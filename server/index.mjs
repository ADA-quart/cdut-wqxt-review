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
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import AdmZip from 'adm-zip';
import {
  DOWNLOAD_DIR, DATA_DIR, NOTES_DIR, PUBLIC_DIR, ROOT_DIR,
  ensureDir, ensureInside, getPaths, applyPathSettings, mdPathOf,
} from './paths.mjs';
import { checkLogin, login, listMyCourses, listCourseSubs, listSubPpt, listTerms } from './wqxt.mjs';
import { createJob, listJobs, getJob, cancelJob, events } from './downloader.mjs';
import {
  createMdJob, listMdJobs, getMdJob, cancelMdJob, mdToolStatus,
  findPython, events as mdEvents,
} from './mdconvert.mjs';
import { publicConfig, saveConfig, loadConfig } from './config.mjs';
import { streamChat } from './chat.mjs';
import { searchKb, buildGraph, listTags, getPreview, listCourses, listLessons } from './kb.mjs';
import { autoParallel } from './gpu.mjs';
import { listCards, dueCount, addCard, addCards, gradeCard, deleteCard, exportCards } from './cards.mjs';
import {
  createLlmJob, listLlmJobs, getLlmJob, cancelLlmJob,
  testProfile, expandQuery, generateQaCards, feynmanReview, listModels, getCaps,
  events as llmEvents,
} from './llm.mjs';
import {
  closeBrowser, edgeStatus, getWorkPage, WQ_BASE,
  showBrowserWindow, hideBrowserWindow, browserWindowVisible,
} from './browser.mjs';

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
  // 登录可能需要输验证码 → 先把 Edge 窗口唤到屏幕上
  await showBrowserWindow();
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
  const termId = req.query.term;
  if (termId) {
    // 按学期查询：自动换算学期起止月份
    res.json({ courses: await listMyCourses({ termId }) });
    return;
  }
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

/** Edge 窗口控制：平时躲在屏幕外，需要输验证码/手动操作时唤出 */
app.post('/api/browser/show', asyncRoute(async (_req, res) => {
  res.json(await showBrowserWindow());
}));

app.post('/api/browser/hide', asyncRoute(async (_req, res) => {
  res.json(await hideBrowserWindow());
}));

app.get('/api/browser/window', (_req, res) => {
  res.json({ visible: browserWindowVisible() });
});

app.post('/api/jobs', asyncRoute(async (req, res) => {
  const { mode = 'course', courseId, subId, monthsBack = 12, termId } = req.body || {};
  if ((mode === 'course' || mode === 'sub') && !courseId) return res.status(400).json({ error: '缺少 courseId' });
  if (mode === 'sub' && !subId) return res.status(400).json({ error: '缺少 subId' });
  const job = await createJob({ mode, courseId, subId, monthsBack, termId });
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

// ---------- 图片清洗（去重预检 / 人工复核） ----------

/** 跑 dedup.py，解析它输出的 JSON 摘要 */
function runDedupScan(absDir) {
  const python = findPython();
  if (!python) throw new Error('未找到 Python 环境（先运行 setup-p2t.ps1）');
  const script = path.join(ROOT_DIR, 'dedup.py');
  if (!fs.existsSync(script)) throw new Error('缺少 dedup.py');

  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, absDir, '--json'], {
      cwd: ROOT_DIR,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('清洗分析超时')); }, 180000);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error((err || out || `退出码 ${code}`).slice(-300)));
      const line = out.trim().split('\n').filter(Boolean).pop();
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error('清洗结果解析失败：' + out.slice(-200)));
      }
    });
  });
}

app.post('/api/dedup-scan', asyncRoute(async (req, res) => {
  const relDir = String(req.body?.dir || '').replace(/^[/\\]+/, '');
  if (!relDir) return res.status(400).json({ error: '缺少 dir' });
  const absDir = ensureInside(DOWNLOAD_DIR, path.join(DOWNLOAD_DIR, relDir));
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    return res.status(404).json({ error: `目录不存在：${relDir}` });
  }
  const summary = await runDedupScan(absDir);
  const reportRel = path.relative(DOWNLOAD_DIR, summary.report).split(path.sep).join('/');
  res.json({
    lesson: summary.lesson,
    total: summary.total,
    kept: summary.kept,
    removed: summary.removed,
    restored: summary.restored,
    report: '/files/' + reportRel.split('/').map(encodeURIComponent).join('/'),
  });
}));

