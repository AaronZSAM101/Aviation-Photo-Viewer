use actix_web::{http::header, web, HttpRequest, HttpResponse};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::PathBuf};
use tokio::fs;

/// 缩略图缓存最大条目数（约 2000 × 30KB ≈ 60MB）
/// 上限要覆盖整库一屏屏滚动的命中集，否则后台重复读网络盘上的缓存文件。
const MAX_THUMB_CACHE: usize = 2000;
/// 预览图缓存最大条目数（约 50 × 1MB ≈ 50MB）
const MAX_PREVIEW_CACHE: usize = 50;

/// 当缓存超出上限时驱逐条目（随机驱逐，简单有效）
fn evict_cache<V>(cache: &mut HashMap<String, V>, max_size: usize) {
    while cache.len() > max_size {
        if let Some(key) = cache.keys().next().cloned() {
            cache.remove(&key);
        } else {
            break;
        }
    }
}

fn has_display_exif(exif: &crate::models::ExifData) -> bool {
    exif.date_taken.is_some()
        || exif.make.is_some()
        || exif.model.is_some()
        || exif.lens_model.is_some()
        || exif.software.is_some()
        || exif.iso.is_some()
        || exif.exposure_time.is_some()
        || exif.f_number.is_some()
        || exif.focal_length.is_some()
        || exif.focal_length_35mm.is_some()
        || exif.gps_altitude.is_some()
        || exif.gps_altitude_ref.is_some()
        || exif.gps_lat.is_some()
        || exif.gps_lat_ref.is_some()
        || exif.gps_lon.is_some()
        || exif.gps_lon_ref.is_some()
        || exif.gps_date_stamp.is_some()
        || exif.gps_time_stamp.is_some()
        || exif.gps_version_id.is_some()
        || exif.gps_map_datum.is_some()
        || exif.flash.is_some()
        || exif.white_balance.is_some()
        || exif.metering_mode.is_some()
        || exif.exposure_bias.is_some()
}

fn date_asc_sort_key(photo: &PhotoMeta) -> i64 {
    if photo.date_sort_key == 0 {
        i64::MAX
    } else {
        photo.date_sort_key
    }
}

fn versioned_thumb_cache_path(
    photos_dir: &std::path::Path,
    subpath: &str,
    mtime: u64,
    size: u64,
) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(subpath.as_bytes());
    hasher.update(b"\0");
    hasher.update(mtime.to_le_bytes());
    hasher.update(size.to_le_bytes());
    let key = hex::encode(hasher.finalize());
    cache_paths::thumbs_dir(photos_dir).join(key)
}

fn clean_lens_value(value: &serde_json::Value) -> Option<String> {
    let value = match value {
        serde_json::Value::String(s) => s.trim(),
        serde_json::Value::Number(n) => return Some(n.to_string()),
        _ => return None,
    };
    if value.is_empty() || value == "(null)" {
        None
    } else {
        Some(value.to_string())
    }
}

fn lens_model_from_exiftool(path: &std::path::Path) -> Option<String> {
    let output = std::process::Command::new("exiftool")
        .args(["-j", "-LensModel", "-Lens", "-Composite:LensID"])
        .arg(path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let docs: Vec<serde_json::Value> = serde_json::from_slice(&output.stdout).ok()?;
    let obj = docs.first()?.as_object()?;
    ["LensModel", "Lens", "LensID"]
        .iter()
        .find_map(|key| obj.get(*key).and_then(clean_lens_value))
}

use crate::cache_paths;
use crate::exif::extract_exif;
use crate::exif_edit::apply_exif_override;
use crate::models::{
    AppState, CachedMeta, PhotoMeta, PhotosQuery, ScanError, ScanStatus, META_CACHE_SCHEMA_VERSION,
};
use crate::paths::{self, PathError};
use crate::utils::{
    collect_photo_entries, collect_photo_folders, metadata_mtime_key, safe_subpath,
};
use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

/// 把路径检查的失败映射为 API 状态码：语法错误 400，保留目录/符号链接 403，不存在 404。
pub(crate) fn path_error_response(error: PathError) -> HttpResponse {
    match error {
        PathError::Invalid => HttpResponse::BadRequest().finish(),
        PathError::Denied => HttpResponse::Forbidden().finish(),
        PathError::NotFound => HttpResponse::NotFound().finish(),
    }
}

/// 记录最近一次扫描的错误，并在日志里逐条指出受影响路径。
async fn record_scan_status(
    state: &AppState,
    errors: &[ScanError],
    truncated: bool,
    scanned: usize,
) {
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    for error in errors {
        tracing::warn!(
            "Photo scan error at {}: {}",
            if error.path.is_empty() {
                "<root>"
            } else {
                error.path.as_str()
            },
            error.message
        );
    }
    let status = ScanStatus {
        errors: errors.to_vec(),
        truncated,
        scanned,
        at,
    };
    *state.last_scan.write().await = status;
}

/// 前端构建产物目录（Vite 的 dist）。可被 FRONTEND_DIR 覆盖。
/// 预览图片最大尺寸
const PREVIEW_MAX: u32 = 2400;

#[derive(Clone)]
pub struct FrontendConfig {
    pub dir: PathBuf,
}

pub fn resolve_frontend_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("FRONTEND_DIR") {
        return PathBuf::from(dir);
    }
    for candidate in ["frontend/dist", "../frontend/dist", "/app/frontend/dist"] {
        let dir = PathBuf::from(candidate);
        if dir.join("index.html").exists() {
            return dir;
        }
    }
    PathBuf::from("frontend/dist")
}

