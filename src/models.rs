use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tokio::sync::RwLock;

/// 存储EXIF元数据
#[derive(Debug, Default, Serialize, Deserialize, Clone)]
pub struct ExifData {
    pub date_taken: Option<String>,
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens_model: Option<String>,
    pub software: Option<String>,
    pub iso: Option<String>,
    pub exposure_time: Option<String>,
    pub f_number: Option<String>,
    pub focal_length: Option<String>,
    pub focal_length_35mm: Option<String>,
    pub image_width: Option<u32>,
    pub image_height: Option<u32>,
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
    pub flash: Option<String>,
    pub white_balance: Option<String>,
    pub metering_mode: Option<String>,
    pub exposure_bias: Option<String>,
}

/// 缓存的元数据
#[derive(Clone, Serialize, Deserialize)]
pub struct CachedMeta {
    pub mtime: u64,
    pub size: u64,
    pub exif: ExifData,
    pub sort_key: i64,
}

/// 应用状态
#[derive(Clone)]
pub struct AppState {
    pub photos_dir: Arc<PathBuf>,
    /// 相对路径 → (mtime, size, JPEG 缩略图字节)
    pub thumb_cache: Arc<RwLock<HashMap<String, (u64, u64, Vec<u8>)>>>,
    /// 相对路径 → (mtime, size, 预览字节, mime类型)
    pub preview_cache: Arc<RwLock<HashMap<String, (u64, u64, Vec<u8>, String)>>>,
    /// 待应用的文件操作
    pub staged_ops: Arc<RwLock<Vec<StagedOp>>>,
    /// 相对路径 → 缓存的EXIF元数据
    pub meta_cache: Arc<RwLock<HashMap<String, CachedMeta>>>,
}

/// 文件操作类型
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum OpKind {
    Delete,
    Move,
    Copy,
    Rename,
    Restore,
}

/// 待处理的文件操作
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StagedOp {
    pub id: String,
    pub kind: OpKind,
    pub src: String,
    pub dst: Option<String>,
    #[serde(default)]
    pub replace: bool,
}

/// 照片元数据
#[derive(Debug, Serialize, Clone)]
pub struct PhotoMeta {
    pub filename: String,
    /// 相对于根目录的子文件夹路径，空字符串表示根目录
    pub folder: String,
    pub size: u64,
    pub mtime: u64,
    pub exif: ExifData,
    /// 紧凑时间戳 (YYYYMMDDHHMMSS) 用于排序
    pub date_sort_key: i64,
}

/// 照片查询参数
#[derive(Deserialize)]
pub struct PhotosQuery {
    pub sort: Option<String>,
}
