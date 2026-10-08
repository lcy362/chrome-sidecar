// browser.mjs — 策略层（本技能的核心资产）
//
// 上面两层（cdp-core / cdp-daemon）解决「怎么连、怎么下命令」；
// 这一层解决「下完命令怎么确认它真的生效，并且不打扰用户」。
//
// 两个贯穿全层的原则：
//   1. 不抢前台 —— 所有操作都走 CDP/Input 或 evaluate，只在后台标签上生效，
//      绝不调用 bringToFront。用户正在打字时 agent 不会把标签抢走。
//   2. Node 侧驱动 —— 后台标签的 setInterval 被节流到 ~1Hz、requestAnimationFrame
//      完全挂起（已实机验证），所以滚动、等待、轮询一律由 Node 侧循环驱动，
//      不放进页面里跑定时器。
//
// 用法：
//   import { connectCDP, ensureOn, scrollFull, shot, uploadAndVerify, waitForHuman }
//     from './files/browser.mjs';
//   const { page, findPage, newPage } = await connectCDP();
//   const app = findPage('example.com') || await newPage('https://example.com');

import * as core from './cdp-core.mjs';
import { connectDaemon } from './cdp-daemon.mjs';

export { sleep, randWait } from './cdp-core.mjs';
const { sleep } = core;

// 把 daemon 客户端适配成 cdp-core 期望的连接接口（send(method, params, targetRef)）
function asConn(client) {
  return {
    send: (method, params = {}, targetRef) => client.call(method, params, targetRef),
    raw: client,
  };
}

// ---------------------------------------------------------------------------
// 连接
// ---------------------------------------------------------------------------

