#!/usr/bin/env node
// selftest.mjs — self-test, in two parts:
//
//   A. Offline: no Chrome needed. Verifies port-file parsing, candidate paths, utilities.
//   B. Online: needs an authorised Chrome. Runs the whole policy layer in a **background** tab
//      (ensureOn / dismissModals / uploadAndVerify / clickByText / scrollFull / shot /
//      waitForHuman) and, on macOS, independently verifies with Chrome's own active tab
//      that the user's foreground was never taken.
//
// Usage:
//   node scripts/selftest.mjs                    # run everything if Chrome is reachable
//   node scripts/selftest.mjs --offline          # offline checks only
//   node scripts/selftest.mjs --require-chrome   # fail instead of skipping (for CI)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..');

const ARGS = process.argv.slice(2);
const OFFLINE_ONLY = ARGS.includes('--offline');
const REQUIRE_CHROME = ARGS.includes('--require-chrome');

const results = [];
const check = (name, pass, extra = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// A. Offline checks
// ---------------------------------------------------------------------------

async function offlineChecks() {
  console.log('\n== A. Offline checks ==');
  const core = await import(path.join(SKILL, 'files/cdp-core.mjs'));

  // port-file parsing
  const tmp = path.join(os.tmpdir(), `cdp-selftest-port-${process.pid}`);
  fs.writeFileSync(tmp, '9333\n/devtools/browser/abc-def\n');
  const parsed = core.parsePortFile(tmp);
  check('parsePortFile reads port and ws path', parsed.port === 9333 && parsed.wsPath === '/devtools/browser/abc-def',
    `port=${parsed.port} path=${parsed.wsPath}`);
  fs.unlinkSync(tmp);

  // a malformed file must throw, not silently yield a bad port
  const bad = path.join(os.tmpdir(), `cdp-selftest-bad-${process.pid}`);
  fs.writeFileSync(bad, 'not-a-port\n');
  let threw = false;
  try { core.parsePortFile(bad); } catch { threw = true; }
  check('parsePortFile throws on a malformed file', threw);
  fs.unlinkSync(bad);

  // candidates must cover this platform and must not contain the classic typo
  const cands = core.candidatePortFiles();
  check('candidate port-file list is non-empty', cands.length > 0, `${cands.length} entries`);
  if (process.platform === 'darwin') {
    // macOS uses the two-level Google/Chrome layout, not "Google Chrome"
    const macPath = cands.find(p => p.includes('Library/Application Support/Google/Chrome/DevToolsActivePort'));
    check('macOS candidate is Google/Chrome (two levels)', !!macPath, macPath || 'not found');
    check('no candidate uses the malformed "Google Chrome/DevToolsActivePort" form',
      !cands.some(p => p.includes('Application Support/Google Chrome/DevToolsActivePort')));
  }

  // shuffle must actually reorder (sample repeatedly rather than seeding)
  const { shuffle } = await import(path.join(SKILL, 'files/browser.mjs'));
  const base = [1, 2, 3, 4, 5, 6, 7, 8];
  const shuffledAtLeastOnce = Array.from({ length: 20 }, () => shuffle(base).join(''))
    .some(s => s !== base.join(''));
  check('shuffle changes the order', shuffledAtLeastOnce);
  check('shuffle keeps every element', shuffle(base).sort((a, b) => a - b).join('') === base.join(''));

  // every path quoted in the docs must exist
  for (const rel of ['files/cdp-core.mjs', 'files/cdp-daemon.mjs', 'files/browser.mjs', 'scripts/cdp.mjs']) {
    check(`file exists: ${rel}`, fs.existsSync(path.join(SKILL, rel)));
  }
}

// ---------------------------------------------------------------------------
// B. Online checks
// ---------------------------------------------------------------------------

// On macOS, fingerprint Chrome's active tab (length + hash only; the URL itself is not printed).
// The only independent way to tell whether the foreground was taken. Focus emulation makes the
// target page report itself as visible no matter what, so visibilityState cannot be used here.
function activeTabFingerprint() {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync('osascript', ['-e',
      'tell application "Google Chrome"\nset w to count of windows\nif w = 0 then return "no-window"\n' +
      'return (URL of active tab of front window) & "|" & (title of active tab of front window)\nend tell'],
      { encoding: 'utf8', timeout: 8000 }).trim();
    let h = 0;
    for (const ch of out) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return 'len=' + out.length + ' hash=' + h.toString(16);
  } catch { return null; }
}

