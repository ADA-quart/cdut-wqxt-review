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
import { spawn } from 'node:child_process';
import { DOWNLOAD_DIR, PUBLIC_DIR, ROOT_DIR, ensureDir, ensureInside } from './paths.mjs';
import { checkLogin, login, listMyCourses, listCourseSubs, listSubPpt, listTerms } from './wqxt.mjs';
import { createJob, listJobs, getJob, cancelJob, events } from './downloader.mjs';
import {
  createMdJob, listMdJobs, getMdJob, cancelMdJob, mdToolStatus,
  findPython, events as mdEvents,
} from './mdconvert.mjs';
import { publicConfig, saveConfig } from './config.mjs';
import { streamChat } from './chat.mjs';
import { searchKb, buildGraph, listTags, getPreview } from './kb.mjs';
import { listCards, dueCount, addCard, addCards, gradeCard, deleteCard, exportCards } from './cards.mjs';
import {
  createLlmJob, listLlmJobs, getLlmJob, cancelLlmJob,
  testProfile, expandQuery, generateQaCards, feynmanReview,
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
  const valid = new Set(data.frames.filter((f) => !f.keep).map((f) => f.name));
  data.restore = restore.filter((n) => valid.has(n));
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');
  res.json({ ok: true, restoreCount: data.restore.length });
}));

// ---------- LLM 配置与文档操作（纠错 / 总结） ----------

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
          rel: path.relative(DOWNLOAD_DIR, full).split(path.sep).join('/'),
          name: e.name,
          snippet,
        });
      }
    }
  };
  walk(DOWNLOAD_DIR);
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
  const mdPath = path.join(DOWNLOAD_DIR, course, lesson + '.md');
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
      const mdPath = path.join(DOWNLOAD_DIR, course, lessonName + '.md');
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
  let absDir = ensureInside(DOWNLOAD_DIR, path.join(DOWNLOAD_DIR, relDir));
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    return res.status(404).json({ error: `目录不存在：${relDir}` });
  }

  const lessonsOf = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .filter((name) => fs.existsSync(path.join(dir, `${name}.md`)))
    .sort((a, b) => a.localeCompare(b, 'zh'));

  let lessons = lessonsOf(absDir);
  if (lessons.length === 0) {
    // 允许传课次目录：自动上溯一层到课程目录
    const parent = path.dirname(absDir);
    if (parent !== DOWNLOAD_DIR && parent.startsWith(DOWNLOAD_DIR + path.sep)) {
      const fromParent = lessonsOf(parent);
      if (fromParent.length > 0) {
        absDir = parent;
        lessons = fromParent;
      }
    }
  }
  if (lessons.length === 0) {
    return res.status(400).json({
      error: `「${path.basename(absDir)}」下没有已转 MD 的课次；请传课程目录（例如 downloads/<课程名>）`,
    });
  }

  const courseName = path.basename(absDir);
  const outPath = path.join(absDir, `${courseName}.md`);

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
    rel: path.relative(DOWNLOAD_DIR, outPath).split(path.sep).join('/'),
    lessons: lessons.length,
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