fn frontend_index(frontend: &FrontendConfig) -> HttpResponse {
    match std::fs::read(frontend.dir.join("index.html")) {
        Ok(data) => HttpResponse::Ok()
            .content_type("text/html; charset=utf-8")
            .insert_header((header::CACHE_CONTROL, "no-cache"))
            .body(data),
        Err(e) => HttpResponse::ServiceUnavailable()
            .content_type("text/plain; charset=utf-8")
            .body(format!(
                "frontend build not found in {}: {e}",
                frontend.dir.display()
            )),
    }
}

/// 返回前端 index.html（SPA 入口）
pub async fn serve_frontend(frontend: web::Data<FrontendConfig>) -> HttpResponse {
    frontend_index(&frontend)
}

/// 提供构建产物资源：/assets/* 与根目录静态文件
pub async fn serve_asset(
    path: web::Path<String>,
    frontend: web::Data<FrontendConfig>,
) -> HttpResponse {
    let rel = path.into_inner();
    if rel.is_empty() || !safe_subpath(&rel) {
        return HttpResponse::BadRequest().finish();
    }
    let fs_path = frontend.dir.join("assets").join(&rel);
    match fs::read(&fs_path).await {
        Ok(data) => {
            let mime = mime_guess::from_path(&fs_path).first_or_octet_stream();
            HttpResponse::Ok()
                .content_type(mime.as_ref())
                .insert_header((header::CACHE_CONTROL, "public, max-age=31536000, immutable"))
                .body(data)
        }
        Err(_) => HttpResponse::NotFound().finish(),
    }
}

/// 根目录静态文件（favicon.svg 等）
async fn serve_root_file(frontend: &FrontendConfig, rel: &str) -> Option<HttpResponse> {
    if rel.is_empty() || rel.contains('/') || !safe_subpath(rel) {
        return None;
    }
    let fs_path = frontend.dir.join(rel);
    let data = fs::read(&fs_path).await.ok()?;
    let mime = mime_guess::from_path(&fs_path).first_or_octet_stream();
    let mut builder = HttpResponse::Ok();
    let builder = builder.content_type(mime.as_ref());
    // 不带 Cache-Control 会被浏览器启发式缓存：重新部署后，直接收藏 /index.html 的手机
    // 会继续用旧入口页，而它引用的 hash 资源已经不在新镜像里，页面就白屏了。
    if rel.ends_with(".html") {
        builder.insert_header((header::CACHE_CONTROL, "no-cache"));
    }
    Some(builder.body(data))
}

/// 未匹配路径：客户端路由回退到 index.html，接口/资源路径返回 404。
pub async fn serve_spa(req: HttpRequest, frontend: web::Data<FrontendConfig>) -> HttpResponse {
    let path = req.path();
    if path.starts_with("/api/")
        || path.starts_with("/photos/")
        || path.starts_with("/preview/")
        || path.starts_with("/thumb/")
        || path.starts_with("/assets/")
    {
        return HttpResponse::NotFound().finish();
    }
    let trimmed = path.trim_start_matches('/');
    if !trimmed.is_empty() && !trimmed.contains('/') {
        if std::path::Path::new(trimmed).extension().is_some() {
            if let Some(resp) = serve_root_file(&frontend, trimmed).await {
                return resp;
            }
            return HttpResponse::NotFound().finish();
        }
    }
    frontend_index(&frontend)
}

/// 返回前端运行配置。认证通常由反向代理（如 oauth2-proxy）处理；
/// 这里仅暴露应用级开关和代理传来的用户标识，方便 UI 做降级。
pub async fn app_config(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    let headers = req.headers();
    let user = headers
        .get("x-forwarded-user")
        .or_else(|| headers.get("x-auth-request-user"))
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string());
    let email = headers
        .get("x-forwarded-email")
        .or_else(|| headers.get("x-auth-request-email"))
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string());

    HttpResponse::Ok().json(serde_json::json!({
        "readOnly": state.read_only,
        "version": env!("PHOTO_VIEWER_VERSION"),
        "versionSource": env!("PHOTO_VIEWER_VERSION_SOURCE"),
        "user": user,
        "email": email,
        // 前端据此决定「识别机号」按钮是灰的还是能点的，而不是等用户点下去才收到 503
        "ocrAvailable": crate::registration::ocr_available(),
        // 彩绘提醒有没有配数据源（AIRFRAME_URL / LIVERY_FEED_URL）；没配就只有关注清单
        "liveryConfigured": crate::livery::feed_configured(),
    }))
}

