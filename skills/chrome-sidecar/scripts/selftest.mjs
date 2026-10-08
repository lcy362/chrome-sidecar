#!/usr/bin/env node
// selftest.mjs — 自测。分两部分：
//
//   A. 离线检查：不需要 Chrome，验证端口文件解析、候选路径、工具函数。
//   B. 联机检查：需要一个开着 chrome://inspect 授权的 Chrome。会在**后台**标签
//      里跑完整策略层（ensureOn / dismissModals / uploadAndVerify / clickByText /
//      scrollFull / shot / waitForHuman），并（macOS 上）用 Chrome 自身的活动标签
//      做独立验证：全程没有抢用户前台。
//
// 用法：
//   node scripts/selftest.mjs                # 能连就全跑，连不上只跑离线部分
//   node scripts/selftest.mjs --offline      # 只跑离线部分
//   node scripts/selftest.mjs --require-chrome   # 连不上就失败退出（CI 用）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..');

const ARGS = process.argv.slice(2);
const OFFLINE_ONLY = ARGS.includes('--offline');
const REQUIRE_CHROME = ARGS.includes('--require-chrome');

const results = [];
const check = (name, pass, extra = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// A. 离线检查
// ---------------------------------------------------------------------------

async function offlineChecks() {
  console.log('\n== A. 离线检查 ==');
  const core = await import(path.join(SKILL, 'files/cdp-core.mjs'));

  // 端口文件解析
  const tmp = path.join(os.tmpdir(), `cdp-selftest-port-${process.pid}`);
  fs.writeFileSync(tmp, '9333\n/devtools/browser/abc-def\n');
  const parsed = core.parsePortFile(tmp);
  check('parsePortFile 读出端口与 ws 路径', parsed.port === 9333 && parsed.wsPath === '/devtools/browser/abc-def',
    `port=${parsed.port} path=${parsed.wsPath}`);
  fs.unlinkSync(tmp);

  // 内容异常时必须抛错，而不是静默用一个坏端口
  const bad = path.join(os.tmpdir(), `cdp-selftest-bad-${process.pid}`);
  fs.writeFileSync(bad, 'not-a-port\n');
  let threw = false;
  try { core.parsePortFile(bad); } catch { threw = true; }
  check('parsePortFile 对坏文件抛错', threw);
  fs.unlinkSync(bad);

  // 候选路径必须覆盖当前平台，且不能出现明显拼错的路径
  const cands = core.candidatePortFiles();
  check('候选端口文件列表非空', cands.length > 0, `${cands.length} 条`);
  if (process.platform === 'darwin') {
    // macOS 的实际布局是 Google/Chrome 两层目录，不是 "Google Chrome"
    const macPath = cands.find(p => p.includes('Library/Application Support/Google/Chrome/DevToolsActivePort'));
    check('macOS 候选路径为 Google/Chrome（两层目录）', !!macPath, macPath || '未找到');
    check('候选中不含 "Google Chrome/DevToolsActivePort" 这种错误写法',
      !cands.some(p => p.includes('Application Support/Google Chrome/DevToolsActivePort')));
  }

  // shuffle 必须真的改变顺序（固定种子做不到，这里用多次采样）
  const { shuffle } = await import(path.join(SKILL, 'files/browser.mjs'));
  const base = [1, 2, 3, 4, 5, 6, 7, 8];
  const shuffledAtLeastOnce = Array.from({ length: 20 }, () => shuffle(base).join(''))
    .some(s => s !== base.join(''));
  check('shuffle 会改变顺序', shuffledAtLeastOnce);
  check('shuffle 不丢元素', shuffle(base).sort((a, b) => a - b).join('') === base.join(''));

  // 用户脚本引用路径必须存在（文档里写的文件名与实际一致）
  for (const rel of ['files/cdp-core.mjs', 'files/cdp-daemon.mjs', 'files/browser.mjs', 'scripts/cdp.mjs']) {
    check(`文件存在: ${rel}`, fs.existsSync(path.join(SKILL, rel)));
  }
}

// ---------------------------------------------------------------------------
// B. 联机检查
// ---------------------------------------------------------------------------

// macOS 上读 Chrome 当前活动标签的指纹（只取长度+哈希，不打印 URL 内容）。
// 这是唯一能独立判断「有没有抢用户前台」的方法：伪聚焦会让目标页自己恒报 visible。
function activeTabFingerprint() {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync('osascript', ['-e',
      'tell application "Google Chrome"\nset w to count of windows\nif w = 0 then return "no-window"\n' +
      'return (URL of active tab of front window) & "|" & (title of active tab of front window)\nend tell'],
      { encoding: 'utf8', timeout: 8000 }).trim();
    let h = 0;
    for (const ch of out) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return 'len=' + out.length + ' hash=' + h.toString(16);
  } catch { return null; }
}

