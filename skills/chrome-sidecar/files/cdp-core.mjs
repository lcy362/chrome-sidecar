// cdp-core.mjs — 零依赖 Chrome DevTools Protocol 内核（Node 22+ 内置 WebSocket）
//
// 这一层只管两件事：
//   1. L0 端口发现：在「用户正常打开的 Chrome」上找到 CDP 端点
//   2. L1 原语：把 CDP 的裸命令包成可组合的函数，全部**不抢前台**
//
// 设计前提（已实机验证，Chrome 154 / macOS）：
//   · Target.createTarget{background:true} 建标签不会抢前台
//   · 后台标签上 evaluate / 真实鼠标点击 / 真实按键 / insertText /
//     setFileInputFiles / 截图（含全页）/ navigate 全部可用，且不会把标签切到前台
//   · 但后台标签的 setInterval 被节流到 ~1Hz、requestAnimationFrame 完全挂起
//     → 任何依赖页面内定时器/动画帧的逻辑都必须由 Node 侧驱动，见 browser.mjs
//
// 不依赖 Playwright：Playwright 连 ws 端点会挂（实测 30s 超时），且它多一层
// 无法控制的前台行为。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TIMEOUT = Number(process.env.CDP_TIMEOUT || 15000);

// ---------------------------------------------------------------------------
// L0: 端口发现
// ---------------------------------------------------------------------------

// Chrome 136+ 会忽略默认配置目录上的 --remote-debugging-port。
// 正常 Chrome 的调试端口只能通过 chrome://inspect/#remote-debugging 的开关开启，
// 开启后端口与 ws 路径会写进配置目录下的 DevToolsActivePort 文件（两行）。
//
// ⚠️ 路径易错点：macOS 上是 `Google/Chrome`（两层），**不是** `Google Chrome`。
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
  // 少数环境把该文件写在 profile 子目录下
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
  if (!port) throw new Error('DevToolsActivePort 内容异常: ' + file);
  return { port, wsPath: (lines[1] || '').trim() };
}

// 返回 { port, httpUrl, wsUrl, source }；找不到时抛出带指引的错误。
export function resolvePort({ verbose = false } = {}) {
  const tried = [];
  for (const f of candidatePortFiles()) {
    try {
      const { port, wsPath } = parsePortFile(f);
      const host = process.env.CDP_HOST || '127.0.0.1';
      if (verbose) console.log(`[cdp] 端口文件: ${f} (port=${port})`);
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
      '未找到 Chrome 调试端口。\n' +
      '请在**你正常使用的 Chrome**里打开 chrome://inspect/#remote-debugging，\n' +
      '勾选 "Allow remote debugging for this browser instance"，然后重试。\n' +
      '（Chrome 136+ 不允许用 --remote-debugging-port 调试默认配置目录；\n' +
      ' 若浏览器把 DevToolsActivePort 写在非标准位置，用 CDP_PORT_FILE 指定其完整路径。）'
    ),
    { code: 'NO_PORT_FILE', tried }
  );
}

// ---------------------------------------------------------------------------
// L1: 极简 CDP 客户端
// ---------------------------------------------------------------------------

export class CDP {
  #ws = null;
  #id = 0;
  #pending = new Map();
  #handlers = new Map();
  #closed = false;

  // timeoutMs 要给足：首次连接时 Chrome 会弹「要允许远程调试吗？」，
  // 需要用户手动点「允许」，握手会一直挂到那一刻才完成。
  static async connect(wsUrl, { timeoutMs = Number(process.env.CDP_CONNECT_TIMEOUT_MS || 120000) } = {}) {
    const c = new CDP();
    await c.#open(wsUrl, timeoutMs);
    return c;
  }

