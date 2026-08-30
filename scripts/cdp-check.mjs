// 通过 WebView2 CDP 检查真实应用页面渲染情况（带等待与错误捕获）
// 用法：node scripts/cdp-check.mjs <exe路径>
import { spawn } from "node:child_process";

const exe = process.argv[2] || "src-tauri/target/debug/planer.exe";
const PORT = 9222;

const app = spawn(exe, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "ignore",
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTargets() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page");
      if (page && page.url !== "about:blank") return page;
    } catch {
      /* not ready */
    }
    await sleep(500);
  }
  return null;
}

async function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    } else if (msg.method === "Runtime.consoleAPICalled") {
      const args = (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
      logs.push(`[console.${msg.params.type}] ${args}`);
    } else if (msg.method === "Runtime.exceptionThrown") {
      logs.push(`[exception] ${msg.params.exceptionDetails?.text} ${msg.params.exceptionDetails?.exception?.description ?? ""}`);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true });
    return r?.result?.value;
  };
  return { ws, send, evalJs, logs };
}

try {
  const target = await getTargets();
  if (!target) {
    console.error("CDP target not found (no non-blank page)");
    app.kill();
    process.exit(1);
  }
  console.log("target:", target.title, "|", target.url);
  const { ws, send, evalJs, logs } = await cdpSession(target.webSocketDebuggerUrl);
  await send("Runtime.enable");

  // 等待内容渲染（最多 15s）
  let state = null;
  for (let i = 0; i < 30; i++) {
    state = await evalJs(`JSON.stringify({
      bodyLen: document.body ? document.body.innerHTML.length : -1,
      titlebar: !!document.querySelector('.titlebar-title'),
      sections: document.querySelectorAll('.section-title').length,
      dateMain: document.querySelector('.date-main')?.textContent ?? null,
      emptyHints: document.querySelectorAll('.empty-hint').length,
      htmlTheme: document.documentElement.dataset.theme ?? null,
      htmlPreset: document.documentElement.dataset.preset ?? null,
    })`);
    if (state && JSON.parse(state).titlebar) break;
    await sleep(500);
  }
  console.log("PAGE STATE:", state);

  const bg = await evalJs(`getComputedStyle(document.querySelector('.app-root')).backgroundColor`);
  console.log("app-root bg:", bg);

  console.log("LOGS:");
  (logs.length ? logs : ["(none)"]).slice(0, 20).forEach((l) => console.log("  " + l));
  ws.close();
} finally {
  app.kill();
}
