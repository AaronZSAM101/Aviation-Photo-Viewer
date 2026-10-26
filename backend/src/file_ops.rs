use actix_web::{web, HttpResponse};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    path::Path as FsPath,
    process::Command,
};
use tokio::fs;
use uuid::Uuid;

use crate::paths::{self, PathError};
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

/// 分批操作执行失败。`conflict == true` 表示目标已存在（覆盖被拒绝）。
#[derive(Debug)]
struct ExecFailure {
    kind: OpKind,
    src: String,
    dst: Option<String>,
    conflict: bool,
    error: String,
}

impl ExecFailure {
    fn to_json(&self) -> serde_json::Value {
        json!({
            "kind": self.kind,
            "src": self.src,
            "dst": self.dst,
            "error": self.error,
        })
    }
}

fn staged_op_key(op: &StagedOp) -> String {
    format!(
        "{:?}\0{}\0{}",
        op.kind,
        op.src,
        op.dst.as_deref().unwrap_or("")
    )
}

fn dedupe_staged_ops(ops: &mut Vec<StagedOp>) {
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut deduped: Vec<StagedOp> = Vec::with_capacity(ops.len());

    for op in ops.drain(..) {
        let key = staged_op_key(&op);
        if let Some(index) = seen.get(&key).copied() {
            let existing = &mut deduped[index];
            existing.replace = existing.replace || op.replace;
            if op.exif.is_some() {
                existing.exif = op.exif;
            }
        } else {
            seen.insert(key, deduped.len());
            deduped.push(op);
        }
    }

    *ops = deduped;
}

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
    // 原子写入：唯一临时文件名 + rename，并发批次不会互相踩掉对方的中间文件
    let tmp_path = trash_dir.join(format!(
        ".{}.{}.tmp",
        TRASH_MANIFEST,
        Uuid::new_v4().simple()
    ));
    if let Err(e) = fs::write(&tmp_path, data).await {
        let _ = fs::remove_file(&tmp_path).await;
        return Err(e);
    }
    if let Err(e) = fs::rename(&tmp_path, &manifest_path).await {
        let _ = fs::remove_file(&tmp_path).await;
        return Err(e);
    }
    Ok(())
}

/// 丢弃“有映射、但回收站里没有对应文件”的条目：删除先写映射再移动文件，
/// 中途被打断会留下这类意图记录，它们不该出现在列表里，也不该阻止后续操作。
async fn reconcile_trash_manifest(trash_dir: &FsPath, manifest: &mut TrashManifest) -> bool {
    let names: Vec<String> = manifest.keys().cloned().collect();
    let mut dirty = false;
    for name in names {
        if fs::symlink_metadata(trash_dir.join(&name)).await.is_err() {
            manifest.remove(&name);
            dirty = true;
        }
    }
    dirty
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
        manifest.insert(
            new_name.clone(),
            TrashManifestEntry {
                original: original.clone(),
            },
        );
        // 迁移后的名字不再带原始路径，映射必须立刻落盘；写不进去就改回旧名字，
        // 让下一次迁移还能重新推导出原始路径。
        if let Err(e) = write_trash_manifest(trash_dir, manifest).await {
            manifest.remove(&new_name);
            manifest.insert(name.to_string(), TrashManifestEntry { original });
            let _ = fs::rename(trash_dir.join(&new_name), entry.path()).await;
            return Err(e);
        }
        dirty = true;
    }

    Ok(dirty)
}

// ─── no-clobber 放置 ─────────────────────────────────────────────────────────
// rename() 与 copy() 都会无条件覆盖目标，"先 exists() 再写" 的预检在两步之间存在
// 竞态，因此执行时改用 link() 作为原子的"目标存在即失败"占位：EEXIST 时目标文件
// 仍在原处，一次应用不会悄悄吃掉照片。

/// 原子地把 `src` 放到 `dst`；`dst` 已存在时返回 `AlreadyExists`，绝不覆盖。
async fn move_noclobber(src: &FsPath, dst: &FsPath) -> std::io::Result<()> {
    fs::hard_link(src, dst).await?;
    if let Err(e) = fs::remove_file(src).await {
        // 回滚占位，源文件保持可见
        let _ = fs::remove_file(dst).await;
        return Err(e);
    }
    Ok(())
}