export async function connectCDP({ verbose = false } = {}) {
  const client = await connectDaemon({ verbose });
  const conn = asConn(client);

  const listTargets = () => client.targets();
  const find = (substr) => listTargets().then(ts => ts.find(t => t.url.includes(substr)) || null);
  const newPage = async (url) => {
    // background:true —— 关键：新标签不会把用户正在看的页面挤到后面
    const { targetId } = await client.newTarget(url || 'about:blank', true);
    const p = new Page(conn, targetId);
    if (url) await p.waitReady();
    return p;
  };
  const openPage = async (url) => {
    if (url) {
      const existing = await find(url);
      if (existing) return new Page(conn, existing.targetId);
    }
    return newPage(url);
  };

  return {
    client,
    conn,
    listTargets,
    findPage: async (substr) => {
      const t = await find(substr);
      return t ? new Page(conn, t.targetId) : null;
    },
    openPage,
    newPage,
    closePage: (page) => client.closeTarget(page.targetId),
    disconnect: () => client.stop(),
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export class Page {
  constructor(conn, targetId) {
    this.conn = conn;
    this.targetId = targetId;
    this.targetRef = targetId;
  }

  // ---- 读取 ----
  evaluate(fn, arg) { return core.evaluate(this.conn, this.targetRef, fn, arg); }
  url() { return this.evaluate('location.href'); }
  title() { return this.evaluate('document.title'); }
  count(selector) { return this.evaluate(s => document.querySelectorAll(s).length, selector); }
  text(selector) { return this.evaluate(s => document.querySelector(s)?.innerText ?? null, selector); }
  visible() { return this.evaluate('document.visibilityState'); }
  dpr() { return core.devicePixelRatio(this.conn, this.targetRef); }
  snapshot(opts) { return core.snapshot(this.conn, this.targetRef, opts); }
  net() { return core.resourceTiming(this.conn, this.targetRef); }
  humanNeeded() { return core.detectHumanNeeded(this.conn, this.targetRef); }

  // ---- 导航 ----
  goto(url, opts) { return core.navigate(this.conn, this.targetRef, url, opts); }
  async reload(opts) { return core.navigate(this.conn, this.targetRef, await this.url(), opts); }

  async waitReady({ timeout = 15000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const st = await this.evaluate('document.readyState').catch(() => null);
      if (st === 'complete') return true;
      await sleep(150);
    }
    return false;
  }

  // Node 侧轮询等元素出现（不用页面内定时器）
  async waitForSelector(selector, { timeout = 10000, interval = 200 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const n = await this.count(selector).catch(() => 0);
      if (n > 0) return true;
      await sleep(interval);
    }
    return false;
  }

  waitForTimeout = (ms) => sleep(ms);

  // ---- 操作 ----
  async click(selector, { timeout = 8000, via = 'input', human = false } = {}) {
    if (!(await this.waitForSelector(selector, { timeout }))) {
      throw new Error('点击失败，未找到元素: ' + selector);
    }
    if (via === 'dom') {
      // DOM 级点击：更快，且能绕过 z-index 遮罩拦截真实指针的场合
      await this.evaluate(s => document.querySelector(s).click(), selector);
      return true;
    }
    const c = await core.elementCenter(this.conn, this.targetRef, selector);
    if (!c) throw new Error('点击失败，元素无布局盒: ' + selector);
    try {
      if (human) await humanClickAt(this, c.x, c.y);
      else await core.clickAt(this.conn, this.targetRef, c.x, c.y);
      return true;
    } catch (e) {
      // 输入事件的 ack 在未被激活的后台标签上会被无限期拖住，此时回退 DOM 点击
      console.log(`  ⚠ 真实点击失败(${e.message})，回退 DOM 点击: ${selector}`);
      await this.evaluate(s => document.querySelector(s).click(), selector);
      return true;
    }
  }

  // 按可见文本找元素并点击。
  // 选元素的优先级：精确文本 > 可交互标签 > DOM 更深（更具体）。
  // 只用 innerText.includes 会在「按钮外层还套了一层 div」时先命中那个 div，
  // 结果点在容器的空白处，什么都不会发生。
  async clickText(text, { timeout = 8000, via = 'input' } = {}) {
    const selector = await this.evaluate((t) => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const INTERACTIVE = 'button, a, [role="button"], [role="link"], [role="tab"], ' +
        'input[type="submit"], input[type="button"], [onclick], [tabindex]';
      const depthOf = (el) => { let d = 0; for (let p = el.parentElement; p; p = p.parentElement) d++; return d; };
      const pick = (nodes) => {
        const cands = nodes.filter(el => {
          const it = norm(el.innerText);
          return it === t || it.includes(t);
        });
        if (!cands.length) return null;
        cands.sort((a, b) => {
          const ka = [norm(a.innerText) === t ? 1 : 0, a.matches(INTERACTIVE) ? 1 : 0, depthOf(a)];
          const kb = [norm(b.innerText) === t ? 1 : 0, b.matches(INTERACTIVE) ? 1 : 0, depthOf(b)];
          return (kb[0] - ka[0]) || (kb[1] - ka[1]) || (kb[2] - ka[2]);
        });
        return cands[0];
      };
      const el = pick(Array.from(document.querySelectorAll(INTERACTIVE)))
        || pick(Array.from(document.querySelectorAll('span, div, li, td, label, p, h1, h2, h3')));
      if (!el) return null;
      el.setAttribute('data-cdp-target', '1');
      return '[data-cdp-target="1"]';
    }, text);
    if (!selector) return false;
    try {
      await this.click(selector, { timeout, via });
    } finally {
      await this.evaluate("document.querySelector('[data-cdp-target]')?.removeAttribute('data-cdp-target')").catch(() => {});
    }
    return true;
  }

  // 走真实键盘事件（有 keydown/keyup），比 insertText 更像人手，能触发键盘相关组件
  type(text, { delay = 40 } = {}) { return core.typeText(this.conn, this.targetRef, text, { delay }); }
  insertText(text) { return core.insertText(this.conn, this.targetRef, text); }

  async fill(selector, text, { clear = true, delay = 30 } = {}) {
    await this.click(selector);
    if (clear) await this.evaluate(s => {
      const el = document.querySelector(s);
      if (el && 'value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
      else if (el) el.textContent = '';
    }, selector);
    await this.type(text, { delay });
  }

  // 注意：绝不主动调用。保留它只是为了兼容旧脚本，文档里明确标注「不要用」。
  bringToFront() {
    console.warn('[cdp] bringToFront 被调用 —— 这会打断用户，本技能的设计目标是永不抢前台');
    return Promise.resolve();
  }

  // ---- 滚动（Node 侧驱动） ----
  scrollTo(y) { return core.scrollTo(this.conn, this.targetRef, y); }
  wheel(deltaY) { return core.mouseWheel(this.conn, this.targetRef, deltaY); }
  scrollInfo() {
    return this.evaluate(() => ({
      y: window.scrollY, h: document.body.scrollHeight, vh: window.innerHeight,
    }));
  }

  // ---- 截图 ----
  async screenshot({ path, fullPage = false } = {}) {
    return core.screenshot(this.conn, this.targetRef, path, { fullPage });
  }

  async setInputFiles(selector, files) {
    return core.setFileInputFiles(this.conn, this.targetRef, selector, files);
  }

  async detectHumanNeeded() { return this.humanNeeded(); }
}

// ---------------------------------------------------------------------------
// 业务策略 helper —— 这些是「对方没有」的部分
// ---------------------------------------------------------------------------

// 用「数字比较法」确保开关处于开启态。
// className（active/on）在 SPA 上不可靠，甚至有「没有 class 才是开」的反例；
// 但计数数字是可观测的：点击后数字变小 → 说明本来已开、被点成了关闭 → 补点一次。
export async function ensureOn(page, selector, name = selector) {
  const readNum = () => page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (!el) return -1;
    const m = (el.innerText || '').match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  }, selector);

  const n1 = await readNum();
  if (n1 < 0) { console.log(`  ⚠ ${name}: 元素不存在，跳过`); return false; }
  console.log(`  ${name} 点击前: ${n1}`);

  await page.click(selector).catch(() => {});
  await sleep(1200);
  const n2 = await readNum();
  console.log(`  ${name} 点击后: ${n2}`);

  if (n2 > n1) { console.log(`  ✓ ${name} 已置为开启 (${n1} → ${n2})`); return true; }
  if (n2 === n1) { console.log(`  ⚠ ${name} 计数未变化，无法判定开关状态`); return false; }

  // 数字下降 = 它本来就是开启态，被这一下点成了关闭 → 补点恢复
  console.log(`  ⚠ ${name} 已开启被取消，补点恢复…`);
  await page.click(selector).catch(() => {});
  await sleep(1200);
  const n3 = await readNum();
  console.log(`  ${name} 补点后: ${n3}`);
  if (n3 > n2) { console.log(`  ✓ ${name} 已恢复为开启 (${n2} → ${n3})`); return true; }
  console.log(`  ✗ ${name} 未能恢复为开启`);
  return false;
}

