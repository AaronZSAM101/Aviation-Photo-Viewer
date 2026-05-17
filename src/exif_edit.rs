use axum::{extract::State, http::StatusCode, Json};
use serde_json::json;
use std::{collections::HashMap, path::PathBuf};

use crate::{exif::date_to_sort_key, models::{AppState, ExifData}};
use crate::utils::safe_subpath;

#[derive(Debug, serde::Deserialize)]
pub struct ExifUpdateRequest {
    pub src: String,
    pub exif: ExifData,
}

fn is_empty_override(exif: &ExifData) -> bool {
    exif.date_taken.is_none()
        && exif.make.is_none()
        && exif.model.is_none()
        && exif.lens_model.is_none()
        && exif.software.is_none()
        && exif.iso.is_none()
        && exif.exposure_time.is_none()
        && exif.f_number.is_none()
        && exif.focal_length.is_none()
        && exif.focal_length_35mm.is_none()
        && exif.image_width.is_none()
        && exif.image_height.is_none()
        && exif.gps_lat.is_none()
        && exif.gps_lon.is_none()
        && exif.flash.is_none()
        && exif.white_balance.is_none()
        && exif.metering_mode.is_none()
        && exif.exposure_bias.is_none()
}

pub fn apply_exif_override(base: &mut ExifData, override_exif: &ExifData) {
    macro_rules! copy_field {
        ($field:ident) => {
            if override_exif.$field.is_some() {
                base.$field = override_exif.$field.clone();
            }
        };
    }

    copy_field!(date_taken);
    copy_field!(make);
    copy_field!(model);
    copy_field!(lens_model);
    copy_field!(software);
    copy_field!(iso);
    copy_field!(exposure_time);
    copy_field!(f_number);
    copy_field!(focal_length);
    copy_field!(focal_length_35mm);
    copy_field!(image_width);
    copy_field!(image_height);
    copy_field!(gps_lat);
    copy_field!(gps_lon);
    copy_field!(flash);
    copy_field!(white_balance);
    copy_field!(metering_mode);
    copy_field!(exposure_bias);
}

pub async fn load_exif_overrides(path: &PathBuf) -> HashMap<String, ExifData> {
    if !path.exists() {
        return HashMap::new();
    }

    match tokio::fs::read_to_string(path).await {
        Ok(text) => serde_json::from_str::<HashMap<String, ExifData>>(&text).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

pub async fn persist_exif_overrides_atomic(
    path: &PathBuf,
    snapshot: &HashMap<String, ExifData>,
) -> Result<(), String> {
    let buf = serde_json::to_vec_pretty(snapshot)
        .map_err(|e| format!("serialize exif overrides failed: {e}"))?;

    let tmp_name = format!(
        ".{}.tmp",
        path.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("photo_viewer_exif_overrides.json")
    );
    let tmp_path = path.with_file_name(tmp_name);

    tokio::fs::write(&tmp_path, &buf)
        .await
        .map_err(|e| format!("write temp exif overrides failed: {e}"))?;
    tokio::fs::rename(&tmp_path, path)
        .await
        .map_err(|e| format!("atomic rename exif overrides failed: {e}"))?;
    Ok(())
}

pub async fn update_exif(
    State(state): State<AppState>,
    Json(req): Json<ExifUpdateRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), (StatusCode, String)> {
    if !safe_subpath(&req.src) {
        return Err((StatusCode::BAD_REQUEST, "invalid src".to_string()));
    }

    let path = state.photos_dir.join(&req.src);
    if !path.exists() {
        return Err((StatusCode::NOT_FOUND, "source file not found".to_string()));
    }

    let cache_path = state.photos_dir.join(".photo_viewer_exif_overrides.json");

    {
        let mut overrides = state.exif_overrides.write().await;
        if is_empty_override(&req.exif) {
            overrides.remove(&req.src);
        } else {
            overrides.insert(req.src.clone(), req.exif.clone());
        }

        if let Err(e) = persist_exif_overrides_atomic(&cache_path, &overrides).await {
            return Err((StatusCode::INTERNAL_SERVER_ERROR, e));
        }
    }

    let sort_key = date_to_sort_key(req.exif.date_taken.as_deref());
    Ok((
        StatusCode::OK,
        Json(json!({"saved": true, "src": req.src, "sort_key": sort_key})),
    ))
}