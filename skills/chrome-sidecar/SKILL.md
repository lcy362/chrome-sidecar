---
name: chrome-sidecar
version: 1.0.0
description: Drive the Chrome the user is actually using (default profile, already-logged-in session) over the Chrome DevTools Protocol to perform web *actions* — clicking, liking/saving, commenting, filling forms, uploading files, submitting. Operates in background tabs so it never steals the user's focus, uses real mouse and keyboard events, and hands control back to the human whenever credentials, 2FA, CAPTCHA or payment confirmation are involved. Use when a task needs browser interaction (click/fill/upload/submit), when an already-authenticated session avoids a re-login or 2FA wall, or when the user explicitly asks for CDP / their real browser. Do NOT use for plain "read this public page" requests — those should use a normal page fetch or a throwaway Playwright instance.
description_zh: 通过 Chrome DevTools Protocol 驱动用户**正在使用的正常 Chrome**（默认配置目录、已登录会话）完成网页内"操作类"任务：点击、点赞/收藏、评论、填表、上传截图、提交表单；或用户明确要求使用 CDP 时启用。全程在后台标签上操作，不抢前台、不打断用户，遇到登录/验证码/扫码/支付等场景自动把控制权交还给人再继续。零依赖（Node 22+ 内置 WebSocket），不需要复制配置目录、不需要另开调试实例。使用范围：①需要在浏览器中进行操作（点击/填写/上传/提交，或需借助已登录态避免重新登录/2FA）的场景；②用户明确要求使用 CDP 的场景。不包含一般的"访问/浏览公开网页"（仅查看、读取公开页面内容）类场景。
---

# chrome-sidecar

*A Chrome skill for AI agents: operate the user's real Chrome — in background tabs, with real input
events, and with a handoff when a credential is required.*

## What it does

Drives **the Chrome the user is already using**: same window, same profile directory, same
logged-in sessions. It does not copy the profile, does not launch a separate debugging instance,
and does not ask the user to change how they browse.

**Use it when:** ① a task needs browser action (click / fill / upload / submit), or the user's
existing login state avoids a re-login or 2FA wall; ② the user explicitly asks for CDP.
The user does not have to say "CDP" — that is an implementation detail of this scope.

**Do not use it for:** plain "look at / read this public page" requests. Those should use a
normal page fetch or a throwaway Playwright instance — there is no reason to open a debugging
port on someone's real browser to read a public page.

## Three rules that govern everything

1. **Never steal the foreground.** The user may be working in the same Chrome. New tabs are
   always created `background`. All interaction goes through CDP. **Never call `bringToFront`
   or `Target.activateTarget`.** Background tabs can execute JS, click with real input events,
   type, receive file uploads and take full-page screenshots — verified — while the user's
   active tab is untouched.
2. **Drive loops from Node, not from the page.** In-page timers in a background tab are throttled
   to ~1 Hz and `requestAnimationFrame` stops entirely. Scrolling, waiting and polling therefore
   run in Node. The daemon applies `Emulation.setFocusEmulationEnabled` +
   `Page.setWebLifecycleState('active')` on attach to restore full responsiveness — that is what
   lets us keep working in the background *and* keep input events real.
3. **Stop when the human is needed.** On login, CAPTCHA, QR, 2FA or payment confirmation, hand
   over and observe. See the handoff protocol below.

## Prerequisites

- Chrome (or Chromium / Brave / Edge), **running normally**. Once, open
  `chrome://inspect/#remote-debugging` and tick **"Allow remote debugging for this browser
  instance"**.
- Chrome will prompt "Allow debugging?" when a client connects. Click **Allow**. That prompt is
  Chrome's security boundary — **do not use a tool that auto-clicks it**.
- Node.js **22+** (uses the built-in `WebSocket`). **Zero dependencies** — no npm install, no
  Playwright.
- Details and troubleshooting: `references/connect.md`.

## First use — say what is about to happen, then prove it works

The first time this skill runs on a machine, two things are true and the user probably knows
neither. Both belong in the same breath, before you touch their browser:

1. **You are about to operate *their* browser, not a copy of it** — their profile, their tabs, their
   logged-in sessions. Say it plainly, with the reassurance that makes it acceptable: it works in
   background tabs, their active tab never moves, no password is ever typed or read, and it stops
   and hands back control at the first login / code / CAPTCHA / payment wall.
