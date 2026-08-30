// 日期工具：统一使用本地时区的 YYYY-MM-DD 字符串作为“日期键”

const pad = (n: number) => String(n).padStart(2, "0");

/** Date -> YYYY-MM-DD（本地时区） */
export function toKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 今天 */
export function todayKey(): string {
  return toKey(new Date());
}

/** YYYY-MM-DD -> 本地零点 Date */
export function fromKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** 日期键加 n 天 */
export function addDays(key: string, n: number): string {
  const d = fromKey(key);
  d.setDate(d.getDate() + n);
  return toKey(d);
}

/** 比较两个日期键：a < b 返回 -1，相等 0，a > b 返回 1 */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 8月24日 */
export function formatMonthDay(key: string): string {
  const d = fromKey(key);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 8月24日 · 周三 */
export function formatFull(key: string): string {
  const d = fromKey(key);
  return `${formatMonthDay(key)} · ${WEEKDAYS[d.getDay()]}`;
}

/** 缩小卡片文案：8月24日日程 */
export function formatCard(key: string): string {
  return `${formatMonthDay(key)}日程`;
}

/** 校验日期键格式 */
export function isValidKey(key: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(key);
}
