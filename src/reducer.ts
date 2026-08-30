// 状态 reducer：所有数据变更的纯函数
import type { AppData, Task } from "./types";
import { uid } from "./lib/id";
import { addDays, compareKeys } from "./lib/dates";
import { addToHistory, insertFutureSorted, removeFromHistory, rollback, rollover } from "./lib/data";

export type Action =
  | { type: "LOAD"; data: AppData }
  | { type: "ADD_TASK"; section: "today" | "future"; text: string; dueDate?: string | null }
  | { type: "EDIT_TASK"; id: string; text: string; dueDate?: string | null }
  | { type: "DELETE_TASK"; id: string }
  | { type: "TOGGLE_TODAY"; id: string }
  | { type: "COMPLETE_FUTURE"; id: string }
  | { type: "REORDER"; section: "today" | "future"; from: number; to: number }
  | { type: "MOVE_TASK"; id: string; to: "today" | "future"; toIndex: number; dueDate?: string | null }
  | { type: "END_DAY" }
  | { type: "ROLLOVER_TO"; key: string }
  | { type: "ROLLBACK_TO"; key: string }
  | { type: "RESTORE"; entryDate: string; id: string; target: "today" | "future"; dueDate?: string | null }
  | { type: "DELETE_HISTORY_TASK"; entryDate: string; id: string }
  | { type: "CLEAR_HISTORY" }
  | { type: "SET_SETTINGS"; patch: Partial<AppData["settings"]> };

export function reducer(state: AppData, action: Action): AppData {
  switch (action.type) {
    case "LOAD":
      return action.data;

    case "ADD_TASK": {
      const task: Task = {
        id: uid(),
        text: action.text.trim(),
        createdAt: new Date().toISOString(),
        dueDate: action.dueDate || null,
        completed: false,
        completedAt: null,
      };
      if (action.section === "today") {
        return { ...state, todayTasks: [...state.todayTasks, task] };
      }
      // 未来日程：默认按截止日期升序插入
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
        // 当日日程：只允许修改名称（即使带隐藏截止时间也不显示、不改动）
        return {
          ...state,
          todayTasks: state.todayTasks.map((t) => (t.id === action.id ? { ...t, text } : t)),
        };
      }
      // 未来日程：可改名称与截止日期
      const me = { ...state.futureTasks.find((t) => t.id === action.id)! };
      me.text = text;
      if (action.dueDate !== undefined) me.dueDate = action.dueDate || null;
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
        // 拖往未来：设置/保留截止日期（隐藏的截止时间自动带出）
        moved.dueDate = action.dueDate || task.dueDate || null;
      }
      // 拖往当日：保留截止日期但不在当日显示（作为隐藏截止时间）
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

    default:
      return state;
  }
}
