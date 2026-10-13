# Planer 项目协作约定

## README 维护规则（必须遵守）

- **大的功能添加或行为改动** —— 新增功能、既有功能行为变化、交互/界面结构变化、设置项增删、构建或测试方式变化 —— **必须同步更新 `README.md`** 的对应描述，让文档与实现保持一致。
- **bug 修复、缺陷修补不需要修改 `README.md`**；不改变使用方式的内部重构、注释、格式化、性能优化同样不需要。
- 更新时的写法约定：
  - 功能描述写进「功能一览」下对应小节（日程 / 历史日程 / 日程显示设置 / 窗口行为 / 外观与页面），从使用者视角描述行为，不写实现细节。
  - 新增或调整设置项时，要在「日程显示设置」「窗口行为」表格里标注**默认值**。
  - 测试脚本用例数量变化时，同步更新「测试」小节的数字（数字 = 脚本中 `assert(` 调用数）。
  - 环境要求、构建与运行命令变化时，更新「开发」小节。

## 环境

- Node.js ≥ 22（本机验证 v24.20.0 LTS），npm 随 Node 自带（Node 24 对应 npm 11）。
- 技术栈：Tauri 2 + React 18 + TypeScript + Vite；数据存于 `%APPDATA%\com.planer.app\data.json`。

## 常用命令

```bash
npm install
npm run tauri dev                    # 前端开发（配合 src-tauri）
npm run tauri build                  # 构建发布版（含 NSIS 安装包）
node scripts/test-reducer.mjs        # 业务逻辑单元测试
node scripts/test-e2e.mjs            # UI 端到端测试（需先 npm run build）
node scripts/test-shrink.mjs         # 缩小卡片周期 + 窗口缩放验证（需真实应用）
node scripts/test-resize-guard.mjs   # 调整大小防误缩验证（需真实应用）
```

## 代码与提交

- 代码注释、提交信息使用中文；提交信息概述本次改动要点。
