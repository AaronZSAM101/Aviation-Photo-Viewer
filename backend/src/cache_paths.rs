use std::path::{Path, PathBuf};

pub const STATE_DIR_NAME: &str = ".photo_viewer";

pub fn state_dir(photos_dir: &Path) -> PathBuf {
    photos_dir.join(STATE_DIR_NAME)
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
