// cdp-daemon.mjs — 常驻连接守护进程 + 客户端
//
// 为什么必须有 daemon：
//   正常 Chrome（默认配置目录）的调试授权是**按连接**授予的——每建立一条新的
//   CDP 连接，Chrome 就弹一次「要允许远程调试吗？」。如果每个脚本各自连一次，
//   弹窗会反复出现。用一个常驻进程持有**唯一**长连接，授权就只在
//   「每次 Chrome 启动后」发生一次。
//
// 架构：CLI/库 → 本地 socket(NDJSON) → daemon → 唯一 WebSocket → Chrome
//       （UNIX socket；Windows 走命名管道）
//
// 启动时序（关键）：**先把 socket 建起来，再去连 Chrome**。
//   因为首次连接要等用户在 Chrome 里点「允许」，可能要等几十秒。
//   若先连 Chrome 再建 socket，客户端会在这段时间里连不上、还看不出原因。
//   现在客户端可以立刻连上，用 `info` 查询连接进度。
//
// 生命周期（三条退出路径）：
//   · 空闲超过 IDLE_TTL_MS（默认 4 小时——要给人留出输密码/扫码的时间）
//   · Chrome 侧连接断开（用户重启了 Chrome）
//   · 显式 `cdp daemon stop` / SIGTERM / SIGINT
// 另外：标签被关闭只清理会话注册表，不退出。

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CDP, resolvePort, listPages, attach, sleep } from './cdp-core.mjs';

const RUNTIME_DIR = process.env.CDP_RUNTIME_DIR || path.join(os.homedir(), '.cache', 'cdp-browser-automation');
// Windows 没有 UNIX socket，改用命名管道；管道名是机器全局的，所以要带用户名做隔离。
const SOCKET_PATH = process.platform === 'win32'
  ? `\\\\.\\pipe\\cdp-browser-automation-${String(process.env.USERNAME || 'default').replace(/[^\w.-]/g, '_')}`
  : path.join(RUNTIME_DIR, 'cdp.sock');
const STATE_PATH = path.join(RUNTIME_DIR, 'daemon.json');
const LOG_PATH = path.join(RUNTIME_DIR, 'daemon.log');
const IDLE_TTL_MS = Number(process.env.CDP_IDLE_TTL_MS || 4 * 60 * 60 * 1000);
const CONNECT_RETRIES = Number(process.env.CDP_DAEMON_RETRIES || 40);
const CONNECT_DELAY_MS = 150;
// 首次连接要等用户点「允许远程调试」，给足 2 分钟
const AUTH_TIMEOUT_MS = Number(process.env.CDP_AUTH_TIMEOUT_MS || 120000);

export { SOCKET_PATH, RUNTIME_DIR, LOG_PATH };

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

function requestOnce(payload, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCKET_PATH);
    let buf = '';
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('daemon 响应超时: ' + payload.op)), timeout);
    sock.on('connect', () => sock.write(JSON.stringify(payload) + '\n'));
    sock.on('data', (d) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        const res = JSON.parse(buf.slice(0, nl));
        if (res.ok) finish(null, res.result);
        else finish(Object.assign(new Error(res.error), { op: payload.op }));
      } catch (e) { finish(new Error('daemon 响应解析失败: ' + e.message)); }
    });
    sock.on('error', (e) => finish(e));
    sock.on('end', () => { if (!settled && !buf.trim()) finish(new Error('daemon 提前关闭连接')); });
  });
}

async function daemonAlive() {
  try { await requestOnce({ op: 'ping' }, { timeout: 2000 }); return true; }
  catch { return false; }
}

function spawnDaemon() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  // 'w' 而不是 'a'：每次拉起新 daemon 都重写日志，
  // 否则排障时会把上一轮的记录误读成本次的状态。
  const log = fs.openSync(LOG_PATH, 'w');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve'], {
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  child.unref();
  return child.pid;
}

function logTail(n = 20) {
  try {
    return fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').slice(-n).join('\n');
  } catch { return '(无日志)'; }
}

