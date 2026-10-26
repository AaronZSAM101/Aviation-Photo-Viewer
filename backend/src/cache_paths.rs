use std::path::{Path, PathBuf};

pub const STATE_DIR_NAME: &str = ".photo_viewer";

/// 把状态文件和缩略图缓存挪出照片目录用；不设就维持老行为，写在照片目录里。
pub const CACHE_DIR_ENV: &str = "PHOTO_VIEWER_CACHE_DIR";

/// 照片目录本身也可能在运行时被换掉（admin set-dir），所以外部缓存目录下按库分子目录，
/// 两个库的 meta/thumbs 才不会互相盖掉。后缀是整条路径的 FNV-1a，避免纯中文名被洗成同样的横线。
pub fn library_slug(photos_dir: &Path) -> String {
    let raw = photos_dir.to_string_lossy();
    let mut slug = String::with_capacity(raw.len());
    for ch in raw.chars() {
        slug.push(if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            ch
        } else {
            '-'
        });
    }
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "root" } else { slug };
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in raw.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{slug}-{hash:08x}")
}

pub fn state_dir_in(photos_dir: &Path, cache_root: Option<&Path>) -> PathBuf {
    match cache_root {
        Some(root) => root.join(library_slug(photos_dir)),
        None => photos_dir.join(STATE_DIR_NAME),
    }
}

fn cache_root() -> Option<PathBuf> {
    std::env::var(CACHE_DIR_ENV)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

pub fn state_dir(photos_dir: &Path) -> PathBuf {
    state_dir_in(photos_dir, cache_root().as_deref())
}

pub fn meta_cache(photos_dir: &Path) -> PathBuf {
    state_dir(photos_dir).join("meta.json")
}

pub fn legacy_meta_cache(photos_dir: &Path) -> PathBuf {
    photos_dir.join(".photo_viewer_meta.json")
}

pub fn hash_cache(photos_dir: &Path) -> PathBuf {
    state_dir(photos_dir).join("hash_cache.json")
}

pub fn thumbs_dir(photos_dir: &Path) -> PathBuf {
    state_dir(photos_dir).join("thumbs")
}

pub fn legacy_hash_cache(photos_dir: &Path) -> PathBuf {
    photos_dir.join(".photo_viewer_hash_cache.json")
}

pub fn exif_overrides(photos_dir: &Path) -> PathBuf {
    state_dir(photos_dir).join("exif_overrides.json")
}

pub fn legacy_exif_overrides(photos_dir: &Path) -> PathBuf {
    photos_dir.join(".photo_viewer_exif_overrides.json")
}

pub fn preferred_existing(preferred: PathBuf, legacy: PathBuf) -> PathBuf {
    if preferred.exists() || !legacy.exists() {
        preferred
    } else {
        legacy
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_dir_stays_in_the_library_without_a_cache_root() {
        assert_eq!(
            state_dir_in(Path::new("/photos"), None),
            PathBuf::from("/photos/.photo_viewer")
        );
    }

    #[test]
    fn state_dir_moves_under_the_cache_root_per_library() {
        let moved = state_dir_in(Path::new("/photos"), Some(Path::new("/fast-cache")));
        assert!(moved.starts_with("/fast-cache"));
        assert!(moved.ends_with(library_slug(Path::new("/photos"))));
        assert_ne!(moved, PathBuf::from("/fast-cache"));
    }

    #[test]
    fn different_libraries_get_different_slug_dirs() {
        assert_ne!(
            library_slug(Path::new("/photos/Aviation")),
            library_slug(Path::new("/photos/Personal"))
        );
        // 中文名会被洗成一串横线，靠后缀区分
        assert_ne!(
            library_slug(Path::new("/库/彩绘机")),
            library_slug(Path::new("/库/南航机"))
        );
    }

    #[test]
    fn slug_is_a_single_safe_path_component() {
        for dir in ["/photos", "/", "", "a/../b"] {
            let slug = library_slug(Path::new(dir));
            assert!(!slug.is_empty());
            assert!(!slug.contains('/'), "{dir} -> {slug}");
            assert!(!slug.contains(".."), "{dir} -> {slug}");
        }
    }

    #[test]
    fn slug_is_stable_across_calls() {
        assert_eq!(library_slug(Path::new("/photos/x")), library_slug(Path::new("/photos/x")));
    }
}
