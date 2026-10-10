// browser.mjs — the policy layer (the core asset of this skill)
//
// The two layers above (cdp-core / cdp-daemon) answer "how do we connect, how do we issue commands";
// this layer answers "how do we confirm the command actually worked, without disturbing the user".
//
// Two principles run through all of it:
//   1. Never steal the foreground — everything goes through CDP/Input or evaluate in a background tab,
//      and bringToFront is never called, so the agent cannot yank a tab away mid-typing.
//   2. Drive from Node — a background tab throttles setInterval to ~1 Hz and stops
//      requestAnimationFrame entirely (measured), so scrolling, waiting and polling are Node loops
//      rather than timers living inside the page.
//
// Usage:
//   import { connectCDP, ensureOn, scrollFull, shot, uploadAndVerify, waitForHuman }
//     from './files/browser.mjs';
//   const { page, findPage, newPage } = await connectCDP();
//   const app = findPage('example.com') || await newPage('https://example.com');

import * as core from './cdp-core.mjs';
import { connectDaemon } from './cdp-daemon.mjs';

export { sleep, randWait } from './cdp-core.mjs';
const { sleep } = core;

// Adapt the daemon client to the connection interface cdp-core expects: send(method, params, ref)
function asConn(client) {
  return {
    send: (method, params = {}, targetRef) => client.call(method, params, targetRef),
    raw: client,
  };
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export async function connectCDP({ verbose = false } = {}) {
  const client = await connectDaemon({ verbose });
  const conn = asConn(client);

  const listTargets = () => client.targets();
  const find = (substr) => listTargets().then(ts => ts.find(t => t.url.includes(substr)) || null);
  const newPage = async (url) => {
    // background:true — the key bit: a new tab does not push the page the user is reading behind
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

  // ---- read ----
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

  // ---- navigation ----
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

  // Node-side polling until the element appears (no in-page timers)
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

  // ---- actions ----
  async click(selector, { timeout = 8000, via = 'input', human = false } = {}) {
    if (!(await this.waitForSelector(selector, { timeout }))) {
      throw new Error('Click failed, element not found: ' + selector);
    }
    if (via === 'dom') {
      // DOM-level click: faster, and bypasses overlays that would intercept real pointer events
      await this.evaluate(s => document.querySelector(s).click(), selector);
      return true;
    }
    const c = await core.elementCenter(this.conn, this.targetRef, selector);
    if (!c) throw new Error('Click failed, element has no layout box: ' + selector);
    try {
      if (human) await humanClickAt(this, c.x, c.y);
      else await core.clickAt(this.conn, this.targetRef, c.x, c.y);
      return true;
    } catch (e) {
      // Input acks stall indefinitely on an unactivated background tab, so fall back to a DOM click
      console.log(`  ⚠ real click failed (${e.message}); falling back to a DOM click: ${selector}`);
      await this.evaluate(s => document.querySelector(s).click(), selector);
      return true;
    }
  }

  // Find an element by its visible text and click it.
  // Priority: exact text > interactive tag > deeper DOM node (more specific).
  // innerText.includes alone matches the wrapping div first when a button sits inside one,
  // so the click lands on empty space and nothing happens.
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

  // Real key events (with keydown/keyup): closer to a human, and they trigger keyboard-driven components
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

  // Never call this. It exists only for old scripts, and the docs say not to use it.
  bringToFront() {
    console.warn('[cdp] bringToFront called — this interrupts the user; never stealing focus is the whole point');
    return Promise.resolve();
  }

  // ---- scrolling (Node-driven) ----
  scrollTo(y) { return core.scrollTo(this.conn, this.targetRef, y); }
  wheel(deltaY) { return core.mouseWheel(this.conn, this.targetRef, deltaY); }
  scrollInfo() {
    return this.evaluate(() => ({
      y: window.scrollY, h: document.body.scrollHeight, vh: window.innerHeight,
    }));
  }

  // ---- screenshots ----
  async screenshot({ path, fullPage = false } = {}) {
    return core.screenshot(this.conn, this.targetRef, path, { fullPage });
  }

  async setInputFiles(selector, files) {
    return core.setFileInputFiles(this.conn, this.targetRef, selector, files);
  }

  async detectHumanNeeded() { return this.humanNeeded(); }
}

// ---------------------------------------------------------------------------
// Task-level policy helpers — the part most tools do not have
// ---------------------------------------------------------------------------

// Make sure a toggle ends up ON, using numeric comparison.
// className (active/on) is unreliable in SPAs — sometimes the ABSENCE of a class means "on";
// but the count is observable: if a click makes it DROP, it was already on and we just turned it off.
export async function ensureOn(page, selector, name = selector) {
  const readNum = () => page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (!el) return -1;
    const m = (el.innerText || '').match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  }, selector);

  const n1 = await readNum();
  if (n1 < 0) { console.log(`  ⚠ ${name}: element not found, skipping`); return false; }
  console.log(`  ${name} before click: ${n1}`);

  await page.click(selector).catch(() => {});
  await sleep(1200);
  const n2 = await readNum();
  console.log(`  ${name} after click: ${n2}`);

  if (n2 > n1) { console.log(`  ✓ ${name} is now on (${n1} → ${n2})`); return true; }
  if (n2 === n1) { console.log(`  ⚠ ${name} count unchanged — cannot determine toggle state`); return false; }

  // A drop means it was already on and this click turned it off → click again to restore
  console.log(`  ⚠ ${name} was on and got toggled off; clicking again…`);
  await page.click(selector).catch(() => {});
  await sleep(1200);
  const n3 = await readNum();
  console.log(`  ${name} after corrective click: ${n3}`);
  if (n3 > n2) { console.log(`  ✓ ${name} restored to on (${n2} → ${n3})`); return true; }
  console.log(`  ✗ ${name} could not be restored to on`);
  return false;
}