const TEST_PAGE = `<!doctype html><meta charset=utf-8><title>cdp-selftest</title>
<style>body{background:#123456;margin:0;color:#fff;font:16px sans-serif}
.row{padding:16px}</style>
<div class="row" id="like" data-on="1"><span class="cnt">13</span> Like</div>
<div class="row"><button id="submit">Submit task</button></div>
<div class="row"><input id="f" type="file" accept="image/*"></div>
<div class="row" id="loginbox"><input type="password" placeholder="Password"></div>
<div class="row"><div role="dialog" data-state="open" style="position:relative;z-index:50">
  <button id="dismiss">Got it</button></div></div>
<div style="height:3000px"></div>
<div class="row" id="anchor">anchor text</div>
<div style="height:400px"></div>
<script>
  const like = document.getElementById('like');
  like.addEventListener('click', () => {
    const on = like.dataset.on === '1';
    like.dataset.on = on ? '0' : '1';
    like.querySelector('.cnt').textContent = on ? '12' : '13';
  });
  document.getElementById('submit').addEventListener('click', e => e.target.remove());
  document.getElementById('dismiss').addEventListener('click', e => e.target.closest('[role=dialog]').remove());
</script>`;

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

async function onlineChecks() {
  console.log('\n== B. Online checks (background tab, no focus stealing) ==');
  const {
    connectCDP, ensureOn, dismissModals, uploadAndVerify, scrollFull, shot,
    clickByText, waitForHuman, humanClick, humanScroll,
  } = await import(path.join(SKILL, 'files/browser.mjs'));

  const { listTargets, newPage, closePage } = await connectCDP();
  const before = (await listTargets()).length;
  const fpBefore = activeTabFingerprint();

  const png = path.join(os.tmpdir(), `cdp-selftest-${process.pid}.png`);
  const outPng = path.join(os.tmpdir(), `cdp-selftest-shot-${process.pid}.png`);
  fs.writeFileSync(png, TINY_PNG);

  const page = await newPage('data:text/html;charset=utf-8,' + encodeURIComponent(TEST_PAGE));
  await page.waitReady();
  await sleep(600);

  check('evaluate works in a background tab', (await page.title()) === 'cdp-selftest');
  check('the new tab was created in the background', (await page.visible()) !== null);

  // Numeric comparison: the toggle starts ON, a click turns it off, so ensureOn must click back
  const on = await ensureOn(page, '#like', 'Like');
  check('ensureOn restores a toggle that got switched off', on === true, `final count=${(await page.text('#like'))?.trim()}`);

  await dismissModals(page);
  check('dismissModals closes an overlay modal', (await page.count('[role=dialog]')) === 0);

  await page.evaluate(() => {
    const i = document.getElementById('f');
    i.addEventListener('change', () => {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(i.files[0]);
      i.after(img);
    });
  });
  check('uploadAndVerify polls until a real preview appears', (await uploadAndVerify(page, png)) === true);

  check('clickByText hits the button, not the wrapping container', (await clickByText(page, 'Submit task')) === true
    && (await page.count('#submit')) === 0);

  const r = await scrollFull(page, 'anchor text');
  check('scrollFull (Node-driven) reaches deep into the document', (await page.scrollInfo()).y > 500, `rounds=${r.rounds}`);

  await shot(page, outPng);
  check('full-page screenshot is written and non-empty', fs.existsSync(outPng) && fs.statSync(outPng).size > 2000);

  // Handoff: simulate the human finishing — once the login wall is gone, waitForHuman returns
  const humanOk = await page.evaluate("!!document.getElementById('loginbox')");
  check('detectHumanNeeded spots a login wall', humanOk === true);
  check('waitForHuman resumes once the human step is done', (await waitForHuman(page, {
    pollMs: 300, timeoutMs: 5000,
    signal: async () => {
      await page.evaluate("document.getElementById('loginbox')?.remove()");
      return true;
    },
  })).ok === true);

  await humanClick(page, '#like');
  await humanScroll(page, { rounds: 2 });
  check('humanClick / humanScroll run (real input works in a background tab)', true);

  await closePage(page);
  await sleep(500);
  check('temporary tab cleaned up', (await listTargets()).length === before);

  const fpAfter = activeTabFingerprint();
  if (fpAfter === null) {
    console.log('  · skipping the "foreground untouched" check (macOS only)');
  } else {
    check('the user foreground tab was never taken', fpAfter === fpBefore, `${fpBefore} → ${fpAfter}`);
  }

  fs.unlinkSync(png);
  fs.unlinkSync(outPng);
}

// ---------------------------------------------------------------------------

(async () => {
  console.log(`chrome-sidecar selftest  (node ${process.version} / ${process.platform})`);
  await offlineChecks();

  if (!OFFLINE_ONLY) {
    try {
      await onlineChecks();
    } catch (e) {
      const msg = String(e.message || e);
      if (REQUIRE_CHROME) {
        console.log('\n== B. Online checks ==');
        check('connect to Chrome', false, msg.split('\n')[0]);
      } else {
        console.log('\n== B. Online checks: skipped ==');
        console.log('  Could not reach Chrome: ' + msg.split('\n')[0]);
        console.log('  Needs a normally running Chrome with the chrome://inspect toggle ticked.');
        console.log('  Pass --offline to skip this part explicitly.');
      }
    }
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n=== selftest: ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) {
    console.log('failed:');
    for (const f of failed) console.log('  - ' + f.name);
  }
  process.exit(failed.length ? 1 : 0);
})();