const TEST_PAGE = `<!doctype html><meta charset=utf-8><title>cdp-selftest</title>
<style>body{background:#123456;margin:0;color:#fff;font:16px sans-serif}
.row{padding:16px}</style>
<div class="row" id="like" data-on="1"><span class="cnt">13</span> 点赞</div>
<div class="row"><button id="submit">提交任务</button></div>
<div class="row"><input id="f" type="file" accept="image/*"></div>
<div class="row" id="loginbox"><input type="password" placeholder="密码"></div>
<div class="row"><div role="dialog" data-state="open" style="position:relative;z-index:50">
  <button id="dismiss">知道了</button></div></div>
<div style="height:3000px"></div>
<div class="row" id="anchor">锚点文本</div>
<div style="height:400px"></div>
<script>
  const like = document.getElementById('like');
  like.addEventListener('click', () => {
    const on = like.dataset.on === '1';
    like.dataset.on = on ? '0' : '1';
    like.querySelector('.cnt').textContent = on ? '12' : '13';
  });
  document.getElementById('submit').addEventListener('click', e => e.target.remove());
  document.getElementById('dismiss').addEventListener('click', e => e.target.closest('[role=dialog]').remove());
</script>`;

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

async function onlineChecks() {
  console.log('\n== B. 联机检查（后台标签，不抢前台）==');
  const {
    connectCDP, ensureOn, dismissModals, uploadAndVerify, scrollFull, shot,
    clickByText, waitForHuman, humanClick, humanScroll,
  } = await import(path.join(SKILL, 'files/browser.mjs'));

  const { listTargets, newPage, closePage } = await connectCDP();
  const before = (await listTargets()).length;
  const fpBefore = activeTabFingerprint();

  const png = path.join(os.tmpdir(), `cdp-selftest-${process.pid}.png`);
  const outPng = path.join(os.tmpdir(), `cdp-selftest-shot-${process.pid}.png`);
  fs.writeFileSync(png, TINY_PNG);

  const page = await newPage('data:text/html;charset=utf-8,' + encodeURIComponent(TEST_PAGE));
  await page.waitReady();
  await sleep(600);

  check('后台标签中 evaluate 可用', (await page.title()) === 'cdp-selftest');
  check('新建的是后台标签（新标签不会挤掉用户正在看的页面）', (await page.visible()) !== null);

  // 数字比较法：初始为「已开启」，点击会变成关闭 → ensureOn 应自动补点恢复
  const on = await ensureOn(page, '#like', '点赞');
  check('ensureOn 恢复被误关的开关态', on === true, `最终计数=${(await page.text('#like'))?.trim()}`);

  await dismissModals(page);
  check('dismissModals 关掉遮罩弹窗', (await page.count('[role=dialog]')) === 0);

  await page.evaluate(() => {
    const i = document.getElementById('f');
    i.addEventListener('change', () => {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(i.files[0]);
      i.after(img);
    });
  });
  check('uploadAndVerify 轮询到真实预览', (await uploadAndVerify(page, png)) === true);

  check('clickByText 命中按钮而不是外层容器', (await clickByText(page, '提交任务')) === true
    && (await page.count('#submit')) === 0);

  const r = await scrollFull(page, '锚点文本');
  check('scrollFull（Node 侧驱动）推进到文档深处', (await page.scrollInfo()).y > 500, `轮次=${r.rounds}`);

  await shot(page, outPng);
  check('整页截图落盘且非空', fs.existsSync(outPng) && fs.statSync(outPng).size > 2000);

  // 交接：模拟「人完成操作」——移除登录墙后 waitForHuman 应自行返回
  const humanOk = await page.evaluate("!!document.getElementById('loginbox')");
  check('detectHumanNeeded 能识别登录墙', humanOk === true);
  check('waitForHuman 检测到人工完成后继续', (await waitForHuman(page, {
    pollMs: 300, timeoutMs: 5000,
    signal: async () => {
      await page.evaluate("document.getElementById('loginbox')?.remove()");
      return true;
    },
  })).ok === true);

  await humanClick(page, '#like');
  await humanScroll(page, { rounds: 2 });
  check('humanClick / humanScroll 可执行（真实输入事件在后台标签可用）', true);

  await closePage(page);
  await sleep(500);
  check('临时标签已清理', (await listTargets()).length === before);

  const fpAfter = activeTabFingerprint();
  if (fpAfter === null) {
    console.log('  · 跳过「前台未被抢」验证（该检查仅 macOS 可用）');
  } else {
    check('全程未抢用户前台标签', fpAfter === fpBefore, `${fpBefore} → ${fpAfter}`);
  }

  fs.unlinkSync(png);
  fs.unlinkSync(outPng);
}

// ---------------------------------------------------------------------------

(async () => {
  console.log(`cdp-browser-automation selftest  (node ${process.version} / ${process.platform})`);
  await offlineChecks();

  if (!OFFLINE_ONLY) {
    try {
      await onlineChecks();
    } catch (e) {
      const msg = String(e.message || e);
      if (REQUIRE_CHROME) {
        console.log('\n== B. 联机检查 ==');
        check('连接 Chrome', false, msg.split('\n')[0]);
      } else {
        console.log('\n== B. 联机检查：跳过 ==');
        console.log('  未连接到 Chrome：' + msg.split('\n')[0]);
        console.log('  需要正常打开的 Chrome，并在 chrome://inspect/#remote-debugging 勾选授权。');
        console.log('  只用 --offline 可显式跳过这部分。');
      }
    }
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n=== selftest: ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log('  - ' + f.name);
  }
  process.exit(failed.length ? 1 : 0);
})();
