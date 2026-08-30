import { invoke } from "@tauri-apps/api/core";
import type { AppData } from "../types";

/** 从本地数据文件读取（不存在时返回 null） */
export async function loadData(): Promise<AppData | null> {
  try {
    const raw = await invoke<AppData | null>("load_data");
    return raw;
  } catch (e) {
    console.error("load_data failed:", e);
    return null;
  }
}

/** 写入本地数据文件（自动保存） */
export function saveData(data: AppData): void {
  invoke("save_data", { data }).catch((e) => console.error("save_data failed:", e));
}

/** 通知 Rust 端“关闭窗口行为” */
export function setCloseAction(action: string): void {
  invoke("set_close_action", { action }).catch(() => {});
}

/** 通知 Rust 端“全屏自动隐藏”开关 */
export function setFullscreenAutoHide(enabled: boolean): void {
  invoke("set_fullscreen_auto_hide", { enabled }).catch(() => {});
}

/** 设置/取消开机启动 */
export function setLaunchAtStartup(enabled: boolean): void {
  invoke("set_launch_at_startup", { enabled }).catch((e) =>
    console.error("set_launch_at_startup failed:", e)
  );
}
