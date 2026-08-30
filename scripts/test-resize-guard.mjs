// 验证：悬浮展开状态下去调整窗口大小，不再误触发缩小（卡片/抽动/尺寸回退）
import { spawn, execSync } from "node:child_process";

const exe = process.argv[2] || "src-tauri/target/release/planer.exe";
const PORT = 9232;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  execSync("taskkill /IM planer.exe /F", { stdio: "ignore" });
  execSync("taskkill /IM notepad.exe /F", { stdio: "ignore" });
} catch {}
await sleep(1500);
const np = spawn("notepad.exe", [], { stdio: "ignore" });
await sleep(1200);

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
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
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

  console.log("1) 先进入卡片（失焦）");
  let inCard = await evalJs(`!!document.querySelector('.card-view')`);
  for (let a = 0; a < 3 && !inCard; a++) {
    await evalJs(`window.__TAURI_INTERNALS__.invoke('plugin:window|set_focus')`);
    await sleep(700);
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
  assert(inCard === true, "进入卡片模式");
  await sleep(800); // 等收缩动画结束（busyRef 释放）

  console.log("2) 悬浮展开（hover 状态，不聚焦）");
  const cardRect = JSON.parse(
    (await evalJs(`JSON.stringify((() => { const r = document.querySelector('.card-view').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })())`)) || "{}"
  );
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cardRect.x + cardRect.w / 2, y: cardRect.y + cardRect.h / 2 });
  await sleep(1600);
  assert(
    (await evalJs(`!!document.querySelector('.titlebar-title') && !document.querySelector('.card-view')`)) === true,
    "悬浮后展开为完整界面"
  );
  const before = await evalJs(`innerWidth + 'x' + innerHeight`);
  console.log(`   (展开后 ${before})`);

  console.log("3) 鼠标移出窗口后 600ms 内开始调整大小 -> 不应缩小");
  // 模拟：鼠标移出（mouseout）后立刻去拖右下角手柄
  const beforeW = await evalJs(`innerWidth`);
  const beforeH = await evalJs(`innerHeight`);
  await evalJs(`document.dispatchEvent(new MouseEvent('mouseout'))`); // 悬浮状态下移出窗口
  await sleep(150); // 用户正移向边缘
  // 开始拖手柄（pointerdown 落在 .resize-handle 上）
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: beforeW - 4, y: beforeH - 4, button: "left", clickCount: 1 });
  for (let i = 1; i <= 8; i++) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: beforeW - 4 + i * 18, y: beforeH - 4 + i * 12, button: "left" });
    await sleep(50);
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: beforeW - 4 + 144, y: beforeH - 4 + 96, button: "left", clickCount: 1 });
  await sleep(1500);
  const cardNow = await evalJs(`!!document.querySelector('.card-view')`);
  const sizeNow = await evalJs(`innerWidth + 'x' + innerHeight`);
  console.log(`   (调整后 ${sizeNow}, 卡片=${cardNow})`);
  assert(cardNow === false, "调整大小期间未误触发缩小（无卡片）");
  const [wNow] = sizeNow.split("x").map(Number);
  assert(wNow > beforeW, "调整生效（窗口尺寸增大，未回退）");

  console.log("4) 对照：悬浮展开后单纯移出（不调整）-> 应缩小");
  // 再进入卡片 -> 悬浮展开 -> 直接移出（不拖手柄）
  // 先失焦缩小
  let inCard2 = await evalJs(`!!document.querySelector('.card-view')`);
  if (!inCard2) {
    await evalJs(`window.__TAURI_INTERNALS__.invoke('plugin:window|set_focus')`);
    await sleep(700);
    try {
      execSync(
        'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/steal-focus.ps1 -ProcessName notepad',
        { stdio: "ignore" }
      );
    } catch {}
    for (let i = 0; i < 8 && !inCard2; i++) {
      await sleep(500);
      inCard2 = await evalJs(`!!document.querySelector('.card-view')`);
    }
  }
  const cardRect2 = JSON.parse(
    (await evalJs(`JSON.stringify((() => { const r = document.querySelector('.card-view').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })())`)) || "{}"
  );
  await sleep(800); // 等收缩动画结束
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cardRect2.x + cardRect2.w / 2, y: cardRect2.y + cardRect2.h / 2 });
  await sleep(1600);
  await evalJs(`document.dispatchEvent(new MouseEvent('mouseout'))`);
  await sleep(1300);
  const reCard = await evalJs(`!!document.querySelector('.card-view')`);
  assert(reCard === true, "单纯移出（无调整）仍会缩小");

  ws.close();
} finally {
  app.kill();
  try {
    execSync("taskkill /IM planer.exe /F", { stdio: "ignore" });
    execSync("taskkill /IM notepad.exe /F", { stdio: "ignore" });
  } catch {}
}

console.log(`\n调整大小防误缩结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
