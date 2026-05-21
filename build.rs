use std::{env, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=.git/HEAD");
    println!("cargo:rerun-if-changed=.git/refs/heads");

    if let Ok(p) = env::var("DEFAULT_PHOTOS_DIR") {
        println!("cargo:rustc-env=DEFAULT_PHOTOS_DIR={}", p);
    }

    println!("cargo:rustc-env=PHOTO_VIEWER_VERSION={}", build_version());
}

fn build_version() -> String {
    let date = build_date().unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    match git_short_sha() {
        Some(sha) => format!("{date}+{sha}"),
        None => date,
    }
}

fn build_date() -> Option<String> {
    let output = Command::new("date").arg("+%Y.%m.%d").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8(output.stdout).ok()?;
    let parts: Vec<String> = raw
        .trim()
        .split('.')
        .map(|part| {
            part.parse::<u32>()
                .map(|n| n.to_string())
                .unwrap_or_else(|_| part.to_string())
        })
        .collect();
    if parts.len() == 3 {
        Some(parts.join("."))
    } else {
        None
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