/// 手动刷新派生缓存：立即清空缩略图/预览缓存，移除磁盘元数据缓存，并在后台重建元数据缓存。
pub async fn refresh_caches(state: web::Data<AppState>) -> HttpResponse {
    if state.read_only {
        return HttpResponse::Forbidden().body("read-only mode enabled");
    }

    let started = std::time::Instant::now();
    let (photos_dir, generation) = {
        let pd = state.photos_dir.read().await;
        (pd.clone(), state.dir_generation.load(Ordering::SeqCst))
    };
    let cache_file = cache_paths::meta_cache(&photos_dir);
    let legacy_cache_file = cache_paths::legacy_meta_cache(&photos_dir);
    let thumbs_dir = cache_paths::thumbs_dir(&photos_dir);

    {
        state.thumb_cache.write().await.clear();
        state.preview_cache.write().await.clear();
        state.meta_extract_inflight.write().await.clear();
    }

    match fs::remove_file(&cache_file).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => tracing::warn!("Failed to remove meta cache file during refresh: {}", e),
    }
    match fs::remove_file(&legacy_cache_file).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => tracing::warn!(
            "Failed to remove legacy meta cache file during refresh: {}",
            e
        ),
    }
    match fs::remove_dir_all(&thumbs_dir).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => tracing::warn!("Failed to remove thumbnail cache dir during refresh: {}", e),
    }

    let bg_state = state.clone();
    tokio::spawn(async move {
        let outcome =
            tokio::task::spawn_blocking(move || collect_photo_entries(photos_dir, None))
                .await
                .unwrap_or_default();
        let entries = outcome.entries;
        let total = entries.len();
        let errors = outcome.errors;
        let truncated = outcome.truncated;
        record_scan_status(&bg_state, &errors, truncated, total).await;
        {
            let mut inflight = bg_state.meta_extract_inflight.write().await;
            inflight.clear();
            for e in &entries {
                inflight.insert(e.subpath.clone(), (e.mtime, e.size));
            }
        }

        let rebuilt: Result<Vec<(String, CachedMeta)>, _> =
            tokio::task::spawn_blocking(move || {
                use rayon::prelude::*;

                entries
                    .into_par_iter()
                    .map(|e| {
                        let (mut exif, sort_key) = extract_exif(&e.path);
                        if exif.image_width.is_none() || exif.image_height.is_none() {
                            if let Ok((w, h)) = image::image_dimensions(&e.path) {
                                exif.image_width = Some(w);
                                exif.image_height = Some(h);
                            }
                        }
                        (
                            e.subpath,
                            CachedMeta {
                                mtime: e.mtime,
                                size: e.size,
                                schema_version: META_CACHE_SCHEMA_VERSION,
                                exif,
                                sort_key,
                            },
                        )
                    })
                    .collect()
            })
            .await;

        if let Ok(rebuilt) = rebuilt {
            // 重建期间切换了目录：这批结果属于旧库，直接丢弃
            if bg_state.dir_generation.load(Ordering::SeqCst) == generation {
                let mut cache = bg_state.meta_cache.write().await;
                cache.clear();
                for (subpath, meta) in rebuilt {
                    cache.insert(subpath, meta);
                }
                tracing::info!(
                    "refresh_caches: rebuilt metadata for {} files in {:?}",
                    total,
                    started.elapsed()
                );
            }
        }
        if bg_state.dir_generation.load(Ordering::SeqCst) == generation {
            bg_state.meta_extract_inflight.write().await.clear();
        }
    });

    HttpResponse::Ok().json(serde_json::json!({
        "ok": true,
        "rebuilding": true,
        "elapsed_ms": started.elapsed().as_millis(),
    }))
}

/// 按需读取镜头信息，作为 `list_photos` 的兜底补充
pub async fn lens_model_for_photo(
    subpath: web::Path<String>,
    state: web::Data<AppState>,
) -> HttpResponse {
    let path = {
        let pd = state.photos_dir.read().await.clone();
        match paths::resolve_user_file(&pd, subpath.as_str()).await {
            Ok(path) => path,
            Err(error) => return path_error_response(error),
        }
    };

    #[cfg(target_os = "macos")]
    {
        let lens = web::block(move || {
            use std::process::Command;

            let output = Command::new("mdls")
                .arg("-name")
                .arg("kMDItemLensModel")
                .arg("-raw")
                .arg(&path)
                .output()
                .ok()?;
            if !output.status.success() {
                return None;
            }
            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let lens = if value.is_empty() || value == "(null)" {
                None
            } else {
                Some(value)
            };
            lens.or_else(|| lens_model_from_exiftool(&path))
        })
        .await
        .ok()
        .flatten();

        return HttpResponse::Ok().json(serde_json::json!({"lens_model": lens}));
    }

    #[cfg(not(target_os = "macos"))]
    {
        let lens = web::block(move || lens_model_from_exiftool(&path))
            .await
            .ok()
            .flatten();
        HttpResponse::Ok().json(serde_json::json!({"lens_model": lens}))
    }
}