  get closed() { return this.#closed; }

  #open(wsUrl, timeoutMs) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl); // Node 22+ 内置，无需依赖
      this.#ws = ws;
      const timer = setTimeout(() => reject(new Error(
        `WebSocket 连接超时(${timeoutMs}ms)：若 Chrome 正在弹出「要允许远程调试吗？」，请点「允许」后重试。`
      )), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      ws.addEventListener('error', (e) => {
        clearTimeout(timer);
        reject(new Error('WebSocket 连接失败: ' + (e?.message || 'error')));
      });
      ws.addEventListener('close', () => this.#onClosed());
      ws.addEventListener('message', (ev) => this.#onMessage(ev));
    });
  }

  #onClosed() {
    this.#closed = true;
    for (const p of this.#pending.values()) p.reject(new Error('CDP 连接已关闭'));
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
    if (this.#closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = ++this.#id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP 超时(${TIMEOUT}ms): ${method}`));
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

  close() { try { this.#ws.close(); } catch { /* 已关闭 */ } }
}

// ---------------------------------------------------------------------------
// L1: 原语
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

// 在页面里执行表达式。fn 可以是字符串，也可以是函数（自动序列化并传 arg）。
export async function evaluate(cdp, sid, fn, arg, { awaitPromise = true, returnByValue = true } = {}) {
  const expression = typeof fn === 'function'
    ? `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`
    : String(fn);
  const res = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise, returnByValue, userGesture: true,
  }, sid);
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error('页面内异常: ' + (d.exception?.description || d.text || JSON.stringify(d)));
  }
  return res.result?.value;
}

export async function createTarget(cdp, url, { background = true, newWindow = false } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: url || 'about:blank', background, newWindow });
  return targetId;
}

export const closeTarget = (cdp, targetId) => cdp.send('Target.closeTarget', { targetId });

// 全页截图用 captureBeyondViewport，实测在后台标签上也能拿到正确尺寸与新帧。
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
  if (!nodeId) throw new Error('未找到文件输入框: ' + selector);
  await cdp.send('DOM.setFileInputFiles', { files, nodeId }, sid);
  return true;
}

// 元素中心的 CSS 坐标（视口坐标系）。
export const elementCenter = (cdp, sid, selector) => evaluate(cdp, sid, (sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
}, selector);

// 真实鼠标事件点击（走 Input 域，不依赖前台、不触发 bringToFront）。
export async function clickAt(cdp, sid, x, y, { button = 'left', clickCount = 1 } = {}) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sid);
  const base = { x, y, button, clickCount };
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 }, sid);
  await sleep(30);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 }, sid);
}

// 在元素上做一次真实点击。元素不存在返回 false，不抛错。
export async function clickElement(cdp, sid, selector, opts) {
  const c = await elementCenter(cdp, sid, selector);
  if (!c) return false;
  await clickAt(cdp, sid, c.x, c.y, opts);
  return true;
}

// 逐字符派发真实键盘事件（比 insertText 更接近人手；insertText 无 keydown）。
export async function typeText(cdp, sid, text, { delay = 40 } = {}) {
  for (const ch of text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch }, sid).catch(() => {});
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, sid).catch(() => {});
    if (delay) await sleep(delay);
  }
}

export const insertText = (cdp, sid, text) => cdp.send('Input.insertText', { text }, sid);

// Node 侧滚动（后台标签的页面内定时器会被节流，所以滚动必须由外部驱动）。
export async function scrollTo(cdp, sid, y, { behavior = 'instant' } = {}) {
  return evaluate(cdp, sid, (args) => { window.scrollTo({ top: args.y, behavior: args.behavior }); return window.scrollY; }, { y, behavior });
}

export async function mouseWheel(cdp, sid, deltaY, x = 100, y = 100) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY }, sid);
}

// 导航并等待加载完成。
// 只用 readyState 轮询，不依赖 CDP 事件：这样它对「直连会话」和「daemon 代理」
// 两种连接都成立（daemon 客户端无法接收事件）。
export async function navigate(conn, targetRef, url, { timeout = 30000 } = {}) {
  const u = new URL(url);
  if (!['http:', 'https:', 'file:', 'data:', 'about:'].includes(u.protocol)) {
    throw new Error('协议不被允许: ' + u.protocol);
  }
  await conn.send('Page.enable', {}, targetRef).catch(() => {});
  const res = await conn.send('Page.navigate', { url }, targetRef);
  if (res.errorText) throw new Error('导航失败: ' + res.errorText);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const st = await evaluate(conn, targetRef, 'document.readyState').catch(() => null);
    if (st === 'complete') return { ok: true, readyState: 'complete' };
    await sleep(200);
  }
  return { ok: true, readyState: 'timeout' };
}

// 无障碍树快照：给 agent 看页面结构的省 token 方式（比整页 HTML 便宜得多）。
// compact 模式会去掉两类冗余节点：纯排版节点（InlineTextBox/LineBreak），
// 以及名字与祖先完全相同的包装节点（StaticText 往往只是复述父节点的文字）。
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
  for (const n of nodes) walk(n.nodeId, 0, ''); // 兜底：孤儿节点
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

// 判定「是否需要人介入」的一组信号，供交接触发使用。
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
