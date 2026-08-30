// 纯数据逻辑：日期滚动、历史归档、数据规范化
import type { AppData, HistoryEntry, Settings, Task } from "../types";
import { DEFAULT_SETTINGS } from "../types";
import { compareKeys, isValidKey, todayKey } from "./dates";

/** 全新数据（首次运行） */
export function freshData(): AppData {
  return {
    version: 1,
    currentDate: todayKey(),
    todayTasks: [],
    futureTasks: [],
    history: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

function normalizeTask(t: any): Task {
  return {
    id: String(t?.id ?? ""),
    text: String(t?.text ?? ""),
    createdAt: String(t?.createdAt ?? new Date().toISOString()),
    dueDate: t?.dueDate ? String(t.dueDate) : null,
    completed: !!t?.completed,
    completedAt: t?.completedAt ? String(t.completedAt) : null,
    plannedDate: t?.plannedDate ? String(t.plannedDate) : null,
    archivedAt: t?.archivedAt ? String(t.archivedAt) : null,
  };
}

/** 把磁盘上可能缺失字段的旧数据补全为完整结构 */
export function normalizeData(raw: any): AppData {
  const base = freshData();
  const data: AppData = {
    ...base,
    ...raw,
    settings: { ...DEFAULT_SETTINGS, ...(raw?.settings || {}) } as Settings,
    todayTasks: Array.isArray(raw?.todayTasks) ? raw.todayTasks.map(normalizeTask) : [],
    futureTasks: Array.isArray(raw?.futureTasks) ? raw.futureTasks.map(normalizeTask) : [],
    history: Array.isArray(raw?.history)
      ? raw.history
          .map((h: any) => ({
            date: String(h?.date ?? ""),
            tasks: Array.isArray(h?.tasks) ? h.tasks.map(normalizeTask) : [],
          }))
          .filter((h: HistoryEntry) => h.date && h.tasks.length > 0)
      : [],
  };
  if (!isValidKey(data.currentDate)) data.currentDate = todayKey();
  return data;
}

/** 往历史中加入一条（按归档日期合并） */
export function addToHistory(history: HistoryEntry[], date: string, task: Task): HistoryEntry[] {
  const next = history.map((h) => (h.date === date ? { ...h } : h));
  const idx = next.findIndex((h) => h.date === date);
  if (idx >= 0) {
    next[idx] = { date, tasks: [...next[idx].tasks, task] };
  } else {
    next.push({ date, tasks: [task] });
  }
  return next;
}

/** 从历史中移除一条，空分组自动删除 */
export function removeFromHistory(history: HistoryEntry[], date: string, taskId: string): HistoryEntry[] {
  return history
    .map((h) => (h.date === date ? { ...h, tasks: h.tasks.filter((t) => t.id !== taskId) } : h))
    .filter((h) => h.tasks.length > 0);
}

/**
 * 日期滚动核心逻辑：把应用从 currentDate 前进到 targetKey（targetKey 必须晚于当前日期）。
 *  - 当日已完成日程 -> 归档进历史（归档日期 = 当前日期）
 *  - 当日未完成日程 -> 保留，继续显示在“当日日程”
 *  - 截止日期 <= targetKey 的未来日程 -> 自动移动到当日日程列表末尾
 */
export function rollover(data: AppData, targetKey: string): AppData {
  if (compareKeys(targetKey, data.currentDate) <= 0) return data;

  const done = data.todayTasks.filter((t) => t.completed);
  const kept = data.todayTasks.filter((t) => !t.completed);

  const now = new Date().toISOString();
  const archived: Task[] = done.map((t) => ({
    ...t,
    plannedDate: data.currentDate,
    archivedAt: now,
  }));

  let history = data.history;
  if (archived.length) {
    for (const t of archived) history = addToHistory(history, data.currentDate, t);
  }

  // 拉取截止日期不晚于目标日期的未来日程，追加到当日末尾
  const pulled = data.futureTasks.filter(
    (t) => t.dueDate && compareKeys(t.dueDate, targetKey) <= 0
  );
  const futureTasks = data.futureTasks.filter(
    (t) => !(t.dueDate && compareKeys(t.dueDate, targetKey) <= 0)
  );

  return {
    ...data,
    currentDate: targetKey,
    todayTasks: [...kept, ...pulled],
    futureTasks,
    history,
  };
}

/** 未来日程按截止日期升序插入（默认排序规则） */
export function insertFutureSorted(tasks: Task[], task: Task): Task[] {
  const arr = [...tasks];
  const due = task.dueDate || "";
  let i = arr.findIndex((t) => compareKeys(t.dueDate || "", due) > 0);
  if (i < 0) i = arr.length;
  arr.splice(i, 0, task);
  return arr;
}

/**
 * 日期回退核心逻辑：把 currentDate 退回到 targetKey（targetKey 必须早于当前日期）。
 *  - 当日日程中“隐藏截止日期晚于目标日”的任务（本属于更晚的日子）放回未来列表
 *  - 其余任务（无截止日期 / 截止日期不晚于目标日）留在当日
 *  - 已归档进历史的任务不受影响
 */
export function rollback(data: AppData, targetKey: string): AppData {
  if (compareKeys(targetKey, data.currentDate) >= 0) return data;
  const stay: Task[] = [];
  const back: Task[] = [];
  for (const t of data.todayTasks) {
    if (t.dueDate && compareKeys(t.dueDate, targetKey) > 0) back.push(t);
    else stay.push(t);
  }
  let futureTasks = data.futureTasks;
  for (const t of back) futureTasks = insertFutureSorted(futureTasks, t);
  return { ...data, currentDate: targetKey, todayTasks: stay, futureTasks };
}
