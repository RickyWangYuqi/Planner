// 拖动排序：计算鼠标悬停的目标列表/分组与插入位置

export type DropTarget = { list: "today" | "future"; index: number; group: string | null; after: boolean; anchorId?: string };
export type GroupDropTarget = { list: "today" | "future"; index: number; kind: "group" };

export const TODAY_LIST_ID = "list-today";
export const FUTURE_LIST_ID = "list-future";

/** data-group 编码：'' 表示未分组（null） */
export const genc = (g: string | null) => g ?? "";
export const gdec = (v: string | null | undefined) => (v ? v : null);

const EDGE_PAD = 40; // 列表上下边界容差

type PreviewTarget = { list: "today" | "future"; index: number; group?: string | null; after?: boolean; anchorId?: string; kind?: "group" };
let indicator: HTMLElement | null = null;
let previewTarget: PreviewTarget | null = null;
let previewHeight = 56;
const previewAnimations = new Map<HTMLElement, Animation>();

/** 只读取布局坐标，隔离让位补间、浮起缩放和页面内的重排动画。 */
function layoutRect(row: HTMLElement, list: HTMLElement) {
  let top = 0;
  let node: HTMLElement | null = row;
  while (node && node !== list) {
    top += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  top += list.getBoundingClientRect().top + list.clientTop - list.scrollTop;
  return { top, bottom: top + row.offsetHeight, height: row.offsetHeight };
}

function previewRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(
    `#${TODAY_LIST_ID} [data-task-row], #${FUTURE_LIST_ID} [data-task-row], ` +
    `#${TODAY_LIST_ID} .group-header, #${FUTURE_LIST_ID} .group-header`
  ));
}

function cancelPreviewAnimations() {
  for (const animation of previewAnimations.values()) animation.cancel();
  previewAnimations.clear();
}

