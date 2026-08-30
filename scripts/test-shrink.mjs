// 验证缩小卡片完整周期 + 窗口缩放（真实应用）：
// 失焦缩小(紧凑卡片) -> 悬浮展开(恢复全尺寸) -> 移出再次缩小 -> 点击保持 -> 缩放手柄拖动
import { spawn, execSync } from "node:child_process";

const exe = process.argv[2] || "src-tauri/target/release/planer.exe";
const PORT = 9229;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  execSync("taskkill /IM planer.exe /F", { stdio: "ignore" });
  execSync("taskkill /IM notepad.exe /F", { stdio: "ignore" });
} catch {}
await sleep(1500);

// 先让 notepad 占住前台，再启动应用（新窗口创建时会被激活，随后抢走焦点触发 blur 最可靠）
const np = spawn("notepad.exe", [], { stdio: "ignore" });
await sleep(1500);

const app = spawn(exe, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "ignore",
});

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page" && t.url !== "about:blank");
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  return null;
}

let passed = 0;
let failed = 0;
const assert = (c, m) => {
  if (c) {
    passed++;
    console.log(`  ✓ ${m}`);
  } else {
    failed++;
    console.error(`  ✗ ${m}`);
  }
};

try {
  const target = await getTarget();
  if (!target) {
    console.error("no target");
    process.exit(1);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  const consoleLogs = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    } else if (msg.method === "Runtime.consoleAPICalled") {
      consoleLogs.push(
        (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ")
      );
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const evalJs = (expression) =>
    send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }).then(
      (r) => r?.result?.value
    );

  await send("Runtime.enable");
  for (let i = 0; i < 20; i++) {
    const ok = await evalJs(`!!document.querySelector('.date-jump-btn') || !!document.querySelector('.card-view')`);
    if (ok === true) break;
    await sleep(500);
  }
  const winInfo = async () =>
    JSON.parse(await evalJs(`JSON.stringify({ innerW: window.innerWidth, innerH: window.innerHeight })`));

  // 1) 失焦缩小 -> 紧凑卡片
  console.log("1) 失焦缩小为紧凑卡片");
  let inCard = await evalJs(`!!document.querySelector('.card-view')`);
  // 焦点转换在 WM 层面偶有丢失，循环尝试：激活应用 -> 抢走焦点（制造 focus/blur 转换）
  for (let attempt = 0; attempt < 3 && !inCard; attempt++) {
    await evalJs(`window.__TAURI_INTERNALS__.invoke('plugin:window|set_focus')`);
    await sleep(800);
    try {
      execSync(
        'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/steal-focus.ps1 -ProcessName notepad',
        { stdio: "ignore" }
      );
    } catch {}
    for (let i = 0; i < 8 && !inCard; i++) {
      await sleep(500);
      inCard = await evalJs(`!!document.querySelector('.card-view')`);
    }
  }
  const focusAfter = await evalJs(`document.hasFocus()`);
  console.log(`   (抢焦点后应用 hasFocus: ${focusAfter})`);
  assert(inCard === true, "失焦后进入卡片模式");
  console.log("   [日志]", consoleLogs.slice(-6));
  await sleep(700); // 等收缩动画结束（窗口缩至最终尺寸）
  const cardWin = await winInfo();
  console.log(`   (窗口 ${cardWin.innerW}x${cardWin.innerH}, 期望 172x52)`);
  assert(cardWin.innerW === 172 && cardWin.innerH === 52, "卡片窗口为紧凑尺寸 172x52");
  const cardText = await evalJs(`document.querySelector('.card-text')?.textContent ?? null`);
  console.log(`   (卡片文案: ${cardText})`);
  assert(!!cardText && cardText.includes("日程"), "卡片完整显示日期+日程文字");
  // 文字不溢出（文本宽度 <= 卡片宽度）
  const overflow = await evalJs(`(() => {
    const t = document.querySelector('.card-text');
    if (!t) return true;
    return t.scrollWidth > t.clientWidth + 1;
  })()`);
  assert(overflow === false, "卡片文字完整显示不溢出");

  // 2) 悬浮展开
  console.log("2) 悬浮展开（无滑动动画，淡入）");
  const rect = JSON.parse(
    (await evalJs(`JSON.stringify((() => { const r = document.querySelector('.card-view').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })())`)) || "{}"
  );
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
  await sleep(1300);
  const expanded = await evalJs(`!document.querySelector('.card-view') && !!document.querySelector('.titlebar-title')`);
  assert(expanded === true, "悬浮后展开为完整界面");
  const fullWin = await winInfo();
  console.log(`   (窗口 ${fullWin.innerW}x${fullWin.innerH}, 期望 440x740)`);
  assert(fullWin.innerW === 440 && fullWin.innerH === 740, "恢复默认完整尺寸");
  // 展开时页面不应有左右滑动动画 class
  const animClass = await evalJs(`document.querySelector('.page-slot')?.className ?? ''`);
  console.log(`   (page-slot class: ${animClass})`);
  assert(!animClass.includes("slide-"), "展开恢复不使用左右滑动动画");

  // 3) 移出窗口再次缩小（未点击）
  console.log("3) 移出窗口再次缩小（未点击）");
  await evalJs(`document.dispatchEvent(new MouseEvent('mouseout'))`);
  await sleep(1300);
  assert((await evalJs(`!!document.querySelector('.card-view')`)) === true, "悬浮期间未点击、移出后自动再次缩小");

  // 4) 点击卡片保持展开
  console.log("4) 点击卡片保持展开");
  const rect2 = JSON.parse(
    (await evalJs(`JSON.stringify((() => { const r = document.querySelector('.card-view').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })())`)) || "{}"
  );
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect2.x + rect2.w / 2, y: rect2.y + rect2.h / 2, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect2.x + rect2.w / 2, y: rect2.y + rect2.h / 2, button: "left", clickCount: 1 });
  await sleep(1300);
  assert(
    (await evalJs(`!!document.querySelector('.titlebar-title') && !document.querySelector('.card-view')`)) === true,
    "点击后保持完整界面"
  );
  await evalJs(`document.dispatchEvent(new MouseEvent('mouseout'))`);
  await sleep(1000);
  assert(
    (await evalJs(`!!document.querySelector('.titlebar-title') && !document.querySelector('.card-view')`)) === true,
    "聚焦状态下移出不再缩小"
  );

  // 5) 缩放手柄拖动 -> 窗口变大
  console.log("5) 右下角缩放手柄调整窗口大小");
  const before = await winInfo();
  const hx = before.innerW - 5;
  const hy = before.innerH - 5;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: hx, y: hy, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: hx + 130, y: hy + 90, button: "left" });
  await sleep(100);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: hx + 130, y: hy + 90, button: "left", clickCount: 1 });
  await sleep(600);
  const after = await winInfo();
  console.log(`   (窗口 ${before.innerW}x${before.innerH} -> ${after.innerW}x${after.innerH})`);
  assert(after.innerW > before.innerW && after.innerH > before.innerH, "拖动后窗口尺寸增大");
  // 窗口放大后布局无重叠：检查日期头部按钮与文字不重叠
  const noOverlap = await evalJs(`(() => {
    const hd = document.querySelector('.date-header');
    if (!hd) return true;
    const blk = document.querySelector('.date-block');
    const acts = document.querySelector('.date-actions');
    if (!blk || !acts) return true;
    const a = blk.getBoundingClientRect();
    const b = acts.getBoundingClientRect();
    // 允许同行或换行，但不能互相覆盖（水平重叠且垂直重叠）
    const xOverlap = a.left < b.right && a.right > b.left;
    const yOverlap = a.top < b.bottom && a.bottom > b.top;
    return !(xOverlap && yOverlap);
  })()`);
  assert(noOverlap === true, "放大后日期头部无重叠");

  // 6) 缩小到最小尺寸 -> 布局仍正常
  console.log("6) 缩小到最小尺寸");
  const minW = 380;
  const minH = 520;
  const cur = await winInfo();
  const dx = cur.innerW - minW;
  const dy = cur.innerH - minH;
  const hx2 = cur.innerW - 5;
  const hy2 = cur.innerH - 5;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: hx2, y: hy2, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: hx2 - dx, y: hy2 - dy, button: "left" });
  await sleep(100);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: hx2 - dx, y: hy2 - dy, button: "left", clickCount: 1 });
  await sleep(600);
  const minWin = await winInfo();
  console.log(`   (窗口 ${minWin.innerW}x${minWin.innerH}, 最小 380x520)`);
  assert(minWin.innerW >= 380 && minWin.innerH >= 520, "不小于最小尺寸");
  const noOverlapMin = await evalJs(`(() => {
    const rows = [...document.querySelectorAll('.task-row')];
    // 检查标题栏与内容、按钮是否溢出视口
    const vw = window.innerWidth;
    const bad = [...document.querySelectorAll('.titlebar, .date-actions, .add-btn, .section-header')].some((el) => {
      const r = el.getBoundingClientRect();
      return r.right > vw + 1 || r.left < -1;
    });
    return !bad;
  })()`);
  assert(noOverlapMin === true, "最小尺寸下无横向溢出/重叠");

  // 7) 移动窗口后失焦缩小立即生效（onMoved 清除拖拽守卫）
  console.log("7) 移动窗口后失焦立即生效");
  // 模拟标题栏按下（合成 pointerdown 设置守卫；不触发 Tauri 原生拖拽）
  await evalJs(
    `document.querySelector('.titlebar').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 120, clientY: 22 }))`
  );
  await sleep(150);
  // 读取当前位置后偏移移动（确保实际发生移动 -> onMoved 触发 -> 清除守卫）
  await evalJs(`(async () => {
    const p = await window.__TAURI_INTERNALS__.invoke('plugin:window|position');
    await window.__TAURI_INTERNALS__.invoke('plugin:window|set_position', { x: (p?.x ?? 0) + 60, y: (p?.y ?? 0) + 40 });
    return true;
  })()`);
  await sleep(800);
  await evalJs(`document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))`);
  await sleep(400);
  // 抢走焦点 -> blur -> 应立即缩小（守卫已被 onMoved 清除）
  try {
    execSync(
      'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/steal-focus.ps1 -ProcessName notepad',
      { stdio: "ignore" }
    );
  } catch {}
  let card7 = await evalJs(`!!document.querySelector('.card-view')`);
  for (let i = 0; i < 8 && !card7; i++) {
    await sleep(500);
    card7 = await evalJs(`!!document.querySelector('.card-view')`);
  }
  assert(card7 === true, "移动窗口后第一次失焦即可缩小");

  ws.close();
} finally {
  app.kill();
  try {
    execSync("taskkill /IM planer.exe /F", { stdio: "ignore" });
  } catch {}
}

console.log(`\n缩小/缩放周期结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
