// 日程条目组件：勾选、编辑、删除、长按拖动排序（含跨区域拖动）
import React, { useRef, useState } from "react";
import type { Task } from "../types";
import { useApp } from "../store";
import { addDays, compareKeys, formatMonthDay, formatRange } from "../lib/dates";
import {
  autoScrollList,
  clearDropIndicator,
  computeDropTarget,
  showDropIndicator,
  type DropTarget,
} from "../drag";
import { showToast } from "../toast";
import { ConfirmModal, DatePicker, GroupPicker, Modal, Switch, useModalClose } from "./ui";
import { IconCheck, IconPencil, IconPlus, IconTrash } from "./icons";
import { FUTURE_LIST_ID, TODAY_LIST_ID, genc } from "../drag";

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
  const showGroups = state.settings.showGroups;
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pendingFuture, setPendingFuture] = useState<{ toIndex: number; group?: string | null } | null>(null);

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
    // 先隐藏并定位，下一帧再显示，避免克隆行入场时重放动画/初始位置跳动
    ghost.style.left = "0px";
    ghost.style.top = "0px";
    ghost.style.opacity = "0";
    document.body.appendChild(ghost);
    const ds = dragRef.current!;
    ds.ghost = ghost;
    ds.offX = e.clientX - r.left;
    ds.offY = e.clientY - r.top;
    moveGhost(e);
    requestAnimationFrame(() => {
      if (dragRef.current?.ghost === ghost) {
        ghost.style.opacity = "0.94";
      }
    });
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
      // 同区域：同组内排序；跨组则移动并更新目标分组（分组功能关闭时仅排序，不改分组信息）
      if (target.index !== index) {
        if (!showGroups || target.group === task.group) {
          dispatch({ type: "REORDER", section, from: index, to: target.index });
        } else {
          dispatch({
            type: "MOVE_TASK",
            id: task.id,
            to: section,
            toIndex: target.index,
            group: target.group,
          });
        }
        applyFlip(prev);
      }
      return;
    }
    if (section === "today" && target.list === "future") {
      // 当日 -> 未来：弹窗设置时间区间（有隐藏起止时间则自动带出）
      setPendingFuture({ toIndex: target.index, group: showGroups ? target.group : undefined });
      return;
    }
    if (section === "future" && target.list === "today") {
      // 未来 -> 当日：保留起止日期（当日不显示），分组跟随落点（功能开启时）
      dispatch({
        type: "MOVE_TASK",
        id: task.id,
        to: "today",
        toIndex: target.index,
        group: showGroups ? target.group : undefined,
      });
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
      const me = state.todayTasks.find((t) => t.id === task.id);
      // 正在“完成”且该日程前方没有未完成日程 -> 完成后把下一个未完成定位到列表顶部
      if (me && !me.completed) {
        const idx = state.todayTasks.indexOf(me);
        const firstUnfinished = state.todayTasks.findIndex((t) => !t.completed);
        if (firstUnfinished === idx) {
          dispatch({ type: "TOGGLE_TODAY", id: task.id });
          if (state.settings.autoScrollNextOnComplete) {
            const next = state.todayTasks.slice(idx + 1).find((t) => !t.completed);
            dispatch({ type: "SET_TODAY_ANCHOR", id: next?.id ?? null });
          }
          return;
        }
      }
      dispatch({ type: "TOGGLE_TODAY", id: task.id });
    } else {
      dispatch({ type: "COMPLETE_FUTURE", id: task.id });
      showToast("已完成，已归档至历史日程");
    }
  };

  // 区间徽章只在未来日程显示（拖入当日后作为隐藏时间不展示）
  const rangeChip =
    section === "future" && task.dueDate ? (
      <span
        className={`due-chip ${compareKeys(task.dueDate, state.currentDate) <= 0 ? "overdue" : ""}`}
      >
        {formatRange(task.startDate, task.dueDate)}
      </span>
    ) : null;

  // 完成百分比：已完成显示勾；未完成按 progress 或“默认 0%”开关显示
  const progressShown =
    !task.completed &&
    (task.progress != null || state.settings.progressDefaultZero);
  const progressPct = task.completed ? null : task.progress ?? (state.settings.progressDefaultZero ? 0 : null);

  return (
    <>
      <div
        ref={rowRef}
        className={`task-row ${task.completed ? "done" : ""}`}
        data-task-row
        data-task-id={task.id}
        data-group={genc(task.group)}
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
        <div className="task-main">
          <div className="task-top">
            <span className="task-text">{task.text}</span>
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
          {/* 第二行：起始-截止日期与完成进度在同一行排列（不再挤占文字宽度） */}
          {(rangeChip || (progressShown && progressPct != null)) && (
            <div className="task-meta">
              {rangeChip}
              {progressShown && progressPct != null && (
                <span className="task-progress" title={`完成度 ${progressPct}%`}>
                  <span className="progress-track-mini">
                    <span className="progress-fill-mini" style={{ width: `${progressPct}%` }} />
                  </span>
                  <span className="progress-pct">{progressPct}%</span>
                </span>
              )}
            </div>
          )}
        </div>
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

      {/* 当日 -> 未来：设置时间区间 */}
      {pendingFuture && (
        <FutureDeadlineModal
          task={task}
          toIndex={pendingFuture.toIndex}
          group={pendingFuture.group}
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
  const [start, setStart] = useState<string | null>(section === "future" ? task.startDate : null);
  const [due, setDue] = useState<string | null>(section === "future" ? task.dueDate : null);
  const [group, setGroup] = useState<string | null>(task.group);
  const minDate = addDays(state.currentDate, 1); // 未来日程日期必须晚于“今天”
  const canSubmit = text.trim().length > 0 && (section === "today" || !!due);
  // 完成进度：仅在用户修改后才随 EDIT 提交
  const progressChanged = useRef(false);
  const [progressVal, setProgressVal] = useState<number | null>(null);

  // 已有分组（供选择）
  const existingGroups = React.useMemo(() => {
    const s = new Set<string>();
    for (const t of [...state.todayTasks, ...state.futureTasks]) if (t.group) s.add(t.group);
    return [...s];
  }, [state.todayTasks, state.futureTasks]);

  const pickStart = (key: string) => {
    setStart(key);
    // 起始不晚于截止
    if (due && compareKeys(key, due) > 0) setDue(key);
  };
  const pickDue = (key: string) => {
    setDue(key);
    if (start && compareKeys(start, key) > 0) setStart(key);
  };

  const submit = () => {
    if (!canSubmit) return;
    const progressArg = progressChanged.current ? progressVal : undefined;
    // 分组功能开启时才提交分组（关闭时界面不展示，保持原分组信息）
    const groupArg = state.settings.showGroups ? group : undefined;
    if (section === "future") {
      dispatch({
        type: "EDIT_TASK",
        id: task.id,
        text,
        group: groupArg,
        startDate: start,
        dueDate: due,
        progress: progressArg,
      });
    } else {
      dispatch({ type: "EDIT_TASK", id: task.id, text, group: groupArg, progress: progressArg });
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
          <label className="field-label">起始日期（可不填，默认次日）</label>
          <DatePicker inline value={start} onChange={pickStart} min={minDate} placeholder="选择起始日期" />
          <label className="field-label">截止日期</label>
          <DatePicker inline value={due} onChange={pickDue} min={start || minDate} placeholder="选择截止日期" />
        </>
      )}
      {state.settings.showGroups && (
        <>
          <label className="field-label">分组</label>
          <GroupPicker value={group} groups={existingGroups} onChange={setGroup} />
        </>
      )}
      <ProgressEditor
        task={task}
        onChange={(v) => {
          progressChanged.current = true;
          setProgressVal(v);
        }}
      />
      {section === "today" && task.dueDate && (
        <p className="field-hint">该日程保留隐藏的时间区间，此处不可修改。</p>
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

/* ---------------- 完成进度编辑（开关式：关=未设置，开=滑块区展开可拖动） ---------------- */
function ProgressEditor({
  task,
  onChange,
}: {
  task: Task;
  onChange: (v: number | null) => void;
}) {
  const initial = task.progress ?? (task.completed ? 100 : null);
  const [enabled, setEnabled] = useState(initial !== null);
  const [value, setValue] = useState<number>(initial ?? 0);

  const toggle = (on: boolean) => {
    setEnabled(on);
    if (on) onChange(value); // 开启即视为已设置（从当前滑块值开始）
    else onChange(null); // 关闭 = 未设置
  };
  const slide = (v: number) => {
    setValue(v);
    onChange(v);
  };

  return (
    <div className="progress-field">
      <div className="progress-field-head">
        <span className="field-label">
          完成进度
          <span className={`progress-head-value ${enabled ? "" : "empty"}`}>
            {enabled ? `${value}%` : "未设置"}
          </span>
        </span>
        <span className="progress-toggle">
          <Switch checked={enabled} onChange={toggle} />
        </span>
      </div>
      <div className={`progress-slider-area ${enabled ? "open" : ""}`}>
        <div className="progress-slider-inner">
          <input
            type="range"
            className="progress-range"
            min={0}
            max={100}
            step={5}
            value={enabled ? value : 0}
            disabled={!enabled}
            onChange={(e) => slide(Number(e.target.value))}
          />
          <div className="progress-field-actions">
            {[0, 25, 50, 75, 100].map((v) => (
              <button
                key={v}
                type="button"
                className={`mini-chip ${enabled && value === v ? "active" : ""}`}
                disabled={!enabled}
                onClick={() => slide(v)}
              >
                {v}%
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
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
  const [start, setStart] = useState<string | null>(null);
  const [due, setDue] = useState<string | null>(null);
  const minDate = addDays(state.currentDate, 1);
  const canSubmit = text.trim().length > 0 && (section === "today" || !!due);

  const pickStart = (key: string) => {
    setStart(key);
    if (due && compareKeys(key, due) > 0) setDue(key);
  };
  const pickDue = (key: string) => {
    setDue(key);
    if (start && compareKeys(start, key) > 0) setStart(key);
  };

  const submit = () => {
    if (!canSubmit) return;
    dispatch({ type: "ADD_TASK", section, text, startDate: start, dueDate: due });
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
          <label className="field-label">起始日期（可不填，默认次日开始）</label>
          <DatePicker inline value={start} onChange={pickStart} min={minDate} placeholder="选择起始日期" />
          <label className="field-label">截止日期</label>
          <DatePicker inline value={due} onChange={pickDue} min={start || minDate} placeholder="选择截止日期" />
        </>
      )}
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={requestClose}>
          取消
        </button>
        <button type="button" className="btn primary" disabled={!canSubmit} onClick={submit}>
          {section === "future" ? "添加" : "添加"}
        </button>
      </div>
    </Modal>
  );
}

/* ---------------- 当日 -> 未来：设置时间区间 ---------------- */
function FutureDeadlineModal({
  task,
  toIndex,
  group,
  onClose,
}: {
  task: Task;
  toIndex: number;
  group?: string | null;
  onClose: () => void;
}) {
  const { state, dispatch } = useApp();
  const requestClose = useModalClose();
  const minDate = addDays(state.currentDate, 1);
  // 隐藏的截止时间自动带出，否则默认明天
  const prefillDue =
    task.dueDate && compareKeys(task.dueDate, state.currentDate) > 0 ? task.dueDate : minDate;
  const [start, setStart] = useState<string | null>(
    task.startDate && compareKeys(task.startDate, state.currentDate) > 0 ? task.startDate : null
  );
  const [due, setDue] = useState<string | null>(prefillDue);
  const canSubmit = !!due;

  const pickStart = (key: string) => {
    setStart(key);
    if (due && compareKeys(key, due) > 0) setDue(key);
  };
  const pickDue = (key: string) => {
    setDue(key);
    if (start && compareKeys(start, key) > 0) setStart(key);
  };

  const submit = () => {
    if (!due) return;
    dispatch({
      type: "MOVE_TASK",
      id: task.id,
      to: "future",
      toIndex,
      group,
      startDate: start,
      dueDate: due,
    });
    showToast("已移动到未来日程");
    requestClose();
  };

  return (
    <Modal title="移动到未来日程" onClose={onClose}>
      <p className="confirm-message">
        {task.dueDate
          ? `该日程保留着原时间区间，已自动填入，可修改。`
          : "请为该日程设置时间（可只填截止日期）。"}
      </p>
      <label className="field-label">起始日期（可不填，默认次日）</label>
      <DatePicker inline value={start} onChange={pickStart} min={minDate} placeholder="选择起始日期" />
      <label className="field-label">截止日期</label>
      <DatePicker inline value={due} onChange={pickDue} min={start || minDate} placeholder="选择截止日期" />
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