/// 复制到 `dst`：先写入唯一命名的临时文件，再原子占位。任何一步失败都会清理临时
/// 文件，不会留下被当成成功照片的半成品。
async fn copy_noclobber(src: &FsPath, dst: &FsPath) -> std::io::Result<()> {
    let name = dst.file_name().and_then(|n| n.to_str()).unwrap_or("photo");
    // .pvtmp 结尾不是受支持的图片扩展名，扫描器不会索引半成品
    let tmp = dst.with_file_name(format!("{name}.{}.pvtmp", Uuid::new_v4().simple()));
    if let Err(e) = fs::copy(src, &tmp).await {
        let _ = fs::remove_file(&tmp).await;
        return Err(e);
    }
    let linked = fs::hard_link(&tmp, dst).await;
    let _ = fs::remove_file(&tmp).await;
    linked
}

/// EEXIST 是唯一的"目标已存在"信号：其它错误不能当成覆盖冲突。
fn is_already_exists(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::AlreadyExists
}

fn exec_failure(op: &StagedOp, conflict: bool, error: String) -> ExecFailure {
    ExecFailure {
        kind: op.kind.clone(),
        src: op.src.clone(),
        dst: op.dst.clone(),
        conflict,
        error,
    }
}

/// 每个操作的真实结局：applied / skipped（无改动）/ failed，失败时带原因
fn op_result(op: &StagedOp, status: &str, error: Option<String>) -> serde_json::Value {
    json!({
        "id": op.id,
        "kind": op.kind,
        "src": op.src,
        "dst": op.dst,
        "status": status,
        "error": error,
    })
}

/// 把文件移进回收站：映射先落盘再移动，任何时刻中断都不会丢原始路径。
async fn move_into_trash(
    trash_dir: &FsPath,
    src: &FsPath,
    original: &str,
    manifest: &mut TrashManifest,
) -> std::io::Result<()> {
    let trash_name = Uuid::new_v4().simple().to_string();
    let target = trash_dir.join(&trash_name);
    manifest.insert(
        trash_name.clone(),
        TrashManifestEntry {
            original: original.to_string(),
        },
    );
    if let Err(e) = write_trash_manifest(trash_dir, manifest).await {
        manifest.remove(&trash_name);
        return Err(e);
    }
    if let Err(e) = fs::rename(src, &target).await {
        manifest.remove(&trash_name);
        let _ = write_trash_manifest(trash_dir, manifest).await;
        return Err(e);
    }
    Ok(())
}

