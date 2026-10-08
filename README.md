# chrome-sidecar

**Give your AI agent hands in your own Chrome — without taking the wheel.**

An [agent skill](https://github.com/pasky/chrome-cdp-skill)-style toolkit that drives the Chrome
you are *already using*: your profile, your tabs, your logins. It works in **background tabs**
so it never steals your focus, uses **real mouse and keyboard events** so it does not betray
itself to anti-bot heuristics, and **hands control back to you** when a password or a 2FA code
is on screen.

Zero runtime dependencies. Node 22+ only.

```
┌─ what other tools do ─────────────────────────────┐   ┌─ what this does ──────────────────────────┐
│                                                   │   │                                           │
│  steal your foreground tab                        │   │  operate in a background tab              │
│  or degrade to DOM el.click() (no isTrusted)      │   │  real Input events, still in background   │
│  or silently type your credentials                │   │  stop and hand over when you're needed    │
│                                                   │   │                                           │
└───────────────────────────────────────────────────┘   └───────────────────────────────────────────┘
```

📖 [中文说明](README.zh-CN.md) · [docs/zh-CN](docs/zh-CN) — the agent-facing `SKILL.md` and
`references/` ship in English; the original Chinese docs are kept in `docs/zh-CN/`.

---

## Why this exists

Connecting an agent to your real Chrome is a solved problem. Doing it **without being annoying
and without lying about who is driving** is not.

Reading a page from your logged-in session is fine when it is read-only. *Acting* is where it
gets ugly, because a naive implementation has to pick one of two bad options:

| Naive approach | What breaks |
|---|---|
| Bring the target tab to the front, then click | It hijacks your foreground every time. You lose whatever you were typing. |
| Stay in the background, but click via `document.querySelector(sel).click()` | No `isTrusted`, no pointer path, no timing jitter — and some frameworks ignore synthetic clicks entirely. |
| Reuse your session but fill in the password field | The agent now holds your credentials, and you have no idea which step it is on. |

`chrome-sidecar` takes none of these. It keeps working in the background *and* keeps the input
real, then stops at the login wall and gives you the keyboard.

## What makes it different

### 1. Background operation that is not crippled

A background tab in Chrome is throttled hard: `setInterval(16ms)` runs at ~1 Hz,
`requestAnimationFrame` stops entirely, and — the nasty one — `Input.dispatchMouseEvent`
**never acks** (it stalls for seconds, though the event *is* delivered; retrying then
double-clicks).

Two CDP calls fix it without touching the foreground:

```js
await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sid);
await cdp.send('Page.setWebLifecycleState', { state: 'active' }, sid);
```

Measured on a background tab (Chrome 154, macOS, DPR 2):

| Metric | Before | After |
|---|---|---|
| `setInterval(16ms)` ticks per second | 2 | **63** |
| `requestAnimationFrame` callbacks per second | **0** | **61** |
| `Input.dispatchMouseEvent` ack | **stalled (>5 s)** | **8–18 ms** |
| `dispatchKeyEvent` / `insertText` | — | 4 ms / 1 ms |
| **Your foreground tab** | — | **unchanged** |

That last row is verified independently, not asserted: the test reads Chrome's own active tab
via AppleScript before and after, and after 25 s of idling. `document.visibilityState` is
useless for this check — focus emulation makes the target page believe it is visible.

### 2. A human handoff protocol, not just a command set

Most tools hand you 14 primitives and wish you luck. This one defines **when to stop**:

- **Must stop and hand over**: login/signup, SMS or email codes, QR login, 2FA, CAPTCHA,
  payment or OAuth confirmation, native file pickers, anything requiring a credential.
- **Never do**: type a user's username/password/OTP, read a password field's value, guess a
  code, or click while the human is interacting.
- **`waitForHuman(page)`** polls read-only (no clicks, no navigation, no focusing) with a
  generous default timeout, then verifies the wall actually disappeared before resuming.

### 3. A policy layer: doing the task *correctly*, not just issuing commands

The difference between "I can click" and "I submitted the form" is a pile of small truths:

- `ensureOn()` — toggle state via **numeric comparison**, not `className`. SPA class names lie,
  and clicking an already-on toggle turns it *off*; the helper notices the count dropped and
  clicks back.
- **Reload-golden-standard** success detection — after submitting, reload and check the button
  is *gone*. Template status words ("pending review") live permanently in sidebars and produce
  false positives.
- `uploadAndVerify()` — `setInputFiles` returns instantly but the upload is async; clicking
  submit too early silently does nothing. Poll for a real preview.
- `dismissModals()` / `clickByText()` — overlays swallow pointer events; there is a DOM-click
  fallback.
- `scrollFull()` — Node-driven scrolling that also triggers lazy loading.

### 4. Anti-detection that survives the background constraint

Using your real Chrome already gives a genuine fingerprint. What remains is **behavioral
timing**: `randWait`, `humanClick` (Bézier path with deceleration and micro-adjustment),
`humanScroll` (variable steps, random pauses, occasional back-scroll), `preRead` (read before
you interact), `shuffle` (vary action order).

These are driven from Node, not from in-page timers, because of the throttling above. And
because background input works, you do not have to choose between *being polite* and *looking
human*.

---

## Demo

Real output from `npm test` (`scripts/selftest.mjs`), which drives a throwaway `data:` URL page
in a background tab — no site, no network:

```console
$ npm test
chrome-sidecar selftest  (node v24.14.0 / darwin)

== A. Offline checks ==
  ✓ parsePortFile reads port and ws path  port=9333 path=/devtools/browser/abc-def
  ✓ macOS candidate is Google/Chrome (two levels)
  ✓ shuffle keeps every element

== B. Online checks (background tab, no focus stealing) ==
  Like before click: 13
  Like after click: 12
  ⚠ Like was on and got toggled off; clicking again…
  Like after corrective click: 13
  ✓ ensureOn restores a toggle that got switched off  final count=13 Like
  ✓ dismissModals closes an overlay modal
  ✓ uploadAndVerify polls until a real preview appears
  ✓ clickByText hits the button, not the wrapping container
  ✓ waitForHuman resumes once the human step is done
  ✓ temporary tab cleaned up
  ✓ the user foreground tab was never taken  len=139 hash=f052a60e → len=139 hash=f052a60e

=== selftest: 24/24 passed ===
```

The `ensureOn` sequence above is the point: the toggle was *already on*, so the first click
turned it off, the helper detected the count drop and clicked back.

## Install

**1. Enable remote debugging in your normal Chrome**

Open `chrome://inspect/#remote-debugging` and tick
**"Allow remote debugging for this browser instance"**. A `DevToolsActivePort` file appears in
your profile directory; that is how the endpoint is discovered.

Chrome will ask you to confirm ("Allow debugging?") when a client connects. That dialog is the
security boundary — **never automate it away**.

**2. Drop the skill where your agent looks for skills**

```bash
git clone https://github.com/lcy362/chrome-sidecar
cp -R chrome-sidecar/skills/chrome-sidecar ~/.claude/skills/     # or your agent's skills dir
```

**3. Try it**

```bash
cd chrome-sidecar/skills/chrome-sidecar
node scripts/cdp.mjs daemon start     # authorise once; the connection stays up
node scripts/cdp.mjs list             # your tabs
node scripts/cdp.mjs snap 6BE827FA     # accessibility-tree snapshot of one tab
npm test                               # full self-test
```

## Usage

The **library** is the real path — it carries the task-level helpers. The **CLI** is for poking at
a live browser while debugging, and for agents that can only run shell commands.

### Library

```js
import {
  connectCDP, ensureOn, dismissModals, uploadAndVerify,
  scrollFull, shot, clickByText, waitForHuman, preRead, randWait,
} from './files/browser.mjs';

const { findPage, newPage } = await connectCDP();
const social = (await findPage('example.com')) || await newPage('https://example.com/note/1');
await social.waitReady();

await preRead(social);                       // look before you touch
await randWait(800, 2000);
await ensureOn(social, '.engage-bar .like-wrapper', 'like');

await scrollFull(social, 'my comment');      // Node-driven scroll + bring anchor into view
await shot(social, '/tmp/shot.png');

const app = (await findPage('forms.example.com')) || await newPage('https://forms.example.com/new');
await dismissModals(app);
if (!(await uploadAndVerify(app, '/tmp/shot.png'))) throw new Error('upload never produced a preview');
await dismissModals(app);
await clickByText(app, 'Submit');

const need = await app.detectHumanNeeded();
if (need.loginWall || need.captcha || need.twoFactor) {
  console.log('Needs you: finish this step in the Chrome tab, then tell me.');
  if (!(await waitForHuman(app)).ok) throw new Error('timed out waiting for the human step');
}
```

## Security and privacy

This tool drives a session that can read everything you are logged into. Treat it accordingly.

- **Consent is explicit and per-connection.** Chrome raises an "Allow debugging?" prompt when a
  client attaches. Do not script your way past it.
- **Local only.** The daemon listens on a UNIX socket (`0600`) or a per-user Windows named pipe.
  Nothing is exposed to the network.
- **No credentials, ever.** The skill is instructed never to type or read passwords, OTP codes,
  or card numbers, and to hand over instead. Review that instruction before you rely on it.
- **No data leaves your machine.** There is no telemetry, no remote endpoint, no analytics.
- **One driver at a time.** Do not point two CDP tools (e.g. another MCP server) at the same
  Chrome; sessions and authorisations will interfere.
- **Use it on your own accounts.** This is built so an agent can do the repetitive parts of
  *your* work, not to farm accounts or bypass a platform's limits.

## Platform support

| Platform | Status |
|---|---|
| macOS | Tested (Chrome 154). Port discovery, UNIX-socket daemon, AppleScript-based non-intrusive verification. |
| Linux | Port discovery implemented (including Flatpak paths). Not yet verified on a real machine. |
| Windows | **Implemented but unverified**: port discovery via `%LOCALAPPDATA%`, daemon over a per-user named pipe. Needs someone with a Windows box to confirm. |

The foreground-verification step in `selftest.mjs` is macOS-only (it reads Chrome's active tab
to prove nothing jumped). On other platforms that check is skipped, not silently passed.

## Prior art

The **connection layer** follows the design of [pasky/chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill)
(MIT): discovering the endpoint through `DevToolsActivePort`, binding it behind a persistent
daemon over a local socket, addressing tabs by shortest unique id prefix, and the compact
accessibility-tree snapshot. Those are good ideas and they are not ours.

This project is **not a fork** — the code is written independently — and the layers above the
plumbing are original to it: non-intrusive background operation, the human handoff protocol,
the task-level policy helpers, and the behavioral anti-detection layer.

### How it differs

| | chrome-cdp-skill | chrome-sidecar |
|---|---|---|
| Connections | one daemon **per tab** → one authorisation prompt per tab | one daemon for all tabs → one prompt per Chrome start |
| Background tab responsiveness | not addressed | focus emulation + lifecycle activation (measured above) |
| Clicking | DOM `el.click()`; `clickxy` for real events | real Input events by default, DOM fallback on failure |
| New tab | foreground | `background: true` — never steals focus |
| Screenshot | viewport only | full page (`captureBeyondViewport`) or viewport |
| Task-level correctness | none — 14 primitives | `ensureOn`, `uploadAndVerify`, `dismissModals`, reload-based success checks |
| Human/agent handoff | none | stop conditions + `waitForHuman` |
| Anti-detection | none | timing, pointer paths, scroll, reading behavior |
| Footprint | one 32 KB file | four modules |
| Platform coverage | macOS, Linux, Windows, Flatpak | macOS verified; Linux/Windows implemented, unverified |

If you want the smallest possible tool to poke at a page, **use theirs**. If you want an agent
to carry out a task in your browser without being a nuisance or a liability, this one goes further.

## Repository layout

```
skills/chrome-sidecar/
├─ SKILL.md                  agent-facing entry point (what/why/how, handoff rules)
├─ files/cdp-core.mjs        endpoint discovery + raw CDP primitives
├─ files/cdp-daemon.mjs      persistent single connection, auto-start, tab activation
├─ files/browser.mjs         Page wrapper + policy helpers + handoff + anti-detection
├─ scripts/cdp.mjs           CLI front-end
├─ scripts/selftest.mjs      offline + online self-test
└─ references/               connect.md · pitfalls.md · anti-detection.md
docs/zh-CN/                  the same docs in Chinese
```

Root files: `README.md` (this), `README.zh-CN.md`, `AGENTS.md`, `LICENSE` (MIT), `package.json`.

## Requirements

- Node.js **22+** (uses the built-in `WebSocket`)
- Chrome, Chromium, Brave, or Edge, running normally, with the `chrome://inspect` toggle on
- Nothing else. No Playwright, no Puppeteer, no npm install.

## Contributing

Most valuable right now: **Linux and Windows verification** of the port discovery and daemon,
and translations of `SKILL.md` / `references/` into languages other than English and Chinese.

## License

MIT — see [LICENSE](LICENSE).
