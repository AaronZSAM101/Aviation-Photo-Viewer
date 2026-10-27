use actix_web::{middleware::Compress, web, App, HttpServer};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tokio::sync::RwLock;

use photo_viewer::{
    cache_paths, exif_edit, file_ops, handlers, hash, livery, models::AppState, registration, spots,
};

fn env_flag(name: &str) -> bool {
    matches!(
        std::env::var(name)
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "1" | "true" | "yes" | "on"
    )
}

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

    if let Some(parent) = cache_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("create cache dir failed: {e}"))?;
    }
    tokio::fs::write(&tmp_path, &buf)
        .await
        .map_err(|e| format!("write temp cache failed: {e}"))?;
    tokio::fs::rename(&tmp_path, cache_path)
        .await
        .map_err(|e| format!("atomic rename cache failed: {e}"))?;
    Ok(())
}

/// 等待进程退出信号：Unix 下同时监听 CTRL+C 和 SIGTERM（Docker/K8s 兼容），
/// 其他平台仅监听 CTRL+C。
async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut sigterm) => {
                tokio::select! {
                    res = tokio::signal::ctrl_c() => {
                        if let Err(e) = res {
                            tracing::warn!("Failed to listen for ctrl-c: {}", e);
                        }
                    },
                    _ = sigterm.recv() => {
                        tracing::info!("Received SIGTERM");
                    },
                }
            }
            Err(e) => {
                tracing::warn!(
                    "Failed to register SIGTERM handler: {}; falling back to ctrl-c only",
                    e
                );
                tokio::signal::ctrl_c().await.ok();
            }
        }
        return;
    }
    #[cfg(not(unix))]
    {
        if let Err(e) = tokio::signal::ctrl_c().await {
            tracing::warn!("Failed to listen for shutdown signal: {}", e);
        }
    }
}

async fn flush_caches_on_shutdown(
    photos_dir: Arc<RwLock<PathBuf>>,
    meta_cache: Arc<RwLock<HashMap<String, photo_viewer::models::CachedMeta>>>,
    exif_overrides: Arc<RwLock<HashMap<String, photo_viewer::models::ExifData>>>,
) {
    wait_for_shutdown_signal().await;

    // 退出时按当前照片目录推导路径：运行中换过库也不会把缓存写回旧目录
    let current = photos_dir.read().await.clone();
    let cache_path = cache_paths::meta_cache(&current);
    let exif_overrides_path = cache_paths::exif_overrides(&current);

    tracing::info!("Shutdown signal received, flushing meta cache...");
    let snapshot = {
        let guard = meta_cache.read().await;
        guard.clone()
    };

    if let Err(e) = persist_meta_cache_atomic(&cache_path, &snapshot).await {
        tracing::warn!("Failed to flush meta cache on shutdown: {}", e);
    }

    let exif_snapshot = {
        let guard = exif_overrides.read().await;
        guard.clone()
    };
    if let Err(e) =
        exif_edit::persist_exif_overrides_atomic(&exif_overrides_path, &exif_snapshot).await
    {
        tracing::warn!("Failed to flush exif overrides on shutdown: {}", e);
    }
}

fn load_tls_config(cert_path: &str, key_path: &str) -> Result<rustls::ServerConfig, String> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| "failed to install rustls crypto provider".to_string())?;

    let cert_data =
        std::fs::read(cert_path).map_err(|e| format!("failed to read certificate: {e}"))?;
    let key_data = std::fs::read(key_path).map_err(|e| format!("failed to read key: {e}"))?;

    let certs = rustls_pemfile::certs(&mut cert_data.as_slice())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("failed to parse certificates: {e}"))?;
    let key = rustls_pemfile::private_key(&mut key_data.as_slice())
        .map_err(|e| format!("failed to parse private key: {e}"))?
        .ok_or_else(|| "no private key found in key file".to_string())?;

    rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| format!("invalid TLS certificate/key pair: {e}"))
}

fn photos_dir_from_env() -> PathBuf {
    if let Ok(p) = std::env::var("PHOTOS_DIR") {
        PathBuf::from(p)
    } else if let Some(p) = option_env!("DEFAULT_PHOTOS_DIR") {
        PathBuf::from(p)
    } else {
        PathBuf::from("/photos")
    }
}

