use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
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
    pub gps_altitude: Option<f64>,
    pub gps_altitude_ref: Option<String>,
    pub gps_lat: Option<f64>,
    pub gps_lat_ref: Option<String>,
    pub gps_lon: Option<f64>,
    pub gps_lon_ref: Option<String>,
    pub gps_date_stamp: Option<String>,
    pub gps_time_stamp: Option<String>,
    pub gps_version_id: Option<String>,
    pub gps_map_datum: Option<String>,
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
    #[serde(default)]
    pub schema_version: u32,
    pub exif: ExifData,
    pub sort_key: i64,
}

pub const META_CACHE_SCHEMA_VERSION: u32 = 2;

/// 文件系统扫描到的照片条目
#[derive(Clone)]
pub struct PhotoEntry {
    pub path: PathBuf,
    pub subpath: String,
    pub filename: String,
    pub folder: String,
    pub size: u64,
    pub mtime: u64,
}

/// 图片文字识别出来的机号，按文件版本（mtime+size）存，避免改图后还用老结果。
/// 文件名里能读出机号时优先用文件名的，识别值只补空缺。
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct DetectedReg {
    pub mtime: u64,
    pub size: u64,
    #[serde(default)]
    pub regs: Vec<String>,
    #[serde(default)]
    pub engine: String,
}

/// 拍摄点档案：老照片没写 GPS，坐标只能人补。按文件夹记一次，
/// 再把某个点的照片单独补进 EXIF 覆盖层（见 `spots` 模块）。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Spot {
    /// 拍摄点名字，例如「01 跑道北端铁丝网」
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    #[serde(default)]
    pub note: String,
}

/// 彩绘关注清单：机号 → 我自己记的名字。数据源没标注这台时，靠它把班认出来。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct WatchItem {
    /// 彩绘名字，例如「FLYING HONU · 蓝色海龟」
    pub name: String,
    #[serde(default)]
    pub note: String,
    /// true = 我确认过这台确实刷了彩绘；false 只是留意，数据源另说时算「待核对」
    #[serde(default = "default_documented")]
    pub documented: bool,
}

fn default_documented() -> bool {
    true
}

/// 缓存的感知哈希
#[derive(Clone, Serialize, Deserialize)]
pub struct CachedHash {
    pub mtime: u64,
    pub size: u64,
    #[serde(default)]
    pub phash: u64,
    #[serde(default)]
    pub dhash: u64,
    #[serde(default)]
    pub color_sig: [u8; 12],
    #[serde(default)]
    pub aspect_milli: u32,
}

/// 后台相似照片扫描任务
#[derive(Clone, Serialize, Deserialize)]
pub struct SimilarScanJob {
    pub id: String,
    pub status: String,
    pub threshold: u32,
    pub limit: usize,
    pub max_photos: usize,
    pub scanned: usize,
    pub processed: usize,
    pub hashed: usize,
    pub cached: usize,
    pub unreadable: usize,
    pub total: usize,
    pub truncated: bool,
    pub pairs: Vec<serde_json::Value>,
    pub error: Option<String>,
}

/// 应用状态
#[derive(Clone)]
pub struct AppState {
    pub photos_dir: Arc<RwLock<PathBuf>>,
    /// 公网分享/反代认证场景下的只读保护开关
    pub read_only: bool,
    /// 相对路径 → (mtime, size, JPEG 缩略图字节)
    pub thumb_cache: Arc<RwLock<HashMap<String, (u64, u64, Vec<u8>)>>>,
    /// 相对路径 → (mtime, size, 预览字节, mime类型)
    pub preview_cache: Arc<RwLock<HashMap<String, (u64, u64, Vec<u8>, String)>>>,
    /// 待应用的文件操作
    pub staged_ops: Arc<RwLock<Vec<StagedOp>>>,
    /// 相对路径 → 缓存的EXIF元数据
    pub meta_cache: Arc<RwLock<HashMap<String, CachedMeta>>>,
    /// 相对路径 → 正在后台提取 EXIF 的 (mtime, size)，避免重复排队同一文件版本
    pub meta_extract_inflight: Arc<RwLock<HashMap<String, (u64, u64)>>>,
    /// 相对路径 → 缓存的感知哈希
    pub phash_cache: Arc<RwLock<HashMap<String, CachedHash>>>,
    /// 后台相似照片扫描任务
    pub similar_jobs: Arc<RwLock<HashMap<String, Arc<Mutex<SimilarScanJob>>>>>,
    /// 是否已有感知哈希预热任务在运行
    pub phash_warmup_running: Arc<Mutex<bool>>,
    /// 相对路径 → 人工编辑后的 EXIF 覆盖值
    pub exif_overrides: Arc<RwLock<HashMap<String, ExifData>>>,
    /// 相对路径 → 图片文字识别出的机号（文件名读不出机号时用它补）
    pub reg_detect: Arc<RwLock<HashMap<String, DetectedReg>>>,
    /// 文件夹（'' 表示库根）→ 拍摄点档案
    pub spots: Arc<RwLock<HashMap<String, Spot>>>,
    /// 机号 → 彩绘关注清单（`.photo_viewer/watchlist.json`）
    pub livery_watch: Arc<RwLock<HashMap<String, WatchItem>>>,
    /// 「机场/日期」→ 最近一次成功读到的排班提醒，5 分钟内直接复用
    pub livery_feed: Arc<RwLock<HashMap<String, crate::livery::FeedOutcome>>>,
    /// 串行化会读写 .trash 及 manifest 的批次，避免并发 apply 互相覆盖映射
    pub trash_lock: Arc<tokio::sync::Mutex<()>>,
    /// 照片目录切换代数：切换后递增，用来丢弃旧目录的在途结果
    pub dir_generation: Arc<std::sync::atomic::AtomicU64>,
    /// 最近一次照片扫描的结果摘要（含错误），供 /api/scan/status 与界面提示使用
    pub last_scan: Arc<RwLock<ScanStatus>>,
}

/// 单条扫描错误（目录不可读、路径过长等）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ScanError {
    pub path: String,
    pub message: String,
}

/// 最近一次扫描摘要
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ScanStatus {
    /// 受影响的相对路径 → 错误信息
    pub errors: Vec<ScanError>,
    /// 是否因为 max_photos 截断（截断不算错误）
    pub truncated: bool,
    pub scanned: usize,
    /// Unix 毫秒时间戳；0 表示还没有扫描过
    pub at: u64,
}

/// 文件操作类型
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OpKind {
    Delete,
    Move,
    Copy,
    Rename,
    Restore,
    Exif,
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
    #[serde(default)]
    pub exif: Option<ExifData>,
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
    /// 机号：文件名里读出来的优先，读不出时用图片文字识别的结果
    #[serde(default)]
    pub regs: Vec<String>,
    /// 机号来源，方便界面说明这是猜的还是写死的
    pub reg_source: &'static str,
}

/// 照片查询参数
#[derive(Deserialize)]
pub struct PhotosQuery {
    pub sort: Option<String>,
}
