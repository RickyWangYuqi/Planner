// 全局数据类型定义

/** 单条日程 */
export interface Task {
  id: string;
  text: string;
  createdAt: string; // ISO 时间
  /** 截止日期 YYYY-MM-DD。
   *  - 未来日程：表示截止日期（始终 > currentDate）
   *  - 当日日程：若该日程从未来日程拖入，这里保留隐藏的截止时间（界面不显示）
   */
  dueDate: string | null;
  completed: boolean;
  completedAt: string | null;
  /** 历史记录字段：归档时该日程原本属于哪一天（YYYY-MM-DD） */
  plannedDate?: string | null;
  /** 历史记录字段：归档时间 */
  archivedAt?: string | null;
}

/** 历史日程条目：按日期分组 */
export interface HistoryEntry {
  /** 归档当天日期 YYYY-MM-DD */
  date: string;
  tasks: Task[];
}

export type ThemeMode = "light" | "dark" | "system";
export type ColorPreset = "seasalt" | "forest" | "sunset" | "ink";
export type CloseAction = "exit" | "tray";

export interface Settings {
  alwaysOnTop: boolean; // 窗口置顶
  autoHideFullscreen: boolean; // 全屏自动隐藏
  autoNumber: boolean; // 自动编号
  shrinkOnBlur: boolean; // 失去焦点自动缩小
  themeMode: ThemeMode; // 浅色 / 深色 / 跟随系统
  colorPreset: ColorPreset; // 配色预设
  closeAction: CloseAction; // 关闭行为
  launchAtStartup: boolean; // 开机启动
}

export interface AppData {
  version: number;
  /** 当前“当日”日期（用户可手动前进到第二天） */
  currentDate: string;
  todayTasks: Task[];
  futureTasks: Task[];
  history: HistoryEntry[];
  settings: Settings;
}

export const DEFAULT_SETTINGS: Settings = {
  alwaysOnTop: false,
  autoHideFullscreen: false,
  autoNumber: true,
  shrinkOnBlur: false,
  themeMode: "system",
  colorPreset: "seasalt",
  closeAction: "exit",
  launchAtStartup: false,
};
