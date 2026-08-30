// 失去焦点自动缩小为小卡片：悬浮展开（不抢焦点）、点击后聚焦保持展开
import { useCallback, useEffect, useRef, useState } from "react";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Settings } from "./types";

export const WINDOW_SIZE = { w: 440, h: 740 }; // 默认全尺寸
export const MIN_WINDOW_SIZE = { w: 380, h: 520 }; // 手动调整窗口的最小尺寸
export const CARD_SIZE = { w: 172, h: 52 }; // 缩小卡片：紧凑显示“8月26日日程”

/** 用 rAF 驱动原生窗口尺寸，缓动曲线 easeOutCubic（非线性、流畅） */
async function animateResize(
  win: ReturnType<typeof getCurrentWindow>,
  to: { w: number; h: number },
  duration = 300
): Promise<void> {
  // 起点取当前视口尺寸（CSS px = 逻辑尺寸，与 setSize 语义一致）
  const from = { w: window.innerWidth, h: window.innerHeight };
  const t0 = performance.now();
  await new Promise<void>((resolve) => {
    const step = async (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      const e = 1 - Math.pow(1 - p, 3); // easeOutCubic
      try {
        await win.setSize(
          new LogicalSize(from.w + (to.w - from.w) * e, from.h + (to.h - from.h) * e)
        );
      } catch {
        /* ignore */
      }
      if (p < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

export interface ShrinkApi {
  cardMode: boolean;
  onCardEnter: () => void;
  onCardMouseDown: () => void;
}

/**
 * 缩小卡片控制。
 * @param enabled 仅当为 true 时允许失焦缩小（主页面启用；设置/历史页禁用）
 */
export function useShrink(settings: Settings, enabled: boolean): ShrinkApi {
  const [cardMode, setCardMode] = useState(false);
  const cardModeRef = useRef(false);
  cardModeRef.current = cardMode;

  const focusedRef = useRef(true);
  const hoverOpenRef = useRef(false);
  const busyRef = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // 记忆“完整尺寸”（用户手动调整后的尺寸），展开时恢复
  const fullSizeRef = useRef(WINDOW_SIZE);
  // 拖拽守卫：标题栏按下后短暂忽略 blur，避免移动窗口时误缩成卡片；
  // 窗口移动结束（onMoved）后立即清除，保证随后失焦缩小正常生效
  const lastDragPressRef = useRef(0);
  // resize 守卫：正在调整窗口大小时忽略 blur（系统边缘或右下角手柄拖动）
  const lastResizeRef = useRef(0);

  // 监听标题栏（data-tauri-drag-region）与缩放手柄（.resize-handle）按下
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest("[data-tauri-drag-region], .resize-handle")) {
        lastDragPressRef.current = Date.now();
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, []);

  // 窗口移动结束：清除拖拽守卫（之后失焦缩小立即生效）
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    win
      .onMoved(() => {
        lastDragPressRef.current = 0;
      })
      .then((u) => {
        unlisten = u;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, []);

  // 记录非卡片状态下的窗口尺寸（用户可自由调整大小），并记录最近 resize 时间
  useEffect(() => {
    const onResize = () => {
      if (cardModeRef.current) return;
      fullSizeRef.current = { w: window.innerWidth, h: window.innerHeight };
      lastResizeRef.current = Date.now();
    };
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const expand = useCallback(async (focusAfter: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const win = getCurrentWindow();
      // 先放大窗口，再切换内容，配合内容淡入动画
      await animateResize(win, fullSizeRef.current);
      cancelScheduledShrink();
      setCardMode(false);
      if (focusAfter) {
        try {
          await win.setFocus();
        } catch {
          /* ignore */
        }
      }
    } finally {
      busyRef.current = false;
    }
    // 注意：这里不清空 hoverOpenRef —— 由“获得焦点”事件负责，
    // 这样“悬浮展开但未点击”时鼠标移出窗口仍能触发再次缩小。
  }, []);

  const shrink = useCallback(async () => {
    if (busyRef.current) return;
    const win = getCurrentWindow();
    try {
      if (await win.isMinimized()) return; // 最小化时不缩小
    } catch {
      /* ignore */
    }
    busyRef.current = true;
    try {
      // 先切换为卡片内容，再缩小窗口
      setCardMode(true);
      await animateResize(win, CARD_SIZE);
    } finally {
      busyRef.current = false;
    }
  }, []);

  // 延迟确认缩小：blur / 鼠标移出后不立即缩小，
  // 给“移向窗口边缘调整大小”等操作留出时间；期间发生 resize 或重新聚焦则取消
  const shrinkTimerRef = useRef<number | null>(null);
  const cancelScheduledShrink = useCallback(() => {
    if (shrinkTimerRef.current !== null) {
      clearTimeout(shrinkTimerRef.current);
      shrinkTimerRef.current = null;
    }
  }, []);
  const scheduleShrink = useCallback(
    (delay: number) => {
      cancelScheduledShrink();
      shrinkTimerRef.current = window.setTimeout(() => {
        shrinkTimerRef.current = null;
        // 二次确认：延迟期间窗口被调整过（resize）或已重新聚焦 -> 取消缩小
        if (Date.now() - lastResizeRef.current < 300) return;
        if (focusedRef.current) return;
        shrink();
      }, delay);
    },
    [cancelScheduledShrink, shrink]
  );
  const isResizingOrDragging = useCallback(
    () =>
      Date.now() - lastResizeRef.current < 1000 ||
      Date.now() - lastDragPressRef.current < 2000,
    []
  );

  // 卸载时清理定时器
  useEffect(() => cancelScheduledShrink, [cancelScheduledShrink]);

  // 监听焦点变化
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    win
      .onFocusChanged(({ payload }) => {
        focusedRef.current = payload;
        const s = settingsRef.current;
        if (payload) {
          // 获得焦点 -> 结束“悬浮展开”状态，保持完整窗口
          hoverOpenRef.current = false;
          cancelScheduledShrink();
          if (cardModeRef.current) expand(false);
        } else {
          // 正在调整窗口大小 / 拖动窗口导致的 blur 不触发缩小
          if (isResizingOrDragging()) return;
          // 失去焦点 -> 延迟确认后缩小为卡片（开关开启且当前页面允许时）
          if (s.shrinkOnBlur && enabledRef.current && !cardModeRef.current) {
            scheduleShrink(500);
          }
        }
      })
      .then((u) => {
        unlisten = u;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, [expand, shrink, scheduleShrink, cancelScheduledShrink, isResizingOrDragging]);

  // 鼠标离开窗口：若处于“悬浮展开但未聚焦”状态，则延迟确认后再次缩小
  useEffect(() => {
    const onOut = (e: MouseEvent) => {
      if (e.relatedTarget) return; // 仍在窗口内移动
      if (cardModeRef.current) return; // 已经是卡片
      if (focusedRef.current) return; // 已聚焦则保持展开
      if (!hoverOpenRef.current) return;
      // 正在调整窗口大小 / 拖动窗口 -> 不移出即缩
      if (isResizingOrDragging()) return;
      // 延迟稍长：用户可能正把鼠标移向窗口边缘调整大小
      scheduleShrink(600);
    };
    document.addEventListener("mouseout", onOut);
    return () => document.removeEventListener("mouseout", onOut);
  }, [shrink, scheduleShrink, isResizingOrDragging]);

  // 开关关闭 / 进入无需缩小的页面时，若处于卡片状态则立即恢复
  useEffect(() => {
    if ((!settings.shrinkOnBlur || !enabled) && cardModeRef.current) expand(false);
  }, [settings.shrinkOnBlur, enabled, expand]);

  const onCardEnter = useCallback(() => {
    if (!cardModeRef.current) return;
    hoverOpenRef.current = true;
    if (busyRef.current) {
      // 收缩/展开动画进行中：动画结束后自动补展开（避免悬浮后无响应）
      setTimeout(() => {
        if (hoverOpenRef.current && cardModeRef.current) expand(false);
      }, 380);
      return;
    }
    expand(false); // 悬浮展开但不抢焦点
  }, [expand]);

  const onCardMouseDown = useCallback(() => {
    // 点击卡片 -> 聚焦本软件 -> 保持展开
    getCurrentWindow()
      .setFocus()
      .catch(() => {});
  }, []);

  return { cardMode, onCardEnter, onCardMouseDown };
}
