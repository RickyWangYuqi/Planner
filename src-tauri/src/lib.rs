//! Planer 日程便签 · Rust 后端入口
//! 职责：数据文件读写、系统托盘、全屏检测轮询、开机启动、关闭行为控制

mod fullscreen;

use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WindowEvent};

/// 由前端同步过来的原生层状态
struct AppState {
    close_action: Mutex<String>,       // "exit" | "tray"
    fullscreen_auto_hide: Mutex<bool>, // 全屏自动隐藏开关
    fullscreen_now: Mutex<bool>,       // 当前是否处于全屏（用于状态变化检测）
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            close_action: Mutex::new("exit".into()),
            fullscreen_auto_hide: Mutex::new(false),
            fullscreen_now: Mutex::new(false),
        }
    }
}

// ---------------- 数据读写 ----------------

fn data_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("data.json"))
}

#[tauri::command]
async fn load_data(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = data_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<serde_json::Value>, String> {
        if !path.exists() {
            return Ok(None);
        }
        let s = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let v = serde_json::from_str(&s).map_err(|e| e.to_string())?;
        Ok(Some(v))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_data(app: AppHandle, data: serde_json::Value) -> Result<(), String> {
    let path = data_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let s = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
        std::fs::write(&path, s).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------- 设置同步 ----------------

#[tauri::command]
fn set_close_action(state: State<AppState>, action: String) {
    *state.close_action.lock().unwrap() = action;
}

#[tauri::command]
fn set_fullscreen_auto_hide(state: State<AppState>, enabled: bool) {
    *state.fullscreen_auto_hide.lock().unwrap() = enabled;
}

/// 开机启动：写入/删除 HKCU Run 键
/// （异步 + spawn_blocking：reg.exe 可能在主线程上阻塞事件循环导致 UI 卡死）
#[tauri::command]
async fn set_launch_at_startup(enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || run_reg(enabled))
        .await
        .map_err(|e| e.to_string())?
}

fn run_reg(enabled: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    let name = "Planer日程便签";
    let (args, action) = if enabled {
        let cmd = format!("\"{}\" --hidden", exe.display());
        (
            vec![
                "add".to_string(),
                key.to_string(),
                "/v".to_string(),
                name.to_string(),
                "/t".to_string(),
                "REG_SZ".to_string(),
                "/d".to_string(),
                cmd,
                "/f".to_string(),
            ],
            "写入",
        )
    } else {
        (
            vec![
                "delete".to_string(),
                key.to_string(),
                "/v".to_string(),
                name.to_string(),
                "/f".to_string(),
            ],
            "删除",
        )
    };
    let out = std::process::Command::new("reg")
        .args(&args)
        .output()
        .map_err(|e| format!("reg 命令无法执行（{}）：{e}", action))?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let msg = if msg.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            msg
        };
        return Err(format!("{action}开机启动失败：{msg}"));
    }
    Ok(())
}

// ---------------- 系统托盘 ----------------

fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn hide_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "隐藏窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出程序", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?;

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("Planer 日程便签")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "hide" => hide_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击托盘图标：显示/隐藏主窗口
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(win) = app.get_webview_window("main") {
                    if win.is_visible().unwrap_or(false) {
                        let _ = win.hide();
                    } else {
                        show_main(app);
                    }
                }
            }
        })
        .build(app)?;
    Ok(())
}

// ---------------- 全屏检测轮询 ----------------

fn start_fullscreen_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        let enabled = *app.state::<AppState>().fullscreen_auto_hide.lock().unwrap();
        if enabled {
            let now = fullscreen::is_foreground_fullscreen();
            let prev = *app.state::<AppState>().fullscreen_now.lock().unwrap();
            if now != prev {
                *app.state::<AppState>().fullscreen_now.lock().unwrap() = now;
                if let Some(win) = app.get_webview_window("main") {
                    if now {
                        let _ = win.hide(); // 进入全屏 -> 隐藏
                    } else {
                        let _ = win.show(); // 退出全屏 -> 恢复
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(1000));
    });
}

// ---------------- 应用装配 ----------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 重复启动时聚焦已有实例
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            load_data,
            save_data,
            set_close_action,
            set_fullscreen_auto_hide,
            set_launch_at_startup
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            setup_tray(&handle)?;
            start_fullscreen_poller(handle);

            // 开机启动带 --hidden：直接最小化到托盘
            if std::env::args().any(|a| a == "--hidden") {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.app_handle().state::<AppState>();
                let action = state.close_action.lock().unwrap().clone();
                if action == "tray" {
                    // 最小化到系统托盘：拦截关闭，改为隐藏
                    api.prevent_close();
                    let _ = window.hide();
                }
                // "exit"：放行关闭，直接退出
            }
        })
        .build(tauri::generate_context!())
        .expect("Planer 启动失败")
        .run(|_app_handle, _event| {});
}
