use axum::{extract::Path, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    path::Path as FsPath,
    process::Command,
};
use tokio::fs;
use uuid::Uuid;

use crate::utils::safe_subpath;
use crate::{
    cache_paths, exif_edit,
    models::{AppState, ExifData, OpKind, StagedOp},
};

// ─── 缓存迁移辅助 ────────────────────────────────────────────────────────────

/// rename/move 成功后：将所有缓存的旧路径条目迁移到新路径
/// 让前端在同一次刷新内就能看到正确的 EXIF / 缩略图，不必等下一次扫描
async fn move_cache_entries(state: &AppState, old_key: &str, new_key: &str) {
    macro_rules! migrate {
        ($field:ident) => {{
            let mut cache = state.$field.write().await;
            if let Some(entry) = cache.remove(old_key) {
                cache.insert(new_key.to_string(), entry);
            }
        }};
    }
    migrate!(meta_cache);
    migrate!(thumb_cache);
    migrate!(preview_cache);
    migrate!(phash_cache);
    migrate!(exif_overrides);
}

/// copy 成功后：将缓存条目从源路径复制到目标路径（源条目保留）
async fn copy_cache_entries(state: &AppState, src_key: &str, dst_key: &str) {
    macro_rules! duplicate {
        ($field:ident) => {{
            let mut cache = state.$field.write().await;
            if let Some(entry) = cache.get(src_key).cloned() {
                cache.insert(dst_key.to_string(), entry);
            }
        }};
    }
    duplicate!(meta_cache);
    duplicate!(thumb_cache);
    duplicate!(preview_cache);
    duplicate!(phash_cache);
    // exif_overrides 不复制：新文件是独立的，用户若需要可单独编辑
}

/// delete 成功后：主动清除已删文件的缓存，避免等待下次 list_photos 才清理
async fn remove_cache_entries(state: &AppState, key: &str) {
    macro_rules! evict {
        ($field:ident) => {{
            state.$field.write().await.remove(key);
        }};
    }
    evict!(meta_cache);
    evict!(thumb_cache);
    evict!(preview_cache);
    evict!(phash_cache);
    evict!(exif_overrides);
}

async fn remove_persisted_exif_override(
    state: &AppState,
    photos_dir: &FsPath,
    key: &str,
) -> Result<(), String> {
    let snapshot = {
        let mut overrides = state.exif_overrides.write().await;
        overrides.remove(key);
        overrides.clone()
    };
    exif_edit::persist_exif_overrides_atomic(&cache_paths::exif_overrides(photos_dir), &snapshot)
        .await
}

const TRASH_MANIFEST: &str = ".manifest.json";

fn exiftool_set(args: &mut Vec<String>, tag: &str, value: &Option<String>) {
    if let Some(value) = value.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        args.push(format!("-{}={}", tag, value));
    }
}

fn exiftool_set_u32(args: &mut Vec<String>, tag: &str, value: Option<u32>) {
    if let Some(value) = value {
        args.push(format!("-{}={}", tag, value));
    }
}

fn normalize_f_number(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('f')
        .trim_start_matches('F')
        .trim_start_matches('/')
        .trim()
        .to_string()
}

fn split_exif_datetime(value: &str) -> Option<(&str, &str)> {
    let mut parts = value.trim().split_whitespace();
    let date = parts.next()?;
    let time = parts.next().unwrap_or("00:00:00");
    if date.len() >= 10 {
        Some((&date[..10], time))
    } else {
        None
    }
}