/// 列出所有照片（含EXIF元数据）
pub async fn list_photos(q: web::Query<PhotosQuery>, state: web::Data<AppState>) -> HttpResponse {
    let started = std::time::Instant::now();

    // 步骤1：在blocking池中遍历文件系统，避免阻塞tokio
    // 目录快照与代数一起取：切换照片目录后，旧目录的在途结果不再写回共享缓存
    let (photos_dir, scan_generation) = {
        let pd = state.photos_dir.read().await;
        (pd.clone(), state.dir_generation.load(Ordering::SeqCst))
    };
    let outcome = tokio::task::spawn_blocking(move || collect_photo_entries(photos_dir, None))
        .await
        .unwrap_or_default();
    let scan_elapsed = started.elapsed();
    let scan_errors = outcome.errors;
    let truncated = outcome.truncated;
    let entries = outcome.entries;

    let total = entries.len();
    record_scan_status(&state, &scan_errors, truncated, total).await;

    let exif_overrides = {
        let guard = state.exif_overrides.read().await;
        guard.clone()
    };
    // 图片文字识别出来的机号：文件名读不出时才用得上
    let reg_detect = {
        let guard = state.reg_detect.read().await;
        guard.clone()
    };

    // 步骤2：分离缓存命中和需要提取的条目
    // 缓存key = subpath; 当 (mtime, size) 改变时失效。
    // mtime 使用微秒级指纹，避免同一秒内覆盖文件时继续复用旧 EXIF。
    let mut hits = 0usize;
    let mut extract_candidates: Vec<(usize, PathBuf, String, u64, u64)> = Vec::new();
    let mut cached: HashMap<usize, (crate::models::ExifData, i64)> =
        HashMap::with_capacity(entries.len());
    {
        let cache = state.meta_cache.read().await;
        for (i, e) in entries.iter().enumerate() {
            match cache.get(&e.subpath) {
                Some(c)
                    if c.mtime == e.mtime
                        && c.size == e.size
                        && c.schema_version == META_CACHE_SCHEMA_VERSION
                        && (has_display_exif(&c.exif)
                            || c.exif.image_width.is_some()
                            || c.exif.image_height.is_some()) =>
                {
                    cached.insert(i, (c.exif.clone(), c.sort_key));
                    hits += 1;
                }
                Some(c) => {
                    // 旧版本持久化的是秒级 mtime；升级到微秒级后会全量失效。
                    // 若旧缓存里已有可展示 EXIF，先返回它，避免刷新时整页短暂变成 NO EXIF；
                    // 后台仍会重新提取并写回新指纹。旧缓存本身无 EXIF 时不复用，
                    // 这样覆盖写入了 EXIF 的照片能在后台刷新后显示新数据。
                    if has_display_exif(&c.exif) {
                        cached.insert(i, (c.exif.clone(), c.sort_key));
                    }
                    extract_candidates.push((
                        i,
                        e.path.clone(),
                        e.subpath.clone(),
                        e.mtime,
                        e.size,
                    ));
                }
                None => {
                    extract_candidates.push((i, e.path.clone(), e.subpath.clone(), e.mtime, e.size))
                }
            }
        }
    }
    let mut to_extract: Vec<(usize, PathBuf, String, u64, u64)> =
        Vec::with_capacity(extract_candidates.len());
    if !extract_candidates.is_empty() {
        let mut inflight = state.meta_extract_inflight.write().await;
        for (i, path, subpath, mtime, size) in extract_candidates {
            let already_running =
                inflight
                    .get(&subpath)
                    .is_some_and(|(active_mtime, active_size)| {
                        *active_mtime == mtime && *active_size == size
                    });
            if already_running {
                continue;
            }
            inflight.insert(subpath.clone(), (mtime, size));
            to_extract.push((i, path, subpath, mtime, size));
        }
    }

    // 步骤3（改进）：不要在响应期间同步提取所有 EXIF，改为：
    //  - 立即返回列表（未命中的条目使用默认 EXIF），
    //  - 在后台异步提取并更新缓存以加速后续请求
    let to_extract_batch = to_extract;
    // 记录需后台提取的数量（移动进 spawn 前先捕获）
    let bg_extract_count = to_extract_batch.len();

    if !to_extract_batch.is_empty() {
        let bg_items = to_extract_batch.clone();
        let inflight_items: Vec<(String, u64, u64)> = bg_items
            .iter()
            .map(|(_i, _path, subpath, mtime, size)| (subpath.clone(), *mtime, *size))
            .collect();
        let bg_state = state.clone();
        // 在后台做阻塞的并行提取，不阻塞当前请求
        tokio::spawn(async move {
            let results: Result<Vec<(String, CachedMeta)>, _> =
                tokio::task::spawn_blocking(move || {
                    use rayon::prelude::*;
                    bg_items
                        .into_par_iter()
                        .map(|(_i, path, subpath, mtime, size)| {
                            let (mut exif, sort_key) = extract_exif(&path);
                            if exif.image_width.is_none() || exif.image_height.is_none() {
                                if let Ok((w, h)) = image::image_dimensions(&path) {
                                    exif.image_width = Some(w);
                                    exif.image_height = Some(h);
                                }
                            }
                            (
                                subpath,
                                CachedMeta {
                                    mtime,
                                    size,
                                    schema_version: META_CACHE_SCHEMA_VERSION,
                                    exif,
                                    sort_key,
                                },
                            )
                        })
                        .collect::<Vec<_>>()
                })
                .await;

            if let Ok(new_cache) = results {
                // 目录已切换时丢弃这批结果，避免把旧库的 EXIF 写进新库的缓存
                if bg_state.dir_generation.load(Ordering::SeqCst) == scan_generation {
                    let mut cache = bg_state.meta_cache.write().await;
                    for (sp, m) in new_cache {
                        cache.insert(sp, m);
                    }
                }
            }
            if bg_state.dir_generation.load(Ordering::SeqCst) == scan_generation {
                let mut inflight = bg_state.meta_extract_inflight.write().await;
                for (subpath, mtime, size) in inflight_items {
                    if inflight
                        .get(&subpath)
                        .is_some_and(|(active_mtime, active_size)| {
                            *active_mtime == mtime && *active_size == size
                        })
                    {
                        inflight.remove(&subpath);
                    }
                }
            }
        });
    }

    let warm_phash_on_list = matches!(
        std::env::var("PHASH_WARMUP")
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "1" | "true" | "yes" | "on"
    );
    if warm_phash_on_list {
        crate::hash::spawn_phash_warmup(AppState::clone(&state), entries.clone());
    }

    // 步骤4（已移除）：之前在此做缓存清理（retain 只保留 live 文件），
    // 但这会引发竞态：apply_stage 刚把 "A.jpg" 迁移到 "A-new.jpg"，
    // 而此处的 live 集合基于旧 FS 扫描结果，会误删迁移后的新条目。
    // 清理现已移至后台 60 秒刷新任务（main.rs），届时会先重新扫描再清理。

    // 步骤5：组装PhotoMeta列表并排序
    let mut photos: Vec<PhotoMeta> = entries
        .into_iter()
        .enumerate()
        .map(|(i, e)| {
            // 缓存未命中时（新文件 / 重命名后 / EXIF 还在后台异步提取），
            // 返回 sort_key=0 作为占位。前端的 timeGroupOf 用 `if (!k)` 判断后
            // 会归到「未知日期」组；之前曾误用 `e.mtime`（文件修改时间），
            // 让前端按 14 位 YYYYMMDDHHMMSS 解析后显示成 "0000 年 17 月"。
            let (exif, _cached_sort_key) = match cached.remove(&i) {
                Some((exif, sk)) => (exif, sk),
                None => (crate::models::ExifData::default(), 0i64),
            };
            let mut exif = exif;
            if let Some(override_exif) = exif_overrides.get(&e.subpath) {
                apply_exif_override(&mut exif, override_exif);
            }
            let sort_key = crate::exif::date_to_sort_key(exif.date_taken.as_deref());
            // 文件名优先：文件名里明写的机号是作者自己标的，识别结果只补空缺，
            // 而且只对同一个文件版本（mtime+size）生效，改过图就不会拿老结果
            let name_regs = crate::registration::from_filename(&e.filename);
            let (regs, reg_source) = if name_regs.is_empty() {
                match reg_detect.get(&e.subpath) {
                    Some(d) if d.mtime == e.mtime && d.size == e.size && !d.regs.is_empty() => {
                        (d.regs.clone(), "ocr")
                    }
                    _ => (Vec::new(), "none"),
                }
            } else {
                (name_regs, "name")
            };
            PhotoMeta {
                filename: e.filename,
                folder: e.folder,
                size: e.size,
                mtime: e.mtime,
                exif,
                date_sort_key: sort_key,
                regs,
                reg_source,
            }
        })
        .collect();

    match q.sort.as_deref().unwrap_or("date-asc") {
        "date-desc" => photos.sort_by(|a, b| b.date_sort_key.cmp(&a.date_sort_key)),
        "name-asc" => photos.sort_by(|a, b| a.filename.cmp(&b.filename)),
        "name-desc" => photos.sort_by(|a, b| b.filename.cmp(&a.filename)),
        "size-desc" => photos.sort_by(|a, b| b.size.cmp(&a.size)),
        _ => photos.sort_by_key(date_asc_sort_key), // date-asc 默认；未知日期放最后
    }

    tracing::info!(
        "list_photos: {} files, {} cache hits, {} queued for bg extraction, scan {:?} / handler {:?} in total",
        total,
        hits,
        bg_extract_count,
        scan_elapsed,
        started.elapsed()
    );

    // 扫描不是“返回数组就等于完整”：错误数量单独放在响应头里，界面据此提示
    HttpResponse::Ok()
        .insert_header(("x-scan-errors", scan_errors.len().to_string()))
        .insert_header(("x-scan-truncated", if truncated { "1" } else { "0" }))
        .json(photos)
}

