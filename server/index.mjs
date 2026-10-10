/**
 * 问渠学堂 PPT 整理系统 — 本地服务（Express）。
 *
 * 路由全集见 README「API 一览」；静态资源 public/；数据目录 downloads/（经 /files、/notes 浏览）。
 * 三类任务：下载（downloader）/ 转 MD（mdconvert）/ LLM（llm），进度统一走 /api/events（SSE）。
 */
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import AdmZip from 'adm-zip';
import {
  DOWNLOAD_DIR, DATA_DIR, NOTES_DIR, PUBLIC_DIR, ROOT_DIR,
  ensureDir, ensureInside, getPaths, applyPathSettings, mdPathOf, sanitizeName,
} from './paths.mjs';
import { checkLogin, login, logout, listMyCourses, listCourseSubs, listSubPpt, listTerms, resolveLessonIds } from './wqxt.mjs';
import { createJob, listJobs, getJob, cancelJob, events } from './downloader.mjs';
import {
  createMdJob, listMdJobs, getMdJob, cancelMdJob, mdToolStatus,
  findPython, events as mdEvents,
} from './mdconvert.mjs';
import { publicConfig, saveConfig, loadConfig, loadLogin, saveLogin } from './config.mjs';
import { streamChat } from './chat.mjs';
import { searchKb, buildGraph, listTags, getPreview, listCourses, listLessons } from './kb.mjs';
import { autoParallel } from './gpu.mjs';
import {
  createReplayJob, listReplayJobs, getReplayJob, cancelReplayJob, replayEvents,
  ffmpegStatus, findAsrPython, modelStatus, audioStats, DEFAULT_ASR_MODEL,
} from './replay.mjs';
import { renderNotePdf } from './notepdf.mjs';
import { listCards, dueCount, addCard, addCards, gradeCard, deleteCard, exportCards, mergeCards } from './cards.mjs';
import {
  createLlmJob, listLlmJobs, getLlmJob, cancelLlmJob,
  testProfile, expandQuery, generateQaCards, feynmanReview, listModels, getCaps,
  visionStatus, events as llmEvents,
} from './llm.mjs';
import {
  closeBrowser, edgeStatus, WQ_BASE,
  showBrowserWindow, hideBrowserWindow, browserWindowVisible,
} from './browser.mjs';

const PORT = Number(process.env.PORT || 3901);
const app = express();
app.use(express.json({ limit: '1mb' }));

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- 简化流水线：时间范围 + 任务串联 ----------

/** 今天 / 本周 / 本月（本机时区）→ [起, 止]（毫秒时间戳） */
function periodRangeMs(range) {
  const now = new Date();
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === 'today') {
    return [day0.getTime(), day0.getTime() + 86400000 - 1];
  }
  if (range === 'week') {
    const mondayOffset = (now.getDay() + 6) % 7; // 周一为一周开始
    const start = new Date(day0.getTime() - mondayOffset * 86400000);
    return [start.getTime(), start.getTime() + 7 * 86400000 - 1];
  }
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return [start.getTime(), end.getTime() - 1];
}

/** 课次名（如 2026-09-04第7-8节）里的日期 */
function lessonDateOf(name) {
  const m = String(name || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 等某个任务跑完（done / error / canceled） */
function waitJobDone(emitter, getter, id) {
  return new Promise((resolve) => {
    const finishIfDone = () => {
      const j = getter(id);
      if (!j || ['done', 'error', 'canceled'].includes(j.status)) {
        emitter.off('update', on);
        resolve(j);
        return true;
      }
      return false;
    };
    const on = (j) => { if (j && j.id === id) finishIfDone(); };
    if (finishIfDone()) return;
    emitter.on('update', on);
  });
}

/** LLM 是否已配置（本地接口无需 key） */
function llmReady() {
  try {
    const llm = loadConfig().llm;
    const p = llm.profiles?.[llm.defaultMode || 'text'] || {};
    const local = /(localhost|127\.0\.0\.1)/.test(p.baseUrl || '');
    return Boolean(p.baseUrl && p.model && (p.apiKey || local));
  } catch {
    return false;
  }
}

/** 未登录时用记住的账号自动恢复（供一键下载等主动操作使用）；返回是否已登录 */
async function ensureLoggedIn() {
  try {
    const s = await checkLogin();
    if (s.loggedIn) return true;
  } catch { /* 继续尝试自动登录 */ }
  const saved = loadLogin();
  if (!saved.remember || !saved.username || !saved.password) return false;
  try {
    const r = await login(saved.username, saved.password);
    return Boolean(r && r.ok);
  } catch {
    return false;
  }
}

// 自动串联：转 MD 完成 → 校订；生成笔记完成 → 复核（可在 config.json 的 automation 里关闭）
const autoPolished = new Set();
mdEvents.on('update', (job) => {
  if (!job || job.status !== 'done' || autoPolished.has(job.id)) return;
  autoPolished.add(job.id);
  try {
    if (!loadConfig().automation.polishAfterMd) return;
    if (!llmReady()) return;
    createLlmJob({ op: 'polish', dir: job.dir });
    console.log(`[auto] 转 MD 完成 → 自动校订：${job.dir}`);
  } catch (e) {
    console.warn('[auto] 自动校订加入失败：', e.message);
  }
});

const autoAudited = new Set();
llmEvents.on('update', (job) => {
  if (!job || job.op !== 'note' || job.status !== 'done' || autoAudited.has(job.id)) return;
  autoAudited.add(job.id);
  try {
    if (!loadConfig().automation.auditAfterNote) return;
    if (!llmReady()) return;
    createLlmJob({ op: 'audit', dir: job.dir });
    console.log(`[auto] 生成笔记完成 → 自动复核：${job.dir}`);
  } catch (e) {
    console.warn('[auto] 自动复核加入失败：', e.message);
  }
});

// ---------- 状态与登录 ----------

/**
 * 探活用：只回一个标记，不碰浏览器、不读磁盘。
 * 桌面壳用它判断「本地服务是否已在跑」——`/api/status` 冷启动要 2 秒以上（要唤醒浏览器会话），
 * 壳的探测超时只有 1.2 秒，会把正在跑的服务误判成没起（踩过）。
 */
app.get('/api/ping', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, app: 'qingqu', version: PKG.version || '0.0.0' });
});

app.get('/api/status', asyncRoute(async (_req, res) => {
  const status = { ...edgeStatus(), site: WQ_BASE };
  const saved = loadLogin();
  status.savedLogin = saved.remember && Boolean(saved.username && saved.password);
  status.savedUser = status.savedLogin ? saved.username : '';
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
  const { username, password, remember } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入学号和密码' });
  // 登录可能需要输验证码 → 先把 Edge 窗口唤到屏幕上
  await showBrowserWindow();
  const result = await login(username, password);
  if (!result.ok) return res.status(401).json({ error: result.error || '登录失败' });
  if (remember === true) {
    saveLogin({ username, password, remember: true });
  }
  res.json(result);
}));