/// 执行单个分批操作。返回 `Ok(true)` 表示确实改动了磁盘。
///
/// 队列里的路径在暂存时校验过一次，执行时还要按当前磁盘重新校验：
/// 目录可能在入队后才出现符号链接，`.trash` 里的名字也可能被替换。
async fn execute_staged_op(
    state: &AppState,
    photos_dir: &FsPath,
    trash_dir: &FsPath,
    op: &StagedOp,
    trash_manifest: &mut TrashManifest,
) -> Result<bool, ExecFailure> {
    let fail =
        |error: std::io::Error, conflict: bool| exec_failure(op, conflict, error.to_string());
    let path_fail = |error: PathError| {
        let message = match error {
            PathError::Invalid => "路径不合法：不允许 ..、根路径或保留目录",
            PathError::Denied => "路径包含符号链接或不是普通文件，已拒绝",
            PathError::NotFound => "路径不可用：文件不存在或父路径不是目录",
        };
        exec_failure(op, false, message.to_string())
    };

    match op.kind {
        OpKind::Delete => {
            let src = paths::resolve_user_file(photos_dir, &op.src)
                .await
                .map_err(path_fail)?;
            // 移动到垃圾桶：文件名使用无扩展名的 32 位 hex，避免被图片软件扫描到。
            // 映射写不进去就不动文件，操作留在队列里等下次重试。
            move_into_trash(trash_dir, &src, &op.src, trash_manifest)
                .await
                .map_err(|e| fail(e, false))?;
            remove_cache_entries(state, &op.src).await;
            Ok(true)
        }
        OpKind::Restore => {
            // src 是回收站里的文件名，dst 是原始路径（缺省时按 manifest 推断）
            let src = paths::resolve_trash_file(trash_dir, &op.src)
                .await
                .map_err(path_fail)?;
            let dst_rel = match op.dst.clone() {
                Some(dst) => dst,
                None => {
                    let Some(name) = src.file_name().and_then(|n| n.to_str()) else {
                        return Err(fail(
                            std::io::Error::other("restore source has no name"),
                            false,
                        ));
                    };
                    match trash_manifest.get(name) {
                        Some(entry) => entry.original.clone(),
                        // 兼容旧格式："path_to_file-{UUID}"
                        None => match legacy_original_from_trash_name(name) {
                            Some(original) => original,
                            None => {
                                return Err(fail(
                                    std::io::Error::other(format!(
                                        "no original recorded for {}",
                                        name
                                    )),
                                    false,
                                ))
                            }
                        },
                    }
                }
            };
            paths::validate_destination(photos_dir, &dst_rel)
                .await
                .map_err(path_fail)?;
            let dst = photos_dir.join(&dst_rel);
            ensure_parent(&dst, op).await?;
            if op.replace {
                let _ = fs::remove_file(&dst).await;
            }
            move_noclobber(&src, &dst)
                .await
                .map_err(|e| exec_failure(op, is_already_exists(&e), e.to_string()))?;
            if let Some(name) = src.file_name().and_then(|n| n.to_str()) {
                trash_manifest.remove(name);
            }
            Ok(true)
        }
        OpKind::Move | OpKind::Rename | OpKind::Copy => {
            let Some(dst_rel) = op.dst.clone() else {
                return Err(fail(std::io::Error::other("destination missing"), false));
            };
            let src = paths::resolve_user_file(photos_dir, &op.src)
                .await
                .map_err(path_fail)?;
            let dst = photos_dir.join(&dst_rel);
            if dst == src {
                // 原地移动：无需改动磁盘
                return Ok(false);
            }
            paths::validate_destination(photos_dir, &dst_rel)
                .await
                .map_err(path_fail)?;
            ensure_parent(&dst, op).await?;
            if op.replace {
                let _ = fs::remove_file(&dst).await;
            }
            let placed = if matches!(op.kind, OpKind::Copy) {
                copy_noclobber(&src, &dst).await
            } else {
                move_noclobber(&src, &dst).await
            };
            placed.map_err(|e| exec_failure(op, is_already_exists(&e), e.to_string()))?;
            if matches!(op.kind, OpKind::Copy) {
                copy_cache_entries(state, &op.src, &dst_rel).await;
            } else {
                move_cache_entries(state, &op.src, &dst_rel).await;
            }
            Ok(true)
        }
        OpKind::Exif => {
            let Some(exif) = op.exif.clone() else {
                return Ok(false);
            };
            let src = paths::resolve_user_file(photos_dir, &op.src)
                .await
                .map_err(path_fail)?;
            // EXIF 写盘是同步的，失败按普通错误上报，不伪装成覆盖冲突
            write_exif_to_file(&src, &exif).map_err(|e| exec_failure(op, false, e))?;
            remove_cache_entries(state, &op.src).await;
            remove_persisted_exif_override(state, photos_dir, &op.src)
                .await
                .map_err(|e| exec_failure(op, false, e))?;
            Ok(true)
        }
    }
}

async fn ensure_parent(dst: &FsPath, op: &StagedOp) -> Result<(), ExecFailure> {
    let Some(parent) = dst.parent() else {
        return Ok(());
    };
    fs::create_dir_all(parent).await.map_err(|e| {
        exec_failure(
            op,
            false,
            format!("failed to create {}: {}", parent.display(), e),
        )
    })
}

