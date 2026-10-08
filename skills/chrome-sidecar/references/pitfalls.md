# Pitfalls, learned the hard way

Everything here was measured on a real machine (Chrome 154 / macOS / background tabs). Numbers
will shift on other versions — re-measure, do not assume.

## 1. Input acks stall indefinitely in a background tab (the sneakiest one)

**Symptom:** `Input.dispatchMouseEvent` / `dispatchKeyEvent` time out — in one run, 4 of 8
dispatches got no response for over 5 seconds. **But the events were delivered**: the click
counter in the test page actually incremented.

**Consequence:** treating the timeout as a failure and retrying will **click the target twice**
(a like becomes an unlike; a submit becomes a double submit).

**Root cause:** an un-activated background tab is throttled, and the input ack depends on the
renderer's response, which is deferred indefinitely.

**Fix:** apply this on attach:

```js
await cdp.send('Page.enable', {}, sid);
await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sid);
await cdp.send('Page.setWebLifecycleState', { state: 'active' }, sid);
```

Measured on the same tab (before → after):

| Metric | Before | After |
|---|---|---|
| `setInterval(16ms)` ticks in 1 s | 2 | **62–63** |
| `requestAnimationFrame` callbacks in 1 s | **0** | **61** |
| `Input.dispatchMouseEvent` ack | **stalled >5 s** | **8–18 ms** |
| `dispatchKeyEvent` / `insertText` | — | 4 ms / 1 ms |

The daemon does this automatically in `ensureSession()`. `Page.click` also falls back to a DOM
click if a real click times out.

## 2. In-page timers and animation frames are dead in background tabs

`setInterval` is throttled to ~1 Hz and `requestAnimationFrame` stops completely (measured:
0 callbacks in one second).

**Therefore:** scrolling, waiting and polling are driven from **Node**, never from a loop inside
the page. Anti-pattern: `setInterval(() => window.scrollTo(0, y), 150)` inside the page — in a
background tab that advanced 4 times in 3 seconds and reached only 1379px where ~10000px was
expected.

See `scrollFull()` in `browser.mjs` for the Node-side pattern.

## 3. Side effect of focus emulation: `visibilityState` is always `visible`

After applying the fix from #1, the **target page itself** always reports
`document.visibilityState === 'visible'` and `document.hasFocus() === true`, even though it is a
background tab.

So:

- Never use `visibilityState` to decide "did we steal the user's foreground" — false negative.
- It *is* a cheap, useful signal that activation took effect.
- To actually verify non-intrusiveness, see `connect.md` §6. Measured that way: the user's active
  tab fingerprint was unchanged before the operation, after it, and after 25 s of idling.

Some sites change behavior when they think they are visible (autoplaying video, for example).
For those, set `CDP_NO_ACTIVATE=1` and use `click(..., { via: 'dom' })`.

## 4. `setInputFiles` is asynchronous — poll for the preview

`DOM.setFileInputFiles` returns immediately, but the platform-side upload is asynchronous. Click
submit immediately and the button is still `disabled`, so the click **does nothing, silently**.

**Fix:** poll until a real preview appears (`img[src^=blob:]` / `data:image`) or an
"uploaded" label shows, then submit. Use `uploadAndVerify()`. This is the single most common
cause of "it looked like it submitted but did not".

## 5. Do not judge success from page text

Templates keep status words ("pending review", "settled") permanently in sidebars and menus, so
`body.innerText.includes('pending review')` produces a **false positive**.

**Golden standard:** after submitting, reload the detail page and confirm the submit
button/form **disappeared**. Absence of the button means it really submitted.

## 6. `className` is unreliable for toggle state

In SPAs, `active` / `on` mean inconsistent things — and sometimes the *absence* of a class means
"on".

**Numeric comparison** (`ensureOn()`):

1. Read the count before clicking, `n1` (if the element is missing, skip).
2. Click, then read `n2`.
3. `n2 > n1` → it is now on; return true.
4. `n2 === n1` → nothing observable changed; we cannot decide; return false (**do not** treat as success).
5. `n2 < n1` → it was already on and this click turned it off → **click once more** and read `n3`;
   only `n3 > n2` counts as restored.

