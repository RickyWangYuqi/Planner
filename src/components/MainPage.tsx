// 日程主界面：日期头部 + 上下可调比例的当日/未来两个分区
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../store";
import { compareKeys, formatFull, todayKey } from "../lib/dates";
import type { Task } from "../types";
import { showToast } from "../toast";
import { TaskItem, AddTaskModal } from "./TaskItem";
import { GroupHeader } from "./GroupHeader";
import { FUTURE_LIST_ID, TODAY_LIST_ID } from "../drag";
import { DatePicker, Modal, useModalClose } from "./ui";
import { IconCalendar, IconGear, IconPlus } from "./icons";

/** 分区最短高度（约为 标题栏 + 一个日程行），无最长限制 */
const MIN_PANE_PX = 110;

/** 按任务数组顺序切分连续的组段 */
function toSegments(tasks: Task[]) {
  const segs: Array<{ group: string | null; items: Array<{ task: Task; index: number }> }> = [];
  tasks.forEach((task, index) => {
    const g = task.group ?? null;
    const last = segs[segs.length - 1];
    if (!last || last.group !== g) segs.push({ group: g, items: [{ task, index }] });
    else last.items.push({ task, index });
  });
  return segs;
}

/** 是否展示分组标题（单段且全为未分组时不显示，避免杂乱） */
function shouldShowHead(segs: ReturnType<typeof toSegments>) {
  return segs.length > 1 || (segs.length === 1 && segs[0].group !== null);
}

