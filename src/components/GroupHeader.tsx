// 分组标题：显示组名，可按住拖动整组（把整组任务搬到其它组之前）；悬停可删除分组
import { useRef, useState } from "react";
import { useApp } from "../store";
import {
  autoScrollList,
  clearDropIndicator,
  computeGroupDropTarget,
  showDropIndicator,
} from "../drag";
import { ConfirmModal } from "./ui";
import { IconTrash } from "./icons";

export function GroupHeader({
  section,
  group,
  listId,
}: {
  section: "today" | "future";
  group: string | null;
  listId: string;
}) {
  const { state, dispatch } = useApp();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const dragState = useRef<{
    x: number;
    y: number;
    dragging: boolean;
    ghost: HTMLElement | null;
    offX: number;
    offY: number;
    index: number;
  } | null>(null);

  const moveGhost = (e: PointerEvent) => {
    const ds = dragState.current;
    if (!ds?.ghost) return;
    ds.ghost.style.left = `${e.clientX - ds.offX}px`;
    ds.ghost.style.top = `${e.clientY - ds.offY}px`;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return; // 删除按钮
    e.preventDefault();
    const x = e.clientX;
    const y = e.clientY;
    dragState.current = { x, y, dragging: false, ghost: null, offX: 0, offY: 0, index: -1 };

    const startDrag = (ev: PointerEvent) => {
      const el = ref.current;
      if (!el) return;
      document.body.classList.add("is-dragging");
      el.classList.add("dragging");
      const r = el.getBoundingClientRect();
      const ghost = el.cloneNode(true) as HTMLElement;
      ghost.classList.remove("dragging");
      ghost.classList.add("drag-ghost", "group-ghost");
      ghost.style.width = `${r.width}px`;
      document.body.appendChild(ghost);
      const ds = dragState.current!;
      ds.ghost = ghost;
      ds.offX = ev.clientX - r.left;
      ds.offY = ev.clientY - r.top;
      moveGhost(ev);
    };

    const onMove = (ev: PointerEvent) => {
      const ds = dragState.current;
      if (!ds) return;
      if (!ds.dragging && Math.hypot(ev.clientX - ds.x, ev.clientY - ds.y) > 6) {
        ds.dragging = true;
        startDrag(ev);
      }
      if (!ds.dragging) return;
      moveGhost(ev);
      const listEl = document.getElementById(listId);
      if (!listEl) return;
      const target = computeGroupDropTarget(listEl, ev.clientY, group);
      ds.index = target ? target.index : -1;
      showDropIndicator(target, null);
      autoScrollList(ev.clientX, ev.clientY);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const ds = dragState.current;
      clearDropIndicator();
      document.body.classList.remove("is-dragging");
      ref.current?.classList.remove("dragging");
      if (ds?.ghost) ds.ghost.remove();
      dragState.current = null;
      if (ds?.dragging && ds.index >= 0) {
        dispatch({ type: "MOVE_GROUP", section, group, toIndex: ds.index });
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const groupCount = (section === "today" ? state.todayTasks : state.futureTasks).filter(
    (t) => (t.group ?? null) === group
  ).length;

  return (
    <>
      <div
        ref={ref}
        className="group-header"
        data-group-header
        onPointerDown={onPointerDown}
        title="按住拖动可整体调整分组顺序"
      >
        <span className="group-grip">⠿</span>
        <span className="group-name">{group ?? "未分组"}</span>
        {group !== null && (
          <button
            type="button"
            className="group-del"
            data-no-drag
            aria-label="删除分组"
            title="删除分组（组内日程移至未分组）"
            onClick={() => setConfirmDelete(true)}
          >
            <IconTrash size={12} />
          </button>
        )}
      </div>
      {confirmDelete && (
        <ConfirmModal
          title="删除分组"
          message={`确定删除分组“${group}”吗？该分组的 ${groupCount} 条日程不会被删除，将移入“未分组”的末尾。`}
          confirmText="删除分组"
          danger
          onConfirm={() => {
            dispatch({ type: "DELETE_GROUP", section, group });
            setConfirmDelete(false);
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
}
