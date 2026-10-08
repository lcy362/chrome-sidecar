# Connecting to the Chrome you actually use

## 1. Why `--remote-debugging-port` is no longer the way

Chrome's official blog (2025-03-17) states that **from Chrome 136**, if
`--remote-debugging-port` / `--remote-debugging-pipe` point at the **default data directory**,
both flags are **silently ignored** — Chrome starts normally and the port never opens. The
reason is that attackers were using the remote debugging port to bulk-extract cookies (in the
context of App-Bound Encryption hardening). The official recommendations are a custom
`--user-data-dir` or Chrome for Testing.

So "copy the profile out and drive the copy" is a **workaround**. What we want — driving the
user's normal browser on its default profile — is served by a different, consented path.

## 2. The right path: the `chrome://inspect` toggle

In the **normally running** Chrome:

```
Open chrome://inspect/#remote-debugging
Tick "Allow remote debugging for this browser instance"
```

Chrome then starts a debugging server and writes the port and the WebSocket path into
`DevToolsActivePort` inside the profile directory:

```
<user-data-dir>/DevToolsActivePort
  line 1: the port
  line 2: /devtools/browser/<uuid>
```

- macOS default: `~/Library/Application Support/Google/Chrome/DevToolsActivePort`
  (note the two-level `Google/Chrome` — a common thing to get wrong)
- The port is **assigned by Chrome**, not fixed at 9222, so it must be discovered from the file.
- If your browser writes it somewhere non-standard, point `CDP_PORT_FILE` at the full path.
- Expect to re-tick the toggle **after a Chrome restart** (verify on your own version); when the
  toggle state changes, `DevToolsActivePort` appears or disappears with it.

`resolvePort()` in `cdp-core.mjs` probes candidates for Chrome / Chromium / Brave / Edge across
macOS, Linux (including Flatpak) and Windows. When it finds nothing it raises an error **with
instructions** — it will not go and launch a copy of your browser behind your back.

## 3. Authorisation granularity — why a daemon is mandatory

When a client connects, Chrome shows an **"Allow debugging?"** prompt.

**Its granularity is per connection / per attach session** — not per tab, not per time window.

That single fact decides the architecture:

- If every script connects on its own → **you get a prompt per script run**. Five iterations of
  debugging means five prompts.
- So this project keeps **one persistent daemon holding one long-lived connection**, which
  reduces the prompt to **once per Chrome start**.

```
CLI / library  ──(local socket, NDJSON)──▶  daemon  ──(single WebSocket)──▶  Chrome
```

The daemon owns the long connection. Every CLI/library call is a short-lived connection that
does not affect the daemon's lifetime.

### Daemon lifecycle

| Exit path | Trigger |
|---|---|
| Idle reaping | no request for **4 hours** by default (`CDP_IDLE_TTL_MS`). Deliberately generous — the human may be fetching a code from their phone |
| Chrome goes away | the CDP connection closes (user restarted Chrome) → daemon exits |
| Explicit stop | `node scripts/cdp.mjs daemon stop`, `SIGTERM`, `SIGINT` |
| Target closed | only the session registry is cleaned up; the daemon stays |

After a Chrome restart the daemon is gone; the next command starts a new one, and Chrome will ask
for authorisation again.

### Runtime files

| Path | Purpose |
|---|---|
| `~/.cache/cdp-browser-automation/cdp.sock` | UNIX socket, mode `0600`, directory `0700` (`umask 077`). On Windows: a per-user named pipe, `\\.\pipe\cdp-browser-automation-<user>` |
| `~/.cache/cdp-browser-automation/daemon.json` | current daemon pid / browser version / endpoint source |
| `~/.cache/cdp-browser-automation/daemon.log` | daemon log — look here first when debugging |

## 4. Environment variables

| Variable | Default | Effect |
|---|---|---|
| `CDP_PORT_FILE` | auto-discovered | full path to `DevToolsActivePort` |
| `CDP_HOST` | `127.0.0.1` | debugging endpoint host |
| `CDP_TIMEOUT` | `15000` | per-command timeout (ms) |
| `CDP_CONNECT_TIMEOUT_MS` | `120000` | WebSocket handshake timeout |
| `CDP_AUTH_TIMEOUT_MS` | `120000` | how long to wait for the user to authorise |
| `CDP_IDLE_TTL_MS` | `14400000` | daemon idle reaping (ms) |
| `CDP_RUNTIME_DIR` | `~/.cache/cdp-browser-automation` | where socket / state / log live |
| `CDP_NO_ACTIVATE` | unset | set to `1` to skip the focus-emulation + lifecycle activation |
| `CDP_DAEMON_RETRIES` | `40` | retries while waiting for the daemon socket (×150 ms) |

## 5. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `could not find a Chrome debugging port` | Toggle not ticked, or reset by a Chrome restart. Tick it at `chrome://inspect/#remote-debugging` and retry |
| `daemon failed to start` | Read the log tail in the error output. Usually: toggle not ticked, or the "Allow debugging?" prompt was never accepted |
| `Timeout: Input.dispatchMouseEvent` | The target tab was never activated, so input acks stall. Normal flow activates automatically; if you set `CDP_NO_ACTIVATE=1`, use `via:'dom'` clicks instead |
| The action worked but the command reported a timeout | Same root cause: **the event was delivered, the ack was late.** Do not blindly retry — you will double-click |
| Daemon keeps restarting | Chrome is unstable, or another tool (e.g. a different MCP server) is fighting for the same port |
| The page behaves oddly (always reports "visible") | That is the expected side effect of focus emulation — see `pitfalls.md` #3 |

## 6. Verifying "the user's foreground was not touched" independently

`document.visibilityState` **cannot** be used for this: focus emulation makes the target page
report `visible` regardless. You need an external observation of the browser's own state. On
macOS you can read Chrome's active tab:

```bash
osascript -e 'tell application "Google Chrome" to get (URL of active tab of front window) & "|" & (title of active tab of front window)'
```

Take it before and after and compare. The first use will ask for Automation permission.
On Windows/Linux, query the window manager or simply ask the user.

`scripts/selftest.mjs` does exactly this and asserts the fingerprint is unchanged.

## 7. If you are currently driving a copied profile

| Copied-profile workaround | This project |
|---|---|
| `ditto` / `cp -R` the profile to another directory | no copy — the default profile is used directly |
| launch Chrome with `--user-data-dir=… --remote-debugging-port=9222` | the user launches Chrome normally and ticks the `chrome://inspect` toggle once |
| each script calls `chromium.connectOverCDP('http://127.0.0.1:9222')` | the daemon holds one connection; scripts never connect themselves |
| Playwright / Puppeteer dependency | zero dependencies, Node 22+ built-in `WebSocket` |
| `await browser.close()` | nothing to do — the daemon and the browser stay alive |

**Do not run two CDP tools against the same Chrome** (for example another MCP server on the same
port). Sessions and authorisations will interfere with each other.
