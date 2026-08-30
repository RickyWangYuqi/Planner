// 历史日程页面：按日期分组，支持恢复 / 删除 / 清空
import { useState } from "react";
import type { Task } from "../types";
import { useApp } from "../store";
import { compareKeys, formatFull } from "../lib/dates";
import { showToast } from "../toast";
import { BackButton, ConfirmModal, DatePicker, Modal, useModalClose } from "./ui";
import { IconCheck, IconRestore, IconTrash } from "./icons";

export function HistoryPage({ onBack }: { onBack: () => void }) {
  const { state, dispatch } = useApp();
  const [confirmClear, setConfirmClear] = useState(false);
  const [toDelete, setToDelete] = useState<{ entryDate: string; task: Task } | null>(null);
  const [toRestore, setToRestore] = useState<{ entryDate: string; task: Task } | null>(null);

  const groups = [...state.history].sort((a, b) => (a.date < b.date ? 1 : -1));
  const total = groups.reduce((n, g) => n + g.tasks.length, 0);

  const requestRestore = (entryDate: string, task: Task) => {
    const planned = task.plannedDate;
    const cur = state.currentDate;
    if (planned && compareKeys(planned, cur) === 0) {
      // 原计划日期是今天 -> 直接恢复到当日日程
      dispatch({ type: "RESTORE", entryDate, id: task.id, target: "today" });
      showToast("已恢复到当日日程");
    } else if (planned && compareKeys(planned, cur) > 0) {
      // 原计划日期在未来 -> 恢复到未来日程（保留原截止日期）
      dispatch({ type: "RESTORE", entryDate, id: task.id, target: "future", dueDate: planned });
      showToast("已恢复到未来日程");
    } else {
      // 原计划日期已过 -> 弹窗选择新的截止日期
      setToRestore({ entryDate, task });
    }
  };

  return (
    <div className="page-history">
      <div className="page-head">
        <BackButton onClick={onBack} />
        <h1 className="page-title">历史日程</h1>
        {total > 0 && (
          <button
            type="button"
            className="btn ghost danger-text"
            onClick={() => setConfirmClear(true)}
          >
            清空历史
          </button>
        )}
      </div>

      {total === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon">🗂️</div>
          <p>暂无历史日程</p>
          <p className="empty-state-sub">完成的日程在次日会自动归档到这里</p>
        </div>
      )}

      {groups.map((g) => (
        <section key={g.date} className="history-group">
          <div className="history-group-head">
            <span className="history-group-date">{formatFull(g.date)}</span>
            <span className="section-count">{g.tasks.length}</span>
          </div>
          <div className="card history-card">
            {g.tasks.map((t) => (
              <div key={t.id} className="history-row">
                <span className={`history-check ${t.completed ? "checked" : ""}`}>
                  {t.completed && <IconCheck size={12} />}
                </span>
                <span className="history-text">
                  {t.text}
                  {t.plannedDate && (
                    <span className="history-planned">计划 {formatFull(t.plannedDate)}</span>
                  )}
                </span>
                <span className="history-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    title="恢复"
                    onClick={() => requestRestore(g.date, t)}
                  >
                    <IconRestore size={15} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    title="永久删除"
                    onClick={() => setToDelete({ entryDate: g.date, task: t })}
                  >
                    <IconTrash size={14} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}

      {/* 清空历史确认 */}
      {confirmClear && (
        <ConfirmModal
          title="清空历史日程"
          message="将永久删除全部历史记录，且不可恢复。确定继续吗？"
          confirmText="清空"
          danger
          onConfirm={() => {
            dispatch({ type: "CLEAR_HISTORY" });
            showToast("历史日程已清空", "info");
            // 弹窗由退出动画结束后关闭（onClose -> setConfirmClear(false)）
          }}
          onCancel={() => setConfirmClear(false)}
        />
      )}

      {/* 单条永久删除确认 */}
      {toDelete && (
        <ConfirmModal
          title="删除历史日程"
          message={`将永久删除“${toDelete.task.text}”，不可恢复。确定继续吗？`}
          confirmText="永久删除"
          danger
          onConfirm={() => {
            dispatch({ type: "DELETE_HISTORY_TASK", entryDate: toDelete.entryDate, id: toDelete.task.id });
            showToast("已永久删除", "info");
            // 弹窗由退出动画结束后关闭（onClose -> setToDelete(null)）
          }}
          onCancel={() => setToDelete(null)}
        />
      )}

      {/* 恢复：选择截止日期 */}
      {toRestore && (
        <RestoreModal
          task={toRestore.task}
          onClose={() => setToRestore(null)}
          onConfirm={(target, dueDate) => {
            dispatch({
              type: "RESTORE",
              entryDate: toRestore.entryDate,
              id: toRestore.task.id,
              target,
              dueDate,
            });
            showToast(target === "today" ? "已恢复到当日日程" : "已恢复到未来日程");
            // 弹窗由退出动画结束后关闭（RestoreModal 内 requestClose）
          }}
        />
      )}
    </div>
  );
}

function RestoreModal({
  task,
  onClose,
  onConfirm,
}: {
  task: Task;
  onClose: () => void;
  onConfirm: (target: "today" | "future", dueDate?: string | null) => void;
}) {
  const { state } = useApp();
  const requestClose = useModalClose();
  const [target, setTarget] = useState<"today" | "future">("today");
  const [due, setDue] = useState<string | null>(null);
  const minDate = state.currentDate; // 选择今天或未来
  const minFuture = minDate;

  return (
    <Modal title="恢复日程" onClose={onClose}>
      <p className="confirm-message">“{task.text}”的原计划日期已过，请选择恢复方式。</p>
      <div className="segmented restore-seg">
        <button
          type="button"
          className={`segmented-item ${target === "today" ? "active" : ""}`}
          onClick={() => setTarget("today")}
        >
          恢复到今天
        </button>
        <button
          type="button"
          className={`segmented-item ${target === "future" ? "active" : ""}`}
          onClick={() => setTarget("future")}
        >
          恢复到未来日期
        </button>
      </div>
      {target === "future" && (
        <div className="restore-date">
          <DatePicker value={due} onChange={setDue} min={minFuture} placeholder="选择新的截止日期" />
        </div>
      )}
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={requestClose}>
          取消
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={target === "future" && !due}
          onClick={() => {
            onConfirm(target, target === "future" ? due : null);
            requestClose();
          }}
        >
          恢复
        </button>
      </div>
    </Modal>
  );
}
