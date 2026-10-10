# chrome-sidecar

<!--
JSON-LD structured data, for search engines and AI engines that read repository READMEs (GitHub does
not execute it; the raw JSON is what gets read). Keep it in sync with the GitHub "About" description,
the topic list, and package.json.
-->

<!--
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "chrome-sidecar",
  "applicationCategory": "DeveloperApplication",
  "operatingSystem": "macOS, Linux, Windows",
  "description": "A Chrome skill for AI agents: drive the Chrome you are already using over the Chrome DevTools Protocol, in background tabs with real mouse and keyboard events, and hand control back to the human at password, 2FA and CAPTCHA walls. Zero runtime dependencies.",
  "url": "https://github.com/lcy362/chrome-sidecar",
  "codeRepository": "https://github.com/lcy362/chrome-sidecar",
  "programmingLanguage": "JavaScript",
  "runtimePlatform": "Node.js 22+",
  "softwareVersion": "1.0.0",
  "license": "https://opensource.org/licenses/MIT",
  "keywords": "chrome skill, chrome cdp skill, claude chrome skill, chrome automation skill, browser automation skill, agent skill, claude code skill, chrome devtools protocol, human in the loop, zero dependency",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "author": {
    "@type": "Person",
    "@id": "https://lichuanyang.top/#author",
    "name": "SandGrid",
    "alternateName": "lcy362",
    "url": "https://lichuanyang.top/",
    "sameAs": ["https://github.com/lcy362"]
  }
}
</script>
-->

**A Chrome skill for AI agents — give your agent hands in your own Chrome, without taking the wheel.**

`chrome-sidecar` is an [agent skill](https://github.com/pasky/chrome-cdp-skill)-style toolkit that
drives the Chrome you are *already using*: your profile, your tabs, your logins. It works in
**background tabs** so it never steals your focus, uses **real mouse and keyboard events** so it
does not betray itself to anti-bot heuristics, and **hands control back to you** when a password or
a 2FA code is on screen.

It ships as one `SKILL.md` directory, so it drops into any agent that reads skills — Claude Code,
Cursor, Codex, Gemini CLI — installed either through [flint](https://github.com/lcy362/flint) or by
copying that one directory.

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

## What is a "Chrome skill"?

A **Chrome skill** is an agent skill whose job is to *operate* a real Chrome — click, type, upload,
submit, read the dashboard behind a login — rather than only fetch a public page. `chrome-sidecar`
is one, and deliberately the narrow kind:

| What you need | What to use |
|---|---|
| Read a public page | A normal page fetch. No debugging port on anyone's browser. |
| Automate a site from scratch, in CI | Playwright / Puppeteer and a throwaway browser. |
| Act inside the Chrome the human is already logged into | **This** — a background tab in the browser that is already open. |

The same idea travels under several names — Chrome CDP skill, Chrome automation skill, Claude Chrome
skill, browser-automation skill, "let the agent use my browser" — and they all point at the same
layer: protocol-level control of a browser that a human is also using. That is exactly the place
where the naive designs in the next section fall over.

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

## Requirements

- Node.js **22+** (uses the built-in `WebSocket`)
- Chrome, Chromium, Brave, or Edge, running normally, with the `chrome://inspect` toggle on
- Nothing else. No Playwright, no Puppeteer, no npm install.

## Install the Chrome skill

**1. Enable remote debugging in your normal Chrome**

Open `chrome://inspect/#remote-debugging` and tick
**"Allow remote debugging for this browser instance"**. A `DevToolsActivePort` file appears in
your profile directory; that is how the endpoint is discovered.

Chrome will ask you to confirm ("Allow debugging?") when a client connects. That dialog is the
security boundary — **never automate it away**.

**2. Put the skill where your agent looks for skills**

Recommended: manage it with **[flint](https://github.com/lcy362/flint)**, a local-first skill asset
manager. You keep one directory of skills as the source of truth and flint distributes them to your
agents (Claude Code, Cursor, Codex…) through presets, so updating a skill updates it everywhere.
Everything is local — plain `SKILL.md` directories on disk, no account, no telemetry.

```bash
git clone https://github.com/lcy362/chrome-sidecar
npx flint-skills-hub      # or: npm install -g flint-skills-hub && flint
```

That opens a UI at <http://localhost:8787>. Register the cloned repository, put `chrome-sidecar` in
a preset, and apply it to the agents you use — flint links or copies the skill into their skills
directories.

Doing it by hand instead? Same clone, then copy it yourself:

```bash
cp -R chrome-sidecar/skills/chrome-sidecar ~/.claude/skills/     # or your agent's skills dir
```

**3. Check that it works**

There is nothing to launch. The skill ships a read-only install check — run it once:

```bash
cd chrome-sidecar/skills/chrome-sidecar/scripts && node cdp.mjs demo
```

It opens this repository in a **background tab**, reads the page and screenshots it, and prints what
it did at each step. Watch your own tab while it runs: it should not move.

**It deliberately does not click the star button.** That one is yours to click, and leaving it
alone is the whole point — the skill stops at the boundary instead of acting on your behalf.

**4. Ask your agent for something**

Now give it something small, so you can watch how it behaves:

> Open example.com and tell me the page title.

Your active tab should not move. See [Using it](#using-it) below for what else to expect.

## Using it

You do not drive the browser yourself. You ask your agent, in plain language, and this skill is
what tells the agent how to behave inside your Chrome: work in a background tab, never take your
focus, use real input events, and stop and hand over when it needs you.

Things worth asking:

> Open my ad dashboard and tell me yesterday's revenue.

> Update the second paragraph of my saved draft, then save it.

> Check whether that order shipped, and post the tracking number in the support thread.

> Take a screenshot of the pricing page and put it in my notes.

> Turn on two-factor for my account — and hand it back to me when the QR code appears.

What to expect while it works:

- It opens the page in a **background tab**. Your active tab does not move, and nothing you are
  typing gets interrupted.
- When it hits a login, a code, a QR scan or a payment confirmation, **it stops and tells you**,
  then waits — reading only, not clicking — until you say you are done.
- It never types your password, never reads a password field, and never asks you for a credential.
- If it cannot finish, it says where it stopped instead of guessing.

The technical surface — the API, the command-line front-end, and the rules for changing either —
lives in [`skills/chrome-sidecar/SKILL.md`](skills/chrome-sidecar/SKILL.md), which your agent reads
on your behalf. Contributors should start at [AGENTS.md](AGENTS.md).

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
  payment or OAuth confirmation, anything requiring a credential. File inputs are **not** a
  handoff trigger — set them with `setInputFiles` (see the skill docs).
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

## Demo

For the 10-second version, run `node cdp.mjs demo` — the read-only install check from step 3.

The full self-test is `npm test` (`scripts/selftest.mjs`). It drives a throwaway `data:` URL page in
a background tab — no site, no network. The full run, and the external evidence behind the "never
steals your focus" claim, are in **[docs/demo.md](docs/demo.md)**. The assertion that matters:

```console
  ✓ the user foreground tab was never taken  len=139 hash=f052a60e → len=139 hash=f052a60e
```

The `ensureOn` sequence is the part worth reading closely: the toggle was *already on*, so the
first click turned it off, the helper detected the count drop and clicked back.

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

## Contributing

Most valuable right now: **Linux and Windows verification** of the port discovery and daemon,
and translations of `SKILL.md` / `references/` into languages other than English and Chinese.

## License

MIT — see [LICENSE](LICENSE).
