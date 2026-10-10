---
name: cdp-browser-automation
version: 2.0.0
description: 通过 Chrome DevTools Protocol 驱动用户**正在使用的正常 Chrome**（默认配置目录、已登录会话）完成网页内"操作类"任务：点击、点赞/收藏、评论、填表、上传截图、提交表单；或用户明确要求使用 CDP 时启用。全程在后台标签上操作，不抢前台、不打断用户，遇到登录/验证码/扫码/支付等场景自动把控制权交还给人再继续。不适用于一般的"访问/浏览公开网页"场景（仅查看、读取公开页面内容），那种情况应改用普通网页抓取或全新 Playwright 实例。
description_zh: 通用 CDP 浏览器自动化技能 v2。零依赖（Node 22+ 内置 WebSocket），直接接管用户正常打开的 Chrome——不需要复制配置目录、不需要专门开一个调试实例。用一个常驻 daemon 持有唯一长连接，把「允许调试」授权压到每次 Chrome 启动后一次。核心能力：①不抢前台（新标签后台创建；用 Emulation.setFocusEmulationEnabled + Page.setWebLifecycleState 让后台标签恢复前台级响应，实测定时器 1Hz→63Hz、输入 ack 超时→10ms，且用 AppleScript 验证用户前台标签始终未变）②业务级健壮性 helper（数字比较法状态检测、reload 金标准验证、异步上传轮询、弹窗消解、点击回退）③人机交接协议（waitForHuman + 必须停下的场景清单 + 绝不代填凭据）④反检测行为层（贝塞尔轨迹、变速滚动、先阅读再互动、动作乱序）。使用范围：①需要在浏览器里操作（点击/填写/上传/提交，或需借助已登录态避免重新登录/2FA）的场景；②用户明确要求用 CDP 的场景。不包含一般的"访问/浏览公开网页"（仅查看/读取公开页面内容）类场景，后者应改用普通网页抓取或全新 Playwright 实例。
---

# CDP Browser Automation

## 用途

驱动**用户正在使用的那一份正常 Chrome**：同一个窗口、同一个配置目录、同一套登录态。
不复制 profile、不另开调试实例、不要求用户改变浏览习惯。

**使用范围**：①需要在浏览器中进行操作（点击/填写/上传/提交，或需借助已登录态避免重新登录/2FA）的场景；②用户明确要求使用 CDP 的场景。无需用户特别声明"CDP"——这对该范围是隐含机制。

**不适用**：一般的"访问/浏览公开网页"场景（仅查看、读取公开页面内容），例如"看看这个网页说什么""抓取这个公开页面内容"。这种场景应改用普通网页抓取（WebFetch）或全新 Playwright 实例。

## 三条贯穿全技能的原则

1. **不抢前台**。用户可能在同一个 Chrome 里干活。新标签一律 `background` 创建；所有操作走 CDP，**任何情况下都不调用 `bringToFront` / `Target.activateTarget`**。实测确认：后台标签上 `evaluate` / 真实鼠标点击 / 真实按键 / 文件上传 / 截图（含整页）全部可用，且用户的前台标签不会被切换。
2. **Node 侧驱动**。后台标签的页面内定时器被节流到 ~1Hz、`requestAnimationFrame` 完全挂起。所以滚动、等待、轮询都由 Node 侧循环驱动，不放进页面里跑定时器。daemon 在附加标签时自动施加 `Emulation.setFocusEmulationEnabled` + `Page.setWebLifecycleState(active)` 把后台标签恢复到前台级响应（这是不抢前台又能用真实输入事件的关键）。
3. **该停下就停下**。遇到登录、验证码、扫码、支付确认等需要凭据的环节，**把控制权交还给人**，只观察不动作。详见下方「人机交接协议」。

## 前置条件

- Chrome（或 Chromium / Brave / Edge）**正常启动**即可。首次需要在地址栏打开 `chrome://inspect/#remote-debugging`，勾选 **"Allow remote debugging for this browser instance"**。
- 连接时会弹一次「要允许远程调试吗？」——点「允许」。这是 Chrome 的安全确认，**不要用自动点弹窗的工具绕过它**。
- Node.js **22+**（用到内置 `WebSocket`）。**零依赖**，不需要 npm install，不需要 Playwright。
- 细节与故障排查见 `references/connect.md`。

## 首次使用 —— 先说清楚要发生什么，再证明它能用

这个技能在某台机器上第一次运行时，有两件事成立，而用户多半都不知道。两件要在同一口气里讲完，在碰他的浏览器之前：

