# AGENTS.md — maintaining chrome-sidecar

**Read this before changing anything.** It is written for an agent (or human) *editing this
repository*, which is a different job from *using* the skill at runtime.

## 0. Which document is for whom

Getting this wrong is the most common way this repo degrades — for example by copying runtime
instructions into `README.md`, or build rules into `SKILL.md`.

| File | Reader | When it is read | Never put here |
|---|---|---|---|
| `README.md`, `README.zh-CN.md` | a human deciding whether to use this | before installing | runtime instructions, maintenance rules |
| `skills/chrome-sidecar/SKILL.md` | the **runtime** agent driving a user's browser | when a user asks for browser work | build rules, repo conventions |
| `skills/chrome-sidecar/references/*.md` | the runtime agent, on demand | when it hits the specific problem | anything short enough for `SKILL.md` |
| `AGENTS.md` (this file) | an agent **editing this repo** | every time you change something | user-facing rationale, runtime instructions |

Rule of thumb: *user-facing rationale → README; runtime instructions → SKILL.md; rules about
changing this repo → here; deep detail on a runtime problem → references.*

## 1. What this project is

- One skill, `skills/chrome-sidecar/`, plus a root README and a Chinese doc mirror.
- **Zero runtime dependencies.** Node 22+ only, using the built-in `WebSocket`. No build step, no
  `npm install`, no bundler. Do not add a dependency without a very strong reason.
- It drives **the user's real Chrome** — their profile, their tabs, their logins. Most failure
  modes are visible to the human sitting in front of the browser, so regressions here are not
  abstract.

## 2. Invariants — do not break these

Each one exists because it was violated once and cost real debugging time.

**2.1 Never steal the foreground.**
No `bringToFront`, no `Target.activateTarget`, anywhere. New tabs are created with
`background: true`. If a change needs a tab in front, the change is wrong.

**2.2 Every attached target gets focus emulation + lifecycle activation.**
`Emulation.setFocusEmulationEnabled` + `Page.setWebLifecycleState('active')` in `ensureSession()`.
Without it, input acks stall indefinitely — and because the event *is* delivered anyway, a naive
retry double-clicks. See `references/pitfalls.md` #1 for the measured numbers.
Opt-out is `CDP_NO_ACTIVATE=1`; keep that working.

**2.3 `waitForHuman` polls read-only.**
No clicks, no navigation, no focus changes while waiting, and never read a password field's value.
Its whole purpose is that a human can type safely while it runs.

**2.4 The two front-ends must agree.**
`scripts/cdp.mjs` (CLI) and `files/browser.mjs` (library) both drive the same daemon.
For any **action** primitive present in both (`click`, `type`, …) the robustness must be
identical — the same wait, the same real-input-then-DOM-fallback. If you improve one, change the
other in the same commit. Presentation differences are fine (the CLI's `shot` additionally prints
the DPR hint that `clickxy` needs). Where practical, implement the CLI command *by calling the
library*, not by re-deriving CDP calls.

**2.5 Loops live in Node, not in the page.**
Background tabs throttle `setInterval` to ~1 Hz and stop `requestAnimationFrame` entirely. Any
scrolling, waiting or polling must be a Node loop. Never `setInterval` inside `evaluate`.

**2.6 Chinese strings in the code are match data, not prose.**
`DISMISS_LABELS`, the upload-status patterns and the login/CAPTCHA/2FA regexes contain Chinese so
they can match Chinese UIs. Each site carries an English comment saying so. Do not "translate them
away". If you add support for another language, *add* labels for it — that is what happened for
English in `DISMISS_LABELS`, after the self-test caught that English overlays could not be
dismissed.

**2.7 One connection.**
The daemon holds exactly one long-lived WebSocket, which is what keeps Chrome's per-connection
"Allow debugging?" prompt down to once per Chrome start. Do not add a second connect path, and do
not make the library connect on its own.

**2.8 Never automate Chrome's consent dialog.**
The "Allow debugging?" prompt is the security boundary. Do not ship anything that clicks it.

## 3. Verifying a change

There is no test framework and no build. Verification is:

