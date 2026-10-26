//! 用户输入路径的边界检查。
//!
//! 这里不把 `canonicalize` 当前置条件：它只跟随链接给出最终位置，既分不清中间某个
//! 组件是不是符号链接，也无法阻止检查与读取之间的替换。实际策略是：
//! 1. 只接受纯普通组件的相对路径，拒绝 `..`、根路径；
//! 2. 拒绝访问 `.photo_viewer`、`.trash`、`@*` 这些保留目录；
//! 3. 逐级 `symlink_metadata`，路径里出现任何符号链接即拒绝；
//! 4. 末端必须是普通文件（不打开 FIFO/设备，避免读请求被挂住）；
//! 5. 再 canonicalize 已存在的父目录，确认仍在照片库根内（覆盖根目录自身是链接、
//!    或挂载点把父目录换掉的情况）。
//!
//! 这不是内核级 `openat2(RESOLVE_BENEATH)`：本地写者仍可在最后一步替换目录。
//! 能写照片库的人本来就能直接读这些文件，所以边界定在“不跟随应用数据里的符号链接”。

use std::path::{Component, Path, PathBuf};

use tokio::fs;

use crate::cache_paths;

pub const TRASH_DIR_NAME: &str = ".trash";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathError {
    /// 语法上不接受（400）
    Invalid,
    /// 指向保留目录或符号链接（403）
    Denied,
    /// 文件/目录不存在，或末端不是普通文件（404）
    NotFound,
}

/// 扫描器与读写接口共用的保留目录规则。
pub fn is_reserved_component(name: &str) -> bool {
    name == cache_paths::STATE_DIR_NAME || name == TRASH_DIR_NAME || name.starts_with('@')
}

/// 用户可寻址的相对路径：全部是普通组件，且不触碰保留目录。
pub fn is_user_rel_path(p: &str) -> bool {
    if p.is_empty() {
        return false;
    }
    let mut has_component = false;
    for component in Path::new(p).components() {
        match component {
            Component::Normal(name) => {
                if is_reserved_component(&name.to_string_lossy()) {
                    return false;
                }
                has_component = true;
            }
            _ => return false,
        }
    }
    has_component
}

/// 回收站里的名字：只允许 `.trash/<单层名字>`，且不能是隐藏文件（含 manifest）。
pub fn trash_name_from_src(src: &str) -> Option<&str> {
    let mut components = Path::new(src).components();
    match components.next() {
        Some(Component::Normal(dir)) if dir == TRASH_DIR_NAME => {}
        _ => return None,
    }
    let name = match components.next() {
        Some(Component::Normal(name)) => name.to_str()?,
        _ => return None,
    };
    if components.next().is_some() || name.is_empty() || name.starts_with('.') {
        return None;
    }
    Some(name)
}

fn map_io_error(error: &std::io::Error) -> PathError {
    match error.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => PathError::NotFound,
        _ => PathError::Denied,
    }
}

async fn canonical_root(root: &Path) -> Result<PathBuf, PathError> {
    fs::canonicalize(root).await.map_err(|e| map_io_error(&e))
}

async fn canonical_parent_within(root: &Path, parent: &Path) -> Result<(), PathError> {
    let root = canonical_root(root).await?;
    let parent = fs::canonicalize(parent).await.map_err(|e| map_io_error(&e))?;
    if parent.starts_with(&root) {
        Ok(())
    } else {
        Err(PathError::Denied)
    }
}

/// 把用户路径解析为照片库内的真实文件路径。只读接口与写操作共用同一套规则。
pub async fn resolve_user_file(root: &Path, rel: &str) -> Result<PathBuf, PathError> {
    if !is_user_rel_path(rel) {
        return Err(PathError::Invalid);
    }

    let components: Vec<&str> = rel.split('/').collect();
    let (name_last, parents) = components
        .split_last()
        .ok_or(PathError::Invalid)?;

    let mut current = root.to_path_buf();
    for component in parents {
        current.push(component);
        let metadata = fs::symlink_metadata(&current)
            .await
            .map_err(|e| map_io_error(&e))?;
        if metadata.file_type().is_symlink() {
            return Err(PathError::Denied);
        }
        if !metadata.is_dir() {
            return Err(PathError::NotFound);
        }
    }

    current.push(name_last);
    let metadata = fs::symlink_metadata(&current)
        .await
        .map_err(|e| map_io_error(&e))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(PathError::Denied);
    }

    if let Some(parent) = current.parent() {
        canonical_parent_within(root, parent).await?;
    }
    Ok(current)
}

/// 写目标的父目录检查：允许最后几层目录还不存在（执行时创建），但已存在的部分
/// 必须是真实目录，且 canonicalize 后仍在照片库根内。
pub async fn validate_destination(root: &Path, rel: &str) -> Result<(), PathError> {
    if !is_user_rel_path(rel) {
        return Err(PathError::Invalid);
    }

    let components: Vec<&str> = rel.split('/').collect();
    let Some((_name, parents)) = components.split_last() else {
        return Err(PathError::Invalid);
    };

    let mut current = root.to_path_buf();
    for component in parents {
        current.push(component);
        match fs::symlink_metadata(&current).await {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(PathError::Denied);
                }
                if !metadata.is_dir() {
                    return Err(PathError::NotFound);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // 这一层会被 create_dir_all 新建；更深的组件不可能已经存在
                return Ok(());
            }
            Err(e) => return Err(map_io_error(&e)),
        }
    }

    canonical_parent_within(root, &current).await
}

