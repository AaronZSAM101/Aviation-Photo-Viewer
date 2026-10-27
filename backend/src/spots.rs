//! 拍摄点档案：把「这堆照片是在哪儿拍的」按文件夹记一次。
//!
//! 库里大量早期照片根本没写坐标（机身没 GPS，回来也没补）。这里不猜坐标、也不联网
//! 查机场数据库，只做两件人能做而机器做不了的事：
//! 1. 按文件夹存一份手写档案（`.photo_viewer/spots.json`）；
//! 2. 一键把档案里的坐标补进**单张照片的 EXIF 覆盖层**——原图不动，随时可清。

use actix_web::{web, HttpResponse};
use serde::Deserialize;
use std::{collections::HashMap, path::Path};
use tokio::fs;

use crate::{
    cache_paths,
    models::{AppState, ExifData, Spot},
};

impl Spot {
    fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("拍摄点要有名字，不然档案列表里认不出是哪条".to_string());
        }
        if !self.lat.is_finite() || self.lat.abs() > 90.0 {
            return Err("纬度得是 -90～90 之间的数字".to_string());
        }
        if !self.lon.is_finite() || self.lon.abs() > 180.0 {
            return Err("经度得是 -180～180 之间的数字".to_string());
        }
        Ok(())
    }

    /// 补进 EXIF 覆盖层的那几个字段。EXIF 里经纬度是「数值 + N/S/E/W」两段，
    /// 前端读的都是这套，所以负纬度必须落成 S，不能只给个 -33.95。
    pub fn to_exif(&self) -> ExifData {
        ExifData {
            gps_lat: Some(self.lat.abs()),
            gps_lat_ref: Some(if self.lat < 0.0 { "S" } else { "N" }.to_string()),
            gps_lon: Some(self.lon.abs()),
            gps_lon_ref: Some(if self.lon < 0.0 { "W" } else { "E" }.to_string()),
            ..Default::default()
        }
    }
}

pub async fn load_spots(path: &Path) -> HashMap<String, Spot> {
    match fs::read_to_string(path).await {
        Ok(text) => serde_json::from_str::<HashMap<String, Spot>>(&text).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

pub async fn persist_spots(path: &Path, snapshot: &HashMap<String, Spot>) -> Result<(), String> {
    let buf = serde_json::to_vec_pretty(snapshot)
        .map_err(|e| format!("序列化拍摄点档案失败：{e}"))?;
    let tmp = path.with_file_name(format!(
        ".{}.tmp",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("spots.json")
    ));
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("建拍摄点档案目录失败：{e}"))?;
    }
    fs::write(&tmp, &buf)
        .await
        .map_err(|e| format!("写拍摄点档案临时文件失败：{e}"))?;
    tokio::fs::rename(&tmp, path)
        .await
        .map_err(|e| format!("拍摄点档案换名失败：{e}"))?;
    Ok(())
}

#[derive(Deserialize)]
pub struct SpotRequest {
    /// 照片所在文件夹（'' 表示库根）；档案就是按它记的
    #[serde(default)]
    pub folder: String,
    #[serde(flatten)]
    pub spot: Spot,
}

/// 覆盖层写入用的照片定位
#[derive(Deserialize)]
pub struct ApplySpotRequest {
    pub src: String,
}

/// 删档案只需要文件夹，所以不复用 SpotRequest（那个要求带上完整的坐标）
#[derive(Deserialize)]
pub struct DeleteSpotRequest {
    pub folder: String,
}

pub async fn list_spots(state: web::Data<AppState>) -> HttpResponse {
    HttpResponse::Ok().json(state.spots.read().await.clone())
}

async fn persist_if_same_library(
    state: &web::Data<AppState>,
    photos_dir: &std::path::Path,
    generation: u64,
) {
    // 目录已切换就别把老库的档案写进新库的状态文件
    if state
        .dir_generation
        .load(std::sync::atomic::Ordering::SeqCst)
        != generation
    {
        return;
    }
    let snapshot = state.spots.read().await.clone();
    if let Err(e) = persist_spots(&cache_paths::spots(photos_dir), &snapshot).await {
        tracing::warn!("拍摄点档案落盘失败：{e}");
    }
}

pub async fn save_spot(state: web::Data<AppState>, req: web::Json<SpotRequest>) -> HttpResponse {
    if state.read_only {
        return HttpResponse::Forbidden().body("read-only mode enabled");
    }
    if let Err(e) = req.spot.validate() {
        return HttpResponse::BadRequest().body(e);
    }
    let folder = req.folder.trim_matches('/').to_string();
    let spot = Spot {
        name: req.spot.name.trim().to_string(),
        lat: req.spot.lat,
        lon: req.spot.lon,
        note: req.spot.note.trim().to_string(),
    };
    let photos_dir = state.photos_dir.read().await.clone();
    let generation = state
        .dir_generation
        .load(std::sync::atomic::Ordering::SeqCst);
    state.spots.write().await.insert(folder.clone(), spot.clone());
    persist_if_same_library(&state, &photos_dir, generation).await;
    HttpResponse::Ok().json(serde_json::json!({ "ok": true, "folder": folder, "spot": spot }))
}

