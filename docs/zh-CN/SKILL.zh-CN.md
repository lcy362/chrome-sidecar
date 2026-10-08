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

登录 / 注册 / 切换账号、短信或邮箱验证码、扫码登录、双因子（2FA）、人机验证（滑块、点选）、支付或授权二次确认、系统级文件选择框、以及**任何需要填写凭据的字段**。

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
| `scripts/cdp.mjs` | CLI 前端：list / snap / eval / shot / click / type / open / human / daemon 等 |
| `files/cdp-core.mjs` | L0 端口发现 + L1 原生 CDP 原语（零依赖） |
| `files/cdp-daemon.mjs` | L0 常驻 daemon：持有唯一长连接、自动启动、自动激活后台标签 |
| `files/browser.mjs` | L2 策略层：Page 封装 + 业务 helper + 交接协议 + 反检测行为 |
| `references/connect.md` | 正常 Chrome 开启 CDP、授权弹窗语义、daemon、故障排查、环境变量 |
| `references/pitfalls.md` | 实战踩坑与修复（含本轮实机测量数据） |
| `references/anti-detection.md` | 反检测信号对照表与 Node 侧实现 |

> 旧版（1.x）依赖 Playwright、要求复制配置目录并用 `--user-data-dir` 启动副本 Chrome，已废弃。
> 2.0 改为零依赖 + 正常 Chrome + 常驻连接。若你手上还有按旧 API 写的脚本，见 `references/connect.md` 的迁移说明。
