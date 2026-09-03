// 拖动排序：计算鼠标悬停的目标列表/分组与插入位置

export type DropTarget = { list: "today" | "future"; index: number; group: string | null; after: boolean };
export type GroupDropTarget = { list: "today" | "future"; index: number };

export const TODAY_LIST_ID = "list-today";
export const FUTURE_LIST_ID = "list-future";

/** data-group 编码：'' 表示未分组（null） */
export const genc = (g: string | null) => g ?? "";
export const gdec = (v: string | null | undefined) => (v ? v : null);

const EDGE_PAD = 40; // 列表上下边界容差

function groupOf(row: HTMLElement): string | null {
  return gdec(row.dataset.group);
}

/**
 * 任务级落点计算（插槽 = 两任务行之间的间隙，位置按“下一行中点”划分）：
 *  - 普通槽（同一组相邻 / 列表首尾）：任务插入该槽并归属其相邻组；
 *  - 组边界槽（上一组末行与下一组首行之间，中间有分组标题）：
 *      指针停在标题上半/更贴近上方组 -> 归上方组（作为其最后一项，蓝条贴上方组末行下方）；
 *      指针停在标题下半/更贴近下方组 -> 归下方组（作为其第一项，蓝条贴下方组首行上方）。
 * @param excludeId 正在拖动的任务 id（index 基于“排除它之后的行序”）
 */
export function computeDropTarget(
  x: number,
  y: number,
  excludeId: string | null
): DropTarget | null {
  const lists: Array<{ list: "today" | "future"; el: HTMLElement | null }> = [
    { list: "today", el: document.getElementById(TODAY_LIST_ID) },
    { list: "future", el: document.getElementById(FUTURE_LIST_ID) },
  ];
  for (const { list, el } of lists) {
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const inX = x >= r.left && x <= r.right;
    const inY = y >= r.top - EDGE_PAD && y <= r.bottom + EDGE_PAD;
    if (!inX || !inY) continue;

    const rowsEx = Array.from(el.querySelectorAll<HTMLElement>("[data-task-row]")).filter(
      (row) => row.dataset.taskId !== excludeId
    );
    const rectsEx = rowsEx.map((row) => row.getBoundingClientRect());
    if (rowsEx.length === 0) return { list, index: 0, group: null, after: false };

    // 主插槽：指向第一个“中点低于指针”的行之前；都不满足则为队尾
    let slot = rowsEx.length;
    for (let i = 0; i < rowsEx.length; i++) {
      if (y < rectsEx[i].top + rectsEx[i].height / 2) {
        slot = i;
        break;
      }
    }

    // 组边界：slot 行与上一行不同组（中间有分组标题）
    if (slot > 0 && slot < rowsEx.length && groupOf(rowsEx[slot - 1]) !== groupOf(rowsEx[slot])) {
      const below = rowsEx[slot];
      const header = below.parentElement?.querySelector<HTMLElement>(":scope > .group-header");
      if (header) {
        const hr = header.getBoundingClientRect();
        // 指针在分组标题之内或之上 -> 归上方组（成为其最后一项，蓝条贴上方组末行下方）；
        // 越过分组标题（贴近下方组首行）-> 归下方组（成为其第一项）
        if (y <= hr.bottom) {
          return { list, index: slot, group: groupOf(rowsEx[slot - 1]), after: true };
        }
      }
      // 贴下方组：作为下方组第一项
      return { list, index: slot, group: groupOf(rowsEx[slot]), after: false };
    }

    if (slot === rowsEx.length) {
      // 队尾
      return { list, index: slot, group: groupOf(rowsEx[rowsEx.length - 1]), after: true };
    }
    return { list, index: slot, group: groupOf(rowsEx[slot]), after: false };
  }
  return null;
}

/**
 * 分组头级落点计算：返回“把整组搬到该行之前”的数组位置（基于全部行序）。
 * 指针落在本组任务行内时返回 null（无意义移动）。
 */
export function computeGroupDropTarget(
  listEl: HTMLElement,
  y: number,
  dragGroup: string | null
): GroupDropTarget | null {
  const rows = Array.from(listEl.querySelectorAll<HTMLElement>("[data-task-row]"));
  const rects = rows.map((row) => row.getBoundingClientRect());
  let index = rows.length;
  for (let i = 0; i < rows.length; i++) {
    if (y < rects[i].top + rects[i].height / 2) {
      index = i;
      break;
    }
  }
  if (index < rows.length) {
    const rowGroup = gdec(rows[index].dataset.group);
    if (rowGroup === dragGroup) return null;
  }
  return { list: listEl.id === FUTURE_LIST_ID ? "future" : "today", index };
}

let indicator: HTMLElement | null = null;

/**
 * 显示插入指示线（绝对定位，不参与布局、不会引起列表抖动）。
 * after = true：贴目标行（上方行 / 队尾末行）下缘显示；
 * after = false：贴目标行上缘显示。
 */
export function showDropIndicator(
  target: { list: "today" | "future"; index: number; after?: boolean } | null,
  excludeId: string | null = null
): void {
  if (!target) {
    clearDropIndicator();
    return;
  }
  const el = document.getElementById(target.list === "today" ? TODAY_LIST_ID : FUTURE_LIST_ID);
  if (!el) return;
  const rowsEx = Array.from(el.querySelectorAll<HTMLElement>("[data-task-row]")).filter(
    (row) => row.dataset.taskId !== excludeId
  );
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.className = "drop-indicator";
    el.appendChild(indicator);
  }
  const lr = el.getBoundingClientRect();
  if (rowsEx.length === 0) {
    indicator.style.top = "4px";
    return;
  }
  let top = 0;
  if (target.after) {
    const idx = Math.max(0, Math.min(target.index - 1, rowsEx.length - 1));
    const rr = rowsEx[idx].getBoundingClientRect();
    top = rr.bottom - lr.top + 2; // 贴该行下缘
  } else {
    const idx = Math.max(0, Math.min(target.index, rowsEx.length - 1));
    const rr = rowsEx[idx].getBoundingClientRect();
    top = rr.top - lr.top - 3; // 贴该行上缘
  }
  indicator.style.top = `${Math.max(0, Math.round(top))}px`;
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
