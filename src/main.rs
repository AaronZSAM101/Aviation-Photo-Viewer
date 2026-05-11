use axum::{
    routing::{get, post},
    Router,
};
use std::{path::PathBuf, sync::Arc, collections::HashMap};
use tokio::sync::RwLock;

use photo_viewer::{
    models::AppState,
    handlers, file_ops, hash,
};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "photo_viewer=info".into()),
        )
        .init();

    let photos_dir = PathBuf::from(
        std::env::var("PHOTOS_DIR").unwrap_or_else(|_| "/photos".to_string()),
    );
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
        photos_dir: Arc::new(photos_dir),
        thumb_cache: Arc::new(RwLock::new(HashMap::new())),
        preview_cache: Arc::new(RwLock::new(HashMap::new())),
        staged_ops: Arc::new(RwLock::new(Vec::new())),
        meta_cache: Arc::new(RwLock::new(HashMap::new())),
    };

    let app = Router::new()
        .route("/", get(handlers::serve_frontend))
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
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("Failed to bind");
    axum::serve(listener, app).await.expect("Server error");
}

