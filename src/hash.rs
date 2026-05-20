use axum::{
    extract::{Path, Query},
    http::StatusCode,
    Json,
};
use serde_json::json;
use std::collections::HashMap;
use sha2::{Digest, Sha256};

use crate::models::AppState;
use crate::utils::{safe_subpath, compute_ahash};

/// 对文件进行哈希计算
pub async fn hash_file(
    Path(subpath): Path<String>,
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Result<(StatusCode, Json<serde_json::Value>), StatusCode> {
    if !safe_subpath(&subpath) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let path = {
        let pd = state.photos_dir.read().await.clone();
        pd.join(&subpath)
    };
    let data = tokio::fs::read(&path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;

    // SHA256 哈希
    let mut hasher = Sha256::new();
    hasher.update(&data);
    let sha = hasher.finalize();
    let sha_hex = hex::encode(sha);

    // 感知哈希：8x8 平均哈希 (aHash)
    let img = image::load_from_memory(&data)
        .map_err(|_| StatusCode::UNPROCESSABLE_ENTITY)?;
    let ph = compute_ahash(&img);
    let ph_hex = format!("{:016x}", ph);

    Ok((
        StatusCode::OK,
        Json(json!({"sha256": sha_hex, "phash": ph_hex})),
    ))
}

/// 比较两张照片
pub async fn compare_photos(
    Query(q): Query<HashMap<String, String>>,
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Result<(StatusCode, Json<serde_json::Value>), (StatusCode, String)> {
    let a = q
        .get("a")
        .ok_or((StatusCode::BAD_REQUEST, "missing a".into()))?;
    let b = q
        .get("b")
        .ok_or((StatusCode::BAD_REQUEST, "missing b".into()))?;
    if !safe_subpath(a) || !safe_subpath(b) {
        return Err((StatusCode::BAD_REQUEST, "invalid path".into()));
    }
    let pa = {
        let pd = state.photos_dir.read().await.clone();
        pd.join(a)
    };
    let pb = {
        let pd = state.photos_dir.read().await.clone();
        pd.join(b)
    };
    let da = tokio::fs::read(&pa)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "a not found".into()))?;
    let db = tokio::fs::read(&pb)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "b not found".into()))?;

    let mut sha = Sha256::new();
    sha.update(&da);
    let sha_a = hex::encode(sha.finalize_reset());
    sha.update(&db);
    let sha_b = hex::encode(sha.finalize());

    let img_a = image::load_from_memory(&da)
        .map_err(|_| (StatusCode::UNPROCESSABLE_ENTITY, "a unreadable".into()))?;
    let img_b = image::load_from_memory(&db)
        .map_err(|_| (StatusCode::UNPROCESSABLE_ENTITY, "b unreadable".into()))?;
    let ha = compute_ahash(&img_a);
    let hb = compute_ahash(&img_b);
    let dist = (ha ^ hb).count_ones();
    Ok((
        StatusCode::OK,
        Json(json!({"sha_a": sha_a, "sha_b": sha_b, "phash_dist": dist})),
    ))
}