// 拿到一个可用的 daemon 客户端；需要时自动拉起 daemon，并等到与 Chrome 建连成功。
export async function connectDaemon({ autoStart = true, verbose = false, waitConnected = true } = {}) {
  if (await daemonAlive()) {
    if (verbose) console.log('[cdp] 复用已有 daemon');
  } else {
    if (!autoStart) throw new Error('daemon 未运行，且 autoStart=false');
    // 清理可能残留的 socket，否则客户端会连到一个死端点
    try { fs.unlinkSync(SOCKET_PATH); } catch { /* 不存在 */ }
    const pid = spawnDaemon();
    if (verbose) console.log(`[cdp] 已拉起 daemon (pid=${pid})，等待其监听…`);
    let up = false;
    for (let i = 0; i < CONNECT_RETRIES; i++) {
      await sleep(CONNECT_DELAY_MS);
      if (await daemonAlive()) { up = true; break; }
    }
    if (!up) {
      throw new Error(
        'daemon 启动失败（socket 未就绪）。\n' +
        `--- daemon 日志尾部 ---\n${logTail()}`
      );
    }
  }

  const client = {
    request: (op, extra = {}) => requestOnce({ op, ...extra }),
    info: () => requestOnce({ op: 'info' }),
    targets: () => requestOnce({ op: 'targets' }),
    attach: (targetId) => requestOnce({ op: 'attach', targetId }),
    call: (method, params = {}, targetId) => requestOnce({ op: 'call', method, params, targetId }),
    newTarget: (url, background = true) => requestOnce({ op: 'newTarget', url, background }),
    closeTarget: (targetId) => requestOnce({ op: 'closeTarget', targetId }),
    stop: () => requestOnce({ op: 'stop' }).catch(() => null),
  };
  if (!waitConnected) return client;

  // 等 daemon 与 Chrome 建连。首次会弹「要允许远程调试吗？」，需要人工点「允许」。
  const deadline = Date.now() + AUTH_TIMEOUT_MS;
  let info = null;
  let announced = false;
  while (Date.now() < deadline) {
    try { info = await requestOnce({ op: 'info' }, { timeout: 5000 }); } catch { info = null; }
    if (info?.connected) break;
    if (!announced) {
      console.log('⏳ 正在连接 Chrome… 若 Chrome 弹出了「要允许远程调试吗？」，请点「允许」。');
      console.log('   （若还没授权：地址栏打开 chrome://inspect/#remote-debugging，勾选 Allow remote debugging for this browser instance）');
      announced = true;
    }
    await sleep(1000);
  }
  if (!info?.connected) {
    throw new Error(
      '未能连接 Chrome（等了 ' + Math.round(AUTH_TIMEOUT_MS / 1000) + 's）。\n' +
      (info?.error ? '原因: ' + info.error + '\n' : '') +
      '请依次确认：\n' +
      '  1) Chrome 已正常打开（不是别的浏览器）；\n' +
      '  2) 地址栏打开 chrome://inspect/#remote-debugging 并勾选\n' +
      '     "Allow remote debugging for this browser instance"；\n' +
      '  3) 出现「要允许远程调试吗？」时点了「允许」。\n' +
      `--- daemon 日志尾部 ---\n${logTail()}`
    );
  }
  if (verbose) console.log(`[cdp] 已连接 ${info.browser}`);

  return client;
}

// ---------------------------------------------------------------------------
// 服务端（--serve）
// ---------------------------------------------------------------------------

