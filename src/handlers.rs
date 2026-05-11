use axum::{
    extract::{Path, Query, State},
    http::header,
    response::{Html, IntoResponse},
    Json,
};
use std::{collections::HashMap, path::PathBuf, time::UNIX_EPOCH};
use tokio::fs;

use crate::models::{AppState, PhotoMeta, PhotosQuery, CachedMeta, PagedPhotos};
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
) -> Json<PagedPhotos> {
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
        let (exif, sort_key) = match cached.remove(&i) {
            Some((exif, sk)) => (exif, sk),
            None => (crate::models::ExifData::default(), e.mtime as i64),
        };
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
        "list_photos: {} files, {} cached, {} extracted in {:?} (limit={:?} offset={:?})",
        total, hits, extracted, started.elapsed(), q.limit, q.offset
    );

    // 支持分页：若未传 limit (或为 0)，返回全部；否则返回分页结果
    let limit = q.limit.unwrap_or(0) as usize;
    let offset = q.offset.unwrap_or(0) as usize;
    let total_u32 = total as u32;

    let photos_page: Vec<PhotoMeta> = if limit == 0 {
        photos
    } else {
        photos.into_iter().skip(offset).take(limit).collect()
    };

    let has_more = offset + photos_page.len() < total;

    Json(PagedPhotos {
        photos: photos_page,
        total: total_u32,
        limit: limit as u32,
        offset: offset as u32,
        has_more,
    })
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
    let path = state.photos_dir.join(&subpath);
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
    let path = state.photos_dir.join(&subpath);
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
