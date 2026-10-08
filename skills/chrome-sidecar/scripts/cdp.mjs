#!/usr/bin/env node
// cdp.mjs — 命令行前端。任何 agent（只要能跑 shell）都能直接驱动本技能，
// 不必写 Node 脚本；需要复杂流程时改用 files/browser.mjs 的策略层。
//
//   cdp.mjs list                 列出可操作的标签（含 targetId）
//   cdp.mjs info                 daemon / 浏览器状态
//   cdp.mjs snap    <t>          无障碍树快照（省 token 看结构）
//   cdp.mjs eval    <t> <expr>   在页面里执行 JS
//   cdp.mjs html    <t> [sel]    整页或元素 HTML
//   cdp.mjs shot    <t> [file]   截图（默认整页；--viewport 只截视口）
//   cdp.mjs nav     <t> <url>    导航并等加载完成
//   cdp.mjs net     <t>          资源加载耗时
//   cdp.mjs click   <t> <sel>    按 CSS 选择器真实点击
//   cdp.mjs clickxy <t> <x> <y>  按 CSS 像素坐标真实点击
//   cdp.mjs type    <t> <text>   真实按键输入（有 keydown/keyup）
//   cdp.mjs keys    <t> <key>    按一次特殊键（Enter/Escape/Tab…）
//   cdp.mjs open    [url]        新建**后台**标签（不抢前台）
//   cdp.mjs close   <t>          关闭标签
//   cdp.mjs human   <t>          把控制权交给人，等人操作完成后返回
//   cdp.mjs raw     <t> <method> [json]   原始 CDP 命令透传
//   cdp.mjs daemon  [status|stop|start]
//
// <t> 是 list 输出里 targetId 的**唯一前缀**。

import fs from 'node:fs';
import { connectCDP, waitForHuman } from '../files/browser.mjs';
import { connectDaemon, SOCKET_PATH } from '../files/cdp-daemon.mjs';

const [, , cmd, ...args] = process.argv;

const USAGE = `cdp — 驱动你正在使用的 Chrome（后台操作，不抢前台）

用法: cdp <命令> [参数]
  list                    列出标签
  info                    daemon / 浏览器状态
  snap    <t> [--full]    无障碍树快照
  eval    <t> <expr>      执行 JS
  html    <t> [sel]       取 HTML
  shot    <t> [file] [--viewport]
  nav     <t> <url>
  net     <t>
  click   <t> <sel>
  clickxy <t> <x> <y>
  type    <t> <text>
  keys    <t> <key>
  open    [url] [--foreground]
  close   <t>
  human   <t> [timeoutMs]
  raw     <t> <method> [json]
  daemon  [status|stop|start]

<t> = list 输出中 targetId 的唯一前缀
首次使用需在 Chrome 打开 chrome://inspect/#remote-debugging 并勾选授权。`;

function resolveTarget(targets, prefix) {
  const p = (prefix || '').toLowerCase();
  if (!p) throw new Error('缺少 <target> 参数（先跑 cdp list）');
  const hits = targets.filter(t => t.targetId.toLowerCase().startsWith(p));
  if (!hits.length) throw new Error(`找不到标签: ${prefix}（先跑 cdp list）`);
  if (hits.length > 1) {
    const shortest = Math.max(...hits.map(h => {
      let n = 1;
      while (n < h.targetId.length && hits.filter(x => x.targetId.startsWith(h.targetId.slice(0, n))).length > 1) n++;
      return n;
    }));
    throw new Error(`前缀有歧义: ${prefix} 命中 ${hits.length} 个标签，请至少给 ${shortest} 个字符`);
  }
  return hits[0];
}

const fmtTarget = (t, i) => `${String(i).padStart(2)}  ${t.targetId.slice(0, 8)}  ${(t.title || '').slice(0, 50)}`;

