export interface ExifData {
  date_taken: string | null;
  make: string | null;
  model: string | null;
  lens_model: string | null;
  software: string | null;
  iso: string | null;
  exposure_time: string | null;
  f_number: string | null;
  focal_length: string | null;
  focal_length_35mm: string | null;
  image_width: number | null;
  image_height: number | null;
  gps_altitude: number | null;
  gps_altitude_ref: string | null;
  gps_lat: number | null;
  gps_lat_ref: string | null;
  gps_lon: number | null;
  gps_lon_ref: string | null;
  gps_date_stamp: string | null;
  gps_time_stamp: string | null;
  gps_version_id: string | null;
  gps_map_datum: string | null;
  flash: string | null;
  white_balance: string | null;
  metering_mode: string | null;
  exposure_bias: string | null;
}

export interface Photo {
  filename: string;
  folder: string;
  size: number;
  mtime: number;
  exif: ExifData;
  date_sort_key: number;
  // 机号：后端从文件名读出，文件名读不出时才回落到机身文字识别的结果
  regs?: string[];
  reg_source?: 'name' | 'ocr' | 'none';
}

// 拍摄点档案：老照片没写 GPS，坐标由人按文件夹补一次（后端 spots.json）
export interface Spot {
  name: string;
  lat: number;
  lon: number;
  note?: string;
}

export type SortKey = 'date-asc' | 'date-desc' | 'name-asc' | 'name-desc' | 'size-desc';
export type BaseView = 'flat' | 'folder';
export type TimeScale = 'none' | 'year' | 'month' | 'day';
export type ZoomMode = 'fit' | 'actual' | 'fill' | 'custom';
export type ThemeMode = 'auto' | 'light' | 'dark';

export interface BrowsePreferences {
  currentSort: SortKey;
  baseView: BaseView;
  timeScale: TimeScale;
  zoomMode: ZoomMode;
}

export interface AppConfig {
  readOnly?: boolean;
  ocrAvailable?: boolean;
  liveryConfigured?: boolean;
  defaultAirport?: string;
  version?: string | null;
  versionSource?: string | null;
  user?: string | null;
  email?: string | null;
}

export type OpKind = 'delete' | 'move' | 'copy' | 'rename' | 'restore' | 'exif';

// 彩绘关注清单：机号 → 自己记的名字（后端 watchlist.json）
export interface WatchItem {
  registration: string;
  name: string;
  note?: string;
  documented: boolean;
}

// 提醒里的一条航班：数据源给的原始信息 + 后端按规则判出来的类别
export interface LiveryAlert {
  flightNumber: string;
  registration: string | null;
  model: string;
  airline: string;
  origin: string;
  destination: string;
  direction: 'arrival' | 'departure';
  scheduledAt: string | null;
  status: string;
  source: string;
  name: string;
  category: string;
  providerTarget?: string | null;
}

export interface LiveryFeed {
  state: 'ok' | 'empty' | 'stale' | 'error' | 'unconfigured';
  message: string;
  alerts: LiveryAlert[];
  totalFlights: number;
  feedSource: string;
  retrievedAt: number;
  stale: boolean;
}

export interface StagedOp {
  id: string;
  kind: OpKind;
  src: string;
  dst?: string | null;
  replace?: boolean;
  exif?: ExifData | null;
}

export interface TrashItem {
  name: string;
  original?: string | null;
}

// 应用分批时后端拒绝的覆盖冲突：操作仍留在队列里，等待用户处理
export interface StageConflict {
  kind?: OpKind;
  src: string;
  dst?: string | null;
  reason?: string;
}

export interface StageOpResult {
  id: string;
  kind: OpKind;
  src: string;
  dst?: string | null;
  status: 'applied' | 'skipped' | 'failed';
  error?: string | null;
}

export interface StageApplyResult {
  applied: number;
  results?: StageOpResult[];
  pending?: number;
}

export interface StagedRequest {
  kind: OpKind;
  src: string;
  dst?: string;
  replace?: boolean;
  exif?: Record<string, string | number | null>;
}

export interface ExifUpdatePayload {
  src: string;
  exif: Record<string, string | number | null>;
}

export type SimilarityTone = 'same' | 'high' | 'medium' | 'low';

export interface CompareAssessment {
  verdict?: string;
  verdict_label?: string;
  tone?: SimilarityTone;
  score?: number;
  reasons?: string[];
  phash_dist?: number;
  ahash_dist?: number;
  dhash_dist?: number;
  color_dist?: number;
  aspect_dist?: number;
  same_phash?: boolean;
}

export interface CompareResult extends CompareAssessment {
  sha_a: string;
  sha_b: string;
  same_file: boolean;
}

export interface SimilarPair extends CompareAssessment {
  a: string;
  b: string;
}

export interface SimilarScanParams {
  threshold: number;
  limit: number;
  max_photos: number;
}

export interface SimilarJob {
  id?: string;
  status: 'running' | 'done' | 'error';
  threshold?: number;
  limit?: number;
  max_photos?: number;
  scanned?: number;
  processed?: number;
  hashed?: number;
  cached?: number;
  unreadable?: number;
  total?: number;
  truncated?: boolean;
  pairs?: SimilarPair[];
  error?: string | null;
}

export interface GpsCustomSource {
  id: string;
  name: string;
  template: string;
  key: string;
  subdomains: string;
  maxZoom: number;
}

export interface GpsMapSettings {
  provider: string;
  zoom: number;
  customSources: GpsCustomSource[];
  sourceKeys: Record<string, string>;
}

export interface GpsSource extends GpsCustomSource {
  needsKey?: boolean;
}

export interface GpsPoint {
  lat: number;
  lon: number;
}

export interface GpsMeasureState {
  active: boolean;
  points: GpsPoint[];
  focalGuide: boolean;
}

export interface GalleryCardEntry {
  photo: Photo;
  index: number;
}

export interface GallerySection {
  key: string | null;
  label: string;
  icon: string;
  count: number;
  items: GalleryCardEntry[];
  children: GallerySection[];
}
