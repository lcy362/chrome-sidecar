# Demo

These are real outputs, not mock-ups. Nothing here touches a website or the network: the
self-test drives a throwaway `data:` URL page opened in a **background** tab.

> A screencast/GIF would show this better than text. If you record one, please open a PR — and make
> sure the recording includes the Chrome tab strip, because the whole point is that the active tab
> never changes.

## 1. Self-test

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

Two things worth reading closely:

- **The `ensureOn` sequence.** The toggle was already on, so the first click switched it *off*; the
  helper noticed the count went down and clicked once more. A naive `page.click()` would have
  silently un-liked the post.
- **The last line.** The fingerprint is Chrome's *own* active tab, read via AppleScript before and
  after. Everything above happened in a background tab, and the user's foreground never moved.

## 2. The CLI, step by step

```console
$ node scripts/cdp.mjs daemon start
⏳ Connecting to Chrome… if Chrome shows "Allow debugging?", click Allow.
daemon: running  pid=86930
Chrome connection: established ✓
browser: Chrome/154.0.8037.98
endpoint source: /Users/lcy/Library/Application Support/Google/Chrome/DevToolsActivePort
idle reaping: 4.0 h

$ node scripts/cdp.mjs list
3 tabs:
 0  74D2465E  Some dashboard
 1  BBC9E44B  Repository search results
 2  60A0B6A8  Statistics @ Advert-network

$ node scripts/cdp.mjs open "https://example.com/report"
background tab: 4125782C  https://example.com/report
(created in the background; your current page is untouched)

$ node scripts/cdp.mjs snap 4125782C | head -4
  heading "Report"
  button "Export"

$ node scripts/cdp.mjs eval 4125782C "location.href"
https://example.com/report

$ node scripts/cdp.mjs shot 4125782C /tmp/report.png
/tmp/report.png  101 KB  2880x7416 (full page)
CSS px = image px / 2

$ node scripts/cdp.mjs click 4125782C ".like-wrapper"
clicked .like-wrapper

$ node scripts/cdp.mjs close 4125782C
closed 4125782C
```

Note what is *not* happening: no `bringToFront`, no window activation, no focus change. The `open`
line says it explicitly — the new tab is created in the background.

## 3. Handing over to a human

When a credential wall shows up, the agent stops instead of guessing:

```console
$ node scripts/cdp.mjs human 60A0B6A8
⏸ Manual step needed: finish it in this Chrome tab (login / verification code / QR scan /
  payment confirmation), then tell me and I will continue. The agent will not fill in credentials.
▶ human step finished (waited 42s), resuming
```

While it waits, the only thing running is a read-only poll. It does not click, does not navigate,
and does not bring the tab forward — so your typing is never interrupted.

## 4. Reproducing

```bash
npm test                                            # offline checks + background-tab integration
npm run test:offline                                # no Chrome needed
node skills/chrome-sidecar/scripts/selftest.mjs --require-chrome   # fail instead of skipping (CI)
```

The online half is skipped automatically (not silently passed) when no authorised Chrome is
available. On non-macOS platforms the final "foreground untouched" assertion is skipped for the
same reason, and says so.