/** 用记住的账号密码自动恢复登录（会话过期时用；可能需要验证码 → 失败时回退手动登录） */
app.post('/api/auto-login', asyncRoute(async (_req, res) => {
  const saved = loadLogin();
  if (!saved.remember || !saved.username || !saved.password) {
    return res.status(400).json({ error: '没有保存的登录信息' });
  }
  const result = await login(saved.username, saved.password);
  if (!result.ok) return res.status(401).json({ error: result.error || '自动登录失败（可能需要验证码，请手动登录）' });
  res.json(result);
}));

app.post('/api/logout', asyncRoute(async (_req, res) => {
  saveLogin({ remember: false });   // 退出即清除记住的登录，避免马上又被自动登回来
  const result = await logout();
  if (!result.ok) {
    return res.status(500).json({ error: '会话未完全清除，可能是校园统一认证仍保持登录，请重试', detail: result });
  }
  res.json(result);
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
  const { mode = 'course', courseId, subId, monthsBack = 12, termId, force, withAudio } = req.body || {};
  if ((mode === 'course' || mode === 'sub') && !courseId) return res.status(400).json({ error: '缺少 courseId' });
  if (mode === 'sub' && !subId) return res.status(400).json({ error: '缺少 subId' });
  const job = await createJob({ mode, courseId, subId, monthsBack, termId, force, withAudio });
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

/** 一键下载：今天 / 本周 / 本月 的课件（跨课程按课次开始时间筛，跳过已下架课程） */
app.post('/api/download-range', asyncRoute(async (req, res) => {
  const range = ['today', 'week', 'month'].includes(req.body?.range) ? req.body.range : 'week';
  const [fromMs, toMs] = periodRangeMs(range);
  const dryRun = req.body?.dryRun === true;
  const termId = req.body?.termId;
  const withAudio = req.body?.withAudio === true;

  if (!(await ensureLoggedIn())) {
    return res.status(401).json({ error: '未登录：请先登录统一认证（勾选「记住登录状态」后会自动恢复）' });
  }
  const courses = await listMyCourses(termId != null && termId !== '' ? { termId } : {});
  const matched = [];
  for (const c of courses) {
    if (c.delisted) continue; // 已下架课程没有课件
    let subs = [];
    try { subs = await listCourseSubs(String(c.courseId)); } catch { /* 单门课失败跳过 */ }
    for (const s of subs) {
      const t = Number(s.startAt) * 1000;
      if (!t || t < fromMs || t > toMs) continue;
      matched.push({
        courseId: String(c.courseId), course: c.title || '',
        subId: s.subId, title: s.title || '',
        startAt: Number(s.startAt) || 0,
      });
    }
  }
  matched.sort((a, b) => a.startAt - b.startAt);

  if (dryRun) return res.json({ range, from: fromMs, to: toMs, matched });
  const jobs = [];
  const failed = [];
  for (const m of matched) {
    try {
      const job = await createJob({ mode: 'sub', courseId: m.courseId, subId: m.subId, withAudio });
      jobs.push({ id: job.id, course: m.course, title: m.title });
    } catch (e) {
      failed.push({ ...m, error: e.message });
    }
  }
  res.json({ range, matched: matched.length, queued: jobs.length, jobs, failed, withAudio });
}));

// ---------- PPT → Markdown 转换 ----------

app.get('/api/md-tools', (_req, res) => res.json(mdToolStatus()));

app.post('/api/md-jobs', asyncRoute(async (req, res) => {
  const { dir, device = 'auto', dedup } = req.body || {};
  if (!dir) return res.status(400).json({ error: '缺少 dir（downloads 下的相对目录）' });
  const job = createMdJob({ dir, device, dedup });
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

// ---------- 回放转写（抓音轨 + 本地语音识别） ----------

/** 转写链路的环境自检：缺 ffmpeg 或缺 faster-whisper 时前端能提前提示 */
app.get('/api/replay-tools', asyncRoute(async (_req, res) => {
  const ff = await ffmpegStatus();
  const python = findAsrPython();
  res.json({
    ffmpeg: { available: ff.ok, version: ff.version || '' },
    whisper: {
      available: Boolean(python),
      python: python || '',
      hint: python ? null : '未找到装了 faster-whisper 的 Python：pip install faster-whisper（或用环境变量 QINGQU_ASR_PYTHON 指定解释器）',
    },
    model: modelStatus(DEFAULT_ASR_MODEL),   // 识别模型下没下、多大
    audio: audioStats(),                     // 已经抓了多少节音轨
  });
}));

app.post('/api/replay-jobs', asyncRoute(async (req, res) => {
  const { courseId, subId, courseTitle, subTitle, model, force } = req.body || {};
  if (!courseId || !subId) return res.status(400).json({ error: '缺少 courseId / subId' });
  const job = createReplayJob({ courseId, subId, courseTitle, subTitle, model, force });
  res.status(201).json({ job });
}));

app.get('/api/replay-jobs', (_req, res) => res.json({ jobs: listReplayJobs() }));

app.get('/api/replay-jobs/:id', (req, res) => {
  const job = getReplayJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json({ job });
});

app.post('/api/replay-jobs/:id/cancel', (req, res) => {
  const job = cancelReplayJob(Number(req.params.id));
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
  if (!relDir) return res.status(400).json({ error: '缺少 dir' });
  const absDir = ensureInside(DOWNLOAD_DIR, path.join(DOWNLOAD_DIR, relDir));
  const jsonPath = path.join(path.dirname(absDir), `${path.basename(absDir)}.dedup.json`);
  if (!fs.existsSync(jsonPath)) return res.status(404).json({ error: '还没有清洗数据，请先执行「清洗」' });

  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const lessonDir = absDir;
  const trashDir = path.join(path.dirname(absDir), '_回收站', path.basename(absDir));

  // 新复核页提交「要清理」的完整名单；旧版页面提交 restore（勾选恢复）时自动换算一次
  const legacyRestoreCount = Array.isArray(req.body?.restore) ? req.body.restore.length : 0;
  let remove = Array.isArray(req.body?.remove) ? req.body.remove.map(String) : null;
  if (!remove && Array.isArray(req.body?.restore)) {
    const restoreSet = new Set(req.body.restore.map(String));
    remove = data.frames.filter((f) => !f.keep).map((f) => f.name).filter((n) => !restoreSet.has(n));
  }
  if (!remove) return res.status(400).json({ error: '缺少 remove（要清理的帧名单）' });

  const all = new Set(data.frames.map((f) => f.name));
  const removeSet = new Set(remove.filter((n) => all.has(n)));
  const movedToTrash = [];
  const movedBack = [];
  for (const f of data.frames) {
    const inTrash = fs.existsSync(path.join(trashDir, f.name));
    const shouldTrash = removeSet.has(f.name);
    if (shouldTrash && !inTrash) {
      const from = path.join(lessonDir, f.name);
      if (fs.existsSync(from)) {
        ensureDir(trashDir);
        fs.renameSync(from, path.join(trashDir, f.name));
        movedToTrash.push(f.name);
      }
    } else if (!shouldTrash && inTrash) {
      const to = path.join(lessonDir, f.name);
      if (!fs.existsSync(to)) {
        fs.renameSync(path.join(trashDir, f.name), to);
        movedBack.push(f.name);
      }
    }
    f.trashed = shouldTrash;
  }
  data.userRemove = [...removeSet].sort();
  data.userDecided = true;
  data.keptCount = data.frames.filter((f) => !removeSet.has(f.name)).length;
  data.removedCount = data.frames.length - data.keptCount;
  data.trash = { dir: trashDir, moved: data.removedCount, names: data.userRemove };
  delete data.restore;
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');
  res.json({
    ok: true,
    removed: data.removedCount,
    kept: data.keptCount,
    restoreCount: legacyRestoreCount,
    movedToTrash: movedToTrash.length,
    movedBack: movedBack.length,
    trashDir,
  });
}));

// 复核页数据（页面每次打开 / 保存后重新读取，始终显示最新状态）
app.get('/api/dedup-state', asyncRoute(async (req, res) => {
  const rel = String(req.query.dir || '').replace(/^[/\\]+/, '');
  if (!rel) return res.status(400).json({ error: '缺少 dir' });
  const absDir = ensureInside(DOWNLOAD_DIR, path.join(DOWNLOAD_DIR, rel));
  const jsonPath = path.join(path.dirname(absDir), `${path.basename(absDir)}.dedup.json`);
  if (!fs.existsSync(jsonPath)) return res.status(404).json({ error: '还没有清洗数据' });
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  res.json({
    lesson: data.lesson,
    total: data.total,
    generatedAt: data.generatedAt,
    userDecided: Boolean(data.userDecided),
    kept: data.keptCount ?? 0,
    removed: data.removedCount ?? 0,
    userRemove: data.userRemove || [],
    frames: (data.frames || []).map((f) => ({
      name: f.name, reason: f.reason || '', keep: Boolean(f.keep), trashed: Boolean(f.trashed),
    })),
  });
}));

// 复核页图片：课次目录与回收站里自动查找（图片被移动后页面依然能显示）
app.get('/api/dedup-image', asyncRoute(async (req, res) => {
  const rel = String(req.query.dir || '').replace(/^[/\\]+/, '');
  const name = String(req.query.name || '');
  if (!rel || !name || /[\\/]/.test(name) || name.includes('..')) return res.status(400).end();
  const lessonDir = ensureInside(DOWNLOAD_DIR, path.join(DOWNLOAD_DIR, rel));
  const candidates = [
    path.join(lessonDir, name),
    path.join(path.dirname(lessonDir), '_回收站', path.basename(lessonDir), name),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return res.sendFile(p);
    } catch { /* 继续找 */ }
  }
  res.status(404).end();
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
  if (['auto', 'vision', 'text'].includes(body.notePipeline)) patch.llm.notePipeline = body.notePipeline;
  saveConfig(patch);
  res.json(publicConfig());
}));

/** 各 LLM 档位能不能读图 + 笔记会走哪条链路（设置弹窗用来提示） */
app.get('/api/llm-vision', asyncRoute(async (_req, res) => {
  res.json(await visionStatus());
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
  const { op, dir, mode, scope, pipeline } = req.body || {};
  if (!op) return res.status(400).json({ error: '缺少 op' });
  if (op !== 'weave' && !dir) return res.status(400).json({ error: '缺少 dir' });
  if (op === 'weave' && scope !== 'all' && !dir) return res.status(400).json({ error: '缺少 dir' });
  const job = createLlmJob({ op, dir, mode, scope, pipeline });
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

// ---------- 一键笔记（今天 / 本周 / 本月）：转 MD → 校订 → 生成笔记 → 复核 ----------

const notePipelineQueue = [];
let notePipelineRunning = false;

async function runLessonPipeline(rel, needMd) {
  if (needMd) {
    const md = createMdJob({ dir: rel });
    const r = await waitJobDone(mdEvents, getMdJob, md.id);
    if (!r || r.status !== 'done') throw new Error(`转 MD ${r ? r.status : '中断'}${r?.error ? '：' + r.error : ''}`);
  }
  if (!llmReady()) return;

  // 生成笔记前补讲稿：没有转写、但课次有回放的，自动跑一次转写（讲稿进笔记后质量明显更好）。
  // 可以在 config.json 的 automation.transcribeBeforeNote 关掉；失败只记日志，不阻断整条流水线。
  if (loadConfig().automation?.transcribeBeforeNote !== false) {
    try {
      const [course, lesson] = String(rel).split('/');
      const transAbs = path.join(NOTES_DIR, `${rel}.trans.json`);
      if (!fs.existsSync(transAbs)) {
        const ids = await resolveLessonIds(course, lesson);
        if (ids) {
          const rj = createReplayJob(ids);
          if (!rj.skipped) {
            const r = await waitJobDone(replayEvents, getReplayJob, rj.id);
            if (r && r.status === 'done') console.log(`[pipeline] ${rel} 讲稿已转写`);
            else console.warn(`[pipeline] ${rel} 转写未完成：${r ? r.status + (r.error ? ' ' + r.error : '') : '中断'}`);
          }
        }
      }
    } catch (e) {
      console.warn(`[pipeline] ${rel} 转写讲稿失败（继续生成笔记）：`, e.message);
    }
  }

  const polish = createLlmJob({ op: 'polish', dir: rel });
  const p = await waitJobDone(llmEvents, getLlmJob, polish.id);
  if (!p || p.status !== 'done') throw new Error(`校订 ${p ? p.status : '中断'}${p?.error ? '：' + p.error : ''}`);
  const note = createLlmJob({ op: 'note', dir: rel });
  const n = await waitJobDone(llmEvents, getLlmJob, note.id);
  if (!n || n.status !== 'done') throw new Error(`生成笔记 ${n ? n.status : '中断'}${n?.error ? '：' + n.error : ''}`);
  const audit = createLlmJob({ op: 'audit', dir: rel });
  const a = await waitJobDone(llmEvents, getLlmJob, audit.id);
  if (!a || a.status !== 'done') throw new Error(`复核 ${a ? a.status : '中断'}${a?.error ? '：' + a.error : ''}`);
}

async function pumpNotePipeline() {
  if (notePipelineRunning) return;
  notePipelineRunning = true;
  try {
    while (notePipelineQueue.length) {
      const item = notePipelineQueue.shift();
      try {
        console.log(`[pipeline] 处理：${item.rel}${item.needMd ? '（含转 MD）' : ''}`);
        await runLessonPipeline(item.rel, item.needMd);
      } catch (e) {
        console.warn(`[pipeline] ${item.rel} 失败：`, e.message);
      }
    }
  } finally {
    notePipelineRunning = false;
  }
}

app.post('/api/note-range', asyncRoute(async (req, res) => {
  const range = ['today', 'week', 'month'].includes(req.body?.range) ? req.body.range : 'week';
  const force = req.body?.force === true;
  const dryRun = req.body?.dryRun === true;
  const [fromMs, toMs] = periodRangeMs(range);
  if (!llmReady()) return res.status(400).json({ error: '还没配置 LLM：先在设置里填好接口和 Key' });

  const plan = [];
  for (const course of listCourses()) {
    let entries = [];
    try { entries = fs.readdirSync(path.join(DOWNLOAD_DIR, course), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('_') || e.name.endsWith('_assets')) continue;
      const d = lessonDateOf(e.name);
      if (!d) continue;
      const t = d.getTime();
      if (t < fromMs || t > toMs) continue;
      const rel = `${course}/${e.name}`;
      const mdAbs = path.join(NOTES_DIR, `${rel}.md`);
      const noteAbs = path.join(NOTES_DIR, `${rel}.note.md`);
      const hasMd = fs.existsSync(mdAbs);
      const hasNote = fs.existsSync(noteAbs);
      let imgs = [];
      try { imgs = fs.readdirSync(path.join(DOWNLOAD_DIR, rel), { withFileTypes: true }).filter((f) => f.isFile() && /\.(jpe?g|png|webp|bmp)$/i.test(f.name)); } catch { /* 无图片目录 */ }
      if (!hasMd && !imgs.length) { plan.push({ rel, action: 'skip-no-images' }); continue; }
      if (!force && hasMd && hasNote) {
        try {
          if (fs.statSync(noteAbs).mtimeMs >= fs.statSync(mdAbs).mtimeMs) { plan.push({ rel, action: 'skip-fresh' }); continue; }
        } catch { /* 取时间失败 → 当作需要重做 */ }
      }
      plan.push({ rel, action: hasMd ? 'note' : 'full', needMd: !hasMd });
    }
  }

  const todo = plan.filter((p) => p.action === 'full' || p.action === 'note');
  if (dryRun) return res.json({ range, queued: todo.length, skipped: plan.length - todo.length, plan });
  notePipelineQueue.push(...todo);
  void pumpNotePipeline();
  res.json({ range, queued: todo.length, skipped: plan.length - todo.length, plan });
}));

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
  res.write('data: ' + JSON.stringify({ type: 'hello-replay', jobs: listReplayJobs() }) + '\n\n');
  const onUpdate = (job) => res.write('data: ' + JSON.stringify({ type: 'job', job }) + '\n\n');
  const onMdUpdate = (job) => res.write('data: ' + JSON.stringify({ type: 'md-job', job }) + '\n\n');
  const onLlmUpdate = (job) => res.write('data: ' + JSON.stringify({ type: 'llm-job', job }) + '\n\n');
  const onReplayUpdate = (job) => res.write('data: ' + JSON.stringify({ type: 'replay-job', job }) + '\n\n');
  events.on('update', onUpdate);
  mdEvents.on('update', onMdUpdate);
  llmEvents.on('update', onLlmUpdate);
  replayEvents.on('update', onReplayUpdate);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(keepAlive);
    events.off('update', onUpdate);
    mdEvents.off('update', onMdUpdate);
    llmEvents.off('update', onLlmUpdate);
    replayEvents.off('update', onReplayUpdate);
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
  const HIDDEN = /\.(dedup\.(json|html)|(ocr|math|note)-backup\.md|note\.work(\.vision)?\.md|cards\.json|note\.marks\.json|(audit|points)\.(json|md)|chat\.json|progress\.json|trans\.json|pages\.json)$/i;
  return entries
    .filter((e) => !e.name.startsWith('.') && !e.name.startsWith('_')
      && !(e.isDirectory() && e.name.endsWith('_assets'))   // 转 MD 的图形素材目录，不算课次
      // 讲稿音轨（audio/）与抓流临时文件（tmp/）不是课次目录
      && !(e.isDirectory() && (e.name === 'tmp' || (e.name === 'audio' && path.resolve(dir) === path.resolve(DOWNLOAD_DIR))))
      && !HIDDEN.test(e.name))
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

// 笔记多色标记：读取走 /notes 静态文件，写入走这里
app.post('/api/note-marks', asyncRoute(async (req, res) => {
  const relDir = String(req.body?.dir || '').replace(/^[/\\]+/, '');
  const marks = Array.isArray(req.body?.marks) ? req.body.marks : null;
  if (!relDir || !marks) return res.status(400).json({ error: '缺少 dir 或 marks' });
  const file = ensureInside(NOTES_DIR, path.join(NOTES_DIR, `${relDir}.note.marks.json`));
  const ALLOWED = ['red', 'yellow', 'green', 'blue'];
  const clean = marks
    .filter((m) => m && Number.isInteger(m.i) && m.i >= 0 && ALLOWED.includes(m.color))
    .map((m) => ({ i: m.i, head: String(m.head || '').slice(0, 24), color: m.color }))
    .slice(0, 500);
  if (!clean.length) {
    try { fs.unlinkSync(file); } catch { /* 没有就算了 */ }
  } else {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ v: 1, marks: clean }), 'utf8');
  }
  res.json({ ok: true, count: clean.length });
}));

// 对话历史：按课次存 <课次>.chat.json —— 刷新/重开浏览器后能继续看，也能回看更早的内容
function chatHistoryFile(relDir) {
  const rel = String(relDir || '').replace(/^[/\\]+/, '');
  if (rel.split('/').filter(Boolean).length < 2) throw new Error('dir 需要是「课程/课次」');
  return ensureInside(NOTES_DIR, path.join(NOTES_DIR, `${rel}.chat.json`));
}

app.get('/api/chat-history', asyncRoute(async (req, res) => {
  const rel = String(req.query.dir || '').replace(/^[/\\]+/, '');
  const file = chatHistoryFile(rel);
  let messages = [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(data.messages)) messages = data.messages;
  } catch { /* 还没有历史 */ }
  res.json({ messages, count: messages.length });
}));

app.post('/api/chat-history', asyncRoute(async (req, res) => {
  const { dir: relDir, messages } = req.body || {};
  if (!Array.isArray(messages)) return res.status(400).json({ error: '缺少 messages' });
  const file = chatHistoryFile(relDir);
  let stored = [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(data.messages)) stored = data.messages;
  } catch { /* 忽略 */ }
  const seen = new Set(stored.map((m) => m && m.id).filter(Boolean));
  const clean = [];
  for (const m of messages) {
    if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') continue;
    const id = m.id ? String(m.id).slice(0, 64) : '';
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    clean.push({
      ...(id ? { id } : {}),
      role: m.role,
      content: m.content.slice(0, 20000),
      ...(typeof m.display === 'string' ? { display: m.display.slice(0, 20000) } : {}),
      ...(Array.isArray(m.sources) ? {
        sources: m.sources.slice(0, 8).map((s) => ({
          course: String(s?.course || ''), lesson: String(s?.lesson || ''),
          page: Number(s?.page) || null, rel: String(s?.rel || ''),
          snippet: String(s?.snippet || '').slice(0, 200),
        })),
      } : {}),
      at: Number(m.at) || Date.now(),
    });
  }
  const next = [...stored, ...clean].slice(-2000);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ v: 1, updatedAt: Date.now(), messages: next }, null, 2), 'utf8');
  res.json({ ok: true, count: next.length, added: clean.length });
}));

