// 全局状态容器：加载、持久化、跨午夜滚动、窗口行为同步
import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { AppData } from "./types";
import { freshData, normalizeData } from "./lib/data";
import { loadData, saveData } from "./lib/storage";
import { reducer, type Action } from "./reducer";
import { todayKey } from "./lib/dates";
import { useWindowBehaviors } from "./useWindowBehaviors";

interface StoreCtx {
  state: AppData;
  dispatch: React.Dispatch<Action>;
  hydrated: boolean;
}

const Ctx = createContext<StoreCtx | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, freshData);
  const [hydrated, setHydrated] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  // 启动时从磁盘加载
  useEffect(() => {
    let cancelled = false;
    loadData().then((raw) => {
      if (cancelled) return;
      if (raw) dispatch({ type: "LOAD", data: normalizeData(raw) });
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 数据变更 -> 自动保存（防抖）
  useEffect(() => {
    if (!hydrated) return;
    const t = setTimeout(() => saveData(stateRef.current), 120);
    return () => clearTimeout(t);
  }, [state, hydrated]);

  // 窗口隐藏/退出前立即落盘，避免丢失最后一次变更
  useEffect(() => {
    if (!hydrated) return;
    const flush = () => saveData(stateRef.current);
    const onVis = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("beforeunload", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("beforeunload", flush);
    };
  }, [hydrated]);

  // 跨午夜 / 多日未打开时的日期追赶
  useEffect(() => {
    if (!hydrated) return;
    const check = () => {
      const s = stateRef.current;
      const today = todayKey();
      if (today > s.currentDate) {
        dispatch({ type: "ROLLOVER_TO", key: today });
      }
    };
    check();
    const iv = setInterval(check, 30000);
    return () => clearInterval(iv);
  }, [hydrated]);

  // 把设置同步到原生层（置顶/托盘/开机启动/全屏隐藏）
  useWindowBehaviors(state.settings);

  const value = useMemo<StoreCtx>(() => ({ state, dispatch, hydrated }), [state, hydrated]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): StoreCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp 必须在 AppProvider 内使用");
  return ctx;
}