// Safe dismiss labels. The Chinese entries match Chinese UIs, the English ones cover English UIs.
// These are data to match against, not prose — do not translate them away.
const DISMISS_LABELS = [
  '不再提示', '取消', '关闭', '知道了', '确定', '好的', '稍后再说', '稍后',
  'Close', 'Dismiss', 'Cancel', 'Not now', 'Later', 'Got it', 'OK', 'I understand', 'No thanks',
];
const MODAL_SELECTORS = [
  '[role="dialog"][data-state="open"]',
  'div[data-state="open"][class*="z-50"]',
  '[role="dialog"]',
  '[class*="modal"]',
];

// Dismiss modals and overlays that swallow clicks (radix-ui style overlays cover the submit button)
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
    console.log(`  dismissed modal: ${closed}`);
    await sleep(700);
  }
}

// Upload a file and **poll** until the app itself confirms it: a served `https://` URL in the
// preview, or an explicit "uploaded / re-upload" label. A `blob:` / `data:` preview is NOT that —
// it only proves the page read the file locally.
// setInputFiles returns synchronously but the platform-side upload is async: submitting too early
// fails silently while the button is still disabled — the most common trap there is.
export async function uploadAndVerify(page, filePath, { selector = 'input[type="file"][accept*="image"]', timeout = 18000 } = {}) {
  const found = await page.waitForSelector(selector, { timeout: 5000 });
  if (!found) {
    // Fall back to any file input
    const any = await page.count('input[type="file"]');
    if (!any) { console.log('  ⚠ no file input found'); return false; }
    selector = 'input[type="file"]';
  }
  // Snapshot the images that already exist BEFORE setting the input: only a newly appearing one
  // counts, and the snapshot has to come first. `change` fires in the same turn as
  // DOM.setFileInputFiles, so a snapshot taken afterwards already contains the new preview —
  // every preview then looks pre-existing and the poll can never succeed.
  const known = await page.evaluate(() => Array.from(document.querySelectorAll('img')).map(im => im.src || ''));

  await page.setInputFiles(selector, [filePath]);

  console.log('  file set; polling for a SERVER-SIDE artifact (a blob: preview alone proves nothing)…');
  const rounds = Math.ceil(timeout / 1500);
  let localOnly = false;
  for (let i = 0; i < rounds; i++) {
    await sleep(1500);
    const st = await page.evaluate(({ sel, seen }) => {
      const input = document.querySelector(sel);
      const srcs = Array.from(document.querySelectorAll('img')).map(im => im.src || '');
      const freshLocal = srcs.filter(s => /^(blob:|data:image)/.test(s) && !seen.includes(s));
      const freshRemote = srcs.filter(s => /^https?:/i.test(s) && !seen.includes(s));
      const txt = document.body.innerText || '';
      return {
        files: input ? input.files.length : -1,
        freshLocal: freshLocal.length,
        freshRemote: freshRemote.length,
        // Chinese patterns match Chinese UIs; keep both.
        uploading: /上传中|uploading/i.test(txt),
        done: /重新上传|已上传|上传成功/.test(txt),
      };
    }, { sel: selector, seen: known });
    console.log(`   [${i}] files=${st.files} localPreview=${st.freshLocal} serverPreview=${st.freshRemote} uploading=${st.uploading} done=${st.done}`);
    // Success = the APP confirms it: a served URL appeared, or it says "uploaded".
    if (st.freshRemote > 0 || st.done) return true;
    if (st.freshLocal > 0) localOnly = true;
  }
  if (localOnly) {
    console.log('  ⚠ only a local blob:/data: preview appeared — the page READ the file, the app never took it.');
    console.log('     Treat this as NOT uploaded. If the form still reports the field as missing, stop retrying and');
    console.log('     hand over the exact file path (the upload pipeline rejects automation; that is a real handoff).');
  }
  return false;
}

