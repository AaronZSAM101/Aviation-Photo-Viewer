//! RAW 图片的解码入口。
//!
//! `image` 0.24 认不得 CR2/CR3/NEF/ARW/DNG 这些相机原始格式，但几乎所有相机
//! 都会在 RAW 里内嵌一张自己处理过的 JPEG（相机背面回放和 macOS 预览用的就是它）。
//! 所以这里统一用 exiftool 把内嵌预览取出来当解码结果：
//! 列表、缩略图、预览、感知哈希拿到的是同一份像素，不会出现两套哈希互相对不上的情况。
use std::path::Path;
use std::process::Command;

use image::DynamicImage;

/// 当作 RAW 处理的扩展名（小写，不含点）
pub const RAW_EXTS: &[&str] = &[
    "3fr", "arw", "cr2", "cr3", "dng", "iiq", "kdc", "mrw", "nef", "nrw", "orf", "pef", "raf",
    "raw", "rw2", "sr2", "srf", "x3f",
];

/// 内嵌预览小于这个字节数就当没有：exiftool 取不到标签时输出为空，
/// 个别机型会给出一个几十 KB 的小图标，撑不起 2400px 的预览。
const MIN_PREVIEW_BYTES: usize = 40_000;

pub fn is_raw(path: &Path) -> bool {
    let ext = match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => ext.to_ascii_lowercase(),
        None => return false,
    };
    RAW_EXTS.contains(&ext.as_str())
}

/// 读出一张照片可用于渲染的位图。RAW 走内嵌预览，其余交给 image。
pub fn open_image(path: &Path) -> Option<DynamicImage> {
    if !is_raw(path) {
        return image::open(path).ok();
    }
    if let Some(img) = embedded_preview(path) {
        return Some(img);
    }
    // 扩展名是 RAW 却读不到内嵌预览时按文件内容再试一次：
    // image::open 用扩展名选解码器，`.CR2` 这种它直接拒收，
    // 而导出改名、云盘里塞个 JPEG 的情况其实是有像素的。
    let bytes = std::fs::read(path).ok()?;
    image::load_from_memory(&bytes).ok()
}

fn embedded_preview(path: &Path) -> Option<DynamicImage> {
    let bytes = embedded_preview_bytes(path)?;
    image::load_from_memory(&bytes).ok()
}

fn embedded_preview_bytes(path: &Path) -> Option<Vec<u8>> {
    // PreviewImage 是相机给的全尺寸 JPEG；老机身只有 ThumbnailImage 时退而求其次
    for tag in ["-PreviewImage", "-ThumbnailImage"] {
        if let Some(bytes) = exiftool_binary(path, tag) {
            if bytes.len() >= MIN_PREVIEW_BYTES {
                return Some(bytes);
            }
        }
    }
    None
}

fn exiftool_binary(path: &Path, tag: &str) -> Option<Vec<u8>> {
    let output = Command::new("exiftool")
        .arg("-b")
        .arg("-q")
        .arg(tag)
        .arg(path)
        .output()
        .ok()?;
    if !output.status.success() || output.stdout.is_empty() {
        return None;
    }
    Some(output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_raw_by_extension() {
        assert!(is_raw(Path::new("a/b/x.CR3")));
        assert!(is_raw(Path::new("shot.dng")));
        assert!(!is_raw(Path::new("shot.jpg")));
        assert!(!is_raw(Path::new("noextension")));
    }
}
