// 通用 UI 组件：开关、分段选择、模态框、确认框、Toast、日期选择器
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addDays, compareKeys, formatMonthDay, fromKey, toKey, todayKey } from "../lib/dates";
import { setToastListener, type ToastMsg } from "../toast";
import { IconBack, IconCheck } from "./icons";

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
