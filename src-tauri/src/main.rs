// 可执行入口：Windows 下隐藏控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    planer_lib::run()
}