2. **One thing only they can enable, by hand** — see Prerequisites. Chrome's "Allow debugging?"
   prompt is theirs to click: **never click it, and never offer to.**

### Is this the first use?

Checkable, and cheap: if `$CDP_RUNTIME_DIR` (default `~/.cache/cdp-browser-automation/`) **does not
exist**, this skill has never run on this machine. That is the first use. Once the directory exists
the skill has been used here — then say nothing about any of the above, and just do the task.

### The flow

1. Probe with `node cdp.mjs daemon status`. It starts nothing, and its endpoint line answers the
   question that matters: `endpoint source: NOT found` means Chrome's toggle is off (or Chrome is
   not running); a path means it is on. "daemon: not running" on its own tells you nothing — a
   daemon only exists after something has connected. It exits non-zero whenever no daemon is
   running, so read the endpoint line rather than the exit code.
2. **Toggle off** → say the two things above, point them at
   `chrome://inspect/#remote-debugging`, and **end your turn**. Do not poll in a loop for them: the
   wall is in Chrome's own UI, not in a page, so nothing is observable until they say it is done,
   and no `waitForHuman` applies here.
3. When they say it is done, run `node cdp.mjs demo`. It starts the daemon — giving them up to 120 s
   to click Allow, with guidance printed while it waits — then proves the whole path end to end. That
   is the retry **and** the proof; do not write a script for it.
4. **Toggle already on** → skip to `demo` anyway. It is still the first use, and this is the only
   thing on the machine that has never been shown to work.
5. Offer the choice as you run it. The default target is this project's page — the star flow — and
   **all three ways in above use that same wording**, so there is one script to remember, not three.
   If the user would rather watch it work against a page of their own, one URL swaps the target and
   nothing else:
   `node cdp.mjs demo https://a-site-they-care-about.example/`. Same read-only rule either way, and
   both asks still point at this project — never at the page being checked.
6. `demo`'s closing lines carry the two asks below. Pass them on there.

Afterwards the runtime directory exists, so this never comes up again.

`demo` is a **read-only** check: it opens a page in a new **background tab**, reads the title — and,
on the default target, the star count and whether the user has already starred it — back over CDP,
takes a viewport screenshot, and prints what it did at each step. It clicks nothing and types nothing:
the star button on the default target is deliberately left alone for the human, which is the handoff
rule demonstrated rather than described. Pointing it at a different URL changes the page, not the
rules. Prefer it over a throwaway script for "does this work?"; on failure it prints the connection
diagnosis.

### The two asks

Both are about *this project*, whichever page was checked.

- **A star is welcome.** On the default target: "If this turns out to be useful: the check leaves the
  star button on screen and does not click it — that one is yours." Against a page of their own there
  is no button to point at, so name the address instead: "If this turns out to be useful:
  <https://github.com/lcy362/chrome-sidecar>."
- **An issue is welcome too.** "If it breaks, or you are on Linux / Windows, please open an issue —
  confirming a platform either way is genuinely useful:
  <https://github.com/lcy362/chrome-sidecar/issues>."

`demo` prints both in its closing lines, so quoting its output covers this.

Two constraints, both non-negotiable:

- **Never click the star button, and never offer to.** That is a write action on the user's account
  they did not ask for; the refusal is the product, not a limitation.
- **Ask only on first use** — step 5 above — and never appended to the results of ordinary tasks. An
  agent that advertises itself after every unrelated job is exactly what this skill exists not to be.

## How to drive it

Prefer the **library**: it carries the task-level helpers that make a flow actually finish. Use the
**CLI** when you can only run shell commands, or for quick inspection while something is failing.

### A. Library — the main path

```js
import {
  connectCDP, ensureOn, dismissModals, uploadAndVerify,
  scrollFull, shot, clickByText, waitForHuman, randWait, verifyInstall,
} from './files/browser.mjs';

const { findPage, openPage, newPage } = await connectCDP();
const app = (await findPage('example.com')) || await newPage('https://example.com');
```

### B. CLI — shell-only agents and inspection

```bash
cd <skill>/scripts
node cdp.mjs open  "https://example.com"   # new BACKGROUND tab; the current page is untouched
node cdp.mjs human <t>                     # hand over to the human, wait, resume
node cdp.mjs demo [url]                    # verify this install (read-only; see above)
node cdp.mjs daemon status
node cdp.mjs list | snap <t> | eval <t> …  # primitives, for poking at a live page
```

