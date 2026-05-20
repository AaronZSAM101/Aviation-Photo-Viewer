use std::env;

fn main() {
    if let Ok(p) = env::var("DEFAULT_PHOTOS_DIR") {
        println!("cargo:rustc-env=DEFAULT_PHOTOS_DIR={}", p);
    }
}
