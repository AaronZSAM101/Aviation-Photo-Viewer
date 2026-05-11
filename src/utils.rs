use std::path::{Component, Path};

/// 检查路径是否安全（必须是非空的相对路径，且不能包含父目录/根路径）
pub fn safe_subpath(p: &str) -> bool {
    if p.is_empty() {
        return false;
    }

    let path = Path::new(p);
    path.components().all(|component| matches!(component, Component::Normal(_)))
}

/// 计算8x8 Average Hash (aHash)用于感知哈希
pub fn compute_ahash(img: &image::DynamicImage) -> u64 {
    use image::imageops::FilterType;
    let small = img
        .resize_exact(8, 8, FilterType::Triangle)
        .to_luma8();
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
