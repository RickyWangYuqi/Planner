// 把设置项同步到 Rust 原生层
import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Settings } from "./types";
import { setCloseAction, setFullscreenAutoHide, setLaunchAtStartup } from "./lib/storage";

export function useWindowBehaviors(settings: Settings) {
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // 窗口置顶：设置变化时应用；获得焦点时重试一次（避免启动早期 IPC 未就绪导致置顶丢失）
  useEffect(() => {
    const apply = () => {
      getCurrentWindow()
        .setAlwaysOnTop(settings.alwaysOnTop)
        .catch(() => {});
    };
    apply();
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    win
      .onFocusChanged(() => apply())
      .then((u) => {
        unlisten = u;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, [settings.alwaysOnTop]);

  // 关闭行为（Rust 端在 CloseRequested 时判断）
  useEffect(() => {
    setCloseAction(settings.closeAction);
  }, [settings.closeAction]);

  // 全屏自动隐藏（Rust 端轮询前台窗口）
  useEffect(() => {
    setFullscreenAutoHide(settings.autoHideFullscreen);
  }, [settings.autoHideFullscreen]);

  // 开机启动：只在开关变化时调用（启动时跳过初始同步，避免首次运行就执行 reg.exe 阻塞 UI）
  const prevLaunch = useRef(settings.launchAtStartup);
  useEffect(() => {
    if (prevLaunch.current === settings.launchAtStartup) return;
    prevLaunch.current = settings.launchAtStartup;
    setLaunchAtStartup(settings.launchAtStartup);
  }, [settings.launchAtStartup]);
}
