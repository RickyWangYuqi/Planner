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
    groups: [],
    history: [],
    settings: { ...DEFAULT_SETTINGS },
    todayAnchorId: null,
  };
}

/** 补入正在使用的分组，已有的空分组及其顺序保持不变。 */
export function addTaskGroups(groups: string[], tasks: readonly Task[]): string[] {
  const known = new Set(groups);
  let next = groups;
  for (const task of tasks) {
    if (task.group && !known.has(task.group)) {
      if (next === groups) next = [...groups];
      next.push(task.group);
      known.add(task.group);
    }
  }
  return next;
}

function normalizeTask(t: any): Task {
  const progress = t?.progress;
  return {
    id: String(t?.id ?? ""),
    text: String(t?.text ?? ""),
    createdAt: String(t?.createdAt ?? new Date().toISOString()),
    group: t?.group && String(t.group).trim() ? String(t.group).trim() : null,
    startDate: t?.startDate ? String(t.startDate) : null,
    dueDate: t?.dueDate ? String(t.dueDate) : null,
    completed: !!t?.completed,
    completedAt: t?.completedAt ? String(t.completedAt) : null,
    progress:
      typeof progress === "number" && isFinite(progress)
        ? Math.max(0, Math.min(100, Math.round(progress)))
        : null,
    plannedDate: t?.plannedDate ? String(t.plannedDate) : null,
    archivedAt: t?.archivedAt ? String(t.archivedAt) : null,
  };
}

/** 未来日程未填起始日期时的默认值：创建日（currentDate）的下一天 */
export function defaultStartDate(currentDate: string): string {
  return addDaysKey(currentDate, 1);
}

function addDaysKey(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + n);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
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
  const groups = Array.isArray(raw?.groups)
    ? [...new Set<string>(raw.groups.filter((group: unknown): group is string => typeof group === "string")
        .map((group: string) => group.trim()).filter(Boolean))]
    : [];
  // 旧数据从当前日程迁移分组；历史只保留归档信息，不复活已删除的标签。
  data.groups = addTaskGroups(groups, [...data.todayTasks, ...data.futureTasks]);
  if (!isValidKey(data.currentDate)) data.currentDate = todayKey();
  if (typeof data.todayAnchorId !== "string") data.todayAnchorId = null;
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

const gkey = (g: string | null) => g ?? "";

/**
 * 分组收敛：任何分组改动都可能让同一组在数组中断裂成多段（例如把某组中间的任务移到别的组）。
 * 该函数把每个组收敛为唯一一段：
 *  - 若每个组已经只有一段则原样返回（不改变顺序，用户拖好的组间顺序保持不变）；
 *  - 否则按“每组最右侧成员在数组中的位置”排序重建（组内保持原有相对顺序），
 *    例如 ad 123 ABC 中把 B 移到新组后，结果收敛为 ad 123 B AC。
 */
export function settleGroupList(tasks: Task[]): Task[] {
  let prevKey = "\u0000";
  const seen = new Set<string>();
  let dup = false;
  const rightIdx = new Map<string, number>();
  for (let i = 0; i < tasks.length; i++) {
    const k = gkey(tasks[i].group);
    if (k !== prevKey) {
      if (seen.has(k)) dup = true;
      seen.add(k);
      prevKey = k;
    }
    rightIdx.set(k, i);
  }
  if (!dup) return tasks;
  const buckets = new Map<string, Task[]>();
  for (const t of tasks) {
    const k = gkey(t.group);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(t);
  }
  const order = [...buckets.keys()].sort((a, b) => (rightIdx.get(a) ?? 0) - (rightIdx.get(b) ?? 0));
  const out: Task[] = [];
  for (const k of order) out.push(...(buckets.get(k) as Task[]));
  return out;
}