async function main() {
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(USAGE); return; }

  if (cmd === 'daemon') {
    const sub = args[0] || 'status';
    if (sub === 'stop') {
      const c = await connectDaemon({ autoStart: false, waitConnected: false });
      await c.stop();
      console.log('daemon 已停止');
      return;
    }
    try {
      const wait = sub !== 'status';
      const c = await connectDaemon({ autoStart: wait, waitConnected: wait });
      const info = await c.info();
      console.log(`daemon: 运行中  pid=${info.pid}`);
      // 错误信息可能很长，这里只显示第一行，完整内容看 daemon.log
      const errLine = info.error ? info.error.split('\n')[0] : null;
      console.log(`Chrome 连接: ${info.connected ? '已建立 ✓' : '未建立 ✗'}` + (errLine ? `（${errLine}）` : ''));
      console.log(`浏览器: ${info.browser}`);
      console.log(`端点来源: ${info.source || '(未发现)'}`);
      console.log(`已附加标签: ${info.sessions.length} 个`);
      console.log(`空闲回收: ${(info.idleTtlMs / 3600000).toFixed(1)} 小时`);
      console.log(`socket: ${SOCKET_PATH}`);
      if (!info.connected) {
        console.log('\n连接未建立时请确认：');
        console.log('  1) Chrome 已正常打开；');
        console.log('  2) chrome://inspect/#remote-debugging 已勾选 Allow remote debugging for this browser instance；');
        console.log('  3) 弹出「要允许远程调试吗？」时点了「允许」。');
        process.exitCode = 4;
      }
    } catch (e) {
      console.log('daemon: 未运行');
      if (sub === 'status') {
        console.log('  （用 cdp daemon start）');
        process.exitCode = 4;
      } else throw e;
    }
    return;
  }

  const { client, conn, listTargets } = await connectCDP();

  if (cmd === 'list' || cmd === 'ls') {
    const targets = await listTargets();
    console.log(`共 ${targets.length} 个标签：`);
    targets.forEach((t, i) => console.log(fmtTarget(t, i)));
    return;
  }
  if (cmd === 'info') {
    const info = await client.info();
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  if (cmd === 'open') {
    const url = args.find(a => !a.startsWith('--')) || 'about:blank';
    const foreground = args.includes('--foreground');
    const { targetId } = await client.newTarget(url, !foreground);
    console.log(`${foreground ? '前台' : '后台'}新标签: ${targetId.slice(0, 8)}  ${url}`);
    if (!foreground) console.log('（后台创建，不会打扰你正在看的页面）');
    return;
  }

  const targets = await listTargets();
  const target = resolveTarget(targets, args[0]);
  const tId = target.targetId;
  const rest = args.slice(1);

  switch (cmd) {
    case 'snap': {
      const { snapshot } = await import('../files/cdp-core.mjs');
      console.log(await snapshot(conn, tId, { compact: !rest.includes('--full') }));
      break;
    }
    case 'eval': {
      const expr = rest.join(' ');
      const r = await conn.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, tId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      const v = r.result?.value;
      console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
      break;
    }
    case 'html': {
      const sel = rest[0];
      const r = await conn.send('Runtime.evaluate', {
        expression: sel ? `document.querySelector(${JSON.stringify(sel)})?.outerHTML` : 'document.documentElement.outerHTML',
        returnByValue: true,
      }, tId);
      console.log(r.result?.value ?? '(未找到)');
      break;
    }
    case 'shot': {
      const file = rest.find(a => !a.startsWith('--'));
      const fullPage = !rest.includes('--viewport');
      const out = file || `/tmp/cdp-shot-${tId.slice(0, 8)}.png`;
      const r = await conn.send('Page.captureScreenshot',
        fullPage ? { format: 'png', captureBeyondViewport: true } : { format: 'png' }, tId);
      const buf = Buffer.from(r.data, 'base64');
      fs.writeFileSync(out, buf);
      const w = buf.readUInt32BE(16); const h = buf.readUInt32BE(20);
      console.log(`${out}  ${(buf.length / 1024).toFixed(0)} KB  ${w}x${h}${fullPage ? ' (整页)' : ''}`);
      console.log(`CSS 像素 = 图像像素 / ${await conn.send('Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true }, tId).then(x => x.result.value)}`);
      break;
    }
    case 'nav': {
      const { navigate } = await import('../files/cdp-core.mjs');
      const r = await navigate(conn, tId, rest[0]);
      console.log(`已导航 readyState=${r.readyState}`);
      break;
    }
    case 'net': {
      const { resourceTiming } = await import('../files/cdp-core.mjs');
      const rows = await resourceTiming(conn, tId);
      rows.sort((a, b) => b.ms - a.ms).slice(0, 30)
        .forEach(r => console.log(`${String(r.ms).padStart(6)}ms  ${String(r.kb).padStart(5)}KB  ${r.type.padEnd(10)} ${r.name}`));
      break;
    }
    case 'click': {
      const { clickElement } = await import('../files/cdp-core.mjs');
      const ok = await clickElement(conn, tId, rest[0]);
      console.log(ok ? `已点击 ${rest[0]}` : `未找到元素 ${rest[0]}`);
      break;
    }
    case 'clickxy': {
      const { clickAt } = await import('../files/cdp-core.mjs');
      await clickAt(conn, tId, Number(rest[0]), Number(rest[1]));
      console.log(`已点击坐标 (${rest[0]}, ${rest[1]})`);
      break;
    }
    case 'type': {
      const { typeText, insertText } = await import('../files/cdp-core.mjs');
      const text = rest.join(' ');
      if (rest.includes('--fast')) await insertText(conn, tId, text);
      else await typeText(conn, tId, text);
      console.log(`已输入 ${text.length} 个字符`);
      break;
    }
    case 'keys': {
      const key = rest[0] || 'Enter';
      const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38 };
      await conn.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key, code: key, windowsVirtualKeyCode: codes[key] || 0,
      }, tId);
      await conn.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key, code: key, windowsVirtualKeyCode: codes[key] || 0,
      }, tId);
      console.log(`已按下 ${key}`);
      break;
    }
    case 'close': {
      await client.closeTarget(tId);
      console.log(`已关闭 ${tId.slice(0, 8)}`);
      break;
    }
    case 'human': {
      const { Page } = await import('../files/browser.mjs');
      const page = new Page(conn, tId);
      const timeoutMs = Number(rest[0] || 15 * 60 * 1000);
      const r = await waitForHuman(page, { timeoutMs });
      console.log(r.ok ? '人已完成操作，可以继续' : `等待超时（${(r.waitedMs / 1000).toFixed(0)}s），请确认后重试`);
      if (!r.ok) process.exitCode = 3;
      break;
    }
    case 'raw': {
      const method = rest[0];
      const params = rest[1] ? JSON.parse(rest.slice(1).join(' ')) : {};
      const r = await conn.send(method, params, tId);
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }

  // CLI 是短命进程：每个请求都用独立 socket，无需清理，也不必停 daemon；
  // daemon 与浏览器会继续存活，供后续命令复用这条已授权的长连接。
}

main().catch(e => { console.error('✗ ' + e.message); process.exitCode = 1; });
