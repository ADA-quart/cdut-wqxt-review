/* 移动端 E2E 冒烟（可选，需本机装有 Edge/Chrome）：
 *   npm run test:e2e   （= node tools/e2e-mobile.mjs）
 * 起一个只服务 public/ 的临时静态服务器，用真实 Chromium + IndexedDB 跑通：
 *   导入内容包 → 复习页图片（笔记正文 / 原文 md，blob URL）→ 删除课程（保留 / 全清）
 *   → 重新导入 → 目录自愈（meta 丢失：镜像恢复 / 按 files 重建）→ 数据管理 / 清空全部
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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.woff2': 'font/woff2' };
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

// ---------- 2) 构造测试包（结构同电脑端导出） ----------
// 1×1 白色 JPEG（验证 <img> 真能解码，不只是 URL 换对了）
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==',
  'base64',
);
const now = Date.now();
const zip = new AdmZip();
zip.addFile('manifest.json', Buffer.from(JSON.stringify({
  app: 'wqppt', format: 2, type: 'full', version: '0.1.10', exportedAt: new Date(now).toISOString(), device: 'desktop',
  courses: [
    { name: 'zz课程甲', lessons: [
      { name: 'zz课次一', pages: 1, note: true, images: 1, contentVersion: '1' },
      { name: 'zz课次二', pages: 0, note: true, images: 0 },
    ] },
    { name: 'zz课程乙', lessons: [{ name: 'zz课次一', pages: 0, note: true, images: 1 }] },
  ],
}), 'utf8'));
// 笔记 md：正文相对图片，一个指向课件图目录（images/），一个指向 _assets（notes/）
zip.addFile('notes/zz课程甲/zz课次一.note.md', Buffer.from(
  '# 笔记一\n\n![图](zz课次一/001.jpg)\n\n![图2](zz课次一_assets/p0001/figures/f1.jpg)\n', 'utf8'));
zip.addFile('notes/zz课程甲/zz课次一.md', Buffer.from(
  '<!-- page 1: 001.jpg -->\n\n原文正文\n\n![](zz课次一/001.jpg)\n\n![](zz课次一_assets/p0001/figures/f2.jpg)\n', 'utf8'));
zip.addFile('notes/zz课程甲/zz课次二.note.md', Buffer.from('# 笔记二\n', 'utf8'));
zip.addFile('notes/zz课程甲/zz课次一.note.work.vision.md', Buffer.from('# 中间产物（不应算课次）\n', 'utf8'));
zip.addFile('notes/zz课程甲/zz课程甲.md', Buffer.from('# 课程索引\n', 'utf8'));
zip.addFile('notes/知识链.md', Buffer.from('# 知识链\n', 'utf8'));
zip.addFile('notes/zz课程乙/zz课次一.note.md', Buffer.from('# 笔记乙\n', 'utf8'));
zip.addFile('notes/zz课程甲/zz课次一_assets/p0001/figures/f1.jpg', JPEG);
zip.addFile('notes/zz课程甲/zz课次一_assets/p0001/figures/f2.jpg', JPEG);
zip.addFile('images/zz课程甲/zz课次一/001.jpg', JPEG);
zip.addFile('images/zz课程乙/zz课次一/001.jpg', JPEG);
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
const clearCatalogMeta = () => page.evaluate(() => new Promise((resolve, reject) => {
  const req = indexedDB.open('qingqu-library', 1);
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  };
  req.onerror = () => reject(req.error);
}));
const mdImages = () => page.evaluate(() => [...document.querySelectorAll('#mdContent img')]
  .map((i) => ({ src: i.src, w: i.naturalWidth, complete: i.complete })));
const shot = async (name) => {
  const file = path.join(os.tmpdir(), 'zz-qingqu-' + name + '.png');
  await page.screenshot({ path: file });
  console.log('  截图：' + file);
};

console.log('\n[1] 导入测试包');
await page.goto(ORIGIN + '/mobile.html');
await page.waitForFunction(() => window.QingquLocal && window.QingquLocal.active === true);
const imported = await importZip(ZIP_B64);
assert(imported.count === 16, 'zip 解出 16 个文件（实际 ' + imported.count + '）');
await page.reload();
await page.waitForSelector('.course');
let names = await catalogNames();
assert(names.length === 2 && names.includes('zz课程甲') && names.includes('zz课程乙'), '目录含 2 门课程：' + names.join('、'));
const bodyText = await page.textContent('#catalog');
assert(!bodyText.includes('note.work.vision'), '中间产物未混进课次列表');
assert((await page.locator('.course-del').count()) === 2, '每张课程卡片都有「删除」按钮');

console.log('\n[2] 复习页图片：笔记正文 / 原文 md 都必须真实显示');
await page.goto(ORIGIN + '/review.html?dir=' + encodeURIComponent('zz课程甲/zz课次一'));
await page.waitForSelector('#mdContent img');
await page.evaluate(() => { const el = document.getElementById('mdScroll'); if (el) el.scrollTop = el.scrollHeight; });
await page.waitForFunction(() => [...document.querySelectorAll('#mdContent img')].every((i) => i.complete && i.naturalWidth > 0));
let imgs = await mdImages();
assert(imgs.length >= 2, '笔记里有 ' + imgs.length + ' 张正文图');
assert(imgs.every((i) => i.src.startsWith('blob:')), '全部走 blob URL（App 内 <img> 不走 fetch 拦截）');
assert(imgs.every((i) => i.w > 0), '全部真实解码成功（naturalWidth > 0）');
await shot('note-images');
await page.click('#tabRaw');
await page.waitForFunction(() => {
  const els = [...document.querySelectorAll('#mdContent img')];
  return els.length >= 2 && els.every((i) => i.complete && i.naturalWidth > 0);
});
imgs = await mdImages();
assert(imgs.every((i) => i.src.startsWith('blob:') && i.w > 0), '原文 md 的图片同样全部显示（' + imgs.length + ' 张）');

console.log('\n[3] 仅删课件与笔记（课程甲）——学习记录应保留');
await page.goto(ORIGIN + '/mobile.html');
await page.waitForSelector('.course');
await page.locator('.course', { hasText: 'zz课程甲' }).locator('.course-del').click();
await page.waitForFunction(() => !!document.getElementById('qzSheet'));
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

console.log('\n[4] 重新导入新版内容包——课程回来、进度/对话/卡片仍在');
await importZip(ZIP_B64);
names = await catalogNames();
assert(names.includes('zz课程甲'), '课程甲重新出现在目录');
assert((await counts('notes/zz课程甲/')) >= 5, '课程甲笔记/资源文件已恢复');
assert((await counts('progress/zz课程甲/')) === 1, '学习进度仍在（重新导入后接着用）');

console.log('\n[5] 目录自愈：meta 丢失后课程不消失');
await clearCatalogMeta();                       // 只丢目录（模拟 meta 被清 / 数据损坏）
await page.reload();
await page.waitForSelector('.course');
names = await catalogNames();
assert(names.length === 2, '镜像恢复：2 门课程都在（' + names.join('、') + '）');
await clearCatalogMeta();
await page.evaluate(() => localStorage.removeItem('wqppt_catalog_mirror'));  // 镜像也没了
await page.reload();
await page.waitForSelector('.course');
const rebuilt = await page.evaluate(() => window.QingquLocal.getCatalog().then((c) => c.courses.map((x) => ({
  name: x.name,
  lessons: x.lessons.map((l) => l.name + (l.note ? '/note' : '') + '/p' + l.pages).sort(),
}))));
const jia = rebuilt.find((x) => x.name === 'zz课程甲');
assert(rebuilt.length === 2 && jia && jia.lessons.length === 2, '按文件重建：课程与课次从 files 存储找回');
assert(Boolean(jia) && jia.lessons.includes('zz课次一/note/p1'), '课次保留 note 标记与页数（' + (jia ? jia.lessons.join(' | ') : '') + '）');
assert(Boolean(jia) && !jia.lessons.some((l) => l.startsWith('zz课程甲')), '课程索引没被当成课次');

console.log('\n[6] 全部删除（课程乙）——内容与学习记录一并清掉');
await page.locator('.course', { hasText: 'zz课程乙' }).locator('.course-del').click();
await page.waitForFunction(() => !!document.getElementById('qzSheet'));
await page.click('#qzSheet .qz-sheet-acts .btn:has-text("全部删除")');
await page.waitForFunction(async () => !(await window.QingquLocal.getCatalog()).courses.some((x) => x.name === 'zz课程乙'), null, { timeout: 15000 });
assert((await counts('notes/zz课程乙/')) === 0 && (await counts('images/zz课程乙/')) === 0, '课程乙内容已清空');
assert((await counts('progress/zz课程乙/')) === 0, '课程乙学习记录一并删除');

console.log('\n[7] 数据管理：占用统计 + 清空全部数据（清掉后不会被自愈复活）');
await page.evaluate(() => localStorage.setItem('wqppt_ai_config', JSON.stringify({ baseUrl: 'http://127.0.0.1:9', model: 'zz', apiKey: 'zz' })));
await page.click('#btnData');
await page.waitForFunction(() => !!document.getElementById('qzSheet'));
await page.waitForFunction(() => !/统计中/.test(document.getElementById('qzSheet').textContent));
const dmText = await page.textContent('#qzSheet');
assert(/共 \d+ 门课程/.test(dmText) && /zz课程甲/.test(dmText), '数据管理列出课程与占用');
await shot('sheet-data');
await page.click('#qzSheet .qz-sheet-acts .btn:has-text("清空全部数据")');
await page.waitForFunction(() => /清空全部数据/.test(document.getElementById('qzSheet').textContent));
await page.click('#qzSheet .qz-sheet-acts .btn:has-text("确认清空")');
await page.waitForFunction(async () => {
  const c = await window.QingquLocal.getCatalog();
  return !c || !(c.courses || []).length;
}, null, { timeout: 15000 });
assert((await page.evaluate(() => window.QingquLocal.listFiles('').then((a) => a.length))) === 0, 'files 存储已清空');
assert((await page.evaluate(() => localStorage.getItem('wqppt_catalog_mirror'))) === null, '目录镜像一并清除');
assert((await page.evaluate(() => localStorage.getItem('wqppt_ai_config'))) !== null, 'AI 接口设置保留');
await page.reload();
await page.waitForSelector('.empty');
assert((await page.textContent('#catalog')).includes('还没有内容'), '重载后仍是空状态（不会复活旧目录）');

console.log('\n[8] 控制台错误检查');
assert(errors.length === 0, '无页面报错' + (errors.length ? '：' + errors.join(' | ') : ''));

await browser.close();
server.close();
console.log('\n' + (failed ? '✗ 失败 ' + failed + ' 项' : '✓ 全部通过'));
process.exit(failed ? 1 : 0);
