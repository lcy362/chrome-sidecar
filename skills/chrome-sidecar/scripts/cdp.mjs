#!/usr/bin/env node
// cdp.mjs — command-line front-end. Any agent that can run a shell can drive this skill
// without writing a Node script; for complex flows use the policy layer in files/browser.mjs.
//
//   cdp.mjs list                 list operable tabs (with target ids)
//   cdp.mjs info                 daemon / browser status
//   cdp.mjs snap    <t>          accessibility-tree snapshot (token-cheap page structure)
//   cdp.mjs eval    <t> <expr>   evaluate JS in the page
//   cdp.mjs html    <t> [sel]    full page or element HTML
//   cdp.mjs shot    <t> [file]   screenshot (full page by default; --viewport for viewport only)
//   cdp.mjs nav     <t> <url>    navigate and wait for load
//   cdp.mjs net     <t>          resource timing
//   cdp.mjs click   <t> <sel>    real click by CSS selector
//   cdp.mjs clickxy <t> <x> <y>  real click at CSS pixel coordinates
//   cdp.mjs type    <t> <text>   real key input (with keydown/keyup)
//   cdp.mjs keys    <t> <key>    press one special key (Enter/Escape/Tab…)
//   cdp.mjs open    [url]        new **background** tab (never steals focus)
//   cdp.mjs close   <t>          close a tab
//   cdp.mjs human   <t>          hand over to the human, return when they are done
//   cdp.mjs demo    [file.png]   verify this install; opens the project page and clicks nothing
//   cdp.mjs raw     <t> <method> [json]   raw CDP command passthrough
//   cdp.mjs daemon  [status|stop|start]
//
// <t> is a **unique prefix** of a target id printed by `cdp.mjs list`.

import fs from 'node:fs';
import { connectCDP, waitForHuman, verifyInstall } from '../files/browser.mjs';
import { connectDaemon, SOCKET_PATH } from '../files/cdp-daemon.mjs';

const [, , cmd, ...args] = process.argv;

const USAGE = `cdp — drive the Chrome you are already using (background work, no focus stealing)

usage: cdp <command> [args]
  list                    list tabs
  info                    daemon / browser status
  snap    <t> [--full]    accessibility-tree snapshot
  eval    <t> <expr>      evaluate JS
  html    <t> [sel]       get HTML
  shot    <t> [file] [--viewport]   full-page (or viewport) screenshot
  nav     <t> <url>
  net     <t>             resource timing
  click   <t> <sel>       real click on a CSS selector
  clickxy <t> <x> <y>     real click at CSS pixel coords
  type    <t> <text>      real key events
  keys    <t> <key>       press one special key (Enter/Escape/Tab…)
  open    [url] [--foreground]   new BACKGROUND tab
  close   <t>             close a tab
  human   <t> [timeoutMs] hand over to the human and wait
  demo    [file.png]      verify this install: opens the project page in a background tab,
                          reads it and screenshots it — and clicks nothing
  raw     <t> <method> [json]    raw CDP passthrough
  daemon  [status|stop|start]

<t> = a unique prefix of a target id from 'cdp list' output
First run: open chrome://inspect/#remote-debugging in Chrome and tick the authorisation box.`;

function resolveTarget(targets, prefix) {
  const p = (prefix || '').toLowerCase();
  if (!p) throw new Error('missing <target> argument (run `cdp list` first)');
  const hits = targets.filter(t => t.targetId.toLowerCase().startsWith(p));
  if (!hits.length) throw new Error(`tab not found: ${prefix} (run \`cdp list\` first)`);
  if (hits.length > 1) {
    const shortest = Math.max(...hits.map(h => {
      let n = 1;
      while (n < h.targetId.length && hits.filter(x => x.targetId.startsWith(h.targetId.slice(0, n))).length > 1) n++;
      return n;
    }));
    throw new Error(`ambiguous prefix: ${prefix} matches ${hits.length} tabs; give at least ${shortest} characters`);
  }
  return hits[0];
}

const fmtTarget = (t, i) => `${String(i).padStart(2)}  ${t.targetId.slice(0, 8)}  ${(t.title || '').slice(0, 50)}`;

