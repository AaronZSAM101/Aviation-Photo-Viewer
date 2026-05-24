use std::{env, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=.git/HEAD");
    println!("cargo:rerun-if-changed=.git/refs/heads");
    println!("cargo:rerun-if-env-changed=PHOTO_VIEWER_VERSION");
    println!("cargo:rerun-if-env-changed=PHOTO_VIEWER_VERSION_SOURCE");

    if let Ok(p) = env::var("DEFAULT_PHOTOS_DIR") {
        println!("cargo:rustc-env=DEFAULT_PHOTOS_DIR={}", p);
    }

    let (version, source) = build_version();
    println!("cargo:rustc-env=PHOTO_VIEWER_VERSION={}", version);
    println!("cargo:rustc-env=PHOTO_VIEWER_VERSION_SOURCE={}", source);
}

fn build_version() -> (String, String) {
    if let Ok(version) = env::var("PHOTO_VIEWER_VERSION") {
        let version = version.trim();
        if !version.is_empty() {
            return (version.to_string(), version_source("ghcr"));
        }
    }

    let timestamp = build_timestamp().unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    let version = match git_short_sha() {
        Some(sha) => format!("local-{timestamp}+{sha}"),
        None => format!("local-{timestamp}"),
    };
    (version, version_source("local"))
}

fn version_source(default: &str) -> String {
    match env::var("PHOTO_VIEWER_VERSION_SOURCE") {
        Ok(source) => {
            let source = source.trim();
            if source.is_empty() {
                default.to_string()
            } else {
                source.to_string()
            }
        }
        Err(_) => default.to_string(),
    }
}

fn build_timestamp() -> Option<String> {
    let output = Command::new("date").arg("+%Y%m%d-%H%M%S").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let timestamp = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if timestamp.is_empty() {
        None
    } else {
        Some(timestamp)
    }
}

fn git_short_sha() -> Option<String> {
    let output = Command::new("git")
        .args(["rev-parse", "--short=7", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let sha = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if sha.is_empty() {
        None
    } else {
        Some(sha)
    }
}
