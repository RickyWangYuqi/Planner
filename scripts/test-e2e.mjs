// 端到端 UI 测试：用 puppeteer-core + 系统 Chrome 驱动 dist 构建产物
// 运行（需先 npm run build）：node scripts/test-e2e.mjs
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import puppeteer from "puppeteer-core";

const DIST = join(process.cwd(), "dist");
const PORT = 4173;
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

// ---------- 静态服务器 ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || "/").split("?")[0]);
    if (p === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (p.endsWith("/")) p += "index.html";
    const file = normalize(join(DIST, p));
    if (!file.startsWith(normalize(DIST))) {
      res.writeHead(403);
      res.end();
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

// ---------- 测试辅助 ----------
let passed = 0;
let failed = 0;
const errors = [];
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    errors.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
function keyOf(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
function fmt(d) {
  return `${d.getMonth() + 1}月${d.getDate()}日 · ${WEEK[d.getDay()]}`;
}
const today = new Date();
const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
const threeDays = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 3);
const TODAY_KEY = keyOf(today);
const TOMORROW_KEY = keyOf(tomorrow);
// 测试中会点「选择日期」前进一天（currentDate = 明天），
// 因此未来日程的截止日期选择器最小值为「后天」，这里选「+3 天」确保可选且回退时能被放回未来
const FUTURE_KEY = keyOf(threeDays);

let page;
let browser;
const consoleErrors = [];

async function text(sel) {
  const el = await page.$(sel);
  return el ? (await el.evaluate((e) => e.textContent.trim())) : null;
}
async function count(sel) {
  return (await page.$$(sel)).length;
}

async function openAdd(section, name = "") {
  const buttons = await page.$$(".add-btn");
  await buttons[section].click();
  await page.waitForSelector(".modal-panel");
  if (name) await page.type(".modal-panel .input:not(.group-input)", name);
}

async function closeModal(save = false) {
  await page.click(`.modal-actions .btn.${save ? "primary" : "ghost"}`);
  await page.waitForFunction(() => !document.querySelector(".modal-panel"));
  await sleep(160); // 等待保存防抖，供后续断言读取 mock 数据
}

async function clickGroup(name) {
  await page.$$eval(".group-chips button", (buttons, n) => {
    const target = buttons.find((button) => button.textContent.trim() === n);
    if (!target) throw new Error(`未找到分组 ${n}`);
    target.click();
  }, name);
}

async function groupPoint(name) {
  const chip = await page.evaluateHandle((n) =>
    [...document.querySelectorAll(".group-chip")].find((item) => item.textContent.trim() === n), name);
  const element = chip.asElement();
  if (!element) throw new Error(`未找到分组 ${name}`);
  await element.scrollIntoView();
  const rect = await element.boundingBox();
  await chip.dispose();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

async function pressGroup(name) {
  const point = await groupPoint(name);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  return point;
}

async function holdGroup(name) {
  await pressGroup(name);
  await sleep(650);
  await page.mouse.up();
}

async function hasGroup(name) {
  return page.$$eval(".group-chip", (chips, n) => chips.some((chip) => chip.textContent.trim() === n), name);
}

async function openGroupCreate() {
  await page.click(".group-new-btn");
  await page.waitForFunction(() => {
    const input = document.querySelector(".group-input");
    const shell = document.querySelector(".group-create-shell");
    return input && !input.disabled && !shell?.getAnimations().some((animation) => animation.playState === "running");
  });
}

async function createGroup(name, keyboard = false) {
  await openGroupCreate();
  await page.type(".group-input", name);
  if (keyboard) await page.keyboard.press("Enter");
  else await page.click(".group-create .btn");
  await page.waitForFunction(() => !document.querySelector(".group-create"));
}

async function editTask(name) {
  await page.$$eval(".task-row", (rows, n) => {
    const row = rows.find((item) => item.querySelector(".task-text")?.textContent.trim() === n);
    if (!row) throw new Error(`未找到日程 ${n}`);
    row.querySelector('[aria-label="编辑"]').click();
  }, name);
  await page.waitForSelector(".modal-panel");
}

/** 只读取隔离的 Tauri mock 保存记录，不访问应用的真实数据文件。 */
async function savedTasks() {
  return page.evaluate(() => {
    const data = window.__E2E_SAVED__;
    return [...data.todayTasks, ...data.futureTasks];
  });
}

async function toggleGroups() {
  await goToSettings();
  await page.$$eval(".switch-row", (rows) => {
    rows.find((row) => row.querySelector(".switch-row-title")?.textContent === "按分组显示日程")
      .querySelector(".switch").click();
  });
  await backToMain();
}

async function modalFitsViewport() {
  return page.$eval(".modal-panel", (panel) => {
    const rect = panel.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight + 1 && rect.left >= 0 && rect.right <= innerWidth + 1 &&
      panel.scrollWidth <= panel.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth;
  });
}

async function addTask(section, name, dateKey) {
  const addBtns = await page.$$(".add-btn");
  await addBtns[section].click();
  await page.waitForSelector(".modal-panel");
  await page.type(".input", name);
  if (dateKey) {
    // 未来日程弹窗有两个内联日历：第 0 个 = 起始日期（可空），第 1 个 = 截止日期
    const pickers = await page.$$(".modal-panel .datepicker.inline");
    const duePicker = pickers[pickers.length - 1];
    const day = await duePicker.$(`.dp-day[data-date="${dateKey}"]`);
    if (!day) throw new Error(`截止日期 ${dateKey} 在日历中不可见`);
    await day.click();
  }
  await page.click(".modal-actions .btn.primary");
  await page.waitForFunction(() => !document.querySelector(".modal-panel"));
}

async function dragRow(rowSelector, targetSelector) {
  const box = await page.$eval(rowSelector, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const tb = await page.$eval(targetSelector, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + 12, { steps: 6 });
  await page.mouse.move(tb.x, tb.y, { steps: 12 });
  await page.mouse.up();
  await sleep(300);
}

/** 在指定列表里按文字找到任务行并拖到目标列表 */
async function dragTaskByText(listSelector, textMatch, targetSelector) {
  const idx = await page.evaluate(
    (sel, t) => {
      const rows = [...document.querySelectorAll(`${sel} .task-row`)];
      return rows.findIndex((r) => r.textContent.includes(t));
    },
    listSelector,
    textMatch
  );
  if (idx < 0) throw new Error(`dragTaskByText: 未找到 "${textMatch}"`);
  await dragRow(`${listSelector} .task-row:nth-child(${idx + 1})`, targetSelector);
}

/** 打开「选择日期」弹窗并选一个日期 */
async function pickDate(dateKey) {
  await page.click(".date-jump-btn");
  await page.waitForSelector(".modal-panel");
  await page.click(`.dp-day[data-date="${dateKey}"]`);
  await page.waitForFunction(() => !document.querySelector(".modal-panel"));
  await sleep(250);
}

/** 从设置/历史页返回主页面（循环点返回，兼容二级页与退场动画） */
async function backToMain() {
  for (let i = 0; i < 4; i++) {
    const state = await page.evaluate(() => ({
      hasBack: !!document.querySelector(".back-btn"),
      hasMain: !!document.querySelector(".page-main"),
    }));
    if (!state.hasBack || state.hasMain) break; // 已回到主页面
    await page.click(".back-btn");
    await sleep(400); // 等滑动动画结束（退场页面会短暂留在 DOM）
  }
  await page.waitForSelector(".page-main");
  await sleep(350);
}

/** 进设置页（等滑动动画结束） */
async function goToSettings() {
  await page.click(".icon-btn.gear");
  await page.waitForSelector(".page-title");
  await sleep(350);
}

/** 进历史页 */
async function goToHistory() {
  await page.click(".history-entry");
  await page.waitForSelector(".page-history");
  await sleep(350);
}

// ---------- 主流程 ----------
try {
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`serving ${DIST} on :${PORT}`);

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 460, height: 760 });

  // 屏蔽 Tauri 原生调用（测试环境无 IPC）
  await page.evaluateOnNewDocument(() => {
    window.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main" },
        currentWebviewWindow: { label: "main" },
      },
      transformCallback: (cb, once) => {
        if (once) setTimeout(() => cb?.(), 0);
        return 1;
      },
      invoke: async (command, args) => {
        if (command === "load_data") {
          const saved = sessionStorage.getItem("planer-e2e-data");
          window.__E2E_SAVED__ = saved ? JSON.parse(saved) : undefined;
          return window.__E2E_SAVED__ ?? null;
        }
        if (command === "save_data") {
          window.__E2E_SAVED__ = structuredClone(args.data);
          sessionStorage.setItem("planer-e2e-data", JSON.stringify(args.data));
        }
        return undefined;
      },
    };
  });

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".titlebar-title");
  await sleep(400);

  console.log("1) 初始界面");
  assert((await text(".titlebar-title")) === "Planer 日程便签", "标题栏显示应用名");
  assert(await count(".section-title") === 2, "有当日/未来两个区块");
  assert(await count(".empty-hint") === 2, "两个空状态提示");
  assert(await count(".date-jump-btn") === 1, "存在「选择日期」按钮");

  console.log("2) 添加当日日程 + 自动编号");
  await addTask(0, "写周报");
  await addTask(0, "买咖啡");
  assert(await count(".task-row") === 2, "当日有 2 条任务");
  assert((await text(".task-row:nth-child(1) .task-num")) === "1", "第一条编号 1");
  assert((await text(".task-row:nth-child(2) .task-num")) === "2", "第二条编号 2");

  console.log("3) 打钩完成");
  await page.click(".task-row:nth-child(1) .task-check");
  await sleep(200);
  assert(await count(".task-row.done") === 1, "完成的任务有删除线样式");

  console.log("4) 选择日期：切换到明天");
  await pickDate(TOMORROW_KEY);
  assert((await text(".date-main")) === fmt(tomorrow), "日期前进到明天");
  assert(await count("#list-today .task-row") === 1, "已完成归档、未完成顺延");
  assert((await text(".task-row .task-text")) === "买咖啡", "顺延的是未完成任务");

  console.log("5) 历史：弹窗恢复（原计划日期已过）");
  await goToSettings();
  await goToHistory();
  assert(await count(".history-row") === 1, "历史 1 条（写周报）");
  await page.click(".history-row .icon-btn");
  await page.waitForSelector(".modal-panel");
  assert((await text(".modal-title")) === "恢复日程", "弹出恢复选择弹窗");
  await page.click(".restore-seg .segmented-item:first-child"); // 恢复到今天
  await page.click(".modal-actions .btn.primary");
  await sleep(300);
  await backToMain();
  assert(await count("#list-today .task-row") === 2, "恢复到当日日程（买咖啡 + 写周报）");

  console.log("6) 添加未来日程 + 截止日期");
  await addTask(1, "医院体检", FUTURE_KEY);
  assert(await count("#list-future .task-row") === 1, "未来列表 1 条");
  assert(await count("#list-future .due-chip") === 1, "显示截止日期标签");

  console.log("7) 跨区拖动：未来 -> 当日（保留隐藏截止时间）");
  await dragTaskByText("#list-future", "医院体检", "#list-today");
  assert(await count("#list-today .task-row") === 3, "任务移入当日");
  assert(await count("#list-future .task-row") === 0, "未来列表清空");
  assert(await count("#list-today .due-chip") === 0, "当日不显示截止日期");

  console.log("8) 跨区拖动：当日 -> 未来（弹窗设置截止日期）");
  await dragTaskByText("#list-today", "医院体检", "#list-future");
  await page.waitForSelector(".modal-panel");
  assert((await text(".modal-title")) === "移动到未来日程", "弹出截止日期设置");
  assert((await text(".modal-body"))?.includes("已自动填入"), "隐藏截止时间自动带出");
  await page.click(".modal-actions .btn.primary");
  await sleep(300);
  assert(await count("#list-future .task-row") === 1, "任务回到未来列表");
  assert(await count("#list-today .task-row") === 2, "当日剩 2 条");

  console.log("9) 编辑规则：当日任务不显示日期区间 + 设置完成进度");
  await page.click("#list-today .task-row .icon-btn:first-of-type");
  await page.waitForSelector(".modal-panel");
  assert(await count(".modal-panel .datepicker") === 0, "当日编辑不显示日期选择器");
  assert(await count(".modal-panel .progress-field") === 1, "当日编辑含完成进度控件");
  // 打开进度开关并设置 75%
  await page.click(".progress-field .switch");
  await sleep(200);
  await page.$$eval(".progress-field-actions .mini-chip", (els) => {
    const target = els.find((e) => e.textContent.trim() === "75%");
    if (target) target.click();
  });
  await page.click(".modal-actions .btn.primary");
  await sleep(350);
  assert((await text("#list-today .task-row .progress-pct")) === "75%", "行内显示进度 75%");
  assert(await count("#list-today .task-row.done") === 0, "设 75% 后该行不是完成样式");

  console.log("10) 设置页：主题切换与自动编号");
  await goToSettings();
  assert(await count(".switch-row") === 8, "开关共 8 项（功能 7 + 开机启动 1）");
  const segs = await page.$$(".segmented");
  await segs[0].$$eval(".segmented-item", (els) => els[1].click());
  await sleep(200);
  assert(
    (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark",
    "主题切到深色"
  );
  await segs[0].$$eval(".segmented-item", (els) => els[2].click());
  await sleep(200);
  const themeNow = await page.evaluate(() => document.documentElement.dataset.theme);
  assert(themeNow === "light" || themeNow === "dark", "跟随系统解析出有效模式");
  await page.$$eval(".preset-card", (els) => els[1].click());
  await sleep(200);
  assert(
    (await page.evaluate(() => document.documentElement.dataset.preset)) === "forest",
    "配色切到森林"
  );
  const switches = await page.$$(".switch-row .switch");
  await page.$$eval(".switch-row .switch", (els) => els[3].click()); // 自动编号 关
  await sleep(200);
  await backToMain();
  assert(await count(".task-num") === 0, "关闭自动编号后不显示序号");
  await goToSettings();
  await page.$$eval(".switch-row .switch", (els) => els[3].click()); // 自动编号 开
  await sleep(200);
  await backToMain();

  console.log("11) 全部完成 -> 不再自动切换");
  await page.click("#list-today .task-row:nth-child(1) .task-check");
  await page.click("#list-today .task-row:nth-child(2) .task-check");
  await sleep(2600);
  assert(await count("#list-today .task-row") === 2, "任务仍在当日（不自动切换）");
  assert(await count("#list-today .task-row.done") === 2, "全部为完成样式");
  assert((await text(".date-main")) === fmt(tomorrow), "日期仍为明天");
  assert((await count(".toast")) === 0, "无自动切换提示");

  console.log("12) 选择日期：回退到今天（更晚任务放回未来）");
  await pickDate(TODAY_KEY);
  assert((await text(".date-main")) === fmt(today), "日期回到今天");
  assert(await count("#list-future .task-row") === 1, "体检（截止 +3 天）放回未来");
  assert(await count("#list-today .task-row") === 2, "无截止日期的留在当日");

  console.log("13) 历史：原计划日期=今天 -> 直接恢复（无弹窗）");
  // 从今天前进到明天：归档已完成的 2 条（plannedDate = 今天）
  await pickDate(TOMORROW_KEY);
  assert(await count("#list-today .task-row") === 0, "已完成全部归档，当日为空");
  // 回退到今天
  await pickDate(TODAY_KEY);
  assert(await count("#list-today .task-row") === 0, "回退后当日为空");
  assert(await count("#list-future .task-row") === 1, "体检仍在未来列表");
  await goToSettings();
  await goToHistory();
  assert(await count(".history-row") === 2, "历史 2 条（plannedDate = 今天）");
  await page.click(".history-row:nth-child(1) .icon-btn");
  await sleep(300);
  assert(await count(".modal-panel") === 0, "无弹窗（原计划日期=今天直接恢复）");
  await backToMain();
  assert(await count("#list-today .task-row") === 1, "恢复后当日 1 条");
  // 清空历史
  await goToSettings();
  await goToHistory();
  assert(await count(".history-row") === 1, "历史剩 1 条");
  await page.click(".btn.ghost.danger-text");
  await page.waitForSelector(".modal-panel");
  await page.click(".modal-actions .btn.danger");
  await sleep(300);
  assert(await count(".history-group") === 0, "清空历史后无分组");
  assert((await text(".empty-state"))?.includes("暂无历史日程"), "显示空状态");

  console.log("14) 分组关闭时沿用原有新增和编辑表单");
  await backToMain();
  const restoredName = await text("#list-today .task-text");
  await openAdd(0);
  assert(await count(".group-picker") === 0, "分组关闭时当日新增不显示分组控件");
  await closeModal();
  await openAdd(1);
  assert(await count(".group-picker") === 0, "分组关闭时未来新增不显示分组控件");
  await closeModal();
  await editTask(restoredName);
  assert(await count(".group-picker") === 0, "分组关闭时编辑不显示分组控件");
  await closeModal();

  console.log("15) 当日新增：创建分组即选中，提交前保留为草稿");
  await toggleGroups();
  await openAdd(0, "阅读一本书");
  assert((await text(".group-chip.active")) === "未分组", "新增默认选中未分组");
  assert(await count(".group-create") === 0, "创建输入区按需展开");
  const beforeNewTask = JSON.stringify(await savedTasks());
  await openGroupCreate();
  await page.type(".group-input", "  ");
  assert(await page.$eval(".group-create .btn", (button) => button.disabled), "空白分组名不能创建");
  await page.type(".group-input", "学习  ");
  await page.click(".group-create .btn");
  await page.waitForFunction(() => !document.querySelector(".group-create"));
  assert((await text(".group-chip.active")) === "学习" && await count(".group-create") === 0,
    "创建后立刻出现新组、选中它并收起输入区");
  assert((await text(".group-selection"))?.includes("已创建并选中") &&
    (await text(".group-picker"))?.includes("随日程一起保存"), "明确反馈创建成功及随日程保存");
  await sleep(180);
  assert(JSON.stringify(await savedTasks()) === beforeNewTask, "创建分组尚未提交时不会写入日程数据");
  await clickGroup("学习");
  assert((await text(".group-chip.active")) === "未分组", "再次点选当前组可回到未分组");
  await clickGroup("学习");
  assert((await text(".group-chip.active")) === "学习", "新建的草稿分组仍能再次选中");
  await mkdir(join(process.cwd(), ".test"), { recursive: true });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.dataset.preset = "seasalt";
  });
  await sleep(300); // 等主题过渡结束后截图，避免颜色混合
  await page.screenshot({ path: join(process.cwd(), ".test", "groups-add-today.png") });
  await closeModal(true);
  assert((await savedTasks()).find((task) => task.text === "阅读一本书")?.group === "学习",
    "新增当日日程保存所选分组");
  assert(await page.$$eval("#list-today .group-header", (headers) => headers.some((header) => header.textContent.includes("学习"))),
    "保存后主列表显示新分组");

  console.log("16) 未来新增：复用已有分组与原有日期校验");
  await openAdd(1, "准备分享");
  await openGroupCreate();
  await page.type(".group-input", " 学习 ");
  assert((await text(".group-create .btn")) === "选用分组", "输入已有分组名时提示选用分组");
  await page.click(".group-create .btn");
  assert(await page.$$eval(".group-chip", (chips) => chips.filter((chip) => chip.textContent.trim() === "学习").length) === 1 &&
    (await text(".group-chip.active")) === "学习", "重名复用同一分组且不重复显示");
  assert(await page.$eval(".modal-actions .btn.primary", (button) => button.disabled), "选好分组后仍须填写未来截止日期");
  await page.$$eval(`.modal-panel .datepicker.inline .dp-day[data-date="${FUTURE_KEY}"]`, (days) => days.at(-1).click());
  await closeModal(true);
  const addedFuture = (await savedTasks()).find((task) => task.text === "准备分享");
  assert(addedFuture?.group === "学习" && addedFuture?.dueDate === FUTURE_KEY, "未来新增同时保存分组和截止日期");

  console.log("17) 编辑：取消不写入，回车创建不会提前保存日程");
  await editTask("阅读一本书");
  assert((await text(".group-chip.active")) === "学习", "编辑预选日程现有分组");
  const beforeEdit = JSON.stringify(await savedTasks());
  await createGroup("工作安排");
  await closeModal();
  assert(JSON.stringify(await savedTasks()) === beforeEdit, "取消编辑不会改变原分组或创建持久分组");
  await editTask("阅读一本书");
  assert(!(await text(".group-chips"))?.includes("工作安排"), "重新打开不出现已取消的草稿分组");
  await createGroup("阅读计划", true);
  assert(await count(".modal-panel") === 1 && (await text(".group-chip.active")) === "阅读计划" &&
    JSON.stringify(await savedTasks()) === beforeEdit, "回车创建只选择新组，不触发保存日程");
  await closeModal(true);
  assert((await savedTasks()).find((task) => task.text === "阅读一本书")?.group === "阅读计划", "保存编辑后更新为新组");

  console.log("18) 新增取消及未分组保存");
  const beforeCancelAdd = JSON.stringify(await savedTasks());
  await openAdd(0, "不会保存的日程");
  await createGroup("临时安排");
  await closeModal();
  assert(JSON.stringify(await savedTasks()) === beforeCancelAdd, "取消新增既不添加日程也不保留草稿分组");
  await openAdd(0, "散步");
  assert(!(await text(".group-chips"))?.includes("临时安排"), "下次新增不会出现取消的分组");
  await clickGroup("学习");
  await clickGroup("学习");
  await closeModal(true);
  assert((await savedTasks()).find((task) => task.text === "散步")?.group === null, "取消选中后按未分组保存");

  console.log("19) 隐藏分组保留现有信息，新增仍为未分组");
  await toggleGroups();
  await editTask("阅读一本书");
  await closeModal(true);
  assert((await savedTasks()).find((task) => task.text === "阅读一本书")?.group === "阅读计划", "隐藏分组后编辑仍保留原分组");
  await openAdd(0, "隐藏分组时新增");
  await closeModal(true);
  assert((await savedTasks()).find((task) => task.text === "隐藏分组时新增")?.group === null, "隐藏分组时新增默认未分组");
  await toggleGroups();

  console.log("20) 长分组名与小窗口：未来表单可滚动、不横向溢出");
  await openAdd(1, "制定学习计划");
  await createGroup("这是一个用来验证长名称换行与小窗口显示的学习分组");
  assert(await modalFitsViewport(), "460×760 下未来分组表单不超出窗口");
  await page.waitForFunction(() => !document.querySelector(".toast"));
  await page.$eval(".modal-panel", (panel) => { panel.scrollTop = 0; });
  await page.screenshot({ path: join(process.cwd(), ".test", "groups-add-future.png") });
  await page.setViewport({ width: 380, height: 520 });
  await sleep(220);
  assert(await modalFitsViewport(), "380×520 下长分组名不会造成水平溢出");
  await page.screenshot({ path: join(process.cwd(), ".test", "groups-add-future-narrow.png") });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await sleep(300);
  await page.screenshot({ path: join(process.cwd(), ".test", "groups-add-future-dark.png") });
  await openGroupCreate();
  await page.type(".group-input", "每周阅读");
  await page.screenshot({ path: join(process.cwd(), ".test", "groups-create-narrow.png") });
  await page.click('[aria-label="取消新建分组"]');
  await page.$eval(".modal-actions", (actions) => actions.scrollIntoView({ block: "end" }));
  assert(await page.$eval(".modal-actions", (actions) => {
    const rect = actions.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight + 1;
  }), "小窗口仍能滚动到添加与取消按钮");
  await page.screenshot({ path: join(process.cwd(), ".test", "groups-add-future-actions.png") });
  await closeModal();

  console.log("21) 分组标签：居中文字、短按选择与长按删除模式");
  await page.setViewport({ width: 460, height: 760 });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await openAdd(0, "分组手势验证");
  const chipAppearance = await page.$$eval(".group-chip", (chips) => chips.map((chip) => {
    const label = chip.querySelector("span");
    const bounds = chip.getBoundingClientRect();
    const labelBounds = label?.getBoundingClientRect();
    return {
      centered: !!labelBounds && Math.abs(labelBounds.left + labelBounds.width / 2 - bounds.left - bounds.width / 2) < 1.5,
      icon: !!chip.querySelector("svg"),
      active: chip.classList.contains("active"),
      background: getComputedStyle(chip).backgroundColor,
    };
  }));
  assert(chipAppearance.every((chip) => chip.centered && !chip.icon), "分组标签文字居中且选中、未选中均无勾号");
  assert(chipAppearance.find((chip) => chip.active)?.background !== chipAppearance.find((chip) => !chip.active)?.background,
    "选中分组通过底色与其他标签区分");
  await pressGroup("学习");
  await sleep(70);
  await page.mouse.up();
  await sleep(650);
  assert((await text(".group-chip.active")) === "学习" && await count(".group-chip-delete") === 0,
    "短按正常选择且释放后不会延迟进入删除模式");
  await clickGroup("未分组");
  const moveOrigin = await pressGroup("学习");
  await page.mouse.move(moveOrigin.x + 26, moveOrigin.y + 1, { steps: 3 });
  await sleep(650);
  await page.mouse.up();
  assert(await count(".group-chip-delete") === 0, "按住后移动会取消长按计时");
  await pressGroup("学习");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await sleep(650);
  await page.mouse.up();
  assert(await count(".group-chip-delete") === 0, "窗口失焦会取消尚未触发的长按");
  await clickGroup("未分组");
  await holdGroup("学习");
  assert(await count(".group-chip-delete") === 1 && (await text(".group-chip.active")) === "未分组",
    "长按只让目标标签进入删除模式，不会误改当前选择");
  assert((await text(".group-selection"))?.includes("再次点击分组标签可取消删除"),
    "删除模式明确提示再次点击标签可取消删除");
  const cancelDeletePoint = await groupPoint("学习");
  await page.mouse.click(cancelDeletePoint.x, cancelDeletePoint.y);
  assert(await count(".group-chip-delete") === 0 && (await text(".group-chip.active")) === "未分组" &&
    !(await text(".group-selection"))?.includes("再次点击分组标签可取消删除"),
    "再次点击退出删除模式、收起提示且不改变原选择");
  await holdGroup("学习");
  await page.keyboard.press("Escape");
  assert(await count(".group-chip-delete") === 0 && await count(".modal-panel") === 1,
    "Escape 退出删除模式并保留当前表单");
  await holdGroup("学习");
  await page.click(".modal-title");
  assert(await count(".group-chip-delete") === 0, "点击标签外可退出删除模式");
  await holdGroup("未分组");
  assert(await count(".group-chip-delete") === 0, "未分组标签长按也不可删除");
  await closeModal();

  console.log("22) 草稿分组删除：退场动画、不持久化与小窗口显示");
  await openAdd(0, "草稿分组删除验证");
  await createGroup("保留草稿");
  await createGroup("待删除草稿");
  const beforeDraftDelete = JSON.stringify(await savedTasks());
  await holdGroup("待删除草稿");
  const deleteAppearance = await page.$eval(".group-chip-delete", (button) => {
    const style = getComputedStyle(button);
    const chip = button.parentElement.querySelector(".group-chip");
    return {
      buttonBackground: style.backgroundColor,
      buttonColor: style.color,
      borderColor: getComputedStyle(chip).borderColor,
      animated: button.parentElement.getAnimations({ subtree: true }).length > 0,
    };
  });
  assert(deleteAppearance.animated && deleteAppearance.buttonBackground !== "rgba(0, 0, 0, 0)",
    "删除模式有轻摇动画与可辨识的叉号背景");
  await page.screenshot({ path: join(process.cwd(), ".test", "groups-delete-ready.png") });
  await page.setViewport({ width: 380, height: 520 });
  await sleep(200);
  assert(await modalFitsViewport(), "删除模式在小窗口中不造成横向溢出");
  await page.screenshot({ path: join(process.cwd(), ".test", "groups-delete-narrow.png") });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await sleep(300);
  await page.screenshot({ path: join(process.cwd(), ".test", "groups-delete-dark.png") });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.setViewport({ width: 460, height: 760 });
  await sleep(300);
  await page.click(".group-chip-delete");
  const deletionMotion = await page.evaluate(() => {
    const chip = [...document.querySelectorAll(".group-chip")].find((item) => item.textContent.trim() === "待删除草稿");
    const animation = chip?.parentElement.getAnimations({ subtree: true });
    return { present: !!chip, nonlinear: animation?.some((item) => item.effect.getTiming().easing !== "linear") };
  });
  assert(deletionMotion.present && deletionMotion.nonlinear, "点击删除后先播放非线性退场动画，不会瞬间移除标签");
  await sleep(60);
  await page.screenshot({ path: join(process.cwd(), ".test", "groups-delete-midpoint.png") });
  await sleep(500);
  assert(!(await hasGroup("待删除草稿")) && await hasGroup("保留草稿") && (await text(".group-chip.active")) === "未分组",
    "删除选中草稿后回到未分组，其他草稿标签仍保留");
  assert(JSON.stringify(await savedTasks()) === beforeDraftDelete, "删除尚未保存的草稿分组不会改动持久数据");
  await closeModal();

  console.log("23) 删除未选中的已有分组：跨列表解绑，取消表单不撤销");
  await openAdd(0, "跨列表删除验证");
  await clickGroup("学习");
  await closeModal(true);
  const tasksBeforeGroupDelete = await savedTasks();
  const learningBeforeDelete = tasksBeforeGroupDelete.filter((task) => task.group === "学习");
  assert(learningBeforeDelete.length === 2, "删除前同一分组同时有当日日程和未来日程");
  await editTask("阅读一本书");
  await page.$eval(".modal-panel .input:not(.group-input)", (input) => input.select());
  await page.type(".modal-panel .input:not(.group-input)", "取消后不应保存的文字");
  await holdGroup("学习");
  await page.click(".group-chip-delete");
  await sleep(550);
  assert((await text(".group-chip.active")) === "阅读计划" && !(await hasGroup("学习")),
    "删除未选中组时保留原选择并移除被删组标签");
  const afterGroupDelete = await savedTasks();
  assert(learningBeforeDelete.every((before) => afterGroupDelete.find((task) => task.id === before.id)?.group === null),
    "删除已有分组会把当日与未来中该组的所有日程转为未分组");
  assert(afterGroupDelete.length === tasksBeforeGroupDelete.length &&
    afterGroupDelete.some((task) => task.text === "阅读一本书" && task.group === "阅读计划"),
    "删除分组保留任务及其他分组");
  await closeModal();
  const cancelledEditTasks = await savedTasks();
  assert(!cancelledEditTasks.some((task) => task.group === "学习") &&
    cancelledEditTasks.some((task) => task.text === "阅读一本书") &&
    !cancelledEditTasks.some((task) => task.text === "取消后不应保存的文字"),
    "取消编辑不撤销已经完成的分组删除，也不保存文字草稿");
  await openAdd(0);
  assert(!(await hasGroup("学习")), "下次打开分组选择器不会重新出现被删组");
  await closeModal();

  console.log("24) 编辑自身所在单条分组：删除后弹窗、输入与保存不丢失");
  await editTask("阅读一本书");
  await page.$eval(".modal-panel .input:not(.group-input)", (input) => input.select());
  await page.type(".modal-panel .input:not(.group-input)", "保留编辑草稿的阅读日程");
  const beforeOwnGroupDelete = await savedTasks();
  const editingId = beforeOwnGroupDelete.find((task) => task.text === "阅读一本书").id;
  await holdGroup("阅读计划");
  await page.click(".group-chip-delete");
  await sleep(550);
  assert(await count(".modal-panel") === 1 &&
    await page.$eval(".modal-panel .input:not(.group-input)", (input) => input.value) === "保留编辑草稿的阅读日程",
    "删除当前任务所属单条分组后弹窗仍在且未保存文字不丢失");
  assert((await text(".group-chip.active")) === "未分组" && !(await hasGroup("阅读计划")),
    "删除自身所选分组后同步选择未分组");
  await closeModal(true);
  const afterOwnGroupDelete = await savedTasks();
  assert(afterOwnGroupDelete.find((task) => task.id === editingId)?.text === "保留编辑草稿的阅读日程" &&
    afterOwnGroupDelete.find((task) => task.id === editingId)?.group === null &&
    !afterOwnGroupDelete.some((task) => task.group === "阅读计划"),
    "保存编辑只更新原任务且不会复活刚刚删除的分组");
  assert(afterOwnGroupDelete.length === beforeOwnGroupDelete.length, "删除分组并保存不会丢失或重复日程");

  console.log("25) 删除边界：回车不能重选退场分组，减少动态效果无残留");
  await openAdd(0, "删除边界验证");
  await createGroup("退场中不可重选");
  await openGroupCreate();
  await page.type(".group-input", "退场中不可重选");
  await page.$$eval(".group-chip", (chips) => {
    chips.find((chip) => chip.textContent.trim() === "退场中不可重选").focus();
  });
  await page.keyboard.press("Delete");
  await page.click(".group-chip-delete");
  // 在同一退场窗口内触发输入框键盘路径，确保不会被按钮 disabled 掩盖。
  const enteredDuringExit = await page.$eval(".group-input", (input) => {
    const exiting = !!document.querySelector(".group-chip-wrap.is-removing");
    const disabled = document.querySelector(".group-create .btn").disabled;
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return exiting && disabled;
  });
  await sleep(500);
  assert(enteredDuringExit && !(await hasGroup("退场中不可重选")) &&
    (await text(".group-chip.active")) === "未分组" && await count(".group-create") === 1,
    "删除退场期间在同名输入框回车，不会重新选中或复活分组");
  await page.click('[aria-label="取消新建分组"]');
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await createGroup("减少动态效果验证");
  await holdGroup("减少动态效果验证");
  const reducedDeleteMode = await page.$eval(".group-chip-wrap.is-delete-mode", (wrapper) => {
    const chip = wrapper.querySelector(".group-chip");
    const remove = wrapper.querySelector(".group-chip-delete");
    return !!remove && getComputedStyle(chip).animationName === "none" &&
      getComputedStyle(remove).animationName === "none";
  });
  assert(reducedDeleteMode, "减少动态效果时仍可进入删除模式，但标签不抖动、叉号不弹入");
  await page.click(".group-chip-delete");
  await sleep(80);
  assert(!(await hasGroup("减少动态效果验证")) && await count(".group-chip-wrap.is-removing") === 0 &&
    await count(".group-chip-delete") === 0 && (await text(".group-chip.active")) === "未分组",
    "减少动态效果时删除即时完成，未留下退场标签或删除按钮");
  await page.emulateMediaFeatures([]);
  await closeModal();

  console.log("26) 分组创建动画：输入区出入、标签加入与快速开关");
  await openAdd(0, "分组动画草稿");
  await page.click(".group-new-btn");
  const createEntrance = await page.$eval(".group-picker", (picker) => {
    const input = picker.querySelector(".group-input");
    const animations = picker.getAnimations({ subtree: true });
    return {
      ready: input && !input.disabled && document.activeElement === input,
      nonlinear: animations.some((animation) => animation.effect.getTiming().easing !== "linear" ||
        animation.effect.getKeyframes().some((frame) => frame.easing !== "linear")),
    };
  });
  assert(createEntrance.ready && createEntrance.nonlinear, "展开创建区有非线性动画，输入框可直接输入并获得焦点");
  await page.waitForFunction(() => !document.querySelector(".group-create-shell").getAnimations().some((animation) => animation.playState === "running"));
  await page.type(".group-input", "关闭期间不可创建");
  await page.click('[aria-label="取消新建分组"]');
  const closeMotion = await page.$eval(".group-picker", (picker) => {
    const input = picker.querySelector(".group-input");
    const buttons = [...picker.querySelectorAll(".group-create button")];
    const animations = picker.getAnimations({ subtree: true });
    const pending = !!input;
    if (input) input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return {
      pending,
      disabled: !!input?.disabled && buttons.every((button) => button.disabled),
      nonlinear: animations.some((animation) => animation.effect.getTiming().easing !== "linear" ||
        animation.effect.getKeyframes().some((frame) => frame.easing !== "linear")),
    };
  });
  assert(closeMotion.pending && closeMotion.disabled && closeMotion.nonlinear,
    "取消新建先播放非线性退场，退出期间输入与按钮已禁用");
  await page.waitForFunction(() => !document.querySelector(".group-create"));
  assert(!(await hasGroup("关闭期间不可创建")) && (await text(".group-chip.active")) === "未分组" &&
    await count(".modal-panel") === 1, "退场期间回车既不创建标签，也不提交日程或关闭表单");
  // 同一个事件帧内连点，覆盖动画尚未完成时取消、重新展开的计时竞争。
  await page.$eval(".group-new-btn", (button) => button.click());
  await page.waitForSelector(".group-input");
  await page.type(".group-input", "快速取消的名称");
  await page.$eval('[aria-label="取消新建分组"]', (button) => button.click());
  await page.$eval(".group-new-btn", (button) => button.click());
  await sleep(450);
  assert(await count(".group-create") === 1 && await page.$eval(".group-input", (input) => !input.disabled && input.value === "") &&
    await page.$eval(".group-new-btn", (button) => button.getAttribute("aria-expanded") === "true"),
    "退出期间重新展开只有一个可用输入区，旧计时器不会将其误收起");
  await page.type(".group-input", "新增动画验证标签");
  await page.click(".group-create .btn");
  const chipEntrance = await page.evaluate(() => {
    const chip = [...document.querySelectorAll(".group-chip")].find((item) => item.textContent.trim() === "新增动画验证标签");
    const wrapper = chip?.parentElement;
    const entrance = wrapper?.getAnimations({ subtree: true }).some((animation) => {
      const frames = animation.effect.getKeyframes();
      const nonlinear = animation.effect.getTiming().easing !== "linear" || frames.some((frame) => frame.easing !== "linear");
      return nonlinear && frames.some((frame) => "opacity" in frame || "scale" in frame || "transform" in frame);
    });
    return { entrance, neighborMotion: document.querySelector(".group-new-btn").getAnimations().length > 0 };
  });
  assert(chipEntrance.entrance && chipEntrance.neighborMotion, "新增标签平滑淡入、缩放，相邻新建按钮同步让位");
  await sleep(65);
  await page.screenshot({ path: join(process.cwd(), ".test", "groups-create-midpoint.png") });
  await page.waitForFunction(() => !document.querySelector(".group-create"));
  await sleep(320);
  assert((await text(".group-chip.active")) === "新增动画验证标签" && await modalFitsViewport(),
    "新增动画结束后标签保持选中，输入区完全移除且布局无溢出");
  await closeModal();
  assert(await page.evaluate(() => !(window.__E2E_SAVED__.groups ?? []).some((group) =>
    ["新增动画验证标签", "关闭期间不可创建", "快速取消的名称"].includes(group))),
    "取消整个表单不保存动画过程中创建或放弃的草稿分组");
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await openAdd(0);
  await page.click(".group-new-btn");
  await page.type(".group-input", "减少动态新增验证");
  await page.click(".group-create .btn");
  await sleep(80);
  assert(await hasGroup("减少动态新增验证") && await count(".group-create") === 0 &&
    await page.$eval(".group-chips", (chips) => !chips.getAnimations({ subtree: true }).some((animation) =>
      animation.effect.getKeyframes().some((frame) => ["opacity", "scale", "translate", "height", "transform"].some((key) => key in frame)))),
    "减少动态效果时新增与收起即时完成，不残留标签或容器动画");
  await closeModal();
  await page.emulateMediaFeatures([]);

  console.log("27) 已保存空分组：移空后保留、重新加载复用与显式删除");
  await openAdd(0, "保留空组当日日程");
  await createGroup("移动后保留的分组");
  await closeModal(true);
  await openAdd(1, "保留空组未来日程");
  await clickGroup("移动后保留的分组");
  await page.$$eval(`.modal-panel .datepicker.inline .dp-day[data-date="${FUTURE_KEY}"]`, (days) => days.at(-1).click());
  await closeModal(true);
  await editTask("保留空组当日日程");
  await createGroup("日程迁入分组");
  await closeModal(true);
  await editTask("保留空组未来日程");
  await clickGroup("日程迁入分组");
  await closeModal(true);
  assert(!(await savedTasks()).some((task) => task.group === "移动后保留的分组") &&
    await page.evaluate(() => window.__E2E_SAVED__.groups.includes("移动后保留的分组")),
    "当日和未来的全部成员移出后，已保存分组目录仍保留原组");
  assert(await page.$$eval(".group-header", (headers) => !headers.some((header) => header.textContent.includes("移动后保留的分组"))),
    "空组保留在选择器中，不在主列表生成空白分组区块");
  await openAdd(0);
  const addRetainsEmpty = await hasGroup("移动后保留的分组");
  await closeModal();
  await editTask("保留空组当日日程");
  assert(addRetainsEmpty && await hasGroup("移动后保留的分组"), "新增和编辑界面均能继续选择已无日程的分组");
  await closeModal();
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector(".page-main");
  await sleep(250);
  await openAdd(1);
  const reloadedEmpty = await hasGroup("移动后保留的分组");
  await closeModal();
  await editTask("保留空组未来日程");
  assert(reloadedEmpty && await hasGroup("移动后保留的分组"), "持久化数据重新加载后，未来新增和编辑仍保留空组标签");
  await closeModal();
  await openAdd(0, "再次使用保留空组");
  await clickGroup("移动后保留的分组");
  await closeModal(true);
  assert((await savedTasks()).find((task) => task.text === "再次使用保留空组")?.group === "移动后保留的分组",
    "保留的空组可以再次用于新增日程，无需重复创建");
  await editTask("再次使用保留空组");
  await clickGroup("日程迁入分组");
  await closeModal(true);
  const beforeEmptyDeletion = JSON.stringify(await savedTasks());
  await openAdd(0);
  await holdGroup("移动后保留的分组");
  await page.screenshot({ path: join(process.cwd(), ".test", "groups-empty-delete-hint.png") });
  await page.click(".group-chip-delete");
  await sleep(500);
  assert(!(await hasGroup("移动后保留的分组")) && JSON.stringify(await savedTasks()) === beforeEmptyDeletion &&
    await page.evaluate(() => !window.__E2E_SAVED__.groups.includes("移动后保留的分组")),
    "显式删除空分组会移除标签及目录，不改动其他组日程");
  await closeModal();
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector(".page-main");
  await openAdd(0);
  assert(!(await hasGroup("移动后保留的分组")) && await hasGroup("日程迁入分组"),
    "重新加载后被明确删除的空分组不复活，其他分组保留");
  await closeModal();

  console.log("28) 无控制台错误");
  const realErrors = consoleErrors.filter(
    (e) => !e.includes("Autofill") && !e.includes("favicon")
  );
  assert(realErrors.length === 0, `控制台无错误 (${realErrors.length})`);
  if (realErrors.length) console.error("  ->", realErrors.slice(0, 5));
} catch (e) {
  failed++;
  console.error("测试执行异常:", e);
  try {
    const dump = await page.evaluate(
      () =>
        JSON.stringify({
          url: location.href,
          slots: document.querySelectorAll(".page-slot").length,
          backBtns: document.querySelectorAll(".back-btn").length,
          pageTitle: document.querySelector(".page-title")?.textContent ?? null,
          mainPresent: !!document.querySelector(".page-main"),
          settingsPresent: !!document.querySelector(".page-settings"),
          historyPresent: !!document.querySelector(".page-history"),
          bodyHead: document.body?.innerHTML.slice(0, 200),
        })
    );
    console.error("PAGE STATE:", dump);
  } catch {
    /* ignore */
  }
  console.error("consoleErrors:", consoleErrors.slice(0, 6));
} finally {
  if (browser) await browser.close();
  server.close();
}

console.log(`\nE2E 结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) {
  errors.forEach((e) => console.error("  -", e));
  process.exit(1);
}
