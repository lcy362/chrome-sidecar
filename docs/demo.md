# Demo

These are real outputs, not mock-ups. Nothing here touches a website or the network: the
self-test drives a throwaway `data:` URL page opened in a **background** tab.

> A screencast/GIF would show this better than text. If you record one, please open a PR —
> and make sure the recording includes the Chrome tab strip, because the whole point is that
> the active tab never changes.

## 1. Self-test

```console
$ npm test
cdp-browser-automation selftest  (node v24.14.0 / darwin)

== A. 离线检查 ==
  ✓ parsePortFile 读出端口与 ws 路径  port=9333 path=/devtools/browser/abc-def
  ✓ parsePortFile 对坏文件抛错
  ✓ 候选端口文件列表非空  26 条
  ✓ macOS 候选路径为 Google/Chrome（两层目录）  /Users/…/Application Support/Google/Chrome/DevToolsActivePort
  ✓ 候选中不含 "Google Chrome/DevToolsActivePort" 这种错误写法
  ✓ shuffle 会改变顺序
  ✓ shuffle 不丢元素

== B. 联机检查（后台标签，不抢前台）==
  ✓ 后台标签中 evaluate 可用
  点赞 点击前: 13
  点赞 点击后: 12
  ⚠ 点赞 已开启被取消，补点恢复…
  点赞 补点后: 13
  ✓ ensureOn 恢复被误关的开关态  最终计数=13 点赞
  ✓ dismissModals 关掉遮罩弹窗
  ✓ uploadAndVerify 轮询到真实预览
  ✓ clickByText 命中按钮而不是外层容器
  ✓ scrollFull（Node 侧驱动）推进到文档深处  轮次=9
  ✓ 整页截图落盘且非空
  ✓ detectHumanNeeded 能识别登录墙
  ✓ waitForHuman 检测到人工完成后继续
  ✓ humanClick / humanScroll 可执行（真实输入事件在后台标签可用）
  ✓ 临时标签已清理
  ✓ 全程未抢用户前台标签  len=139 hash=f052a60e → len=139 hash=f052a60e

=== selftest: 24/24 通过 ===
```

Two things worth reading closely:

- **The `ensureOn` sequence.** The toggle was already on, so the first click switched it *off*;
  the helper noticed the count went down and clicked once more. A naive `page.click()` would have
  silently un-liked the post.
- **The last line.** The fingerprint is Chrome's *own* active tab, read via AppleScript before and
  after. Everything above happened in a background tab, and the user's foreground never moved.

## 2. The CLI, step by step

```console
$ node scripts/cdp.mjs daemon start
⏳ 正在连接 Chrome… 若 Chrome 弹出了「要允许远程调试吗？」，请点「允许」。
daemon: 运行中  pid=86930
Chrome 连接: 已建立 ✓
浏览器: Chrome/154.0.8037.98
端点来源: /Users/lcy/Library/Application Support/Google/Chrome/DevToolsActivePort
空闲回收: 4.0 小时

$ node scripts/cdp.mjs list
共 3 个标签：
 0  74D2465E  Some dashboard
 1  BBC9E44B  Repository search results
 2  60A0B6A8  Statistics @ Advert-network

$ node scripts/cdp.mjs open "https://example.com/report"
后台新标签: 4125782C  https://example.com/report
（后台创建，不会打扰你正在看的页面）

$ node scripts/cdp.mjs snap 4125782C | head -6
  heading "cli-test"
  button "ok"

$ node scripts/cdp.mjs eval 4125782C "location.href"
https://example.com/report

$ node scripts/cdp.mjs shot 4125782C /tmp/report.png
/tmp/report.png  21 KB  2880x1498 (整页)
CSS 像素 = 图像像素 / 2

$ node scripts/cdp.mjs click 4125782C ".like-wrapper"
已点击 .like-wrapper

$ node scripts/cdp.mjs close 4125782C
已关闭 4125782C
```

Note what is *not* happening: no `bringToFront`, no window activation, no focus change. The
`open` line says it explicitly — the new tab is created in the background.

## 3. Handing over to a human

When a credential wall shows up, the agent stops instead of guessing:

```console
$ node scripts/cdp.mjs human 60A0B6A8
⏸ 需要你手动操作：请在这个 Chrome 标签里完成（登录 / 验证码 / 扫码 / 支付确认等），
   完成后告诉我，我会继续。（agent 不会代填任何凭据）
▶ 检测到人工操作已完成（等待 42s），继续
```

While it waits, the only thing running is a read-only poll. It does not click, does not navigate,
and does not bring the tab forward — so your typing is never interrupted.

## 4. Reproducing

```bash
npm test                                   # offline checks + background-tab integration
node skills/chrome-sidecar/scripts/selftest.mjs --offline   # no Chrome needed
```

The online half is skipped automatically (not silently passed) when no authorised Chrome is
available. On non-macOS platforms the final "foreground untouched" assertion is skipped for the
same reason, and says so.
