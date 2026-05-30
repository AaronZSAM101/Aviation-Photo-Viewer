use std::{
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

use crate::cache_paths;
use crate::models::PhotoEntry;

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
        name == cache_paths::STATE_DIR_NAME || name == ".trash" || name.starts_with('@')
    })
}

pub fn collect_photo_entries(
    photos_dir: PathBuf,
    max_photos: Option<usize>,
) -> (Vec<PhotoEntry>, bool) {
    use walkdir::WalkDir;

    let photos_root = photos_dir.clone();
    let mut entries = Vec::new();
    let mut truncated = false;

    for entry in WalkDir::new(&photos_dir)
        .max_depth(4)
        .into_iter()
        .filter_entry(|entry| should_descend(entry, &photos_root))
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() || !is_supported_image(entry.path()) {
            continue;
        }

        let path = entry.path().to_path_buf();
        let Some(metadata) = entry.metadata().ok() else {
            continue;
        };
        let size = metadata.len();
        let mtime = metadata_mtime_key(&metadata);
        let Some(filename) = path
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
        else {
            continue;
        };
        let folder = path
            .parent()
            .and_then(|p| p.strip_prefix(&photos_root).ok())
            .and_then(|p| p.to_str())
            .unwrap_or("")
            .to_string();
        let subpath = if folder.is_empty() {
            filename.clone()
        } else {
            format!("{}/{}", folder, filename)
        };

        entries.push(PhotoEntry {
            path,
            subpath,
            filename,
            folder,
            size,
            mtime,
        });

        if max_photos.is_some_and(|max| entries.len() >= max) {
            truncated = true;
            break;
        }
    }

    (entries, truncated)
}
