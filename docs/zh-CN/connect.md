# 连接你正常使用的 Chrome

## 1. 为什么不能再靠 `--remote-debugging-port`

Chrome 官方博客（2025-03-17）明确：**从 Chrome 136 起**，若 `--remote-debugging-port` /
`--remote-debugging-pipe` 指向**默认数据目录**，这两个开关会被**静默忽略**——Chrome 正常启动、
端口永远不开。原因是攻击者用远程调试口批量窃取 Cookie（配合 App-Bound Encryption 的加固背景）。
官方建议：自带非标准 `--user-data-dir`，或用 Chrome for Testing。

所以"用 `--user-data-dir` 复制一份 profile 出来调"是**限制的规避**；
而我们要的是**在用户正常浏览器的默认配置目录上工作**，走的是下面这条官方同意路径。

## 2. 正确路径：`chrome://inspect` 授权开关

在**用户正常打开的 Chrome**里：

```
地址栏输入 chrome://inspect/#remote-debugging
勾选 "Allow remote debugging for this browser instance"
```

勾选后 Chrome 会起一个调试服务，并把端口与 ws 路径写入配置目录下的 `DevToolsActivePort`：

```
<user-data-dir>/DevToolsActivePort
  第 1 行：端口号
  第 2 行：/devtools/browser/<uuid>
```

- macOS 默认路径：`~/Library/Application Support/Google/Chrome/DevToolsActivePort`
- 端口是**由 Chrome 自动分配**的，不是固定 9222，所以必须读文件发现。
- 若浏览器把它写在非标准位置，用环境变量 `CDP_PORT_FILE` 指定完整路径。
- 预期该开关在 **Chrome 重启后需要重新勾选**（请以你自己版本实测为准）；勾选状态变了，
  `DevToolsActivePort` 也会随之更新或消失。

`cdp-core.mjs` 的 `resolvePort()` 会按序探测多个浏览器（Chrome / Chromium / Brave / Edge 等）
在 macOS / Linux / Windows 下的候选路径，找不到时抛出带指引的错误（而不是自作主张去启动副本浏览器）。

## 3. 授权弹窗的粒度 —— 为什么必须有 daemon

外部客户端接入时，Chrome 弹一次「**要允许远程调试吗？**」。

**它的粒度是「每个连接 / attach 会话」，不是每个标签、也不是固定时长。**

这条决定架构：

- 如果每次跑脚本各自 `connect` 一次 → **每跑一次脚本弹一次**，agent 迭代五次就弹五次。
- 所以本技能用**一个常驻 daemon 持有唯一长连接**，把弹窗压到
  「每次 Chrome 启动后一次」。

```
CLI / 库  ──(UNIX socket, NDJSON)──▶  daemon  ──(唯一 WebSocket)──▶  Chrome
```

daemon 才是长连接；CLI/库的每次调用都是短连接，跑完即退，不影响 daemon 存活。

### daemon 生命周期

| 退出路径 | 触发 |
|---|---|
| 空闲回收 | 默认 **4 小时**无请求（`CDP_IDLE_TTL_MS`）。刻意给足——要等人输密码/扫码 |
| Chrome 断开 | 用户重启/退出 Chrome → `CDP` 连接关闭 → daemon 自杀 |
| 显式停止 | `node scripts/cdp.mjs daemon stop`、`SIGTERM`、`SIGINT` |
| 目标关闭 | 只是清理会话注册表，不退出 |

Chrome 重启后 daemon 已死，下一条命令会自动拉起新 daemon，届时需要重新授权一次。

### 运行期文件

| 路径 | 说明 |
|---|---|
| `~/.cache/cdp-browser-automation/cdp.sock` | UNIX socket，权限 `0600`，目录 `0700`（`umask 077`） |
| `~/.cache/cdp-browser-automation/daemon.json` | 当前 daemon 的 pid / 浏览器版本 / 端点来源 |
| `~/.cache/cdp-browser-automation/daemon.log` | daemon 日志（排障先看这里） |

## 4. 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `CDP_PORT_FILE` | 自动探测 | 指定 `DevToolsActivePort` 的完整路径 |
| `CDP_HOST` | `127.0.0.1` | 调试端点主机 |
| `CDP_TIMEOUT` | `15000` | 单条 CDP 命令超时（ms） |
| `CDP_IDLE_TTL_MS` | `14400000` | daemon 空闲回收（ms），4 小时 |
| `CDP_RUNTIME_DIR` | `~/.cache/cdp-browser-automation` | socket / 状态 / 日志目录 |
| `CDP_NO_ACTIVATE` | 未设置 | 设为 `1` 则不对标签施加「伪聚焦 + 页面激活」 |
| `CDP_DAEMON_RETRIES` | `40` | 等待 daemon 就绪的重试次数（×150ms） |

## 5. 故障排查

| 现象 | 原因与处理 |
|---|---|
| `未找到 Chrome 调试端口` | 开关没勾 / Chrome 重启后失效。去 `chrome://inspect/#remote-debugging` 勾选后重试 |
| `daemon 启动失败` | 看输出里的日志尾部。最常见的两种：开关没勾（起不来服务）、弹窗没点「允许」（连上了但 attach 被拒） |
| 命令超时 `Input.dispatchMouseEvent` | 目标标签未被激活，输入 ack 被拖住。正常流程会自动激活；若你设了 `CDP_NO_ACTIVATE=1`，改用 `via:'dom'` 点击 |
| 操作生效了但命令报超时 | 同上：**事件已送达、ack 迟到**。不要盲目重试，否则会重复点击 |
| daemon 反复重启 | Chrome 不稳定或调试端口被其它工具抢占（例如另一个 MCP 也在连同一端口） |
| 页面行为异常（如恒为「可见」） | 那是伪聚焦的正常副作用，见 `pitfalls.md` |

## 6. 验证「没有抢用户前台」的独立方法

`document.visibilityState` **不能**用来判断（伪聚焦会让目标页自身恒为 `visible`）。
用浏览器自身状态做外部观测才可靠——macOS 上可以读 Chrome 当前活动标签：

```bash
osascript -e 'tell application "Google Chrome" to get (URL of active tab of front window) & "|" & (title of active tab of front window)'
```

操作前后各取一次比对即可。首次使用会要求授予「自动化」权限。
（Windows / Linux 可用窗口管理器查询或直接问用户。）

## 7. 从 1.x 迁移

| 1.x 做法 | 2.0 做法 |
|---|---|
| `ditto` 复制 profile 到 `~/ChromeData` | **不再复制**，直接用默认配置目录 |
| `open -a "Google Chrome" --args --user-data-dir=... --remote-debugging-port=9222` | 用户正常打开 Chrome，勾一次 `chrome://inspect` 开关 |
| 每次脚本 `chromium.connectOverCDP('http://127.0.0.1:9222')` | 经 daemon 长连接；脚本不再自己连 |
| `require('playwright')` + 自动缓存安装 | **零依赖**，Node 22+ 内置 WebSocket；可删掉 `~/.cache/cdp-browser-automation/node_modules` |
| `const {browser, ctx} = await connectCDP(); ctx.pages()` | `const {findPage, newPage} = await connectCDP()`；`page` 就是标签本身 |
| `await browser.close()` | 无需操作；daemon 与浏览器继续存活 |

**不要在同一个 Chrome 上同时跑两套 CDP 工具**（例如某个 MCP 也连着同一端口），
会话/授权会互相干扰。
