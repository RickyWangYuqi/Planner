// 状态 reducer：所有数据变更的纯函数
import type { AppData, Task } from "./types";
import { uid } from "./lib/id";
import { addDays, compareKeys } from "./lib/dates";
import {
  addToHistory,
  defaultStartDate,
  insertFutureSorted,
  removeFromHistory,
  rollback,
  rollover,
  settleGroupList,
} from "./lib/data";

export type Action =
  | { type: "LOAD"; data: AppData }
  | {
      type: "ADD_TASK";
      section: "today" | "future";
      text: string;
      group?: string | null;
      startDate?: string | null;
      dueDate?: string | null;
    }
  | {
      type: "EDIT_TASK";
      id: string;
      text: string;
      group?: string | null;
      startDate?: string | null;
      dueDate?: string | null;
      progress?: number | null; // undefined = 不改；null = 清除；0-100 = 设置
    }
  | { type: "DELETE_TASK"; id: string }
  | { type: "TOGGLE_TODAY"; id: string }
  | { type: "COMPLETE_FUTURE"; id: string }
  | { type: "REORDER"; section: "today" | "future"; from: number; to: number }
  | {
      type: "MOVE_TASK";
      id: string;
      to: "today" | "future";
      toIndex: number;
      group?: string | null; // 跨组拖动时的目标分组（undefined = 保持原分组）
      startDate?: string | null;
      dueDate?: string | null;
    }
  | {
      type: "MOVE_GROUP";
      section: "today" | "future";
      group: string | null; // null = 未分组
      toIndex: number; // 整组插入的目标数组位置
    }
  | { type: "DELETE_GROUP"; section: "today" | "future"; group: string | null }
  | { type: "END_DAY" }
  | { type: "ROLLOVER_TO"; key: string }
  | { type: "ROLLBACK_TO"; key: string }
  | {
      type: "RESTORE";
      entryDate: string;
      id: string;
      target: "today" | "future";
      dueDate?: string | null;
    }
  | { type: "DELETE_HISTORY_TASK"; entryDate: string; id: string }
  | { type: "CLEAR_HISTORY" }
  | { type: "SET_SETTINGS"; patch: Partial<AppData["settings"]> }
  | { type: "SET_TODAY_ANCHOR"; id: string | null };

/**
 * 应用完成百分比：
 *  - 100 -> 视为完成（completed = true）
 *  - 0-99 -> 视为进行中（completed = false）
 *  - null（清除）-> 只清除进度，完成状态不变
 */
function applyProgress(task: Task, progress: number | null | undefined): Task {
  if (progress === undefined) return task;
  if (progress === null) {
    return { ...task, progress: null };
  }
  const p = Math.max(0, Math.min(100, Math.round(progress)));
  return { ...task, progress: p, completed: p >= 100, completedAt: p >= 100 ? new Date().toISOString() : null };
}

