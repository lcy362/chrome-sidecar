// cdp-daemon.mjs — persistent-connection daemon + client
//
// Why a daemon is mandatory:
//   Debugging authorisation on a normal Chrome (default profile) is granted **per connection** — every new
//   CDP connection raises an "Allow debugging?" prompt. If each script connected on its own,
//   the prompt would keep coming back. One resident process holding the **single** long-lived
//   connection reduces it to once per Chrome start.
//
// Architecture: CLI/library → local socket (NDJSON) → daemon → single WebSocket → Chrome
//             (UNIX socket; a named pipe on Windows)
//
// Start-up order (important): **bind the socket first, then connect to Chrome**.
//   The first connection waits for the user to click Allow, which can take tens of seconds.
//   Connecting to Chrome before binding leaves clients unable to reach us, with no clue why.
//   Now clients connect immediately and can poll `info` for progress.
//
// Lifecycle (three exit paths):
//   · idle beyond IDLE_TTL_MS (4 h default — leave the human room for passwords and QR codes)
//   · the Chrome side drops the connection (the user restarted Chrome)
//   · an explicit `cdp daemon stop`, SIGTERM or SIGINT
// Closing a tab only clears the session registry; it does not exit.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CDP, resolvePort, listPages, attach, sleep } from './cdp-core.mjs';

const RUNTIME_DIR = process.env.CDP_RUNTIME_DIR || path.join(os.homedir(), '.cache', 'cdp-browser-automation');
// Windows has no UNIX sockets, so use a named pipe. Pipe names are machine-global, hence the user suffix.
const SOCKET_PATH = process.platform === 'win32'
  ? `\\\\.\\pipe\\cdp-browser-automation-${String(process.env.USERNAME || 'default').replace(/[^\w.-]/g, '_')}`
  : path.join(RUNTIME_DIR, 'cdp.sock');
const STATE_PATH = path.join(RUNTIME_DIR, 'daemon.json');
const LOG_PATH = path.join(RUNTIME_DIR, 'daemon.log');
const IDLE_TTL_MS = Number(process.env.CDP_IDLE_TTL_MS || 4 * 60 * 60 * 1000);
const CONNECT_RETRIES = Number(process.env.CDP_DAEMON_RETRIES || 40);
const CONNECT_DELAY_MS = 150;
// The first connection waits for the user to click Allow; give it a full two minutes
const AUTH_TIMEOUT_MS = Number(process.env.CDP_AUTH_TIMEOUT_MS || 120000);

export { SOCKET_PATH, RUNTIME_DIR, LOG_PATH };

// ---------------------------------------------------------------------------
// Client
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
    const timer = setTimeout(() => finish(new Error('daemon response timeout: ' + payload.op)), timeout);
    sock.on('connect', () => sock.write(JSON.stringify(payload) + '\n'));
    sock.on('data', (d) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        const res = JSON.parse(buf.slice(0, nl));
        if (res.ok) finish(null, res.result);
        else finish(Object.assign(new Error(res.error), { op: payload.op }));
      } catch (e) { finish(new Error('failed to parse daemon response: ' + e.message)); }
    });
    sock.on('error', (e) => finish(e));
    sock.on('end', () => { if (!settled && !buf.trim()) finish(new Error('daemon closed the connection early')); });
  });
}

async function daemonAlive() {
  try { await requestOnce({ op: 'ping' }, { timeout: 2000 }); return true; }
  catch { return false; }
}

function spawnDaemon() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  // 'w' rather than 'a': every new daemon rewrites the log,
  // otherwise a stale run gets mistaken for the current one while debugging.
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
  } catch { return '(no log)'; }
}

