// 拖拽落位验证：预留空槽与相邻卡片的位置必须对应最终排序
// 场景：行前后/队尾落位、分割线与滚动、跨列表/空列表、分组边界、半遮挡行起拖与边缘滚动、隐藏分组自由排序、让位稳定性与取消、单条组原位、整组边界
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import puppeteer from "puppeteer-core";

const DIST = join(process.cwd(), "dist");
const PORT = 4176;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || "/").split("?")[0]);
    if (p === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    if (p.endsWith("/")) p += "index.html";
    const f = normalize(join(DIST, p));
    const d = await readFile(f);
    res.writeHead(200, { "Content-Type": MIME[extname(f)] || "application/octet-stream" });
    res.end(d);
  } catch { res.writeHead(404); res.end("nf"); }
});

let passed = 0;
let failed = 0;
let browser;
const assert = (c, m) => {
  if (c) { passed++; console.log(`  ✓ ${m}`); }
  else { failed++; console.error(`  ✗ ${m}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function taskOrder(page, section = "today") {
  return page.evaluate((s) =>
    [...document.querySelectorAll(`#list-${s} [data-task-row] .task-text`)].map((e) => e.textContent.trim()), section
  );
}

async function groupedOrder(page, section) {
  return page.evaluate((s) =>
    [...document.querySelectorAll(`#list-${s} [data-task-row]`)].map((row) => ({
      text: row.querySelector(".task-text").textContent.trim(), group: row.dataset.group,
    })), section
  );
}

/** 等待让位动画结束，比较真实空槽和相邻卡片的实际像素坐标。 */
async function indicatorAt(page, textMatch, edge = "before", section = "today") {
  await sleep(240);
  const result = await page.evaluate((t, side, s) => {
    const list = document.getElementById(`list-${s}`);
    const ind = list?.querySelector(".drop-indicator");
    const target = [...(list?.querySelectorAll("[data-task-row]") || [])]
      .find((r) => r.querySelector(".task-text")?.textContent.trim() === t);
    if (!ind || (t && !target)) return { ok: false, reason: "目标列表内无落位槽或目标行" };
    const rr = target?.getBoundingClientRect();
    const ir = ind.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(ind.parentElement).rowGap);
    const expected = !t ? list.getBoundingClientRect().top + list.clientTop + 2 - list.scrollTop
      : side === "after" ? rr.bottom + gap : rr.top - gap;
    const actual = t && side === "before" ? ir.bottom : ir.top;
    return { ok: document.querySelectorAll(".drop-indicator").length === 1 && ir.height >= 44 && Math.abs(actual - expected) <= 1,
      actual, expected, height: ir.height, error: actual - expected };
  }, textMatch, edge, section);
  if (!result.ok) console.error("    落位槽坐标:", JSON.stringify(result));
  return result.ok;
}

/** 整组槽必须位于组块外侧，标题与组内日程作为整体让位。 */
async function groupIndicatorAt(page, group, edge = "before", section = "today") {
  await sleep(240);
  const result = await page.evaluate((name, side, s) => {
    const list = document.getElementById(`list-${s}`);
    const slot = list?.querySelector(".drop-indicator");
    const block = [...(list?.querySelectorAll(":scope > .group-block") || [])]
      .find((e) => e.querySelector("[data-task-row]")?.dataset.group === (name ?? ""));
    if (!slot || !block) return { ok: false, reason: "目标列表内无落位槽或目标组" };
    const sr = slot.getBoundingClientRect();
    const br = block.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
    const expected = side === "after" ? br.bottom + gap : br.top - gap - (parseFloat(getComputedStyle(block).marginTop) || 0);
    const actual = side === "after" ? sr.top : sr.bottom;
    const adjacent = side === "after" ? slot.previousElementSibling === block : slot.nextElementSibling === block;
    return { ok: slot.parentElement === list && adjacent && document.querySelectorAll(".drop-indicator").length === 1 &&
      sr.height >= 44 && Math.abs(actual - expected) <= 1,
      parentIsList: slot.parentElement === list, adjacent, actual, expected, error: actual - expected };
  }, group, edge, section);
  if (!result.ok) console.error("    整组落位槽坐标:", JSON.stringify(result));
  return result.ok;
}

/** 拖动指定文字的行，把指针移到目标 y（绝对坐标），停在原地供检查 */
async function dragTo(page, textMatch, targetY, section = "today", settleMs = 240) {
  const box = await page.evaluate((t, s) => {
    const rows = [...document.querySelectorAll(`#list-${s} [data-task-row]`)];
    const row = rows.find((r) => r.querySelector(".task-text")?.textContent.trim() === t);
    const r = row.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, textMatch, section);
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y);
  await page.mouse.move(box.x, targetY);
  if (settleMs) await sleep(settleMs);
}
async function drop(page) {
  await page.mouse.up();
  await sleep(350);
}

async function rowY(page, section, name, fraction = 0.25) {
  return page.evaluate((s, t, f) => {
    const row = [...document.querySelectorAll(`#list-${s} [data-task-row]`)]
      .find((r) => r.querySelector(".task-text")?.textContent.trim() === t);
    const r = row.getBoundingClientRect();
    return r.top + r.height * f;
  }, section, name, fraction);
}

/** 独立测试数据只交给 Tauri mock，保存调用不会触及实际用户文件。 */
async function loadFixture(page, todayNames, futureNames, showGroups = false) {
  await page.evaluate((today, future, grouped) => {
    const now = new Date();
    const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const due = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);
    const tasks = (names, section) => names.map((entry, i) => ({
      id: `${section}-${i}`, text: typeof entry === "string" ? entry : entry.text,
      group: typeof entry === "string" ? null : entry.group, createdAt: now.toISOString(),
      startDate: null, dueDate: section === "future" ? key(due) : null,
      completed: false, completedAt: null, progress: null,
    }));
    sessionStorage.setItem("drop-test-fixture", JSON.stringify({
      version: 1, currentDate: key(now), todayTasks: tasks(today, "today"), futureTasks: tasks(future, "future"),
      history: [], todayAnchorId: null, settings: { showGroups: grouped },
    }));
  }, todayNames, futureNames, showGroups);
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector(".titlebar-title");
  await sleep(350);
}

async function moveDivider(page, ratio) {
  const r = await page.evaluate(() => {
    const d = document.querySelector(".split-divider").getBoundingClientRect();
    const s = document.querySelector(".dnd-split").getBoundingClientRect();
    return { x: d.left + d.width / 2, y: d.top + d.height / 2, top: s.top, height: s.height };
  });
  await page.mouse.move(r.x, r.y);
  await page.mouse.down();
  await page.mouse.move(r.x, r.top + r.height * ratio, { steps: 6 });
  await page.mouse.up();
  await sleep(200);
}

async function scrollTarget(page, section, name) {
  return page.evaluate((s, t) => {
    const list = document.getElementById(`list-${s}`);
    const row = [...list.querySelectorAll("[data-task-row]")]
      .find((r) => r.querySelector(".task-text")?.textContent.trim() === t);
    list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - 70;
    return list.scrollTop;
  }, section, name);
}