```bash
node --check <file you touched>          # always
npm run test:offline                     # no Chrome needed
npm test                                 # offline + online; needs an authorised Chrome
node skills/chrome-sidecar/scripts/selftest.mjs --require-chrome   # fail instead of skip (CI)
```

The online half runs against a throwaway `data:` URL page in a **background** tab. It never
touches a website. On non-macOS platforms the final "foreground was not taken" assertion is
**skipped and says so** — do not turn that into a silent pass.

**3.1 Text-only changes (comments, messages, docs) must be proven inert.**
When a change is supposed to alter nothing but wording, prove it: strip comments and the contents
of every string/template literal from both versions, then compare. The two must be identical.

```js
// strip(src): walk the source; drop // and /* */ comments; for ', " and ` literals keep only the
// delimiter (dropping the content and handling backslash escapes). Then collapse whitespace.
// Compare strip(old) === strip(new).
```

This is not ceremony — it is what stopped an unintended behavioural change (an added label) from
riding along inside a "translation" commit.

**3.2 Never claim a number you have not measured.**
The timing table in `README.md` and the figures in `references/pitfalls.md` and
`AGENTS.md` came from real runs. If you change activation, scrolling or timing behaviour,
re-measure and update **all** places that quote it.

**3.3 The non-intrusiveness check is external.**
`document.visibilityState` cannot be used to tell whether the user's foreground moved: focus
emulation makes the target page report `visible` about itself regardless. `selftest.mjs` reads
Chrome's own active tab (via AppleScript on macOS) before and after and asserts the fingerprint is
unchanged. On other platforms that check is skipped; if you add an equivalent, add it there.

## 4. Layout and where new files go

```
skills/chrome-sidecar/
├─ SKILL.md          runtime entry point   (the agent that USES the skill)
├─ files/            cdp-core.mjs (discovery + primitives)
│                    cdp-daemon.mjs (single connection, activation)
│                    browser.mjs (Page wrapper, policy helpers, handoff, anti-detection)
├─ scripts/          cdp.mjs (CLI front-end), selftest.mjs
└─ references/       connect.md, pitfalls.md, anti-detection.md   (deep runtime detail)
docs/zh-CN/          Chinese mirror of the skill docs
AGENTS.md            this file
```

- Prefer editing an existing document over adding a new one.
- `references/` is for runtime problems that are too long for `SKILL.md`. Do not put repo
  conventions there.
- `docs/zh-CN/` is a **mirror**. It is expected to lag; keep it coherent enough to be useful, and
  never treat it as the source of truth.

## 5. The CLI — what it is for, and what it must not become

`scripts/cdp.mjs` is a **second front-end over the same daemon**, not a separate product.

**Why it exists** (all four are load-bearing; do not delete it without answering these):

1. Agents that can only run shell commands can drive the whole thing without writing a Node file.
2. Interactive debugging. `list` / `snap` / `eval` are the fastest way to answer "is it connected,
   which tab am I on, what is actually in the DOM right now" — without creating a script file.
   This is how the navigation race in `references/pitfalls.md` #15 was found.
3. A 30-second smoke test for a human right after install (README step 3).
4. `human` — handing control to a person is natural from a terminal.

**Rules:**

- **It must not become the headline.** It exposes primitives (`list`, `snap`, `eval`, `html`,
  `net`), and primitives are the commodity layer that every CDP tool has. Leading the README with
  them invites the "just another CDP CLI" comparison and buries what is actually different:
  background operation, the handoff protocol, and the policy helpers. Show `open` (background tab,
  current page untouched), `human`, and `daemon status` instead — those carry the positioning.
- Keep the **full command surface in `SKILL.md`** (the runtime agent needs it) and only a pointer
  in `README.md`.
- **Parity with the library** — see invariant 2.4. `cdp click` originally called the raw primitive
  while `Page.click` waited for the element and fell back to a DOM click; on a stalled tab the
  library recovered and the CLI timed out. Fixed by routing the CLI through `Page.click`.
- Adding a command: implement it by calling `files/browser.mjs` where possible. Only drop to
  `cdp-core.mjs` when there is no library equivalent.

## 6. Commits and releases

- Commit messages in **English**: a short title, then bullets explaining what and why.
- **Separate text-only changes from behavioural ones.** A pure translation or doc pass must be its
  own commit, so it can be skimmed and reverted independently.
- When a change fixes a defect found while doing something else, say so explicitly in the message.
- **Platform status is a claim, not a wish.** Today: macOS verified (Chrome 154); Linux port
  discovery and the Windows named-pipe daemon are *implemented but unverified*. Update
  `README.md` and the selftest together when someone actually verifies one.
- Release: bump `package.json` and the `version` in `SKILL.md` together, then tag.

## 7. Related repositories

- **`lcy362/flint`** is the recommended way for *users* to install and manage skills (README
  install step 2). That recommendation is deliberate: keep it, and keep manual copying as the
  documented fallback rather than the primary path. Do not turn the README back into a list of
  commands a user is expected to run.
- **`lcy362/local-skills`** holds a Chinese-language backup copy of this skill under
  `skills/cdp-browser-automation/`. It is a **copy**, and it is already behind (no English
  translation, and it predates the `DISMISS_LABELS` fix).
- **This repo is the source of truth.** A change made here does *not* propagate to the backup, and
  a change made there does not come back. If a fix matters for both, say so explicitly rather than
  assuming a sync exists.
- The old name `cdp-browser-automation` still appears in the backup. Do not reintroduce it here.

## 8. Platform notes

- **Port discovery** (`candidatePortFiles()` in `cdp-core.mjs`) is a list of profile directories
  per browser per OS. Note macOS is the two-level `Library/Application Support/Google/Chrome` —
  **not** `Google Chrome`. `selftest.mjs` asserts both the correct form and the absence of the
  wrong one, because that exact typo once made discovery fail silently while the port file sat
  right there.
- **Windows** has no UNIX sockets: the daemon binds `\\.\pipe\cdp-browser-automation-<user>`, and
  `fs.chmodSync` on the socket is guarded by a platform check. Keep both when editing
  `cdp-daemon.mjs`.
- Do not half-support a platform. Either the discovery paths *and* the daemon transport work, or
  say plainly that it is unverified.

## 9. Prior art — keep the credit current

The **connection layer** follows the design of [pasky/chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill)
(MIT): endpoint discovery via `DevToolsActivePort`, a persistent daemon behind a local socket,
shortest-unique-prefix tab addressing, and the compact accessibility-tree snapshot.

This is **not a fork**; the code is written independently, and the layers above the plumbing are
original. If you borrow more from anywhere, add it to the *Prior art* section of `README.md` in the
same commit — and do not attach the author's name to the project name or tagline.

## 10. Discoverability — the search terms move as a set

People reach this repo by searching GitHub for a **Chrome skill** (and for `chrome cdp skill`,
`claude chrome skill`, `browser automation skill`). Four places carry those terms, and they are
expected to change **together** — editing one alone is a half-finished change:

| Where | What it carries |
|---|---|
| GitHub **About** description | the literal phrase "Chrome skill", plus background tabs / real input events / human handoff / zero dependencies |
| GitHub **topics** | `chrome-skill`, `chrome-automation`, `chrome-devtools-protocol`, `agent-skill`, `agent-skills`, `claude-skill`, `browser-automation`, … |
| `README.md` / `README.zh-CN.md` | the phrase in the opening paragraph **and** in the `## What is a "Chrome skill"?` heading, plus the alias sentence (Chrome CDP skill, Claude Chrome skill, browser-automation skill) |
| `package.json` | same terms in `description` and `keywords`, ASCII-hyphenated |

Also: the commented JSON-LD block at the top of `README.md` mirrors the About description — update it
in the same commit.

Rules:

- **The phrase has to appear literally.** Search does not match synonyms; "controls your browser"
  does not score for "Chrome skill".
- **Headings and the first screen matter more than a keyword dump** at the bottom of the README. Do
  not add a keyword-stuffed section instead of putting the term where a human reads it.
- **Never invent a capability to fit a keyword.** The list only grows with things the repo actually
  does; a task the skill refuses (reading public pages, for instance) stays out of it.
