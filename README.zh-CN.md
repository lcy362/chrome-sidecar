# chrome-sidecar

**面向 AI agent 的 Chrome 技能——让你的 agent 在你自己的 Chrome 里有双手，又不抢方向盘。**

`chrome-sidecar` 是一个 [agent skill](https://github.com/pasky/chrome-cdp-skill) 形态的工具集，驱动你**正在使用的那一份** Chrome：你的配置目录、你的标签页、你的登录态。它在**后台标签**里工作，所以从不抢走你的焦点；它用**真实鼠标与键盘事件**，所以不会在反机器人启发式面前露馅；当屏幕上出现密码框或验证码时，它**把控制权交还给你**。

它以单个 `SKILL.md` 目录的形式发布，因此任何读取 skill 的 agent 都能直接用——Claude Code、Cursor、Codex、Gemini CLI 皆可；安装可以走 [flint](https://github.com/lcy362/flint)，也可以直接拷这一个目录。

零运行时依赖，只需 Node 22+。

```
┌─ 其他工具的做法 ──────────────────────────────────┐   ┌─ 本项目的做法 ────────────────────────────┐
│                                                   │   │                                           │
│  抢走你的前台标签                                  │   │  在后台标签里操作                          │
│  或退化成 DOM el.click()（没有 isTrusted）         │   │  真实 Input 事件，且仍在后台                │
│  或默默替你填掉密码                                │   │  该你上时停下来交给你                       │
│                                                   │   │                                           │
└───────────────────────────────────────────────────┘   └───────────────────────────────────────────┘
```

📖 [English](README.md) · [docs/zh-CN](docs/zh-CN) —— 面向 agent 的 `SKILL.md` 与 `references/` 以英文发布，原始中文文档保留在 `docs/zh-CN/`。

---

## 什么算「Chrome 技能」

**Chrome 技能**指的是：让 agent 去**操作**真实 Chrome 的 skill——点击、输入、上传、提交、读取登录后的后台——而不是仅仅抓一个公开页面。`chrome-sidecar` 就是其中之一，而且刻意收得很窄：

| 你的需求 | 该用什么 |
|---|---|
| 读取一个公开页面 | 普通网页抓取。不需要在任何人的浏览器上开调试端口 |
| 从零自动化某个站点、跑在 CI 里 | Playwright / Puppeteer + 一次性浏览器 |
| 在人已经登录的那份 Chrome 里操作 | **本项目**——在已经开着的那个浏览器里新开一个后台标签 |

同一件事还有别的叫法：Chrome CDP 技能、浏览器自动化技能、Claude Chrome 技能、"让 agent 用我的浏览器"——说的都是同一层：对一个**人也在同时使用**的浏览器做协议级控制。而这恰好是下文那些朴素实现翻车的地方。

## 为什么做这个

把 agent 连到你的真实 Chrome 上，这件事本身早就被解决了。**"做得不烦人、并且不撒谎说自己是谁"** 没有被解决。

读取你已登录会话里的页面，只读的话还行。一旦要**操作**，就难看了——因为朴素实现只能二选一：

| 朴素做法 | 代价 |
|---|---|
| 把目标标签调到前台再点击 | 每次都在劫持你的前台。你正在输的东西丢了 |
| 留在后台，但用 `document.querySelector(sel).click()` 点 | 没有 `isTrusted`、没有指针轨迹、没有时序抖动，而且某些框架根本不认合成点击 |
| 复用你的登录态，顺手把密码也填了 | 凭据落到了 agent 手里，而且你不知道它现在走到哪一步 |

`chrome-sidecar` 三个都不选。它既留在后台，又保持输入真实，然后在登录墙前停下，把键盘交给你。

## 环境要求

- Node.js **22+**（使用内置 `WebSocket`）
- Chrome / Chromium / Brave / Edge，正常启动，且已打开 `chrome://inspect` 开关
- 其他都不需要。不用 Playwright、不用 Puppeteer、不用 npm install。

## 安装这个 Chrome 技能

**1. 在你正常使用的 Chrome 里开启远程调试**

打开 `chrome://inspect/#remote-debugging`，勾选 **"Allow remote debugging for this browser instance"**。你的配置目录里会出现 `DevToolsActivePort` 文件——端点就是从这里发现的。

客户端接入时 Chrome 会弹出确认框（"要允许远程调试吗？"）。**那个弹窗就是安全边界，绝不要用工具把它自动点掉。**

**2. 把技能放到你的 agent 读取 skills 的位置**

推荐用 **[flint](https://github.com/lcy362/flint)** 管理——一个本地优先的技能资产管理器。你只维护一份技能目录作为唯一事实源，flint 通过预设把它们分发到你用的各个 agent（Claude Code、Cursor、Codex……），改一处、处处同步。全部本地：磁盘上就是普通的 `SKILL.md` 目录，没有账号、没有遥测。

```bash
git clone https://github.com/lcy362/chrome-sidecar
npx flint-skills-hub      # 或：npm install -g flint-skills-hub && flint
```

它会打开 <http://localhost:8787> 的界面。把这个仓库注册进去，把 `chrome-sidecar` 放进一个预设，再应用到你要用的 agent 上——flint 会把技能软链或复制到它们的 skills 目录。

想手动来？同样先 clone，然后自己拷：

```bash
cp -R chrome-sidecar/skills/chrome-sidecar ~/.claude/skills/     # 或你所用 agent 的 skills 目录
```

**3. 验证装好了**

没有东西需要你启动。技能自带一个只读的安装自检，装完跑一次：

```bash
cd chrome-sidecar/skills/chrome-sidecar/scripts && node cdp.mjs demo
```

它会在**后台标签**里打开本仓库地址，读回页面内容并截图，逐步打印自己做了什么。跑的时候盯着你自己的标签——它不应该移动。

这是默认目标。如果你更想拿自己真正在用的页面看效果——你的后台、那个你每天开的站——把它的 URL 传进去即可，其余规则不变：

```bash
node cdp.mjs demo <你在意的那个页面的 URL>
```

两种情况都是同一套只读检查，而且下面那两个请求始终指向本项目，**不指向被检查的那个页面**。

你也可以整个跳过——它是一道检查，不是一道关卡。第 4 步不依赖它；如果你是来做事的，你自己的任务就是更好的证明。

**它刻意不去点 star 按钮。** 那一下留给你自己点，而这正是全部设计的要点——技能在边界处停下，而不是替你做主。

所以只有两个请求，也是这个工具唯一会对你提的请求：

- **如果它确实好用，欢迎点个 star。**
- **如果它坏了——或者你在 Linux / Windows 上，能说一句跑不跑得起来——欢迎开 issue。** 不管验证结果是能跑还是不能跑，都是目前最有价值的贡献：<https://github.com/lcy362/chrome-sidecar/issues>

**4. 让 agent 去做一件事**

第 3 步是在你的终端里跑的。另一半——agent 自己判断该用这个技能——只有你用自己的话说一件真事才能验证，而且要落在你真正会用的页面上。「怎么用它」下面有例子。

这里刻意不放一个一次性测试页：链路第 3 步已经证明过了，只有你自己的真实任务才能说明它在实际用法下是否成立。

你当前的活动标签不应该发生移动。

## 怎么用它

你不需要自己操作浏览器。你用自然语言跟 agent 说，而这个技能负责告诉 agent 在你的 Chrome 里该怎么行事：在后台标签里干活、绝不抢你的焦点、用真实输入事件、需要你的时候停下来交接。

可以这样说：

> 打开我的广告后台，告诉我昨天的收入。

> 把草稿第二段改一下，然后保存。

> 看看那个订单发货了没，发了就把单号发到支持帖里。

> 把定价页截个图，放进我的笔记。

> 给我的账号开双因子——出二维码的时候交给我。

它干活时你该看到的：

- 它在**后台标签**里打开页面。你的活动标签不会移动，你正在输入的东西也不会被打断。
- 一旦遇到登录、验证码、扫码或支付确认，它会**停下来告诉你**，然后只读地等着——不点击——直到你说完成。
- 它不会替你输密码、不会读取密码字段、也不会向你要凭据。
- 做不完就如实说卡在哪一步，而不是硬猜。

技术面——API、命令行前端、以及修改任一部分的约定——都在
[`skills/chrome-sidecar/SKILL.md`](skills/chrome-sidecar/SKILL.md)（你的 agent 会自己读）
与 [AGENTS.md](AGENTS.md)（贡献者从这看起）。

## 差异点

### 1. 后台操作，但不是残缺的后台

Chrome 对后台标签限流很凶：`setInterval(16ms)` 实际只有约 1 Hz 次，`requestAnimationFrame` 完全停止，还有最阴的一条——`Input.dispatchMouseEvent` **永远不返回 ack**（会卡住好几秒，但事件**其实已经送达**；此时若当成失败去重试，就会重复点击）。

两个 CDP 调用就能修好，而且完全不碰前台：

```js
await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sid);
await cdp.send('Page.setWebLifecycleState', { state: 'active' }, sid);
```

后台标签实测（Chrome 154 / macOS / DPR 2）：

| 指标 | 之前 | 之后 |
|---|---|---|
| `setInterval(16ms)` 每秒次数 | 2 | **63** |
| `requestAnimationFrame` 每秒回调 | **0** | **61** |
| `Input.dispatchMouseEvent` ack | **卡住（>5 秒）** | **8–18 ms** |
| `dispatchKeyEvent` / `insertText` | — | 4 ms / 1 ms |
| **你的前台标签** | — | **始终未变** |

最后一行不是声称，是独立验证的：测试在操作前后、以及静置 25 秒后，用 AppleScript 读取 Chrome 自身的活动标签做比对。`document.visibilityState` 对这件事**没有用**——伪聚焦会让目标页以为自己可见。

### 2. 人机交接协议，而不只是一堆命令

多数工具丢给你 14 个原语就完事。这个额外定义了**什么时候该停**：

- **必须停下交接**：登录 / 注册、短信或邮箱验证码、扫码登录、双因子、人机验证、支付或 OAuth 二次确认，以及任何需要凭据的字段。**文件上传不在其列**——用 `setInputFiles` 直接驱动 `input[type=file]`，它就是一个普通表单字段（仅在应用明确拒收程序化上传时才交接）。
- **绝不做**：代填用户名 / 密码 / 验证码，读取 password 字段的值，猜验证码，或在人操作期间点击。
- **`waitForHuman(page)`**：只读轮询（不点击、不导航、不抢前台），默认超时给得很宽，恢复前会再确认一次登录墙确实消失了。

### 3. 策略层：把任务做**对**，而不是"能下命令"

"我能点击"和"我提交成功了"之间隔着一堆小事：

- `ensureOn()` —— 用**数字比较**判断开关态，而不是 `className`。SPA 的 class 会撒谎，而且点一个本来就开着的开关会把它**关掉**；这个 helper 会发现计数掉了然后补点回来。
- **reload 金标准**判成功 —— 提交后 reload，确认按钮**消失了**。模板里的状态词（"待审核"之类）常年挂在侧边栏，会给出假阳性。
- `uploadAndVerify()` —— `setInputFiles` 立刻返回但上传是异步的；过早提交会**静默无效**。要轮询到真实预览出现。
- `dismissModals()` / `clickByText()` —— 遮罩会吞掉指针事件，有 DOM 点击兜底。
- `scrollFull()` —— Node 侧驱动滚动，同时触发懒加载。

### 4. 在"后台"这个约束下依然成立的反检测

用你的真实 Chrome 本身就已经拿到了真指纹。剩下的暴露面是**行为时序**：`randWait`、`humanClick`（贝塞尔轨迹 + 减速接近 + 微调）、`humanScroll`（变速、随机停顿、偶尔回滚）、`preRead`（先阅读再互动）、`shuffle`（打乱动作顺序）。

这些全部由 Node 侧驱动（因为上文的后台节流），而且因为后台输入可用，你**不必**在"礼貌"和"像人"之间二选一。

---

## 安全与隐私

这个工具驱动的会话能读到你所登录的一切。请按这个分量对待它。

- **授权是显式的、按连接的。** 客户端接入时 Chrome 会弹确认框。不要写脚本绕过它。
- **仅本机。** daemon 监听 UNIX socket（`0600`）或 Windows 的按用户命名管道，不暴露到网络。
- **永不接触凭据。** 技能被明确要求：不输入、不读取密码、验证码、卡号，而是交接给人。请自行审阅这条指令后再依赖它。
- **数据不出本机。** 没有遥测、没有远端接口、没有埋点。
- **同一时间只允许一个驱动方。** 不要让两套 CDP 工具（例如另一个 MCP server）连同一个 Chrome，会话与授权会互相干扰。
- **只用在你自己的账号上。** 它是为了让 agent 替你完成工作中的重复部分，不是用来批量养号或绕过平台限制。

## 演示

想要 10 秒版就运行 `node cdp.mjs demo`——就是第 3 步那个只读安装自检。

完整自测是 `npm test`（`scripts/selftest.mjs`）：在后台标签里驱动一个一次性的 `data:` URL 页面——不碰任何站点、不走网络。完整运行结果，以及"从不抢前台"这一说法的外部证据，都在 **[docs/demo.md](docs/demo.md)**。最关键是这一行断言：

```console
  ✓ the user foreground tab was never taken  len=139 hash=f052a60e → len=139 hash=f052a60e
```

`ensureOn` 的那段才值得细读：那个开关**本来就是开着的**，所以第一次点击把它关掉了，helper 发现计数下降后补点恢复。

## 平台支持

| 平台 | 状态 |
|---|---|
| macOS | 已测试（Chrome 154）。端口发现、UNIX socket daemon、基于 AppleScript 的非侵入性验证 |
| Linux | 端口发现已实现（含 Flatpak 路径），**未在真机验证** |
| Windows | **已实现但未验证**：端口发现走 `%LOCALAPPDATA%`，daemon 走按用户命名管道。需要有 Windows 机器的人确认 |

`selftest.mjs` 里的"前台未被抢"验证仅在 macOS 可用（它读 Chrome 的活动标签来证明没有跳转）。其他平台上这一项会**显式跳过**，而不是默默当作通过。

## 参考与致谢（Prior art）

**连接层**的设计参考了 [pasky/chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill)（MIT）：通过 `DevToolsActivePort` 发现端点、把端点收敛到一个常驻 daemon 并通过本地 socket 通信、用最短唯一前缀寻址标签、以及紧凑的无障碍树快照。这些是好设计，但不是我们的。

本项目**不是它的 fork**——代码为独立实现——而管道层之上的部分是本项目原创的：非侵入式后台操作、人机交接协议、任务级策略 helper、行为反检测层。

### 差异对照

| | chrome-cdp-skill | chrome-sidecar |
|---|---|---|
| 连接 | **每个标签**一个 daemon → 每个标签一次授权 | 单 daemon 管所有标签 → 每次 Chrome 启动一次授权 |
| 后台标签响应能力 | 未处理 | 伪聚焦 + 页面激活（见上文实测） |
| 点击 | DOM `el.click()`；真实事件要用 `clickxy` | 默认真实 Input 事件，失败回退 DOM |
| 新建标签 | 前台 | `background: true`，永不抢焦点 |
| 截图 | 仅视口 | 整页（`captureBeyondViewport`）或视口 |
| 任务级正确性 | 无，14 个原语 | `ensureOn`、`uploadAndVerify`、`dismissModals`、reload 判成功 |
| 人机交接 | 无 | 停下条件 + `waitForHuman` |
| 反检测 | 无 | 时序、指针轨迹、滚动、阅读行为 |
| 体量 | 单文件 32 KB | 四个模块 |
| 平台覆盖 | macOS / Linux / Windows / Flatpak | macOS 已验证；Linux / Windows 已实现未验证 |

如果你只是想要最小的工具去捅一下页面，**直接用他那个**。如果你要 agent 在你的浏览器里把一件事办完、而且要既不烦人也不担责，这个走得更远。

## 仓库结构

```
skills/chrome-sidecar/
├─ SKILL.md                  agent 入口（是什么 / 怎么做 / 交接规则）
├─ files/cdp-core.mjs        端口发现 + 原生 CDP 原语
├─ files/cdp-daemon.mjs      常驻单连接、自动启动、后台标签激活
├─ files/browser.mjs         Page 封装 + 策略 helper + 交接 + 反检测
├─ scripts/cdp.mjs           CLI 前端
├─ scripts/selftest.mjs      离线 + 联机自测
└─ references/               connect.md · pitfalls.md · anti-detection.md
docs/zh-CN/                  同一套文档的中文版
```

根目录：`README.md`（英文）、`README.zh-CN.md`（本文）、`AGENTS.md`、`LICENSE`（MIT）、`package.json`。

## 参与贡献

当前最有价值的贡献：**在 Linux 和 Windows 上验证**端口发现与 daemon，以及把 `SKILL.md` / `references/` 翻译成英文与中文以外的语言。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
