// cdp-core.mjs — Zero-dependency Chrome DevTools Protocol kernel (Node 22+ built-in WebSocket)
//
// This layer does exactly two things:
//   1. L0 endpoint discovery: find the CDP endpoint on the Chrome the user is actually running
//   2. L1 primitives: wrap raw CDP commands into composable functions, none of which steal focus
//
// Design premises, measured on a real machine (Chrome 154 / macOS):
//   · Target.createTarget{background:true} creates a tab without stealing focus
//   · In a background tab, evaluate / real mouse clicks / real key events / insertText /
//     setFileInputFiles / screenshots (incl. full page) / navigate all work, and never bring the tab forward
//   · But in a background tab setInterval is throttled to ~1 Hz and requestAnimationFrame stops entirely
//     → anything relying on in-page timers or animation frames must be driven from Node; see browser.mjs
//
// No Playwright: it hangs on a bare ws endpoint (measured: 30 s timeout) and adds a layer of
// focus behaviour we do not control.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TIMEOUT = Number(process.env.CDP_TIMEOUT || 15000);

// ---------------------------------------------------------------------------
// L0: endpoint discovery
// ---------------------------------------------------------------------------

// Chrome 136+ silently ignores --remote-debugging-port on the default data directory.
// The only way to get a debugging port on a normal profile is the toggle at
// chrome://inspect/#remote-debugging, which writes the port and ws path into DevToolsActivePort.
//
// ⚠️ Easy to get wrong: on macOS the path is `Google/Chrome` (two levels), NOT `Google Chrome`.
const BROWSER_PROFILES = [
  // macOS
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/Google/Chrome Beta',
  'Library/Application Support/Google/Chrome Canary',
  'Library/Application Support/Google/Chrome for Testing',
  'Library/Application Support/Chromium',
  'Library/Application Support/BraveSoftware/Brave-Browser',
  'Library/Application Support/Microsoft Edge',
  // Linux
  '.config/google-chrome',
  '.config/google-chrome-beta',
  '.config/chromium',
  '.config/BraveSoftware/Brave-Browser',
  '.config/microsoft-edge',
  '.config/vivaldi',
];

export function candidatePortFiles() {
  const home = os.homedir();
  const out = [];
  if (process.env.CDP_PORT_FILE) out.push(process.env.CDP_PORT_FILE);
  for (const rel of BROWSER_PROFILES) out.push(path.join(home, rel, 'DevToolsActivePort'));
  // some environments place the file inside the profile subdirectory
  for (const rel of BROWSER_PROFILES) out.push(path.join(home, rel, 'Default', 'DevToolsActivePort'));
  if (process.env.LOCALAPPDATA) {
    for (const rel of ['Google/Chrome', 'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge']) {
      out.push(path.join(process.env.LOCALAPPDATA, rel, 'User Data', 'DevToolsActivePort'));
    }
  }
  if (process.platform === 'linux') {
    for (const rel of ['.var/app/com.google.Chrome/config/google-chrome', '.var/app/org.chromium.Chromium/config/chromium']) {
      out.push(path.join(home, rel, 'DevToolsActivePort'));
    }
  }
  return out;
}

export function parsePortFile(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const port = parseInt(lines[0], 10);
  if (!port) throw new Error('Malformed DevToolsActivePort: ' + file);
  return { port, wsPath: (lines[1] || '').trim() };
}

// Returns { port, httpUrl, wsUrl, source }; throws an error with instructions when nothing is found.
export function resolvePort({ verbose = false } = {}) {
  const tried = [];
  for (const f of candidatePortFiles()) {
    try {
      const { port, wsPath } = parsePortFile(f);
      const host = process.env.CDP_HOST || '127.0.0.1';
      if (verbose) console.log(`[cdp] port file: ${f} (port=${port})`);
      return {
        port,
        httpUrl: `http://${host}:${port}`,
        wsUrl: wsPath ? `ws://${host}:${port}${wsPath}` : null,
        source: f,
      };
    } catch {
      tried.push(f);
    }
  }
  throw Object.assign(
    new Error(
      'No Chrome debugging port found.\n' +
      'Open chrome://inspect/#remote-debugging in the Chrome you normally use and tick\n' +
      '"Allow remote debugging for this browser instance", then retry.\n' +
      '(Chrome 136+ does not allow --remote-debugging-port against the default data directory;\n' +
      ' if your browser writes DevToolsActivePort elsewhere, point CDP_PORT_FILE at it.)'
    ),
    { code: 'NO_PORT_FILE', tried }
  );
}

// ---------------------------------------------------------------------------
// L1: minimal CDP client
// ---------------------------------------------------------------------------

export class CDP {
  #ws = null;
  #id = 0;
  #pending = new Map();
  #handlers = new Map();
  #closed = false;