/// 暂存一个文件操作
pub async fn stage_op(state: web::Data<AppState>, body: web::Bytes) -> HttpResponse {
    if state.read_only {
        return HttpResponse::Forbidden().json(json!({"error":"read-only mode enabled"}));
    }

    let req: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return HttpResponse::BadRequest().json(json!({"error":"invalid json"})),
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

    let kind_enum = match kind.to_lowercase().as_str() {
        "delete" => OpKind::Delete,
        "move" => OpKind::Move,
        "copy" => OpKind::Copy,
        "rename" => OpKind::Rename,
        "restore" => OpKind::Restore,
        "exif" => OpKind::Exif,
        _ => return HttpResponse::BadRequest().json(json!({"error":"unknown op kind"})),
    };

    // restore 的源只能是回收站里的单层文件名；其余操作的源必须是照片库里的普通路径。
    if matches!(kind_enum, OpKind::Restore) {
        if paths::trash_name_from_src(src).is_none() {
            return HttpResponse::BadRequest()
                .json(json!({"error":"restore src must be .trash/<name>"}));
        }
    } else if !paths::is_user_rel_path(src) {
        return HttpResponse::BadRequest().json(json!({"error":"invalid src"}));
    }
    if let Some(d) = &dst {
        if !paths::is_user_rel_path(d) {
            return HttpResponse::BadRequest().json(json!({"error":"invalid dst"}));
        }
    }

    if matches!(kind_enum, OpKind::Move | OpKind::Copy | OpKind::Rename) && dst.is_none() {
        return HttpResponse::BadRequest().json(json!({"error":"dst required"}));
    }

    if matches!(kind_enum, OpKind::Exif) && exif.is_none() {
        return HttpResponse::BadRequest().json(json!({"error":"exif required"}));
    }

    if matches!(kind_enum, OpKind::Rename) {
        let d = match &dst {
            Some(v) => v,
            None => return HttpResponse::BadRequest().json(json!({"error":"dst required"})),
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
            return HttpResponse::BadRequest()
                .json(json!({"error":"rename only accepts filename"}));
        }
        if src_parent != dst_parent {
            return HttpResponse::BadRequest()
                .json(json!({"error":"rename only supports same folder"}));
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

    let mut staged_ops = state.staged_ops.write().await;
    dedupe_staged_ops(&mut staged_ops);
    if let Some(existing) = staged_ops
        .iter_mut()
        .find(|existing| staged_op_key(existing) == staged_op_key(&op))
    {
        existing.replace = existing.replace || op.replace;
        if op.exif.is_some() {
            existing.exif = op.exif.clone();
        }
        return HttpResponse::Ok().json(json!({"staged": existing.clone(), "deduped": true}));
    }

    staged_ops.push(op.clone());
    HttpResponse::Created().json(json!({"staged": op, "deduped": false}))
}

/// 列出所有待处理的文件操作
pub async fn list_stage(state: web::Data<AppState>) -> HttpResponse {
    let ops = {
        let mut ops = state.staged_ops.write().await;
        dedupe_staged_ops(&mut ops);
        ops.clone()
    };
    HttpResponse::Ok().json(ops)
}

/// 清空所有待处理的文件操作
pub async fn clear_stage(state: web::Data<AppState>) -> HttpResponse {
    if state.read_only {
        return HttpResponse::Forbidden().finish();
    }

    state.staged_ops.write().await.clear();
    HttpResponse::NoContent().finish()
}

/// 按队列顺序模拟磁盘占用，返回所有"目标已存在且用户未确认替换"的操作。
/// 只是提前给出整批的冲突清单；执行时的 EEXIST 才是最终权威。
fn precheck_conflicts(photos_dir: &FsPath, ops: &[StagedOp]) -> Vec<serde_json::Value> {
    let mut conflicts = Vec::new();
    // 本批次中已经腾空的源路径（删除或移走后的位置，可以被后续操作复用）
    let mut freed: HashSet<&str> = HashSet::new();
    // 本批次中已被前面操作占用的目标路径
    let mut claimed: HashSet<&str> = HashSet::new();

    for op in ops {
        if op.kind == OpKind::Exif {
            continue;
        }
        if op.kind == OpKind::Delete {
            freed.insert(op.src.as_str());
            claimed.remove(op.src.as_str());
            continue;
        }
        let Some(dst_rel) = op.dst.as_ref() else {
            continue;
        };
        if dst_rel == &op.src {
            // 原地移动，不存在覆盖
            continue;
        }
        let same_batch = claimed.contains(dst_rel.as_str());
        let vacated = freed.contains(dst_rel.as_str());
        let on_disk = !vacated && photos_dir.join(dst_rel).exists();
        if (same_batch || on_disk) && !op.replace {
            let reason = if same_batch {
                "batch-same-destination"
            } else {
                "destination-exists"
            };
            conflicts.push(json!({
                "kind": op.kind.clone(),
                "src": op.src.clone(),
                "dst": dst_rel.clone(),
                "reason": reason,
            }));
            continue;
        }
        claimed.insert(dst_rel.as_str());
        if op.kind != OpKind::Copy {
            freed.insert(op.src.as_str());
            claimed.remove(op.src.as_str());
        }
    }

    conflicts
}

/// 应用所有待处理的文件操作
pub async fn apply_stage(state: web::Data<AppState>) -> HttpResponse {
    if state.read_only {
        return HttpResponse::Forbidden().body("read-only mode enabled");
    }

    // 步骤1：整理队列并拍快照（write lock 只用于去重，快速释放），用于冲突预检
    let ops_snapshot = {
        let mut ops = state.staged_ops.write().await;
        dedupe_staged_ops(&mut ops);
        if ops.is_empty() {
            return HttpResponse::Ok().json(json!({"applied":0}));
        }
        ops.clone()
    };

    // 步骤2：一次性读取 photos_dir，整个 apply 过程使用同一目录
    let photos_dir = state.photos_dir.read().await.clone();
    let trash_dir = photos_dir.join(".trash");

    if let Err(e) = fs::create_dir_all(&trash_dir).await {
        return HttpResponse::InternalServerError().body(format!("failed to create trash: {}", e));
    }

    // 步骤3：冲突预检（同步 exists()，stat 系统调用，速度快，不持长锁）
    // 预检按队列顺序模拟磁盘状态，因此同批次两个操作抢同一个目标也能被提前发现。
    // 真正的权威仍是执行时 link() 返回的 EEXIST：预检与执行之间目标可能出现，
    // 此时批次会中止并把未完成的操作退回队列。
    let pre_found = precheck_conflicts(&photos_dir, &ops_snapshot);
    if !pre_found.is_empty() {
        return HttpResponse::Conflict().json(json!({
            "error": "目标已存在，覆盖已被拒绝；相关操作仍保留在分批队列中",
            "conflicts": pre_found,
        }));
    }

    // 步骤4：回收站 manifest。apply 之间用 trash_lock 串行，避免并发批次互相覆盖映射；
    // 整个准备过程在取走队列之前，失败时操作仍完整留在队列里。
    let _trash_guard = state.trash_lock.lock().await;
    let mut trash_manifest = read_trash_manifest(&trash_dir).await;
    if reconcile_trash_manifest(&trash_dir, &mut trash_manifest).await {
        if let Err(e) = write_trash_manifest(&trash_dir, &trash_manifest).await {
            tracing::warn!("Failed to persist reconciled trash manifest: {}", e);
        }
    }
    if let Err(e) = migrate_legacy_trash_names(&trash_dir, &mut trash_manifest).await {
        return HttpResponse::InternalServerError()
            .body(format!("failed to migrate trash names: {}", e));
    }

    // 步骤5：从队列中精确取出已验证的操作（write lock 仅用于 drain，立即释放）
    // 验证期间新加入的操作不会被误取走，依然保留在队列中。
    let ops: Vec<StagedOp> = {
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

    // 步骤6：执行文件操作（不持队列锁）。任一操作失败即中止，剩余操作退回队列。
    let mut applied = 0usize;
    let mut restore_dirty = false;
    let mut results: Vec<serde_json::Value> = Vec::with_capacity(ops.len());
    let mut failure: Option<ExecFailure> = None;
    let mut failed_at = ops.len();

    for (index, op) in ops.iter().enumerate() {
        match execute_staged_op(&state, &photos_dir, &trash_dir, op, &mut trash_manifest).await {
            Ok(true) => {
                applied += 1;
                // 删除的映射是先写后移，已经落盘；还原是把文件移出后删映射，需要补写
                if matches!(op.kind, OpKind::Restore) {
                    restore_dirty = true;
                }
                results.push(op_result(op, "applied", None));
            }
            Ok(false) => results.push(op_result(op, "skipped", None)),
            Err(error) => {
                results.push(op_result(op, "failed", Some(error.error.clone())));
                failure = Some(error);
                failed_at = index;
                break;
            }
        }
    }

    // 还原已经把文件移出 .trash，映射删不掉只会留下指向缺失文件的陈旧条目，
    // 下次 reconcile 会清掉，因此这里只记警告，不把成功的还原报成失败。
    if restore_dirty {
        if let Err(e) = write_trash_manifest(&trash_dir, &trash_manifest).await {
            tracing::warn!("Failed to persist trash manifest after restore: {}", e);
        }
    }

    if let Some(failure) = failure {
        // 失败的那一条及其后的操作退回队列，保留 id 与顺序，可以直接再次应用
        let pending = {
            let mut queue = state.staged_ops.write().await;
            for pending in ops[failed_at..].iter().rev() {
                queue.insert(0, pending.clone());
            }
            queue.len()
        };

        let dst = failure.dst.as_deref().unwrap_or("");
        let error = if failure.conflict {
            format!("目标已存在，覆盖已被拒绝：{} → {}", failure.src, dst)
        } else {
            format!("操作失败：{}（{}）", failure.src, failure.error)
        };
        let failed = failure.to_json();
        let conflicts: Vec<serde_json::Value> = if failure.conflict {
            vec![failed.clone()]
        } else {
            Vec::new()
        };
        if failure.conflict {
            return HttpResponse::Conflict().json(json!({
                "error": error,
                "applied": applied,
                "conflicts": conflicts,
                "failed": failed,
                "results": results,
                "pending": pending,
            }));
        }
        return HttpResponse::InternalServerError().json(json!({
            "error": error,
            "applied": applied,
            "failed": failed,
            "results": results,
            "pending": pending,
        }));
    }

    let pending = state.staged_ops.read().await.len();
    HttpResponse::Ok().json(json!({"applied": applied, "results": results, "pending": pending}))
}

/// 列出垃圾桶中的文件
pub async fn list_trash(state: web::Data<AppState>) -> HttpResponse {
    let trash_dir = {
        let pd = state.photos_dir.read().await.clone();
        pd.join(".trash")
    };
    let mut items = Vec::new();
    let mut manifest = read_trash_manifest(&trash_dir).await;
    // 只读模式绝不允许一次 GET 触发改名或写盘；可写实例里顺带修复旧命名与陈旧映射，
    // try_lock 失败说明正有批次在跑，这次就只列不改。
    if !state.read_only {
        if let Ok(_guard) = state.trash_lock.try_lock() {
            if reconcile_trash_manifest(&trash_dir, &mut manifest).await {
                if let Err(e) = write_trash_manifest(&trash_dir, &manifest).await {
                    tracing::warn!("Failed to persist reconciled trash manifest: {}", e);
                }
            }
            if let Err(e) = migrate_legacy_trash_names(&trash_dir, &mut manifest).await {
                tracing::warn!("Failed to migrate legacy trash names: {}", e);
            }
        }
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
    HttpResponse::Ok().json(items)
}

/// 从暂存队列中移除一个操作
pub async fn remove_staged(op_id: web::Path<String>, state: web::Data<AppState>) -> HttpResponse {
    if state.read_only {
        return HttpResponse::Forbidden().finish();
    }

    let mut ops = state.staged_ops.write().await;
    ops.retain(|op| op.id != *op_id);
    HttpResponse::NoContent().finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, read_dir, read_to_string, remove_dir_all, write as write_file};

    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new() -> Self {
            let name = format!("photo-viewer-test-{}", Uuid::new_v4().simple());
            let path = std::env::temp_dir().join(name);
            create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = remove_dir_all(&self.0);
        }
    }

    fn op(kind: OpKind, src: &str, dst: Option<&str>) -> StagedOp {
        StagedOp {
            id: Uuid::new_v4().to_string(),
            kind,
            src: src.to_string(),
            dst: dst.map(|d| d.to_string()),
            replace: false,
            exif: None,
        }
    }

    fn contents(path: &FsPath) -> String {
        read_to_string(path).unwrap()
    }

    fn leftovers(dir: &FsPath) -> Vec<String> {
        let mut names: Vec<String> = read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    #[tokio::test]
    async fn move_noclobber_keeps_existing_destination_untouched() {
        let tmp = TempDir::new();
        let src = tmp.0.join("src.jpg");
        let dst = tmp.0.join("dst.jpg");
        write_file(&src, "new").unwrap();
        write_file(&dst, "precious").unwrap();

        // 模拟预检通过之后目标才出现：执行时的 EEXIST 才是最终权威
        let error = move_noclobber(&src, &dst).await.unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(contents(&dst), "precious");
        assert_eq!(contents(&src), "new");
        assert_eq!(leftovers(&tmp.0), ["dst.jpg", "src.jpg"]);
    }

    #[tokio::test]
    async fn move_noclobber_moves_when_destination_is_free() {
        let tmp = TempDir::new();
        let src = tmp.0.join("src.jpg");
        let dst = tmp.0.join("dst.jpg");
        write_file(&src, "payload").unwrap();

        move_noclobber(&src, &dst).await.unwrap();
        assert_eq!(contents(&dst), "payload");
        assert_eq!(leftovers(&tmp.0), ["dst.jpg"]);
    }

    #[tokio::test]
    async fn copy_noclobber_refuses_and_leaves_no_temp_file() {
        let tmp = TempDir::new();
        let src = tmp.0.join("src.jpg");
        let dst = tmp.0.join("dst.jpg");
        write_file(&src, "copy").unwrap();
        write_file(&dst, "precious").unwrap();

        let error = copy_noclobber(&src, &dst).await.unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(contents(&dst), "precious");
        assert_eq!(leftovers(&tmp.0), ["dst.jpg", "src.jpg"]);
    }

    #[tokio::test]
    async fn copy_noclobber_cleans_up_when_the_source_is_missing() {
        let tmp = TempDir::new();
        let src = tmp.0.join("gone.jpg");
        let dst = tmp.0.join("dst.jpg");

        assert!(copy_noclobber(&src, &dst).await.is_err());
        assert_eq!(leftovers(&tmp.0), Vec::<String>::new());
    }

    #[tokio::test]
    async fn copy_noclobber_keeps_the_source_and_places_a_complete_file() {
        let tmp = TempDir::new();
        let src = tmp.0.join("src.jpg");
        let dst = tmp.0.join("nested.jpg");
        write_file(&src, "full").unwrap();

        copy_noclobber(&src, &dst).await.unwrap();
        assert_eq!(contents(&dst), "full");
        assert_eq!(contents(&src), "full");
        assert_eq!(leftovers(&tmp.0), ["nested.jpg", "src.jpg"]);
    }

    #[test]
    fn precheck_flags_two_ops_sharing_one_destination() {
        let tmp = TempDir::new();
        let ops = vec![
            op(OpKind::Move, "Alpha/a.jpg", Some("Beta/x.jpg")),
            op(OpKind::Move, "Gamma/b.jpg", Some("Beta/x.jpg")),
        ];
        let conflicts = precheck_conflicts(&tmp.0, &ops);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0]["reason"], "batch-same-destination");
        assert_eq!(conflicts[0]["src"], "Gamma/b.jpg");
        assert_eq!(conflicts[0]["dst"], "Beta/x.jpg");
    }

    #[test]
    fn precheck_flags_an_existing_destination() {
        let tmp = TempDir::new();
        create_dir_all(tmp.0.join("Beta")).unwrap();
        write_file(&tmp.0.join("Beta/x.jpg"), "precious").unwrap();

        let ops = vec![op(OpKind::Rename, "Beta/y.jpg", Some("Beta/x.jpg"))];
        let conflicts = precheck_conflicts(&tmp.0, &ops);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0]["reason"], "destination-exists");
    }

    #[test]
    fn precheck_allows_reusing_a_path_vacated_earlier_in_the_batch() {
        let tmp = TempDir::new();
        create_dir_all(tmp.0.join("Beta")).unwrap();
        write_file(&tmp.0.join("Beta/x.jpg"), "old").unwrap();

        let ops = vec![
            op(OpKind::Delete, "Beta/x.jpg", None),
            op(OpKind::Move, "Alpha/a.jpg", Some("Beta/x.jpg")),
        ];
        assert!(precheck_conflicts(&tmp.0, &ops).is_empty());
    }

    #[test]
    fn precheck_treats_restore_over_an_existing_file_as_a_conflict() {
        let tmp = TempDir::new();
        create_dir_all(tmp.0.join("Beta")).unwrap();
        write_file(&tmp.0.join("Beta/x.jpg"), "precious").unwrap();

        let ops = vec![op(OpKind::Restore, ".trash/abcd", Some("Beta/x.jpg"))];
        let conflicts = precheck_conflicts(&tmp.0, &ops);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0]["kind"], "restore");
    }

    #[test]
    fn precheck_allows_an_explicitly_confirmed_replacement() {
        let tmp = TempDir::new();
        create_dir_all(tmp.0.join("Beta")).unwrap();
        write_file(&tmp.0.join("Beta/x.jpg"), "old").unwrap();

        let mut confirmed = op(OpKind::Rename, "Beta/y.jpg", Some("Beta/x.jpg"));
        confirmed.replace = true;
        assert!(precheck_conflicts(&tmp.0, &[confirmed]).is_empty());
    }

    // ── 批2：回收站映射的持久化 ─────────────────────────────────────────────

    fn trash_names(dir: &FsPath) -> Vec<String> {
        leftovers(dir)
            .into_iter()
            .filter(|name| is_generated_trash_name(name))
            .collect()
    }

    #[tokio::test]
    async fn trash_manifest_write_leaves_no_temp_files_behind() {
        let tmp = TempDir::new();
        let trash = tmp.0.join(".trash");
        create_dir_all(&trash).unwrap();

        let mut manifest = TrashManifest::default();
        manifest.insert(
            "aaaa".to_string(),
            TrashManifestEntry {
                original: "Alpha/a.jpg".to_string(),
            },
        );
        write_trash_manifest(&trash, &manifest).await.unwrap();
        write_trash_manifest(&trash, &manifest).await.unwrap();

        assert_eq!(leftovers(&trash), [TRASH_MANIFEST.to_string()]);
        let on_disk = read_trash_manifest(&trash).await;
        assert_eq!(on_disk["aaaa"].original, "Alpha/a.jpg");
    }

    #[tokio::test]
    async fn delete_keeps_the_file_when_the_manifest_cannot_be_written() {
        let tmp = TempDir::new();
        let trash = tmp.0.join(".trash");
        create_dir_all(&trash).unwrap();
        // 同名目录让 manifest 的原子 rename 必然失败
        create_dir_all(trash.join(TRASH_MANIFEST)).unwrap();
        let src = tmp.0.join("a.jpg");
        write_file(&src, "AAA").unwrap();

        let mut manifest = TrashManifest::default();
        let error = move_into_trash(&trash, &src, "Alpha/a.jpg", &mut manifest)
            .await
            .unwrap_err();

        assert_ne!(error.kind(), std::io::ErrorKind::NotFound);
        assert_eq!(contents(&src), "AAA", "映射写失败时文件必须留在原地");
        assert!(manifest.is_empty(), "内存里的映射也要回滚");
        assert!(trash_names(&trash).is_empty(), "回收站里不应出现半成品");
        assert!(leftovers(&trash).iter().all(|n| !n.ends_with(".tmp")));
    }

    #[tokio::test]
    async fn delete_records_the_mapping_on_disk_before_moving() {
        let tmp = TempDir::new();
        let trash = tmp.0.join(".trash");
        create_dir_all(&trash).unwrap();
        let src = tmp.0.join("a.jpg");
        write_file(&src, "AAA").unwrap();

        let mut manifest = TrashManifest::default();
        move_into_trash(&trash, &src, "Alpha/a.jpg", &mut manifest)
            .await
            .unwrap();

        assert!(!src.exists());
        let names = trash_names(&trash);
        assert_eq!(names.len(), 1);
        // 调用方还没补写，磁盘上就已经有映射了
        let on_disk = read_trash_manifest(&trash).await;
        assert_eq!(on_disk[&names[0]].original, "Alpha/a.jpg");
        assert_eq!(contents(&trash.join(&names[0])), "AAA");
    }

    #[tokio::test]
    async fn reconcile_drops_mappings_whose_trash_file_is_gone() {
        let tmp = TempDir::new();
        let trash = tmp.0.join(".trash");
        create_dir_all(&trash).unwrap();
        write_file(trash.join("aaaa"), "x").unwrap();

        let mut manifest = TrashManifest::default();
        manifest.insert(
            "aaaa".to_string(),
            TrashManifestEntry {
                original: "Keep/a.jpg".to_string(),
            },
        );
        manifest.insert(
            "bbbb".to_string(),
            TrashManifestEntry {
                original: "Gone/b.jpg".to_string(),
            },
        );

        assert!(reconcile_trash_manifest(&trash, &mut manifest).await);
        assert_eq!(manifest.len(), 1);
        assert!(manifest.contains_key("aaaa"));
        assert!(!reconcile_trash_manifest(&trash, &mut manifest).await);
    }

    #[tokio::test]
    async fn legacy_trash_names_are_renamed_with_the_mapping_on_disk() {
        let tmp = TempDir::new();
        let trash = tmp.0.join(".trash");
        create_dir_all(&trash).unwrap();
        write_file(
            trash.join("Alpha_Old.jpg-00000000-0000-0000-0000-000000000000"),
            "P",
        )
        .unwrap();

        let mut manifest = TrashManifest::default();
        assert!(migrate_legacy_trash_names(&trash, &mut manifest)
            .await
            .unwrap());

        let names = trash_names(&trash);
        assert_eq!(names.len(), 1);
        let on_disk = read_trash_manifest(&trash).await;
        assert_eq!(on_disk[&names[0]].original, "Alpha/Old.jpg");
    }
}
