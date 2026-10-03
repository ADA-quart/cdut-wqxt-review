/**
 * 问渠学堂 PPT 下载器 — 本地服务
 *
 * 端点：
 *   GET  /api/status           浏览器/登录状态
 *   POST /api/login            触发登录（在真实 Edge 窗口里完成）
 *   GET  /api/courses          我的课程列表
 *   GET  /api/courses/:id/subs 课程课次列表
 *   GET  /api/subs/:courseId/:subId/ppt  课次 PPT 图片清单
 *   POST /api/jobs             创建下载任务 {mode:'course'|'all', courseId}
 *   GET  /api/jobs             任务列表
 *   GET  /api/jobs/:id         任务详情
 *   POST /api/jobs/:id/cancel  取消任务
 *   GET  /api/events           SSE 进度推送
 *   GET  /api/logout           退出登录（清空页面会话）
 * 静态资源：public/
 * 下载目录：downloads/（可通过 /files/* 浏览与预览）
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { DOWNLOAD_DIR, PUBLIC_DIR, ensureDir } from './paths.mjs';
import { checkLogin, login, listMyCourses, listCourseSubs, listSubPpt, listTerms } from './wqxt.mjs';
import { createJob, listJobs, getJob, cancelJob, events } from './downloader.mjs';
import {
  createMdJob, listMdJobs, getMdJob, cancelMdJob, mdToolStatus,
  events as mdEvents,
} from './mdconvert.mjs';
import { closeBrowser, edgeStatus, getWorkPage, WQ_BASE } from './browser.mjs';

const PORT = Number(process.env.PORT || 3901);
const app = express();
app.use(express.json({ limit: '1mb' }));

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- 状态与登录 ----------

app.get('/api/status', asyncRoute(async (_req, res) => {
  const status = { ...edgeStatus(), site: WQ_BASE };
  try {
    const s = await checkLogin();
    Object.assign(status, s);
  } catch (e) {
    status.loggedIn = false;
    status.error = String(e.message || e);
  }
  res.json(status);
}));

app.post('/api/login', asyncRoute(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入学号和密码' });
  const result = await login(username, password);
  if (!result.ok) return res.status(401).json({ error: result.error || '登录失败' });
  res.json(result);
}));

app.post('/api/logout', asyncRoute(async (_req, res) => {
  const page = await getWorkPage();
  await page.goto(WQ_BASE + '/logout', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  res.json({ ok: true });
}));

// ---------- 课程数据 ----------

app.get('/api/terms', asyncRoute(async (_req, res) => {
  res.json({ terms: await listTerms() });
}));

app.get('/api/courses', asyncRoute(async (req, res) => {
  const monthsBack = Math.min(Math.max(Number(req.query.months) || 12, 1), 24);
  const months = [];
  const now = new Date();
  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  res.json({ courses: await listMyCourses({ months }) });
}));

app.get('/api/courses/:id/subs', asyncRoute(async (req, res) => {
  res.json({ subs: await listCourseSubs(req.params.id) });
}));

app.get('/api/subs/:courseId/:subId/ppt', asyncRoute(async (req, res) => {
  res.json({ images: await listSubPpt(req.params.courseId, req.params.subId) });
}));

// ---------- 下载任务 ----------

app.post('/api/jobs', asyncRoute(async (req, res) => {
  const { mode = 'course', courseId, subId, monthsBack = 12 } = req.body || {};
  if ((mode === 'course' || mode === 'sub') && !courseId) return res.status(400).json({ error: '缺少 courseId' });
  if (mode === 'sub' && !subId) return res.status(400).json({ error: '缺少 subId' });
  const job = await createJob({ mode, courseId, subId, monthsBack });
  res.status(201).json({ job });
}));

app.get('/api/jobs', (_req, res) => res.json({ jobs: listJobs() }));

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json({ job });
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = cancelJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json({ job });
});

// ---------- PPT → Markdown 转换 ----------

app.get('/api/md-tools', (_req, res) => res.json(mdToolStatus()));

app.post('/api/md-jobs', asyncRoute(async (req, res) => {
  const { dir, device = 'auto' } = req.body || {};
  if (!dir) return res.status(400).json({ error: '缺少 dir（downloads 下的相对目录）' });
  const job = createMdJob({ dir, device });
  res.status(201).json({ job });
}));

app.get('/api/md-jobs', (_req, res) => res.json({ jobs: listMdJobs() }));

app.get('/api/md-jobs/:id', (req, res) => {
  const job = getMdJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json({ job });
});

app.post('/api/md-jobs/:id/cancel', (req, res) => {
  const job = cancelMdJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json({ job });
});

// ---------- SSE 进度 ----------

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('data: ' + JSON.stringify({ type: 'hello', jobs: listJobs() }) + '\n\n');
  res.write('data: ' + JSON.stringify({ type: 'hello-md', jobs: listMdJobs() }) + '\n\n');
  const onUpdate = (job) => res.write('data: ' + JSON.stringify({ type: 'job', job }) + '\n\n');
  const onMdUpdate = (job) => res.write('data: ' + JSON.stringify({ type: 'md-job', job }) + '\n\n');
  events.on('update', onUpdate);
  mdEvents.on('update', onMdUpdate);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(keepAlive);
    events.off('update', onUpdate);
    mdEvents.off('update', onMdUpdate);
  });
});

// ---------- 已下载文件浏览 ----------

ensureDir(DOWNLOAD_DIR);

app.get('/api/files', asyncRoute(async (_req, res) => {
  res.json({ tree: readTree(DOWNLOAD_DIR, 3) });
}));

function readTree(dir, depth) {
  if (depth < 0) return [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => !e.name.startsWith('.'))
    .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name, 'zh') : a.isDirectory() ? -1 : 1))
    .map((e) => {
      const full = path.join(dir, e.name);
      const rel = path.relative(DOWNLOAD_DIR, full).split(path.sep).join('/');
      if (e.isDirectory()) {
        // 同名 .md 存在 = 这个课次已转过 Markdown
        const hasMd = fs.existsSync(full + '.md');
        return { name: e.name, type: 'dir', rel, hasMd, children: readTree(full, depth - 1) };
      }
      const stat = fs.statSync(full);
      return {
        name: e.name, type: 'file', size: stat.size, rel,
        url: '/files/' + rel.split('/').map(encodeURIComponent).join('/'),
      };
    });
}

// 静态文件预览（downloads 目录，防目录穿越）
app.use('/files', (req, res, next) => {
  const rel = decodeURIComponent(req.path).replace(/^\/+/, '');
  const full = path.resolve(DOWNLOAD_DIR, rel);
  const relCheck = path.relative(DOWNLOAD_DIR, full);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) return res.status(403).end();
  if (fs.existsSync(full) && fs.statSync(full).isFile()) return res.sendFile(full);
  next();
});

app.use(express.static(PUBLIC_DIR));

// 统一错误处理
app.use((err, _req, res, _next) => {
  console.error('[api error]', err);
  res.status(500).json({ error: String(err?.message || err) });
});

const server = app.listen(PORT, () => {
  console.log(`问渠学堂 PPT 下载器已启动: http://127.0.0.1:${PORT}`);
});

async function shutdown() {
  console.log('\n正在关闭...');
  server.close();
  await closeBrowser();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