app.delete('/api/chat-history', asyncRoute(async (req, res) => {
  const rel = String(req.query.dir || '').replace(/^[/\\]+/, '');
  const file = chatHistoryFile(rel);
  try { fs.unlinkSync(file); } catch { /* 没有就算了 */ }
  res.json({ ok: true });
}));

// ---------- 阅读进度（跨设备同步：<课次>.progress.json） ----------

function progressFileOf(rel) {
  const clean = String(rel || '').replace(/^[/\\]+|[/\\]+$/g, '');
  if (!clean) throw new Error('缺少 dir');
  return ensureInside(NOTES_DIR, path.join(NOTES_DIR, `${clean}.progress.json`));
}

function readProgress(rel) {
  try {
    const d = JSON.parse(fs.readFileSync(progressFileOf(rel), 'utf8'));
    return { page: Number(d.page) || 0, updatedAt: Number(d.updatedAt) || 0 };
  } catch {
    return { page: 0, updatedAt: 0 };
  }
}

function writeProgress(rel, page, updatedAt) {
  const file = progressFileOf(rel);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({
    v: 1, page: Number(page) || 0, updatedAt: Number(updatedAt) || Date.now(),
  }, null, 2), 'utf8');
}

app.get('/api/progress', asyncRoute(async (req, res) => {
  const rel = String(req.query.dir || '');
  if (!rel) return res.status(400).json({ error: '缺少 dir' });
  res.json(readProgress(rel));
}));

