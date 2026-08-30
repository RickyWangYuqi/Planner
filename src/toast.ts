// 轻量 Toast：模块级事件，AppShell 中的 ToastHost 负责渲染
import { uid } from "./lib/id";

export type ToastKind = "info" | "success";

export interface ToastMsg {
  id: string;
  text: string;
  kind: ToastKind;
}

type Listener = (t: ToastMsg) => void;

let listener: Listener | null = null;

export function setToastListener(fn: Listener | null): void {
  listener = fn;
}

export function showToast(text: string, kind: ToastKind = "success"): void {
  listener?.({ id: uid(), text, kind });
}
