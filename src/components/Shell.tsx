// 应用外壳：标题栏 + 页面切换（左右滑动动画）+ 缩小卡片 + 窗口缩放手柄
import React, { useCallback, useEffect, useRef, useState } from "react";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useApp } from "../store";
import { MIN_WINDOW_SIZE, useShrink } from "../useShrink";import { formatCard } from "../lib/dates";
import { resolveTheme } from "../lib/themes";
import { MainPage } from "./MainPage";
import { SettingsPage } from "./SettingsPage";
import { HistoryPage } from "./HistoryPage";
import { ToastHost } from "./ui";
import { IconClose, IconMinus, IconPin } from "./icons";

type Page = "main" | "settings" | "history";

const DEPTH: Record<Page, number> = { main: 0, settings: 1, history: 2 };
const SLIDE_MS = 300;

export function Shell() {
  const { state, dispatch } = useApp();
  const [page, setPage] = useState<Page>("main");
  // 当前展示的页面与进入方向：1 = 进入更深层（从右滑入），-1 = 返回（从左滑入）
  const [nav, setNav] = useState<{ page: Page; dir: 1 | -1 }>({ page: "main", dir: 1 });
  // 滑动动画是否已结束（结束后清除动画 class，避免卡片展开时误触发滑动）
  const [animDone, setAnimDone] = useState(false);
  // 正在退场的旧页面（动画结束后移除）
  const [leaving, setLeaving] = useState<{ page: Page; dir: 1 | -1 } | null>(null);
  // 每个页面的滚动位置（切换后恢复，避免回到顶部）
  const scrollPos = useRef<Partial<Record<Page, number>>>({});
  // 缩小功能只在主页面启用（设置/历史页不缩小）
  const shrink = useShrink(state.settings, page === "main");

  // 主题：根据设置应用配色预设与浅/深色
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const theme = resolveTheme(state.settings.themeMode, mq.matches);
      const root = document.documentElement;
      root.dataset.theme = theme;
      root.dataset.preset = state.settings.colorPreset;
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [state.settings.themeMode, state.settings.colorPreset]);

  const navigate = useCallback(
    (next: Page) => {
      if (next === page) return;
      setPage(next);
      setAnimDone(false); // 重新启用滑动动画
      const dir: 1 | -1 = DEPTH[next] >= DEPTH[page] ? 1 : -1;
      setLeaving({ page, dir });
      setNav({ page: next, dir });
    },
    [page]
  );

  // 滑动动画结束后清除动画 class（后续重渲染不再触发）
  useEffect(() => {
    if (animDone) return;
    const t = setTimeout(() => setAnimDone(true), SLIDE_MS);
    return () => clearTimeout(t);
  }, [animDone, nav.page]);

  // 退场动画结束后移除旧页面
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => setLeaving(null), SLIDE_MS);
    return () => clearTimeout(t);
  }, [leaving]);

  const renderPage = (p: Page, key: string, extraClass = "") => (
    <div
      key={key}
      className={`page-slot ${extraClass}`}
      onScroll={(e) => {
        scrollPos.current[p] = e.currentTarget.scrollTop;
      }}
      ref={(el) => {
        // 仅在新挂载时恢复滚动位置（避免每次渲染重置）
        if (el && !el.dataset.scrollRestored) {
          el.dataset.scrollRestored = "1";
          el.scrollTop = scrollPos.current[p] ?? 0;
        }
      }}
    >
      {p === "main" && <MainPage onOpenSettings={() => navigate("settings")} />}
      {p === "settings" && (
        <SettingsPage onBack={() => navigate("main")} onOpenHistory={() => navigate("history")} />
      )}
      {p === "history" && <HistoryPage onBack={() => navigate("settings")} />}
    </div>
  );

  const win = getCurrentWindow();
  const togglePin = () =>
    dispatch({ type: "SET_SETTINGS", patch: { alwaysOnTop: !state.settings.alwaysOnTop } });

  // 缩放手柄：拖动调整窗口大小（起始尺寸直接取视口 CSS px，无需额外权限）
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX;
    const sy = e.clientY;
    const sw = window.innerWidth;
    const sh = window.innerHeight;
    const onMove = (ev: PointerEvent) => {
      const w = Math.max(MIN_WINDOW_SIZE.w, sw + (ev.clientX - sx));
      const h = Math.max(MIN_WINDOW_SIZE.h, sh + (ev.clientY - sy));
      win
        .setSize(new LogicalSize(Math.round(w), Math.round(h)))
        .catch(() => {});
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const navClass = !animDone ? (nav.dir === 1 ? "slide-in-right" : "slide-in-left") : "";

  return (
    <div className={`app-root ${shrink.cardMode ? "card-mode" : ""}`}>
      {/* 自定义标题栏（可拖动） */}
      <div className="titlebar" data-tauri-drag-region>
        <span className="titlebar-dot" data-tauri-drag-region />
        <span className="titlebar-title" data-tauri-drag-region>
          Planer 日程便签
        </span>
        <span className="spacer" data-tauri-drag-region />
        <button
          type="button"
          className={`tbtn ${state.settings.alwaysOnTop ? "active" : ""}`}
          onClick={togglePin}
          title={state.settings.alwaysOnTop ? "取消置顶" : "窗口置顶"}
        >
          <IconPin size={14} />
        </button>
        <button type="button" className="tbtn" onClick={() => win.minimize()} title="最小化">
          <IconMinus size={14} />
        </button>
        <button type="button" className="tbtn close" onClick={() => win.close()} title="关闭">
          <IconClose size={14} />
        </button>
      </div>

      {/* 页面舞台：左右滑动过渡（页面始终挂载，卡片模式仅隐藏） */}
      <div className="content">
        {leaving &&
          renderPage(
            leaving.page,
            `leaving-${leaving.page}`,
            leaving.dir === 1 ? "slide-out-left" : "slide-out-right"
          )}
        {renderPage(nav.page, `nav-${nav.page}`, navClass)}
      </div>

      {/* 右下角缩放手柄 */}
      <div className="resize-handle" onPointerDown={startResize} title="拖动调整窗口大小" />

      {/* 缩小卡片（覆盖在隐藏的界面之上） */}
      {shrink.cardMode && (
        <div
          className="card-view"
          onMouseEnter={shrink.onCardEnter}
          onMouseDown={shrink.onCardMouseDown}
        >
          <span className="card-dot" />
          <span className="card-text">{formatCard(state.currentDate)}</span>
        </div>
      )}

      <ToastHost />
    </div>
  );
}