// Get a usable daemon client, starting the daemon if needed and waiting until Chrome is connected.
export async function connectDaemon({ autoStart = true, verbose = false, waitConnected = true } = {}) {
  if (await daemonAlive()) {
    if (verbose) console.log('[cdp] reusing existing daemon');
  } else {
    if (!autoStart) throw new Error('daemon is not running and autoStart=false');
    // Clear a possibly stale socket, or clients will connect to a dead endpoint
    try { fs.unlinkSync(SOCKET_PATH); } catch { /* not present */ }
    const pid = spawnDaemon();
    if (verbose) console.log(`[cdp] started daemon (pid=${pid}), waiting for it to listen…`);
    let up = false;
    for (let i = 0; i < CONNECT_RETRIES; i++) {
      await sleep(CONNECT_DELAY_MS);
      if (await daemonAlive()) { up = true; break; }
    }
    if (!up) {
      throw new Error(
        'daemon failed to start (socket not ready).\n' +
        `--- daemon log tail ---\n${logTail()}`
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

  // Wait until the daemon is connected to Chrome. The first time a human must click Allow.
  const deadline = Date.now() + AUTH_TIMEOUT_MS;
  let info = null;
  let announced = false;
  while (Date.now() < deadline) {
    try { info = await requestOnce({ op: 'info' }, { timeout: 5000 }); } catch { info = null; }
    if (info?.connected) break;
    if (!announced) {
      console.log('⏳ Connecting to Chrome… if Chrome shows "Allow debugging?", click Allow.');
      console.log('   (If not authorised yet: open chrome://inspect/#remote-debugging and tick "Allow remote debugging for this browser instance")');
      announced = true;
    }
    await sleep(1000);
  }
  if (!info?.connected) {
    throw new Error(
      'Could not connect to Chrome (waited ' + Math.round(AUTH_TIMEOUT_MS / 1000) + 's).\n' +
      (info?.error ? 'Reason: ' + info.error + '\n' : '') +
      'Please check, in order:\n' +
      '  1) Chrome is open normally (and it really is Chrome);\n' +
      '  2) chrome://inspect/#remote-debugging is open, with\n' +
      '     "Allow remote debugging for this browser instance" ticked;\n' +
      '  3) you clicked Allow when the "Allow debugging?" prompt appeared.\n' +
      `--- daemon log tail ---\n${logTail()}`
    );
  }
  if (verbose) console.log(`[cdp] connected to ${info.browser}`);

  return client;
}

// ---------------------------------------------------------------------------
// Server (--serve)
// ---------------------------------------------------------------------------

async function serve() {
  if (process.platform !== 'win32') process.umask(0o077);
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(SOCKET_PATH); } catch { /* not present */ }

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

  // Connect to Chrome in the background without blocking socket readiness. Backoff retries cover:
  //   · the port file does not exist yet (the toggle is not ticked)
  //   · the handshake is pending while the user decides on the Allow prompt
  const connectPromise = (async () => {
    const deadline = Date.now() + AUTH_TIMEOUT_MS;
    let attempt = 0;
    let backoff = 2000;
    while (Date.now() < deadline) {
      attempt++;
      let c = null;
      try {
        if (!endpoint) endpoint = resolvePort({ verbose: true });
        if (!endpoint.wsUrl) throw new Error('DevToolsActivePort has no WebSocket path');
        c = await CDP.connect(endpoint.wsUrl, { timeoutMs: Math.max(20000, deadline - Date.now()) });
        const { product } = await c.send('Browser.getVersion').catch(() => ({ product: 'unknown' }));
        cdp = c;
        browserVersion = product;
        c.onClose(() => shutdown(0));                 // the user restarted Chrome
        c.onEvent('Target.detachedFromTarget', (p) => {
          for (const [tid, sid] of sessions) if (sid === p.sessionId) sessions.delete(tid);
        });
        c.onEvent('Target.targetDestroyed', (p) => sessions.delete(p.targetId));
        console.error(`[daemon] connected to ${product} @ ${endpoint.source}`);
        writeState();
        return true;
      } catch (e) {
        if (c) { try { c.close(); } catch { /* ignore */ } }
        connError = e;
        console.error(`[daemon] Chrome connect failed (attempt ${attempt}): ${e.message}`);
        endpoint = null;                              // the port may have changed; re-discover next round
        await sleep(Math.min(backoff, 15000));
        backoff *= 2;
      }
    }
    return false;
  })();

  // If the connection never succeeds, do not leave a permanently unusable daemon behind:
  // exit instead, so the next command runs the whole flow from scratch.
  connectPromise.then((ok) => {
    if (!ok) {
      console.error('[daemon] Chrome connection never succeeded; exiting');
      shutdown(1);
    }
  });

  // Any operation that needs Chrome waits for the connection first (including authorisation)
  const needCdp = async () => {
    if (cdp) return cdp;
    const ok = await connectPromise;
    if (!ok || !cdp) {
      throw new Error('Chrome is not connected yet' + (connError ? ': ' + connError.message : ''));
    }
    return cdp;
  };

  const ensureSession = async (targetId) => {
    const conn = await needCdp();
    if (sessions.has(targetId)) return sessions.get(targetId);
    const sid = await attach(conn, targetId);
    sessions.set(targetId, sid);

    // "Focus emulation + page activation": bring a **background** tab back to foreground-grade responsiveness.
    // Measured on Chrome 154 / macOS:
    //   setInterval(16ms)    2 ticks/s → 62 ticks/s
    //   requestAnimationFrame 0 callbacks/s → 61 callbacks/s
    //   Input.dispatchMouseEvent ack  stalled (>5s) → 8-18ms (unactivated acks are deferred indefinitely)
    // Crucially it does **not** bring the tab forward: verified against Chrome's active-tab fingerprint,
    // unchanged before and after the operation and after 25 s of idling.
    // Set CDP_NO_ACTIVATE=1 to disable (e.g. a site behaves differently when it believes it is visible).
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
    // These two do not need Chrome, so progress can be polled while waiting for authorisation
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
        throw new Error('Unknown op: ' + req.op);
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
    conn.on('error', () => { /* client disconnected early; ignore */ });
  });

  server.on('error', (e) => { console.error('[daemon] server error:', e.message); shutdown(1); });
  server.listen(SOCKET_PATH, () => {
    // A named pipe has no file permissions to set; tighten the UNIX socket to 0600
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
