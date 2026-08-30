// 拖动排序：计算鼠标悬停的目标列表与插入位置
export type DropTarget = { list: "today" | "future"; index: number };

export const TODAY_LIST_ID = "list-today";
export const FUTURE_LIST_ID = "list-future";

/**
 * 根据指针坐标计算插入目标。
 * 列表上下各留 40px 容差：即使指针越出列表边界（完全越过最后一张卡片后继续拖），
 * 仍视为该列表的末尾/开头，避免“拖到末尾反而不生效”的困惑。
 * @param excludeId 正在拖动的任务 id（计算同列表插入位置时跳过它自身）
 */
export function computeDropTarget(
  x: number,
  y: number,
  excludeId: string | null
): DropTarget | null {
  const PAD = 40;
  const lists: Array<{ list: "today" | "future"; el: HTMLElement | null }> = [
    { list: "today", el: document.getElementById(TODAY_LIST_ID) },
    { list: "future", el: document.getElementById(FUTURE_LIST_ID) },
  ];
  for (const { list, el } of lists) {
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const inX = x >= r.left && x <= r.right;
    const inY = y >= r.top - PAD && y <= r.bottom + PAD;
    if (!inX || !inY) continue;
    const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-task-row]")).filter(
      (row) => row.dataset.taskId !== excludeId
    );
    let index = rows.length;
    if (y < r.top) {
      // 列表上方容差区：插入到开头
      index = 0;
    } else {
      for (let i = 0; i < rows.length; i++) {
        const rr = rows[i].getBoundingClientRect();
        if (y < rr.top + rr.height / 2) {
          index = i;
          break;
        }
      }
    }
    return { list, index };
  }
  return null;
}

let indicator: HTMLElement | null = null;

/**
 * 在目标列表的指定位置显示插入指示线。
 * 必须与 computeDropTarget 保持一致的索引语义：都要排除被拖动的行，
 * 否则蓝条位置与最终落位会错位（例如蓝条显示在“某日程上方”却插入其下方）。
 * @param excludeId 被拖动的任务 id（与 computeDropTarget 的 excludeId 一致）
 */
export function showDropIndicator(target: DropTarget | null, excludeId: string | null = null): void {
  if (indicator) {
    indicator.remove();
    indicator = null;
  }
  if (!target) return;
  const el = document.getElementById(target.list === "today" ? TODAY_LIST_ID : FUTURE_LIST_ID);
  if (!el) return;
  const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-task-row]")).filter(
    (row) => row.dataset.taskId !== excludeId
  );
  indicator = document.createElement("div");
  indicator.className = "drop-indicator";
  const before = rows[target.index];
  if (before) el.insertBefore(indicator, before);
  else el.appendChild(indicator);
}

export function clearDropIndicator(): void {
  if (indicator) {
    indicator.remove();
    indicator = null;
  }
}

/** 拖动时靠近列表上下边缘自动滚动 */
export function autoScrollList(x: number, y: number): void {
  for (const id of [TODAY_LIST_ID, FUTURE_LIST_ID]) {
    const el = document.getElementById(id);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (y < r.top || y > r.bottom || x < r.left || x > r.right) continue;
    const zone = 42;
    if (y < r.top + zone) el.scrollTop -= 12;
    else if (y > r.bottom - zone) el.scrollTop += 12;
  }
}
