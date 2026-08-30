// 日程条目组件：勾选、编辑、删除、长按拖动排序（含跨区域拖动）
import React, { useRef, useState } from "react";
import type { Task } from "../types";
import { useApp } from "../store";
import { addDays, compareKeys, formatMonthDay } from "../lib/dates";
import {
  autoScrollList,
  clearDropIndicator,
  computeDropTarget,
  showDropIndicator,
  type DropTarget,
} from "../drag";
import { showToast } from "../toast";
import { ConfirmModal, DatePicker, Modal, useModalClose } from "./ui";
import { IconCheck, IconPencil, IconPlus, IconTrash } from "./icons";
import { FUTURE_LIST_ID, TODAY_LIST_ID } from "../drag";

/** 记录两个列表中所有任务行的当前位置（用于 FLIP 重排动画） */
function captureRowPositions(): Map<string, number> {
  const map = new Map<string, number>();
  for (const id of [TODAY_LIST_ID, FUTURE_LIST_ID]) {
    const el = document.getElementById(id);
    if (!el) continue;
    for (const row of el.querySelectorAll<HTMLElement>("[data-task-row]")) {
      map.set(row.dataset.taskId ?? "", row.getBoundingClientRect().top);
    }
  }
  return map;
}

/** 重排后：让位置变化的行平滑滑入新位置（消除“瞬移感”） */
function applyFlip(prev: Map<string, number>) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      for (const id of [TODAY_LIST_ID, FUTURE_LIST_ID]) {
        const el = document.getElementById(id);
        if (!el) continue;
        for (const row of el.querySelectorAll<HTMLElement>("[data-task-row]")) {
          const oldTop = prev.get(row.dataset.taskId ?? "");
          if (oldTop === undefined) continue;
          const dy = oldTop - row.getBoundingClientRect().top;
          if (Math.abs(dy) > 0.5) {
            row.style.transition = "none";
            row.style.transform = `translateY(${dy}px)`;
            void row.getBoundingClientRect(); // 强制回流，让起始帧生效
            row.style.transition = "transform 0.28s var(--ease-spring)";
            row.style.transform = "";
            row.addEventListener(
              "transitionend",
              () => {
                row.style.transition = "";
              },
              { once: true }
            );
          }
        }
      }
    });
  });
}