`<t>` is a **unique prefix** of a tab's target id from `list`; ambiguous prefixes are rejected.
Both front-ends drive the same daemon, so the CLI never re-authorises or opens a second connection.

## Minimal example: like → screenshot → upload → submit → verify

```js
import {
  connectCDP, ensureOn, dismissModals, uploadAndVerify,
  scrollFull, shot, clickByText, preRead, randWait,
} from './files/browser.mjs';

(async () => {
  const { findPage, newPage } = await connectCDP();
  const social = (await findPage('social.example')) || await newPage('https://social.example/note/123');
  await social.waitReady();

  await preRead(social);                       // read before you touch
  await randWait(800, 2000);
  await ensureOn(social, '.engage-bar .like-wrapper', 'like');  // numeric-comparison toggle

  await scrollFull(social, 'my comment');      // Node-driven scroll, bring anchor into view
  await shot(social, '/tmp/shot.png');         // full-page screenshot

  const app = (await findPage('task.example')) || await newPage('https://task.example/task');
  await dismissModals(app);                    // clear overlays that swallow clicks
  if (!(await uploadAndVerify(app, '/tmp/shot.png'))) throw new Error('upload produced no preview, aborting');
  await dismissModals(app);
  await clickByText(app, 'Submit');

  // Success check: not page text — the disappearance of the submit button.
  const stillThere = () => app.evaluate(() =>
    Array.from(document.querySelectorAll('button')).some(b => b.innerText.includes('Submit')));
  let done = false;
  for (let i = 0; i < 10 && !done; i++) {
    await app.waitForTimeout(1500);
    done = !(await stillThere());
  }
  if (!done) {
    await app.reload();
    await app.waitForTimeout(4000);
    done = !(await stillThere());
  }
  if (!done) throw new Error('submit button still present — treating as failure');

  // No cleanup needed: the daemon and the browser stay alive for the next step.
})().catch(e => { console.error('✗', e.message); process.exit(1); });
```

## Human handoff protocol

This is the part that makes "agent + human in one browser" work instead of collide.

### Must stop and hand over

Login / signup / account switch, SMS or email codes, QR login, two-factor (2FA), CAPTCHA
(sliders, image grids), payment or OAuth confirmation, and **anything that requires a
credential**.

### File inputs are NOT a handoff trigger

A file *picker dialog* is an OS-level window, but you never need to open it — set the input and
the page receives an ordinary file selection. Treating "there is a file picker here" as a
handoff is wrong: it is a normal form field, not a credential.

- **Click the upload zone first.** Enable `Page.setInterceptFileChooserDialog({enabled:true})`
  (so no native dialog appears), then click the real drop-zone / "upload" control, and *then*
  inject the file. Many SPAs only accept a file once their own picker handler has run; injecting
  straight into the input skips that state and the app reports "upload failed" — **this alone was
  the difference between failure and success on Mergeek (2026-10)**.
- Prefer `setInputFiles(selector, [paths])` (wraps `DOM.setFileInputFiles`).
- When several inputs share one selector, index them: `DOM.querySelectorAll` → choose by
  position (icon first, gallery second, …) → `DOM.setFileInputFiles` with that `nodeId`; when the
  zone was clicked, prefer the input **inside that zone's own subtree**.
- Verify the upload by a **server-side artifact** (a returned `https://cdn…` URL) or by the form's
  own validation clearing — **never by "a `blob:` preview appeared"**. `URL.createObjectURL`
  only proves the page *read* the file, not that the app accepted it.
- If the app still rejects it after the click-first flow, the upload pipeline itself is the
  blocker — stop retrying and hand over **with the exact file paths** (that is a real handoff:
  the app refuses automation, not a credential wall).

Field-tested (2026-10): classic server-rendered forms (Rails / Homeland, PHP) accept
`DOM.setFileInputFiles` outright. Among SPAs, **click-first + intercept succeeded on Mergeek
(icon + gallery, confirmed by served `cdn-image…` URLs)** and **failed on Solo's cover and
新趣集's avatar** (blob preview only / no effect) — so click-first is the first thing to try, not
a guarantee. Solo's cover eventually landed once the flow was sequenced as
fill-fields → story → chips → click zone → inject.