pub async fn delete_spot(
    state: web::Data<AppState>,
    req: web::Json<DeleteSpotRequest>,
) -> HttpResponse {
    if state.read_only {
        return HttpResponse::Forbidden().body("read-only mode enabled");
    }
    let folder = req.folder.trim_matches('/').to_string();
    let photos_dir = state.photos_dir.read().await.clone();
    let generation = state
        .dir_generation
        .load(std::sync::atomic::Ordering::SeqCst);
    let removed = state.spots.write().await.remove(&folder).is_some();
    if removed {
        persist_if_same_library(&state, &photos_dir, generation).await;
    }
    HttpResponse::Ok().json(serde_json::json!({ "ok": true, "removed": removed }))
}

/// 把文件夹的拍摄点坐标补进这张照片的 EXIF 覆盖层。
/// 走的是和 /api/exif/update 同一份覆盖数据：原图一个字节都不改，清掉覆盖就恢复原样。
pub async fn apply_spot(state: web::Data<AppState>, req: web::Json<ApplySpotRequest>) -> HttpResponse {
    if state.read_only {
        return HttpResponse::Forbidden().body("read-only mode enabled");
    }
    let src = req.src.trim().trim_start_matches('/').to_string();
    let photos_dir = state.photos_dir.read().await.clone();
    let path = match crate::paths::resolve_user_file(&photos_dir, &src).await {
        Ok(path) => path,
        Err(error) => return crate::handlers::path_error_response(error),
    };
    if !path.exists() {
        return HttpResponse::NotFound().body("照片不存在");
    }
    // 档案按文件夹记，直接用 src 去掉文件名那截就行：src 本来就是相对库根的路径，
    // 不用 realpath，免得符号链接把文件夹算错。
    let folder = match src.rsplit_once('/') {
        Some((parent, _)) => parent.to_string(),
        None => String::new(),
    };
    let Some(spot) = state.spots.read().await.get(folder.trim_matches('/')).cloned() else {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": "no-spot",
            "message": format!("文件夹「{}」还没有拍摄点档案", folder),
        }));
    };

    let exif = spot.to_exif();
    let snapshot = {
        let mut overrides = state.exif_overrides.write().await;
        let entry = overrides.entry(src.clone()).or_insert_with(ExifData::default);
        crate::exif_edit::apply_exif_override(entry, &exif);
        overrides.clone()
    };
    let cache_path = cache_paths::exif_overrides(&photos_dir);
    if let Err(e) = crate::exif_edit::persist_exif_overrides_atomic(&cache_path, &snapshot).await {
        return HttpResponse::InternalServerError().body(e);
    }
    HttpResponse::Ok().json(serde_json::json!({
        "ok": true,
        "src": src,
        "exif": exif,
        "spot": spot,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn southern_and_western_hemispheres_get_their_refs() {
        let sydney = Spot {
            name: "02 跑道北端".into(),
            lat: -33.9461,
            lon: 151.1772,
            note: String::new(),
        }
        .to_exif();
        assert_eq!(sydney.gps_lat, Some(33.9461));
        assert_eq!(sydney.gps_lat_ref.as_deref(), Some("S"));
        assert_eq!(sydney.gps_lon, Some(151.1772));
        assert_eq!(sydney.gps_lon_ref.as_deref(), Some("E"));

        let la = Spot {
            name: "LAX".into(),
            lat: 33.94,
            lon: -118.4,
            note: String::new(),
        }
        .to_exif();
        assert_eq!(la.gps_lat_ref.as_deref(), Some("N"));
        assert_eq!(la.gps_lon_ref.as_deref(), Some("W"));
    }

    #[test]
    fn out_of_range_coordinates_are_rejected() {
        assert!(Spot { name: String::new(), lat: 0.0, lon: 0.0, note: String::new() }
            .validate()
            .is_err());
        assert!(Spot { name: "x".into(), lat: 91.0, lon: 0.0, note: String::new() }
            .validate()
            .is_err());
        assert!(Spot { name: "x".into(), lat: 0.0, lon: 181.0, note: String::new() }
            .validate()
            .is_err());
        assert!(Spot { name: "x".into(), lat: f64::NAN, lon: 0.0, note: String::new() }
            .validate()
            .is_err());
        assert!(Spot { name: "x".into(), lat: -33.9, lon: 151.2, note: String::new() }
            .validate()
            .is_ok());
    }

    #[tokio::test]
    async fn archive_round_trips_through_its_own_file() {
        let dir = std::env::temp_dir().join(format!("pv-spots-{}", std::process::id()));
        let file = dir.join("spots.json");
        let mut map = HashMap::new();
        map.insert(
            "YSSY".to_string(),
            Spot {
                name: "02 左主起落架".into(),
                lat: -33.9461,
                lon: 151.1772,
                note: "下午顺光".into(),
            },
        );
        persist_spots(&file, &map).await.expect("write");
        let back = load_spots(&file).await;
        assert_eq!(back.get("YSSY").map(|s| s.name.as_str()), Some("02 左主起落架"));
        assert_eq!(back.get("YSSY").map(|s| s.note.as_str()), Some("下午顺光"));
        let _ = fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn missing_archive_loads_as_empty() {
        let map = load_spots(&std::env::temp_dir().join("pv-spots-definitely-absent.json")).await;
        assert!(map.is_empty());
    }
}