/// 最近一次照片扫描的摘要：错误路径 + 是否截断，供界面提示和排障使用
pub async fn scan_status(state: web::Data<AppState>) -> HttpResponse {
    let status = state.last_scan.read().await.clone();
    HttpResponse::Ok().json(status)
}

#[derive(serde::Deserialize)]
pub struct OcrRegRequest {
    pub path: String,
}

/// 对单张照片做机身文字识别。装了 tesseract 才有；结果按文件版本存进
/// `.photo_viewer/reg_detect.json`，只在文件名读不出机号时补进列表。
pub async fn ocr_photo_reg(req: web::Json<OcrRegRequest>, state: web::Data<AppState>) -> HttpResponse {
    if state.read_only {
        return HttpResponse::Forbidden().body("read-only mode enabled");
    }
    if !crate::registration::ocr_available() {
        return HttpResponse::ServiceUnavailable().json(serde_json::json!({
            "error": "no-ocr",
            "message": "容器里没有 tesseract，装不了就用文件名里的机号",
        }));
    }
    let rel = req.path.trim().trim_start_matches('/').to_string();
    let (photos_dir, generation) = {
        let pd = state.photos_dir.read().await;
        (pd.clone(), state.dir_generation.load(Ordering::SeqCst))
    };
    let path = match crate::paths::resolve_user_file(&photos_dir, &rel).await {
        Ok(path) => path,
        Err(error) => return path_error_response(error),
    };
    let metadata = match fs::metadata(&path).await {
        Ok(m) => m,
        Err(_) => return HttpResponse::NotFound().body("file not found"),
    };
    let mtime = metadata_mtime_key(&metadata);
    let size = metadata.len();
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let outcome = tokio::task::spawn_blocking(move || crate::registration::ocr_file(&path)).await;
    let regs = match outcome {
        Ok(Ok(regs)) => regs,
        Ok(Err(message)) => {
            return HttpResponse::UnprocessableEntity()
                .json(serde_json::json!({"error": "ocr-failed", "message": message}))
        }
        Err(_) => return HttpResponse::InternalServerError().body("识别任务崩了"),
    };
    {
        let mut guard = state.reg_detect.write().await;
        guard.insert(
            rel.clone(),
            crate::models::DetectedReg {
                mtime,
                size,
                regs: regs.clone(),
                engine: "tesseract".to_string(),
            },
        );
    }
    // 目录已切换就别把老库的识别结果写进新库的状态文件
    if state.dir_generation.load(Ordering::SeqCst) == generation {
        let snapshot = state.reg_detect.read().await.clone();
        if let Err(e) =
            crate::registration::persist_detect(&crate::cache_paths::reg_detect(&photos_dir), &snapshot)
                .await
        {
            tracing::warn!("机号识别结果落盘失败：{}", e);
        }
    }
    HttpResponse::Ok().json(serde_json::json!({
        "path": rel,
        "regs": regs,
        "name_regs": crate::registration::from_filename(&file_name),
        "engine": "tesseract",
    }))
}