app.post('/api/dedup-decisions', asyncRoute(async (req, res) => {
  const relDir = String(req.body?.dir || '').replace(/^[/\\]+/, '');
  const restore = Array.isArray(req.body?.restore) ? req.body.restore.map(String) : [];
  if (!relDir) return res.status(400).json({ error: '缺少 dir' });
  const absDir = ensureInside(DOWNLOAD_DIR, path.join(DOWNLOAD_DIR, relDir));
  const jsonPath = path.join(path.dirname(absDir), `${path.basename(absDir)}.dedup.json`);
  if (!fs.existsSync(jsonPath)) return res.status(404).json({ error: '还没有清洗数据，请先执行「清洗」' });

  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const lessonDir = absDir;
  const trashDir = path.join(path.dirname(absDir), '_回收站', path.basename(absDir));
  ensureDir(trashDir);

  const valid = new Set(data.frames.filter((f) => !f.keep).map((f) => f.name));
  const nextRestore = restore.filter((n) => valid.has(n));
  const prev = new Set(data.restore || []);
  const next = new Set(nextRestore);

  // 勾选恢复 → 从回收站搬回课次目录；取消勾选 → 再丢回回收站
  const restored = [];
  const reTrashed = [];
  for (const name of next) {
    if (prev.has(name)) continue;
    const from = path.join(trashDir, name);
    const to = path.join(lessonDir, name);
    if (fs.existsSync(from) && !fs.existsSync(to)) { fs.renameSync(from, to); restored.push(name); }
  }
  for (const name of prev) {
    if (next.has(name)) continue;
    const from = path.join(lessonDir, name);
    const to = path.join(trashDir, name);
    if (fs.existsSync(from) && !fs.existsSync(to)) { fs.renameSync(from, to); reTrashed.push(name); }
  }

  data.restore = nextRestore;
  const trashedSet = new Set(data.frames.filter((f) => !f.keep && !next.has(f.name)).map((f) => f.name));
  for (const f of data.frames) {
    f.restored = Boolean(!f.keep && next.has(f.name));
    f.trashed = trashedSet.has(f.name);
  }
  const keptCount = data.frames.filter((f) => f.keep || f.restored).length;
  data.keptCount = keptCount;
  data.removedCount = data.total - keptCount;
  data.trash = { dir: trashDir, moved: trashedSet.size, names: [...trashedSet] };
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');
  res.json({
    ok: true,
    restoreCount: nextRestore.length,
    movedBack: restored.length,
    movedToTrash: reTrashed.length,
    kept: keptCount,
    removed: data.removedCount,
    trashDir,
  });
}));

// ---------- LLM 配置与文档操作（纠错 / 总结） ----------

/** 转 MD 相关配置（并行度：auto 或 1~4） */
app.get('/api/md-config', asyncRoute(async (_req, res) => {
  const cfg = loadConfig();
  res.json({ parallel: cfg.md?.parallel ?? 'auto', resolved: await autoParallel() });
}));

app.put('/api/md-config', asyncRoute(async (req, res) => {
  const raw = req.body?.parallel;
  const parallel = raw === 'auto' ? 'auto' : Math.min(Math.max(Number(raw) || 1, 1), 4);
  saveConfig({ md: { parallel } });
  res.json({ parallel, resolved: await autoParallel() });
}));

