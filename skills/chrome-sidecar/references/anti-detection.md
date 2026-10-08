# Anti-detection

## Why this layer can exist here at all

Your real Chrome already has a genuine fingerprint (User-Agent, extensions, viewport, TLS
fingerprint, cookie distribution), so driving it over CDP is **less detectable than launching a
fresh Playwright instance**.

What remains exposed is **behavioral timing** — humans are irregular, so a script must be too.

Most lightweight CDP tools click with DOM `el.click()`: no `isTrusted`, no pointer path, no
timing jitter. On sites that fingerprint behavior, that is a signal in itself.

This skill **can use real mouse and keyboard events inside a background tab** (because it solved
the input-ack stall — see `pitfalls.md` #1). That means you do not have to choose between being
polite to the user and looking human to the site.

## Signal by signal

| Signal | Mechanical (detectable) | Human-like (implemented here) |
|---|---|---|
| **Timing** | fixed delays (`waitForTimeout(2000)`) | `randWait(2000, 4000)` — every wait random |
| **Mouse** | `page.click()` teleports to the element center | `humanClick()` — Bézier path from a random start, smoothstep deceleration, a pause before the press, micro-adjustment; pointer position persists between clicks |
| **Scrolling** | fixed step/interval (`scrollBy(0,500)` every 150 ms) | `humanScroll()` — variable 200–700 px steps, 300–1200 ms random pauses, 20% chance of a small back-scroll |
| **Action order** | always like → save → comment | `shuffle(actions)` every time |
| **Comment text** | a pool of 10, exact repeats | a pool of 30+ with random suffix variants (emoji, punctuation) |
| **Reading behavior** | click immediately after load | `preRead()` — gradual scrolling with reading pauses (0.8–3 s), 40% chance of returning to the top |
| **Between actions** | no pause | 60% chance of a 0.5–2.5 s "thinking" pause |

## Implementation constraint: it must be Node-side

In a background tab, in-page `setInterval` is throttled to ~1 Hz and `requestAnimationFrame`
stops entirely. Every behavior above therefore lives in Node — `await sleep(...)` plus
incremental CDP dispatches — and **must not** be reimplemented with in-page timers.

`humanScroll()` uses `Input.dispatchMouseEvent` with `mouseWheel`; `humanClickAt()` walks a
series of `mouseMoved` events toward the target, then presses and releases.

## Usage

```js
import { preRead, randWait, humanClick, humanScroll, shuffle, ensureOn } from './files/browser.mjs';

await page.goto(url);
await page.waitReady();
await preRead(page);                       // read before you act
await randWait(800, 2200);

for (const action of shuffle([
  () => ensureOn(page, '.engage-bar .like-wrapper', 'like'),
  () => ensureOn(page, '.engage-bar .collect-wrapper', 'save'),
])) {
  await action();
  if (Math.random() < 0.6) await randWait(500, 2500);
}
```

## Limits

- Anti-detection lowers the **probability** of being flagged. It is not a guarantee; platform
  heuristics keep moving.
- Do not experiment on accounts that matter — one misjudgement can lock or ban an account.
- The intended use is **doing the user's own repetitive work**, not circumventing a platform's
  limits. Anything involving credentials, verification codes or payment confirmation is handed
  back to the human (see the handoff protocol in `SKILL.md`).
- Raising the frequency, or operating several tabs against the same site concurrently, sharply
  increases the chance of being flagged — even if every individual action looks human.