/// 回收站文件：名字必须是单层普通名字，文件必须是普通文件（不跟随链接）。
pub async fn resolve_trash_file(trash_dir: &Path, src: &str) -> Result<PathBuf, PathError> {
    let name = trash_name_from_src(src).ok_or(PathError::Invalid)?;
    let path = trash_dir.join(name);
    let metadata = fs::symlink_metadata(&path)
        .await
        .map_err(|e| map_io_error(&e))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(PathError::Denied);
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, remove_dir_all, write};
    use std::os::unix::fs::symlink;
    use uuid::Uuid;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("photo-viewer-paths-{}", Uuid::new_v4().simple()));
            create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = remove_dir_all(&self.0);
        }
    }

    #[test]
    fn user_paths_reject_reserved_and_escaping_forms() {
        assert!(is_user_rel_path("Alpha/a.jpg"));
        assert!(is_user_rel_path("A/B/c.jpg"));

        assert!(!is_user_rel_path(""));
        assert!(!is_user_rel_path("/etc/passwd"));
        assert!(!is_user_rel_path("../outside.jpg"));
        assert!(!is_user_rel_path("Alpha/../Beta/a.jpg"));
        assert!(!is_user_rel_path(".photo_viewer/meta.json"));
        assert!(!is_user_rel_path("Alpha/.photo_viewer/meta.json"));
        assert!(!is_user_rel_path(".trash/0123456789abcdef0123456789abcdef"));
        assert!(!is_user_rel_path("@eaDir/thumb.jpg"));
    }

    #[test]
    fn trash_names_must_be_one_plain_component() {
        let hex = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            trash_name_from_src(&format!(".trash/{hex}")),
            Some(hex)
        );
        assert_eq!(trash_name_from_src(".trash/.manifest.json"), None);
        assert_eq!(trash_name_from_src(".trash/a/b"), None);
        assert_eq!(trash_name_from_src(&format!("Photos/{hex}")), None);
        assert_eq!(trash_name_from_src(&format!("{hex}")), None);
    }

    #[tokio::test]
    async fn resolve_accepts_a_regular_nested_file() {
        let tmp = TempDir::new();
        create_dir_all(tmp.0.join("Alpha")).unwrap();
        write(tmp.0.join("Alpha/a.jpg"), "a").unwrap();

        let path = resolve_user_file(&tmp.0, "Alpha/a.jpg").await.unwrap();
        assert_eq!(path, tmp.0.join("Alpha/a.jpg"));
    }

    #[tokio::test]
    async fn resolve_refuses_symlinked_files_and_directories() {
        let tmp = TempDir::new();
        let outside = TempDir::new();
        write(outside.0.join("secret.jpg"), "secret").unwrap();
        symlink(outside.0.join("secret.jpg"), tmp.0.join("link.jpg")).unwrap();
        symlink(&outside.0, tmp.0.join("linkdir")).unwrap();

        assert_eq!(
            resolve_user_file(&tmp.0, "link.jpg").await.unwrap_err(),
            PathError::Denied
        );
        assert_eq!(
            resolve_user_file(&tmp.0, "linkdir/secret.jpg")
                .await
                .unwrap_err(),
            PathError::Denied
        );
    }

    #[tokio::test]
    async fn resolve_refuses_directories_and_missing_files() {
        let tmp = TempDir::new();
        create_dir_all(tmp.0.join("Alpha")).unwrap();

        assert_eq!(
            resolve_user_file(&tmp.0, "Alpha").await.unwrap_err(),
            PathError::Denied
        );
        assert_eq!(
            resolve_user_file(&tmp.0, "Alpha/gone.jpg").await.unwrap_err(),
            PathError::NotFound
        );
    }

    #[tokio::test]
    async fn missing_parents_are_fine_for_destinations_but_symlinks_are_not() {
        let tmp = TempDir::new();
        let outside = TempDir::new();
        symlink(&outside.0, tmp.0.join("linkdir")).unwrap();

        assert!(validate_destination(&tmp.0, "Alpha/Beta/new.jpg").await.is_ok());
        assert_eq!(
            validate_destination(&tmp.0, "linkdir/new.jpg").await.unwrap_err(),
            PathError::Denied
        );
        assert_eq!(
            validate_destination(&tmp.0, "../new.jpg").await.unwrap_err(),
            PathError::Invalid
        );
    }

    #[tokio::test]
    async fn trash_resolution_only_accepts_regular_files() {
        let tmp = TempDir::new();
        let trash = tmp.0.join(".trash");
        create_dir_all(&trash).unwrap();
        let hex = "0123456789abcdef0123456789abcdef";
        write(trash.join(hex), "bytes").unwrap();
        symlink(tmp.0.join("target"), trash.join("symlinked")).unwrap();

        assert!(resolve_trash_file(&trash, &format!(".trash/{hex}"))
            .await
            .is_ok());
        assert_eq!(
            resolve_trash_file(&trash, ".trash/symlinked")
                .await
                .unwrap_err(),
            PathError::Denied
        );
        assert_eq!(
            resolve_trash_file(&trash, ".trash/symlinked/../../x")
                .await
                .unwrap_err(),
            PathError::Invalid
        );
    }
}
