# 反检测（社交平台反自动化）

## 为什么本技能在这个问题上比通用 CDP 工具更强

真实 Chrome 的指纹（User-Agent、扩展、视口、TLS 指纹、Cookie 分布）本来就是真的，
所以用 CDP 连真实浏览器**比开一个全新 Playwright 实例更不易被识别**。

真正剩下的暴露面是**行为时序**——人类的操作是不规律的，脚本必须也是。

多数轻量 CDP 工具的 `click` 是 DOM 级 `el.click()`：无 `isTrusted`、无鼠标轨迹、无时序抖动。
在风控严格的站点上，这本身就是信号。

本技能**可以在后台标签使用真实鼠标/键盘事件**（因为解决了后台输入 ack 被拖住的问题，
见 `pitfalls.md` 第 1 条），因此不需要在"不打扰用户"和"行为真实"之间二选一。

## 信号对照表

| 信号 | 机械式（易被识别） | 类人式（本技能实现） |
|---|---|---|
| **时序** | 固定延迟 `waitForTimeout(2000)` | `randWait(2000, 4000)`，每次等待都随机 |
| **鼠标** | `page.click()` 瞬间跳到元素中心 | `humanClick()`：贝塞尔曲线从随机起点出发、smoothstep 减速接近、落点前迟疑、末段微调；鼠标位置在多次点击间保持连续 |
| **滚动** | 固定步长/间隔 `scrollBy(0,500)` 每 150ms | `humanScroll()`：200–700px 变速，300–1200ms 随机停顿，20% 概率小幅回滚 |
| **动作顺序** | 永远是 点赞→收藏→评论 | `shuffle(actions)` 每次打乱 |
| **评论内容** | 10 条小池子、精确重复 | 30+ 条池子 + 随机后缀变体（emoji、标点） |
| **阅读行为** | 打开就点 | `preRead()`：渐进滚动 + 阅读停顿（0.8–3s），40% 概率回到顶部 |
| **动作之间** | 无停顿 | 60% 概率插入 0.5–2.5s 的"思考"停顿 |

## 实现约束：必须 Node 侧驱动

后台标签的页面内 `setInterval` 被节流到 ~1Hz、`requestAnimationFrame` 完全挂起。
所以上述所有行为的时序循环都写在 Node 侧（`await sleep(...)` + 逐次派发 CDP 命令），
**不要**在页面里 `setInterval` 驱动动画或滚动。

`humanScroll()` 用 `Input.dispatchMouseEvent` 的 `mouseWheel`；
`humanClickAt()` 用一串 `mouseMoved` 逼近目标后再 `pressed/released`。

## 使用建议

```js
import { preRead, randWait, humanClick, humanScroll, shuffle, ensureOn } from './files/browser.mjs';

await page.goto(url);
await page.waitReady();
await preRead(page);                       // 先读再动
await randWait(800, 2200);

for (const action of shuffle([
  () => ensureOn(page, '.engage-bar .like-wrapper', '点赞'),
  () => ensureOn(page, '.engage-bar .collect-wrapper', '收藏'),
])) {
  await action();
  if (Math.random() < 0.6) await randWait(500, 2500);
}
```

## 边界

- 反检测是"降低被识别的概率"，**不是**"保证不被识别"。平台风控会持续演进。
- 不要在账号安全敏感的操作上试错——一次误判可能触发封号。
- 本技能的定位是**代替用户完成他自己该做的重复操作**，不是绕过平台限制做灰产。
  涉及凭据、验证码、支付确认，一律交接给人（见 `SKILL.md` 的交接协议）。
- 提高频率、同时开多标签并发操作同一平台，会显著抬高被识别概率——即使每次动作都很"像人"。
