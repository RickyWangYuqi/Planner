// 通用 UI 组件：开关、分段选择、模态框、确认框、Toast、日期选择器
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { addDays, compareKeys, formatMonthDay, fromKey, toKey, todayKey } from "../lib/dates";
import { setToastListener, type ToastMsg } from "../toast";
import { IconBack, IconCheck, IconClose, IconPlus } from "./icons";

/* ---------------- 开关 ---------------- */
export function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      className={`switch ${checked ? "on" : ""}`}
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}

export function SwitchRow({
  title,
  desc,
  checked,
  onChange,
}: {
  title: string;
  desc?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="switch-row">
      <div className="switch-row-text">
        <div className="switch-row-title">{title}</div>
        {desc ? <div className="switch-row-desc">{desc}</div> : null}
      </div>
      <Switch checked={checked} onChange={onChange} />
    </div>
  );
}

/* ---------------- 分组选择（新增和编辑日程共用） ---------------- */
export function GroupPicker({
  value,
  groups,
  onChange,
  onDelete,
}: {
  value: string | null;
  groups: string[];
  onChange: (g: string | null) => void;
  onDelete: (g: string) => void;
}) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createMounted, setCreateMounted] = useState(false);
  const [draftGroups, setDraftGroups] = useState<string[]>([]);
  const [createdGroup, setCreatedGroup] = useState<string | null>(null);
  const [deleteMode, setDeleteMode] = useState<string | null>(null);
  const [exiting, setExiting] = useState<{ name: string; index: number } | null>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const chipRefs = useRef(new Map<string | null, HTMLButtonElement>());
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);
  const createCloseTimer = useRef<number | null>(null);
  const pressRef = useRef<{ timer: number; group: string; x: number; y: number; pointerId: number } | null>(null);
  const suppressClick = useRef<string | null>(null);
  const removalTimer = useRef<number | null>(null);
  const animations = useRef(new Set<Animation>());
  const beforeChipsLayout = useRef<{ height: number; positions: Map<HTMLElement, { x: number; y: number }> } | null>(null);
  // 新建分组先保留在当前表单中，立即可见、可重选，随日程提交后才保存。
  const options = [...new Set([...groups, ...draftGroups, ...(value ? [value] : [])])];
  // 数据先删除，原标签仅留作退场；取消或保存窗口不会中断已经确认的删除。
  if (exiting) {
    const index = options.indexOf(exiting.name);
    if (index >= 0) options.splice(index, 1);
    options.splice(exiting.index, 0, exiting.name);
  }
  const trimmedName = name.trim();
  const exists = options.includes(trimmedName);
  const cancelPress = useCallback(() => {
    if (pressRef.current) window.clearTimeout(pressRef.current.timer);
    pressRef.current = null;
  }, []);
  useEffect(() => {
    const blur = () => { cancelPress(); setDeleteMode(null); };
    window.addEventListener("pointerup", cancelPress);
    window.addEventListener("pointercancel", blur);
    window.addEventListener("blur", blur);
    return () => {
      cancelPress();
      if (removalTimer.current !== null) window.clearTimeout(removalTimer.current);
      if (createCloseTimer.current !== null) window.clearTimeout(createCloseTimer.current);
      for (const animation of animations.current) animation.cancel();
      window.removeEventListener("pointerup", cancelPress);
      window.removeEventListener("pointercancel", blur);
      window.removeEventListener("blur", blur);
    };
  }, [cancelPress]);
  useEffect(() => {
    if (deleteMode === null) return;
    const outside = (e: PointerEvent) => {
      const chip = chipRefs.current.get(deleteMode)?.parentElement;
      if (!chip?.contains(e.target as Node)) setDeleteMode(null);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") { cancelPress(); setDeleteMode(null); }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
    };
  }, [deleteMode, cancelPress]);
  // 创建区保留到收起动画结束；快速重新展开时取消卸载，过渡从当前位置续接。
  useEffect(() => {
    if (createCloseTimer.current !== null) window.clearTimeout(createCloseTimer.current);
    if (!creating && createMounted) {
      createCloseTimer.current = window.setTimeout(() => {
        createCloseTimer.current = null;
        setCreateMounted(false);
        setName("");
      }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 240);
    }
    return () => {
      if (createCloseTimer.current !== null) window.clearTimeout(createCloseTimer.current);
    };
  }, [creating, createMounted]);
  useLayoutEffect(() => {
    if (creating) createInputRef.current?.focus({ preventScroll: true });
  }, [creating]);
  const captureChipsLayout = () => {
    const list = chipsRef.current;
    if (!list) return;
    const rect = list.getBoundingClientRect();
    beforeChipsLayout.current = {
      height: rect.height,
      positions: new Map((Array.from(list.children) as HTMLElement[]).map((el) => {
        const r = el.getBoundingClientRect();
        return [el, { x: r.left - rect.left + list.scrollLeft, y: r.top - rect.top + list.scrollTop }];
      })),
    };
    // 连续增删从当前可见位置续接，避免旧动画与下一次补位叠加。
    for (const animation of animations.current) animation.cancel();
    animations.current.clear();
  };
  useLayoutEffect(() => {
    const before = beforeChipsLayout.current;
    beforeChipsLayout.current = null;
    const list = chipsRef.current;
    if (!before || !list || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animate = (el: HTMLElement, frames: Keyframe[]) => {
      const animation = el.animate(frames, { duration: 260, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
      animations.current.add(animation);
      animation.onfinish = () => animations.current.delete(animation);
    };
    for (const child of Array.from(list.children) as HTMLElement[]) {
      const old = before.positions.get(child);
      if (!old) {
        animate(child, [
          { opacity: 0, scale: "0.75", translate: "0 5px" },
          { opacity: 1, scale: "1", translate: "0 0" },
        ]);
        continue;
      }
      const dx = old.x - child.offsetLeft, dy = old.y - child.offsetTop;
      if (dx || dy) animate(child, [{ translate: `${dx}px ${dy}px` }, { translate: "0 0" }]);
    }
    const height = list.offsetHeight;
    if (height !== before.height) animate(list, [{ height: `${before.height}px` }, { height: `${height}px` }]);
  });
  const startPress = (e: React.PointerEvent<HTMLButtonElement>, group: string | null) => {
    cancelPress();
    suppressClick.current = null;
    if (group === null || exiting || e.button !== 0 || !e.isPrimary) return;
    pressRef.current = {
      group, x: e.clientX, y: e.clientY, pointerId: e.pointerId,
      timer: window.setTimeout(() => {
        suppressClick.current = group;
        setDeleteMode(group);
        pressRef.current = null;
      }, 520),
    };
  };
  const remove = (group: string) => {
    if (removalTimer.current !== null) return;
    cancelPress();
    setExiting({ name: group, index: options.indexOf(group) });
    setDeleteMode(null);
    setDraftGroups((prev) => prev.filter((g) => g !== group));
    if (createdGroup === group) setCreatedGroup(null);
    if (value === group) onChange(null);
    if (groups.includes(group)) onDelete(group);
    chipRefs.current.get(value === group ? null : value)?.focus({ preventScroll: true });
    removalTimer.current = window.setTimeout(() => {
      captureChipsLayout();
      removalTimer.current = null;
      setExiting(null);
    }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180);
  };
  const select = (group: string | null) => {
    setDeleteMode(null);
    setCreatedGroup(null);
    onChange(group);
  };
  const cancelCreate = () => {
    setCreating(false);
    createButtonRef.current?.focus({ preventScroll: true });
  };
  const openCreate = () => {
    if (creating) return;
    if (createCloseTimer.current !== null) window.clearTimeout(createCloseTimer.current);
    setName("");
    setCreateMounted(true);
    setCreating(true);
  };
  const create = () => {
    const n = trimmedName;
    if (!creating || !n || exiting?.name === n) return;
    if (!exists) {
      captureChipsLayout();
      setDraftGroups((prev) => [...prev, n]);
    }
    setCreatedGroup(exists ? null : n);
    onChange(n);
    setCreating(false);
    requestAnimationFrame(() => chipRefs.current.get(n)?.focus({ preventScroll: true }));
  };
  return (
    <div className="group-picker">
      <div className="group-chips" ref={chipsRef} role="group" aria-label="日程分组" onScroll={cancelPress}>
        {[null, ...options].map((g) => (
          <span
            key={g === null ? "ungrouped" : `group:${g}`}
            className={`group-chip-wrap ${g !== null && deleteMode === g ? "is-delete-mode" : ""} ${exiting?.name === g ? "is-removing" : ""}`}
          >
            <button
              ref={(el) => { if (el) chipRefs.current.set(g, el); else chipRefs.current.delete(g); }}
              type="button"
              className={`mini-chip group-chip ${value === g ? "active" : ""}`}
              aria-pressed={value === g}
              disabled={exiting?.name === g}
              title={g !== null ? "长按可删除分组" : undefined}
              onPointerDown={(e) => startPress(e, g)}
              onPointerMove={(e) => {
                const press = pressRef.current;
                if (press && press.pointerId === e.pointerId && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) {
                  suppressClick.current = press.group;
                  cancelPress();
                }
              }}
              onPointerLeave={() => {
                if (pressRef.current) suppressClick.current = pressRef.current.group;
                cancelPress();
              }}
              onContextMenu={(e) => e.preventDefault()}
              onKeyDown={(e) => {
                if (g !== null && !exiting && (e.key === "Delete" || e.key === "Backspace")) {
                  e.preventDefault(); setDeleteMode(g);
                }
              }}
              onClick={() => {
                if (g !== null && suppressClick.current === g) { suppressClick.current = null; return; }
                if (g !== null && deleteMode === g) { setDeleteMode(null); return; }
                select(value === g ? null : g);
              }}
            >
              <span>{g ?? "未分组"}</span>
            </button>
            {g !== null && deleteMode === g && (
              <button type="button" className="group-chip-delete" aria-label={`删除分组“${g}”`} onClick={() => remove(g)}>
                <IconClose size={11} />
              </button>
            )}
          </span>
        ))}
        <button
          ref={createButtonRef}
          type="button"
          className="group-new-btn"
          aria-expanded={creating}
          onClick={openCreate}
        >
          <IconPlus size={13} />新建分组
        </button>
      </div>
      <div className={`group-create-shell ${creating ? "open" : ""}`} aria-hidden={!creating}>
        <div className="group-create-clip">
          {createMounted && (
            <div className="group-create">
              <input
                ref={createInputRef}
                className="input group-input"
                value={name}
                disabled={!creating}
                aria-label="新分组名称"
                placeholder="分组名称"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (!creating || e.nativeEvent.isComposing) return;
                  if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); create(); }
                  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelCreate(); }
                }}
              />
              <button type="button" className="btn soft" disabled={!creating || !trimmedName || exiting?.name === trimmedName} onClick={create}>
                {exists ? "选用分组" : "创建并选中"}
              </button>
              <button type="button" className="icon-btn" aria-label="取消新建分组" disabled={!creating} onClick={cancelCreate}>
                <IconClose size={14} />
              </button>
            </div>
          )}
        </div>
      </div>
      <div className={`group-selection ${value !== null ? "selected" : ""}`} role="status" aria-live="polite" aria-atomic="true">
        {deleteMode !== null ? (
          <span className="group-selection-copy">
            <span>点击右上角叉号删除“{deleteMode}”，组内日程会移入未分组。</span>
            <small>再次点击分组标签可取消删除</small>
          </span>
        ) : value !== null ? (
          <>
            <span className="group-selection-icon" aria-hidden="true"><IconCheck size={13} /></span>
            <span className="group-selection-copy">
              <span>{createdGroup === value ? "已创建并选中" : "已选分组"}：<strong>{value}</strong></span>
              <small>随日程一起保存</small>
            </span>
          </>
        ) : <span>当前未分组，可选择已有分组或新建</span>}
      </div>
    </div>
  );
}