#[actix_web::main]
async fn main() {
    // ops/backup-state.sh 用它算出缓存目录，避免脚本自己复刻一遍命名规则
    if std::env::args().nth(1).as_deref() == Some("--print-state-dir") {
        println!("{}", cache_paths::state_dir(&photos_dir_from_env()).display());
        return;
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "photo_viewer=info".into()),
        )
        .init();

    let photos_dir = photos_dir_from_env();
    let port = std::env::var("PORT").unwrap_or_else(|_| "3000".to_string());
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let addr = format!("{}:{}", host, port);
    let tls_config_paths = match (
        std::env::var("HTTPS_CERT_PATH").ok(),
        std::env::var("HTTPS_KEY_PATH").ok(),
    ) {
        (Some(cert_path), Some(key_path)) => Some((cert_path, key_path)),
        (None, None) => None,
        _ => panic!("HTTPS_CERT_PATH and HTTPS_KEY_PATH must be set together"),
    };
    let use_https = tls_config_paths.is_some();
    let read_only = env_flag("READ_ONLY");

    let frontend_dir = handlers::resolve_frontend_dir();

    if !photos_dir.exists() {
        eprintln!(
            "⚠  Photos directory does not exist: {}",
            photos_dir.display()
        );
        eprintln!("   Mount your photo folder with -v /your/photos:/photos");
    }
    if !frontend_dir.join("index.html").exists() {
        tracing::warn!(
            "Frontend build not found in {} (set FRONTEND_DIR or build frontend/)",
            frontend_dir.display()
        );
    }

    tracing::info!("📷  Photo Viewer {}", env!("PHOTO_VIEWER_VERSION"));
    tracing::info!("    Photos → {}", photos_dir.display());
    tracing::info!("    Frontend → {}", frontend_dir.display());
    tracing::info!(
        "    Listening on {}://{}",
        if use_https { "https" } else { "http" },
        addr
    );
    tracing::info!("    Read-only mode → {}", read_only);

    let state_dir = cache_paths::state_dir(&photos_dir);
    match std::fs::create_dir_all(&state_dir) {
        Ok(_) => tracing::info!("    State/缓存 → {}", state_dir.display()),
        Err(e) => tracing::warn!(
            "    State/缓存 → {} 建不出来：{}（分批与元数据缓存会在写盘时报错）",
            state_dir.display(),
            e
        ),
    }

    let state = AppState {
        photos_dir: Arc::new(RwLock::new(photos_dir.clone())),
        read_only,
        thumb_cache: Arc::new(RwLock::new(HashMap::new())),
        preview_cache: Arc::new(RwLock::new(HashMap::new())),
        staged_ops: Arc::new(RwLock::new(Vec::new())),
        meta_cache: Arc::new(RwLock::new(HashMap::new())),
        meta_extract_inflight: Arc::new(RwLock::new(HashMap::new())),
        phash_cache: Arc::new(RwLock::new(HashMap::new())),
        similar_jobs: Arc::new(RwLock::new(HashMap::new())),
        phash_warmup_running: Arc::new(std::sync::Mutex::new(false)),
        exif_overrides: Arc::new(RwLock::new(HashMap::new())),
        reg_detect: Arc::new(RwLock::new(HashMap::new())),
        spots: Arc::new(RwLock::new(HashMap::new())),
        livery_watch: Arc::new(RwLock::new(HashMap::new())),
        livery_feed: Arc::new(RwLock::new(HashMap::new())),
        trash_lock: Arc::new(tokio::sync::Mutex::new(())),
        dir_generation: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        last_scan: Arc::new(RwLock::new(photo_viewer::models::ScanStatus::default())),
    };

    // 尝试从磁盘加载持久化的 meta_cache（位于照片根目录下 .photo_viewer/meta.json）
    let cache_file = {
        let pd = state.photos_dir.read().await.clone();
        cache_paths::meta_cache(&pd)
    };
    let cache_load_file = {
        let pd = state.photos_dir.read().await.clone();
        cache_paths::preferred_existing(cache_file.clone(), cache_paths::legacy_meta_cache(&pd))
    };
    if cache_load_file.exists() {
        match tokio::fs::read_to_string(&cache_load_file).await {
            Ok(s) => {
                match serde_json::from_str::<HashMap<String, photo_viewer::models::CachedMeta>>(&s)
                {
                    Ok(map) => {
                        let mut cache_guard = state.meta_cache.write().await;
                        for (k, v) in map {
                            cache_guard.insert(k, v);
                        }
                        tracing::info!(
                            "Loaded meta_cache from {} ({} entries)",
                            cache_load_file.display(),
                            cache_guard.len()
                        );
                    }
                    Err(e) => tracing::warn!("Failed to parse meta cache: {}", e),
                }
            }
            Err(e) => tracing::warn!("Failed to read meta cache file: {}", e),
        }
    }

    // 感知哈希缓存（用于相似照片扫描，避免每次重算全量原图）
    let hash_cache_file = {
        let pd = state.photos_dir.read().await.clone();
        cache_paths::preferred_existing(
            cache_paths::hash_cache(&pd),
            cache_paths::legacy_hash_cache(&pd),
        )
    };
    if hash_cache_file.exists() {
        match tokio::fs::read_to_string(&hash_cache_file).await {
            Ok(s) => {
                match serde_json::from_str::<HashMap<String, photo_viewer::models::CachedHash>>(&s)
                {
                    Ok(map) => {
                        let mut guard = state.phash_cache.write().await;
                        *guard = map;
                        tracing::info!(
                            "Loaded hash cache from {} ({} entries)",
                            hash_cache_file.display(),
                            guard.len()
                        );
                    }
                    Err(e) => tracing::warn!("Failed to parse hash cache: {}", e),
                }
            }
            Err(e) => tracing::warn!("Failed to read hash cache file: {}", e),
        }
    }

    // 人工编辑后的 EXIF 覆盖值（位于照片根目录下 .photo_viewer/exif_overrides.json）
    let exif_override_file = {
        let pd = state.photos_dir.read().await.clone();
        cache_paths::exif_overrides(&pd)
    };
    let exif_override_load_file = {
        let pd = state.photos_dir.read().await.clone();
        cache_paths::preferred_existing(
            exif_override_file.clone(),
            cache_paths::legacy_exif_overrides(&pd),
        )
    };
    {
        let overrides = exif_edit::load_exif_overrides(&exif_override_load_file).await;
        if !overrides.is_empty() {
            let mut guard = state.exif_overrides.write().await;
            *guard = overrides;
            tracing::info!(
                "Loaded exif overrides from {} ({} entries)",
                exif_override_load_file.display(),
                guard.len()
            );
        }
    }

    // 机身文字识别出的机号（.photo_viewer/reg_detect.json）：只用来补文件名读不出的空缺
    let reg_detect_file = {
        let pd = state.photos_dir.read().await.clone();
        cache_paths::reg_detect(&pd)
    };
    {
        let detected = registration::load_detect(&reg_detect_file).await;
        if !detected.is_empty() {
            let mut guard = state.reg_detect.write().await;
            *guard = detected;
            tracing::info!(
                "Loaded reg detections from {} ({} entries)",
                reg_detect_file.display(),
                guard.len()
            );
        }
    }

    // 手写拍摄点档案（.photo_viewer/spots.json）：老照片没坐标，只能人自己补
    let spots_file = {
        let pd = state.photos_dir.read().await.clone();
        cache_paths::spots(&pd)
    };
    {
        let archive = spots::load_spots(&spots_file).await;
        if !archive.is_empty() {
            let mut guard = state.spots.write().await;
            *guard = archive;
            tracing::info!(
                "Loaded spot archive from {} ({} entries)",
                spots_file.display(),
                guard.len()
            );
        }
    }

    // 彩绘关注清单（.photo_viewer/watchlist.json）：数据源没标注的机号靠它认
    let watchlist_file = {
        let pd = state.photos_dir.read().await.clone();
        cache_paths::watchlist(&pd)
    };
    {
        let watched = livery::load_watchlist(&watchlist_file).await;
        if !watched.is_empty() {
            let mut guard = state.livery_watch.write().await;
            *guard = watched;
            tracing::info!(
                "Loaded livery watchlist from {} ({} entries)",
                watchlist_file.display(),
                guard.len()
            );
        }
    }

    // 后台周期性保存 meta_cache 到磁盘，避免丢失（每 60 秒，且原子写入）。
    // 清理失效条目用的 FS 扫描每 5 分钟才做一次：列表请求本身也在扫盘，
    // 两次扫描同时在网络盘上跑会把手机端首屏拖到几十秒（实测 3s → 30s）。
    // 扫描不完整（有错误/被截断）时不动缓存，避免把读不到的目录判成“文件已删除”。
    // 只读模式下不写盘：缓存只留在内存里，进程退出即丢弃。
    if !read_only {
        let meta_cache = state.meta_cache.clone();
        let photos_dir_for_flush = state.photos_dir.clone();
        tokio::spawn(async move {
            // 记录 (缓存文件, 内容)：切换照片目录后即使内容相同也要写到新库的缓存文件
            let mut last_saved: Option<(PathBuf, Vec<u8>)> = None;
            let mut last_prune_scan: Option<std::time::Instant> = None;
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;

                // 1. 重新扫描 FS，获取当前实际存在的文件集合
                let need_prune = last_prune_scan
                    .is_none_or(|at| at.elapsed() >= std::time::Duration::from_secs(300));
                if need_prune {
                    let current_photos_dir = photos_dir_for_flush.read().await.clone();
                    let outcome = tokio::task::spawn_blocking(move || {
                        photo_viewer::utils::collect_photo_entries(current_photos_dir, None)
                    })
                    .await
                    .unwrap_or_default();
                    if !outcome.errors.is_empty() {
                        tracing::warn!(
                            "periodic cache flush: scan skipped {} paths, entries kept",
                            outcome.errors.len()
                        );
                    }

                    // 2. 清除已不存在文件的缓存条目
                    if outcome.errors.is_empty() && !outcome.truncated {
                        let live: std::collections::HashSet<String> =
                            outcome.entries.into_iter().map(|e| e.subpath).collect();
                        let mut cache = meta_cache.write().await;
                        let before = cache.len();
                        cache.retain(|k, _| live.contains(k));
                        if cache.len() != before {
                            tracing::info!(
                                "periodic cache flush: dropped {} stale entries",
                                before - cache.len()
                            );
                        }
                    }
                    last_prune_scan = Some(std::time::Instant::now());
                }

                // 3. 拍快照并判断是否需要写盘。路径每次重新推导，
                //    运行时切换照片目录后不会再写回旧目录。
                let cache_path = cache_paths::meta_cache(
                    &photos_dir_for_flush.read().await.clone(),
                );
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

                if last_saved
                    .as_ref()
                    .is_some_and(|(path, bytes)| path == &cache_path && bytes == &current)
                {
                    continue;
                }

                match persist_meta_cache_atomic(&cache_path, &snapshot).await {
                    Ok(()) => {
                        last_saved = Some((cache_path, current));
                    }
                    Err(e) => {
                        tracing::warn!("Failed to persist meta cache: {}", e);
                    }
                }
            }
        });
    }

    let state_data = web::Data::new(state.clone());
    let frontend_data = web::Data::new(handlers::FrontendConfig {
        dir: frontend_dir.clone(),
    });

    let app_factory = {
        let state_data = state_data.clone();
        let frontend_data = frontend_data.clone();
        move || {
            App::new()
                // 局域网/手机端的瓶颈是带宽：JSON 列表和 JS bundle 压缩后小一个数量级。
                // 中间件按 content-type 自动跳过 image/*（JPEG/PNG 已自带压缩）。
                .wrap(Compress::default())
                .app_data(state_data.clone())
                .app_data(frontend_data.clone())
                .service(web::resource("/").route(web::get().to(handlers::serve_frontend)))
                .service(web::resource("/view").route(web::get().to(handlers::serve_frontend)))
                .service(
                    web::resource("/view/{path:.*}").route(web::get().to(handlers::serve_frontend)),
                )
                .service(
                    web::resource("/assets/{path:.*}").route(web::get().to(handlers::serve_asset)),
                )
                .service(web::resource("/api/config").route(web::get().to(handlers::app_config)))
                .service(
                    web::resource("/api/cache/refresh")
                        .route(web::post().to(handlers::refresh_caches)),
                )
                .service(web::resource("/api/photos").route(web::get().to(handlers::list_photos)))
                .service(
                    web::resource("/api/scan/status")
                        .route(web::get().to(handlers::scan_status)),
                )
                .service(web::resource("/api/folders").route(web::get().to(handlers::list_folders)))
                .service(
                    web::resource("/photos/{subpath:.*}")
                        .route(web::get().to(handlers::serve_photo)),
                )
                .service(
                    web::resource("/preview/{subpath:.*}")
                        .route(web::get().to(handlers::serve_preview)),
                )
                .service(
                    web::resource("/thumb/{subpath:.*}")
                        .route(web::get().to(handlers::serve_thumb)),
                )
                .service(web::resource("/api/stage").route(web::post().to(file_ops::stage_op)))
                .service(
                    web::resource("/api/stage/list").route(web::get().to(file_ops::list_stage)),
                )
                .service(
                    web::resource("/api/stage/clear").route(web::post().to(file_ops::clear_stage)),
                )
                .service(
                    web::resource("/api/stage/apply").route(web::post().to(file_ops::apply_stage)),
                )
                .service(
                    web::resource("/api/stage/remove/{id}")
                        .route(web::post().to(file_ops::remove_staged)),
                )
                .service(
                    web::resource("/api/trash/list").route(web::get().to(file_ops::list_trash)),
                )
                .service(
                    web::resource("/api/hash/{subpath:.*}").route(web::get().to(hash::hash_file)),
                )
                .service(web::resource("/api/compare").route(web::get().to(hash::compare_photos)))
                .service(
                    web::resource("/api/similar").route(web::get().to(hash::find_similar_photos)),
                )
                .service(
                    web::resource("/api/similar/jobs")
                        .route(web::post().to(hash::start_similar_scan_job)),
                )
                .service(
                    web::resource("/api/similar/jobs/{id}")
                        .route(web::get().to(hash::get_similar_scan_job)),
                )
                .service(
                    web::resource("/api/exif/lens/{subpath:.*}")
                        .route(web::get().to(handlers::lens_model_for_photo)),
                )
                .service(
                    web::resource("/api/exif/update").route(web::post().to(exif_edit::update_exif)),
                )
                .service(
                    web::resource("/api/reg/ocr")
                        .route(web::post().to(handlers::ocr_photo_reg)),
                )
                .service(
                    web::resource("/api/spots")
                        .route(web::get().to(spots::list_spots))
                        .route(web::post().to(spots::save_spot)),
                )
                .service(
                    web::resource("/api/spots/delete")
                        .route(web::post().to(spots::delete_spot)),
                )
                .service(
                    web::resource("/api/spot/apply")
                        .route(web::post().to(spots::apply_spot)),
                )
                .service(
                    web::resource("/api/livery/feed")
                        .route(web::get().to(livery::feed)),
                )
                .service(
                    web::resource("/api/livery/watch")
                        .route(web::get().to(livery::list_watchlist))
                        .route(web::post().to(livery::add_watch)),
                )
                .service(
                    web::resource("/api/livery/watch/delete")
                        .route(web::post().to(livery::remove_watch)),
                )
                .service(
                    web::resource("/api/admin/allow_set_dir")
                        .route(web::get().to(handlers::allow_runtime_dir_change)),
                )
                .service(
                    web::resource("/api/admin/set_photos_dir")
                        .route(web::post().to(handlers::set_photos_dir)),
                )
                .default_service(web::route().to(handlers::serve_spa))
        }
    };

    let server = HttpServer::new(app_factory)
        .disable_signals()
        .shutdown_timeout(10);
    let server = if use_https {
        let (cert_path, key_path) = tls_config_paths.expect("TLS paths checked above");
        let tls_config = load_tls_config(&cert_path, &key_path)
            .expect("Failed to load HTTPS certificate or key");
        server
            .bind_rustls_0_23(addr.as_str(), tls_config)
            .expect("Failed to bind")
    } else {
        server.bind(addr.as_str()).expect("Failed to bind")
    };
    let server = server.run();
    let handle = server.handle();

    // 优雅退出时执行最后一次落盘
    let shutdown_photos_dir = state.photos_dir.clone();
    let shutdown_meta_cache = state.meta_cache.clone();
    let shutdown_exif_overrides = state.exif_overrides.clone();
    actix_web::rt::spawn(async move {
        // 只读实例同样要响应退出信号，但不做缓存落盘
        if read_only {
            wait_for_shutdown_signal().await;
        } else {
            flush_caches_on_shutdown(
                shutdown_photos_dir,
                shutdown_meta_cache,
                shutdown_exif_overrides,
            )
            .await;
        }
        handle.stop(true).await;
    });

    if let Err(e) = server.await {
        tracing::error!("Server error: {}", e);
    }
}
