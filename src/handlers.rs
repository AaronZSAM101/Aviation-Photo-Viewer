use axum::{
    extract::{Path, Query, State},
    http::header,
    response::{Html, IntoResponse},
    Json,
};
use std::{collections::HashMap, path::PathBuf, time::UNIX_EPOCH};
use tokio::fs;

use crate::models::{AppState, PhotoMeta, PhotosQuery, CachedMeta};
use crate::exif::extract_exif;
use crate::utils::safe_subpath;

/// 前端HTML
const FRONTEND: &str = include_str!("../static/index.html");

/// 支持的图片扩展名
const SUPPORTED_EXTS: &[&str] = &["jpg", "jpeg", "png", "tiff", "tif", "webp"];

/// 预览图片最大尺寸
const PREVIEW_MAX: u32 = 2400;

/// 返回前端HTML
pub async fn serve_frontend() -> Html<&'static str> {
    Html(FRONTEND)
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
    let photos_dir = state.photos_dir.clone();
    let entries: Vec<WalkEntry> = tokio::task::spawn_blocking(move || {
        use walkdir::WalkDir;
        WalkDir::new(photos_dir.as_ref())
            .max_depth(4)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
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
                    .and_then(|p| p.strip_prefix(photos_dir.as_ref()).ok())
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

    // 步骤3：使用rayon并行迭代器提取未缓存的元数据
    let to_extract_batch = to_extract;
    let extracted_results = tokio::task::spawn_blocking(move || {
        use rayon::prelude::*;
        to_extract_batch
            .into_par_iter()
            .map(|(i, path, subpath, mtime, size)| {
                let (mut exif, sort_key) = extract_exif(&path);
                if exif.image_width.is_none() || exif.image_height.is_none() {
                    if let Ok((w, h)) = image::image_dimensions(&path) {
                        exif.image_width = Some(w);
                        exif.image_height = Some(h);
                    }
                }
                (i, subpath, mtime, size, exif, sort_key)
            })
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();

    let mut new_cache: Vec<(String, CachedMeta)> = Vec::new();
    for (i, subpath, mtime, size, exif, sort_key) in extracted_results {
        cached.insert(i, (exif.clone(), sort_key));
        new_cache.push((subpath, CachedMeta { mtime, size, exif, sort_key }));
    }
    let extracted = new_cache.len();

    // 步骤4：将新条目写入缓存，清除已删除文件的缓存
    {
        let mut cache = state.meta_cache.write().await;
        for (sp, m) in new_cache {
            cache.insert(sp, m);
        }
        let live: std::collections::HashSet<String> =
            entries.iter().map(|e| e.subpath.clone()).collect();
        cache.retain(|k, _| live.contains(k));
    }

    // 步骤5：组装PhotoMeta列表并排序
    let mut photos: Vec<PhotoMeta> = entries.into_iter().enumerate().map(|(i, e)| {
        let (exif, sort_key) = cached.remove(&i).unwrap_or_default();
        PhotoMeta {
            filename: e.filename,
            folder: e.folder,
            size: e.size,
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
    let path = state.photos_dir.join(&subpath);
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
    {
        let cache = state.thumb_cache.read().await;
        if let Some(data) = cache.get(&cache_key) {
            return Ok(([(header::CONTENT_TYPE, "image/jpeg")], data.clone()));
        }
    }

    let path = state.photos_dir.join(&subpath);
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
        .insert(cache_key, thumb_data.clone());

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
    {
        let cache = state.preview_cache.read().await;
        if let Some((data, mime)) = cache.get(&cache_key) {
            return Ok(([(header::CONTENT_TYPE, mime.clone())], data.clone()));
        }
    }

    let path = state.photos_dir.join(&subpath);
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
        .insert(cache_key, (result.0.clone(), result.1.clone()));

    Ok(([(header::CONTENT_TYPE, result.1)], result.0))
}
