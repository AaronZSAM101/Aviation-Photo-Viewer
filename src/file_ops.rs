use axum::{
    extract::Path,
    http::StatusCode,
    Json,
};
use serde_json::json;
use tokio::fs;
use uuid::Uuid;

use crate::models::{AppState, OpKind, StagedOp};
use crate::utils::safe_subpath;

/// 暂存一个文件操作
pub async fn stage_op(
    axum::extract::State(state): axum::extract::State<AppState>,
    body: axum::body::Bytes,
) -> (StatusCode, Json<serde_json::Value>) {
    let req: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"invalid json"})),
            )
        }
    };
    let kind = req.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    let src = req.get("src").and_then(|v| v.as_str()).unwrap_or("");
    let dst = req
        .get("dst")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let replace = req.get("replace").and_then(|v| v.as_bool()).unwrap_or(false);

    if src.is_empty() || !safe_subpath(src) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid src"})),
        );
    }
    if let Some(d) = &dst {
        if !safe_subpath(d) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"invalid dst"})),
            );
        }
    }

    let kind_enum = match kind.to_lowercase().as_str() {
        "delete" => OpKind::Delete,
        "move" => OpKind::Move,
        "copy" => OpKind::Copy,
        "rename" => OpKind::Rename,
        "restore" => OpKind::Restore,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"unknown op kind"})),
            )
        }
    };

    if matches!(kind_enum, OpKind::Move | OpKind::Copy | OpKind::Rename) && dst.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"dst required"})),
        );
    }

    if matches!(kind_enum, OpKind::Rename) {
        let d = match &dst {
            Some(v) => v,
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error":"dst required"})),
                )
            }
        };

        let src_parent = std::path::Path::new(src)
            .parent()
            .and_then(|p| p.to_str())
            .unwrap_or("");
        let dst_parent = std::path::Path::new(d)
            .parent()
            .and_then(|p| p.to_str())
            .unwrap_or("");
        let dst_name = std::path::Path::new(d)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");

        if dst_name.is_empty() || dst_name.contains('/') || dst_name.contains('\\') {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"rename only accepts filename"})),
            );
        }
        if src_parent != dst_parent {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"rename only supports same folder"})),
            );
        }
    }

    let op = StagedOp {
        id: Uuid::new_v4().to_string(),
        kind: kind_enum,
        src: src.to_string(),
        dst,
        replace,
    };
    state.staged_ops.write().await.push(op.clone());
    (StatusCode::CREATED, Json(json!({"staged": op})))
}