// Scroll the whole page to trigger lazy loading, bringing anchorText into view when given.
// Node-driven: an in-page setInterval would be throttled to ~1 Hz in a background tab.
export async function scrollFull(page, anchorText, { step = 450, maxRounds = 80 } = {}) {
  let { h } = await page.scrollInfo();
  let y = 0;
  let rounds = 0;
  while (y < h && rounds < maxRounds) {
    y += step + step * (Math.random() - 0.4); // vary the step so it is not mechanically even
    await page.scrollTo(Math.min(y, h));
    await sleep(120 + Math.random() * 180);
    rounds++;
    const info = await page.scrollInfo();
    h = Math.max(h, info.h); // lazy loading makes the document taller
  }
  if (anchorText) {
    const found = await page.evaluate(t => {
      const els = Array.from(document.querySelectorAll('*'))
        .filter(e => e.childElementCount === 0 && (e.textContent || '').trim() === t);
      if (!els[0]) return false;
      els[0].scrollIntoView({ block: 'center' });
      return true;
    }, anchorText);
    if (!found) console.log(`  ⚠ anchor text not found: ${anchorText}`);
    await sleep(600);
  }
  return { rounds, height: h };
}

// Screenshot, then report size and dimensions (full page by default)
export async function shot(page, filePath, { fullPage = true } = {}) {
  const buf = await page.screenshot({ path: filePath, fullPage });
  const w = buf.length > 24 ? buf.readUInt32BE(16) : 0;
  const h = buf.length > 24 ? buf.readUInt32BE(20) : 0;
  console.log(`screenshot: ${filePath} (${(buf.length / 1024).toFixed(0)} KB, ${w}x${h})`);
  return filePath;
}

// Click by visible text, falling back to a DOM click (bypasses overlays intercepting pointers)
export async function clickByText(page, text, { timeout = 8000 } = {}) {
  try {
    const ok = await page.clickText(text, { timeout });
    if (ok) return true;
  } catch (e) {
    console.log(`  real click on "${text}" failed: ${e.message}`);
  }
  console.log(`  falling back to a DOM click on "${text}"`);
  return page.evaluate(t => {
    const els = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    const el = els.find(x => (x.innerText || '').includes(t));
    if (!el) return false;
    el.click();
    return true;
  }, text);
}

// ---------------------------------------------------------------------------
// Human handoff — the capability almost nobody else has
// ---------------------------------------------------------------------------

export const HANDOFF_HINT =
  'Manual step needed: finish it in this Chrome tab (login / verification code / QR scan / ' +
  'payment confirmation), then tell me and I will continue. The agent will not fill in credentials.';

/**
 * Hand control to the human and only observe.
 *
 * Hard constraints that the implementation must keep:
 *   · while polling, only read via evaluate — never click, never navigate, never steal focus
 *   · never read the value of a password field
 *   · return ok:false on timeout so the caller stops loudly instead of continuing broken
 *
 * @param {Page} page
 * @param {object} opts
 * @param {Function} [opts.signal]   returns true when the human is done; defaults to "login wall gone"
 * @param {number}  [opts.timeoutMs] 15 minutes by default (fetching a code from a phone easily exceeds one)
 * @param {number}  [opts.pollMs]
 * @param {Function} [opts.onWait]   called on each poll, for progress output
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
      console.log(`  ▶ human step finished (waited ${(waitedMs / 1000).toFixed(0)}s), resuming`);
      return { ok: true, waitedMs };
    }
    ticks++;
    if (onWait) await onWait(ticks).catch(() => {});
    await sleep(pollMs);
  }
  return { ok: false, reason: 'timeout', waitedMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Anti-detection behaviour — all Node-driven (in-page timers and rAF are dead in background tabs)
// ---------------------------------------------------------------------------

// Bezier pointer path: random start, decelerating approach via a control point, then a micro-adjustment
export async function humanClickAt(page, x, y) {
  const sx = page._mx ?? x - 120 - Math.random() * 200;
  const sy = page._my ?? y - 80 - Math.random() * 120;
  const cx = sx + (x - sx) * (0.3 + Math.random() * 0.4) + (Math.random() - 0.5) * 60;
  const cy = sy + (y - sy) * (0.3 + Math.random() * 0.4) + (Math.random() - 0.5) * 60;
  const steps = 14 + Math.floor(Math.random() * 10);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t * t * (3 - 2 * t); // smoothstep, simulating deceleration
    const px = (1 - e) * (1 - e) * sx + 2 * (1 - e) * e * cx + e * e * x;
    const py = (1 - e) * (1 - e) * sy + 2 * (1 - e) * e * cy + e * e * y;
    await page.conn.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: px + (Math.random() - 0.5) * 2,
      y: py + (Math.random() - 0.5) * 2,
    }, page.targetRef);
    await sleep(8 + Math.random() * 22);
  }
  await sleep(60 + Math.random() * 140);        // hesitation before the press
  await core.clickAt(page.conn, page.targetRef, x, y);
  page._mx = x;
  page._my = y;
}

export const humanClick = (page, selector) => page.click(selector, { human: true });

// Variable-speed scrolling with random pauses and occasional back-scrolls
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

// Skim the content the way a human would before interacting
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
