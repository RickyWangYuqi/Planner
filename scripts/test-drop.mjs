// 拖拽落位验证：蓝色指示条位置与最终落位必须完全一致
// 场景：3 个任务 A/B/C，分别验证"拖到某日程前/后"与"队尾蓝条"
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
const assert = (c, m) => {
  if (c) { passed++; console.log(`  ✓ ${m}`); }
  else { failed++; console.error(`  ✗ ${m}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function taskOrder(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("#list-today [data-task-row] .task-text")].map((e) => e.textContent.trim())
  );
}

/** 蓝条相对某行的位置：'before'=在该行前 / 'after'=在该行后 / 'none'=无蓝条 */
async function indicatorPos(page, textMatch) {
  return page.evaluate((t) => {
    const list = document.getElementById("list-today");
    if (!list) return "no-list";
    const ind = list.querySelector(".drop-indicator");
    if (!ind) return "none";
    const rows = [...list.querySelectorAll("[data-task-row]")];
    const target = rows.find((r) => r.textContent.includes(t));
    if (!target) return "no-target";
    const p = ind.compareDocumentPosition(target);
    return p & Node.DOCUMENT_POSITION_FOLLOWING ? "before" : "after";
  }, textMatch);
}

/** 拖动指定文字的行，把指针移到目标 y（绝对坐标），停在原地供检查 */
async function dragTo(page, textMatch, targetY) {
  const box = await page.evaluate((t) => {
    const rows = [...document.querySelectorAll("#list-today [data-task-row]")];
    const row = rows.find((r) => r.textContent.includes(t));
    const r = row.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, textMatch);
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + 30, box.y + 6, { steps: 4 });
  await page.mouse.move(box.x + 120, targetY, { steps: 10 });
  await sleep(200);
}
async function drop(page) {
  await page.mouse.up();
  await sleep(350);
}

try {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await puppeteer.launch({
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
      invoke: async () => undefined,
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
    await sleep(150);
  };
  await addTask("任务A");
  await addTask("任务B");
  await addTask("任务C");
  assert((await taskOrder(page)).join() === "任务A,任务B,任务C", "初始顺序 A,B,C");

  console.log("1) 拖 A 到 C 的上半部（B 与 C 之间）：蓝条应在 C 前，落位 A 在 B 后");
  const cRect = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#list-today [data-task-row]")];
    const r = rows[2].getBoundingClientRect();
    return { top: r.top, height: r.height };
  });
  await dragTo(page, "任务A", cRect.top + cRect.height * 0.25);
  assert((await indicatorPos(page, "任务C")) === "before", "蓝条显示在 C 之前");
  assert((await indicatorPos(page, "任务B")) === "after", "蓝条显示在 B 之后");
  await drop(page);
  assert((await taskOrder(page)).join() === "任务B,任务A,任务C", "落位后顺序 B,A,C（A 在 B 后 C 前）");

  console.log("2) 拖 A 到 C 的下半部（C 之后）：蓝条应在 C 后，落位 A 到队尾");
  await dragTo(page, "任务A", cRect.top + cRect.height * 0.9);
  assert((await indicatorPos(page, "任务C")) === "after", "蓝条显示在 C 之后");
  await drop(page);
  assert((await taskOrder(page)).join() === "任务B,任务C,任务A", "落位后顺序 B,C,A");

  console.log("3) 队尾蓝条：拖 C 到列表底部下方（队尾）");
  const listBottom = await page.evaluate(() => {
    const list = document.getElementById("list-today");
    const r = list.getBoundingClientRect();
    return r.bottom;
  });
  await dragTo(page, "任务C", listBottom + 20);
  assert((await indicatorPos(page, "任务A")) === "after", "队尾下方能显示蓝条（在最后一个任务之后）");
  await drop(page);
  assert((await taskOrder(page)).join() === "任务B,任务A,任务C", "落位到 A 之后（C 拖到队尾 = A 后面）");

  console.log("4) 拖 C 到 B 的上半部（队首）：蓝条应在 B 前");
  const bRect = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#list-today [data-task-row]")];
    const r = rows[0].getBoundingClientRect();
    return { top: r.top, height: r.height };
  });
  await dragTo(page, "任务C", bRect.top + bRect.height * 0.2);
  assert((await indicatorPos(page, "任务B")) === "before", "蓝条显示在 B 之前");
  await drop(page);
  assert((await taskOrder(page)).join() === "任务C,任务B,任务A", "落位后顺序 C,B,A");

  console.log("5) 无控制台错误");
  assert(errs.length === 0, `控制台无错误 (${errs.length})`);
  if (errs.length) console.error("  ->", errs.slice(0, 5));

  await browser.close();
} finally {
  server.close();
}

console.log(`\n拖拽落位结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