/** 当前模型的能力（上下文 / 最大输出），能自动获取就返回真值 */
app.get('/api/llm-limits', (req, res) => {
  const profile = String(req.query.profile || 'text');
  try {
    res.json(getCaps(profile));
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get('/api/llm-config', (_req, res) => res.json(publicConfig()));

app.put('/api/llm-config', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const patch = { llm: {} };
  if (body.profiles && typeof body.profiles === 'object') {
    patch.llm.profiles = {};
    for (const [key, prof] of Object.entries(body.profiles)) {
      if (!prof || typeof prof !== 'object') continue;
      const p = {};
      if (typeof prof.baseUrl === 'string') p.baseUrl = prof.baseUrl.trim();
      if (typeof prof.model === 'string') p.model = prof.model.trim();
      if ('apiKey' in prof) p.apiKey = prof.apiKey === null ? null : String(prof.apiKey).trim();
      patch.llm.profiles[key] = p;
    }
  }
  if (body.temperature !== undefined) patch.llm.temperature = Number(body.temperature) || 0;
  if (body.concurrency !== undefined) patch.llm.concurrency = Math.min(Math.max(Number(body.concurrency) || 3, 1), 8);
  if (body.defaultMode !== undefined) patch.llm.defaultMode = body.defaultMode;
  saveConfig(patch);
  res.json(publicConfig());
}));

app.post('/api/llm-test', asyncRoute(async (req, res) => {
  const { profile } = req.body || {};
  const r = await testProfile(profile || 'text');
  res.json(r);
}));

/** 自动获取模型列表（GET {baseUrl}/models，OpenAI 兼容） */
app.post('/api/llm-models', asyncRoute(async (req, res) => {
  const { profile, baseUrl, apiKey } = req.body || {};
  const override = {};
  if (baseUrl) override.baseUrl = String(baseUrl).trim();
  if (apiKey) override.apiKey = String(apiKey);
  const key = profile || 'text';
  const models = await listModels(key, override);
  res.json({ models, caps: getCaps(key) });
}));

app.post('/api/llm-jobs', asyncRoute(async (req, res) => {
  const { op, dir, mode, scope } = req.body || {};
  if (!op) return res.status(400).json({ error: '缺少 op' });
  if (op !== 'weave' && !dir) return res.status(400).json({ error: '缺少 dir' });
  if (op === 'weave' && scope !== 'all' && !dir) return res.status(400).json({ error: '缺少 dir' });
  const job = createLlmJob({ op, dir, mode, scope });
  res.status(201).json({ job });
}));

app.get('/api/llm-jobs', (_req, res) => res.json({ jobs: listLlmJobs() }));

app.get('/api/llm-jobs/:id', (req, res) => {
  const job = getLlmJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json({ job });
});

app.post('/api/llm-jobs/:id/cancel', (req, res) => {
  const job = cancelLlmJob(Number(req.params.id));
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
  res.write('data: ' + JSON.stringify({ type: 'hello-llm', jobs: listLlmJobs() }) + '\n\n');
  const onUpdate = (job) => res.write('data: ' + JSON.stringify({ type: 'job', job }) + '\n\n');
  const onMdUpdate = (job) => res.write('data: ' + JSON.stringify({ type: 'md-job', job }) + '\n\n');
  const onLlmUpdate = (job) => res.write('data: ' + JSON.stringify({ type: 'llm-job', job }) + '\n\n');
  events.on('update', onUpdate);
  mdEvents.on('update', onMdUpdate);
  llmEvents.on('update', onLlmUpdate);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(keepAlive);
    events.off('update', onUpdate);
    mdEvents.off('update', onMdUpdate);
    llmEvents.off('update', onLlmUpdate);
  });
});

// ---------- 已下载文件浏览 ----------

ensureDir(DOWNLOAD_DIR);
ensureDir(NOTES_DIR);

app.get('/api/files', asyncRoute(async (_req, res) => {
  res.json({ tree: readTree(DOWNLOAD_DIR, 3) });
}));

function readTree(dir, depth) {
  if (depth < 0) return [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  // 辅助文件不上树（复核页/去重决策/纠错备份/卡片数据），避免看着一头雾水
  const HIDDEN = /\.(dedup\.(json|html)|ocr-backup\.md|cards\.json)$/i;
  return entries
    .filter((e) => !e.name.startsWith('.') && !HIDDEN.test(e.name))
    .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name, 'zh') : a.isDirectory() ? -1 : 1))
    .map((e) => {
      const full = path.join(dir, e.name);
      const rel = path.relative(DOWNLOAD_DIR, full).split(path.sep).join('/');
      if (e.isDirectory()) {
        // 同名 .md 存在（在笔记目录里）= 这个课次已转过 Markdown
        const hasMd = fs.existsSync(path.join(NOTES_DIR, `${rel}.md`));
        const hasDedup = fs.existsSync(path.join(DATA_DIR, `${rel}.dedup.html`));
        return { name: e.name, type: 'dir', rel, hasMd, hasDedup, children: readTree(full, depth - 1) };
      }
      const stat = fs.statSync(full);
      return {
        name: e.name, type: 'file', size: stat.size, rel,
        url: '/files/' + rel.split('/').map(encodeURIComponent).join('/'),
      };
    });
}

// 静态文件预览（防目录穿越）
//   /files  → 数据目录（PPT 图片、去冗报告）
//   /notes  → 笔记目录（Markdown / PDF / assets；默认与数据目录相同）
function staticDirHandler(baseDir) {
  return (req, res, next) => {
    const rel = decodeURIComponent(req.path).replace(/^\/+/, '');
    const full = path.resolve(baseDir, rel);
    const relCheck = path.relative(baseDir, full);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) return res.status(403).end();
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return res.sendFile(full);
    next();
  };
}

app.use('/files', (req, res, next) => staticDirHandler(DATA_DIR)(req, res, next));
app.use('/notes', (req, res, next) => staticDirHandler(NOTES_DIR)(req, res, next));

app.use(express.static(PUBLIC_DIR));

