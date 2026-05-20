use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{Html, IntoResponse, Response},
    Json,
};
use std::{collections::HashMap, path::PathBuf, time::UNIX_EPOCH};
use tokio::fs;

use crate::models::{AppState, PhotoMeta, PhotosQuery, CachedMeta};
use crate::exif::extract_exif;
use crate::exif_edit::apply_exif_override;
use crate::utils::safe_subpath;

/// 把整个 static/ 目录嵌入二进制（编译期）
#[derive(rust_embed::RustEmbed)]
#[folder = "static/"]
struct StaticAssets;

/// 支持的图片扩展名
const SUPPORTED_EXTS: &[&str] = &["jpg", "jpeg", "png", "tiff", "tif", "webp"];

/// 预览图片最大尺寸
const PREVIEW_MAX: u32 = 2400;

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
            (
                [(header::CONTENT_TYPE, mime.as_ref())],
                content.data,
            )
                .into_response()
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
    struct WalkEntry {
        path: PathBuf,
        subpath: String,
        filename: String,
        folder: String,
        size: u64,
        mtime: u64,
    }

    let started = std::time::Instant::now();

    // 步骤1：在blocking池中遍历文件系统，避免阻塞tokio
    let photos_dir = state.photos_dir.read().await.clone();
    let photos_root = photos_dir.clone();
    let entries: Vec<WalkEntry> = tokio::task::spawn_blocking(move || {
        use walkdir::WalkDir;
        WalkDir::new(photos_dir)
            .max_depth(4)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
                // 跳过相对于 photos_root 路径中任一以 '@' 开头的组件
                if let Ok(rel) = e.path().strip_prefix(&photos_root) {
                    if rel.components().any(|c| c.as_os_str().to_string_lossy().starts_with('@')) {
                        return false;
                    }
                }
                e.file_type().is_file() && {
                    let ext = e.path()
                        .extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_lowercase();
                    SUPPORTED_EXTS.contains(&ext.as_str())
                }
            })
            .filter_map(|entry| {
                let path = entry.path().to_path_buf();
                let metadata = entry.metadata().ok()?;
                let size = metadata.len();
                let mtime = metadata.modified().ok()?
                    .duration_since(UNIX_EPOCH).ok()?
                    .as_secs();
                let filename = path.file_name()
                    .and_then(|s| s.to_str())?
                    .to_string();
                    let folder = path.parent()
                    .and_then(|p| p.strip_prefix(&photos_root).ok())
                    .and_then(|p| p.to_str())
                    .unwrap_or("")
                    .to_string();
                let subpath = if folder.is_empty() {
                    filename.clone()
                } else {
                    format!("{}/{}", folder, filename)
                };
                Some(WalkEntry { path, subpath, filename, folder, size, mtime })
            })
            .collect()
    })
    .await
    .unwrap_or_default();

    let total = entries.len();

    let exif_overrides = {
        let guard = state.exif_overrides.read().await;
        guard.clone()
    };

    // 步骤2：分离缓存命中和需要提取的条目
    // 缓存key = subpath; 当 (mtime, size) 改变时失效
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
                _ => to_extract.push((i, e.path.clone(), e.subpath.clone(), e.mtime, e.size)),
            }
        }
    }

    // 步骤3（改进）：不要在响应期间同步提取所有 EXIF，改为：
    //  - 立即返回列表（未命中的条目使用默认 EXIF），
    //  - 在后台异步提取并更新缓存以加速后续请求
    let to_extract_batch = to_extract;
    let extracted = 0usize;

    if !to_extract_batch.is_empty() {
        let bg_items = to_extract_batch.clone();
        let bg_state = state.clone();
        // 在后台做阻塞的并行提取，不阻塞当前请求
        tokio::spawn(async move {
            let results: Result<Vec<(String, CachedMeta)>, _> = tokio::task::spawn_blocking(move || {
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
                        (subpath, CachedMeta { mtime, size, exif, sort_key })
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

    // 步骤4：清除已删除文件的缓存（立即执行以避免缓存无限增长）
    {
        let mut cache = state.meta_cache.write().await;
        let live: std::collections::HashSet<String> =
            entries.iter().map(|e| e.subpath.clone()).collect();
        cache.retain(|k, _| live.contains(k));
    }

    // 步骤5：组装PhotoMeta列表并排序
    let mut photos: Vec<PhotoMeta> = entries.into_iter().enumerate().map(|(i, e)| {
        // 缓存未命中时（新文件 / 重命名后 / EXIF 还在后台异步提取），
        // 返回 sort_key=0 作为占位。前端的 timeGroupOf 用 `if (!k)` 判断后
        // 会归到「未知日期」组；之前曾误用 `e.mtime`（Unix 时间戳，10 位），
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
    }).collect();

    match q.sort.as_deref().unwrap_or("date-asc") {
        "date-desc" => photos.sort_by(|a, b| b.date_sort_key.cmp(&a.date_sort_key)),
        "name-asc" => photos.sort_by(|a, b| a.filename.cmp(&b.filename)),
        "name-desc" => photos.sort_by(|a, b| b.filename.cmp(&a.filename)),
        "size-desc" => photos.sort_by(|a, b| b.size.cmp(&a.size)),
        _ => photos.sort_by_key(|p| p.date_sort_key), // date-asc 默认
    }

    tracing::info!(
        "list_photos: {} files, {} cached, {} extracted in {:?}",
        total, hits, extracted, started.elapsed()
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
    let mtime = metadata
        .modified()
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?
        .as_secs();
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

    state
        .thumb_cache
        .write()
        .await
        .insert(cache_key, (mtime, size, thumb_data.clone()));

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
    let mtime = metadata
        .modified()
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?
        .as_secs();
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

    state
        .preview_cache
        .write()
        .await
        .insert(cache_key, (mtime, size, result.0.clone(), result.1.clone()));

    Ok(([(header::CONTENT_TYPE, result.1)], result.0))
}

/// 管理接口：检查是否允许运行时切换照片目录（由环境变量控制）
pub async fn allow_runtime_dir_change() -> Json<serde_json::Value> {
    let allowed = std::env::var("ALLOW_RUNTIME_DIR_CHANGE").unwrap_or_else(|_| "false".into()) == "true";
    Json(serde_json::json!({"allowed": allowed}))
}

/// 管理接口：切换照片目录（仅在 ALLOW_RUNTIME_DIR_CHANGE=true 时允许）
pub async fn set_photos_dir(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    if std::env::var("ALLOW_RUNTIME_DIR_CHANGE").unwrap_or_else(|_| "false".into()) != "true" {
        return Err((StatusCode::FORBIDDEN, "runtime dir change disabled".to_string()));
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