export function MainPage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { state, dispatch, hydrated } = useApp();
  const [addModal, setAddModal] = useState<null | "today" | "future">(null);
  const [dateJump, setDateJump] = useState(false);

  const date = state.currentDate;
  const total = state.todayTasks.length;
  const done = state.todayTasks.filter((t) => t.completed).length;
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;

  // 上下分区比例（当日区占比）
  const todayRatio = state.settings.todayPaneRatio;
  const splitRef = useRef<HTMLDivElement | null>(null);
  const todayPaneRef = useRef<HTMLElement | null>(null);
  const dragRatioRef = useRef(todayRatio);
  dragRatioRef.current = todayRatio;

  // 日期选择器里给“有日程的日期”打点：未来任务的起始与截止日
  const markedDates = useMemo(() => {
    const set = new Set<string>();
    for (const t of state.futureTasks) {
      if (t.startDate) set.add(t.startDate);
      if (t.dueDate) set.add(t.dueDate);
    }
    return set;
  }, [state.futureTasks]);

  const showGroups = state.settings.showGroups;
  const todaySegments = useMemo(() => toSegments(state.todayTasks), [state.todayTasks]);
  const futureSegments = useMemo(() => toSegments(state.futureTasks), [state.futureTasks]);
  const todayShowHead = showGroups && shouldShowHead(todaySegments);
  const futureShowHead = showGroups && shouldShowHead(futureSegments);

  const jumpToDate = (key: string) => {
    setDateJump(false);
    if (key === date) return;
    if (compareKeys(key, date) > 0) {
      dispatch({ type: "ROLLOVER_TO", key }); // 快进：迁移数据
    } else {
      dispatch({ type: "ROLLBACK_TO", key }); // 回退：把更晚的任务放回未来
    }
    showToast(`已切换到 ${formatFull(key)}`, "info");
  };

  // 当日列表锚点滚动（功能开启时）：仅在锚点变化或页面挂载时执行。
  // 目标总是“当前第一个未完成的任务”：锚点过期则先校正。
  // 不依赖 todayTasks：取消打钩 / 编辑 / 增删任一任务都不应误触发滚动。
  useEffect(() => {
    if (!state.settings.autoScrollNextOnComplete) return;
    const listEl = document.getElementById(TODAY_LIST_ID);
    if (!listEl) return;
    const first = state.todayTasks.find((t) => !t.completed);
    const targetId = first?.id ?? null;
    if (state.todayAnchorId !== targetId) {
      dispatch({ type: "SET_TODAY_ANCHOR", id: targetId });
    }
    let targetTop = 0;
    if (targetId) {
      const row = listEl.querySelector<HTMLElement>(`[data-task-id="${targetId}"]`);
      if (row) {
        const listRect = listEl.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        targetTop = listEl.scrollTop + (rowRect.top - listRect.top) - listEl.clientTop;
      }
    }
    const max = listEl.scrollHeight - listEl.clientHeight;
    listEl.scrollTo({ top: Math.max(0, Math.min(targetTop, max)), behavior: "smooth" });
  }, [state.todayAnchorId, state.settings.autoScrollNextOnComplete, dispatch]);

  // 拖动分割线：调整当日/未来区域高度比例（拖动中直接改 DOM，松手后持久化）
  const startSplitDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const split = splitRef.current;
    const pane = todayPaneRef.current;
    if (!split || !pane) return;
    const rect = split.getBoundingClientRect();
    const h = rect.height || 1;
    const onMove = (ev: PointerEvent) => {
      const y = ev.clientY - rect.top;
      const lo = MIN_PANE_PX / h;
      const hi = Math.max(1 - MIN_PANE_PX / h, lo);
      const r = Math.min(Math.max(y / h, lo), hi);
      pane.style.height = `${(r * 100).toFixed(2)}%`;
      dragRatioRef.current = r;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-resizing-split");
      const r = Math.max(0.03, Math.min(0.97, dragRatioRef.current));
      if (Math.abs(r - state.settings.todayPaneRatio) > 0.002) {
        dispatch({ type: "SET_SETTINGS", patch: { todayPaneRatio: r } });
      }
    };
    document.body.classList.add("is-resizing-split");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div className="page-main">
      {/* 日期头部 */}
      <div className="date-header">
        <div className="date-block">
          <div className="date-main">{formatFull(date)}</div>
          <div className="date-sub">
            {total > 0 ? (
              <>
                已完成 {done} / {total}
                <span className="progress-track">
                  <span className="progress-fill" style={{ width: `${progress}%` }} />
                </span>
              </>
            ) : (
              "今天还没有日程，加一条吧"
            )}
          </div>
        </div>
        <div className="date-actions">
          <button
            type="button"
            className="btn soft date-jump-btn"
            onClick={() => setDateJump(true)}
            title="选择要查看或编辑的日期"
          >
            <IconCalendar size={14} />
            选择日期
          </button>
          <button
            type="button"
            className="icon-btn gear"
            onClick={onOpenSettings}
            aria-label="设置"
            title="设置"
          >
            <IconGear size={17} />
          </button>
        </div>
      </div>

      {/* 上下分区（拖动分割线可调比例） */}
      <div className="dnd-split" ref={splitRef}>
        {/* 当日分区 */}
        <section
          className="pane today-pane"
          ref={todayPaneRef}
          style={{ height: `${todayRatio * 100}%` }}
        >
          <div className="section-header">
            <h2 className="section-title">当日日程</h2>
            {total > 0 && <span className="section-count">{total}</span>}
            <span className="spacer" />
            <button
              type="button"
              className="add-btn"
              onClick={() => setAddModal("today")}
              aria-label="添加当日日程"
              title="添加当日日程"
            >
              <IconPlus size={16} />
            </button>
          </div>
          <div className="list-wrap">
            <div className="task-list" id={TODAY_LIST_ID}>
              {showGroups && total > 0
                ? todaySegments.map((seg) => (
                    <div key={seg.group ?? "__"} className="group-block">
                      {todayShowHead && (
                        <GroupHeader section="today" group={seg.group} listId={TODAY_LIST_ID} />
                      )}
                      {seg.items.map(({ task, index }) => (
                        <TaskItem key={task.id} task={task} section="today" index={index} />
                      ))}
                    </div>
                  ))
                : state.todayTasks.map((t, i) => (
                    <TaskItem key={t.id} task={t} section="today" index={i} />
                  ))}
              {total === 0 &&
                (hydrated ? (
                  <div className="empty-hint" onClick={() => setAddModal("today")}>
                    <IconPlus size={15} />
                    添加今日日程
                  </div>
                ) : (
                  <div className="empty-hint loading">
                    <span className="spinner" />
                    正在加载日程…
                  </div>
                ))}
            </div>
            <MoreBelowHint listId={TODAY_LIST_ID} dep={state.todayTasks.length} />
          </div>
        </section>

        {/* 分割线（可拖动） */}
        <div
          className="divider split-divider"
          onPointerDown={startSplitDrag}
          title="拖动调整上下区域大小"
        />

        {/* 未来分区 */}
        <section className="pane future-pane">
          <div className="section-header">
            <h2 className="section-title">未来日程</h2>
            {state.futureTasks.length > 0 && (
              <span className="section-count">{state.futureTasks.length}</span>
            )}
            <span className="spacer" />
            <button
              type="button"
              className="add-btn"
              onClick={() => setAddModal("future")}
              aria-label="添加未来日程"
              title="添加未来日程"
            >
              <IconPlus size={16} />
            </button>
          </div>
          <div className="list-wrap">
            <div className="task-list" id={FUTURE_LIST_ID}>
              {showGroups && state.futureTasks.length > 0
                ? futureSegments.map((seg) => (
                    <div key={seg.group ?? "__"} className="group-block">
                      {futureShowHead && (
                        <GroupHeader section="future" group={seg.group} listId={FUTURE_LIST_ID} />
                      )}
                      {seg.items.map(({ task, index }) => (
                        <TaskItem key={task.id} task={task} section="future" index={index} />
                      ))}
                    </div>
                  ))
                : state.futureTasks.map((t, i) => (
                    <TaskItem key={t.id} task={t} section="future" index={i} />
                  ))}
              {state.futureTasks.length === 0 && (
                <div className="empty-hint" onClick={() => setAddModal("future")}>
                  <IconPlus size={15} />
                  添加未来日程
                </div>
              )}
            </div>
            <MoreBelowHint listId={FUTURE_LIST_ID} dep={state.futureTasks.length} />
          </div>
        </section>
      </div>

      {addModal && <AddTaskModal section={addModal} onClose={() => setAddModal(null)} />}

      {/* 选择日期：查看/编辑不同日期的日程 */}
      {dateJump && (
        <Modal title="选择日期" onClose={() => setDateJump(false)}>
          <DateJumpBody date={date} markedDates={markedDates} onJump={jumpToDate} />
        </Modal>
      )}
    </div>
  );
}