try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(PORT, resolve); });
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 460, height: 760 });
  await page.evaluateOnNewDocument(() => {
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" }, currentWebviewWindow: { label: "main" } },
      transformCallback: (cb, once) => { if (once) setTimeout(() => cb?.(), 0); return 1; },
      invoke: async (command) => command === "load_data" ? JSON.parse(sessionStorage.getItem("drop-test-fixture") || "null") : undefined,
    };
  });
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  page.on("pageerror", (e) => errs.push(String(e)));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".titlebar-title");
  await sleep(400);

  console.log("0) 准备：添加 3 个任务 A/B/C");
  const addTask = async (name) => {
    await page.click(".add-btn");
    await page.waitForSelector(".modal-panel");
    await page.type(".input", name);
    await page.click(".modal-actions .btn.primary");
    await page.waitForFunction(() => !document.querySelector(".modal-panel"));
    await sleep(350);
  };
  await addTask("任务A");
  await addTask("任务B");
  await addTask("任务C");
  assert((await taskOrder(page)).join() === "任务A,任务B,任务C", "初始顺序 A,B,C");

  console.log("1) 拖 A 到 C 的上半部（B 与 C 之间）：落位槽应在 C 前，落位 A 在 B 后");
  const cRect = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#list-today [data-task-row]")];
    const r = rows[2].getBoundingClientRect();
    return { top: r.top, height: r.height };
  });
  await dragTo(page, "任务A", cRect.top + cRect.height * 0.25);
  assert(await indicatorAt(page, "任务C"), "落位槽准确贴在 C 上缘之前");
  assert(await page.evaluate(() => {
    const rows = document.querySelectorAll("#list-today [data-task-row]");
    return document.querySelector(".drop-indicator").getBoundingClientRect().top > rows[1].getBoundingClientRect().bottom;
  }), "落位槽同时位于 B 下缘之后");
  await drop(page);
  assert((await taskOrder(page)).join() === "任务B,任务A,任务C", "落位后顺序 B,A,C（A 在 B 后 C 前）");

  console.log("2) 拖 A 到 C 的下半部（C 之后）：落位槽应在 C 后，落位 A 到队尾");
  await dragTo(page, "任务A", cRect.top + cRect.height * 0.9);
  assert(await indicatorAt(page, "任务C", "after"), "落位槽准确贴在 C 下缘之后");
  await drop(page);
  assert((await taskOrder(page)).join() === "任务B,任务C,任务A", "落位后顺序 B,C,A");

  console.log("3) 队尾落位槽：拖 C 到列表底部下方（队尾）");
  const listBottom = await page.evaluate(() => {
    const list = document.getElementById("list-today");
    const r = list.getBoundingClientRect();
    return r.bottom;
  });
  await dragTo(page, "任务C", listBottom + 20);
  assert(await indicatorAt(page, "任务A", "after"), "队尾下方落位槽准确贴在最后一行之后");
  await drop(page);
  assert((await taskOrder(page)).join() === "任务B,任务A,任务C", "落位到 A 之后（C 拖到队尾 = A 后面）");

  console.log("4) 拖 C 到 B 的上半部（队首）：落位槽应在 B 前");
  const bRect = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#list-today [data-task-row]")];
    const r = rows[0].getBoundingClientRect();
    return { top: r.top, height: r.height };
  });
  await dragTo(page, "任务C", bRect.top + bRect.height * 0.2);
  assert(await indicatorAt(page, "任务B"), "队首落位槽准确贴在 B 上缘之前");
  await drop(page);
  assert((await taskOrder(page)).join() === "任务C,任务B,任务A", "落位后顺序 C,B,A");

  console.log("5) 移动分割线后，在已滚动的当日和未来列表内排序");
  const names = (prefix, count = 14) => Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(2, "0")}`);
  const todayNames = names("当日");
  const futureNames = names("未来");
  await loadFixture(page, todayNames, futureNames);
  const oldDivider = await page.$eval(".split-divider", (e) => e.getBoundingClientRect().top);
  await moveDivider(page, 0.4);
  assert(await page.$eval(".split-divider", (e, old) => Math.abs(e.getBoundingClientRect().top - old) > 10, oldDivider), "已通过指针实际移动分割线");
  assert(await scrollTarget(page, "today", "当日08") > 100, "当日列表确实滚动超过 100px");
  await dragTo(page, "当日09", await rowY(page, "today", "当日08"));
  assert(await indicatorAt(page, "当日08"), "缩小并滚动当日区后落位槽准确贴住目标行");
  await drop(page);
  const todayExpected = [...todayNames];
  todayExpected.splice(8, 1);
  todayExpected.splice(7, 0, "当日09");
  assert((await taskOrder(page)).join() === todayExpected.join(), "当日滚动排序后的完整顺序正确");
  await moveDivider(page, 0.53);
  assert(await scrollTarget(page, "future", "未来08") > 100, "未来列表确实滚动超过 100px");
  await dragTo(page, "未来09", await rowY(page, "future", "未来08"), "future");
  assert(await indicatorAt(page, "未来08", "before", "future"), "再次移动分割线后，未来日程落位槽准确贴住目标行");
  await drop(page);
  const futureExpected = [...futureNames];
  futureExpected.splice(8, 1);
  futureExpected.splice(7, 0, "未来09");
  assert((await taskOrder(page, "future")).join() === futureExpected.join(), "未来滚动排序后的完整顺序正确");

  console.log("6) 单次拖动在两个列表之间反复移动");
  await loadFixture(page, ["当日A", "当日B", "当日C"], ["未来A", "未来B", "未来C"]);
  await dragTo(page, "未来A", await rowY(page, "today", "当日B"), "future");
  assert(await indicatorAt(page, "当日B"), "首次跨列表后唯一落位槽挂载在当日区且位置正确");
  await page.mouse.move(230, await rowY(page, "future", "未来C"));
  assert(await indicatorAt(page, "未来C", "before", "future"), "返回未来区后落位槽随目标列表移动且位置正确");
  await page.mouse.move(230, await rowY(page, "today", "当日C"));
  assert(await indicatorAt(page, "当日C"), "再次进入当日区后落位槽仍准确贴住目标行");
  await drop(page);
  assert((await taskOrder(page)).join() === "当日A,当日B,未来A,当日C" && (await taskOrder(page, "future")).join() === "未来B,未来C", "跨区落位与最后一次落位槽预览一致");
  assert(await page.$$eval(".drop-indicator", (els) => els.length === 0), "结束拖动后落位槽已清理");

  console.log("7) 跨入空列表并再次往返");
  await loadFixture(page, [], ["未来A", "未来B", "未来C"]);
  const emptyY = await page.$eval("#list-today", (e) => {
    const r = e.getBoundingClientRect();
    return r.top + r.height / 2;
  });
  await dragTo(page, "未来A", emptyY, "future");
  assert(await indicatorAt(page, null), "空列表落位槽位于目标列表内容顶部 2px");
  await page.mouse.move(230, await rowY(page, "future", "未来B"));
  assert(await indicatorAt(page, "未来B", "before", "future"), "离开空列表后落位槽准确返回非空列表");
  await page.mouse.move(230, emptyY);
  assert(await indicatorAt(page, null), "再次进入空列表时落位槽位置仍正确");
  await drop(page);
  assert((await taskOrder(page)).join() === "未来A" && (await taskOrder(page, "future")).join() === "未来B,未来C", "空列表接收任务后的两个列表顺序正确");

  console.log("8) 指针进入未来列表底部边缘，自动滚动后立即预览并落位");
  const edgeNames = names("未来", 20);
  await loadFixture(page, [], edgeNames);
  const edgeY = await page.evaluate(() => {
    const list = document.getElementById("list-future");
    const row = [...list.querySelectorAll("[data-task-row]")][9];
    const lr = list.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    // 第 10 行中点刚好位于边缘指针下方；自动滚动后应改为第 11 行之前。
    list.scrollTop += rr.top + rr.height / 2 - (lr.bottom - 35);
    return lr.bottom - 40;
  });
  const beforeScroll = await page.$eval("#list-future", (e) => e.scrollTop);
  await dragTo(page, "未来09", edgeY, "future");
  assert(await page.$eval("#list-future", (e, before) => e.scrollTop > before, beforeScroll), "边缘指针触发了列表自动滚动");
  assert(await indicatorAt(page, "未来11", "before", "future"), "同一次指针移动即按自动滚动后的目标行显示落位槽");
  await drop(page);
  const edgeExpected = [...edgeNames];
  edgeExpected.splice(8, 1);
  edgeExpected.splice(9, 0, "未来09");
  assert((await taskOrder(page, "future")).join() === edgeExpected.join(), "边缘自动滚动后最终落位与更新后的预览一致");

  console.log("9) 整组拖到未来列表末尾");
  await loadFixture(page, [], [
    { text: "甲1", group: "甲组" }, { text: "甲2", group: "甲组" },
    { text: "乙1", group: "乙组" }, { text: "乙2", group: "乙组" },
  ], true);
  await moveDivider(page, 0.3);
  const header = await page.$eval("#list-future .group-header", (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(header.x, header.y);
  await page.mouse.down();
  await page.mouse.move(header.x + 20, header.y);
  await page.mouse.move(header.x, await rowY(page, "future", "乙2", 0.9));
  assert(await groupIndicatorAt(page, "乙组", "after", "future"), "整组队尾落位槽位于完整乙组之后，作为列表直接子节点");
  await drop(page);
  assert((await taskOrder(page, "future")).join() === "乙1,乙2,甲1,甲2", "整组最终排在列表末尾且组内顺序不变");

  console.log("10) 相邻分组边界：全局索引不变时也应更新分组");
  const boundaryTasks = [
    { text: "A前项", group: "A组" }, { text: "甲", group: "A组" },
    { text: "乙", group: "B组" }, { text: "B后项", group: "B组" },
  ];
  // 扩大被测区域，让两个分组及目标行完整可见，避免边缘滚动改变落点。
  await loadFixture(page, boundaryTasks, [], true);
  await moveDivider(page, 0.7);
  await dragTo(page, "乙", await rowY(page, "today", "甲", 0.9));
  assert(await indicatorAt(page, "甲", "after"), "当日：乙上拖时落位槽位于甲后、A 组末尾");
  await drop(page);
  const todayUp = await groupedOrder(page, "today");
  assert(todayUp.find((t) => t.text === "乙")?.group === "A组", "当日：乙全局索引不变，但实际分组已改为 A 组");
  assert(todayUp.filter((t) => t.group === "A组").map((t) => t.text).join() === "A前项,甲,乙" && todayUp.filter((t) => t.group === "B组").map((t) => t.text).join() === "B后项", "当日：乙成为 A 组最后一项，B 组保留其余日程");

  await loadFixture(page, boundaryTasks, [], true);
  await moveDivider(page, 0.7);
  await dragTo(page, "甲", await rowY(page, "today", "乙", 0.1));
  assert(await indicatorAt(page, "乙"), "当日：甲下拖时落位槽位于乙前、B 组开头");
  await drop(page);
  const todayDown = await groupedOrder(page, "today");
  assert(todayDown.find((t) => t.text === "甲")?.group === "B组", "当日：甲全局索引不变，但实际分组已改为 B 组");
  assert(todayDown.filter((t) => t.group === "A组").map((t) => t.text).join() === "A前项" && todayDown.filter((t) => t.group === "B组").map((t) => t.text).join() === "甲,乙,B后项", "当日：甲成为 B 组第一项，A 组保留其余日程");

  await loadFixture(page, [], boundaryTasks, true);
  await moveDivider(page, 0.3);
  await dragTo(page, "乙", await rowY(page, "future", "甲", 0.9), "future");
  assert(await indicatorAt(page, "甲", "after", "future"), "未来：乙上拖时落位槽位于甲后、A 组末尾");
  await drop(page);
  const futureUp = await groupedOrder(page, "future");
  assert(futureUp.find((t) => t.text === "乙")?.group === "A组", "未来：乙全局索引不变，但实际分组已改为 A 组");
  assert(futureUp.filter((t) => t.group === "A组").map((t) => t.text).join() === "A前项,甲,乙" && futureUp.filter((t) => t.group === "B组").map((t) => t.text).join() === "B后项", "未来：乙成为 A 组最后一项，B 组保留其余日程");

  await loadFixture(page, [], boundaryTasks, true);
  await moveDivider(page, 0.3);
  await dragTo(page, "甲", await rowY(page, "future", "乙", 0.1), "future");
  assert(await indicatorAt(page, "乙", "before", "future"), "未来：甲下拖时落位槽位于乙前、B 组开头");
  await drop(page);
  const futureDown = await groupedOrder(page, "future");
  assert(futureDown.find((t) => t.text === "甲")?.group === "B组", "未来：甲全局索引不变，但实际分组已改为 B 组");
  assert(futureDown.filter((t) => t.group === "A组").map((t) => t.text).join() === "A前项" && futureDown.filter((t) => t.group === "B组").map((t) => t.text).join() === "甲,乙,B后项", "未来：甲成为 B 组第一项，A 组保留其余日程");

  console.log("11) 底部半遮挡日程起拖与横移时不应自动滚动");
  const clippedNames = names("半遮挡", 20);
  await loadFixture(page, clippedNames, []);
  const clipped = await page.evaluate(() => {
    const list = document.getElementById("list-today");
    const row = list.querySelectorAll("[data-task-row]")[8];
    const lr = list.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    // 让第九行恰好有一半藏在分割线之下，鼠标只点击实际可见的文字区域。
    list.scrollTop += rr.top + rr.height / 2 - lr.bottom;
    const tr = row.querySelector(".task-text").getBoundingClientRect();
    const visible = row.getBoundingClientRect();
    return { x: tr.left + 20, y: Math.min(tr.top + 3, lr.bottom - 4), bottom: lr.bottom,
      scroll: list.scrollTop, halfClipped: visible.top < lr.bottom && visible.bottom > lr.bottom };
  });
  assert(clipped.halfClipped, "目标日程确实被当日区底部裁剪，而非完整可见");
  await page.mouse.move(clipped.x, clipped.y);
  await page.mouse.down();
  await sleep(250);
  assert(await page.$eval("#list-today", (e, before) => e.scrollTop === before, clipped.scroll), "按住半遮挡日程时保持原滚动位置");
  await page.mouse.move(clipped.x + 12, clipped.y);
  await page.mouse.move(clipped.x + 14, clipped.y);
  await page.mouse.move(clipped.x + 16, clipped.y);
  assert(await page.$(".drag-ghost") !== null && await page.$eval("#list-today", (e, before) => e.scrollTop === before, clipped.scroll), "拖动已启动，连续横移仍不会把半遮挡行滚到完整可见");
  const inwardBefore = await page.$eval("#list-today", (e) => e.scrollTop);
  await page.mouse.move(clipped.x + 16, clipped.y - 4);
  assert(await page.$eval("#list-today", (e, before) => e.scrollTop === before, inwardBefore), "从底边向列表内移动时不会反向向下滚动");
  const outwardBefore = await page.$eval("#list-today", (e) => e.scrollTop);
  await page.mouse.move(clipped.x + 16, clipped.bottom - 1);
  assert(await page.$eval("#list-today", (e, before) => e.scrollTop > before, outwardBefore), "主动向底边拖动时仍可正常向下滚动");
  const reverseBefore = await page.$eval("#list-today", (e) => e.scrollTop);
  await page.mouse.move(clipped.x + 16, clipped.bottom - 3);
  assert(await page.$eval("#list-today", (e, before) => e.scrollTop === before, reverseBefore), "已触发下滚后反向向内拖动会立即停止下滚");
  await page.mouse.move(clipped.x, await rowY(page, "today", "半遮挡08"));
  assert(await indicatorAt(page, "半遮挡08"), "半遮挡日程拖到上一项前的预览位置正确");
  await drop(page);
  const clippedExpected = [...clippedNames];
  clippedExpected.splice(8, 1);
  clippedExpected.splice(7, 0, "半遮挡09");
  assert((await taskOrder(page)).join() === clippedExpected.join(), "半遮挡日程仍能正常完成排序");

  console.log("12) 顶部半遮挡日程也只在主动向上拖动时滚动");
  await loadFixture(page, clippedNames, []);
  const clippedTop = await page.evaluate(() => {
    const list = document.getElementById("list-today");
    const row = list.querySelectorAll("[data-task-row]")[8];
    const lr = list.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    list.scrollTop += rr.top + rr.height / 2 - lr.top;
    const tr = row.querySelector(".task-text").getBoundingClientRect();
    return { x: tr.left + 20, y: lr.top + 4, top: lr.top, scroll: list.scrollTop };
  });
  await page.mouse.move(clippedTop.x, clippedTop.y);
  await page.mouse.down();
  await page.mouse.move(clippedTop.x + 12, clippedTop.y);
  assert(await page.$(".drag-ghost") !== null && await page.$eval("#list-today", (e, before) => e.scrollTop === before, clippedTop.scroll), "顶部半遮挡行横向起拖时不自动上滚");
  const topInwardBefore = await page.$eval("#list-today", (e) => e.scrollTop);
  await page.mouse.move(clippedTop.x + 12, clippedTop.y + 2);
  assert(await page.$eval("#list-today", (e, before) => e.scrollTop === before, topInwardBefore), "从顶边向列表内拖动时不自动上滚");
  const topOutwardBefore = await page.$eval("#list-today", (e) => e.scrollTop);
  await page.mouse.move(clippedTop.x + 12, clippedTop.top + 1);
  assert(await page.$eval("#list-today", (e, before) => e.scrollTop < before, topOutwardBefore), "主动向顶边拖动不足 6px 时仍可正常上滚");
  await drop(page);

  console.log("13) 隐藏分组时，当日游戏日程可以插入学习日程中间");
  const hiddenGroupTasks = [
    { text: "学习1", group: "学习" }, { text: "学习2", group: "学习" },
    { text: "学习3", group: "学习" }, { text: "学习4", group: "学习" },
    { text: "游戏1", group: "游戏" }, { text: "游戏2", group: "游戏" },
    { text: "未分组", group: null },
  ];
  const originalGroupByText = new Map(hiddenGroupTasks.map((t) => [t.text, t.group ?? ""]));
  // 七行都处于可见范围，确保起拖点和落点不会被分割线遮挡。
  await loadFixture(page, hiddenGroupTasks, []);
  await moveDivider(page, 0.8);
  await dragTo(page, "游戏1", await rowY(page, "today", "学习3"));
  assert(await indicatorAt(page, "学习3"), "隐藏分组当日：落位槽位于学习2与学习3之间");
  await drop(page);
  const hiddenToday = await groupedOrder(page, "today");
  assert(hiddenToday.map((t) => t.text).join() === "学习1,学习2,游戏1,学习3,学习4,游戏2,未分组", "隐藏分组当日：游戏1准确插入落位槽位置，不再回到整组边缘");
  assert(hiddenToday.every((t) => t.group === originalGroupByText.get(t.text)), "隐藏分组当日：自由排序后所有日程仍保留原分组");

  console.log("14) 隐藏分组时，未来游戏日程也可以插入学习日程中间");
  await loadFixture(page, [], hiddenGroupTasks);
  await moveDivider(page, 0.2);
  await dragTo(page, "游戏2", await rowY(page, "future", "学习2"), "future");
  assert(await indicatorAt(page, "学习2", "before", "future"), "隐藏分组未来：落位槽位于学习1与学习2之间");
  await drop(page);
  const hiddenFuture = await groupedOrder(page, "future");
  assert(hiddenFuture.map((t) => t.text).join() === "学习1,游戏2,学习2,学习3,学习4,游戏1,未分组", "隐藏分组未来：游戏2准确插入落位槽位置，不再回到整组边缘");
  assert(hiddenFuture.every((t) => t.group === originalGroupByText.get(t.text)), "隐藏分组未来：自由排序后所有日程仍保留原分组");

  console.log("15) 隐藏分组时，未分组日程也可以插入已有分组中间");
  await loadFixture(page, hiddenGroupTasks, []);
  await moveDivider(page, 0.8);
  await dragTo(page, "未分组", await rowY(page, "today", "学习2"));
  assert(await indicatorAt(page, "学习2"), "隐藏分组未分组项：落位槽位于学习1与学习2之间");
  await drop(page);
  const hiddenUngrouped = await groupedOrder(page, "today");
  assert(hiddenUngrouped.map((t) => t.text).join() === "学习1,未分组,学习2,学习3,学习4,游戏1,游戏2", "隐藏分组未分组项：准确插入落位槽位置，不再被推到学习组边缘");
  assert(hiddenUngrouped.every((t) => t.group === originalGroupByText.get(t.text)), "隐藏分组未分组项：插入后仍为未分组，其余日程分组不变");

  console.log("16) 隐藏分组时，跨列表拖入也应遵循落位槽位置");
  await loadFixture(page, hiddenGroupTasks.slice(0, 4), hiddenGroupTasks.slice(4, 6));
  await moveDivider(page, 0.55);
  await dragTo(page, "游戏1", await rowY(page, "today", "学习3"), "future");
  assert(await indicatorAt(page, "学习3"), "隐藏分组跨列表：落位槽位于当日学习2与学习3之间");
  await drop(page);
  const hiddenCrossToday = await groupedOrder(page, "today");
  const hiddenCrossFuture = await groupedOrder(page, "future");
  assert(hiddenCrossToday.map((t) => t.text).join() === "学习1,学习2,游戏1,学习3,学习4" && hiddenCrossFuture.map((t) => t.text).join() === "游戏2", "隐藏分组跨列表：游戏1准确插入当日落位槽位置，未来只保留游戏2");
  assert([...hiddenCrossToday, ...hiddenCrossFuture].every((t) => t.group === originalGroupByText.get(t.text)), "隐藏分组跨列表：所有日程仍保留原分组");

  console.log("17) 真实空槽内停留及连续横移：动画不能反过来改变落点");
  const stableNames = names("稳定", 6);
  await loadFixture(page, stableNames, []);
  await moveDivider(page, 0.8);
  const stableScroll = await page.$eval("#list-today", (e) => e.scrollTop);
  await dragTo(page, "稳定06", await rowY(page, "today", "稳定03"), "today", 0);
  const stableSlot = await page.$eval(".drop-indicator", (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, height: r.height };
  });
  assert(stableSlot.height >= 44, "让位动画启动时，空槽立即预留完整卡片空间");
  let heldPosition = true;
  // 指针进入预留空间后，分别在动画前后发送微小横移，暴露重复命中导致的跳槽。
  for (const dx of [0, 2, -2, 4, -4, 0]) {
    await page.mouse.move(stableSlot.x + dx, stableSlot.y);
    await sleep(70);
    heldPosition &&= await page.$eval(".drop-indicator", (e, initial) => {
      const r = e.getBoundingClientRect();
      return Math.abs(r.top - initial.top) <= 1 && Math.abs(r.height - initial.height) <= 1;
    }, stableSlot);
  }
  assert(heldPosition && await indicatorAt(page, "稳定03"), "指针停在槽内反复横移，落位槽位置和高度保持不变");
  assert(await page.$eval("#list-today", (e, before) => e.scrollTop === before, stableScroll), "让位动画与槽内横移不改变列表滚动位置");
  await sleep(350);
  assert(await indicatorAt(page, "稳定03"), "无指针输入等待动画完成后，落位槽仍停在原邻接卡片之间");
  assert((await taskOrder(page)).join() === stableNames.join(), "预览让位期间业务顺序尚未改变");

  console.log("18) 跨出空槽上下移动仍可切换目标并正常落位");
  await page.mouse.move(stableSlot.x, await rowY(page, "today", "稳定04", 0.9));
  assert(await indicatorAt(page, "稳定04", "after"), "越过下方卡片后，落位槽切到稳定04之后");
  await page.mouse.move(stableSlot.x, await rowY(page, "today", "稳定02", 0.1));
  assert(await indicatorAt(page, "稳定02"), "重新向上拖动后，落位槽切回稳定02之前");
  await drop(page);
  assert((await taskOrder(page)).join() === "稳定01,稳定06,稳定02,稳定03,稳定04,稳定05", "上下切换目标后的实际排序与最后空槽一致");
  assert(await page.$$eval(".drop-indicator, .drag-ghost, .task-row.dragging", (els) => els.length === 0), "落位完成后空槽、浮卡和起拖状态均已清理");

  console.log("19) 系统取消拖动后恢复布局，保留顺序与滚动位置");
  await loadFixture(page, stableNames, []);
  await moveDivider(page, 0.8);
  const cancelBefore = await page.$eval("#list-today", (e) => ({
    scroll: e.scrollTop,
    tops: [...e.querySelectorAll("[data-task-row]")].map((r) => r.getBoundingClientRect().top),
  }));
  await dragTo(page, "稳定05", await rowY(page, "today", "稳定02"));
  assert(await indicatorAt(page, "稳定02"), "取消前已形成稳定02之前的真实空槽");
  await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, bubbles: true })));
  await page.mouse.up();
  await sleep(350);
  assert(await page.$$eval(".drop-indicator, .drag-ghost, .task-row.dragging, body.is-dragging", (els) => els.length === 0), "pointercancel 清除全部拖动预览状态");
  assert((await taskOrder(page)).join() === stableNames.join(), "取消拖动没有提交排序变化");
  assert(await page.$eval("#list-today", (e, initial) => {
    const tops = [...e.querySelectorAll("[data-task-row]")].map((r) => r.getBoundingClientRect().top);
    return e.scrollTop === initial.scroll && tops.every((top, i) => Math.abs(top - initial.tops[i]) <= 1);
  }, cancelBefore), "取消后原卡片布局和滚动位置完整恢复");
  await page.mouse.move(240, await rowY(page, "today", "稳定04"));
  assert(await page.$$eval(".drop-indicator, .drag-ghost", (els) => els.length === 0), "取消后的普通鼠标移动不会重新生成空槽或浮卡");

  console.log("20) 多行卡片的空槽尺寸与被拖日程匹配");
  const multiline = "这是一条较长的日程，需要分成多行显示。\n第二行记录待完成的学习内容与重要细节。\n第三行确认预留空间能够容纳整张卡片。";
  await loadFixture(page, ["长卡前项", "长卡后项"], [multiline]);
  const longHeight = await page.$eval("#list-future [data-task-row]", (e) => e.getBoundingClientRect().height);
  assert(longHeight > 70, "多行测试日程高度明显大于单行卡片");
  await dragTo(page, multiline, await rowY(page, "today", "长卡后项"), "future");
  assert(await indicatorAt(page, "长卡后项"), "长卡片跨列表时在目标两项之间预留完整空槽");
  assert(await page.$eval(".drop-indicator", (e, height) => Math.abs(e.getBoundingClientRect().height - (height + 12)) <= 1, longHeight), "空槽容纳多行原卡片并保留12px余量，避免固定高度错误暗示落位空间");
  await drop(page);
  assert((await taskOrder(page)).join() === ["长卡前项", multiline, "长卡后项"].join() && (await taskOrder(page, "future")).length === 0, "多行卡片最终落在完整空槽的两个相邻日程之间");

  console.log("21) 空列表预留槽隐藏空提示，取消后恢复空提示");
  await loadFixture(page, [], ["空槽测试"]);
  const emptySlotY = await page.$eval("#list-today", (e) => {
    const r = e.getBoundingClientRect();
    return r.top + r.height / 2;
  });
  await dragTo(page, "空槽测试", emptySlotY, "future");
  assert(await indicatorAt(page, null), "目标为空列表时，在内容顶部预留可容纳卡片的空槽");
  assert(await page.$eval("#list-today", (e) => {
    const hint = e.querySelector(".empty-hint");
    return !hint || hint.getClientRects().length === 0 || getComputedStyle(hint).visibility === "hidden";
  }), "空列表拖入时隐藏添加提示，避免和落位槽同时占位");
  await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, bubbles: true })));
  await page.mouse.up();
  await sleep(350);
  assert(await page.$eval("#list-today .empty-hint", (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility === "visible"), "取消跨列表拖动后，空列表添加提示正常恢复");
  assert((await taskOrder(page)).length === 0 && (await taskOrder(page, "future")).join() === "空槽测试", "空列表取消拖入没有移动原日程");

  console.log("22) 离开原位再拖回来后，同一指针位置不会反复展开和收起");
  await loadFixture(page, stableNames, []);
  await moveDivider(page, 0.8);
  await dragTo(page, "稳定03", await rowY(page, "today", "稳定05"));
  assert(await indicatorAt(page, "稳定05"), "先将稳定03移到稳定04与稳定05之间形成空槽");
  const returnY = await rowY(page, "today", "稳定04", 0.1);
  await page.mouse.move(230, returnY);
  assert(await indicatorAt(page, "稳定04"), "拖回原索引时仍保留稳定04之前的空槽");
  const returnSlot = await page.$eval(".drop-indicator", (e) => e.getBoundingClientRect().top);
  const returnScroll = await page.$eval("#list-today", (e) => e.scrollTop);
  let returnStable = true;
  for (const x of [232, 228, 234, 226, 230]) {
    await page.mouse.move(x, returnY);
    await sleep(60);
    returnStable &&= await page.evaluate((top, scroll) => {
      const slot = document.querySelector(".drop-indicator");
      return !!slot && Math.abs(slot.getBoundingClientRect().top - top) <= 1 &&
        document.getElementById("list-today").scrollTop === scroll;
    }, returnSlot, returnScroll);
  }
  assert(returnStable && await indicatorAt(page, "稳定04"), "回源位后持续同Y横移不跳槽、不收起，也不改变滚动位置");
  await drop(page);
  assert((await taskOrder(page)).join() === stableNames.join(), "回到原索引再松手，实际日程顺序保持不变");
  assert(await page.$$eval(".drop-indicator, .drag-ghost", (els) => els.length === 0), "原位松手同样清理预留空间与浮卡");

  console.log("23) 高卡片通过真实边缘滚动可以拖到长列表最终队尾");
  const tallTask = "待移动的高卡片\n第一项详细安排\n第二项详细安排\n第三项详细安排\n第四项详细安排\n第五项详细安排";
  const tailNames = names("队尾", 18);
  await loadFixture(page, [tallTask, ...tailNames], []);
  const tailBaseline = await page.$eval("#list-today", (e) => {
    const r = e.getBoundingClientRect();
    return { max: e.scrollHeight - e.clientHeight, bottom: r.bottom, x: r.left + r.width / 2,
      sourceHeight: e.querySelector("[data-task-row]").offsetHeight };
  });
  assert(tailBaseline.max > 400 && tailBaseline.sourceHeight > 90, "队尾测试确实包含高卡片及需要多次滚动的长列表");
  await dragTo(page, tallTask, tailBaseline.bottom - 3);
  let maxReachedScroll = await page.$eval("#list-today", (e) => e.scrollTop);
  let reachedTail = false;
  // 模拟用户在底边继续小幅向下拖动；只发送真实指针事件，不直接改写 scrollTop。
  for (let cycle = 0; cycle < 50; cycle++) {
    await page.mouse.move(tailBaseline.x, tailBaseline.bottom - 32);
    await page.mouse.move(tailBaseline.x, tailBaseline.bottom - 3, { steps: 4 });
    const progress = await page.$eval("#list-today", (e, lastName) => {
      const slot = e.querySelector(".drop-indicator");
      const last = [...e.querySelectorAll("[data-task-row]")].find((r) => r.querySelector(".task-text")?.textContent.trim() === lastName);
      return { scroll: e.scrollTop, atTail: !!slot && slot.previousElementSibling === last };
    }, tailNames.at(-1));
    maxReachedScroll = Math.max(maxReachedScroll, progress.scroll);
    if (progress.atTail) { reachedTail = true; break; }
  }
  assert(maxReachedScroll > tailBaseline.max, "边缘自动滚动能越过让位前的旧上限，使被空槽推下的末行可达");
  assert(reachedTail && await indicatorAt(page, tailNames.at(-1), "after"), "连续向底边拖动后，空槽确实出现在最终末行之后");
  await drop(page);
  assert((await taskOrder(page)).join() === [...tailNames, tallTask].join(), "高卡片实际移动到最终队尾，其余18项顺序不变");
  assert(await page.$$eval(".drop-indicator, .drag-ghost", (els) => els.length === 0), "长列表队尾落位后完整清理空槽与浮卡");

  console.log("24) 整组移开再返回本组后，持续横移不使空槽反复收起");
  const returnGroupTasks = [
    { text: "回组A1", group: "回组A" }, { text: "回组A2", group: "回组A" },
    { text: "回组B1", group: "回组B" }, { text: "回组B2", group: "回组B" },
    { text: "回组C1", group: "回组C" }, { text: "回组C2", group: "回组C" },
  ];
  await loadFixture(page, returnGroupTasks, [], true);
  await moveDivider(page, 0.8);
  const returnHeader = await page.$eval("#list-today .group-header", (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(returnHeader.x, returnHeader.y);
  await page.mouse.down();
  await page.mouse.move(returnHeader.x + 20, returnHeader.y);
  await page.mouse.move(returnHeader.x, await rowY(page, "today", "回组C1"));
  assert(await groupIndicatorAt(page, "回组C"), "整组离开本组后，预留槽显示在回组C标题及整个组块之前");
  const backToGroupY = await rowY(page, "today", "回组A1", 0.1);
  await page.mouse.move(returnHeader.x, backToGroupY);
  assert(await groupIndicatorAt(page, "回组A"), "整组返回本组首项时在原组标题之前保留空槽，避免原位反复改变布局");
  const groupReturnSlot = await page.evaluate(() => {
    const slot = document.querySelector(".drop-indicator");
    return slot ? { top: slot.getBoundingClientRect().top, height: slot.getBoundingClientRect().height,
      scroll: document.getElementById("list-today").scrollTop } : null;
  });
  let groupReturnStable = !!groupReturnSlot;
  for (const dx of [2, -2, 4, -4, 0]) {
    await page.mouse.move(returnHeader.x + dx, backToGroupY);
    await sleep(60);
    groupReturnStable &&= await page.evaluate((initial) => {
      const slot = document.querySelector(".drop-indicator");
      if (!slot) return false;
      const r = slot.getBoundingClientRect();
      return Math.abs(r.top - initial.top) <= 1 && Math.abs(r.height - initial.height) <= 1 &&
        document.getElementById("list-today").scrollTop === initial.scroll;
    }, groupReturnSlot);
  }
  assert(groupReturnStable && await groupIndicatorAt(page, "回组A"), "整组回源位后同Y横移，空槽高度、位置和列表滚动均不变");
  await drop(page);
  assert(JSON.stringify(await groupedOrder(page, "today")) === JSON.stringify(returnGroupTasks), "整组回原位松手后，所有分组归属及组内外顺序保持原样");
  assert(await page.$$eval(".drop-indicator, .drag-ghost, .group-header.dragging", (els) => els.length === 0), "整组原位松手清除所有预览及拖动状态");

  console.log("25) 窗口失焦取消拖动，恢复日程而不提交排序");
  await loadFixture(page, stableNames, []);
  await moveDivider(page, 0.8);
  await dragTo(page, "稳定05", await rowY(page, "today", "稳定02"));
  assert(await indicatorAt(page, "稳定02"), "失焦前确实处于已展开空槽的拖动状态");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();
  await sleep(350);
  assert(await page.$$eval(".drop-indicator, .drag-ghost, .task-row.dragging, body.is-dragging", (els) => els.length === 0), "窗口失焦后空槽、浮卡及拖动状态全部清理");
  assert((await taskOrder(page)).join() === stableNames.join(), "失焦取消保留原有顺序，不提交中途预览的落点");

  console.log("26) 视口上方的空槽换位只补偿净高度，不重复改变滚动位置");
  const netScrollTasks = ["A", "B", "C"].flatMap((group) =>
    Array.from({ length: 6 }, (_, i) => ({ text: `净变${group}${i + 1}`, group: `净变${group}` }))
  );
  await loadFixture(page, netScrollTasks, [], true);
  await moveDivider(page, 0.65);
  await scrollTarget(page, "today", "净变A4");
  const netHeader = await page.$$eval("#list-today .group-header", (els) => {
    const r = els.find((e) => e.querySelector(".group-name").textContent === "净变B").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(netHeader.x, netHeader.y);
  await page.mouse.down();
  await page.mouse.move(netHeader.x + 20, netHeader.y);
  await page.mouse.move(netHeader.x, await rowY(page, "today", "净变A6"));
  assert(await groupIndicatorAt(page, "净变A"), "整组指针位于上一组末项时，空槽仍在整个A组标题之前");
  const netBefore = await page.$eval("#list-today", (list) => {
    const find = (name) => [...list.querySelectorAll("[data-task-row]")]
      .find((r) => r.querySelector(".task-text").textContent === name);
    const row = find("净变B4");
    list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - 90;
    const rr = row.getBoundingClientRect();
    const lr = list.getBoundingClientRect();
    return { scroll: list.scrollTop, visibleTop: rr.top, pointerY: rr.top + rr.height / 4,
      bothAbove: list.querySelector(".drop-indicator").getBoundingClientRect().bottom < lr.top &&
        find("净变B1").getBoundingClientRect().bottom < lr.top };
  });
  assert(netBefore.bothAbove, "滚动后旧槽及本组首项均在视口上方，指针目标B4仍清晰可见");
  await page.mouse.move(netHeader.x, netBefore.pointerY);
  assert(await groupIndicatorAt(page, "净变B"), "指针进入本组可见项后，空槽从A组前切换到视口外的B组标题之前");
  assert(await page.$eval("#list-today", (list, before) => {
    const row = [...list.querySelectorAll("[data-task-row]")].find((r) => r.querySelector(".task-text").textContent === "净变B4");
    return list.scrollTop === before.scroll && Math.abs(row.getBoundingClientRect().top - before.visibleTop) <= 1;
  }, netBefore), "新旧槽都在视口上方且高度相同，换槽后scrollTop和可见日程位置均不变");
  await drop(page);
  assert(JSON.stringify(await groupedOrder(page, "today")) === JSON.stringify(netScrollTasks), "视口外空槽回到原组入口后松手，所有日程及分组顺序不变");

  console.log("27) 单条分组起拖原地放下、移开回源位及主动跨组移动");
  const singletonCases = [
    { label: "首组", tasks: [{ text: "单条", group: "单条组" }, { text: "邻组A1", group: "邻组A" }, { text: "邻组A2", group: "邻组A" }] },
    { label: "中组", tasks: [{ text: "邻组A1", group: "邻组A" }, { text: "单条", group: "单条组" }, { text: "邻组B1", group: "邻组B" }] },
    { label: "尾组", tasks: [{ text: "邻组A1", group: "邻组A" }, { text: "邻组A2", group: "邻组A" }, { text: "单条", group: "单条组" }] },
    { label: "未分组", tasks: [{ text: "邻组A1", group: "邻组A" }, { text: "邻组A2", group: "邻组A" }, { text: "单条", group: null }] },
    { label: "唯一日程", tasks: [{ text: "单条", group: "单条组" }] },
  ];
  const singletonResults = [];
  for (const section of ["today", "future"]) {
    for (const fixture of singletonCases) {
      const resetSingleton = async () => {
        await loadFixture(page, section === "today" ? fixture.tasks : [], section === "future" ? fixture.tasks : [], true);
        await moveDivider(page, section === "today" ? 0.8 : 0.2);
      };
      await resetSingleton();
      const initial = await groupedOrder(page, section);
      const result = { label: `${section}/${fixture.label}`, immediate: false, returned: false,
        slotInGroup: false, stable: true, scroll: true, explicitMove: true, emptySpace: true };
      const sourcePoint = await page.evaluate((s) => {
        const row = [...document.querySelectorAll(`#list-${s} [data-task-row]`)]
          .find((r) => r.querySelector(".task-text").textContent === "单条");
        const r = row.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, section);
      await page.mouse.move(sourcePoint.x, sourcePoint.y);
      await page.mouse.down();
      // 超过起拖阈值后立即松手，不等待让位动画完成。
      await page.mouse.move(sourcePoint.x + 20, sourcePoint.y);
      await drop(page);
      result.immediate = JSON.stringify(await groupedOrder(page, section)) === JSON.stringify(initial);

      await resetSingleton();
      const destination = fixture.tasks.find((t) => t.text !== "单条");
      const awayY = destination ? await rowY(page, section, destination.text, 0.2)
        : await page.$eval(`#list-${section === "today" ? "future" : "today"}`, (list) => {
          const r = list.getBoundingClientRect();
          return r.top + r.height / 2;
        });
      await dragTo(page, "单条", awayY, section);
      const backY = await rowY(page, section, "单条", 0.5);
      await page.mouse.move(sourcePoint.x, backY);
      await sleep(240);
      const returnedSlot = await page.evaluate((s) => {
        const list = document.getElementById(`list-${s}`);
        const source = [...list.querySelectorAll("[data-task-row]")]
          .find((r) => r.querySelector(".task-text").textContent === "单条");
        const slot = list.querySelector(".drop-indicator");
        const r = slot?.getBoundingClientRect();
        return { inGroup: !!slot && slot.parentElement === source.parentElement,
          top: r?.top, height: r?.height, scroll: list.scrollTop };
      }, section);
      result.slotInGroup = returnedSlot.inGroup;
      for (const dx of [2, -2, 4, -4, 0]) {
        await page.mouse.move(sourcePoint.x + dx, backY);
        await sleep(60);
        const stable = await page.evaluate((s, baseline) => {
          const list = document.getElementById(`list-${s}`);
          const r = list.querySelector(".drop-indicator")?.getBoundingClientRect();
          return { slot: !!r && Math.abs(r.top - baseline.top) <= 1 && Math.abs(r.height - baseline.height) <= 1,
            scroll: list.scrollTop === baseline.scroll };
        }, section, returnedSlot);
        result.stable &&= stable.slot;
        result.scroll &&= stable.scroll;
      }
      await drop(page);
      result.returned = JSON.stringify(await groupedOrder(page, section)) === JSON.stringify(initial);

      if (destination) {
        await resetSingleton();
        await dragTo(page, "单条", await rowY(page, section, destination.text, 0.2), section);
        await drop(page);
        const expected = initial.filter((t) => t.text !== "单条");
        expected.splice(expected.findIndex((t) => t.text === destination.text), 0,
          { text: "单条", group: destination.group ?? "" });
        result.explicitMove = JSON.stringify(await groupedOrder(page, section)) === JSON.stringify(expected);
      } else {
        await resetSingleton();
        const blankY = await page.$eval(`#list-${section}`, (list) => list.getBoundingClientRect().bottom - 60);
        await dragTo(page, "单条", blankY, section);
        await drop(page);
        result.emptySpace = JSON.stringify(await groupedOrder(page, section)) === JSON.stringify(initial);
      }
      singletonResults.push(result);
      if (Object.entries(result).some(([key, value]) => key !== "label" && value === false)) {
        console.error("    单条分组场景:", JSON.stringify(result));
      }
    }
  }
  assert(singletonResults.filter((r) => r.label.startsWith("today/")).every((r) => r.immediate && r.emptySpace), "当日首/中/尾/未分组/唯一日程：原地及唯一日程拖入列表空白均保留原顺序和分组");
  assert(singletonResults.filter((r) => r.label.startsWith("future/")).every((r) => r.immediate && r.emptySpace), "未来首/中/尾/未分组/唯一日程：原地及唯一日程拖入列表空白均保留原顺序和分组");
  assert(singletonResults.filter((r) => r.label.startsWith("today/")).every((r) => r.returned), "当日单条组：移开后返回源卡再松手保留原顺序和分组");
  assert(singletonResults.filter((r) => r.label.startsWith("future/")).every((r) => r.returned), "未来单条组：移开后返回源卡再松手保留原顺序和分组");
  assert(singletonResults.every((r) => r.slotInGroup), "单条组返回源位时，真实预留槽位于原分组内部");
  assert(singletonResults.every((r) => r.stable), "单条组返回源位后，同Y横移不使预留槽跳动或收起");
  assert(singletonResults.every((r) => r.scroll), "单条组返回源位后，同Y横移保持列表滚动位置");
  assert(singletonResults.every((r) => r.explicitMove), "单条组仍可主动拖入其他分组，准确落在目标日程之前");

  console.log("28) 整组槽与完整分组边界一致，组内命中不拆组");
  const wholeGroupTasks = [
    { text: "整组A1", group: "整组A" }, { text: "整组A2", group: "整组A" },
    { text: "整组B1", group: "整组B" }, { text: "整组B2", group: "整组B" },
    { text: "整组无1", group: null }, { text: "整组无2", group: null },
  ];
  const wholeGroupCases = [
    { label: "移到首组前", source: "整组B", target: "整组A", targetRow: "整组A2", edge: "before", groups: ["整组B", "整组A", null] },
    { label: "移到中间边界", source: "整组A", target: null, targetRow: "整组无2", edge: "before", groups: ["整组B", "整组A", null] },
    { label: "移到列表尾部", source: "整组A", target: null, targetRow: "整组无2", edge: "after", groups: ["整组B", null, "整组A"] },
    { label: "移动未分组", source: null, target: "整组B", targetRow: "整组B2", edge: "before", groups: ["整组A", null, "整组B"] },
  ];
  const wholeGroupResults = [];
  // 为首中尾边界提供完整可见范围，滚动行为由前面的专门场景覆盖。
  await page.setViewport({ width: 460, height: 1000 });
  for (const section of ["today", "future"]) {
    for (const fixture of wholeGroupCases) {
      await loadFixture(page, section === "today" ? wholeGroupTasks : [], section === "future" ? wholeGroupTasks : [], true);
      await moveDivider(page, section === "today" ? 0.8 : 0.2);
      const initial = await groupedOrder(page, section);
      const result = { label: `${section}/${fixture.label}`, boundary: true, stable: true, returned: false, final: false };
      const startGroup = async () => {
        const point = await page.evaluate((s, group) => {
          const block = [...document.querySelectorAll(`#list-${s} > .group-block`)]
            .find((e) => e.querySelector("[data-task-row]").dataset.group === (group ?? ""));
          const r = block.querySelector(".group-header").getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }, section, fixture.source);
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        await page.mouse.move(point.x + 20, point.y);
        return point;
      };
      const moveToBoundary = async (point) => {
        await page.mouse.move(point.x, await rowY(page, section, fixture.targetRow, fixture.edge === "after" ? 0.9 : 0.25));
        return groupIndicatorAt(page, fixture.target, fixture.edge, section);
      };
      const point = await startGroup();
      result.boundary &&= await moveToBoundary(point);
      if (section === "today" && fixture.label === "移到中间边界") {
        await page.screenshot({ path: ".test/group-drop-preview.png" });
      }
      const held = await page.evaluate((s) => {
        const list = document.getElementById(`list-${s}`);
        const r = list.querySelector(".drop-indicator")?.getBoundingClientRect();
        return r ? { top: r.top, height: r.height, y: r.top + r.height / 2, scroll: list.scrollTop } : null;
      }, section);
      for (const dx of [2, -2, 4, -4, 0]) {
        if (!held) { result.stable = false; break; }
        await page.mouse.move(point.x + dx, held.y);
        await sleep(45);
        result.stable &&= await page.evaluate((s, before) => {
          const list = document.getElementById(`list-${s}`);
          const r = list.querySelector(".drop-indicator")?.getBoundingClientRect();
          return !!r && Math.abs(r.top - before.top) <= 1 && Math.abs(r.height - before.height) <= 1 && list.scrollTop === before.scroll;
        }, section, held);
      }
      const sourceRow = wholeGroupTasks.find((t) => t.group === fixture.source).text;
      await page.mouse.move(point.x, await rowY(page, section, sourceRow));
      result.boundary &&= await groupIndicatorAt(page, fixture.source, "before", section);
      await drop(page);
      result.returned = JSON.stringify(await groupedOrder(page, section)) === JSON.stringify(initial);
      const finalPoint = await startGroup();
      result.boundary &&= await moveToBoundary(finalPoint);
      await drop(page);
      const expected = fixture.groups.flatMap((group) => wholeGroupTasks.filter((task) => task.group === group))
        .map((task) => ({ ...task, group: task.group ?? "" }));
      result.final = JSON.stringify(await groupedOrder(page, section)) === JSON.stringify(expected);
      wholeGroupResults.push(result);
      if (Object.entries(result).some(([key, value]) => key !== "label" && value === false)) {
        console.error("    整组边界场景:", JSON.stringify(result));
      }
    }
  }
  await page.setViewport({ width: 460, height: 760 });
  assert(wholeGroupResults.filter((r) => r.label.startsWith("today/")).every((r) => r.boundary), "当日整组首/中/尾及未分组：预留槽始终在完整组块之外，标题随组一起让位");
  assert(wholeGroupResults.filter((r) => r.label.startsWith("future/")).every((r) => r.boundary), "未来整组首/中/尾及未分组：预留槽始终在完整组块之外，标题随组一起让位");
  assert(wholeGroupResults.filter((r) => r.label.startsWith("today/")).every((r) => r.stable), "当日整组槽内同Y横移保持槽位置、高度及滚动位置");
  assert(wholeGroupResults.filter((r) => r.label.startsWith("future/")).every((r) => r.stable), "未来整组槽内同Y横移保持槽位置、高度及滚动位置");
  assert(wholeGroupResults.filter((r) => r.label.startsWith("today/")).every((r) => r.returned), "当日整组移开后回到源组入口松手，恢复原有分组和顺序");
  assert(wholeGroupResults.filter((r) => r.label.startsWith("future/")).every((r) => r.returned), "未来整组移开后回到源组入口松手，恢复原有分组和顺序");
  assert(wholeGroupResults.filter((r) => r.label.startsWith("today/")).every((r) => r.final), "当日整组最终落位与组块边界预览一致，目标组及未分组均不被拆开");
  assert(wholeGroupResults.filter((r) => r.label.startsWith("future/")).every((r) => r.final), "未来整组最终落位与组块边界预览一致，目标组及未分组均不被拆开");

  console.log("29) 无控制台错误");
  assert(errs.length === 0, `控制台无错误 (${errs.length})`);
  if (errs.length) console.error("  ->", errs.slice(0, 5));

} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log(`\n拖拽落位结果: ${passed} 通过, ${failed} 失败`);
process.exitCode = failed > 0 ? 1 : 0;