1. **你要操作的是*他自己的*浏览器，不是副本**——他的配置目录、他的标签、他的登录态。说清楚，并且带上让它变得可接受的那句：全程后台标签、他的活动标签不会移动、永远不输入也不读取密码、遇到登录 / 验证码 / 人机验证 / 支付就停下把控制权还给他。
2. **有一件事只能他手动开**——见「前置条件」。Chrome 的「要允许远程调试吗？」弹窗归他点：**绝不去点，也不要开口承诺代点。**

### 怎么判断这是首次使用？

可观测，而且便宜：如果 `$CDP_RUNTIME_DIR`（默认 `~/.cache/cdp-browser-automation/`）**不存在**，说明这个技能在这台机器上从没跑过，那就是首次使用。目录一旦存在，就表示这里已经用过了——此后上面这些一个字都不要提，直接干活。

### 流程

1. 用 `node cdp.mjs daemon status` 探一下。它什么都不启动，而它那行 endpoint 恰好回答关键问题：`endpoint source: NOT found` 表示 Chrome 的开关没开（或 Chrome 没在运行），打印出路径则表示已开。注意 `daemon: not running` 本身说明不了任何问题——daemon 只在有东西连过之后才存在。只要 daemon 没在跑，它就会以非零码退出，所以看 endpoint 那行，不要看退出码。
2. **开关没开** → 把上面两件事说清楚，让他去 `chrome://inspect/#remote-debugging`，然后**结束这一轮**。不要写循环轮询等他：那堵墙在 Chrome 自己的界面上、不在页面里，他说完成之前没有任何东西可观测，这件事也没有 `waitForHuman` 可用。
3. 他说弄好了之后，跑 `node cdp.mjs demo`。它会启动 daemon（等他点 Allow 最多 120 秒，等待期间会打印指引），然后把整条链路端到端证明一遍。这既是重试，也是证明；不要再为它写脚本。
4. **开关已开** → 照样直接跑 `demo`。仍然是首次使用，而且这是这台机器上唯一一件从未被证明过能用的事。
5. `demo` 的收尾会带出下面两个请求，在那里转达。

此后 runtime 目录已存在，这件事不会再出现。

`demo` 是**只读**自检：在**后台标签**里打开本项目地址，经 CDP 读回标题与 star 数、截一张视口图，并逐步打印自己做了什么。它不点击任何东西、不输入任何东西——star 按钮刻意留给人去点，这就是把交接规则**演示**出来，而不是写在文档里。用它回答"这样到底通不通"，不要写一次性脚本。失败时它会打印连接诊断。

### 两个请求

- **欢迎点 star。**「如果它确实好用：自检会把 star 按钮留在屏幕上、且不会替你点——那一下归你。」
- **也欢迎提 issue。**「要是坏了，或者你在 Linux / Windows 上，欢迎开个 issue——不管验证结果是能跑还是不能跑，都有价值：<https://github.com/lcy362/chrome-sidecar/issues>。」

`demo` 收尾会自己打印这两个链接，所以直接引用它的输出即可。

两条硬约束，都没有商量余地：

- **绝不去点 star 按钮，也不要开口承诺"我帮你点"。** 那是对用户账号做他没要求的写操作；这个"不做"本身就是产品，不是能力不足。
- **只在首次使用提**（上面第 5 步），不要挂到日常任务的结果后面。每做完一件不相干的事就自我推销的 agent，正是这个技能存在的意义所要避免的东西。

## 两种用法

### 用法 A：CLI（只跑 shell 就能驱动，适合一条条下命令）

```bash
cd <skill>/scripts
node cdp.mjs list                       # 列出可操作标签（含 targetId 前缀）
node cdp.mjs snap  <t>                  # 无障碍树快照（省 token 看结构）
node cdp.mjs eval  <t> "document.title"
node cdp.mjs click <t> ".like-wrapper"
node cdp.mjs open  "https://example.com"   # 后台新标签，不打扰用户
node cdp.mjs shot  <t> /tmp/a.png       # 整页截图
node cdp.mjs human <t>                  # 交给人操作，等人完成后返回
node cdp.mjs demo                       # 验证安装（只读，见上文）
node cdp.mjs daemon status              # daemon / 浏览器状态
```

`<t>` 是 `list` 输出里 targetId 的**唯一前缀**（歧义会被拒绝）。

### 用法 B：库（写脚本，用策略层 helper；复杂流程优先这个）

