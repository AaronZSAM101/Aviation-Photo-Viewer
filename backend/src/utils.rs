use std::{
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

use crate::models::{PhotoEntry, ScanError};

pub const SUPPORTED_EXTS: &[&str] = &["jpg", "jpeg", "png", "tiff", "tif", "webp"];

/// 检查路径是否安全（必须是非空的相对路径，且不能包含父目录/根路径）
pub fn safe_subpath(p: &str) -> bool {
    if p.is_empty() {
        return false;
    }

    let path = Path::new(p);
    path.components()
        .all(|component| matches!(component, Component::Normal(_)))
}

/// 计算8x8 Average Hash (aHash)用于感知哈希
pub fn compute_ahash(img: &image::DynamicImage) -> u64 {
    use image::imageops::FilterType;
    let small = img.resize_exact(8, 8, FilterType::Triangle).to_luma8();
    let mut sum: u32 = 0;
    for p in small.pixels() {
        sum += p[0] as u32;
    }
    let avg = (sum / 64) as u8;
    let mut bits = 0u64;
    for (i, p) in small.pixels().enumerate() {
        if p[0] > avg {
            bits |= 1u64 << i;
        }
    }
    bits
}

/// 计算 8x8 Difference Hash。相比 aHash，它对航空照片这种类似构图的误报更少。
pub fn compute_dhash(img: &image::DynamicImage) -> u64 {
    use image::imageops::FilterType;
    let small = img.resize_exact(9, 8, FilterType::Triangle).to_luma8();
    let mut bits = 0u64;
    for y in 0..8 {
        for x in 0..8 {
            let left = small.get_pixel(x, y)[0];
            let right = small.get_pixel(x + 1, y)[0];
            if left > right {
                bits |= 1u64 << (y * 8 + x);
            }
        }
    }
    bits
}

/// 粗略颜色签名：4x1 RGB 均值，用于减少“构图相似但主体涂装/背景不同”的误报。
pub fn compute_color_sig(img: &image::DynamicImage) -> [u8; 12] {
    use image::imageops::FilterType;
    let small = img.resize_exact(4, 1, FilterType::Triangle).to_rgb8();
    let mut sig = [0u8; 12];
    for x in 0..4 {
        let p = small.get_pixel(x, 0);
        let base = (x as usize) * 3;
        sig[base] = p[0];
        sig[base + 1] = p[1];
        sig[base + 2] = p[2];
    }
    sig
}

pub fn aspect_milli(img: &image::DynamicImage) -> u32 {
    let h = img.height().max(1);
    ((img.width() as u64 * 1000) / h as u64) as u32
}

pub fn is_supported_image(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    SUPPORTED_EXTS.contains(&ext.as_str())
}

pub fn metadata_mtime_key(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_micros().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

fn should_descend(entry: &walkdir::DirEntry, root: &Path) -> bool {
    if entry.depth() == 0 {
        return true;
    }

    let Ok(rel) = entry.path().strip_prefix(root) else {
        return true;
    };

    !rel.components().any(|c| {
        let name = c.as_os_str().to_string_lossy();
        crate::paths::is_reserved_component(&name)
    })
}

/// 一次扫描的结果。`truncated` 只表示因 max_photos 提前停止，不能当作“扫描完整”；
/// 真正的扫描错误单独放在 `errors` 里，由调用方向上汇报。
#[derive(Default)]
pub struct ScanOutcome {
    pub entries: Vec<PhotoEntry>,
    pub truncated: bool,
    pub errors: Vec<ScanError>,
}

const MAX_SCAN_ERRORS: usize = 50;

fn push_scan_error(errors: &mut Vec<ScanError>, root: &Path, path: Option<&Path>, message: String) {
    if errors.len() >= MAX_SCAN_ERRORS {
        return;
    }
    let rel = path
        .and_then(|p| p.strip_prefix(root).ok())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    errors.push(ScanError { path: rel, message });
}

/// 每个并行任务处理的文件数。分块要够细：库里最大的目录有 1600+ 张，
/// 按目录粒度并行会让一个线程独自跑完大头，其余线程提前空等。
const SCAN_CHUNK_FILES: usize = 100;

fn record_stat_error(
    errors: &mut Vec<ScanError>,
    root: &Path,
    path: &Path,
    error: &std::io::Error,
) {
    // 只在文件确实出问题时上报；扫描期间被删掉属于正常竞争，不算错误
    if error.kind() != std::io::ErrorKind::NotFound {
        push_scan_error(errors, root, Some(path), error.to_string());
    }
}

fn photo_entry(root: &Path, path: &Path, metadata: &std::fs::Metadata) -> Option<PhotoEntry> {
    let filename = path.file_name()?.to_str()?.to_string();
    let folder = path
        .parent()
        .and_then(|p| p.strip_prefix(root).ok())
        .and_then(|p| p.to_str())
        .unwrap_or("")
        .to_string();
    let subpath = if folder.is_empty() {
        filename.clone()
    } else {
        format!("{}/{}", folder, filename)
    };
    Some(PhotoEntry {
        path: path.to_path_buf(),
        subpath,
        filename,
        folder,
        size: metadata.len(),
        mtime: metadata_mtime_key(metadata),
    })
}

/// 只做 readdir、不 stat 的预扫描：把库里所有候选图片的路径收齐。
/// 网络盘上真正贵的是每个文件一次 stat，所以先把这些路径平摊成均匀的块。
fn collect_photo_paths(photos_root: &Path) -> (Vec<PathBuf>, Vec<ScanError>) {
    let mut files = Vec::new();
    let mut errors = Vec::new();
    // (目录, 相对库根的层数)。原来 walkdir 的 max_depth(4) 等于“最多下降到 3 层目录”
    let mut stack = vec![(photos_root.to_path_buf(), 0usize)];

    while let Some((dir, depth)) = stack.pop() {
        let read_dir = match std::fs::read_dir(&dir) {
            Ok(read_dir) => read_dir,
            Err(error) => {
                push_scan_error(&mut errors, photos_root, Some(&dir), error.to_string());
                continue;
            }
        };
        for item in read_dir {
            let item = match item {
                Ok(item) => item,
                Err(error) => {
                    push_scan_error(&mut errors, photos_root, Some(&dir), error.to_string());
                    continue;
                }
            };
            if crate::paths::is_reserved_component(&item.file_name().to_string_lossy()) {
                continue;
            }
            let file_type = match item.file_type() {
                Ok(file_type) => file_type,
                Err(error) => {
                    push_scan_error(
                        &mut errors,
                        photos_root,
                        Some(&item.path()),
                        error.to_string(),
                    );
                    continue;
                }
            };
            // is_dir()/is_file() 走 dirent 的 d_type，不解引用软链接：
            // 软链接目录不进入、软链接文件不作为照片，与原来 walkdir(follow_links=false) 一致
            if file_type.is_dir() {
                if depth + 1 <= 3 {
                    stack.push((item.path(), depth + 1));
                }
            } else if file_type.is_file() && is_supported_image(&item.path()) {
                files.push(item.path());
            }
        }
    }

    files.sort();
    (files, errors)
}

/// 一段并发扫描的结果
#[derive(Default)]
struct ShardScan {
    entries: Vec<PhotoEntry>,
    errors: Vec<ScanError>,
}

/// 列出照片库中的所有图片。
///
/// 照片放在 virtiofs/Synology 这类网络盘上时，逐个 `metadata()` 才是列表接口的耗时主体：
/// 串行 stat 约 1.8s，先 readdir 收齐路径、再按 100 张一块交给 rayon 并行后约 0.5s。
/// 路径先排序，`max_photos` 截的是排在前面的固定一批，同一库每次返回同一批条目；
/// 超出上限的路径不再 stat，保留原来“扫到上限即停”的行为。
pub fn collect_photo_entries(photos_dir: PathBuf, max_photos: Option<usize>) -> ScanOutcome {
    use rayon::prelude::*;

    let photos_root = photos_dir;
    let mut outcome = ScanOutcome::default();

    let (files, mut errors) = collect_photo_paths(&photos_root);
    // 与串行版本一致：最多只向调用方汇报前 MAX_SCAN_ERRORS 条错误
    errors.truncate(MAX_SCAN_ERRORS);
    outcome.errors = errors;

    let total = files.len();
    let limit = max_photos.unwrap_or(total);

    let parts = files
        .into_par_iter()
        .enumerate()
        .chunks(SCAN_CHUNK_FILES)
        .map(|chunk| {
            let mut out = ShardScan::default();
            for (index, path) in chunk {
                if index >= limit {
                    break;
                }
                let metadata = match std::fs::metadata(&path) {
                    Ok(metadata) => metadata,
                    Err(error) => {
                        record_stat_error(&mut out.errors, &photos_root, &path, &error);
                        continue;
                    }
                };
                if let Some(entry) = photo_entry(&photos_root, &path, &metadata) {
                    out.entries.push(entry);
                }
            }
            out
        })
        .collect::<Vec<_>>();

    let mut entries = Vec::new();
    let mut stat_errors = Vec::new();
    for part in parts {
        entries.extend(part.entries);
        stat_errors.extend(part.errors);
    }
    if outcome.errors.len() < MAX_SCAN_ERRORS {
        let room = MAX_SCAN_ERRORS - outcome.errors.len();
        outcome.errors.extend(stat_errors.into_iter().take(room));
    }
    entries.sort_by(|a, b| a.subpath.cmp(&b.subpath));

    outcome.entries = entries;
    outcome.truncated = limit < total;

    outcome
}

pub fn collect_photo_folders(photos_dir: PathBuf) -> Vec<String> {
    use walkdir::WalkDir;

    let photos_root = photos_dir.clone();
    let mut folders = Vec::new();

    for entry in WalkDir::new(&photos_dir)
        .max_depth(4)
        .into_iter()
        .filter_entry(|entry| should_descend(entry, &photos_root))
        .filter_map(|e| e.ok())
    {
        if entry.depth() == 0 || !entry.file_type().is_dir() {
            continue;
        }

        let Some(folder) = entry
            .path()
            .strip_prefix(&photos_root)
            .ok()
            .and_then(|p| p.to_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
        else {
            continue;
        };

        folders.push(folder);
    }

    folders.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()).then(a.cmp(b)));
    folders.dedup();
    folders
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, remove_dir_all, write as write_file};
    use uuid::Uuid;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("photo-viewer-scan-{}", Uuid::new_v4().simple()));
            create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = remove_dir_all(&self.0);
        }
    }

    fn touch(root: &Path, rel: &str) {
        let path = root.join(rel);
        create_dir_all(path.parent().unwrap()).unwrap();
        write_file(&path, b"x").unwrap();
    }

    fn subpaths(outcome: &ScanOutcome) -> Vec<String> {
        outcome.entries.iter().map(|e| e.subpath.clone()).collect()
    }

    #[test]
    fn scan_covers_four_levels_and_skips_unsupported_ext() {
        let tmp = TempDir::new();
        touch(&tmp.0, "root.jpg");
        touch(&tmp.0, "a/b/c/nested.jpeg");
        touch(&tmp.0, "a/b/c/d/too_deep.png");
        touch(&tmp.0, "a/notes.txt");

        let outcome = collect_photo_entries(tmp.0.clone(), None);

        assert_eq!(subpaths(&outcome), vec!["a/b/c/nested.jpeg", "root.jpg"]);
        assert!(outcome.errors.is_empty(), "{:?}", outcome.errors);
        assert!(!outcome.truncated);
    }

    #[test]
    fn scan_skips_reserved_directories_at_every_depth() {
        let tmp = TempDir::new();
        touch(&tmp.0, "keep/ok.jpg");
        touch(&tmp.0, &format!("{}/thumb.jpg", crate::cache_paths::STATE_DIR_NAME));
        touch(&tmp.0, &format!("{}/gone.jpg", crate::paths::TRASH_DIR_NAME));
        touch(&tmp.0, &format!("keep/{}/x.jpg", crate::cache_paths::STATE_DIR_NAME));

        let outcome = collect_photo_entries(tmp.0.clone(), None);

        assert_eq!(subpaths(&outcome), vec!["keep/ok.jpg"]);
        assert!(outcome.errors.is_empty(), "{:?}", outcome.errors);
    }

    #[test]
    fn scan_truncates_deterministically_at_max_photos() {
        let tmp = TempDir::new();
        for i in 0..25 {
            touch(&tmp.0, &format!("batch/{i:02}.jpg"));
        }
        touch(&tmp.0, "other/z.jpg");

        let outcome = collect_photo_entries(tmp.0.clone(), Some(10));

        assert_eq!(outcome.entries.len(), 10);
        assert!(outcome.truncated);
        assert_eq!(outcome.entries[0].subpath, "batch/00.jpg");
        assert_eq!(outcome.entries[9].subpath, "batch/09.jpg");
        let mut sorted = subpaths(&outcome);
        sorted.sort();
        assert_eq!(sorted, subpaths(&outcome), "结果必须按 subpath 有序");
    }

    #[test]
    fn scan_reports_unreadable_root_without_entries() {
        let missing = std::env::temp_dir().join(format!("photo-viewer-absent-{}", Uuid::new_v4().simple()));

        let outcome = collect_photo_entries(missing, None);

        assert!(outcome.entries.is_empty());
        assert_eq!(outcome.errors.len(), 1, "{:?}", outcome.errors);
        assert_eq!(outcome.errors[0].path, "");
    }

    #[test]
    fn scan_ignores_symlinks_like_walkdir_without_follow_links() {
        let tmp = TempDir::new();
        let outside = TempDir::new();
        touch(&outside.0, "real.jpg");
        touch(&tmp.0, "keep/ok.jpg");
        std::os::unix::fs::symlink(outside.0.join("real.jpg"), tmp.0.join("keep/link.jpg")).unwrap();
        std::os::unix::fs::symlink(&outside.0, tmp.0.join("linkdir")).unwrap();

        let outcome = collect_photo_entries(tmp.0.clone(), None);

        assert_eq!(subpaths(&outcome), vec!["keep/ok.jpg"]);
        assert!(outcome.errors.is_empty(), "{:?}", outcome.errors);
    }

    #[test]
    fn folders_skip_reserved_and_nested_dirs() {
        let tmp = TempDir::new();
        touch(&tmp.0, "Beta/ok.jpg");
        touch(&tmp.0, &format!("{}/x.jpg", crate::paths::TRASH_DIR_NAME));

        assert_eq!(collect_photo_folders(tmp.0.clone()), vec!["Beta".to_string()]);
    }
}