fn exiftool_args_for_update(exif: &ExifData) -> Vec<String> {
    let mut args = vec!["-overwrite_original".to_string(), "-P".to_string()];

    exiftool_set(&mut args, "DateTimeOriginal", &exif.date_taken);
    exiftool_set(&mut args, "CreateDate", &exif.date_taken);
    exiftool_set(&mut args, "Make", &exif.make);
    exiftool_set(&mut args, "Model", &exif.model);
    exiftool_set(&mut args, "LensModel", &exif.lens_model);
    exiftool_set(&mut args, "Software", &exif.software);
    exiftool_set(&mut args, "ISO", &exif.iso);
    exiftool_set(&mut args, "ExposureTime", &exif.exposure_time);
    if let Some(f_number) = exif.f_number.as_deref() {
        let normalized = normalize_f_number(f_number);
        if !normalized.is_empty() {
            args.push(format!("-FNumber={normalized}"));
        }
    }
    exiftool_set(&mut args, "FocalLength", &exif.focal_length);
    exiftool_set(
        &mut args,
        "FocalLengthIn35mmFormat",
        &exif.focal_length_35mm,
    );
    exiftool_set_u32(&mut args, "ExifImageWidth", exif.image_width);
    exiftool_set_u32(&mut args, "ExifImageHeight", exif.image_height);

    if let Some(lat) = exif.gps_lat.filter(|v| v.is_finite()) {
        args.push(format!("-GPSLatitude={}", lat.abs()));
        args.push(format!(
            "-GPSLatitudeRef={}",
            if lat < 0.0 { "S" } else { "N" }
        ));
    }
    if let Some(lon) = exif.gps_lon.filter(|v| v.is_finite()) {
        args.push(format!("-GPSLongitude={}", lon.abs()));
        args.push(format!(
            "-GPSLongitudeRef={}",
            if lon < 0.0 { "W" } else { "E" }
        ));
    }
    if exif.gps_lat.is_some() || exif.gps_lon.is_some() || exif.gps_altitude.is_some() {
        args.push("-GPSVersionID=2.3.0.0".to_string());
        args.push("-GPSMapDatum=WGS-84".to_string());
        if let Some(date_taken) = exif.date_taken.as_deref() {
            if let Some((date, time)) = split_exif_datetime(date_taken) {
                args.push(format!("-GPSDateStamp={date}"));
                args.push(format!("-GPSTimeStamp={time}"));
            }
        }
    }
    if let Some(alt) = exif.gps_altitude.filter(|v| v.is_finite()) {
        args.push(format!("-GPSAltitude={}", alt.abs()));
        args.push(format!(
            "-GPSAltitudeRef#={}",
            if alt < 0.0 { 1 } else { 0 }
        ));
    }

    args
}

fn write_exif_to_file(path: &FsPath, exif: &ExifData) -> Result<(), String> {
    let mut args = exiftool_args_for_update(exif);
    if args.len() <= 2 {
        return Ok(());
    }
    args.push(path.to_string_lossy().to_string());

    let output = Command::new("exiftool")
        .args(&args)
        .output()
        .map_err(|e| format!("failed to run exiftool: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        Err(format!(
            "exiftool failed for {}: {}{}",
            path.display(),
            stderr.trim(),
            stdout.trim()
        ))
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct TrashManifestEntry {
    original: String,
}

type TrashManifest = HashMap<String, TrashManifestEntry>;

fn is_generated_trash_name(name: &str) -> bool {
    name.len() == 32 && name.chars().all(|c| c.is_ascii_hexdigit())
}

fn legacy_original_from_trash_name(name: &str) -> Option<String> {
    if name.len() > 37 && name.chars().nth(name.len() - 37) == Some('-') {
        Some(name[..name.len() - 37].replace('_', "/"))
    } else {
        None
    }
}

async fn read_trash_manifest(trash_dir: &FsPath) -> TrashManifest {
    match fs::read_to_string(trash_dir.join(TRASH_MANIFEST)).await {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => TrashManifest::default(),
    }
}

async fn write_trash_manifest(trash_dir: &FsPath, manifest: &TrashManifest) -> std::io::Result<()> {
    let data = serde_json::to_vec_pretty(manifest)?;
    let manifest_path = trash_dir.join(TRASH_MANIFEST);
    // 原子写入：先写 tmp，再 rename，防止崩溃时 manifest 损坏
    let tmp_path = trash_dir.join(format!(".{}.tmp", TRASH_MANIFEST));
    fs::write(&tmp_path, data).await?;
    fs::rename(&tmp_path, &manifest_path).await
}

async fn migrate_legacy_trash_names(
    trash_dir: &FsPath,
    manifest: &mut TrashManifest,
) -> std::io::Result<bool> {
    let mut dirty = false;
    let mut dir = match fs::read_dir(trash_dir).await {
        Ok(dir) => dir,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };

    while let Some(entry) = dir.next_entry().await? {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        if name == TRASH_MANIFEST || name.starts_with('.') || is_generated_trash_name(name) {
            continue;
        }

        let original = manifest
            .remove(name)
            .map(|entry| entry.original)
            .or_else(|| legacy_original_from_trash_name(name))
            .unwrap_or_else(|| name.to_string());

        let new_name = loop {
            let candidate = Uuid::new_v4().simple().to_string();
            if !trash_dir.join(&candidate).exists() {
                break candidate;
            }
        };

        fs::rename(entry.path(), trash_dir.join(&new_name)).await?;
        manifest.insert(new_name, TrashManifestEntry { original });
        dirty = true;
    }

    Ok(dirty)
}

/// 暂存一个文件操作
pub async fn stage_op(
    axum::extract::State(state): axum::extract::State<AppState>,
    body: axum::body::Bytes,
) -> (StatusCode, Json<serde_json::Value>) {
    if state.read_only {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"read-only mode enabled"})),
        );
    }

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
    let replace = req
        .get("replace")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let exif = req
        .get("exif")
        .cloned()
        .and_then(|v| serde_json::from_value::<ExifData>(v).ok());

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
        "exif" => OpKind::Exif,
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

    if matches!(kind_enum, OpKind::Exif) && exif.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"exif required"})),
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
        exif,
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
    if state.read_only {
        return StatusCode::FORBIDDEN;
    }

    state.staged_ops.write().await.clear();
    StatusCode::NO_CONTENT
}