// Report whether Chrome's debugging toggle is on, without starting a daemon or opening a
// connection. The DevToolsActivePort file exists exactly when "Allow remote debugging for this
// browser instance" is ticked, so it is the honest answer to "is the user set up?" — and the daemon
// being absent says nothing about it (a daemon only exists once something has connected).
async function reportEndpoint() {
  const { resolvePort } = await import('../files/cdp-core.mjs');
  try {
    const { port, source } = resolvePort();
    console.log(`endpoint source:    ${source} (port ${port})`);
    console.log('  → Chrome\'s debugging toggle is ON; the next command will connect.');
  } catch {
    console.log('endpoint source:    NOT found');
    console.log('  → the toggle is off, or Chrome is not running. Open');
    console.log('    chrome://inspect/#remote-debugging in the Chrome you normally use and tick');
    console.log('    "Allow remote debugging for this browser instance".');
  }
}

async function main() {
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(USAGE); return; }

  if (cmd === 'daemon') {
    const sub = args[0] || 'status';
    if (sub === 'stop') {
      const c = await connectDaemon({ autoStart: false, waitConnected: false });
      await c.stop();
      console.log('daemon stopped');
      return;
    }
    try {
      const wait = sub !== 'status';
      const c = await connectDaemon({ autoStart: wait, waitConnected: wait });
      const info = await c.info();
      console.log(`daemon: running  pid=${info.pid}`);
      // The error may be long; show only the first line here, full text is in daemon.log
      const errLine = info.error ? info.error.split('\n')[0] : null;
      console.log(`Chrome connection: ${info.connected ? 'established ✓' : 'NOT established ✗'}` + (errLine ? ` (${errLine})` : ''));
      console.log(`browser: ${info.browser}`);
      console.log(`endpoint source: ${info.source || '(not found)'}`);
      console.log(`attached tabs: ${info.sessions.length}`);
      console.log(`idle reaping: ${(info.idleTtlMs / 3600000).toFixed(1)} h`);
      console.log(`socket: ${SOCKET_PATH}`);
      if (!info.connected) {
        console.log('\nWhen the connection is missing, check:');
        console.log('  1) Chrome is open normally;');
        console.log('  2) chrome://inspect/#remote-debugging has "Allow remote debugging for this browser instance" ticked;');
        console.log('  3) you clicked Allow on the "Allow debugging?" prompt.');
        process.exitCode = 4;
      }
    } catch (e) {
      console.log('daemon: not running');
      if (sub === 'status') {
        await reportEndpoint();
        console.log('  (use `cdp daemon start`)');
        process.exitCode = 4;
      } else throw e;
    }
    return;
  }

  // The install check manages its own connection (it opens a page), so it runs before the shared
  // connect below. It is the one command a human runs by hand right after installing.
  if (cmd === 'demo') {
    try {
      await verifyInstall({ shotPath: args.find(a => !a.startsWith('--')) });
    } catch (e) {
      // Connection failures already print a full checklist from connectDaemon; do not repeat it.
      console.error('✗ ' + e.message);
      console.log('  (run `cdp daemon status` for the short version of this diagnosis)');
      process.exitCode = 4;
    }
    return;
  }

  const { client, conn, listTargets } = await connectCDP();

  if (cmd === 'list' || cmd === 'ls') {
    const targets = await listTargets();
    console.log(`${targets.length} tabs:`);
    targets.forEach((t, i) => console.log(fmtTarget(t, i)));
    return;
  }
  if (cmd === 'info') {
    const info = await client.info();
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  if (cmd === 'open') {
    const url = args.find(a => !a.startsWith('--')) || 'about:blank';
    const foreground = args.includes('--foreground');
    const { targetId } = await client.newTarget(url, !foreground);
    console.log(`${foreground ? 'foreground' : 'background'} tab: ${targetId.slice(0, 8)}  ${url}`);
    if (!foreground) console.log('(created in the background; your current page is untouched)');
    return;
  }

  const targets = await listTargets();
  const target = resolveTarget(targets, args[0]);
  const tId = target.targetId;
  const rest = args.slice(1);

  switch (cmd) {
    case 'snap': {
      const { snapshot } = await import('../files/cdp-core.mjs');
      console.log(await snapshot(conn, tId, { compact: !rest.includes('--full') }));
      break;
    }
    case 'eval': {
      const expr = rest.join(' ');
      const r = await conn.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, tId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      const v = r.result?.value;
      console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
      break;
    }
    case 'html': {
      const sel = rest[0];
      const r = await conn.send('Runtime.evaluate', {
        expression: sel ? `document.querySelector(${JSON.stringify(sel)})?.outerHTML` : 'document.documentElement.outerHTML',
        returnByValue: true,
      }, tId);
      console.log(r.result?.value ?? '(not found)');
      break;
    }
    case 'shot': {
      const file = rest.find(a => !a.startsWith('--'));
      const fullPage = !rest.includes('--viewport');
      const out = file || `/tmp/cdp-shot-${tId.slice(0, 8)}.png`;
      const r = await conn.send('Page.captureScreenshot',
        fullPage ? { format: 'png', captureBeyondViewport: true } : { format: 'png' }, tId);
      const buf = Buffer.from(r.data, 'base64');
      fs.writeFileSync(out, buf);
      const w = buf.readUInt32BE(16); const h = buf.readUInt32BE(20);
      console.log(`${out}  ${(buf.length / 1024).toFixed(0)} KB  ${w}x${h}${fullPage ? ' (full page)' : ''}`);
      console.log(`CSS px = image px / ${await conn.send('Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true }, tId).then(x => x.result.value)}`);
      break;
    }
    case 'nav': {
      const { navigate } = await import('../files/cdp-core.mjs');
      const r = await navigate(conn, tId, rest[0]);
      console.log(`navigated, readyState=${r.readyState}`);
      break;
    }
    case 'net': {
      const { resourceTiming } = await import('../files/cdp-core.mjs');
      const rows = await resourceTiming(conn, tId);
      rows.sort((a, b) => b.ms - a.ms).slice(0, 30)
        .forEach(r => console.log(`${String(r.ms).padStart(6)}ms  ${String(r.kb).padStart(5)}KB  ${r.type.padEnd(10)} ${r.name}`));
      break;
    }
    case 'click': {
      // Route through the library so both front-ends behave identically:
      // wait for the element, real Input click, DOM fallback if the ack stalls.
      const { Page } = await import('../files/browser.mjs');
      const page = new Page(conn, tId);
      try {
        await page.click(rest[0]);
        console.log(`clicked ${rest[0]}`);
      } catch (e) {
        console.log(`click failed: ${e.message}`);
        process.exitCode = 1;
      }
      break;
    }
    case 'clickxy': {
      const { clickAt } = await import('../files/cdp-core.mjs');
      await clickAt(conn, tId, Number(rest[0]), Number(rest[1]));
      console.log(`clicked at (${rest[0]}, ${rest[1]})`);
      break;
    }
    case 'type': {
      const { typeText, insertText } = await import('../files/cdp-core.mjs');
      const text = rest.join(' ');
      if (rest.includes('--fast')) await insertText(conn, tId, text);
      else await typeText(conn, tId, text);
      console.log(`typed ${text.length} characters`);
      break;
    }
    case 'keys': {
      const key = rest[0] || 'Enter';
      const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38 };
      await conn.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key, code: key, windowsVirtualKeyCode: codes[key] || 0,
      }, tId);
      await conn.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key, code: key, windowsVirtualKeyCode: codes[key] || 0,
      }, tId);
      console.log(`pressed ${key}`);
      break;
    }
    case 'close': {
      await client.closeTarget(tId);
      console.log(`closed ${tId.slice(0, 8)}`);
      break;
    }
    case 'human': {
      const { Page } = await import('../files/browser.mjs');
      const page = new Page(conn, tId);
      const timeoutMs = Number(rest[0] || 15 * 60 * 1000);
      const r = await waitForHuman(page, { timeoutMs });
      console.log(r.ok ? 'human step done; safe to continue' : `timed out after ${(r.waitedMs / 1000).toFixed(0)}s — confirm and retry`);
      if (!r.ok) process.exitCode = 3;
      break;
    }
    case 'raw': {
      const method = rest[0];
      const params = rest[1] ? JSON.parse(rest.slice(1).join(' ')) : {};
      const r = await conn.send(method, params, tId);
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }

  // The CLI is short-lived: every request uses its own socket, so there is nothing to clean up
  // and the daemon must keep running so later commands reuse the authorised long connection.
}

main().catch(e => { console.error('✗ ' + e.message); process.exitCode = 1; });