```js
import {
  connectCDP, ensureOn, dismissModals, uploadAndVerify,
  scrollFull, shot, clickByText, waitForHuman, randWait,
} from './files/browser.mjs';

const { findPage, openPage, newPage } = await connectCDP();
const app = (await findPage('example.com')) || await newPage('https://example.com');
```

## 最小示例：给帖子点赞 → 截图 → 上传 → 提交 → 验证

```js
import {
  connectCDP, ensureOn, dismissModals, uploadAndVerify,
  scrollFull, shot, clickByText, preRead, randWait,
} from './files/browser.mjs';

(async () => {
  const { findPage, newPage } = await connectCDP();
  const social = (await findPage('social.example')) || await newPage('https://social.example/note/123');
  await social.waitReady();

  await preRead(social);                 // 先像人一样浏览，再互动
  await randWait(800, 2000);
  await ensureOn(social, '.engage-bar .like-wrapper', '点赞');   // 数字比较法，保证是「开」

  await scrollFull(social, '我自己的评论');   // Node 侧滚动 + 把锚点滚入视口
  await shot(social, '/tmp/shot.png');        // 整页截图

  const app = (await findPage('task.example')) || await newPage('https://task.example/task');
  await dismissModals(app);                   // 清掉拦截点击的弹窗
  if (!(await uploadAndVerify(app, '/tmp/shot.png'))) throw new Error('上传未出现预览，中止');
  await dismissModals(app);
  await clickByText(app, '提交任务');

  // 成功判定：不看页面文字，看「提交按钮是否消失」（必要时 reload 复核）
  let done = false;
  for (let i = 0; i < 10 && !done; i++) {
    await app.waitForTimeout(1500);
    done = !(await app.count('button')) || !(await app.evaluate(() =>
      Array.from(document.querySelectorAll('button')).some(b => b.innerText.includes('提交任务'))));
  }
  if (!done) {
    await app.reload();
    await app.waitForTimeout(4000);
    done = !(await app.evaluate(() =>
      Array.from(document.querySelectorAll('button')).some(b => b.innerText.includes('提交任务'))));
  }
  if (!done) throw new Error('提交后按钮仍在，判定失败');

  // 结束时无需关闭浏览器：daemon/浏览器都继续存活，供下一步复用
})().catch(e => { console.error('✗', e.message); process.exit(1); });
```

## 人机交接协议

这是本技能相对通用 CDP 工具的关键差异：**agent 与人在同一个浏览器里轮流干活**。

### 必须停下、交还给人的场景

登录 / 注册 / 切换账号、短信或邮箱验证码、扫码登录、双因子（2FA）、人机验证（滑块、点选）、支付或授权二次确认，以及**任何需要填写凭据的字段**。

> **文件上传不属于交接项**（2026-10 修订）：文件选择框是系统级窗口，但**无需打开它**——直接用 `DOM.setFileInputFiles`（库封装为 `setInputFiles`）把文件塞进 `input[type=file]`，页面收到的就是一次普通的前端选择事件，性质与「填一个表单字段」相同，不是凭据墙。
>
> **正确顺序（关键）**：① `Page.setInterceptFileChooserDialog({enabled:true})`（避免弹出系统窗口）→ ② **真实点击上传区 / 拖拽区** → ③ 再注入文件（优先注入**该区块子树内**的那个 input）。**很多 SPA 只有在它自己的选择器处理器跑过之后才收文件**；直接注入会跳过这一步，应用就报「上传失败」——**这正是 2026-10 在 Mergeek 上失败与成功的分水岭**。
>
> **成功判据**只能用**服务端产物**（返回的 `https://cdn…` 图址）或表单自身报错消失——`blob:` 预览只说明页面读到了文件，**不代表应用收下了**。实测（2026-10）：经典服务端渲染表单（Rails / Homeland、PHP）直接注入即成功；SPA 里 **Mergeek（先点击再注入）成功**（图标 + 市场图，以服务端 `cdn-image…` 图址为证），**Solo 封面与新趣集头像仍失败**（只有本地预览 / 毫无反应）→ 先试「点击优先」，但它不是保证。若应用仍拒收，再把**确切文件路径**交给用户。

### 绝不做的事

- 不代填用户名 / 密码 / 验证码 / 银行卡号。
- **不读取 password 字段的值**（`eval` 读得到，但不要去读）。
- 不猜、不暴力尝试验证码。
- **不在人操作期间点击页面**。要先 `waitForHuman`，拿到「已完成」再继续。

### 标准流程