/* ---------------- 分段选择 ---------------- */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`segmented-item ${value === o.value ? "active" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------- 模态框 ---------------- */

// 当前激活弹窗的关闭通道：Modal 挂载时注册，useModalClose() 读取。
// （组件自身渲染 <Modal> 时不在 Provider 子树内，用模块级单例最可靠；
//   应用同一时刻只会存在一个弹窗）
let activeRequestClose: (() => void) | null = null;

export function useModalClose(): () => void {
  return () => {
    activeRequestClose?.();
  };
}

const CLOSE_MS = 180;

export function Modal({
  title,
  children,
  onClose,
  width = 340,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  width?: number;
}) {
  const [closing, setClosing] = useState(false);
  const requestClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(onClose, CLOSE_MS); // 退出动画结束后卸载
  }, [closing, onClose]);

  // 注册为“当前激活弹窗”的关闭通道
  useEffect(() => {
    activeRequestClose = requestClose;
    return () => {
      if (activeRequestClose === requestClose) activeRequestClose = null;
    };
  }, [requestClose]);

  return (
    <div
      className={`modal-backdrop ${closing ? "closing" : ""}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        className={`modal-panel ${closing ? "closing" : ""}`}
        style={{ width, maxWidth: "calc(100vw - 40px)" }}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-title">{title}</div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmModal({
  title,
  message,
  confirmText = "确定",
  cancelText = "取消",
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const requestClose = useModalClose();
  return (
    <Modal title={title} onClose={onCancel}>
      <p className="confirm-message">{message}</p>
      <div className="modal-actions">
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            requestClose();
          }}
        >
          {cancelText}
        </button>
        <button
          type="button"
          className={`btn ${danger ? "danger" : "primary"}`}
          onClick={() => {
            onConfirm();
            requestClose();
          }}
        >
          {confirmText}
        </button>
      </div>
    </Modal>
  );
}