// 前端渲染库（marked / KaTeX），直接从 node_modules 提供
app.use('/vendor/marked', express.static(path.join(ROOT_DIR, 'node_modules/marked/lib')));
app.use('/vendor/katex', express.static(path.join(ROOT_DIR, 'node_modules/katex/dist')));

// ---------- 复习工作台：对话 / 反链 / 课程索引 ----------

app.post('/api/chat', asyncRoute(async (req, res) => {
  const { messages, profile = 'text', temperature } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: '缺少 messages' });
  }
  const trimmed = messages
    .filter((m) => m && typeof m.content === 'string' && ['system', 'user', 'assistant'].includes(m.role))
    .slice(-24);

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  try {
    await streamChat({ messages: trimmed, profile, temperature }, (delta) => res.write(delta));
    res.end();
  } catch (e) {
    res.write(`\n[错误] ${String(e?.message || e)}`);
    res.end();
  }
}));

/** 反链：扫描 downloads 下所有 .md，找引用某课次的 wiki 链接 */
app.get('/api/backlinks', asyncRoute(async (req, res) => {
  const relDir = String(req.query.dir || '').replace(/^[/\\]+/, '');
  if (!relDir) return res.status(400).json({ error: '缺少 dir' });
  const target = path.basename(relDir);
  const results = [];
  const MAX_FILES = 500;
  let scanned = 0;

  const walk = (dir) => {
    if (scanned > MAX_FILES || results.length >= 20) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length >= 20 || scanned > MAX_FILES) return;
      if (e.name.startsWith('.') || e.name.endsWith('_assets')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.toLowerCase().endsWith('.md')) continue;
      if (e.name === `${target}.md`) continue;
      scanned++;
      let text = '';
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      const re = /\[\[([^\]]+)\]\]/g;
      let m;
      let snippet = null;
      while ((m = re.exec(text))) {
        const linkTarget = m[1].split('|')[0].split('#')[0].trim();
        const base = path.basename(linkTarget).replace(/\.md$/i, '');
        if (base === target) {
          const idx = Math.max(0, m.index - 40);
          snippet = text.slice(idx, Math.min(text.length, m.index + m[0].length + 60)).replace(/\s+/g, ' ');
          break;
        }
      }
      if (snippet) {
        results.push({
          rel: path.relative(NOTES_DIR, full).split(path.sep).join('/'),
          name: e.name,
          snippet,
        });
      }
    }
  };
  walk(NOTES_DIR);
  res.json({ backlinks: results });
}));

/** 知识库检索（全库问答用）：按课程/课次/全库返回最相关的页片段；smart=LLM 语义扩展 */
app.post('/api/kb/search', asyncRoute(async (req, res) => {
  const { q, scope = 'all', dir = '', topK, smart } = req.body || {};
  const query = String(q || '').trim();
  if (!query) return res.status(400).json({ error: '缺少 q' });
  const useScope = ['lesson', 'course', 'all'].includes(scope) ? scope : 'all';

  let expanded = [];
  if (smart !== false && useScope !== 'lesson') {
    try { expanded = await expandQuery(query); } catch { expanded = []; }
  }
  const result = searchKb({
    q: expanded.length ? `${query} ${expanded.join(' ')}` : query,
    scope: useScope,
    dir: String(dir || '').replace(/^[/\\]+/, ''),
    topK: Number(topK) || 6,
  });
  res.json({ ...result, expanded });
}));

/** 知识图谱：课程 / 课次 / 双链 节点与边 */
app.get('/api/graph', asyncRoute(async (_req, res) => {
  res.json(buildGraph());
}));

/** 全库 #标签 汇总 */
app.get('/api/tags', asyncRoute(async (_req, res) => {
  res.json({ tags: listTags() });
}));

/** 悬浮预览：课次摘要 + 首图 */
app.get('/api/preview', asyncRoute(async (req, res) => {
  const p = getPreview(String(req.query.dir || '').replace(/^[/\\]+/, ''));
  if (!p) return res.status(404).json({ error: '没有这个课次的 Markdown' });
  res.json(p);
}));

/** 复习卡（间隔重复） */
app.get('/api/cards', asyncRoute(async (req, res) => {
  const dir = String(req.query.dir || '').replace(/^[/\\]+/, '');
  const dueOnly = req.query.due === '1';
  const limit = Number(req.query.limit) || 0;
  res.json({ cards: listCards({ dir, dueOnly, limit }), dueCount: dueCount() });
}));

app.post('/api/cards', asyncRoute(async (req, res) => {
  const { dir, page, kind, text, front, back } = req.body || {};
  if (!dir) return res.status(400).json({ error: '缺少 dir' });
  const card = addCard({ dir: String(dir), page, kind: kind || 'star', text, front, back });
  res.status(201).json({ card, dueCount: dueCount() });
}));

