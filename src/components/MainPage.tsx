// 日程主界面：日期头部 + 当日日程 + 未来日程
import { useMemo, useState } from "react";
import { useApp } from "../store";
import { compareKeys, formatFull, todayKey } from "../lib/dates";
import { showToast } from "../toast";
import { TaskItem, AddTaskModal } from "./TaskItem";
import { FUTURE_LIST_ID, TODAY_LIST_ID } from "../drag";
import { DatePicker, Modal, useModalClose } from "./ui";
import { IconCalendar, IconGear, IconPlus } from "./icons";

export function MainPage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { state, dispatch, hydrated } = useApp();
  const [addModal, setAddModal] = useState<null | "today" | "future">(null);
  const [dateJump, setDateJump] = useState(false);

  const date = state.currentDate;
  const total = state.todayTasks.length;
  const done = state.todayTasks.filter((t) => t.completed).length;
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;

  // 日期选择器里给“有日程的日期”打点：未来任务截止日
  const markedDates = useMemo(() => {
    const set = new Set<string>();
    for (const t of state.futureTasks) if (t.dueDate) set.add(t.dueDate);
    return set;
  }, [state.futureTasks]);

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

      {/* 当日日程 */}
      <section className="section">
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
        <div className="task-list" id={TODAY_LIST_ID}>
          {state.todayTasks.map((t, i) => (
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
      </section>

      <div className="divider" />

      {/* 未来日程 */}
      <section className="section">
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
        <div className="task-list" id={FUTURE_LIST_ID}>
          {state.futureTasks.map((t, i) => (
            <TaskItem key={t.id} task={t} section="future" index={i} />
          ))}
          {state.futureTasks.length === 0 && (
            <div className="empty-hint" onClick={() => setAddModal("future")}>
              <IconPlus size={15} />
              添加未来日程
            </div>
          )}
        </div>
      </section>

      {addModal && <AddTaskModal section={addModal} onClose={() => setAddModal(null)} />}

      {/* 选择日期：查看/编辑不同日期的日程 */}
      {dateJump && (
        <Modal title="选择日期" onClose={() => setDateJump(false)}>
          <DateJumpBody
            date={date}
            markedDates={markedDates}
            onJump={jumpToDate}
          />
        </Modal>
      )}
    </div>
  );
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
