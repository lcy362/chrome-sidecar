# Demo

Two things are worth showing: what this looks like from your side, and the evidence behind the
main claim — that it never takes your focus.

## 1. From your side

You ask for something; the interesting part is what happens when it needs you. This is a real
message from a real run:

```console
⏸ Manual step needed: finish it in this Chrome tab (login / verification code / QR scan /
  payment confirmation), then tell me and I will continue. The agent will not fill in credentials.
▶ human step finished (waited 42s), resuming
```

While that is on screen the agent is doing nothing but polling the page, read-only. It is not
clicking, not navigating, and not bringing the tab forward — so your typing is never interrupted.

If you want a starting point, ask for something small and concrete: read yesterday's revenue out of
a dashboard, fix a paragraph in a saved draft, check whether an order shipped, or open a settings
page and report whether two-factor is on. The agent works out the rest; there is no command syntax
for you to learn. See [Using it](../README.md#using-it) for the full picture.

## 2. Evidence: your foreground never moves

The headline claim is easy to make and easy to fake, so it is measured from **outside** the tool.
`selftest.mjs` reads Chrome's *own* active tab (via AppleScript on macOS) before and after the run,
and asserts the fingerprint is unchanged.

`document.visibilityState` cannot be used for this check: focus emulation makes the target page
report `visible` about itself no matter what, so the page's own opinion is worthless here. You need
an external observation of the browser's state — which is why the test shells out to AppleScript.

Every operation in the self-test happens in a background tab. The assertion is the last line:

```console
  ✓ the user foreground tab was never taken  len=139 hash=f052a60e → len=139 hash=f052a60e
```

## 3. The self-test in full

It never touches a website or the network — it drives a throwaway `data:` URL page opened in a
background tab.

```console
$ npm test
chrome-sidecar selftest  (node v24.14.0 / darwin)

== A. Offline checks ==
  ✓ parsePortFile reads port and ws path  port=9333 path=/devtools/browser/abc-def
  ✓ parsePortFile throws on a malformed file
  ✓ candidate port-file list is non-empty  26 entries
  ✓ macOS candidate is Google/Chrome (two levels)  /Users/…/Application Support/Google/Chrome/DevToolsActivePort
  ✓ no candidate uses the malformed "Google Chrome/DevToolsActivePort" form
  ✓ shuffle changes the order
  ✓ shuffle keeps every element
  ✓ file exists: files/cdp-core.mjs
  ✓ file exists: files/cdp-daemon.mjs
  ✓ file exists: files/browser.mjs
  ✓ file exists: scripts/cdp.mjs

== B. Online checks (background tab, no focus stealing) ==
  ✓ evaluate works in a background tab
  ✓ the new tab was created in the background
  Like before click: 13
  Like after click: 12
  ⚠ Like was on and got toggled off; clicking again…
  Like after corrective click: 13
  ✓ Like restored to on (12 → 13)
  ✓ ensureOn restores a toggle that got switched off  final count=13 Like
  ✓ dismissModals closes an overlay modal
  file set; polling for the upload preview…
   [0] files=1 preview=1 uploading=false done=false
  ✓ uploadAndVerify polls until a real preview appears
  ✓ clickByText hits the button, not the wrapping container
  ✓ scrollFull (Node-driven) reaches deep into the document  rounds=7
screenshot: /var/folders/…/cdp-selftest-shot-88814.png (97 KB, 2880x7370)
  ✓ full-page screenshot is written and non-empty
  ✓ detectHumanNeeded spots a login wall
  ⏸ Manual step needed: finish it in this Chrome tab (login / verification code / QR scan /
    payment confirmation), then tell me and I will continue. The agent will not fill in credentials.
  ▶ human step finished (waited 0s), resuming
  ✓ waitForHuman resumes once the human step is done
  ✓ humanClick / humanScroll run (real input works in a background tab)
  ✓ temporary tab cleaned up
  ✓ the user foreground tab was never taken  len=139 hash=f052a60e → len=139 hash=f052a60e

=== selftest: 24/24 passed ===
```

Two lines are worth reading closely:

- **The `ensureOn` sequence.** The toggle was already on, so the first click switched it *off*; the
  helper noticed the count went down and clicked once more. A naive click would have silently
  un-liked the post.
- **The last line.** Everything above happened in a background tab, and the user's foreground never
  moved.

Both halves of that run are local (`npm test`; `npm run test:offline` skips the Chrome half). The
online half is skipped — not silently passed — when no authorised Chrome is available, and on
non-macOS platforms the foreground assertion is skipped for the same reason and says so.

> A screencast would show this better than text. If you record one, please open a PR — and include
> the Chrome tab strip in the frame, because the whole point is that the active tab never changes.