app.post('/api/cards/:id/grade', asyncRoute(async (req, res) => {
  const grade = String(req.body?.grade || 'good');
  const card = gradeCard(String(req.params.id), grade);
  if (!card) return res.status(404).json({ error: '卡片不存在' });
  res.json({ card, dueCount: dueCount() });
}));

app.delete('/api/cards/:id', asyncRoute(async (req, res) => {
  const removed = deleteCard(String(req.params.id));
  if (!removed) return res.status(404).json({ error: '卡片不存在' });
  res.json({ ok: true, dueCount: dueCount() });
}));

/** AI 出题：把某一页（或整节）转成问答卡并入库 */
app.post('/api/cards/gen-qa', asyncRoute(async (req, res) => {
  const { dir, page, count } = req.body || {};
  if (!dir) return res.status(400).json({ error: '缺少 dir' });
  const rel = String(dir).replace(/^[/\\]+/, '');
  const parts = rel.split('/');
  if (parts.length < 2) return res.status(400).json({ error: 'dir 需要是 课程/课次' });
  const [course, lesson] = parts;
  const mdPath = mdPathOf(course, lesson);
  if (!fs.existsSync(mdPath)) return res.status(404).json({ error: '先对该课次「转 MD」' });
  const md = fs.readFileSync(mdPath, 'utf8');
  const marks = [...md.matchAll(/<!-- page (\d+): [^>]+ -->/g)];
  let text = md;
  let pageNo = null;
  if (page) {
    const i = marks.findIndex((m) => Number(m[1]) === Number(page));
    if (i < 0) text = '';
    else {
      const start = marks[i].index + marks[i][0].length;
      const end = i + 1 < marks.length ? marks[i + 1].index : md.length;
      text = md.slice(start, end);
      pageNo = Number(page);
    }
  } else {
    text = md.replace(/<!-- page \d+: [^>]+ -->/g, '\n');
  }
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ').trim();
  if (!text) return res.status(404).json({ error: page ? `md 里没有第 ${page} 页` : '内容为空' });
  const items = await generateQaCards(text, { count: Number(count) || 3, lesson: `${course} / ${lesson}`, page: pageNo });
  if (!items.length) return res.json({ added: 0, cards: [] });
  const added = addCards(rel, items);
  res.json({ added, cards: items, dueCount: dueCount() });
}));

/** 费曼回评：学生复述 → 缺漏/纠错/追问 */
app.post('/api/cards/feynman', asyncRoute(async (req, res) => {
  const { dir, page, cardId, answer } = req.body || {};
  const studentText = String(answer || '').trim();
  if (!studentText) return res.status(400).json({ error: '缺少 answer（你的复述）' });
  let sourceText = '';
  let lesson = '';
  let pageNo = page ? Number(page) : null;
  if (cardId) {
    const card = listCards({}).find((c) => c.id === String(cardId));
    if (card) {
      sourceText = card.back || card.text || '';
      pageNo = card.page ?? pageNo;
      lesson = `${card.dir.split('/').join(' / ')}`;
    }
  }
  if (!sourceText && dir) {
    const rel = String(dir).replace(/^[/\\]+/, '');
    const parts = rel.split('/');
    if (parts.length >= 2) {
      const [course, lessonName] = parts;
      const mdPath = mdPathOf(course, lessonName);
      if (fs.existsSync(mdPath)) {
        const md = fs.readFileSync(mdPath, 'utf8');
        const marks = [...md.matchAll(/<!-- page (\d+): [^>]+ -->/g)];
        if (pageNo != null) {
          const i = marks.findIndex((m) => Number(m[1]) === pageNo);
          if (i >= 0) {
            const start = marks[i].index + marks[i][0].length;
            const end = i + 1 < marks.length ? marks[i + 1].index : md.length;
            sourceText = md.slice(start, end);
          }
        } else {
          sourceText = md.replace(/<!-- page \d+: [^>]+ -->/g, '\n');
        }
        lesson = `${course} / ${lessonName}`;
      }
    }
  }
  sourceText = sourceText.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ').trim();
  if (!sourceText) return res.status(404).json({ error: '找不到用于对照的课件内容' });
  const review = await feynmanReview(sourceText, studentText, { lesson, page: pageNo });
  res.json(review);
}));