/** 布局一次到位，视觉单独补间；快速切换时从当前可见位置续接。 */
function changePreviewLayout(change: () => void, animate = true) {
  const rows = previewRows();
  const before = new Map(rows.map((row) => [row, row.getBoundingClientRect().top]));
  const oldList = indicator?.closest<HTMLElement>(".task-list");
  const oldScroll = oldList?.scrollTop ?? 0;
  const oldGap = indicator ? (parseFloat(getComputedStyle(indicator.parentElement!).rowGap) || 0) : 0;
  // 已滚过的空槽收起时补偿其高度，保持当前可见日程的位置。
  // 允许滚动到真实队尾；不能用起拖时的 scrollHeight 限制含空槽的列表。
  const removedAbove = indicator && oldList &&
    layoutRect(indicator, oldList).bottom + oldGap <= oldList.getBoundingClientRect().top
    ? indicator.offsetHeight + oldGap : 0;
  cancelPreviewAnimations();
  change();
  if (oldList && removedAbove) {
    const newGap = indicator ? (parseFloat(getComputedStyle(indicator.parentElement!).rowGap) || 0) : 0;
    const insertedAbove = indicator && oldList.contains(indicator) &&
      layoutRect(indicator, oldList).bottom + newGap <= oldList.getBoundingClientRect().top
      ? indicator.offsetHeight + newGap : 0;
    // 新旧槽都在视口上方时只补偿净变化，不能重复减去同一段空间。
    oldList.scrollTop = Math.max(0, oldScroll - removedAbove + insertedAbove);
  }
  // 在取消拖动的 overflow-anchor 保护仍生效时完成布局，避免下一帧重新找滚动锚点。
  const after = new Map(rows.map((row) => [row, row.getBoundingClientRect().top]));
  if (!animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (const row of rows) {
    const dy = before.get(row)! - after.get(row)!;
    if (Math.abs(dy) < 0.5) continue;
    const animation = row.animate(
      [{ translate: `0 ${dy}px` }, { translate: "0 0" }],
      { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
    );
    previewAnimations.set(row, animation);
    animation.onfinish = () => {
      if (previewAnimations.get(row) === animation) previewAnimations.delete(row);
    };
  }
}

/** 起拖时只记录槽的尺寸，后续滚动使用实际内容范围。 */
export function beginDropPreview(source: HTMLElement): void {
  clearDropIndicator();
  previewHeight = Math.max(44, source.offsetHeight) + 12;
}

/** 空槽内锁定完整落点（包括分组边界的归属），不受邻居让位影响。 */
function targetInPreview(list: HTMLElement, y: number): PreviewTarget | null {
  if (!indicator || !previewTarget || !list.contains(indicator)) return null;
  const r = layoutRect(indicator, list);
  return y >= r.top && y <= r.bottom ? previewTarget : null;
}

function groupOf(row: HTMLElement): string | null {
  return gdec(row.dataset.group);
}

/**
 * 任务级落点计算（插槽 = 两任务行之间的间隙，位置按“下一行中点”划分）：
 *  - 普通槽（同一组相邻 / 列表首尾）：任务插入该槽并归属其相邻组；
 *  - 组边界槽（上一组末行与下一组首行之间，中间有分组标题）：
 *      指针停在标题之内/之上 -> 归上方组（作为其最后一项，空槽位于上方组末行之后）；
 *      指针越过标题 -> 归下方组（作为其第一项，空槽位于下方组首行之前）。
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

    const held = targetInPreview(el, y);
    if (held) return { ...held, group: held.group ?? null, after: held.after ?? false };

    const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-task-row]"));
    const sourceIndex = rows.findIndex((row) => row.dataset.taskId === excludeId);
    const source = rows[sourceIndex];
    const sourceGroup = source?.parentElement;
    // 排除拖动项时不能把单条分组的原位也丢掉；隐藏分组没有 group-block，仍按普通列表排序。
    if (sourceGroup?.classList.contains("group-block") &&
        sourceGroup.querySelectorAll("[data-task-row]").length === 1) {
      const sr = layoutRect(source, el);
      const header = sourceGroup.querySelector<HTMLElement>(":scope > .group-header");
      const start = header ? layoutRect(header, el).bottom : sr.top;
      // 标题本身继续遵循相邻分组边界规则；仅有这一项时，同列表空白也属于原组。
      if (rows.length === 1 || ((header ? y > start : y >= start) && y <= sr.bottom)) {
        return { list, index: sourceIndex, group: groupOf(source), after: false, anchorId: source.dataset.taskId };
      }
    }
    const rowsEx = rows.filter((row) => row.dataset.taskId !== excludeId);
    const rectsEx = rowsEx.map((row) => layoutRect(row, el));
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
        const hr = layoutRect(header, el);
        // 指针在分组标题之内或之上 -> 归上方组（成为其最后一项，空槽在组内末行之后）；
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
 * 分组头级落点计算：返回目标分组首项或列表末尾的数组位置（基于全部行序）。
 * 初次在本组起拖返回 null；已经展开后回到本组则保留原组入口的槽。
 */
export function computeGroupDropTarget(
  listEl: HTMLElement,
  y: number,
  dragGroup: string | null
): GroupDropTarget | null {
  const held = targetInPreview(listEl, y);
  if (held) return { list: held.list, index: held.index, kind: "group" };
  const rows = Array.from(listEl.querySelectorAll<HTMLElement>("[data-task-row]"));
  const rects = rows.map((row) => layoutRect(row, listEl));
  let index = rows.length;
  for (let i = 0; i < rows.length; i++) {
    if (y < rects[i].top + rects[i].height / 2) {
      index = i;
      break;
    }
  }
  if (index < rows.length) {
    const rowGroup = gdec(rows[index].dataset.group);
    if (rowGroup === dragGroup) {
      // 初次原位起拖无需展开；已经让位后保留原组入口，避免收槽后同坐标改判。
      if (!previewTarget) return null;
    }
    // 整组只能落在完整分组之间，不能把组内某一行的位置用于预览和提交。
    index = rows.findIndex((row) => groupOf(row) === rowGroup);
  }
  return { list: listEl.id === FUTURE_LIST_ID ? "future" : "today", index, kind: "group" };
}

/**
 * 在最终插入位置展开空槽。槽只表示位置，不复制文字；提示始终位于浮卡下方。
 * 相同落点复用已有槽，避免反复插入 DOM 或重启动画。
 */
export function showDropIndicator(
  target: PreviewTarget | null,
  excludeId: string | null = null
): void {
  if (!target) {
    hideDropIndicator();
    return;
  }
  if (previewTarget && target.list === previewTarget.list && target.index === previewTarget.index &&
      target.group === previewTarget.group && target.after === previewTarget.after &&
      target.anchorId === previewTarget.anchorId && target.kind === previewTarget.kind) return;
  const el = document.getElementById(target.list === "today" ? TODAY_LIST_ID : FUTURE_LIST_ID);
  if (!el) return;
  const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-task-row]"));
  const rowsEx = rows.filter((row) => row.dataset.taskId !== excludeId);
  changePreviewLayout(() => {
    indicator?.closest(".task-list")?.classList.remove("drop-preview-list");
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.className = "drop-indicator";
      indicator.setAttribute("aria-hidden", "true");
      indicator.style.height = `${previewHeight}px`;
    }
    indicator.remove();
    if (target.kind === "group") {
      // 整组槽在分组块外，标题与组内日程一起让位，预览才与最终组序一致。
      const block = rows[target.index]?.closest<HTMLElement>(".group-block");
      el.insertBefore(indicator, block ?? null);
    } else {
      const after = target.after || target.index >= rowsEx.length;
      const row = rowsEx[Math.max(0, Math.min(target.index - (after ? 1 : 0), rowsEx.length - 1))];
      const anchor = target.anchorId ? rows.find((item) => item.dataset.taskId === target.anchorId) : undefined;
      // 原单条分组已经没有其它任务可作参照，必须明确把槽放回源行所在分组。
      if (anchor) anchor.parentElement!.insertBefore(indicator, anchor);
      else if (row) row.parentElement!.insertBefore(indicator, after ? row.nextSibling : row);
      else el.appendChild(indicator);
    }
    el.classList.add("drop-preview-list");
    previewTarget = { ...target };
  });
}

function hideDropIndicator(animate = true) {
  if (!indicator) return;
  changePreviewLayout(() => {
    indicator!.closest(".task-list")?.classList.remove("drop-preview-list");
    indicator!.remove();
    indicator = null;
    previewTarget = null;
  }, animate);
}

export function clearDropIndicator(animate = false): void {
  hideDropIndicator(animate);
  if (!animate) cancelPreviewAnimations();
  previewTarget = null;
}

/** 拖动时向列表上下边缘移动才自动滚动，避免边缘行起拖、横移或向内移动时误滚。 */
export function autoScrollList(x: number, y: number, deltaY: number): void {
  for (const id of [TODAY_LIST_ID, FUTURE_LIST_ID]) {
    const el = document.getElementById(id);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (y < r.top || y > r.bottom || x < r.left || x > r.right) continue;
    const zone = 42;
    if (deltaY < 0 && y < r.top + zone) el.scrollTop -= 12;
    else if (deltaY > 0 && y > r.bottom - zone) el.scrollTop += 12;
  }
}