pub async fn list_folders(state: web::Data<AppState>) -> HttpResponse {
    let photos_dir = state.photos_dir.read().await.clone();
    let folders = tokio::task::spawn_blocking(move || collect_photo_folders(photos_dir))
        .await
        .unwrap_or_default();
    HttpResponse::Ok().json(folders)
}

/// 前端所有图片 URL 都带 `?v=<mtime>-<size>`（见 frontend/src/utils/paths.ts）。
/// 版本串可信时可以直接查缓存，省掉一次网络盘的 stat：移动端一屏就要请求上百张缩略图。
fn version_hint(req: &HttpRequest) -> Option<(u64, u64)> {
    let params = web::Query::<HashMap<String, String>>::from_query(req.query_string())
        .ok()
        .map(|q| q.into_inner())?;
    let (mtime, size) = params.get("v")?.split_once('-')?;
    Some((mtime.parse().ok()?, size.parse().ok()?))
}

/// 命中内存或磁盘缩略图缓存时返回响应，未命中返回 None 交给调用方转码
async fn cached_thumb(
    state: &web::Data<AppState>,
    photos_dir: &std::path::Path,
    generation: u64,
    cache_key: &str,
    mtime: u64,
    size: u64,
) -> Option<HttpResponse> {
    let cache_is_current = || state.dir_generation.load(Ordering::SeqCst) == generation;
    let ok = |data: Vec<u8>| {
        HttpResponse::Ok()
            .content_type("image/jpeg")
            .insert_header((header::CACHE_CONTROL, "public, max-age=31536000, immutable"))
            .body(data)
    };

    if cache_is_current() {
        let cache = state.thumb_cache.read().await;
        if let Some((cached_mtime, cached_size, data)) = cache.get(cache_key) {
            if *cached_mtime == mtime && *cached_size == size {
                return Some(ok(data.clone()));
            }
        }
    }

    let data = fs::read(&versioned_thumb_cache_path(photos_dir, cache_key, mtime, size))
        .await
        .ok()?;
    if cache_is_current() {
        let mut cache = state.thumb_cache.write().await;
        cache.insert(cache_key.to_string(), (mtime, size, data.clone()));
        evict_cache(&mut cache, MAX_THUMB_CACHE);
    }
    Some(ok(data))
}