app.get('/api/cards/export', asyncRoute(async (req, res) => {
  const format = req.query.format === 'csv' ? 'csv' : 'md';
  const dir = String(req.query.dir || '').replace(/^[/\\]+/, '');
  const text = exportCards({ dir, format });
  res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="review-${Date.now()}.${format}"`);
  res.send('\uFEFF' + text);
}));

/** 生成/更新课程索引笔记（课程 → 课次的 wiki 链接） */
app.post('/api/index-note', asyncRoute(async (req, res) => {
  const relDir = String(req.body?.dir || '').replace(/^[/\\]+/, '');
  if (!relDir) return res.status(400).json({ error: '缺少 dir' });
  // 允许传课程目录或课次目录：都取第一段作为课程名
  const courseName = relDir.split('/').filter(Boolean)[0];
  if (!courseName) return res.status(400).json({ error: '缺少课程名' });
  const notesCourseDir = ensureInside(NOTES_DIR, path.join(NOTES_DIR, courseName));
  if (!fs.existsSync(notesCourseDir) || !fs.statSync(notesCourseDir).isDirectory()) {
    return res.status(404).json({ error: `笔记目录不存在：${courseName}（先对该课程「转 MD」）` });
  }

  const lessons = fs.readdirSync(notesCourseDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md')
      && e.name !== `${courseName}.md` && !e.name.includes('.ocr-backup.'))
    .map((e) => e.name.replace(/\.md$/i, ''))
    .sort((a, b) => a.localeCompare(b, 'zh'));
  if (lessons.length === 0) {
    return res.status(400).json({ error: `「${courseName}」下没有已转 MD 的课次` });
  }

  const outPath = path.join(notesCourseDir, `${courseName}.md`);

  // 保留「课程间知识链」写入的关联课程块，避免被规则版索引覆盖掉
  let related = '';
  if (fs.existsSync(outPath)) {
    const m = fs.readFileSync(outPath, 'utf8')
      .match(/<!-- llm-courses:start -->[\s\S]*?<!-- llm-courses:end -->/);
    if (m) related = `${m[0]}\n\n`;
  }

  const md = [
    `# ${courseName}`,
    '',
    ...(related ? [related.trimEnd(), ''] : []),
    '> 课程索引（自动生成）',
    '',
    ...lessons.map((l) => `- [[${l}]]`),
    '',
  ].join('\n');
  fs.writeFileSync(outPath, md, 'utf8');
  res.json({
    ok: true,
    rel: path.relative(NOTES_DIR, outPath).split(path.sep).join('/'),
    lessons: lessons.length,
  });
}));

// ---------- 目录设置（PPT 数据目录 / 笔记目录）----------

app.get('/api/paths', (_req, res) => {
  res.json(getPaths());
});

app.put('/api/paths', asyncRoute(async (req, res) => {
  const { dataDir, notesDir } = req.body || {};
  let applied;
  try {
    applied = applyPathSettings({
      dataDir: typeof dataDir === 'string' ? dataDir.trim() : undefined,
      notesDir: typeof notesDir === 'string' ? notesDir.trim() : undefined,
    });
  } catch (e) {
    return res.status(400).json({ error: `目录不可用：${e.message}` });
  }
  saveConfig({ paths: { dataDir: applied.dataDir, notesDir: applied.notesDir } });
  res.json(applied);
}));

/** 打开本机原生「选择文件夹」对话框（服务跑在本机，所以能弹系统框） */
function pickFolder(initial) {
  return new Promise((resolve) => {
    const start = initial || os.homedir();
    if (process.platform === 'win32') {
      const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
        "$d.Description = '选择文件夹'",
        `$d.SelectedPath = ${q(start)}`,
        '$d.ShowNewFolderButton = $true',
        "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }",
      ].join('; ');
      execFile('powershell', ['-NoProfile', '-STA', '-Command', ps],
        { timeout: 300000, windowsHide: true },
        (err, stdout) => resolve(err ? null : String(stdout || '').trim() || null));
      return;
    }
    if (process.platform === 'darwin') {
      const script = `POSIX path of (choose folder with prompt "选择文件夹" default location POSIX file ${JSON.stringify(start)})`;
      execFile('osascript', ['-e', script], { timeout: 300000 },
        (err, stdout) => resolve(err ? null : String(stdout || '').trim() || null));
      return;
    }
    resolve(null);
  });
}

app.post('/api/pick-folder', asyncRoute(async (req, res) => {
  const p = await pickFolder(String(req.body?.initial || ''));
  res.json(p ? { path: p } : { canceled: true });
}));

// ---------- 一键导出 / 导入（含未来手机端所需的结构）----------

const PKG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')); } catch { return {}; }
})();

function addFileToZip(zip, absPath, zipPath) {
  try {
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return false;
    zip.addFile(zipPath, fs.readFileSync(absPath));
    return true;
  } catch {
    return false;
  }
}

