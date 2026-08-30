import type { ColorPreset } from "../types";

export interface PresetMeta {
  id: ColorPreset;
  name: string;
  desc: string;
  light: { bg: string; accent: string };
  dark: { bg: string; accent: string };
}

/** 四套配色预设（每套含浅色 / 深色版本） */
export const PRESETS: PresetMeta[] = [
  {
    id: "seasalt",
    name: "海盐",
    desc: "清爽蓝调",
    light: { bg: "#eef3fa", accent: "#2e7cf6" },
    dark: { bg: "#0e1524", accent: "#4d94ff" },
  },
  {
    id: "forest",
    name: "森林",
    desc: "自然绿意",
    light: { bg: "#f1f7f0", accent: "#2f9e5f" },
    dark: { bg: "#0e1712", accent: "#46c07d" },
  },
  {
    id: "sunset",
    name: "日落",
    desc: "温暖橘橙",
    light: { bg: "#fdf4ee", accent: "#f05f3c" },
    dark: { bg: "#1a1210", accent: "#ff7a55" },
  },
  {
    id: "ink",
    name: "墨影",
    desc: "石墨紫调",
    light: { bg: "#f5f5f8", accent: "#6d5df0" },
    dark: { bg: "#131318", accent: "#8f83f5" },
  },
];

/** 根据主题模式与系统偏好，解析出实际使用的浅/深色 */
export function resolveTheme(mode: string, prefersDark: boolean): "light" | "dark" {
  if (mode === "system") return prefersDark ? "dark" : "light";
  return mode === "dark" ? "dark" : "light";
}