async function serve() {
  if (process.platform !== 'win32') process.umask(0o077);
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(SOCKET_PATH); } catch { /* 不存在 */ }

  let endpoint = null;
  let cdp = null;
  let connError = null;
  let browserVersion = 'connecting…';

  /** @type {Map<string, string>} targetId -> sessionId */
  const sessions = new Map();
  let alive = true;
  let idleTimer = null;
  let server = null;

  const shutdown = (code = 0) => {
    if (!alive) return;
    alive = false;
    clearTimeout(idleTimer);
    try { server?.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
    try { fs.unlinkSync(STATE_PATH); } catch { /* ignore */ }
    try { cdp?.close(); } catch { /* ignore */ }
    setTimeout(() => process.exit(code), 50);
  };
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => shutdown(0), IDLE_TTL_MS);
  };
  resetIdle();

  const writeState = () => {
    try {
      fs.writeFileSync(STATE_PATH, JSON.stringify({
        pid: process.pid, connected: !!cdp, browser: browserVersion,
        source: endpoint?.source || null, startedAt: Date.now(),
      }, null, 2));
    } catch { /* ignore */ }
  };

  // 后台连接 Chrome，不阻塞 socket 就绪。带退避重试以覆盖两种情况：
  //   · 端口文件还没出现（用户还没勾选开关）
  //   · 握手挂起在等用户点「允许」
  const connectPromise = (async () => {
    const deadline = Date.now() + AUTH_TIMEOUT_MS;
    let attempt = 0;
    let backoff = 2000;
    while (Date.now() < deadline) {
      attempt++;
      let c = null;
      try {
        if (!endpoint) endpoint = resolvePort({ verbose: true });
        if (!endpoint.wsUrl) throw new Error('DevToolsActivePort 里没有 WebSocket 路径');
        c = await CDP.connect(endpoint.wsUrl, { timeoutMs: Math.max(20000, deadline - Date.now()) });
        const { product } = await c.send('Browser.getVersion').catch(() => ({ product: 'unknown' }));
        cdp = c;
        browserVersion = product;
        c.onClose(() => shutdown(0));                 // 用户重启了 Chrome
        c.onEvent('Target.detachedFromTarget', (p) => {
          for (const [tid, sid] of sessions) if (sid === p.sessionId) sessions.delete(tid);
        });
        c.onEvent('Target.targetDestroyed', (p) => sessions.delete(p.targetId));
        console.error(`[daemon] 已连接 ${product} @ ${endpoint.source}`);
        writeState();
        return true;
      } catch (e) {
        if (c) { try { c.close(); } catch { /* ignore */ } }
        connError = e;
        console.error(`[daemon] 连接 Chrome 失败(第 ${attempt} 次): ${e.message}`);
        endpoint = null;                              // 端口可能变了，下一轮重新探测
        await sleep(Math.min(backoff, 15000));
        backoff *= 2;
      }
    }
    return false;
  })();

  // 连接始终失败就不要留着一个永远不可用的 daemon：
  // 直接退出，让下一次命令重新走一遍完整流程。
  connectPromise.then((ok) => {
    if (!ok) {
      console.error('[daemon] 连接 Chrome 始终失败，退出');
      shutdown(1);
    }
  });

  // 任何依赖 Chrome 的操作，先等连接就绪（含等待用户授权）
  const needCdp = async () => {
    if (cdp) return cdp;
    const ok = await connectPromise;
    if (!ok || !cdp) {
      throw new Error('尚未连接 Chrome' + (connError ? '：' + connError.message : ''));
    }
    return cdp;
  };

  const ensureSession = async (targetId) => {
    const conn = await needCdp();
    if (sessions.has(targetId)) return sessions.get(targetId);
    const sid = await attach(conn, targetId);
    sessions.set(targetId, sid);

    // 「伪聚焦 + 页面激活」：把一个**后台**标签恢复到前台级响应能力。
    // 实测（Chrome 154 / macOS）：
    //   setInterval(16ms)  2 次/秒 → 62 次/秒
    //   requestAnimationFrame  0 次/秒 → 61 次/秒
    //   Input.dispatchMouseEvent ack  超时(>5s) → 8~18ms（不激活时 ack 会被无限期拖住）
    // 关键是它**不会**把标签切到前台：用 AppleScript 读 Chrome 活动标签指纹验证，
    // 操作前后与静置 25 秒后均未变化。
    // 设 CDP_NO_ACTIVATE=1 可关闭（例如某站点被伪可见状态影响了行为）。
    if (process.env.CDP_NO_ACTIVATE !== '1') {
      await conn.send('Page.enable', {}, sid).catch(() => {});
      await conn.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sid).catch(() => {});
      await conn.send('Page.setWebLifecycleState', { state: 'active' }, sid).catch(() => {});
    }
    return sid;
  };

  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));

  const handle = async (req) => {
    // 这两个操作不依赖 Chrome，用于在授权等待期间查询进度
    if (req.op === 'ping') return { pong: true, pid: process.pid, connected: !!cdp };
    if (req.op === 'info') {
      return {
        pid: process.pid,
        connected: !!cdp,
        browser: browserVersion,
        error: connError ? connError.message : null,
        source: endpoint?.source || null,
        port: endpoint?.port || null,
        sessions: [...sessions.keys()].map(id => id.slice(0, 8)),
        idleTtlMs: IDLE_TTL_MS,
      };
    }
    if (req.op === 'stop') {
      resetIdle();
      setImmediate(() => shutdown(0));
      return { stopping: true };
    }

    const conn = await needCdp();
    switch (req.op) {
      case 'targets':
        return listPages(conn);
      case 'attach':
        return { sessionId: await ensureSession(req.targetId) };
      case 'call': {
        const sid = req.targetId ? await ensureSession(req.targetId) : undefined;
        return conn.send(req.method, req.params || {}, sid);
      }
      case 'newTarget':
        return { targetId: (await conn.send('Target.createTarget', {
          url: req.url || 'about:blank', background: req.background !== false,
        })).targetId };
      case 'closeTarget':
        return conn.send('Target.closeTarget', { targetId: req.targetId });
      default:
        throw new Error('未知操作: ' + req.op);
    }
  };

  server = net.createServer((conn) => {
    resetIdle();
    let buf = '';
    conn.on('data', async (d) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const result = await handle(JSON.parse(line));
        conn.end(JSON.stringify({ ok: true, result }) + '\n');
      } catch (e) {
        conn.end(JSON.stringify({ ok: false, error: e.message }) + '\n');
      }
    });
    conn.on('error', () => { /* 客户端提前断开，忽略 */ });
  });

  server.on('error', (e) => { console.error('[daemon] server error:', e.message); shutdown(1); });
  server.listen(SOCKET_PATH, () => {
    // 命名管道没有文件权限可设；UNIX socket 收紧到 0600
    if (process.platform !== 'win32') fs.chmodSync(SOCKET_PATH, 0o600);
    writeState();
    console.error('[daemon] listening on ' + SOCKET_PATH);
  });
}

const isServe = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  && process.argv.includes('--serve');
if (isServe) {
  serve().catch((e) => { console.error('[daemon] fatal:', e.message); process.exit(1); });
}