/// 提供原始照片
pub async fn serve_photo(subpath: web::Path<String>, state: web::Data<AppState>) -> HttpResponse {
    let path = {
        let pd = state.photos_dir.read().await.clone();
        match paths::resolve_user_file(&pd, subpath.as_str()).await {
            Ok(path) => path,
            Err(error) => return path_error_response(error),
        }
    };
    let data = match fs::read(&path).await {
        Ok(d) => d,
        Err(_) => return HttpResponse::NotFound().finish(),
    };
    let mime = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .to_string();
    // URL 里的 ?v= 已经唯一标识了文件版本，替换照片会产生新 URL
    HttpResponse::Ok()
        .content_type(mime)
        .insert_header((header::CACHE_CONTROL, "public, max-age=31536000, immutable"))
        .body(data)
}

/// 提供缩略图（400px JPEG，内存缓存）
pub async fn serve_thumb(
    subpath: web::Path<String>,
    req: HttpRequest,
    state: web::Data<AppState>,
) -> HttpResponse {
    let cache_key = subpath.as_str().to_string();
    // 路径、磁盘缓存位置和代数取自同一个快照：切换目录不会拼出“旧文件 + 新缓存目录”
    let (photos_dir, generation) = {
        let pd = state.photos_dir.read().await;
        (pd.clone(), state.dir_generation.load(Ordering::SeqCst))
    };
    let path = match paths::resolve_user_file(&photos_dir, subpath.as_str()).await {
        Ok(path) => path,
        Err(error) => return path_error_response(error),
    };

    if let Some((hint_mtime, hint_size)) = version_hint(&req) {
        if let Some(response) =
            cached_thumb(&state, &photos_dir, generation, &cache_key, hint_mtime, hint_size).await
        {
            return response;
        }
    }

    let metadata = match fs::metadata(&path).await {
        Ok(m) => m,
        Err(_) => return HttpResponse::NotFound().finish(),
    };
    let mtime = metadata_mtime_key(&metadata);
    let size = metadata.len();
    let disk_cache_path = versioned_thumb_cache_path(&photos_dir, &subpath, mtime, size);
    let cache_is_current = || state.dir_generation.load(Ordering::SeqCst) == generation;

    if let Some(response) =
        cached_thumb(&state, &photos_dir, generation, &cache_key, mtime, size).await
    {
        return response;
    }

    let thumb_data = match tokio::task::spawn_blocking(move || -> Result<Vec<u8>, ()> {
        let img = crate::decode::open_image(&path).ok_or(())?;
        let thumb = img.thumbnail(400, 400);
        let mut buf = Vec::new();
        thumb
            .write_to(
                &mut std::io::Cursor::new(&mut buf),
                image::ImageOutputFormat::Jpeg(82),
            )
            .map_err(|_| ())?;
        Ok(buf)
    })
    .await
    {
        Ok(Ok(buf)) => buf,
        Ok(Err(())) => return HttpResponse::UnprocessableEntity().finish(),
        Err(_) => return HttpResponse::InternalServerError().finish(),
    };

    if cache_is_current() {
        let mut cache = state.thumb_cache.write().await;
        cache.insert(cache_key, (mtime, size, thumb_data.clone()));
        evict_cache(&mut cache, MAX_THUMB_CACHE);
    }

    // 只读实例不落盘：缩略图只留在内存缓存里
    if !state.read_only && cache_is_current() {
        if let Some(parent) = disk_cache_path.parent() {
            if fs::create_dir_all(parent).await.is_ok() {
                if let Err(e) = fs::write(&disk_cache_path, &thumb_data).await {
                    tracing::warn!("Failed to write thumbnail cache: {}", e);
                }
            }
        }
    }

    HttpResponse::Ok()
        .content_type("image/jpeg")
        .insert_header((header::CACHE_CONTROL, "public, max-age=31536000, immutable"))
        .body(thumb_data)
}

/// 提供预览图片（最大2400px，大于该尺寸则转码为JPEG）
pub async fn serve_preview(subpath: web::Path<String>, state: web::Data<AppState>) -> HttpResponse {
    let cache_key = subpath.as_str().to_string();
    let (photos_dir, generation) = {
        let pd = state.photos_dir.read().await;
        (pd.clone(), state.dir_generation.load(Ordering::SeqCst))
    };
    let path = match paths::resolve_user_file(&photos_dir, subpath.as_str()).await {
        Ok(path) => path,
        Err(error) => return path_error_response(error),
    };
    let metadata = match fs::metadata(&path).await {
        Ok(m) => m,
        Err(_) => return HttpResponse::NotFound().finish(),
    };
    let mtime = metadata_mtime_key(&metadata);
    let size = metadata.len();
    let cache_is_current = || state.dir_generation.load(Ordering::SeqCst) == generation;

    if cache_is_current() {
        let cache = state.preview_cache.read().await;
        if let Some((cached_mtime, cached_size, data, mime)) = cache.get(&cache_key) {
            if *cached_mtime == mtime && *cached_size == size {
                return HttpResponse::Ok()
                    .content_type(mime.clone())
                    .insert_header((header::CACHE_CONTROL, "public, max-age=31536000, immutable"))
                    .body(data.clone());
            }
        }
    }

    let result = match tokio::task::spawn_blocking(move || -> Result<(Vec<u8>, String), ()> {
        // RAW 的原始字节浏览器画不出来，只能走解码出来的内嵌预览，跳过头部探测
        if !crate::decode::is_raw(&path) {
            // 廉价的头部探测：当图片已经足够小时避免完整解码
            if let Ok((w, h)) = image::image_dimensions(&path) {
                if w <= PREVIEW_MAX && h <= PREVIEW_MAX {
                    let data = std::fs::read(&path).map_err(|_| ())?;
                    let mime = mime_guess::from_path(&path)
                        .first_or_octet_stream()
                        .to_string();
                    return Ok((data, mime));
                }
            }
        }
        let img = crate::decode::open_image(&path).ok_or(())?;
        let preview = img.thumbnail(PREVIEW_MAX, PREVIEW_MAX);
        let mut buf = Vec::new();
        preview
            .write_to(
                &mut std::io::Cursor::new(&mut buf),
                image::ImageOutputFormat::Jpeg(88),
            )
            .map_err(|_| ())?;
        Ok((buf, "image/jpeg".to_string()))
    })
    .await
    {
        Ok(Ok(result)) => result,
        Ok(Err(())) => return HttpResponse::UnprocessableEntity().finish(),
        Err(_) => return HttpResponse::InternalServerError().finish(),
    };

    if cache_is_current() {
        let mut cache = state.preview_cache.write().await;
        cache.insert(cache_key, (mtime, size, result.0.clone(), result.1.clone()));
        evict_cache(&mut cache, MAX_PREVIEW_CACHE);
    }

    HttpResponse::Ok()
        .content_type(result.1)
        .insert_header((header::CACHE_CONTROL, "public, max-age=31536000, immutable"))
        .body(result.0)
}

