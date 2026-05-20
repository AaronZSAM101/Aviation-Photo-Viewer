#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, WindowUrl};
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::async_runtime::block_on;

struct BackendChild(Mutex<Option<Child>>);

#[tauri::command]
fn select_photos_dir() -> Option<String> {
    // 使用阻塞对话框以便立即返回结果给前端
    match tauri::api::dialog::blocking::FileDialogBuilder::new().pick_folder() {
        Some(path_buf) => path_buf.to_str().map(|s| s.to_string()),
        None => None,
    }
}

fn main() {
    let context = tauri::generate_context!();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![select_photos_dir])
        .manage(BackendChild(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle();
            // 尝试在 src-tauri 的父目录 target/release 启动后端二进制
            let backend_path = std::path::Path::new("../target/release/photo-viewer");
            if backend_path.exists() {
                match Command::new(backend_path).env("PORT", "3003").spawn() {
                    Ok(child) => {
                        let state = app.state::<BackendChild>();
                        let mut g = state.0.lock().unwrap();
                        *g = Some(child);
                    }
                    Err(e) => {
                        eprintln!("Failed to spawn backend: {}", e);
                    }
                }
            }

            // 在应用退出时确保子进程被杀死
            let state = app.state::<BackendChild>().0.clone();
            app.on_window_event(move |event| {
                use tauri::WindowEvent;
                if let WindowEvent::CloseRequested { .. } = event.event() {
                    if let Ok(mut g) = state.lock() {
                        if let Some(mut c) = g.take() {
                            let _ = c.kill();
                        }
                    }
                }
            });

            let _ = app.get_window("main");
            Ok(())
        })
        .run(context)
        .expect("error while running tauri application");
}