```js
import { waitForHuman, HANDOFF_HINT } from './files/browser.mjs';

const need = await app.detectHumanNeeded();     // 先探测：是否出现了登录墙/验证码/2FA
if (need.loginWall || need.captcha || need.twoFactor) {
  console.log(HANDOFF_HINT);                     // 告诉用户要做什么
  console.log('当前页面:', (await app.url()));    // 交接要带上下文
  const r = await waitForHuman(app);             // 默认 15 分钟；期间只读、不动作
  if (!r.ok) throw new Error('等待人工操作超时，请确认后重试');
  // 人完成后再校验一次状态
  const after = await app.detectHumanNeeded();
  if (after.loginWall) throw new Error('登录墙仍在，可能未完成登录');
}
```

`waitForHuman` 的实现约束（改动时不要破坏）：轮询期间只做 `evaluate` 读取，绝不点击、绝不导航、绝不抢前台；超时返回 `ok:false` 让上层明确中止，而不是带病继续。

## 用正确的方式验证成功

**不要**用页面模板文字判断成功——状态词（"待审核""已结算"）常常常驻在侧边栏/菜单里，`body.innerText.includes('待审核')` 会给出**假阳性**。

- **金标准**：点击提交后，`reload` 详情页，确认提交按钮/表单消失。
- 上传类任务：必须轮询到**真实预览**出现（`img[src^=blob:]` 或"已上传/重新上传"文案）再提交。

## 防检测（社交平台反自动化）

真实 Chrome 的浏览器指纹本身可信，剩下的暴露面是**行为时序**。本技能的反检测行为全部由 Node 侧驱动（后台标签的页面内定时器/动画帧不可用）：

- `randWait(min, max)` — 每次等待都随机，无固定延迟。
- `humanClick(page, sel)` — 贝塞尔曲线鼠标轨迹（含微调与落点迟疑），非瞬移。
- `humanScroll(page)` — 变速滚动、随机停顿、偶尔回滚。
- `preRead(page)` — 打开页面先模拟阅读，再互动。
- `shuffle(actions)` — 点赞/收藏/评论的顺序每次随机。
- 评论池 30+ 条 + 随机后缀变体。

**为什么不退回 DOM 点击**：`el.click()` 无 `isTrusted`、无轨迹、无时序，在风控严格的站点上比真实输入事件更容易被识别。本技能因为解决了后台标签的输入 ack 问题，所以**可以**在后台使用真实鼠标/键盘事件。仅在真实点击超时失败时，才回退到 DOM 点击（`Page.click` 内置这一回退）。

细节见 `references/anti-detection.md`。

## 关键坑位

做非平凡流程前先读 `references/pitfalls.md`。最常见的失败：

1. 用页面文字判断成功（而不是 reload 复查按钮是否消失）。
2. 把 `setInputFiles` 当同步操作，预览还没出来就点提交。
3. 用 `className` 判断开关状态（数字比较法才可靠）。
4. 弹窗/遮罩拦截了提交点击。
5. 在未被激活的后台标签上派发输入事件 → **ack 被无限期拖住**（表现为命令超时，但事件其实已经送达，重试会造成重复点击）。
6. 把滚动/等待放进页面里用 `setInterval` 实现（后台标签会被节流到 ~1Hz）。
7. 为了「确保能操作」而调用 `bringToFront` —— 这正是打断用户的根源。

## 文件

| 文件 | 作用 |
|---|---|
| `scripts/cdp.mjs` | CLI 前端：list / snap / eval / shot / click / type / open / human / demo / daemon 等 |
| `files/cdp-core.mjs` | L0 端口发现 + L1 原生 CDP 原语（零依赖） |
| `files/cdp-daemon.mjs` | L0 常驻 daemon：持有唯一长连接、自动启动、自动激活后台标签 |
| `files/browser.mjs` | L2 策略层：Page 封装 + 业务 helper + 交接协议 + 安装自检 + 反检测行为 |
| `references/connect.md` | 正常 Chrome 开启 CDP、授权弹窗语义、daemon、故障排查、环境变量 |
| `references/pitfalls.md` | 实战踩坑与修复（含本轮实机测量数据） |
| `references/anti-detection.md` | 反检测信号对照表与 Node 侧实现 |

> 旧版（1.x）依赖 Playwright、要求复制配置目录并用 `--user-data-dir` 启动副本 Chrome，已废弃。
> 2.0 改为零依赖 + 正常 Chrome + 常驻连接。若你手上还有按旧 API 写的脚本，见 `references/connect.md` 的迁移说明。