/**
 * “下方还有内容”的非文字视觉提示：列表可继续下滚时，
 * 在列表底部显示一段渐隐遮罩（内容淡出，暗示下面还有）。
 */
function MoreBelowHint({ listId, dep }: { listId: string; dep: number }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const el = document.getElementById(listId) as HTMLElement | null;
    if (!el) return;
    const check = () => {
      const canScroll = el.scrollHeight > el.clientHeight + 4;
      const notAtEnd = el.scrollTop < el.scrollHeight - el.clientHeight - 2;
      setShow(canScroll && notAtEnd);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    el.addEventListener("scroll", check, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", check);
    };
  }, [listId, dep]);
  return <span className={`more-below ${show ? "visible" : ""}`} aria-hidden="true" />;
}

/** 选择日期弹窗内容：选日期即跳转并带退出动画关闭 */
function DateJumpBody({
  date,
  markedDates,
  onJump,
}: {
  date: string;
  markedDates: Set<string>;
  onJump: (key: string) => void;
}) {
  const requestClose = useModalClose();
  return (
    <>
      <p className="confirm-message">可切换到今天或未来的任意日期查看、编辑日程。</p>
      <DatePicker
        inline
        value={date}
        min={todayKey()}
        marks={markedDates}
        onChange={(key) => {
          onJump(key);
          requestClose();
        }}
      />
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={requestClose}>
          取消
        </button>
      </div>
    </>
  );
}