/// 列出所有待处理的文件操作
pub async fn list_stage(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Json<Vec<StagedOp>> {
    let ops = state.staged_ops.read().await.clone();
    Json(ops)
}

/// 清空所有待处理的文件操作
pub async fn clear_stage(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> StatusCode {
    state.staged_ops.write().await.clear();
    StatusCode::NO_CONTENT
}

/// 应用所有待处理的文件操作
pub async fn apply_stage(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Result<(StatusCode, Json<serde_json::Value>), (StatusCode, String)> {
    let mut ops = state.staged_ops.write().await;
    if ops.is_empty() {
        return Ok((StatusCode::OK, Json(json!({"applied":0}))));
    }

    // 确保垃圾桶目录存在
    let trash_dir = {
        let pd = state.photos_dir.read().await.clone();
        pd.join(".trash")
    };
    if let Err(e) = fs::create_dir_all(&trash_dir).await {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to create trash: {}", e),
        ));
    }

    // 验证操作
    for op in ops.iter() {
        match op.kind {
            OpKind::Move | OpKind::Rename | OpKind::Copy => {
                if let Some(dst_rel) = &op.dst {
                    let dst = {
                        let pd = state.photos_dir.read().await.clone();
                        pd.join(dst_rel)
                    };
                    let src = {
                        let pd = state.photos_dir.read().await.clone();
                        pd.join(&op.src)
                    };
                    if dst.exists() && dst != src && !op.replace {
                        return Err((
                            StatusCode::CONFLICT,
                            format!("destination already exists: {}", dst_rel),
                        ));
                    }
                }
            }
            _ => {}
        }
    }

    let mut applied = 0usize;
    // 执行操作
    for op in ops.drain(..) {
        let src = {
            let pd = state.photos_dir.read().await.clone();
            pd.join(&op.src)
        };
        match op.kind {
            OpKind::Delete => {
                // 移动到垃圾桶（带UUID后缀避免冲突）
                let target = trash_dir.join(format!("{}-{}", op.src.replace('/', "_"), Uuid::new_v4()));
                if let Some(p) = target.parent() {
                    let _ = fs::create_dir_all(p).await;
                }
                let _ = fs::rename(&src, &target).await;
                applied += 1;
            }
            OpKind::Restore => {
                // src 是垃圾文件名, dst 是原始路径（可选）
                if let Some(dst_rel) = op.dst {
                    let dst = {
                        let pd = state.photos_dir.read().await.clone();
                        pd.join(&dst_rel)
                    };
                    if let Some(p) = dst.parent() {
                        let _ = fs::create_dir_all(p).await;
                    }
                    let _ = fs::rename(&src, &dst).await;
                    applied += 1;
                } else {
                    // 从垃圾文件名中提取原始名称（格式: "path_to_file-{UUID}"）
                    // UUID长度36字符 (8-4-4-4-12)
                    if let Some(name) = src.file_name() {
                        if let Some(s) = name.to_str() {
                            if s.len() > 37 && s.chars().nth(s.len() - 37) == Some('-') {
                                let orig_name = &s[..s.len() - 37];
                                let restored = {
                                    let pd = state.photos_dir.read().await.clone();
                                    pd.join(orig_name.replace('_', "/"))
                                };
                                if let Some(p) = restored.parent() {
                                    let _ = fs::create_dir_all(p).await;
                                }
                                let _ = fs::rename(&src, &restored).await;
                                applied += 1;
                            }
                        }
                    }
                }
            }
            OpKind::Move | OpKind::Rename => {
                if let Some(dst_rel) = op.dst {
                    let dst = {
                        let pd = state.photos_dir.read().await.clone();
                        pd.join(&dst_rel)
                    };
                    if op.replace && dst.exists() && dst != src {
                        let _ = fs::remove_file(&dst).await;
                    }
                    if let Some(p) = dst.parent() {
                        let _ = fs::create_dir_all(p).await;
                    }
                    let _ = fs::rename(&src, &dst).await;
                    applied += 1;
                }
            }
            OpKind::Copy => {
                if let Some(dst_rel) = op.dst {
                    let dst = {
                        let pd = state.photos_dir.read().await.clone();
                        pd.join(&dst_rel)
                    };
                    if op.replace && dst.exists() && dst != src {
                        let _ = fs::remove_file(&dst).await;
                    }
                    if let Some(p) = dst.parent() {
                        let _ = fs::create_dir_all(p).await;
                    }
                    let _ = fs::copy(&src, &dst).await;
                    applied += 1;
                }
            }
        }
    }

    Ok((StatusCode::OK, Json(json!({"applied": applied}))))
}

/// 列出垃圾桶中的文件
pub async fn list_trash(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Json<Vec<serde_json::Value>> {
    let trash_dir = {
        let pd = state.photos_dir.read().await.clone();
        pd.join(".trash")
    };
    let mut items = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&trash_dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                items.push(json!({"name": name}));
            }
        }
    }
    Json(items)
}

/// 从暂存队列中移除一个操作
pub async fn remove_staged(
    Path(op_id): Path<String>,
    axum::extract::State(state): axum::extract::State<AppState>,
) -> StatusCode {
    let mut ops = state.staged_ops.write().await;
    ops.retain(|op| op.id != op_id);
    StatusCode::NO_CONTENT
}