export function TaskItem({
  task,
  section,
  index,
}: {
  task: Task;
  section: "today" | "future";
  index: number;
}) {
  const { state, dispatch } = useApp();
  const autoNumber = state.settings.autoNumber;
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pendingFuture, setPendingFuture] = useState<{ toIndex: number } | null>(null);

  const rowRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    x: number;
    y: number;
    moved: boolean;
    dragging: boolean;
    ghost: HTMLElement | null;
    offX: number;
    offY: number;
    target: DropTarget | null;
  } | null>(null);

  const startDrag = (e: PointerEvent) => {
    const el = rowRef.current;
    if (!el) return;
    document.body.classList.add("is-dragging");
    el.classList.add("dragging");
    const r = el.getBoundingClientRect();
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.classList.remove("dragging");
    ghost.classList.add("drag-ghost");
    ghost.style.width = `${r.width}px`;
    ghost.style.height = `${r.height}px`;
    document.body.appendChild(ghost);
    const ds = dragRef.current!;
    ds.ghost = ghost;
    ds.offX = e.clientX - r.left;
    ds.offY = e.clientY - r.top;
    moveGhost(e);
  };

  const moveGhost = (e: PointerEvent) => {
    const ds = dragRef.current;
    if (!ds?.ghost) return;
    ds.ghost.style.left = `${e.clientX - ds.offX}px`;
    ds.ghost.style.top = `${e.clientY - ds.offY}px`;
  };

  const onDragMove = (e: PointerEvent) => {
    const ds = dragRef.current;
    if (!ds) return;
    moveGhost(e);
    const target = computeDropTarget(e.clientX, e.clientY, task.id);
    ds.target = target;
    showDropIndicator(target, task.id);
    autoScrollList(e.clientX, e.clientY);
  };

  const finishDrag = (e: PointerEvent) => {
    const ds = dragRef.current;
    clearDropIndicator();
    document.body.classList.remove("is-dragging");
    if (ds?.ghost) ds.ghost.remove();
    rowRef.current?.classList.remove("dragging");
    const target = ds?.target ?? computeDropTarget(e.clientX, e.clientY, task.id);
    dragRef.current = null;
    if (!target) return;

    // 记录重排前各行的位置，用于落位动画
    const prev = captureRowPositions();

    if (target.list === section) {
      // 同区域排序
      if (target.index !== index) {
        dispatch({ type: "REORDER", section, from: index, to: target.index });
        applyFlip(prev);
      }
      return;
    }
    if (section === "today" && target.list === "future") {
      // 当日 -> 未来：弹窗设置截止日期（有隐藏截止时间则自动带出）
      setPendingFuture({ toIndex: target.index });
      return;
    }
    if (section === "future" && target.list === "today") {
      // 未来 -> 当日：保留截止日期（当日不显示）
      dispatch({ type: "MOVE_TASK", id: task.id, to: "today", toIndex: target.index });
      applyFlip(prev);
      showToast("已移动到当日日程");
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    const startX = e.clientX;
    const startY = e.clientY;
    dragRef.current = { x: startX, y: startY, moved: false, dragging: false, ghost: null, offX: 0, offY: 0, target: null };

    const onMove = (ev: PointerEvent) => {
      const ds = dragRef.current;
      if (!ds) return;
      const dx = ev.clientX - ds.x;
      const dy = ev.clientY - ds.y;
      if (!ds.dragging && Math.hypot(dx, dy) > 6) {
        ds.dragging = true;
        ds.moved = true;
        startDrag(ev);
      }
      if (ds.dragging) onDragMove(ev);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const ds = dragRef.current;
      if (ds?.dragging) {
        finishDrag(ev);
      }
      // 注：点击整行不再打开编辑弹窗，仅通过编辑按钮触发
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const toggleComplete = () => {
    if (section === "today") {
      dispatch({ type: "TOGGLE_TODAY", id: task.id });
    } else {
      dispatch({ type: "COMPLETE_FUTURE", id: task.id });
      showToast("已完成，已归档至历史日程");
    }
  };

  // 截止日期标签只在未来日程显示（拖入当日后作为隐藏截止时间，不展示）
  const dueChip = section === "future" && task.dueDate ? (
    <span
      className={`due-chip ${compareKeys(task.dueDate, state.currentDate) <= 0 ? "overdue" : ""}`}
    >
      {formatMonthDay(task.dueDate)}
    </span>
  ) : null;

  return (
    <>
      <div
        ref={rowRef}
        className={`task-row ${task.completed ? "done" : ""}`}
        data-task-row
        data-task-id={task.id}
        onPointerDown={onPointerDown}
      >
        <button
          type="button"
          className={`task-check ${task.completed ? "checked" : ""}`}
          data-no-drag
          onClick={toggleComplete}
          aria-label={task.completed ? "标记为未完成" : "标记为完成"}
        >
          {task.completed && <IconCheck size={13} />}
        </button>
        {autoNumber && <span className="task-num">{index + 1}</span>}
        <span className="task-text">{task.text}</span>
        {dueChip}
        <span className="task-actions" data-no-drag>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setEditing(true)}
            aria-label="编辑"
          >
            <IconPencil size={14} />
          </button>
          <button
            type="button"
            className="icon-btn danger"
            onClick={() => setConfirmDelete(true)}
            aria-label="删除"
          >
            <IconTrash size={14} />
          </button>
        </span>
      </div>

      {/* 编辑弹窗 */}
      {editing && (
        <EditTaskModal task={task} section={section} onClose={() => setEditing(false)} />
      )}

      {/* 删除确认 */}
      {confirmDelete && (
        <ConfirmModal
          title="删除日程"
          message={`确定要删除“${task.text}”吗？删除后不可恢复。`}
          confirmText="永久删除"
          danger
          onConfirm={() => {
            dispatch({ type: "DELETE_TASK", id: task.id });
            showToast("已删除", "info");
            // 弹窗由 requestClose 的退出动画后关闭（onClose -> setConfirmDelete(false)）
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      {/* 当日 -> 未来：设置截止日期 */}
      {pendingFuture && (
        <FutureDeadlineModal
          task={task}
          toIndex={pendingFuture.toIndex}
          onClose={() => setPendingFuture(null)}
        />
      )}
    </>
  );
}

/* ---------------- 编辑日程 ---------------- */
function EditTaskModal({
  task,
  section,
  onClose,
}: {
  task: Task;
  section: "today" | "future";
  onClose: () => void;
}) {
  const { state, dispatch } = useApp();
  const requestClose = useModalClose();
  const [text, setText] = useState(task.text);
  const [due, setDue] = useState<string | null>(
    section === "future" ? task.dueDate : null
  );
  const minDate = addDays(state.currentDate, 1); // 未来日程截止日期必须晚于“今天”
  const canSubmit = text.trim().length > 0 && (section === "today" || !!due);

  const submit = () => {
    if (!canSubmit) return;
    if (section === "future") {
      dispatch({ type: "EDIT_TASK", id: task.id, text, dueDate: due });
    } else {
      dispatch({ type: "EDIT_TASK", id: task.id, text });
    }
    showToast("已保存");
    requestClose();
  };

  return (
    <Modal title={section === "today" ? "编辑当日日程" : "编辑未来日程"} onClose={onClose}>
      <label className="field-label">日程内容</label>
      <input
        className="input"
        value={text}
        autoFocus
        placeholder="写点什么…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      {section === "future" && (
        <>
          <label className="field-label">截止日期</label>
          <DatePicker inline value={due} onChange={setDue} min={minDate} placeholder="选择截止日期" />
        </>
      )}
      {section === "today" && task.dueDate && (
        <p className="field-hint">该日程保留隐藏的截止时间，此处不可修改。</p>
      )}
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={requestClose}>
          取消
        </button>
        <button type="button" className="btn primary" disabled={!canSubmit} onClick={submit}>
          保存
        </button>
      </div>
    </Modal>
  );
}

/* ---------------- 添加日程 ---------------- */
export function AddTaskModal({
  section,
  onClose,
}: {
  section: "today" | "future";
  onClose: () => void;
}) {
  const { state, dispatch } = useApp();
  const requestClose = useModalClose();
  const [text, setText] = useState("");
  const [due, setDue] = useState<string | null>(null);
  const minDate = addDays(state.currentDate, 1);
  const canSubmit = text.trim().length > 0 && (section === "today" || !!due);

  const submit = () => {
    if (!canSubmit) return;
    dispatch({ type: "ADD_TASK", section, text, dueDate: due });
    showToast(section === "today" ? "已添加到当日日程" : "已添加到未来日程");
    requestClose();
  };

  return (
    <Modal title={section === "today" ? "添加当日日程" : "添加未来日程"} onClose={onClose}>
      <label className="field-label">日程内容</label>
      <input
        className="input"
        value={text}
        autoFocus
        placeholder={section === "today" ? "今天要做点什么…" : "计划做点什么…"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      {section === "future" && (
        <>
          <label className="field-label">截止日期</label>
          <DatePicker inline value={due} onChange={setDue} min={minDate} placeholder="选择截止日期" />
        </>
      )}
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={requestClose}>
          取消
        </button>
        <button type="button" className="btn primary" disabled={!canSubmit} onClick={submit}>
          添加
        </button>
      </div>
    </Modal>
  );
}

/* ---------------- 当日 -> 未来：设置截止日期 ---------------- */
function FutureDeadlineModal({
  task,
  toIndex,
  onClose,
}: {
  task: Task;
  toIndex: number;
  onClose: () => void;
}) {
  const { state, dispatch } = useApp();
  const requestClose = useModalClose();
  const minDate = addDays(state.currentDate, 1);
  // 原本有隐藏截止时间则自动带出，否则默认明天
  const prefill =
    task.dueDate && compareKeys(task.dueDate, state.currentDate) > 0
      ? task.dueDate
      : minDate;
  const [due, setDue] = useState<string | null>(prefill);
  const canSubmit = !!due;

  const submit = () => {
    if (!due) return;
    dispatch({ type: "MOVE_TASK", id: task.id, to: "future", toIndex, dueDate: due });
    showToast("已移动到未来日程");
    requestClose();
  };

  return (
    <Modal title="移动到未来日程" onClose={onClose}>
      <p className="confirm-message">
        {task.dueDate
          ? `该日程保留着截止时间（${formatMonthDay(task.dueDate)}），已自动填入，可修改。`
          : "请为该日程设置截止日期。"}
      </p>
      <label className="field-label">截止日期</label>
      <DatePicker inline value={due} onChange={setDue} min={minDate} placeholder="选择新的截止日期" />
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={requestClose}>
          取消
        </button>
        <button type="button" className="btn primary" disabled={!canSubmit} onClick={submit}>
          确认移动
        </button>
      </div>
    </Modal>
  );
}

export { IconPlus };