app.put('/api/progress', asyncRoute(async (req, res) => {
  const rel = String(req.body?.dir || '');
  const page = Number(req.body?.page) || 0;
  if (!rel) return res.status(400).json({ error: '缺少 dir' });
  const now = Date.now();
  writeProgress(rel, page, now);
  res.json({ ok: true, page, updatedAt: now });
}));

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

/** 复习页导航：课程 → 已转 MD 的课次 */
app.get('/api/courses-tree', (_req, res) => {
  const courses = listCourses()
    .map((name) => ({ name, lessons: listLessons(name) }))
    .filter((c) => c.lessons.length > 0);
  res.json({ courses });
});

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
  res.status(201).json({ card, duplicate: Boolean(card.duplicate), dueCount: dueCount() });
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
  if (!items.length) return res.json({ added: 0, skipped: 0, cards: [] });
  const added = addCards(rel, items);
  res.json({ added, skipped: Math.max(0, items.length - added), cards: items, dueCount: dueCount() });
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

// 笔记 PDF：首次生成（无头 Edge 渲染 print.html），之后按 mtime 缓存
app.get('/api/note-pdf', asyncRoute(async (req, res) => {
  const dir = String(req.query.dir || '').replace(/^[/\\]+/, '');
  if (!dir) return res.status(400).json({ error: '缺少 dir' });
  let result;
  try {
    result = await renderNotePdf(dir, { port: PORT });
  } catch (e) {
    return res.status(500).json({ error: 'PDF 生成失败：' + String(e?.message || e).slice(0, 120) });
  }
  if (!result.ok) return res.status(404).json({ error: result.reason === 'no-note' ? '还没有笔记——先点「生成笔记」' : '生成失败' });
  if (req.query.download === '1') return res.download(result.path);
  res.json({ ok: true, url: '/notes/' + result.rel.split('/').map(encodeURIComponent).join('/'), cached: result.cached });
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

// 课次内容指纹（增量同步用）：笔记 mtime + 字符数 + 图片张数
function lessonContentVersion(course, lesson) {
  const rel = `${course}/${lesson}`;
  let t = 0, size = 0;
  for (const f of [`${rel}.note.md`, `${rel}.md`]) {
    try {
      const st = fs.statSync(path.join(NOTES_DIR, f));
      if (st.mtimeMs > t) t = st.mtimeMs;
      size += st.size;
    } catch { /* 忽略 */ }
  }
  return `${Math.floor(t)}-${size}-${countLessonImages(path.join(DATA_DIR, course, lesson))}`;
}

app.get('/api/export', asyncRoute(async (req, res) => {
  const type = ['content', 'state', 'full'].includes(String(req.query.type))
    ? String(req.query.type)
    : (req.query.onlyNotes === '1' ? 'content' : 'full');
  const contentMode = type === 'content';
  const stateMode = type === 'state';
  const courseFilter = String(req.query.course || '').trim();
  const lessonFilter = String(req.query.lesson || '').trim();
  const parseDay = (s, endOfDay) => {
    const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${endOfDay ? '23:59:59' : '00:00:00'}`);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  };
  const rangeFrom = parseDay(req.query.from, false);
  const rangeTo = parseDay(req.query.to, true);
  const includeImages = contentMode ? req.query.images !== '0' : (!stateMode && req.query.images === '1');
  const includePdf = !contentMode && !stateMode && req.query.pdf !== '0';
  const includeAssets = !contentMode && !stateMode && req.query.assets !== '0';
  const includeCards = !contentMode && req.query.cards !== '0';
  const includeChats = !contentMode && req.query.chats !== '0';
  const includeProgress = !contentMode;
  const includeNotePdf = !contentMode && !stateMode && req.query.notePdf !== '0';

  const zip = new AdmZip();
  const courses = [];
  const counts = { courses: 0, lessons: 0, notes: 0, pdfs: 0, assets: 0, cards: 0, chats: 0, notePdfs: 0, images: 0, progress: 0 };

  for (const course of listCourses()) {
    if (courseFilter && course !== courseFilter) continue;
    const lessons = listLessons(course);
    const courseInfo = { name: course, lessons: [] };
    let any = false;

    for (const lesson of lessons) {
      if (lessonFilter && lesson !== lessonFilter) continue;
      if (rangeFrom != null || rangeTo != null) {
        const d = lessonDateOf(lesson);
        if (!d) continue;
        const t = d.getTime();
        if (rangeFrom != null && t < rangeFrom) continue;
        if (rangeTo != null && t > rangeTo) continue;
      }
      const rel = `${course}/${lesson}`;
      const mdAbs = mdPathOf(course, lesson);
      const noteAbs = path.join(NOTES_DIR, `${rel}.note.md`);
      const hasMd = fs.existsSync(mdAbs);
      const hasNote = fs.existsSync(noteAbs);

      if (stateMode) {
        // 学习记录包：只收进度 / 复习卡 / 对话
        const info = { name: lesson, pages: 0, chars: 0, pdf: false, cards: 0, chats: 0, note: hasNote };
        let anyState = false;
        if (includeProgress) {
          const p = readProgress(rel);
          if (p.page > 0 && addFileToZip(zip, progressFileOf(rel), `progress/${rel}.json`)) {
            info.progress = p.page;
            info.stateUpdatedAt = p.updatedAt;
            counts.progress++;
            anyState = true;
          }
        }
        if (includeCards) {
          const cardsAbs = path.join(DATA_DIR, '.review', `${rel}.json`);
          if (addFileToZip(zip, cardsAbs, `cards/${rel}.json`)) {
            try { info.cards = (JSON.parse(fs.readFileSync(cardsAbs, 'utf8')) || []).length; } catch { /* 忽略 */ }
            counts.cards += info.cards;
            anyState = true;
          }
        }
        if (includeChats) {
          const chatAbs = path.join(NOTES_DIR, `${rel}.chat.json`);
          if (addFileToZip(zip, chatAbs, `chats/${rel}.json`)) {
            try { info.chats = (JSON.parse(fs.readFileSync(chatAbs, 'utf8')).messages || []).length; } catch { /* 忽略 */ }
            counts.chats += info.chats;
            anyState = true;
          }
        }
        if (anyState) { courseInfo.lessons.push(info); counts.lessons++; any = true; }
        continue;
      }

      // 内容 / 全量包：原文与笔记至少有一个才收
      if (!hasMd && !hasNote) continue;
      if (hasMd && addFileToZip(zip, mdAbs, `notes/${rel}.md`)) counts.notes++;
      let mdText = '';
      try { mdText = hasMd ? fs.readFileSync(mdAbs, 'utf8') : ''; } catch { /* 忽略 */ }
      const info = {
        name: lesson,
        pages: (mdText.match(/<!-- page \d+:/g) || []).length,
        chars: mdText.length,
        pdf: false,
        cards: 0,
        chats: 0,
        contentVersion: lessonContentVersion(course, lesson),
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
      if (includeChats) {
        const chatAbs = path.join(NOTES_DIR, `${rel}.chat.json`);
        if (addFileToZip(zip, chatAbs, `chats/${rel}.json`)) {
          try { info.chats = (JSON.parse(fs.readFileSync(chatAbs, 'utf8')).messages || []).length; } catch { /* 忽略 */ }
          counts.chats += info.chats;
        }
      }
      if (includeProgress) {
        const p = readProgress(rel);
        if (p.page > 0 && addFileToZip(zip, progressFileOf(rel), `progress/${rel}.json`)) {
          info.progress = p.page;
          info.stateUpdatedAt = p.updatedAt;
          counts.progress++;
        }
      }
      // 生成笔记：md 直接打包；PDF 现场懒生成（之后按 mtime 缓存复用）
      if (addFileToZip(zip, path.join(NOTES_DIR, `${rel}.note.md`), `notes/${rel}.note.md`)) {
        info.note = true;
      }
      if (includeNotePdf && fs.existsSync(path.join(NOTES_DIR, `${rel}.note.md`))) {
        try {
          const pdf = await renderNotePdf(rel, { port: PORT });
          if (pdf.ok && addFileToZip(zip, pdf.path, `notes/${rel}.note.pdf`)) {
            info.notePdf = true;
            counts.notePdfs += 1;
          }
        } catch { /* PDF 生成失败：跳过，不阻塞导出 */ }
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
    // 课程索引 / 知识链：只有课程里真的收了课次才带（按时间范围导出时不带空课程）
    if (any && !stateMode) {
      addFileToZip(zip, path.join(NOTES_DIR, course, `${course}.md`), `notes/${course}/${course}.md`);
      addFileToZip(zip, path.join(NOTES_DIR, '知识链.md'), 'notes/知识链.md');
    }
    if (any) { courses.push(courseInfo); counts.courses++; }
  }

  const manifest = {
    app: 'wqppt',
    format: 2,
    type,
    version: PKG.version || '0.0.0',
    exportedAt: new Date().toISOString(),
    device: 'desktop',
    scope: { course: courseFilter || null, lesson: lessonFilter || null },
    includes: { images: includeImages, pdf: includePdf, assets: includeAssets, cards: includeCards, chats: includeChats, progress: includeProgress, notePdf: includeNotePdf },
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
      contentVersion: l.contentVersion || null,
    }))),
  };
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

  const buf = zip.toBuffer();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const scopeTag = lessonFilter ? 'lesson' : (courseFilter ? 'course' : 'all');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="wqppt-${type}-${scopeTag}-${stamp}.zip"`);
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
  const merged = { progress: 0, cardsAdded: 0, cardsUpdated: 0, chatsAdded: 0 };
  for (const e of entries) {
    if (e.isDirectory) continue;
    const name = e.entryName.replace(/\\/g, '/');
    try {
      // ---- 学习状态：永远合并（不受「跳过 / 覆盖」开关影响）----
      if (name.startsWith('progress/')) {
        const rel = name.slice(9).replace(/\.json$/i, '');
        if (!rel) continue;
        const inc = JSON.parse(e.getData().toString('utf8'));
        const incPage = Number(inc.page) || 0;
        if (incPage <= 0) continue;
        const cur = readProgress(rel);
        const incAt = Number(inc.updatedAt) || 0;
        if (incAt > cur.updatedAt || (cur.page === 0 && incPage > 0)) {
          writeProgress(rel, incPage, incAt || Date.now());
          merged.progress++;
        } else {
          skipped++;
        }
        continue;
      }
      if (name.startsWith('cards/')) {
        const rel = name.slice(6).replace(/\.json$/i, '');
        const inc = JSON.parse(e.getData().toString('utf8'));
        if (!rel || !Array.isArray(inc)) continue;
        const r = mergeCards(rel, inc);
        merged.cardsAdded += r.added;
        merged.cardsUpdated += r.updated;
        continue;
      }
      if (name.startsWith('chats/')) {
        const rel = name.slice(6).replace(/\.json$/i, '');
        const inc = JSON.parse(e.getData().toString('utf8'));
        const incMsgs = Array.isArray(inc?.messages) ? inc.messages : [];
        if (!rel || !incMsgs.length) continue;
        const file = chatHistoryFile(rel);
        let stored = [];
        try {
          const d = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (Array.isArray(d.messages)) stored = d.messages;
        } catch { /* 忽略 */ }
        const seen = new Set(stored.map((m) => m && m.id).filter(Boolean));
        const add = [];
        for (const m of incMsgs) {
          if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') continue;
          const id = m.id ? String(m.id).slice(0, 64) : '';
          if (id && seen.has(id)) continue;
          if (id) seen.add(id);
          add.push({
            ...(id ? { id } : {}),
            role: m.role,
            content: m.content.slice(0, 20000),
            ...(typeof m.display === 'string' ? { display: m.display.slice(0, 20000) } : {}),
            ...(Array.isArray(m.sources) ? {
              sources: m.sources.slice(0, 8).map((s) => ({
                course: String(s?.course || ''), lesson: String(s?.lesson || ''),
                page: Number(s?.page) || null, rel: String(s?.rel || ''),
                snippet: String(s?.snippet || '').slice(0, 200),
              })),
            } : {}),
            at: Number(m.at) || Date.now(),
          });
        }
        if (add.length) {
          const next = [...stored, ...add].slice(-2000);
          ensureDir(path.dirname(file));
          fs.writeFileSync(file, JSON.stringify({ v: 1, updatedAt: Date.now(), messages: next }, null, 2), 'utf8');
          merged.chatsAdded += add.length;
        }
        continue;
      }
      // ---- 内容文件：沿用「跳过 / 覆盖」 ----
      let target = null;
      if (name.startsWith('notes/')) {
        target = ensureInside(NOTES_DIR, path.join(NOTES_DIR, name.slice(6)));
      } else if (name.startsWith('images/')) {
        target = ensureInside(DATA_DIR, path.join(DATA_DIR, name.slice(7)));
      } else {
        continue; // manifest.json 等元数据不入库
      }
      if (fs.existsSync(target) && !overwrite) { skipped++; continue; }
      ensureDir(path.dirname(target));
      fs.writeFileSync(target, e.getData());
      written++;
    } catch (err) {
      if (errors.length < 5) errors.push(`${name}: ${err.message}`);
    }
  }
  res.json({ ok: true, written, skipped, errors, merged, paths: getPaths() });
}));

// ---------- 删除已下载（移入回收站，可恢复） ----------
// 删除只做「搬家」：把选中的文件移动到数据目录下的 _回收站/<id>/，写入 meta.json，随时可还原。

const trashRootOf = () => path.join(DATA_DIR, '_回收站');

function sizeOfPath(abs) {
  let total = 0;
  const stack = [abs];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try { st = fs.lstatSync(cur); } catch { continue; }
    if (st.isDirectory()) {
      let kids = [];
      try { kids = fs.readdirSync(cur); } catch { continue; }
      for (const k of kids) stack.push(path.join(cur, k));
    } else {
      total += st.size;
    }
  }
  return total;
}

function assertLessonKey(course, lesson) {
  const bad = (s) => !s || s.includes('..') || s.includes('/') || s.includes('\\');
  if (bad(course) || bad(lesson)) {
    const err = new Error('课程 / 课次名不合法');
    err.status = 400;
    throw err;
  }
}

/**
 * 汇总某课次要删除的内容。
 * slot='media'  课件与转换文件：原图目录、Markdown、PDF、_assets、清洗复核页
 * slot='records' 学习记录：整理稿、对话、复习卡、备份、审计
 */
function collectLessonFiles(course, lesson) {
  const out = [];
  const seen = new Set();
  const add = (root, rel, slot) => {
    const rootDir = root === 'data' ? DATA_DIR : NOTES_DIR;
    const abs = ensureInside(rootDir, path.join(rootDir, ...rel.split('/')));
    const key = path.resolve(abs).toLowerCase();
    if (seen.has(key)) return;
    if (fs.existsSync(abs)) {
      out.push({ root, rel, slot });
      seen.add(key);
    }
  };
  add('data', `${course}/${lesson}`, 'media');
  add('data', `${course}/${lesson}.dedup.html`, 'media');
  add('data', `${course}/${lesson}.dedup.json`, 'media');
  add('data', `${course}/_回收站/${lesson}`, 'media');
  add('data', `.review/${course}/${lesson}.json`, 'records');
  let names = [];
  try { names = fs.readdirSync(path.join(NOTES_DIR, course)); } catch { /* 没有笔记目录 */ }
  for (const name of names) {
    if (name === `${lesson}_assets`) { add('notes', `${course}/${name}`, 'media'); continue; }
    if (!name.startsWith(`${lesson}.`)) continue;
    const tail = name.slice(lesson.length).toLowerCase();
    const isMedia = tail === '.md' || tail === '.pdf';
    add('notes', `${course}/${name}`, isMedia ? 'media' : 'records');
  }
  return out;
}

function movePath(from, to) {
  ensureDir(path.dirname(to));
  try {
    fs.renameSync(from, to);
  } catch {
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

app.get('/api/trash/preview', asyncRoute(async (req, res) => {
  const course = String(req.query.course || '').trim();
  const lesson = String(req.query.lesson || '').trim();
  assertLessonKey(course, lesson);
  const files = collectLessonFiles(course, lesson);
  const sum = { media: { size: 0, count: 0 }, records: { size: 0, count: 0 } };
  for (const f of files) {
    const rootDir = f.root === 'data' ? DATA_DIR : NOTES_DIR;
    sum[f.slot].size += sizeOfPath(path.join(rootDir, ...f.rel.split('/')));
    sum[f.slot].count += 1;
  }
  res.json(sum);
}));

app.post('/api/trash/preview-multi', asyncRoute(async (req, res) => {
  const rawList = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!rawList.length) return res.status(400).json({ error: '没有选择课次' });
  const sum = { media: { size: 0, count: 0 }, records: { size: 0, count: 0 }, lessons: 0 };
  const seenKey = new Set();
  for (const it of rawList) {
    const course = String(it?.course || '').trim();
    const lesson = String(it?.lesson || '').trim();
    assertLessonKey(course, lesson);
    const key = `${course}/${lesson}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    sum.lessons++;
    for (const f of collectLessonFiles(course, lesson)) {
      const rootDir = f.root === 'data' ? DATA_DIR : NOTES_DIR;
      sum[f.slot].size += sizeOfPath(path.join(rootDir, ...f.rel.split('/')));
      sum[f.slot].count += 1;
    }
  }
  res.json(sum);
}));

app.post('/api/trash/remove', asyncRoute(async (req, res) => {
  const wantMedia = req.body?.media !== false;
  const wantRecords = req.body?.records === true;
  if (!wantMedia && !wantRecords) return res.status(400).json({ error: '没有选择要删除的内容' });

  const rawList = Array.isArray(req.body?.items) && req.body.items.length
    ? req.body.items
    : [{ course: req.body?.course, lesson: req.body?.lesson }];
  const seenKey = new Set();
  const list = [];
  for (const it of rawList) {
    const course = String(it?.course || '').trim();
    const lesson = String(it?.lesson || '').trim();
    assertLessonKey(course, lesson);
    const key = `${course}/${lesson}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    list.push({ course, lesson });
  }
  if (!list.length) return res.status(400).json({ error: '没有选择课次' });

  const files = [];
  for (const it of list) {
    for (const f of collectLessonFiles(it.course, it.lesson)) {
      if (f.slot === 'media' ? wantMedia : wantRecords) files.push(f);
    }
  }
  if (!files.length) return res.status(404).json({ error: '没有找到可删除的内容（可能已经删过了）' });

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const first = list[0];
  const id = list.length > 1
    ? `${stamp}_${sanitizeName(first.course)}_等${list.length}个课次`
    : `${stamp}_${sanitizeName(first.course)}_${sanitizeName(first.lesson)}`;
  const box = path.join(trashRootOf(), id);
  ensureDir(box);

  const items = [];
  const errors = [];
  let size = 0;
  for (const f of files) {
    const rootDir = f.root === 'data' ? DATA_DIR : NOTES_DIR;
    const from = path.join(rootDir, ...f.rel.split('/'));
    const to = path.join(box, f.slot, ...f.rel.split('/'));
    try {
      size += sizeOfPath(from);
      movePath(from, to);
      items.push({ root: f.root, slot: f.slot, rel: f.rel });
    } catch (e) {
      errors.push(`${f.rel}: ${e.message}`);
    }
  }
  if (!items.length) {
    try { fs.rmSync(box, { recursive: true, force: true }); } catch { /* 忽略 */ }
    return res.status(500).json({ error: '删除失败', errors });
  }
  const courseSet = [...new Set(list.map((x) => x.course))];
  const summary = list.length === 1
    ? `${first.course} · ${first.lesson}`
    : (courseSet.length === 1
      ? `${courseSet[0]} · ${list.length} 个课次`
      : `${courseSet.slice(0, 2).join('、')} 等 ${list.length} 个课次`);
  fs.writeFileSync(path.join(box, 'meta.json'), JSON.stringify({
    id, course: first.course, lesson: list.length > 1 ? `${list.length} 个课次` : first.lesson,
    summary, at: new Date().toISOString(), size, lessons: list, items,
  }, null, 2));
  res.json({ ok: true, id, size, removed: items.length, errors });
}));

app.get('/api/trash/list', asyncRoute(async (_req, res) => {
  const root = trashRootOf();
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { /* 空回收站 */ }
  const items = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root, e.name, 'meta.json'), 'utf8'));
      items.push({
        id: e.name, course: meta.course || '', lesson: meta.lesson || '',
        summary: meta.summary || `${meta.course || ''} · ${meta.lesson || ''}`,
        at: meta.at || '', size: meta.size || 0, count: (meta.items || []).length,
      });
    } catch { /* 没有 meta 的目录不展示 */ }
  }
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  res.json({ items, total: items.reduce((s, x) => s + x.size, 0) });
}));

