// 通过 CDP 在真实应用里调用 Rust 命令，验证 IPC 桥（等待初始化完成）
import { spawn, execFileSync } from "node:child_process";

const exe = process.argv[2] || "src-tauri/target/release/planer.exe";
const PORT = 9226;
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_NAME = "Planer日程便签";

const app = spawn(exe, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "ignore",
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function regValueExists() {
  try {
    const out = execFileSync("reg", ["query", RUN_KEY, "/v", RUN_NAME], { encoding: "utf8" });
    return out.includes(RUN_NAME);
  } catch {
    return false;
  }
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
  const evalJs = (expression) =>
    new Promise((res) => {
      const mid = ++id;
      pending.set(mid, (r) => res(r?.result?.value));
      ws.send(JSON.stringify({ id: mid, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    });

  // 等待 Tauri 初始化完成
  for (let i = 0; i < 20; i++) {
    const ready = await evalJs(`typeof window.__TAURI_INTERNALS__ !== 'undefined' && !!document.querySelector('.titlebar-title')`);
    if (ready === true) break;
    await sleep(500);
  }
  const ready = await evalJs(`typeof window.__TAURI_INTERNALS__ !== 'undefined'`);
  assert(ready === true, "Tauri 运行时已注入");

  // 1) load_data 返回结构化数据
  const load = await evalJs(`window.__TAURI_INTERNALS__.invoke('load_data').then(
    (r) => r ? JSON.stringify({ currentDate: r.currentDate, tasks: (r.todayTasks||[]).length, hist: (r.history||[]).length }) : 'null',
    (e) => 'ERR:' + e
  )`);
  assert(typeof load === "string" && load.startsWith("{"), `load_data 成功（${load}）`);

  // 2) save_data -> load_data 往返（保留原始数据）
  const rt = await evalJs(`(async () => {
    const orig = await window.__TAURI_INTERNALS__.invoke('load_data');
    const backup = orig;
    await window.__TAURI_INTERNALS__.invoke('save_data', { data: { ...orig, probe: 42 } });
    const r = await window.__TAURI_INTERNALS__.invoke('load_data');
    const ok = r && r.probe === 42;
    delete backup.probe;
    await window.__TAURI_INTERNALS__.invoke('save_data', { data: backup });
    return ok;
  })()`);
  assert(rt === true, "save_data / load_data 往返一致（数据无损坏）");

  // 3) 开机启动：尝试写入注册表（本环境注册表被封锁，验证返回路径而非崩溃）
  const startup = await evalJs(`window.__TAURI_INTERNALS__.invoke('set_launch_at_startup', { enabled: true }).then(
    () => 'ok', (e) => 'err:' + String(e).slice(0, 120)
  )`);
  await sleep(1000);
  const inReg = regValueExists();
  if (startup === "ok" && inReg) {
    assert(true, "开机启动写入成功");
    await evalJs(`window.__TAURI_INTERNALS__.invoke('set_launch_at_startup', { enabled: false })`);
  } else {
    // 环境封锁注册表时：命令应优雅返回错误（不崩溃）
    console.log(`  (信息) set_launch_at_startup 返回: ${startup}, 注册表可见: ${inReg}`);
    assert(startup.startsWith("err:"), "注册表被环境封锁时命令返回可读错误而非静默失败");
  }

  // 4) 设置同步命令
  const sync = await evalJs(`(async () => {
    try {
      await window.__TAURI_INTERNALS__.invoke('set_close_action', { action: 'tray' });
      await window.__TAURI_INTERNALS__.invoke('set_fullscreen_auto_hide', { enabled: true });
      await window.__TAURI_INTERNALS__.invoke('set_fullscreen_auto_hide', { enabled: false });
      await window.__TAURI_INTERNALS__.invoke('set_close_action', { action: 'exit' });
      return true;
    } catch (e) { return String(e); }
  })()`);
  assert(sync === true, "set_close_action / set_fullscreen_auto_hide 调用成功");

  ws.close();
} finally {
  app.kill();
}

console.log(`IPC 结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
