// 全局数据类型定义

/** 单条日程 */
export interface Task {
  id: string;
  text: string;
  createdAt: string; // ISO 时间
  /** 分组名；null = 未分组（分组功能关闭时仍保留该信息，仅不显示） */
  group: string | null;
  /**
   * 起始日期 YYYY-MM-DD（未来日程时间区间的起点，可选，不填默认创建日的下一天）。
   *  - 未来日程：与 dueDate 组成「起始-截止」区间
   *  - 拖入当日后作为隐藏信息保留，界面不显示
   */
  startDate: string | null;
  /** 截止日期 YYYY-MM-DD。
   *  - 未来日程：表示截止日期（始终 > currentDate）
   *  - 当日日程：若该日程从未来日程拖入，这里保留隐藏的截止时间（界面不显示）
   */
  dueDate: string | null;
  completed: boolean;
  completedAt: string | null;
  /** 完成百分比 0-100；null = 未设置（是否显示取决于设置开关） */
  progress: number | null;
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
  progressDefaultZero: boolean; // 未设置完成百分比的日程默认显示 0%
  autoScrollNextOnComplete: boolean; // 完成前置日程后自动滚动定位到下一未完成
  todayPaneRatio: number; // 当日/未来上下分区比例（0-1，当日区占比），拖动分割线调整
  showGroups: boolean; // 按分组显示日程（关闭不抹除日程的分组信息）
}

export interface AppData {
  version: number;
  /** 当前“当日”日期（用户可手动前进到第二天） */
  currentDate: string;
  todayTasks: Task[];
  futureTasks: Task[];
  history: HistoryEntry[];
  settings: Settings;
  /** 当日列表“置顶锚点”：完成前置日程后定位到的任务 id（用于重启后恢复位置） */
  todayAnchorId: string | null;
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
  progressDefaultZero: false,
  autoScrollNextOnComplete: false,
  todayPaneRatio: 0.45,
  showGroups: false,
};