/* ---------------- Toast ---------------- */
export function ToastHost() {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  useEffect(() => {
    setToastListener((t) => {
      setToasts((prev) => [...prev.slice(-2), t]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== t.id));
      }, 2600);
    });
    return () => setToastListener(null);
  }, []);
  return (
    <div className="toast-wrap">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

/* ---------------- 日期选择器 ---------------- */
const WEEK = ["一", "二", "三", "四", "五", "六", "日"];

function buildMonthGrid(year: number, month: number): Array<Date | null> {
  // month: 0-11，返回 6x7 网格（周一开头）
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7; // 周一到周日
  const cells: Array<Date | null> = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function DatePicker({
  value,
  onChange,
  min,
  placeholder = "选择日期",
  marks,
  inline = false,
}: {
  value: string | null;
  onChange: (key: string) => void;
  min?: string | null;
  placeholder?: string;
  /** 需要打点标记的日期（例如有日程的日期） */
  marks?: Set<string>;
  /** 内联模式：直接显示日历，无需点击触发 */
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => (value ? fromKey(value) : new Date()));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const grid = useMemo(() => buildMonthGrid(view.getFullYear(), view.getMonth()), [view]);
  const today = todayKey();

  const prevMonth = () => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1));
  const nextMonth = () => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1));

  const pick = (d: Date) => {
    const key = toKey(d);
    if (min && compareKeys(key, min) < 0) return;
    onChange(key);
    setOpen(false);
  };

  const renderPopup = () => (
    <div className="dp-popup">
      <div className="dp-head">
        <button type="button" className="dp-nav" onClick={prevMonth} aria-label="上个月">
          ‹
        </button>
        <span className="dp-title">
          {view.getFullYear()} 年 {view.getMonth() + 1} 月
        </span>
        <button type="button" className="dp-nav" onClick={nextMonth} aria-label="下个月">
          ›
        </button>
      </div>
      <div className="dp-week">
        {WEEK.map((w) => (
          <span key={w} className="dp-weekday">
            {w}
          </span>
        ))}
      </div>
      <div className="dp-grid">
        {grid.map((d, i) => {
          if (!d) return <span key={i} className="dp-empty" />;
          const key = toKey(d);
          const disabled = !!min && compareKeys(key, min) < 0;
          const selected = key === value;
          const isToday = key === today;
          return (
            <button
              key={i}
              type="button"
              data-date={key}
              className={`dp-day ${selected ? "selected" : ""} ${isToday ? "today" : ""} ${
                disabled ? "disabled" : ""
              }`}
              disabled={disabled}
              onClick={() => pick(d)}
            >
              {d.getDate()}
              {marks?.has(key) && !disabled && <span className="dp-dot" />}
            </button>
          );
        })}
      </div>
    </div>
  );

  if (inline) {
    return <div className="datepicker inline">{renderPopup()}</div>;
  }

  return (
    <div className="datepicker" ref={ref}>
      <button
        type="button"
        className={`datepicker-trigger ${value ? "" : "empty"}`}
        onClick={() => setOpen((o) => !o)}
      >
        {value ? formatMonthDay(value) : placeholder}
      </button>
      {open && renderPopup()}
    </div>
  );
}

/* ---------------- 页面头部返回按钮 ---------------- */
export function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="back-btn" onClick={onClick}>
      <IconBack size={16} />
      返回
    </button>
  );
}

export { IconCheck };
