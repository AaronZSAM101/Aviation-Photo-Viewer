use axum::{
    extract::{Path, Query},
    http::StatusCode,
    Json,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::models::{AppState, CachedHash, PhotoEntry, SimilarScanJob};
use crate::utils::{
    aspect_milli, collect_photo_entries, compute_ahash, compute_color_sig, compute_dhash,
    safe_subpath,
};

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
    let img = image::load_from_memory(&data).map_err(|_| StatusCode::UNPROCESSABLE_ENTITY)?;
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
    let hash_a = image_hash_from_image(&img_a);
    let hash_b = image_hash_from_image(&img_b);
    let same_file = sha_a == sha_b;
    let assessment = assess_similarity(hash_a, hash_b, same_file);
    Ok((
        StatusCode::OK,
        Json(json!({
            "sha_a": sha_a,
            "sha_b": sha_b,
            "same_file": same_file,
            "verdict": assessment.verdict,
            "verdict_label": assessment.label,
            "tone": assessment.tone,
            "score": assessment.score,
            "reasons": assessment.reasons,
            "phash_dist": assessment.ahash_dist,
            "ahash_dist": assessment.ahash_dist,
            "dhash_dist": assessment.dhash_dist,
            "color_dist": assessment.color_dist,
            "aspect_dist": assessment.aspect_dist,
            "same_phash": assessment.ahash_dist == 0 && assessment.dhash_dist == 0,
        })),
    ))
}

#[derive(serde::Deserialize)]
pub struct SimilarQuery {
    pub threshold: Option<u32>,
    pub limit: Option<usize>,
    pub max_photos: Option<usize>,
}

#[derive(Clone)]
struct HashEntry {
    subpath: String,
    hash: ImageHash,
}

#[derive(Clone, Copy)]
struct ImageHash {
    phash: u64,
    dhash: u64,
    color_sig: [u8; 12],
    aspect_milli: u32,
}

struct ScanOutput {
    value: serde_json::Value,
    cache: HashMap<String, CachedHash>,
}

struct SimilarAssessment {
    verdict: &'static str,
    label: &'static str,
    tone: &'static str,
    score: u32,
    reasons: Vec<&'static str>,
    ahash_dist: u32,
    dhash_dist: u32,
    color_dist: u32,
    aspect_dist: u32,
}

type ThumbSnapshot = HashMap<String, (u64, u64, Vec<u8>)>;

struct ComputedHash {
    subpath: String,
    mtime: u64,
    size: u64,
    hash: ImageHash,
}

