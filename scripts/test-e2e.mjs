// 端到端 UI 测试：用 puppeteer-core + 系统 Chrome 驱动 dist 构建产物
// 运行（需先 npm run build）：node scripts/test-e2e.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
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

async function addTask(section, name, dateKey) {
  const addBtns = await page.$$(".add-btn");
  await addBtns[section].click();
  await page.waitForSelector(".modal-panel");
  await page.type(".input", name);
  if (dateKey) {
    // 内联日历：直接点日期（无需点击触发器展开）
    await page.click(`.dp-day[data-date="${dateKey}"]`);
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
      invoke: async () => undefined,
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

  console.log("9) 编辑规则：当日任务不显示截止日期");
  await page.click("#list-today .task-row .icon-btn:first-of-type");
  await page.waitForSelector(".modal-panel");
  assert(await count(".modal-panel .field-label") === 1, "当日编辑只有内容字段");
  await page.click(".modal-actions .btn.ghost");
  await sleep(200);

  console.log("10) 设置页：主题切换与自动编号");
  await goToSettings();
  assert(await count(".switch-row") === 5, "开关共 5 项（功能 4 + 开机启动 1）");
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

  console.log("14) 无控制台错误");
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
