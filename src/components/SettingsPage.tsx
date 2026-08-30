// 设置界面
import { useApp } from "../store";
import { PRESETS } from "../lib/themes";
import { BackButton, Segmented, SwitchRow } from "./ui";
import { IconCalendar } from "./icons";

export function SettingsPage({
  onBack,
  onOpenHistory,
}: {
  onBack: () => void;
  onOpenHistory: () => void;
}) {
  const { state, dispatch } = useApp();
  const s = state.settings;
  const set = (patch: Partial<typeof s>) => dispatch({ type: "SET_SETTINGS", patch });

  const historyCount = state.history.reduce((n, h) => n + h.tasks.length, 0);

  return (
    <div className="page-settings">
      <div className="page-head">
        <BackButton onClick={onBack} />
        <h1 className="page-title">设置</h1>
      </div>

      {/* 功能开关 */}
      <section className="settings-section">
        <h3 className="settings-section-title">功能开关</h3>
        <div className="card">
          <SwitchRow
            title="窗口置顶"
            desc="始终显示在其他窗口之上"
            checked={s.alwaysOnTop}
            onChange={(v) => set({ alwaysOnTop: v })}
          />
          <div className="card-sep" />
          <SwitchRow
            title="全屏时自动隐藏"
            desc="检测到任意应用进入全屏（看视频 / 玩游戏）时自动隐藏，退出全屏后恢复"
            checked={s.autoHideFullscreen}
            onChange={(v) => set({ autoHideFullscreen: v })}
          />
          <div className="card-sep" />
          <SwitchRow
            title="失去焦点自动缩小"
            desc="窗口失焦后缩小为小卡片，鼠标悬浮自动展开，点击后保持"
            checked={s.shrinkOnBlur}
            onChange={(v) => set({ shrinkOnBlur: v })}
          />
          <div className="card-sep" />
          <SwitchRow
            title="自动编号"
            desc="当日与未来日程分别从 1 开始编号，拖动排序后自动重排"
            checked={s.autoNumber}
            onChange={(v) => set({ autoNumber: v })}
          />
        </div>
      </section>

      {/* 外观主题 */}
      <section className="settings-section">
        <h3 className="settings-section-title">外观主题</h3>
        <div className="card">
          <div className="settings-label">主题模式</div>
          <Segmented
            options={[
              { value: "light", label: "浅色" },
              { value: "dark", label: "深色" },
              { value: "system", label: "跟随系统" },
            ]}
            value={s.themeMode}
            onChange={(v) => set({ themeMode: v })}
          />
          <div className="card-sep" />
          <div className="settings-label">配色预设</div>
          <div className="preset-grid">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`preset-card ${s.colorPreset === p.id ? "selected" : ""}`}
                onClick={() => set({ colorPreset: p.id })}
              >
                <span className="preset-dots">
                  <span className="preset-dot" style={{ background: p.light.bg, borderColor: p.light.accent }}>
                    <i style={{ background: p.light.accent }} />
                  </span>
                  <span className="preset-dot" style={{ background: p.dark.bg, borderColor: p.dark.accent }}>
                    <i style={{ background: p.dark.accent }} />
                  </span>
                </span>
                <span className="preset-name">{p.name}</span>
                <span className="preset-desc">{p.desc}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* 数据与历史 */}
      <section className="settings-section">
        <h3 className="settings-section-title">数据与历史</h3>
        <div className="card">
          <button type="button" className="history-entry" onClick={onOpenHistory}>
            <span className="history-entry-icon">
              <IconCalendar size={16} />
            </span>
            <span className="history-entry-text">
              <span className="history-entry-title">历史日程</span>
              <span className="history-entry-desc">
                {historyCount > 0 ? `共 ${historyCount} 条记录，支持恢复或删除` : "暂无历史记录"}
              </span>
            </span>
            <span className="history-entry-arrow">›</span>
          </button>
        </div>
      </section>

      {/* 其他 */}
      <section className="settings-section">
        <h3 className="settings-section-title">其他</h3>
        <div className="card">
          <div className="settings-label">关闭窗口时</div>
          <Segmented
            options={[
              { value: "exit", label: "退出程序" },
              { value: "tray", label: "最小化到系统托盘" },
            ]}
            value={s.closeAction}
            onChange={(v) => set({ closeAction: v })}
          />
          <div className="card-sep" />
          <SwitchRow
            title="开机启动"
            desc="登录 Windows 时自动启动本程序"
            checked={s.launchAtStartup}
            onChange={(v) => set({ launchAtStartup: v })}
          />
        </div>
        <p className="settings-footnote">Planer 日程便签 v1.0.0 · 数据保存在本地，自动保存</p>
      </section>
    </div>
  );
}