const DISMISS_LABELS = ['不再提示', '取消', '关闭', '知道了', '确定', '好的', '稍后再说', '稍后', 'Close'];
const MODAL_SELECTORS = [
  '[role="dialog"][data-state="open"]',
  'div[data-state="open"][class*="z-50"]',
  '[role="dialog"]',
  '[class*="modal"]',
];

// 关掉拦截点击的弹窗/遮罩（radix-ui 一类会把提交按钮盖住，点击被吞掉）
export async function dismissModals(page, { rounds = 4 } = {}) {
  for (let i = 0; i < rounds; i++) {
    const closed = await page.evaluate(({ labels, selectors }) => {
      for (const sel of selectors) {
        const dlg = document.querySelector(sel);
        if (!dlg || dlg.offsetParent === null) continue;
        for (const b of Array.from(dlg.querySelectorAll('button, [role="button"]'))) {
          const t = (b.innerText || '').trim();
          if (labels.some(l => t === l || t.includes(l))) {
            b.click();
            return t;
          }
        }
      }
      return null;
    }, { labels: DISMISS_LABELS, selectors: MODAL_SELECTORS });
    if (!closed) break;
    console.log(`  关闭弹窗: ${closed}`);
    await sleep(700);
  }
}

// 上传文件并**轮询**到出现真实预览。
// setInputFiles 是同步返回的，但平台侧上传是异步的：过早点提交会因为按钮仍 disabled
// 而静默失败——这是最容易踩的坑。
export async function uploadAndVerify(page, filePath, { selector = 'input[type="file"][accept*="image"]', timeout = 18000 } = {}) {
  const found = await page.waitForSelector(selector, { timeout: 5000 });
  if (!found) {
    // 退一步：任何文件输入框
    const any = await page.count('input[type="file"]');
    if (!any) { console.log('  ⚠ 未找到文件输入框'); return false; }
    selector = 'input[type="file"]';
  }
  await page.setInputFiles(selector, [filePath]);
  console.log('  已设置文件，轮询上传预览…');
  const rounds = Math.ceil(timeout / 1500);
  for (let i = 0; i < rounds; i++) {
    await sleep(1500);
    const st = await page.evaluate(sel => {
      const input = document.querySelector(sel);
      const previewImgs = Array.from(document.querySelectorAll('img'))
        .filter(im => /^(blob:|data:image)/.test(im.src || ''));
      const txt = document.body.innerText || '';
      return {
        files: input ? input.files.length : -1,
        preview: previewImgs.length,
        uploading: /上传中|uploading/i.test(txt),
        done: /重新上传|已上传|上传成功/.test(txt),
      };
    }, selector);
    console.log(`   [${i}] files=${st.files} preview=${st.preview} uploading=${st.uploading} done=${st.done}`);
    if (st.preview > 0 || st.done) return true;
  }
  return false;
}