fn scan_workers() -> usize {
    std::env::var("SIMILAR_SCAN_WORKERS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(4)
        .clamp(1, 8)
}

fn image_hash_from_image(img: &image::DynamicImage) -> ImageHash {
    ImageHash {
        phash: compute_ahash(img),
        dhash: compute_dhash(img),
        color_sig: compute_color_sig(img),
        aspect_milli: aspect_milli(img),
    }
}

fn cached_image_hash(cached: &CachedHash) -> Option<ImageHash> {
    if cached.dhash == 0 || cached.aspect_milli == 0 || cached.color_sig.iter().all(|v| *v == 0) {
        return None;
    }
    Some(ImageHash {
        phash: cached.phash,
        dhash: cached.dhash,
        color_sig: cached.color_sig,
        aspect_milli: cached.aspect_milli,
    })
}

fn color_distance(a: &[u8; 12], b: &[u8; 12]) -> u32 {
    a.iter()
        .zip(b.iter())
        .map(|(x, y)| (*x as i32 - *y as i32).unsigned_abs())
        .sum()
}

fn hash_distance(a: ImageHash, b: ImageHash) -> (u32, u32, u32, u32) {
    let ahash_dist = (a.phash ^ b.phash).count_ones();
    let dhash_dist = (a.dhash ^ b.dhash).count_ones();
    let color_dist = color_distance(&a.color_sig, &b.color_sig);
    let aspect_dist = a.aspect_milli.abs_diff(b.aspect_milli);
    (ahash_dist, dhash_dist, color_dist, aspect_dist)
}

fn assess_similarity(a: ImageHash, b: ImageHash, same_file: bool) -> SimilarAssessment {
    let (ahash_dist, dhash_dist, color_dist, aspect_dist) = hash_distance(a, b);

    let mut reasons = Vec::new();
    if same_file {
        reasons.push("文件内容完全相同");
    }
    if dhash_dist <= 4 {
        reasons.push("轮廓和边缘几乎一致");
    } else if dhash_dist <= 8 {
        reasons.push("轮廓和边缘接近");
    }
    if ahash_dist <= 6 {
        reasons.push("整体明暗结构接近");
    }
    if color_dist <= 120 {
        reasons.push("颜色分布接近");
    } else if color_dist >= 260 {
        reasons.push("颜色差异明显");
    }
    if aspect_dist <= 80 {
        reasons.push("画幅比例接近");
    } else if aspect_dist >= 180 {
        reasons.push("画幅比例差异较大");
    }

    let score = if same_file {
        100
    } else {
        let shape_score = 100u32.saturating_sub(dhash_dist.saturating_mul(7).min(100));
        let light_score = 100u32.saturating_sub(ahash_dist.saturating_mul(5).min(100));
        let color_score = 100u32.saturating_sub((color_dist / 3).min(100));
        let aspect_score = 100u32.saturating_sub((aspect_dist / 2).min(100));
        (shape_score * 40 + light_score * 25 + color_score * 25 + aspect_score * 10) / 100
    };

    let (verdict, label, tone) = if same_file {
        ("exact", "文件内容完全相同", "same")
    } else if dhash_dist <= 4 && ahash_dist <= 8 && color_dist <= 120 && aspect_dist <= 80 {
        ("near_duplicate", "疑似同一张照片的不同版本", "high")
    } else if dhash_dist <= 7 && ahash_dist <= 12 && color_dist <= 190 && aspect_dist <= 130 {
        ("likely_related", "可能是同一场景或连拍", "medium")
    } else if dhash_dist <= 11 && ahash_dist <= 18 && aspect_dist <= 220 {
        ("composition", "构图相似，但需要人工确认", "low")
    } else {
        ("different", "差异较大", "low")
    };

    SimilarAssessment {
        verdict,
        label,
        tone,
        score,
        reasons,
        ahash_dist,
        dhash_dist,
        color_dist,
        aspect_dist,
    }
}

fn similar_limits(threshold: u32) -> (u32, u32, u32, u32) {
    let dhash_limit = match threshold {
        0..=3 => 4,
        4..=5 => 7,
        _ => 11,
    };
    let ahash_limit = match threshold {
        0..=3 => 8,
        4..=5 => 12,
        _ => 18,
    };
    let color_limit = match threshold {
        0..=3 => 120,
        4..=5 => 190,
        _ => 300,
    };
    let aspect_limit = match threshold {
        0..=3 => 80,
        4..=5 => 130,
        _ => 220,
    };
    (ahash_limit, dhash_limit, color_limit, aspect_limit)
}

fn is_similar_hash(a: ImageHash, b: ImageHash, threshold: u32) -> Option<SimilarAssessment> {
    let assessment = assess_similarity(a, b, false);
    let (ahash_limit, dhash_limit, color_limit, aspect_limit) = similar_limits(threshold);

    if assessment.dhash_dist <= dhash_limit
        && assessment.ahash_dist <= ahash_limit
        && assessment.color_dist <= color_limit
        && assessment.aspect_dist <= aspect_limit
    {
        Some(assessment)
    } else {
        None
    }
}

fn assessment_json(assessment: &SimilarAssessment) -> serde_json::Value {
    json!({
        "verdict": assessment.verdict,
        "verdict_label": assessment.label,
        "tone": assessment.tone,
        "score": assessment.score,
        "reasons": assessment.reasons,
        "phash_dist": assessment.ahash_dist,
        "ahash_dist": assessment.ahash_dist,
        "dhash_dist": assessment.dhash_dist,
        "color_dist": assessment.color_dist,
        "aspect_dist": assessment.aspect_dist,
        "same_phash": assessment.ahash_dist == 0 && assessment.dhash_dist == 0,
    })
}

fn update_job<F>(job: &Arc<Mutex<SimilarScanJob>>, f: F)
where
    F: FnOnce(&mut SimilarScanJob),
{
    if let Ok(mut guard) = job.lock() {
        f(&mut guard);
    }
}

async fn persist_hash_cache(cache_path: PathBuf, cache: HashMap<String, CachedHash>) {
    match serde_json::to_vec_pretty(&cache) {
        Ok(buf) => {
            let tmp_path = cache_path.with_file_name(format!(
                ".{}.tmp",
                cache_path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("photo_viewer_hash_cache.json")
            ));
            if let Err(e) = tokio::fs::write(&tmp_path, buf).await {
                tracing::warn!("Failed to write hash cache: {}", e);
                return;
            }
            if let Err(e) = tokio::fs::rename(&tmp_path, &cache_path).await {
                tracing::warn!("Failed to persist hash cache: {}", e);
            }
        }
        Err(e) => tracing::warn!("Failed to serialize hash cache: {}", e),
    }
}

fn compute_entry_hash(entry: &PhotoEntry, thumbs: &ThumbSnapshot) -> Option<ImageHash> {
    if let Some((mtime, size, data)) = thumbs.get(&entry.subpath) {
        if *mtime == entry.mtime && *size == entry.size {
            if let Ok(img) = image::load_from_memory(data) {
                return Some(image_hash_from_image(&img));
            }
        }
    }

    image::open(&entry.path)
        .ok()
        .map(|img| image_hash_from_image(&img))
}

fn compute_missing_hashes(
    pending: Vec<PhotoEntry>,
    thumbs: ThumbSnapshot,
    job: Option<Arc<Mutex<SimilarScanJob>>>,
    processed_base: usize,
) -> (Vec<ComputedHash>, usize) {
    if pending.is_empty() {
        return (Vec::new(), 0);
    }

    let processed = AtomicUsize::new(0);
    let unreadable = AtomicUsize::new(0);
    let workers = scan_workers();
    let pool = rayon::ThreadPoolBuilder::new().num_threads(workers).build();

    let run = || {
        use rayon::prelude::*;
        pending
            .into_par_iter()
            .filter_map(|entry| {
                let hash = compute_entry_hash(&entry, &thumbs);
                let done = processed.fetch_add(1, Ordering::Relaxed) + 1;
                if done % 4 == 0 {
                    let unreadable_now = unreadable.load(Ordering::Relaxed);
                    update_job_opt(&job, |j| {
                        j.processed = processed_base + done;
                        j.unreadable = unreadable_now;
                    });
                }

                match hash {
                    Some(hash) => Some(ComputedHash {
                        subpath: entry.subpath,
                        mtime: entry.mtime,
                        size: entry.size,
                        hash,
                    }),
                    None => {
                        unreadable.fetch_add(1, Ordering::Relaxed);
                        None
                    }
                }
            })
            .collect::<Vec<_>>()
    };

    let computed = match pool {
        Ok(pool) => pool.install(run),
        Err(_) => run(),
    };
    let processed_total = processed.load(Ordering::Relaxed);
    let unreadable_total = unreadable.load(Ordering::Relaxed);
    update_job_opt(&job, |j| {
        j.processed = processed_base + processed_total;
        j.unreadable = unreadable_total;
    });
    (computed, unreadable_total)
}

fn warm_phash_cache_entries(
    entries: Vec<PhotoEntry>,
    mut cache: HashMap<String, CachedHash>,
    thumbs: ThumbSnapshot,
) -> (HashMap<String, CachedHash>, usize, usize) {
    let mut reused = 0usize;
    let mut seen = HashSet::new();
    let mut pending = Vec::new();

    for entry in entries {
        seen.insert(entry.subpath.clone());
        if let Some(cached_hash) = cache.get(&entry.subpath) {
            if cached_hash.mtime == entry.mtime
                && cached_hash.size == entry.size
                && cached_image_hash(cached_hash).is_some()
            {
                reused += 1;
                continue;
            }
        }
        pending.push(entry);
    }

    let (computed_hashes, _unreadable) = compute_missing_hashes(pending, thumbs, None, reused);
    let computed = computed_hashes.len();
    for item in computed_hashes {
        cache.insert(
            item.subpath,
            CachedHash {
                mtime: item.mtime,
                size: item.size,
                phash: item.hash.phash,
                dhash: item.hash.dhash,
                color_sig: item.hash.color_sig,
                aspect_milli: item.hash.aspect_milli,
            },
        );
    }

    cache.retain(|k, _| seen.contains(k));
    (cache, computed, reused)
}

pub fn spawn_phash_warmup(state: AppState, entries: Vec<PhotoEntry>) {
    if entries.is_empty() {
        return;
    }

    {
        let Ok(mut running) = state.phash_warmup_running.lock() else {
            return;
        };
        if *running {
            return;
        }
        *running = true;
    }

    tokio::spawn(async move {
        let photos_dir = state.photos_dir.read().await.clone();
        let cache_path = photos_dir.join(".photo_viewer_hash_cache.json");
        let cache_snapshot = state.phash_cache.read().await.clone();
        let thumb_snapshot = state.thumb_cache.read().await.clone();
        let cache_handle = state.phash_cache.clone();
        let running_handle = state.phash_warmup_running.clone();
        let total = entries.len();

        tracing::info!("Starting phash warmup for {} photos", total);
        let result = tokio::task::spawn_blocking(move || {
            warm_phash_cache_entries(entries, cache_snapshot, thumb_snapshot)
        })
        .await;

        if let Ok((new_cache, computed, reused)) = result {
            {
                let mut guard = cache_handle.write().await;
                *guard = new_cache.clone();
            }
            persist_hash_cache(cache_path, new_cache).await;
            tracing::info!(
                "Finished phash warmup: {} computed, {} cached",
                computed,
                reused
            );
        }

        if let Ok(mut running) = running_handle.lock() {
            *running = false;
        };
    });
}

/// 在当前照片目录内扫描相似照片。
pub async fn find_similar_photos(
    Query(q): Query<SimilarQuery>,
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Result<(StatusCode, Json<serde_json::Value>), (StatusCode, String)> {
    let threshold = q.threshold.unwrap_or(5).min(16);
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let max_photos = q.max_photos.unwrap_or(2000).clamp(2, 10000);
    let photos_dir = state.photos_dir.read().await.clone();
    let cache_path = photos_dir.join(".photo_viewer_hash_cache.json");
    let cache_snapshot = state.phash_cache.read().await.clone();
    let thumb_snapshot = state.thumb_cache.read().await.clone();

    let result = tokio::task::spawn_blocking(move || {
        let (entries, truncated) = collect_photo_entries(photos_dir, Some(max_photos));
        scan_similar_photos(
            entries,
            truncated,
            cache_snapshot,
            thumb_snapshot,
            None,
            false,
            threshold,
            limit,
            max_photos,
        )
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    match result {
        Ok(output) => {
            {
                let mut guard = state.phash_cache.write().await;
                *guard = output.cache.clone();
            }
            persist_hash_cache(cache_path, output.cache).await;
            Ok((StatusCode::OK, Json(output.value)))
        }
        Err(e) => Err(e),
    }
}

fn scan_similar_photos(
    entries: Vec<PhotoEntry>,
    truncated: bool,
    mut cache: HashMap<String, CachedHash>,
    thumbs: ThumbSnapshot,
    job: Option<Arc<Mutex<SimilarScanJob>>>,
    prune_cache: bool,
    threshold: u32,
    limit: usize,
    max_photos: usize,
) -> Result<ScanOutput, (StatusCode, String)> {
    let scanned = entries.len();
    update_job_opt(&job, |j| {
        j.total = scanned;
        j.scanned = scanned;
        j.truncated = truncated;
    });

    let mut hashes = Vec::new();
    let mut cached = 0usize;
    let mut seen = HashSet::new();
    let mut pending = Vec::new();

    for entry in entries {
        seen.insert(entry.subpath.clone());

        if let Some(cached_hash) = cache.get(&entry.subpath) {
            if cached_hash.mtime == entry.mtime && cached_hash.size == entry.size {
                let Some(hash) = cached_image_hash(cached_hash) else {
                    pending.push(entry);
                    continue;
                };
                cached += 1;
                hashes.push(HashEntry {
                    subpath: entry.subpath,
                    hash,
                });
                update_job_opt(&job, |j| {
                    j.processed = hashes.len();
                    j.hashed = hashes.len();
                    j.cached = cached;
                });
                continue;
            }
        }

        pending.push(entry);
    }

    let (computed_hashes, unreadable) =
        compute_missing_hashes(pending, thumbs, job.clone(), cached);
    for item in computed_hashes {
        cache.insert(
            item.subpath.clone(),
            CachedHash {
                mtime: item.mtime,
                size: item.size,
                phash: item.hash.phash,
                dhash: item.hash.dhash,
                color_sig: item.hash.color_sig,
                aspect_milli: item.hash.aspect_milli,
            },
        );
        hashes.push(HashEntry {
            subpath: item.subpath,
            hash: item.hash,
        });
    }
    update_job_opt(&job, |j| {
        j.processed = scanned;
        j.hashed = hashes.len();
        j.cached = cached;
        j.unreadable = unreadable;
    });

    if prune_cache {
        cache.retain(|k, _| seen.contains(k));
    }

    let mut pairs = Vec::new();
    'outer: for i in 0..hashes.len() {
        for j in (i + 1)..hashes.len() {
            if let Some(assessment) = is_similar_hash(hashes[i].hash, hashes[j].hash, threshold) {
                let mut pair = json!({
                    "a": hashes[i].subpath,
                    "b": hashes[j].subpath,
                });
                if let (Some(pair_obj), Some(assessment_obj)) = (
                    pair.as_object_mut(),
                    assessment_json(&assessment).as_object(),
                ) {
                    for (key, value) in assessment_obj {
                        pair_obj.insert(key.clone(), value.clone());
                    }
                }
                pairs.push(pair);
                update_job_opt(&job, |j| j.pairs = pairs.clone());
                if pairs.len() >= limit {
                    break 'outer;
                }
            }
        }
    }

    let value = json!({
        "threshold": threshold,
        "limit": limit,
        "max_photos": max_photos,
        "scanned": scanned,
        "processed": scanned,
        "hashed": hashes.len(),
        "cached": cached,
        "unreadable": unreadable,
        "truncated": truncated,
        "pairs": pairs,
    });

    Ok(ScanOutput { value, cache })
}

fn update_job_opt<F>(job: &Option<Arc<Mutex<SimilarScanJob>>>, f: F)
where
    F: FnOnce(&mut SimilarScanJob),
{
    if let Some(job) = job {
        update_job(job, f);
    }
}

pub async fn start_similar_scan_job(
    Query(q): Query<SimilarQuery>,
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Result<(StatusCode, Json<serde_json::Value>), (StatusCode, String)> {
    let threshold = q.threshold.unwrap_or(5).min(16);
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let max_photos = q.max_photos.unwrap_or(2000).clamp(2, 10000);
    let id = Uuid::new_v4().to_string();
    let job = Arc::new(Mutex::new(SimilarScanJob {
        id: id.clone(),
        status: "queued".to_string(),
        threshold,
        limit,
        max_photos,
        scanned: 0,
        processed: 0,
        hashed: 0,
        cached: 0,
        unreadable: 0,
        total: 0,
        truncated: false,
        pairs: Vec::new(),
        error: None,
    }));

    {
        let mut jobs = state.similar_jobs.write().await;
        jobs.insert(id.clone(), job.clone());
        if jobs.len() > 10 {
            let remove_ids: Vec<String> = jobs.keys().take(jobs.len() - 10).cloned().collect();
            for remove_id in remove_ids {
                if remove_id != id {
                    jobs.remove(&remove_id);
                }
            }
        }
    }

    let photos_dir = state.photos_dir.read().await.clone();
    let cache_path = photos_dir.join(".photo_viewer_hash_cache.json");
    let cache_snapshot = state.phash_cache.read().await.clone();
    let thumb_snapshot = state.thumb_cache.read().await.clone();
    let cache_handle: Arc<RwLock<HashMap<String, CachedHash>>> = state.phash_cache.clone();

    tokio::spawn(async move {
        update_job(&job, |j| j.status = "running".to_string());
        let job_for_scan = job.clone();
        let scan_result = tokio::task::spawn_blocking(move || {
            let (entries, truncated) = collect_photo_entries(photos_dir, Some(max_photos));
            scan_similar_photos(
                entries,
                truncated,
                cache_snapshot,
                thumb_snapshot,
                Some(job_for_scan),
                false,
                threshold,
                limit,
                max_photos,
            )
        })
        .await;

        match scan_result {
            Ok(Ok(output)) => {
                {
                    let mut guard = cache_handle.write().await;
                    *guard = output.cache.clone();
                }
                persist_hash_cache(cache_path, output.cache).await;
                update_job(&job, |j| {
                    j.status = "done".to_string();
                    j.pairs = output
                        .value
                        .get("pairs")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();
                });
            }
            Ok(Err((_, msg))) => {
                update_job(&job, |j| {
                    j.status = "error".to_string();
                    j.error = Some(msg);
                });
            }
            Err(e) => {
                update_job(&job, |j| {
                    j.status = "error".to_string();
                    j.error = Some(e.to_string());
                });
            }
        }
    });

    Ok((StatusCode::ACCEPTED, Json(json!({ "id": id }))))
}

pub async fn get_similar_scan_job(
    Path(id): Path<String>,
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Result<(StatusCode, Json<serde_json::Value>), StatusCode> {
    let job = {
        let jobs = state.similar_jobs.read().await;
        jobs.get(&id).cloned()
    }
    .ok_or(StatusCode::NOT_FOUND)?;

    let snapshot = job
        .lock()
        .map(|j| j.clone())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok((StatusCode::OK, Json(json!(snapshot))))
}