app.post('/api/trash/restore', asyncRoute(async (req, res) => {
  const id = String(req.body?.id || '');
  const root = trashRootOf();
  const box = ensureInside(root, path.join(root, id));
  const metaPath = path.join(box, 'meta.json');
  if (!id || !fs.existsSync(metaPath)) return res.status(404).json({ error: '回收站里找不到这一项' });
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  let restored = 0;
  const blocked = [];
  for (const item of meta.items || []) {
    const rootDir = item.root === 'data' ? DATA_DIR : NOTES_DIR;
    const from = path.join(box, item.slot, ...item.rel.split('/'));
    const to = path.join(rootDir, ...item.rel.split('/'));
    if (!fs.existsSync(from)) continue;
    if (fs.existsSync(to)) { blocked.push(item.rel); continue; }
    try {
      movePath(from, to);
      restored++;
    } catch (e) {
      blocked.push(`${item.rel}（${e.message}）`);
    }
  }
  if (!blocked.length) {
    try { fs.rmSync(box, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
  res.json({ ok: true, restored, blocked });
}));

app.post('/api/trash/purge', asyncRoute(async (req, res) => {
  const root = trashRootOf();
  if (req.body?.all === true) {
    fs.rmSync(root, { recursive: true, force: true });
    return res.json({ ok: true, all: true });
  }
  const id = String(req.body?.id || '');
  const box = ensureInside(root, path.join(root, id));
  if (!id || !fs.existsSync(box)) return res.status(404).json({ error: '回收站里找不到这一项' });
  fs.rmSync(box, { recursive: true, force: true });
  res.json({ ok: true });
}));

// ---------- 导入自定义课件（PPT / PPTX / PDF / 图片 → 课次图片目录） ----------

function lessonDirOf(course, lesson) {
  return ensureInside(DATA_DIR, path.join(DATA_DIR, course, lesson));
}

function countLessonImages(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /\.(jpe?g|png|webp|bmp)$/i.test(f)).length;
  } catch { return 0; }
}

app.get('/api/import-lesson/check', asyncRoute(async (req, res) => {
  const course = sanitizeName(String(req.query.course || '').trim());
  const lesson = sanitizeName(String(req.query.lesson || '').trim());
  if (!course || !lesson) return res.status(400).json({ error: '请先填写课程名和课次名' });
  const dir = lessonDirOf(course, lesson);
  res.json({ exists: fs.existsSync(dir), images: countLessonImages(dir), course, lesson });
}));

app.post('/api/import-lesson', express.raw({ type: () => true, limit: '1024mb' }), asyncRoute(async (req, res) => {
  const course = sanitizeName(String(req.query.course || '').trim());
  const lesson = sanitizeName(String(req.query.lesson || '').trim());
  const filename = String(req.query.filename || '').trim();
  const kind = String(req.query.kind || '').trim();
  const seq = Math.max(1, Number(req.query.seq) || 1);
  if (!course || !lesson || !filename) return res.status(400).json({ error: '缺课程名 / 课次名 / 文件名' });
  const buf = req.body;
  if (!buf || !buf.length) return res.status(400).json({ error: '文件内容为空' });
  const ext = path.extname(filename).toLowerCase();
  const dir = lessonDirOf(course, lesson);
  ensureDir(dir);

  if (kind === 'image') {
    if (!/\.(jpe?g|png|webp|bmp)$/i.test(ext)) return res.status(400).json({ error: `不支持的图片格式：${ext}` });
    const fixedExt = ext === '.jpeg' ? '.jpg' : ext;
    const target = ensureInside(dir, path.join(dir, `${String(seq).padStart(4, '0')}${fixedExt}`));
    fs.writeFileSync(target, buf);
    return res.json({ ok: true, file: path.basename(target), course, lesson });
  }

  if (kind === 'pdf' && ext !== '.pdf') return res.status(400).json({ error: '文件与类型不匹配（期望 PDF）' });
  if (kind === 'pptx' && !['.ppt', '.pptx'].includes(ext)) return res.status(400).json({ error: '文件与类型不匹配（期望 PPT / PPTX）' });

  // 先落临时目录再转换，课次目录里只出现最终图片
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wqppt-import-'));
  const tmpFile = path.join(tmpDir, sanitizeName(path.basename(filename)));
  fs.writeFileSync(tmpFile, buf);
  try {
    if (kind === 'pdf') {
      const py = findPython();
      if (!py) return res.status(500).json({ error: '找不到 Python 环境（.venv-p2t），无法转换 PDF' });
      const dpi = Math.min(300, Math.max(120, Number(req.query.dpi) || 160));
      const r = await runCmd(py, [path.join(ROOT_DIR, 'tools', 'pdf2images.py'), tmpFile, dir, '--dpi', String(dpi)], { timeout: 900000 });
      if (!r.ok) return res.status(500).json({ error: 'PDF 转换失败：' + String(r.stderr || r.error || '').slice(0, 300) });
      return res.json({ ok: true, pages: countLessonImages(dir), course, lesson });
    }
    // PPT / PPTX：PowerPoint COM 导出到临时目录，再按页码自然序复制进课次目录
    const outTmp = path.join(tmpDir, 'out');
    ensureDir(outTmp);
    const psExe = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
    const r = await runCmd(psExe, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT_DIR, 'tools', 'pptx2images.ps1'),
      '-PptPath', tmpFile, '-OutDir', outTmp,
    ], { timeout: 900000 });
    if (!r.ok) return res.status(500).json({ error: 'PPT 转换失败（需要本机安装 PowerPoint）：' + String(r.stderr || r.error || '').slice(0, 300) });
    const imgs = fs.readdirSync(outTmp)
      .filter((f) => /\.(jpe?g|png)$/i.test(f))
      .sort((a, b) => {
        const na = Number((a.match(/\d+/) || ['0'])[0]);
        const nb = Number((b.match(/\d+/) || ['0'])[0]);
        return na - nb;
      });
    if (!imgs.length) return res.status(500).json({ error: 'PPT 转换没有产生图片（演示文稿可能为空）' });
    imgs.forEach((f, i) => {
      const target = ensureInside(dir, path.join(dir, `${String(i + 1).padStart(4, '0')}.jpg`));
      fs.copyFileSync(path.join(outTmp, f), target);
    });
    return res.json({ ok: true, pages: imgs.length, course, lesson });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
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
  res.status(Number(err?.status || err?.statusCode) || 500).json({ error: String(err?.message || err) });
});

const server = app.listen(PORT, () => {
  console.log(`清渠已启动: http://127.0.0.1:${PORT}`);
});

async function shutdown() {
  console.log('\n正在关闭...');
  server.close();
  await closeBrowser();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
