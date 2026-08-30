//! 全屏检测：通过 Win32 API 判断前台窗口是否铺满其所在显示器
use std::mem::size_of;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, HMONITOR, MONITORINFO, MONITOR_DEFAULTTOPRIMARY,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowRect, IsWindowVisible};

/// 前台窗口是否处于全屏状态（矩形覆盖显示器，容差 8px）
pub fn is_foreground_fullscreen() -> bool {
    unsafe {
        let hwnd: HWND = GetForegroundWindow();
        if hwnd.0.is_null() {
            return false;
        }
        if !IsWindowVisible(hwnd).as_bool() {
            return false;
        }
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return false;
        }
        let monitor: HMONITOR = MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY);
        let mut mi = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut mi).as_bool() {
            return false;
        }
        let m = mi.rcMonitor;
        let tol = 8i32;
        rect.left <= m.left + tol
            && rect.top <= m.top + tol
            && rect.right >= m.right - tol
            && rect.bottom >= m.bottom - tol
    }
}
