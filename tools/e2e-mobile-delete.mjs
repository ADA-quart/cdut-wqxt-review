/* 移动端 E2E 冒烟（可选，需本机装有 Edge/Chrome）：
 *   npm run test:e2e   （= node tools/e2e-mobile-delete.mjs）
 * 起一个只服务 public/ 的临时静态服务器，用真实 Chromium + IndexedDB 跑通：
 *   导入内容包 → 仅删课件与笔记（学习记录保留）→ 重新导入 → 全部删除 → 数据管理 / 清空全部
 * 不进 npm test / CI（CI 无本机浏览器），发版 App 前在本机跑一次。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');

let failed = 0;
function assert(ok, msg) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + msg);
  if (!ok) failed++;
}

// ---------- 1) 静态服务器（只服务 public/；/api/* 与 /notes/* 由 shim 本地拦截） ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname === '/' ? path.join(PUB, 'mobile.html') : path.join(PUB, decodeURIComponent(url.pathname));
  if (!p.startsWith(PUB)) { res.writeHead(403); res.end(); return; }
  try {
    const data = fs.readFileSync(p);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

// ---------- 2) 构造测试内容包（结构同电脑端导出） ----------
const now = Date.now();
const zip = new AdmZip();
zip.addFile('manifest.json', Buffer.from(JSON.stringify({
  app: 'wqppt', format: 2, type: 'full', version: '0.1.9', exportedAt: new Date(now).toISOString(), device: 'desktop',
  courses: [
    { name: 'zz课程甲', lessons: [
      { name: 'zz课次一', pages: 3, note: true, images: 1, contentVersion: '1' },
      { name: 'zz课次二', pages: 2, note: true, images: 0 },
    ] },
    { name: 'zz课程乙', lessons: [{ name: 'zz课次一', pages: 2, note: true, images: 1 }] },
  ],
}), 'utf8'));
zip.addFile('notes/zz课程甲/zz课次一.md', Buffer.from('<!-- page 1: -->\n# 原文一\n', 'utf8'));
zip.addFile('notes/zz课程甲/zz课次一.note.md', Buffer.from('# 笔记一\n', 'utf8'));
zip.addFile('notes/zz课程甲/zz课次二.note.md', Buffer.from('# 笔记二\n', 'utf8'));
zip.addFile('notes/zz课程甲/zz课次一.note.work.vision.md', Buffer.from('# 中间产物（不应算课次）\n', 'utf8'));
zip.addFile('notes/zz课程甲/zz课程甲.md', Buffer.from('# 课程索引\n', 'utf8'));
zip.addFile('notes/知识链.md', Buffer.from('# 知识链\n', 'utf8'));
zip.addFile('notes/zz课程乙/zz课次一.note.md', Buffer.from('# 笔记乙\n', 'utf8'));
zip.addFile('images/zz课程甲/zz课次一/001.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
zip.addFile('images/zz课程乙/zz课次一/001.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]));
zip.addFile('progress/zz课程甲/zz课次一.json', Buffer.from(JSON.stringify({ v: 1, page: 5, updatedAt: now })));
zip.addFile('chats/zz课程甲/zz课次一.json', Buffer.from(JSON.stringify({ v: 1, messages: [{ id: 'zzm1', role: 'user', text: 'zz 提问' }] })));
zip.addFile('cards/zz课程甲/zz课次一.json', Buffer.from(JSON.stringify([{ id: 'zzc1', dir: 'zz课程甲/zz课次一', front: 'f', back: 'b' }])));
zip.addFile('progress/zz课程乙/zz课次一.json', Buffer.from(JSON.stringify({ v: 1, page: 3, updatedAt: now })));
const ZIP_B64 = zip.toBuffer().toString('base64');

// ---------- 3) 真实浏览器 ----------
const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
const exec = CANDIDATES.find((p) => fs.existsSync(p));
if (!exec) { console.error('未找到 Edge/Chrome，无法运行'); process.exit(3); }
console.log('浏览器：' + exec);
const browser = await chromium.launch({ executablePath: exec, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.addInitScript(() => { try { localStorage.setItem('qingqu_local_mode', '1'); } catch (e) { /* 忽略 */ } });

const importZip = (b64) => page.evaluate(async (b) => {
  const bin = atob(b);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return await window.QingquLocal.importZip(u8.buffer, 'zz-test.zip');
}, b64);
const counts = (prefix) => page.evaluate((pf) => window.QingquLocal.listFiles(pf).then((a) => a.length), prefix);
const catalogNames = () => page.evaluate(() => window.QingquLocal.getCatalog().then((c) => (c.courses || []).map((x) => x.name)));
const shot = async (name) => {
  const file = path.join(os.tmpdir(), 'zz-qingqu-' + name + '.png');
  await page.screenshot({ path: file });
  console.log('  截图：' + file);
};