Note the last case is easy to get wrong: after the corrective click the count merely returns to
its **original** value (`n3 === n1`), so the test must be "larger than just before the corrective
click", not "larger than the very first reading".

## 7. Modals and overlays swallow the submit click

A dialog with a backdrop (`z-50`, `data-state="open"` — the radix-ui pattern) sits above the
submit button and eats the click.

**Fix:** `dismissModals()` first, using safe labels (close / cancel / got it / later), then
submit. If it still fails, use a DOM click to bypass pointer interception — `clickByText()` does
this as a fallback.

## 8. A screenshot must actually contain the target content

A full-page screenshot does not solve "the content has not rendered yet". Scroll through the page
first (`scrollFull()`) to trigger lazy loading, then bring the target node into view with
`scrollIntoView({ block: 'center' })`.

Also: **verify the screenshot is a fresh frame**, not a cached/stale one. A cheap test: change the
background color, take a second screenshot, and compare the bytes — identical bytes means the
frame is stale.

## 9. Clicking by text: do not hit the wrapping container

`innerText.includes(text)` matches the **div that wraps the button** first (the parent comes
earlier in document order). The click then lands on empty space inside the container — and it
**does not error**.

**Fix** (the ordering inside `clickText()`): exact text > interactive tag
(`button/a/[role=button]/…`) > deeper DOM node. Highest score wins.

## 10. Only one task in progress at a time

Common on workflow sites: if a task is already in an unfinished state, visiting the
"claim / create" entry point returns **the same** task instead of a new one. Finish or cancel the
current one first. And when a task is already open, reuse that detail page — opening another may
land on the same task, or trigger a duplicate submission.

## 11. Short links redirect — match on the final domain

Shared short links (`bit.ly`, a company's own short domain, …) almost always 302 to the main
domain. Matching tabs against the original short link fails, because after navigation
`location.href` is already the redirected address. Match the **final** domain, or `goto()` and
wait for the URL to settle first.

Related structural gotcha: comment boxes are often `contenteditable`, not `textarea`. Their
`value` is always empty — read content from `innerText` / `textContent`, and type with
`Input.insertText` or real key events rather than assigning a value.

## 12. Locate tabs by URL, never by position

Tab order changes (the user opens and closes tabs constantly). Locate by URL substring, or use a
target-id prefix from the CLI. Also: **do not run two CDP tools against the same Chrome** —
sessions and authorisations interfere.

## 13. Never click during a handoff

While the human is typing a password or scanning a code, any click from the agent can interrupt
the input or submit something unintended. `waitForHuman()` polls with `evaluate` only — **no
clicks, no navigation, no focus stealing**. Likewise, **do not read password field values**.

## 14. Chrome restart means re-authorising

The daemon exits when it detects the CDP connection closing (deliberately — it refuses to sit on
a dead endpoint). The next command starts a new daemon, and Chrome will ask for authorisation
again. Do not auto-click that prompt: it is Chrome's security confirmation.

## 15. After navigating, verify the URL — do not trust `readyState` alone

Immediately after creating a tab, reading `document.readyState` returns the **initial blank
document's** `complete`. It looks "loaded" while the page is still `about:blank`, and every
subsequent read comes back empty. (Hit for real: right after `open`, the first probe reported
`href=about:blank` and looked like a navigation failure.)

**Fix:** decide navigation success on whether `location.href` is the target URL, not on
`readyState`. `navigate()` / `goto()` poll `readyState` internally, so still re-check
`page.url()` after calling them.

## 16. Modern React/MUI dashboards need an explicit trigger

Plenty of dashboards open a stats page showing only the filter form and **no results table**: the
data is fetched when you press something like `APPLY`. Do not equate "page loaded" with "data is
ready" — check that the result region actually has content (e.g. `document.body.innerText.length`
grew, or the target table selector appeared) before deciding whether to click.

Also, these dashboards use MUI's custom components rather than native
`<input type="date">`; assigning `value` does nothing. Either use real clicks/typing (this
skill's Input primitives), or keep the default range and pick the row you need out of the results
(for example, group by DATE and read the day you care about).
