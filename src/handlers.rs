use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    Json,
};
use std::{collections::HashMap, path::PathBuf};
use tokio::fs;

/// 缩略图缓存最大条目数（约 500 × 30KB ≈ 15MB）
const MAX_THUMB_CACHE: usize = 500;
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
        || exif.gps_lat.is_some()
        || exif.gps_lon.is_some()
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

use crate::exif::extract_exif;
use crate::exif_edit::apply_exif_override;
use crate::models::{AppState, CachedMeta, PhotoMeta, PhotosQuery};
use crate::utils::{collect_photo_entries, metadata_mtime_key, safe_subpath};

/// 把整个 static/ 目录嵌入二进制（编译期）
#[derive(rust_embed::RustEmbed)]
#[folder = "static/"]
struct StaticAssets;

/// 预览图片最大尺寸
const PREVIEW_MAX: u32 = 2400;

/// 返回前端运行配置。认证通常由反向代理（如 oauth2-proxy）处理；
/// 这里仅暴露应用级开关和代理传来的用户标识，方便 UI 做降级。
pub async fn app_config(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Json<serde_json::Value> {
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

    Json(serde_json::json!({
        "readOnly": state.read_only,
        "version": env!("PHOTO_VIEWER_VERSION"),
        "versionSource": env!("PHOTO_VIEWER_VERSION_SOURCE"),
        "user": user,
        "email": email,
    }))
}

/// 返回前端 index.html
pub async fn serve_frontend() -> Response {
    match StaticAssets::get("index.html") {
        Some(content) => {
            let body = std::str::from_utf8(content.data.as_ref())
                .unwrap_or("")
                .to_string();
            Html(body).into_response()
        }
        None => (StatusCode::NOT_FOUND, "index.html not embedded").into_response(),
    }
}

/// 服务 /static/* 下的所有静态资源（CSS / JS / 图片等）
/// 路由捕获的 `path` 已经不含 "static/" 前缀
pub async fn serve_static(Path(path): Path<String>) -> Response {
    match StaticAssets::get(&path) {
        Some(content) => {
            let mime = mime_guess::from_path(&path).first_or_octet_stream();
            ([(header::CONTENT_TYPE, mime.as_ref())], content.data).into_response()
        }
        None => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}

/// 按需读取镜头信息，作为 `list_photos` 的兜底补充
pub async fn lens_model_for_photo(
    Path(subpath): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if !safe_subpath(&subpath) {
        return Err(StatusCode::BAD_REQUEST);
    }

    let path = {
        let pd = state.photos_dir.read().await.clone();
        pd.join(&subpath)
    };
    if !path.exists() {
        return Err(StatusCode::NOT_FOUND);
    }

    #[cfg(target_os = "macos")]
    {
        let lens = tokio::task::spawn_blocking(move || {
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
            if value.is_empty() || value == "(null)" {
                None
            } else {
                Some(value)
            }
        })
        .await
        .ok()
        .flatten();

        return Ok(Json(serde_json::json!({"lens_model": lens})));
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(Json(serde_json::json!({"lens_model": null})))
    }
}

/// 列出所有照片（含EXIF元数据）
pub async fn list_photos(
    Query(q): Query<PhotosQuery>,
    State(state): State<AppState>,
) -> Json<Vec<PhotoMeta>> {
    let started = std::time::Instant::now();

    // 步骤1：在blocking池中遍历文件系统，避免阻塞tokio
    let photos_dir = state.photos_dir.read().await.clone();
    let entries = tokio::task::spawn_blocking(move || collect_photo_entries(photos_dir, None).0)
        .await
        .unwrap_or_default();

    let total = entries.len();

    let exif_overrides = {
        let guard = state.exif_overrides.read().await;
        guard.clone()
    };

    // 步骤2：分离缓存命中和需要提取的条目
    // 缓存key = subpath; 当 (mtime, size) 改变时失效。
    // mtime 使用微秒级指纹，避免同一秒内覆盖文件时继续复用旧 EXIF。
    let mut hits = 0usize;
    let mut to_extract: Vec<(usize, PathBuf, String, u64, u64)> = Vec::new();
    let mut cached: HashMap<usize, (crate::models::ExifData, i64)> =
        HashMap::with_capacity(entries.len());
    {
        let cache = state.meta_cache.read().await;
        for (i, e) in entries.iter().enumerate() {
            match cache.get(&e.subpath) {
                Some(c) if c.mtime == e.mtime && c.size == e.size => {
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
                    to_extract.push((i, e.path.clone(), e.subpath.clone(), e.mtime, e.size));
                }
                None => to_extract.push((i, e.path.clone(), e.subpath.clone(), e.mtime, e.size)),
            }
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
                                    exif,
                                    sort_key,
                                },
                            )
                        })
                        .collect::<Vec<_>>()
                })
                .await;

            if let Ok(new_cache) = results {
                let mut cache = bg_state.meta_cache.write().await;
                for (sp, m) in new_cache {
                    cache.insert(sp, m);
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
        crate::hash::spawn_phash_warmup(state.clone(), entries.clone());
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
            PhotoMeta {
                filename: e.filename,
                folder: e.folder,
                size: e.size,
                mtime: e.mtime,
                exif,
                date_sort_key: sort_key,
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
        "list_photos: {} files, {} cache hits, {} queued for bg extraction in {:?}",
        total,
        hits,
        bg_extract_count,
        started.elapsed()
    );

    Json(photos)
}

/// 提供原始照片
pub async fn serve_photo(
    Path(subpath): Path<String>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, axum::http::StatusCode> {
    if !safe_subpath(&subpath) {
        return Err(axum::http::StatusCode::BAD_REQUEST);
    }
    let path = {
        let pd = state.photos_dir.read().await.clone();
        pd.join(&subpath)
    };
    let data = fs::read(&path)
        .await
        .map_err(|_| axum::http::StatusCode::NOT_FOUND)?;
    let mime = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .to_string();
    Ok(([(header::CONTENT_TYPE, mime)], data))
}

/// 提供缩略图（400px JPEG，内存缓存）
pub async fn serve_thumb(
    Path(subpath): Path<String>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, axum::http::StatusCode> {
    if !safe_subpath(&subpath) {
        return Err(axum::http::StatusCode::BAD_REQUEST);
    }

    let cache_key = subpath.clone();
    let path = {
        let pd = state.photos_dir.read().await.clone();
        pd.join(&subpath)
    };
    let metadata = fs::metadata(&path)
        .await
        .map_err(|_| axum::http::StatusCode::NOT_FOUND)?;
    let mtime = metadata_mtime_key(&metadata);
    let size = metadata.len();

    {
        let cache = state.thumb_cache.read().await;
        if let Some((cached_mtime, cached_size, data)) = cache.get(&cache_key) {
            if *cached_mtime == mtime && *cached_size == size {
                return Ok(([(header::CONTENT_TYPE, "image/jpeg")], data.clone()));
            }
        }
    }

    let thumb_data = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, ()> {
        let img = image::open(&path).map_err(|_| ())?;
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
    .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?
    .map_err(|_| axum::http::StatusCode::UNPROCESSABLE_ENTITY)?;

    {
        let mut cache = state.thumb_cache.write().await;
        cache.insert(cache_key, (mtime, size, thumb_data.clone()));
        evict_cache(&mut cache, MAX_THUMB_CACHE);
    }

    Ok(([(header::CONTENT_TYPE, "image/jpeg")], thumb_data))
}

/// 提供预览图片（最大2400px，大于该尺寸则转码为JPEG）
pub async fn serve_preview(
    Path(subpath): Path<String>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, axum::http::StatusCode> {
    if !safe_subpath(&subpath) {
        return Err(axum::http::StatusCode::BAD_REQUEST);
    }

    let cache_key = subpath.clone();
    let path = {
        let pd = state.photos_dir.read().await.clone();
        pd.join(&subpath)
    };
    let metadata = fs::metadata(&path)
        .await
        .map_err(|_| axum::http::StatusCode::NOT_FOUND)?;
    let mtime = metadata_mtime_key(&metadata);
    let size = metadata.len();

    {
        let cache = state.preview_cache.read().await;
        if let Some((cached_mtime, cached_size, data, mime)) = cache.get(&cache_key) {
            if *cached_mtime == mtime && *cached_size == size {
                return Ok(([(header::CONTENT_TYPE, mime.clone())], data.clone()));
            }
        }
    }

    let result = tokio::task::spawn_blocking(move || -> Result<(Vec<u8>, String), ()> {
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
        let img = image::open(&path).map_err(|_| ())?;
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
    .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?
    .map_err(|_| axum::http::StatusCode::UNPROCESSABLE_ENTITY)?;

    {
        let mut cache = state.preview_cache.write().await;
        cache.insert(cache_key, (mtime, size, result.0.clone(), result.1.clone()));
        evict_cache(&mut cache, MAX_PREVIEW_CACHE);
    }

    Ok(([(header::CONTENT_TYPE, result.1)], result.0))
}

/// 管理接口：检查是否允许运行时切换照片目录（由环境变量控制）
pub async fn allow_runtime_dir_change(State(state): State<AppState>) -> Json<serde_json::Value> {
    let allowed = !state.read_only
        && std::env::var("ALLOW_RUNTIME_DIR_CHANGE").unwrap_or_else(|_| "false".into()) == "true";
    Json(serde_json::json!({"allowed": allowed}))
}

/// 管理接口：切换照片目录（仅在 ALLOW_RUNTIME_DIR_CHANGE=true 时允许）
pub async fn set_photos_dir(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    if state.read_only {
        return Err((StatusCode::FORBIDDEN, "read-only mode enabled".to_string()));
    }

    if std::env::var("ALLOW_RUNTIME_DIR_CHANGE").unwrap_or_else(|_| "false".into()) != "true" {
        return Err((
            StatusCode::FORBIDDEN,
            "runtime dir change disabled".to_string(),
        ));
    }

    let path = match body.get("path").and_then(|v| v.as_str()) {
        Some(p) => p,
        None => return Err((StatusCode::BAD_REQUEST, "missing path".into())),
    };

    let p = PathBuf::from(path);
    match fs::metadata(&p).await {
        Ok(m) if m.is_dir() => (),
        _ => return Err((StatusCode::BAD_REQUEST, "path not a directory".into())),
    }

    // 更新状态并清空相关缓存
    {
        let mut guard = state.photos_dir.write().await;
        *guard = p.clone();
    }
    state.meta_cache.write().await.clear();
    state.thumb_cache.write().await.clear();
    state.preview_cache.write().await.clear();

    // 加载新的 exif_overrides（如果存在）
    let overrides_path = p.join(".photo_viewer_exif_overrides.json");
    let overrides = crate::exif_edit::load_exif_overrides(&overrides_path).await;
    {
        let mut g = state.exif_overrides.write().await;
        *g = overrides;
    }

    Ok(Json(serde_json::json!({"ok": true, "path": path})))
}