  // Give timeoutMs plenty of room: on first connect Chrome shows an "Allow debugging?" prompt
  // and the handshake stays pending until the user clicks Allow.
  static async connect(wsUrl, { timeoutMs = Number(process.env.CDP_CONNECT_TIMEOUT_MS || 120000) } = {}) {
    const c = new CDP();
    await c.#open(wsUrl, timeoutMs);
    return c;
  }

  get closed() { return this.#closed; }

  #open(wsUrl, timeoutMs) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl); // Node 22+ built-in; no dependency
      this.#ws = ws;
      const timer = setTimeout(() => reject(new Error(
        `WebSocket connect timed out (${timeoutMs}ms): if Chrome is showing "Allow debugging?", click Allow and retry.`
      )), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      ws.addEventListener('error', (e) => {
        clearTimeout(timer);
        reject(new Error('WebSocket connect failed: ' + (e?.message || 'error')));
      });
      ws.addEventListener('close', () => this.#onClosed());
      ws.addEventListener('message', (ev) => this.#onMessage(ev));
    });
  }

  #onClosed() {
    this.#closed = true;
    for (const p of this.#pending.values()) p.reject(new Error('CDP connection closed'));
    this.#pending.clear();
    for (const h of this.#handlers.get('__close') || []) h();
  }

  #onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id !== undefined && this.#pending.has(msg.id)) {
      const p = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      for (const h of this.#handlers.get(msg.method) || []) h(msg.params, msg.sessionId);
      for (const h of this.#handlers.get('*') || []) h(msg.method, msg.params, msg.sessionId);
    }
  }

  send(method, params = {}, sessionId) {
    if (this.#closed) return Promise.reject(new Error('CDP connection closed'));
    const id = ++this.#id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP timeout (${TIMEOUT}ms): ${method}`));
      }, TIMEOUT);
      this.#pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.#ws.send(JSON.stringify(payload));
    });
  }

  onEvent(method, handler) {
    if (!this.#handlers.has(method)) this.#handlers.set(method, new Set());
    this.#handlers.get(method).add(handler);
    return () => this.#handlers.get(method)?.delete(handler);
  }

  onClose(handler) { return this.onEvent('__close', handler); }

  close() { try { this.#ws.close(); } catch { /* already closed */ } }
}

// ---------------------------------------------------------------------------
// L1: primitives
// ---------------------------------------------------------------------------

export async function listPages(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos.filter(t => t.type === 'page' && !t.url.startsWith('chrome://'));
}

export async function attach(cdp, targetId) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return sessionId;
}

const detach = (cdp, sessionId) =>
  cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});

export { detach };

// Evaluate in the page. fn may be a string or a function (serialised, with arg passed in).
export async function evaluate(cdp, sid, fn, arg, { awaitPromise = true, returnByValue = true } = {}) {
  const expression = typeof fn === 'function'
    ? `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`
    : String(fn);
  const res = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise, returnByValue, userGesture: true,
  }, sid);
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error('Page exception: ' + (d.exception?.description || d.text || JSON.stringify(d)));
  }
  return res.result?.value;
}

export async function createTarget(cdp, url, { background = true, newWindow = false } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: url || 'about:blank', background, newWindow });
  return targetId;
}

export const closeTarget = (cdp, targetId) => cdp.send('Target.closeTarget', { targetId });

// Full page uses captureBeyondViewport; measured to give correct dimensions and a fresh frame in a background tab.
export async function screenshot(cdp, sid, filePath, { fullPage = false } = {}) {
  const params = fullPage ? { format: 'png', captureBeyondViewport: true } : { format: 'png' };
  const { data } = await cdp.send('Page.captureScreenshot', params, sid);
  const buf = Buffer.from(data, 'base64');
  if (filePath) fs.writeFileSync(filePath, buf);
  return buf;
}

export async function setFileInputFiles(cdp, sid, selector, files) {
  await cdp.send('DOM.enable', {}, sid).catch(() => {});
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }, sid);
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector }, sid);
  if (!nodeId) throw new Error('File input not found: ' + selector);
  await cdp.send('DOM.setFileInputFiles', { files, nodeId }, sid);
  return true;
}

// CSS coordinates of an element's centre (viewport space).
export const elementCenter = (cdp, sid, selector) => evaluate(cdp, sid, (sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
}, selector);

// Real mouse click through the Input domain — needs no foreground and never triggers bringToFront.
export async function clickAt(cdp, sid, x, y, { button = 'left', clickCount = 1 } = {}) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sid);
  const base = { x, y, button, clickCount };
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 }, sid);
  await sleep(30);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 }, sid);
}


// Dispatch real key events character by character (closer to a human; insertText emits no keydown).
export async function typeText(cdp, sid, text, { delay = 40 } = {}) {
  for (const ch of text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch }, sid).catch(() => {});
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, sid).catch(() => {});
    if (delay) await sleep(delay);
  }
}

export const insertText = (cdp, sid, text) => cdp.send('Input.insertText', { text }, sid);