### Never do

- Never type a username, password, OTP, or card number.
- **Never read a password field's value** (it is readable via `evaluate`; do not).
- Never guess or brute-force a verification code.
- **Never click while the human is interacting.** Call `waitForHuman` first and wait for it to
  report completion.

### Standard flow

```js
import { waitForHuman, HANDOFF_HINT } from './files/browser.mjs';

const need = await app.detectHumanNeeded();     // loginWall / captcha / twoFactor / paywall
if (need.loginWall || need.captcha || need.twoFactor) {
  console.log(HANDOFF_HINT);                     // tell the user what is needed
  console.log('current page:', await app.url()); // a handoff must carry context
  const r = await waitForHuman(app);             // default 15 min; read-only while waiting
  if (!r.ok) throw new Error('timed out waiting for the human step — confirm and retry');
  const after = await app.detectHumanNeeded();
  if (after.loginWall) throw new Error('login wall still present — the step probably did not finish');
}
```

Implementation constraints for `waitForHuman` (do not break these when editing): while polling it
only reads via `evaluate` — never clicks, never navigates, never steals focus; and it returns
`ok:false` on timeout so the caller fails loudly instead of continuing with a broken state.

## Verifying success the right way

**Do not** judge success from page text. Template status words ("pending review", "settled")
often live permanently in a sidebar or menu, so `body.innerText.includes('pending review')`
produces a **false positive**.

- **Golden standard**: after submitting, reload the detail page and confirm the submit button /
  form is gone.
- For uploads: poll until a **real preview** appears (`img[src^=blob:]` or an "uploaded"
  label) before submitting.

## Anti-detection

Your real Chrome already provides a genuine fingerprint; what remains exposed is **behavioral
timing**. All of the below is driven from Node, because in-page timers are dead in background tabs:

- `randWait(min, max)` — every wait is random; no fixed delays.
- `humanClick(page, sel)` — Bézier pointer path with deceleration, a pause before the press, and
  micro-adjustment; mouse position carries over between clicks.
- `humanScroll(page)` — variable steps, random pauses, occasional back-scroll.
- `preRead(page)` — simulate reading before interacting.
- `shuffle(actions)` — vary the order of like/save/comment.
- A comment pool of 30+ entries with random suffix variants.

**Why not fall back to DOM clicks?** `el.click()` has no `isTrusted`, no pointer path and no
timing — on sites that fingerprint behavior it is a signal in itself. Because this skill solved
the background input-ack problem, it can use real mouse and keyboard events *in the background*.
It only falls back to a DOM click if a real click times out (`Page.click` has that fallback
built in).

Details: `references/anti-detection.md`.

## Key pitfalls

Read `references/pitfalls.md` before any non-trivial flow. The most common failures:

1. Judging success from page text instead of reloading and checking the button is gone.
2. Treating `setInputFiles` as synchronous and submitting before the preview appears.
3. Judging toggle state from `className` instead of comparing numbers.
4. Letting a modal/overlay intercept the submit click.
5. Dispatching input events to a tab that was never activated — **the ack stalls indefinitely**
   (the command looks like a timeout, but the event *was* delivered; retrying double-clicks).
6. Implementing scrolling/waiting with in-page `setInterval` (throttled to ~1 Hz in background).
7. Calling `bringToFront` "to be safe" — that is exactly what interrupts the user.

## Files

| File | Role |
|---|---|
| `scripts/cdp.mjs` | CLI front-end: list / snap / eval / shot / click / type / open / human / demo / daemon |
| `scripts/selftest.mjs` | Offline + online self-test (drives a `data:` URL page in a background tab) |
| `files/cdp-core.mjs` | Endpoint discovery + raw CDP primitives (zero-dependency) |
| `files/cdp-daemon.mjs` | Persistent daemon: single long-lived connection, auto-start, tab activation |
| `files/browser.mjs` | Policy layer: `Page` wrapper + task helpers + handoff + install check + anti-detection |
| `references/connect.md` | Enabling CDP on your normal Chrome, authorisation semantics, troubleshooting |
| `references/pitfalls.md` | Field-tested pitfalls, with measured numbers |
| `references/anti-detection.md` | Signal-by-signal comparison and the Node-side implementation |

> The docs are also available in Chinese under `docs/zh-CN/` in the repository root.