console.log('\n[1] 导入测试包');
await page.goto(ORIGIN + '/mobile.html');
await page.waitForFunction(() => window.QingquLocal && window.QingquLocal.active === true);
const imported = await importZip(ZIP_B64);
assert(imported.count === 14, 'zip 解出 14 个文件（实际 ' + imported.count + '）');
await page.reload();
await page.waitForSelector('.course');
let names = await catalogNames();
assert(names.length === 2 && names.includes('zz课程甲') && names.includes('zz课程乙'), '目录含 2 门课程：' + names.join('、'));
const bodyText = await page.textContent('#catalog');
assert(!bodyText.includes('note.work.vision'), '中间产物未混进课次列表');
assert((await page.locator('.course-del').count()) === 2, '每张课程卡片都有「删除」按钮');
assert(bodyText.includes('zz课次一') && bodyText.includes('zz课次二') && bodyText.includes('2 节课'), '课程甲显示 2 节课');
await shot('home-imported');

console.log('\n[2] 仅删课件与笔记（课程甲）——学习记录应保留');
await page.locator('.course', { hasText: 'zz课程甲' }).locator('.course-del').click();
await page.waitForFunction(() => !!document.getElementById('qzSheet'));
await shot('sheet-delete');
await page.click('#qzSheet .qz-sheet-acts .btn:has-text("仅删课件与笔记")');
await page.waitForFunction(async () => {
  const c = await window.QingquLocal.getCatalog();
  return !(c.courses || []).some((x) => x.name === 'zz课程甲');
}, null, { timeout: 15000 });
assert((await counts('notes/zz课程甲/')) === 0, '课程甲 notes/ 已清空');
assert((await counts('images/zz课程甲/')) === 0, '课程甲 images/ 已清空');
assert((await counts('progress/zz课程甲/')) === 1, '课程甲 progress/ 保留');
assert((await counts('chats/zz课程甲/')) === 1, '课程甲 chats/ 保留');
assert((await counts('cards/zz课程甲/')) === 1, '课程甲 cards/ 保留');
assert((await counts('notes/zz课程乙/')) === 1, '课程乙内容不受影响');
assert((await counts('notes/知识链.md')) === 1, '全局知识链文件不受影响');

console.log('\n[3] 重新导入新版内容包——课程回来、进度/对话/卡片仍在');
await importZip(ZIP_B64);
names = await catalogNames();
assert(names.includes('zz课程甲'), '课程甲重新出现在目录');
assert((await counts('notes/zz课程甲/')) >= 3, '课程甲笔记文件已恢复');
assert((await counts('progress/zz课程甲/')) === 1, '学习进度仍在（重新导入后接着用）');

console.log('\n[4] 全部删除（课程乙）——内容与学习记录一并清掉');
await page.reload();
await page.waitForSelector('.course');
await page.locator('.course', { hasText: 'zz课程乙' }).locator('.course-del').click();
await page.waitForFunction(() => !!document.getElementById('qzSheet'));
await page.click('#qzSheet .qz-sheet-acts .btn:has-text("全部删除")');
await page.waitForFunction(async () => !(await window.QingquLocal.getCatalog()).courses.some((x) => x.name === 'zz课程乙'), null, { timeout: 15000 });
assert((await counts('notes/zz课程乙/')) === 0, '课程乙 notes/ 已清空');
assert((await counts('images/zz课程乙/')) === 0, '课程乙 images/ 已清空');
assert((await counts('progress/zz课程乙/')) === 0, '课程乙 progress/ 一并删除');

console.log('\n[5] 数据管理：占用统计 + 清空全部数据');
await page.evaluate(() => localStorage.setItem('wqppt_ai_config', JSON.stringify({ baseUrl: 'http://127.0.0.1:9', model: 'zz', apiKey: 'zz' })));
await page.click('#btnData');
await page.waitForFunction(() => !!document.getElementById('qzSheet'));
await page.waitForFunction(() => !/统计中/.test(document.getElementById('qzSheet').textContent));
const dmText = await page.textContent('#qzSheet');
assert(/共 \d+ 门课程/.test(dmText) && /zz课程甲/.test(dmText), '数据管理列出课程与占用：' + dmText.replace(/\s+/g, ' ').slice(0, 80));
await shot('sheet-data');
await page.click('#qzSheet .qz-sheet-acts .btn:has-text("清空全部数据")');
await page.waitForFunction(() => /清空全部数据/.test(document.getElementById('qzSheet').textContent));
await page.click('#qzSheet .qz-sheet-acts .btn:has-text("确认清空")');
await page.waitForFunction(async () => {
  const c = await window.QingquLocal.getCatalog();
  return !c || !(c.courses || []).length;
}, null, { timeout: 15000 });
assert((await page.evaluate(() => window.QingquLocal.listFiles('').then((a) => a.length))) === 0, 'files 存储已清空');
assert((await page.evaluate(() => localStorage.getItem('wqppt_ai_config'))) !== null, 'AI 接口设置保留');
await page.waitForSelector('.empty');
assert((await page.textContent('#catalog')).includes('还没有内容'), '首页回到空状态');

console.log('\n[6] 控制台错误检查');
assert(errors.length === 0, '无页面报错' + (errors.length ? '：' + errors.join(' | ') : ''));

await browser.close();
server.close();
console.log('\n' + (failed ? '✗ 失败 ' + failed + ' 项' : '✓ 全部通过'));
process.exit(failed ? 1 : 0);