/// 应用所有待处理的文件操作
pub async fn apply_stage(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Result<(StatusCode, Json<serde_json::Value>), (StatusCode, String)> {
    if state.read_only {
        return Err((StatusCode::FORBIDDEN, "read-only mode enabled".to_string()));
    }

    // 步骤1：拍快照（read lock，快速释放），用于冲突预检
    let ops_snapshot = {
        let ops = state.staged_ops.read().await;
        if ops.is_empty() {
            return Ok((StatusCode::OK, Json(json!({"applied":0}))));
        }
        ops.clone()
    };

    // 步骤2：一次性读取 photos_dir，整个 apply 过程使用同一目录
    let photos_dir = state.photos_dir.read().await.clone();
    let trash_dir = photos_dir.join(".trash");

    if let Err(e) = fs::create_dir_all(&trash_dir).await {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to create trash: {}", e),
        ));
    }

    // 步骤3：冲突预检（同步 exists()，stat 系统调用，速度快，不持长锁）
    for op in &ops_snapshot {
        match op.kind {
            OpKind::Move | OpKind::Rename | OpKind::Copy => {
                if let Some(dst_rel) = &op.dst {
                    let dst = photos_dir.join(dst_rel);
                    let src = photos_dir.join(&op.src);
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

    // 步骤4：从队列中精确取出已验证的操作（write lock 仅用于 drain，立即释放）
    // 验证期间新加入的操作不会被误取走，依然保留在队列中。
    let ops: Vec<StagedOp> = {
        // 用 String（owned）而非 &str，避免跨 .await 的生命周期问题
        let snapshot_ids: HashSet<String> = ops_snapshot.iter().map(|op| op.id.clone()).collect();
        let mut guard = state.staged_ops.write().await;
        let mut to_execute = Vec::with_capacity(ops_snapshot.len());
        let mut remaining = Vec::new();
        for op in guard.drain(..) {
            if snapshot_ids.contains(op.id.as_str()) {
                to_execute.push(op);
            } else {
                remaining.push(op);
            }
        }
        *guard = remaining;
        to_execute
        // write lock 在此释放
    };

    // 步骤5：执行文件操作（不持任何锁）
    let mut applied = 0usize;
    let mut trash_manifest = read_trash_manifest(&trash_dir).await;
    let legacy_migrated = migrate_legacy_trash_names(&trash_dir, &mut trash_manifest)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to migrate trash names: {}", e),
            )
        })?;
    let mut trash_manifest_dirty = false;
    if legacy_migrated {
        trash_manifest_dirty = true;
    }

    for op in ops {
        let src = photos_dir.join(&op.src);
        match op.kind {
            OpKind::Delete => {
                // 移动到垃圾桶：文件名使用无扩展名的 32 位 hex，避免被图片软件扫描到。
                let trash_name = Uuid::new_v4().simple().to_string();
                let target = trash_dir.join(&trash_name);
                if let Some(p) = target.parent() {
                    let _ = fs::create_dir_all(p).await;
                }
                if fs::rename(&src, &target).await.is_ok() {
                    trash_manifest.insert(
                        trash_name,
                        TrashManifestEntry {
                            original: op.src.clone(),
                        },
                    );
                    trash_manifest_dirty = true;
                    // 主动清除已删文件的缓存条目
                    remove_cache_entries(&state, &op.src).await;
                    applied += 1;
                }
            }
            OpKind::Restore => {
                // src 是垃圾文件名, dst 是原始路径（可选）
                if let Some(dst_rel) = op.dst {
                    let dst = photos_dir.join(&dst_rel);
                    if let Some(p) = dst.parent() {
                        let _ = fs::create_dir_all(p).await;
                    }
                    if fs::rename(&src, &dst).await.is_ok() {
                        if let Some(name) = src.file_name().and_then(|name| name.to_str()) {
                            trash_manifest.remove(name);
                            trash_manifest_dirty = true;
                        }
                        applied += 1;
                    }
                } else {
                    if let Some(name) = src.file_name() {
                        if let Some(s) = name.to_str() {
                            if let Some(entry) = trash_manifest.get(s) {
                                let restored = photos_dir.join(&entry.original);
                                if let Some(p) = restored.parent() {
                                    let _ = fs::create_dir_all(p).await;
                                }
                                if fs::rename(&src, &restored).await.is_ok() {
                                    trash_manifest.remove(s);
                                    trash_manifest_dirty = true;
                                    applied += 1;
                                }
                            } else if s.len() > 37 && s.chars().nth(s.len() - 37) == Some('-') {
                                // 兼容旧格式："path_to_file-{UUID}"。
                                let orig_name = &s[..s.len() - 37];
                                let restored = photos_dir.join(orig_name.replace('_', "/"));
                                if let Some(p) = restored.parent() {
                                    let _ = fs::create_dir_all(p).await;
                                }
                                if fs::rename(&src, &restored).await.is_ok() {
                                    applied += 1;
                                }
                            }
                        }
                    }
                }
            }
            OpKind::Move | OpKind::Rename => {
                if let Some(dst_rel) = op.dst {
                    let dst = photos_dir.join(&dst_rel);
                    if op.replace && dst.exists() && dst != src {
                        let _ = fs::remove_file(&dst).await;
                    }
                    if let Some(p) = dst.parent() {
                        let _ = fs::create_dir_all(p).await;
                    }
                    // 修复：只有操作真正成功才计数，并迁移所有缓存条目（旧路径→新路径），
                    // 否则重命名后立即刷新会因缓存 miss 而显示"no exif"
                    if fs::rename(&src, &dst).await.is_ok() {
                        move_cache_entries(&state, &op.src, &dst_rel).await;
                        applied += 1;
                    }
                }
            }
            OpKind::Copy => {
                if let Some(dst_rel) = op.dst {
                    let dst = photos_dir.join(&dst_rel);
                    if op.replace && dst.exists() && dst != src {
                        let _ = fs::remove_file(&dst).await;
                    }
                    if let Some(p) = dst.parent() {
                        let _ = fs::create_dir_all(p).await;
                    }
                    // 修复：只有 copy 真正成功才计数，并将缓存条目复制到新路径
                    if fs::copy(&src, &dst).await.is_ok() {
                        copy_cache_entries(&state, &op.src, &dst_rel).await;
                        applied += 1;
                    }
                }
            }
            OpKind::Exif => {
                if let Some(exif) = op.exif {
                    if let Err(e) = write_exif_to_file(&src, &exif) {
                        return Err((StatusCode::INTERNAL_SERVER_ERROR, e));
                    }
                    remove_cache_entries(&state, &op.src).await;
                    remove_persisted_exif_override(&state, &photos_dir, &op.src)
                        .await
                        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
                    applied += 1;
                }
            }
        }
    }

    if trash_manifest_dirty {
        if let Err(e) = write_trash_manifest(&trash_dir, &trash_manifest).await {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to update trash manifest: {}", e),
            ));
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
    let mut manifest = read_trash_manifest(&trash_dir).await;
    if migrate_legacy_trash_names(&trash_dir, &mut manifest)
        .await
        .unwrap_or(false)
    {
        let _ = write_trash_manifest(&trash_dir, &manifest).await;
    }
    // 使用异步 read_dir，避免阻塞 tokio 工作线程
    if let Ok(mut dir) = tokio::fs::read_dir(&trash_dir).await {
        while let Ok(Some(entry)) = dir.next_entry().await {
            let file_name = entry.file_name();
            if let Some(name) = file_name.to_str() {
                if name == TRASH_MANIFEST || name.starts_with('.') {
                    continue;
                }
                let original = manifest.get(name).map(|e| e.original.clone());
                items.push(json!({"name": name, "original": original}));
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
    if state.read_only {
        return StatusCode::FORBIDDEN;
    }

    let mut ops = state.staged_ops.write().await;
    ops.retain(|op| op.id != op_id);
    StatusCode::NO_CONTENT
}