function addDirToZip(zip, absDir, zipPrefix) {
  let n = 0;
  const walk = (dir, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, `${prefix}${e.name}/`); continue; }
      if (addFileToZip(zip, full, `${prefix}${e.name}`)) n++;
    }
  };
  walk(absDir, zipPrefix);
  return n;
}

app.get('/api/export', asyncRoute(async (req, res) => {
  const includeImages = req.query.images === '1';
  const includePdf = req.query.pdf !== '0';
  const includeAssets = req.query.assets !== '0';
  const includeCards = req.query.cards !== '0';

  const zip = new AdmZip();
  const courses = [];
  const counts = { courses: 0, lessons: 0, notes: 0, pdfs: 0, assets: 0, cards: 0, images: 0 };

  for (const course of listCourses()) {
    const lessons = listLessons(course);
    const courseInfo = { name: course, lessons: [] };
    let any = false;

    // 课程索引
    if (addFileToZip(zip, path.join(NOTES_DIR, course, `${course}.md`), `notes/${course}/${course}.md`)) any = true;
    if (addFileToZip(zip, path.join(NOTES_DIR, '知识链.md'), 'notes/知识链.md')) any = true;

    for (const lesson of lessons) {
      const rel = `${course}/${lesson}`;
      const mdAbs = mdPathOf(course, lesson);
      if (!addFileToZip(zip, mdAbs, `notes/${rel}.md`)) continue;
      counts.notes++;
      const md = fs.readFileSync(mdAbs, 'utf8');
      const info = {
        name: lesson,
        pages: (md.match(/<!-- page \d+:/g) || []).length,
        chars: md.length,
        pdf: false,
        cards: 0,
      };
      if (includePdf && addFileToZip(zip, path.join(NOTES_DIR, `${rel}.pdf`), `notes/${rel}.pdf`)) {
        info.pdf = true;
        counts.pdfs++;
      }
      if (includeAssets) counts.assets += addDirToZip(zip, path.join(NOTES_DIR, `${rel}_assets`), `notes/${rel}_assets/`);
      if (includeCards) {
        const cardsAbs = path.join(DATA_DIR, '.review', `${rel}.json`);
        if (addFileToZip(zip, cardsAbs, `cards/${rel}.json`)) {
          try { info.cards = (JSON.parse(fs.readFileSync(cardsAbs, 'utf8')) || []).length; } catch { /* 忽略 */ }
          counts.cards += info.cards;
        }
      }
      if (includeImages) {
        const imgDir = path.join(DATA_DIR, course, lesson);
        let imgs = [];
        try {
          imgs = fs.readdirSync(imgDir).filter((f) => /\.(jpe?g|png|webp|bmp)$/i.test(f));
        } catch { /* 没有原图 */ }
        for (const f of imgs) {
          if (addFileToZip(zip, path.join(imgDir, f), `images/${rel}/${f}`)) counts.images++;
        }
        info.images = imgs.length;
      }
      courseInfo.lessons.push(info);
      counts.lessons++;
      any = true;
    }
    if (any) { courses.push(courseInfo); counts.courses++; }
  }

  const manifest = {
    app: 'wqppt',
    format: 1,
    version: PKG.version || '0.0.0',
    exportedAt: new Date().toISOString(),
    includes: { images: includeImages, pdf: includePdf, assets: includeAssets, cards: includeCards },
    paths: getPaths(),
    counts,
    courses,
    // 给未来的手机 / 平板客户端：课次 → 页 → 图片文件名
    pages: courses.flatMap((c) => c.lessons.map((l) => ({
      dir: `${c.name}/${l.name}`,
      course: c.name,
      lesson: l.name,
      pages: l.pages,
      pdf: l.pdf ? `notes/${c.name}/${l.name}.pdf` : null,
      md: `notes/${c.name}/${l.name}.md`,
    }))),
  };
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

  const buf = zip.toBuffer();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="wqppt-export-${stamp}.zip"`);
  res.setHeader('X-Export-Summary', encodeURIComponent(JSON.stringify(counts)));
  res.send(buf);
}));

app.post('/api/import', express.raw({ type: () => true, limit: '2048mb' }), asyncRoute(async (req, res) => {
  const overwrite = req.query.overwrite === '1';
  const body = req.body;
  if (!body || !body.length) return res.status(400).json({ error: '请求体为空（请上传导出的 .zip）' });

  let zip;
  try {
    zip = new AdmZip(body);
  } catch (e) {
    return res.status(400).json({ error: `不是有效的 zip：${e.message}` });
  }
  const entries = zip.getEntries();
  const hasManifest = entries.some((e) => e.entryName.replace(/\\/g, '/') === 'manifest.json');
  if (!hasManifest && req.query.force !== '1') {
    return res.status(400).json({ error: '缺少 manifest.json —— 这不像是 wqppt 导出的包（确实要导入请加 ?force=1）' });
  }

  let written = 0;
  let skipped = 0;
  const errors = [];
  for (const e of entries) {
    if (e.isDirectory) continue;
    const name = e.entryName.replace(/\\/g, '/');
    let target = null;
    if (name.startsWith('notes/')) {
      target = ensureInside(NOTES_DIR, path.join(NOTES_DIR, name.slice(6)));
    } else if (name.startsWith('images/')) {
      target = ensureInside(DATA_DIR, path.join(DATA_DIR, name.slice(7)));
    } else if (name.startsWith('cards/')) {
      target = ensureInside(DATA_DIR, path.join(DATA_DIR, '.review', name.slice(6)));
    } else {
      continue; // manifest.json 等元数据不入库
    }
    try {
      if (fs.existsSync(target) && !overwrite) { skipped++; continue; }
      ensureDir(path.dirname(target));
      fs.writeFileSync(target, e.getData());
      written++;
    } catch (err) {
      if (errors.length < 5) errors.push(`${name}: ${err.message}`);
    }
  }
  res.json({ ok: true, written, skipped, errors, paths: getPaths() });
}));

// ---------- 一键退出 / 一键升级 ----------

const runCmd = (file, args, opts = {}) => new Promise((resolve) => {
  execFile(file, args, { cwd: ROOT_DIR, timeout: 300000, windowsHide: true, ...opts },
    (err, stdout, stderr) => resolve({
      ok: !err,
      stdout: String(stdout || ''),
      stderr: String(stderr || ''),
      error: err ? String(err.message) : null,
    }));
});

const git = (args, opts) => runCmd('git', args, opts);

app.post('/api/system/shutdown', asyncRoute(async (_req, res) => {
  res.json({ ok: true, message: '服务正在退出…' });
  setTimeout(async () => {
    try { await closeBrowser(); } catch { /* 忽略 */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }, 300);
}));

app.get('/api/system/update-check', asyncRoute(async (_req, res) => {
  const inside = await git(['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return res.json({
      ok: false,
      reason: 'not-git',
      message: '当前目录不是 git 仓库（可能是解压 ZIP 安装的），无法自动升级；请到 GitHub 重新下载',
    });
  }
  const fetchRes = await git(['fetch', '--quiet', 'origin']);
  if (!fetchRes.ok) {
    return res.json({ ok: false, reason: 'fetch-failed', message: `拉取远程信息失败：${(fetchRes.stderr || fetchRes.error || '').slice(0, 200)}` });
  }
  const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!upstream.ok) {
    return res.json({ ok: false, reason: 'no-upstream', message: '当前分支没有配置远程上游，无法自动升级' });
  }
  const behind = await git(['rev-list', '--count', 'HEAD..@{u}']);
  const local = await git(['rev-parse', '--short', 'HEAD']);
  const remote = await git(['rev-parse', '--short', '@{u}']);
  const n = Number(behind.stdout.trim()) || 0;
  res.json({
    ok: true,
    behind: n,
    local: local.stdout.trim(),
    remote: remote.stdout.trim(),
    branch: upstream.stdout.trim(),
    message: n === 0 ? '已经是最新版本' : `有 ${n} 个新提交可以升级`,
  });
}));

app.post('/api/system/update', asyncRoute(async (_req, res) => {
  const inside = await git(['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return res.status(400).json({ error: '当前目录不是 git 仓库，无法自动升级' });
  }
  const before = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const pull = await git(['pull', '--ff-only']);
  if (!pull.ok) {
    return res.status(500).json({
      error: '升级失败（可能有本地改动冲突）',
      detail: (pull.stderr || pull.stdout || pull.error || '').slice(0, 500),
    });
  }
  const after = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const changed = await git(['diff', '--name-only', `${before}`, `${after}`]);
  const files = changed.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const needInstall = files.some((f) => f === 'package.json' || f === 'package-lock.json');

  let npmResult = null;
  if (needInstall) {
    npmResult = await runCmd(process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--no-audit', '--no-fund'], { shell: process.platform === 'win32' });
  }
  res.json({
    ok: true,
    updated: before !== after,
    commits: files.length,
    files: files.slice(0, 30),
    npm: npmResult ? { ok: npmResult.ok, output: (npmResult.stdout || npmResult.stderr || '').slice(-400) } : null,
    needRestart: true,
    message: before === after ? '已是最新版本' : '升级完成，重启程序后生效',
  });
}));

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