function reducerInner(state: AppData, action: Action): AppData {
  switch (action.type) {
    case "LOAD":
      return action.data;

    case "ADD_TASK": {
      const task: Task = {
        id: uid(),
        text: action.text.trim(),
        createdAt: new Date().toISOString(),
        group: action.group ? action.group.trim() : null,
        startDate: action.startDate || null,
        dueDate: action.dueDate || null,
        completed: false,
        completedAt: null,
        progress: null,
      };
      if (action.section === "today") {
        return { ...state, todayTasks: [...state.todayTasks, task] };
      }
      // 未来日程：起始日期缺省默认“创建日的下一天”，且不晚于截止日期；按截止日期升序插入
      if (task.dueDate) {
        if (!task.startDate) {
          task.startDate = defaultStartDate(state.currentDate);
        } else if (compareKeys(task.startDate, task.dueDate) > 0) {
          task.startDate = task.dueDate;
        }
      }
      const futureTasks = task.dueDate
        ? insertFutureSorted(state.futureTasks, task)
        : [...state.futureTasks, task];
      return { ...state, futureTasks };
    }

    case "EDIT_TASK": {
      const text = action.text.trim();
      const inToday = state.todayTasks.some((t) => t.id === action.id);
      const inFuture = state.futureTasks.some((t) => t.id === action.id);
      if (!inToday && !inFuture) return state;
      if (inToday) {
        // 当日日程：可改名称、分组与完成百分比（隐藏的起止时间不显示、不可改）
        return {
          ...state,
          todayTasks: state.todayTasks.map((t) => {
            if (t.id !== action.id) return t;
            let next: Task = { ...t, text };
            if (action.group !== undefined) next.group = action.group ? action.group.trim() : null;
            if (action.progress !== undefined) next = applyProgress(next, action.progress);
            return next;
          }),
        };
      }
      // 未来日程：可改名称、分组、起始/截止日期与完成百分比
      let me: Task = { ...state.futureTasks.find((t) => t.id === action.id)! };
      me.text = text;
      if (action.group !== undefined) me.group = action.group ? action.group.trim() : null;
      if (action.startDate !== undefined) me.startDate = action.startDate || null;
      if (action.dueDate !== undefined) me.dueDate = action.dueDate || null;
      if (action.progress !== undefined) me = applyProgress(me, action.progress);
      const rest = state.futureTasks.filter((t) => t.id !== action.id);
      // 截止日期改成“今天或更早”时，视为到期，移入当日日程末尾
      if (me.dueDate && compareKeys(me.dueDate, state.currentDate) <= 0) {
        return {
          ...state,
          futureTasks: rest,
          todayTasks: [...state.todayTasks, me],
        };
      }
      return {
        ...state,
        futureTasks: me.dueDate ? insertFutureSorted(rest, me) : [...rest, me],
      };
    }

    case "DELETE_TASK": {
      // 直接永久删除（界面已有二次确认）
      return {
        ...state,
        todayTasks: state.todayTasks.filter((t) => t.id !== action.id),
        futureTasks: state.futureTasks.filter((t) => t.id !== action.id),
      };
    }

    case "TOGGLE_TODAY": {
      const now = new Date().toISOString();
      return {
        ...state,
        todayTasks: state.todayTasks.map((t) =>
          t.id === action.id
            ? { ...t, completed: !t.completed, completedAt: !t.completed ? now : null }
            : t
        ),
      };
    }

    case "COMPLETE_FUTURE": {
      // 未来日程打钩：立即归档进历史（保留其截止日期为计划日期）
      const task = state.futureTasks.find((t) => t.id === action.id);
      if (!task) return state;
      const archived: Task = {
        ...task,
        completed: true,
        completedAt: new Date().toISOString(),
        plannedDate: task.dueDate || state.currentDate,
        archivedAt: new Date().toISOString(),
      };
      return {
        ...state,
        futureTasks: state.futureTasks.filter((t) => t.id !== action.id),
        history: addToHistory(state.history, state.currentDate, archived),
      };
    }

    case "REORDER": {
      const source = action.section === "today" ? state.todayTasks : state.futureTasks;
      const arr = [...source];
      if (action.from < 0 || action.from >= arr.length) return state;
      const [item] = arr.splice(action.from, 1);
      const to = Math.max(0, Math.min(action.to, arr.length));
      arr.splice(to, 0, item);
      return action.section === "today"
        ? { ...state, todayTasks: arr }
        : { ...state, futureTasks: arr };
    }

    case "MOVE_TASK": {
      const inToday = state.todayTasks.some((t) => t.id === action.id);
      const inFuture = state.futureTasks.some((t) => t.id === action.id);
      if (!inToday && !inFuture) return state;
      const task = inToday
        ? state.todayTasks.find((t) => t.id === action.id)!
        : state.futureTasks.find((t) => t.id === action.id)!;
      const moved: Task = { ...task };
      if (action.to === "future") {
        // 拖往未来：设置/保留起始与截止日期（隐藏时间自动带出）
        moved.dueDate = action.dueDate || task.dueDate || null;
        moved.startDate =
          action.startDate !== undefined
            ? action.startDate || null
            : task.startDate || null;
        // 起始日期缺省默认次日
        if (!moved.startDate) moved.startDate = defaultStartDate(state.currentDate);
        if (moved.startDate && moved.dueDate && compareKeys(moved.startDate, moved.dueDate) > 0) {
          moved.startDate = moved.dueDate;
        }
      }
      // 跨组拖动：更新目标分组（undefined = 保持原分组）
      if (action.group !== undefined) moved.group = action.group ? action.group.trim() : null;
      // 拖往当日：保留起始/截止日期但不在当日显示（作为隐藏信息）
      const today = inToday ? state.todayTasks.filter((t) => t.id !== action.id) : [...state.todayTasks];
      const future = inFuture ? state.futureTasks.filter((t) => t.id !== action.id) : [...state.futureTasks];
      if (action.to === "today") {
        const idx = Math.max(0, Math.min(action.toIndex, today.length));
        today.splice(idx, 0, moved);
      } else {
        const idx = Math.max(0, Math.min(action.toIndex, future.length));
        future.splice(idx, 0, moved);
      }
      return { ...state, todayTasks: today, futureTasks: future };
    }

    case "MOVE_GROUP": {
      // 整组移动：把该分组的连续任务段搬到目标数组位置（目标位置落在本段内则忽略）
      const source = action.section === "today" ? state.todayTasks : state.futureTasks;
      const arr = [...source];
      const first = arr.findIndex((t) => (t.group ?? null) === action.group);
      if (first < 0) return state;
      let last = first;
      while (last + 1 < arr.length && (arr[last + 1].group ?? null) === action.group) last++;
      if (action.toIndex > first && action.toIndex <= last) return state; // 落点在本段内
      const seg = arr.splice(first, last - first + 1);
      let ins = action.toIndex;
      if (action.toIndex > first) ins = action.toIndex - seg.length;
      ins = Math.max(0, Math.min(ins, arr.length));
      arr.splice(ins, 0, ...seg);
      return action.section === "today"
        ? { ...state, todayTasks: arr }
        : { ...state, futureTasks: arr };
    }

    case "DELETE_GROUP": {
      // 删除分组：组内日程不删除，全部移到“未分组”段的末尾（无视原先后顺序）
      const source = action.section === "today" ? state.todayTasks : state.futureTasks;
      const others: Task[] = [];
      const moved: Task[] = [];
      for (const t of source) {
        if ((t.group ?? null) === action.group) moved.push({ ...t, group: null });
        else others.push(t);
      }
      if (!moved.length) return state;
      let lastNull = -1;
      others.forEach((t, i) => {
        if (t.group === null || t.group === undefined) lastNull = i;
      });
      // 插入到“未分组”段末尾；若当前没有未分组段则放到列表末尾（成为新的未分组段）
      const ins = lastNull >= 0 ? lastNull + 1 : others.length;
      const arr = [...others.slice(0, ins), ...moved, ...others.slice(ins)];
      return action.section === "today"
        ? { ...state, todayTasks: arr }
        : { ...state, futureTasks: arr };
    }

    case "END_DAY":
      return rollover(state, addDays(state.currentDate, 1));

    case "ROLLOVER_TO":
      return rollover(state, action.key);

    case "ROLLBACK_TO":
      return rollback(state, action.key);

    case "RESTORE": {
      const entry = state.history.find((h) => h.date === action.entryDate);
      if (!entry) return state;
      const task = entry.tasks.find((t) => t.id === action.id);
      if (!task) return state;
      const restored: Task = {
        ...task,
        completed: false,
        completedAt: null,
        plannedDate: null,
        archivedAt: null,
      };
      const history = removeFromHistory(state.history, action.entryDate, action.id);
      if (action.target === "today") {
        restored.dueDate = null;
        return { ...state, history, todayTasks: [...state.todayTasks, restored] };
      }
      restored.dueDate = action.dueDate || task.plannedDate || null;
      if (!restored.startDate) restored.startDate = defaultStartDate(state.currentDate);
      const futureTasks = restored.dueDate
        ? insertFutureSorted(state.futureTasks, restored)
        : [...state.futureTasks, restored];
      return { ...state, history, futureTasks };
    }

    case "DELETE_HISTORY_TASK":
      return {
        ...state,
        history: removeFromHistory(state.history, action.entryDate, action.id),
      };

    case "CLEAR_HISTORY":
      return { ...state, history: [] };

    case "SET_SETTINGS":
      return { ...state, settings: { ...state.settings, ...action.patch } };

    case "SET_TODAY_ANCHOR":
      return { ...state, todayAnchorId: action.id };

    default:
      return state;
  }
}

/**
 * 对外 reducer：任何变更后都做一次“组收敛”，保证同组在当日/未来列表内永远是连续一段
 * （例如把某组中间的任务移到别的组，原组会被重新聚拢，不会出现同名的两段）。
 */
export function reducer(state: AppData, action: Action): AppData {
  const next = reducerInner(state, action);
  const todayTasks = settleGroupList(next.todayTasks);
  const futureTasks = settleGroupList(next.futureTasks);
  if (todayTasks === next.todayTasks && futureTasks === next.futureTasks) return next;
  return { ...next, todayTasks, futureTasks };
}