// 整页滚动触发懒加载，必要时把 anchorText 滚入视口。
// 由 Node 侧驱动（后台标签里页面内的 setInterval 会被节流到 ~1Hz，不能用）。
export async function scrollFull(page, anchorText, { step = 450, maxRounds = 80 } = {}) {
  let { h } = await page.scrollInfo();
  let y = 0;
  let rounds = 0;
  while (y < h && rounds < maxRounds) {
    y += step + step * (Math.random() - 0.4); // 变速，避免机械的等距滚动
    await page.scrollTo(Math.min(y, h));
    await sleep(120 + Math.random() * 180);
    rounds++;
    const info = await page.scrollInfo();
    h = Math.max(h, info.h); // 懒加载会让文档变高
  }
  if (anchorText) {
    const found = await page.evaluate(t => {
      const els = Array.from(document.querySelectorAll('*'))
        .filter(e => e.childElementCount === 0 && (e.textContent || '').trim() === t);
      if (!els[0]) return false;
      els[0].scrollIntoView({ block: 'center' });
      return true;
    }, anchorText);
    if (!found) console.log(`  ⚠ 未找到锚点文本: ${anchorText}`);
    await sleep(600);
  }
  return { rounds, height: h };
}

// 截图并报告体积与尺寸（整页默认开启）
export async function shot(page, filePath, { fullPage = true } = {}) {
  const buf = await page.screenshot({ path: filePath, fullPage });
  const w = buf.length > 24 ? buf.readUInt32BE(16) : 0;
  const h = buf.length > 24 ? buf.readUInt32BE(20) : 0;
  console.log(`截图: ${filePath} (${(buf.length / 1024).toFixed(0)} KB, ${w}x${h})`);
  return filePath;
}

// 按可见文本点击，失败回退到 DOM 点击（绕过遮罩拦截真实指针）
export async function clickByText(page, text, { timeout = 8000 } = {}) {
  try {
    const ok = await page.clickText(text, { timeout });
    if (ok) return true;
  } catch (e) {
    console.log(`  真实点击 "${text}" 失败: ${e.message}`);
  }
  console.log(`  回退 DOM 点击 "${text}"`);
  return page.evaluate(t => {
    const els = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    const el = els.find(x => (x.innerText || '').includes(t));
    if (!el) return false;
    el.click();
    return true;
  }, text);
}

// ---------------------------------------------------------------------------
// 人机交接 —— 双方都缺的能力
// ---------------------------------------------------------------------------

export const HANDOFF_HINT =
  '需要你手动操作：请在这个 Chrome 标签里完成（登录 / 验证码 / 扫码 / 支付确认等），' +
  '完成后告诉我，我会继续。（agent 不会代填任何凭据）';