// Scrolling driven from Node (in-page timers are throttled in background tabs, so the outside must drive it).
export async function scrollTo(cdp, sid, y, { behavior = 'instant' } = {}) {
  return evaluate(cdp, sid, (args) => { window.scrollTo({ top: args.y, behavior: args.behavior }); return window.scrollY; }, { y, behavior });
}

export async function mouseWheel(cdp, sid, deltaY, x = 100, y = 100) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY }, sid);
}

// Navigate and wait for the load to finish.
// Polls readyState only, with no CDP events, so it works both for a direct session and
// through the daemon proxy (a daemon client cannot receive events).
export async function navigate(conn, targetRef, url, { timeout = 30000 } = {}) {
  const u = new URL(url);
  if (!['http:', 'https:', 'file:', 'data:', 'about:'].includes(u.protocol)) {
    throw new Error('Protocol not allowed: ' + u.protocol);
  }
  await conn.send('Page.enable', {}, targetRef).catch(() => {});
  const res = await conn.send('Page.navigate', { url }, targetRef);
  if (res.errorText) throw new Error('Navigation failed: ' + res.errorText);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const st = await evaluate(conn, targetRef, 'document.readyState').catch(() => null);
    if (st === 'complete') return { ok: true, readyState: 'complete' };
    await sleep(200);
  }
  return { ok: true, readyState: 'timeout' };
}

// Accessibility-tree snapshot: a token-cheap way to show an agent the page structure.
// compact mode drops two kinds of redundant node: pure layout nodes (InlineTextBox/LineBreak), and
// wrappers whose name equals an ancestor's (StaticText usually just repeats its parent's text).
export async function snapshot(cdp, sid, { compact = true, maxDepth = 12 } = {}) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree', {}, sid);
  const byId = new Map(nodes.map(n => [n.nodeId, n]));
  const parentOf = (n) => n.parentId || n.parentID;
  const children = new Map();
  for (const n of nodes) {
    const p = parentOf(n);
    if (p) {
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(n.nodeId);
    }
  }
  const LAYOUT_ONLY = new Set(['InlineTextBox', 'LineBreak']);
  const WRAPPER_ROLES = new Set(['StaticText', 'InlineTextBox', 'generic', 'none']);
  const lines = [];
  const seen = new Set();

  const walk = (nodeId, depth, ancestorName) => {
    if (seen.has(nodeId) || depth > maxDepth) return;
    seen.add(nodeId);
    const n = byId.get(nodeId);
    if (!n || n.ignored) return;

    const role = n.role?.value || '';
    const name = (n.name?.value || '').trim();
    const value = n.value?.value === undefined ? '' : String(n.value.value);

    const redundant = compact && (
      LAYOUT_ONLY.has(role) ||
      (WRAPPER_ROLES.has(role) && !!name && name === ancestorName)
    );
    const empty = !name && !value;
    if (!redundant && (!empty || !compact)) {
      const shown = role === 'textbox' && value ? `[${value}]` : value;
      const label = [name, shown].filter(Boolean).join(' ').trim();
      lines.push('  '.repeat(depth) + (label ? `${role} "${label}"` : role));
    }
    const nextDepth = redundant ? depth : depth + 1;
    const nextAncestor = redundant ? ancestorName : (name || ancestorName);
    for (const c of children.get(nodeId) || []) walk(c, nextDepth, nextAncestor);
  };

  for (const n of nodes) {
    const p = parentOf(n);
    if (!p || !byId.has(p)) walk(n.nodeId, 0, '');
  }
  for (const n of nodes) walk(n.nodeId, 0, ''); // fallback pass: orphan nodes
  return lines.join('\n');
}

export async function resourceTiming(cdp, sid) {
  return evaluate(cdp, sid, () => performance.getEntriesByType('resource').map(e => ({
    name: e.name.length > 120 ? e.name.slice(0, 120) : e.name,
    type: e.initiatorType,
    ms: Math.round(e.duration),
    kb: Math.round((e.transferSize || 0) / 1024),
  })));
}

export async function devicePixelRatio(cdp, sid) {
  return (await evaluate(cdp, sid, 'devicePixelRatio')) || 1;
}

// Signals for "does a human need to step in", used to trigger a handoff.
export async function detectHumanNeeded(cdp, sid) {
  return evaluate(cdp, sid, () => {
    const txt = (document.body?.innerText || '').slice(0, 20000);
    const has = (re) => re.test(txt);
    const pwd = document.querySelectorAll('input[type="password"]').length;
    return {
      passwordFields: pwd,
      loginWall: pwd > 0 || has(/登录|登入|sign in|log in|扫码登录|手机号登录/i),
      captcha: has(/验证码|captcha|人机验证|安全验证|滑块|拖动滑块|请完成验证/i),
      twoFactor: has(/双因子|两步验证|二次验证|2fa|authenticator|动态口令/i),
      paywall: has(/支付|付款|确认支付|请扫码支付|余额不足/i),
      fileChooserHint: has(/选择文件|上传附件|choose file/i),
    };
  });
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const randWait = (min, max) => sleep(min + Math.random() * (max - min));
