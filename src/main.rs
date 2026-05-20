use axum::{
    routing::{get, post},
    Router,
};
use std::{path::PathBuf, sync::Arc, collections::HashMap};
use tokio::sync::RwLock;

use photo_viewer::{
    models::AppState,
    handlers, file_ops, hash, exif_edit,
};

async fn persist_meta_cache_atomic(
    cache_path: &PathBuf,
    snapshot: &HashMap<String, photo_viewer::models::CachedMeta>,
) -> Result<(), String> {
    let buf = serde_json::to_vec_pretty(snapshot)
        .map_err(|e| format!("serialize meta cache failed: {e}"))?;

    let tmp_name = format!(
        ".{}.tmp",
        cache_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("photo_viewer_meta.json")
    );
    let tmp_path = cache_path.with_file_name(tmp_name);

    tokio::fs::write(&tmp_path, &buf)
        .await
        .map_err(|e| format!("write temp cache failed: {e}"))?;
    tokio::fs::rename(&tmp_path, cache_path)
        .await
        .map_err(|e| format!("atomic rename cache failed: {e}"))?;
    Ok(())
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "photo_viewer=info".into()),
        )
        .init();

    let photos_dir = if let Ok(p) = std::env::var("PHOTOS_DIR") {
        PathBuf::from(p)
    } else if let Some(p) = option_env!("DEFAULT_PHOTOS_DIR") {
        PathBuf::from(p)
    } else {
        PathBuf::from("/photos")
    };
    let port = std::env::var("PORT").unwrap_or_else(|_| "3000".to_string());
    let addr = format!("0.0.0.0:{}", port);

    if !photos_dir.exists() {
        eprintln!("⚠  Photos directory does not exist: {}", photos_dir.display());
        eprintln!("   Mount your photo folder with -v /your/photos:/photos");
    }

    tracing::info!("📷  Photo Viewer");
    tracing::info!("    Photos → {}", photos_dir.display());
    tracing::info!("    Listening on http://{}", addr);

    let state = AppState {
        photos_dir: Arc::new(RwLock::new(photos_dir.clone())),
        thumb_cache: Arc::new(RwLock::new(HashMap::new())),
        preview_cache: Arc::new(RwLock::new(HashMap::new())),
        staged_ops: Arc::new(RwLock::new(Vec::new())),
        meta_cache: Arc::new(RwLock::new(HashMap::new())),
        exif_overrides: Arc::new(RwLock::new(HashMap::new())),
    };

    // 尝试从磁盘加载持久化的 meta_cache（位于照片根目录下 .photo_viewer_meta.json）
    let cache_file = {
        let pd = state.photos_dir.read().await.clone();
        pd.join(".photo_viewer_meta.json")
    };
    if cache_file.exists() {
        match tokio::fs::read_to_string(&cache_file).await {
            Ok(s) => {
                match serde_json::from_str::<HashMap<String, photo_viewer::models::CachedMeta>>(&s) {
                    Ok(map) => {
                        let mut cache_guard = state.meta_cache.write().await;
                        for (k, v) in map {
                            cache_guard.insert(k, v);
                        }
                        tracing::info!("Loaded meta_cache from {} ({} entries)", cache_file.display(), cache_guard.len());
                    }
                    Err(e) => tracing::warn!("Failed to parse meta cache: {}", e),
                }
            }
            Err(e) => tracing::warn!("Failed to read meta cache file: {}", e),
        }
    }

    // 人工编辑后的 EXIF 覆盖值（位于照片根目录下 .photo_viewer_exif_overrides.json）
    let exif_override_file = {
        let pd = state.photos_dir.read().await.clone();
        pd.join(".photo_viewer_exif_overrides.json")
    };
    {
        let overrides = exif_edit::load_exif_overrides(&exif_override_file).await;
        if !overrides.is_empty() {
            let mut guard = state.exif_overrides.write().await;
            *guard = overrides;
            tracing::info!(
                "Loaded exif overrides from {} ({} entries)",
                exif_override_file.display(),
                guard.len()
            );
        }
    }

    // 后台周期性保存 meta_cache 到磁盘，避免丢失（每 60 秒，且原子写入）
    {
        let cache_path = cache_file.clone();
        let meta_cache = state.meta_cache.clone();
        tokio::spawn(async move {
            let mut last_saved: Option<Vec<u8>> = None;
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                let snapshot = {
                    let guard = meta_cache.read().await;
                    guard.clone()
                };

                let current = match serde_json::to_vec_pretty(&snapshot) {
                    Ok(buf) => buf,
                    Err(e) => {
                        tracing::warn!("Failed to serialize meta cache: {}", e);
                        continue;
                    }
                };

                if last_saved.as_ref() == Some(&current) {
                    continue;
                }

                match persist_meta_cache_atomic(&cache_path, &snapshot).await {
                    Ok(()) => {
                        last_saved = Some(current);
                    }
                    Err(e) => {
                        tracing::warn!("Failed to persist meta cache: {}", e);
                    }
                }
            }
        });
    }

    let app = Router::new()
        .route("/", get(handlers::serve_frontend))
        .route("/view", get(handlers::serve_frontend))
        .route("/view/*path", get(handlers::serve_frontend))
        .route("/static/*path", get(handlers::serve_static))
        .route("/api/photos", get(handlers::list_photos))
        .route("/photos/*subpath", get(handlers::serve_photo))
        .route("/preview/*subpath", get(handlers::serve_preview))
        .route("/thumb/*subpath", get(handlers::serve_thumb))
        .route("/api/stage", post(file_ops::stage_op))
        .route("/api/stage/list", get(file_ops::list_stage))
        .route("/api/stage/clear", post(file_ops::clear_stage))
        .route("/api/stage/apply", post(file_ops::apply_stage))
        .route("/api/stage/remove/:id", post(file_ops::remove_staged))
        .route("/api/trash/list", get(file_ops::list_trash))
        .route("/api/hash/*subpath", get(hash::hash_file))
        .route("/api/compare", get(hash::compare_photos))
        .route("/api/exif/lens/*subpath", get(handlers::lens_model_for_photo))
        .route("/api/exif/update", post(exif_edit::update_exif))
        .route("/api/admin/allow_set_dir", get(handlers::allow_runtime_dir_change))
        .route("/api/admin/set_photos_dir", post(handlers::set_photos_dir))
        .with_state(state.clone());

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("Failed to bind");

    // 优雅退出时执行最后一次落盘
    let shutdown_meta_cache = state.meta_cache.clone();
    let shutdown_cache_path = cache_file.clone();
    let shutdown_exif_overrides = state.exif_overrides.clone();
    let shutdown_exif_overrides_path = exif_override_file.clone();
    let shutdown = async move {
        if let Err(e) = tokio::signal::ctrl_c().await {
            tracing::warn!("Failed to listen for shutdown signal: {}", e);
            return;
        }

        tracing::info!("Shutdown signal received, flushing meta cache...");
        let snapshot = {
            let guard = shutdown_meta_cache.read().await;
            guard.clone()
        };

        if let Err(e) = persist_meta_cache_atomic(&shutdown_cache_path, &snapshot).await {
            tracing::warn!("Failed to flush meta cache on shutdown: {}", e);
        }

        let exif_snapshot = {
            let guard = shutdown_exif_overrides.read().await;
            guard.clone()
        };
        if let Err(e) = exif_edit::persist_exif_overrides_atomic(
            &shutdown_exif_overrides_path,
            &exif_snapshot,
        )
        .await
        {
            tracing::warn!("Failed to flush exif overrides on shutdown: {}", e);
        }
    };

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await
        .expect("Server error");
}