/**
 * 把控制权交给人，只观察、不动作。
 *
 * 硬约束（实现上必须保证）：
 *   · 轮询期间只做 evaluate 读取，绝不 click / 绝不导航 / 绝不 bringToFront
 *   · 不读取密码字段的值
 *   · 超时返回 ok:false，让上层明确中止，而不是带病往下跑
 *
 * @param {Page} page
 * @param {object} opts
 * @param {Function} [opts.signal]   返回 true 表示人已完成；缺省用「登录墙消失」判定
 * @param {number}  [opts.timeoutMs] 默认 15 分钟（去翻手机拿验证码很容易超过 1 分钟）
 * @param {number}  [opts.pollMs]
 * @param {Function} [opts.onWait]   每次轮询回调，用于输出进度
 */
export async function waitForHuman(page, {
  signal,
  timeoutMs = 15 * 60 * 1000,
  pollMs = 2000,
  onWait,
} = {}) {
  const check = signal || (async () => {
    const s = await page.detectHumanNeeded();
    return !s.loginWall && !s.captcha && !s.twoFactor;
  });
  const started = Date.now();
  let ticks = 0;
  console.log('  ⏸ ' + HANDOFF_HINT);
  while (Date.now() - started < timeoutMs) {
    let done = false;
    try { done = await check(); } catch { done = false; }
    if (done) {
      const waitedMs = Date.now() - started;
      console.log(`  ▶ 检测到人工操作已完成（等待 ${(waitedMs / 1000).toFixed(0)}s），继续`);
      return { ok: true, waitedMs };
    }
    ticks++;
    if (onWait) await onWait(ticks).catch(() => {});
    await sleep(pollMs);
  }
  return { ok: false, reason: 'timeout', waitedMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// 反检测行为 —— 全部 Node 侧驱动（页面内定时器/动画帧在后台是死的）
// ---------------------------------------------------------------------------

// 贝塞尔鼠标轨迹：从随机起点经控制点减速接近目标，最后做一次微调
export async function humanClickAt(page, x, y) {
  const sx = page._mx ?? x - 120 - Math.random() * 200;
  const sy = page._my ?? y - 80 - Math.random() * 120;
  const cx = sx + (x - sx) * (0.3 + Math.random() * 0.4) + (Math.random() - 0.5) * 60;
  const cy = sy + (y - sy) * (0.3 + Math.random() * 0.4) + (Math.random() - 0.5) * 60;
  const steps = 14 + Math.floor(Math.random() * 10);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t * t * (3 - 2 * t); // smoothstep，模拟减速
    const px = (1 - e) * (1 - e) * sx + 2 * (1 - e) * e * cx + e * e * x;
    const py = (1 - e) * (1 - e) * sy + 2 * (1 - e) * e * cy + e * e * y;
    await page.conn.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: px + (Math.random() - 0.5) * 2,
      y: py + (Math.random() - 0.5) * 2,
    }, page.targetRef);
    await sleep(8 + Math.random() * 22);
  }
  await sleep(60 + Math.random() * 140);        // 落点前的迟疑
  await core.clickAt(page.conn, page.targetRef, x, y);
  page._mx = x;
  page._my = y;
}

export const humanClick = (page, selector) => page.click(selector, { human: true });

// 变速滚动 + 随机停顿 + 偶尔回滚
export async function humanScroll(page, { rounds = 6, minStep = 200, maxStep = 700 } = {}) {
  for (let i = 0; i < rounds; i++) {
    const dy = minStep + Math.random() * (maxStep - minStep);
    await page.wheel(dy);
    await sleep(300 + Math.random() * 900);
    if (Math.random() < 0.2) {
      await page.wheel(-(60 + Math.random() * 160));
      await sleep(200 + Math.random() * 400);
    }
  }
}

// 先像人一样浏览内容，再做互动
export async function preRead(page, { rounds = 5 } = {}) {
  const { vh } = await page.scrollInfo();
  for (let i = 0; i < rounds; i++) {
    await page.wheel(vh * (0.4 + Math.random() * 0.5));
    await sleep(800 + Math.random() * 2200);
  }
  if (Math.random() < 0.4) {
    await page.scrollTo(0);
    await sleep(400 + Math.random() * 600);
  }
}

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