/// 管理接口：检查是否允许运行时切换照片目录（由环境变量控制）
pub async fn allow_runtime_dir_change(state: web::Data<AppState>) -> HttpResponse {
    let allowed = !state.read_only
        && std::env::var("ALLOW_RUNTIME_DIR_CHANGE").unwrap_or_else(|_| "false".into()) == "true";
    HttpResponse::Ok().json(serde_json::json!({"allowed": allowed}))
}

/// 管理接口：切换照片目录（仅在 ALLOW_RUNTIME_DIR_CHANGE=true 时允许）
pub async fn set_photos_dir(
    state: web::Data<AppState>,
    body: web::Json<serde_json::Value>,
) -> HttpResponse {
    if state.read_only {
        return HttpResponse::Forbidden().body("read-only mode enabled");
    }

    if std::env::var("ALLOW_RUNTIME_DIR_CHANGE").unwrap_or_else(|_| "false".into()) != "true" {
        return HttpResponse::Forbidden().body("runtime dir change disabled");
    }

    let path = match body.get("path").and_then(|v| v.as_str()) {
        Some(p) => p,
        None => return HttpResponse::BadRequest().body("missing path"),
    };

    let p = PathBuf::from(path);
    match fs::metadata(&p).await {
        Ok(m) if m.is_dir() => (),
        _ => return HttpResponse::BadRequest().body("path not a directory"),
    }

    // 待处理操作都是相对路径，换库后会把它们作用到另一个库上：要求先处理干净
    if !state.staged_ops.read().await.is_empty() {
        return HttpResponse::Conflict()
            .body("pending staged operations refer to the current directory; apply or clear them first");
    }

    // 更新状态并清空相关缓存。先换目录、再递增代数、最后清缓存：
    // 在途请求读到的是（旧目录，旧代数）或（新目录，新代数），不会把旧库结果写进新库。
    {
        let mut guard = state.photos_dir.write().await;
        *guard = p.clone();
    }
    state.dir_generation.fetch_add(1, Ordering::SeqCst);
    state.meta_cache.write().await.clear();
    state.meta_extract_inflight.write().await.clear();
    state.thumb_cache.write().await.clear();
    state.preview_cache.write().await.clear();
    state.phash_cache.write().await.clear();
    state.similar_jobs.write().await.clear();
    *state.last_scan.write().await = ScanStatus::default();

    // 加载新的 exif_overrides（如果存在）
    let overrides_path = cache_paths::preferred_existing(
        cache_paths::exif_overrides(&p),
        cache_paths::legacy_exif_overrides(&p),
    );
    let overrides = crate::exif_edit::load_exif_overrides(&overrides_path).await;
    {
        let mut g = state.exif_overrides.write().await;
        *g = overrides;
    }

    // 机号识别结果跟着库走：新库没有 reg_detect.json 时 load_detect 返回空表，正好把旧库的清掉
    let detected =
        crate::registration::load_detect(&cache_paths::reg_detect(&p)).await;
    {
        let mut g = state.reg_detect.write().await;
        *g = detected;
    }

    // 拍摄点档案同理按库分开：换库就换一份文件夹→坐标的表
    let archive = crate::spots::load_spots(&cache_paths::spots(&p)).await;
    {
        let mut g = state.spots.write().await;
        *g = archive;
    }

    // 彩绘关注清单也是手写的，跟着库走
    let watched = crate::livery::load_watchlist(&cache_paths::watchlist(&p)).await;
    {
        let mut g = state.livery_watch.write().await;
        *g = watched;
    }

    HttpResponse::Ok().json(serde_json::json!({"ok": true, "path": path}))
}
