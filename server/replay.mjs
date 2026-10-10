/**
 * 回放抓取 + 讲稿转写。
 *
 * 链路（视频不落盘）：
 *   播放页（真实浏览器标签）→ CDP 拦截媒体响应 → ffmpeg stdin → 音轨 <数据目录>/audio/<课程>/<课次>.m4a
 *   → faster-whisper（transcribe.py）→ 讲稿 <笔记目录>/<课程>/<课次>.trans.md + .trans.json
 *
 * 为什么要截播放器自己的请求：
 *   resource 域名的 mp4 直连返回 500；带 `?clientUUID=` 仍 403；只有播放器当场生成的
 *   `clientUUID + t=<用户>-<时间戳>-<哈希>` 签名能拿到 206。签名会过期、且只在真实
 *   播放请求里有效，所以不去复刻签名，而是把播放器发的响应原样流下来。
 *
 * 为什么不用平台自带「语音识别」：
 *   2026-10-09 抽样 144 个课次，只有 74% 有结果；当学期新录的课次仅 14%（上学期 89%），
 *   恰好是学生最需要笔记的时候没有。所以讲稿一律本地生成。
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { ensureBrowser, WQ_BASE } from './browser.mjs';
import { DATA_DIR, NOTES_DIR, ROOT_DIR, ensureDir, sanitizeName } from './paths.mjs';
import { findPython } from './mdconvert.mjs';

export const replayEvents = new EventEmitter();

const jobs = new Map();
let nextJobId = 1;
/** 抓流是重活（每节 1GB 中转 + 浏览器标签），一律串行跑 */
const queue = [];
let running = null;

function pump() {
  if (running || queue.length === 0) return;
  running = queue.shift();
  runJob(running)
    .catch(() => { /* runJob 内部已记录错误 */ })
    .finally(() => {
      running = null;
      pump();
    });
}

/** 抓流等待上限：播放页打开后多久没等到媒体请求就算失败 */
const CAPTURE_START_TIMEOUT_MS = 90000;
/** 单次抓流上限（含网络卡死的情况），94 分钟课次约 1 GB，给足余量 */
const CAPTURE_MAX_MS = 60 * 60 * 1000;

const MODEL_DIR = path.join(ROOT_DIR, 'run', 'asr');

let asrPython = null;
let asrPythonChecked = false;

/**
 * 找一个装了 faster-whisper 的解释器。
 * 不能直接用 OCR 那个 venv：faster-whisper（CTranslate2）与本机 CUDA 的搭配可能在
 * 系统 Python 里，硬用 .venv-p2t 会报 ModuleNotFoundError。
 */
export function findAsrPython() {
  if (asrPythonChecked) return asrPython;
  asrPythonChecked = true;
  const candidates = [
    process.env.QINGQU_ASR_PYTHON,
    'python',
    'python3',
    findPython(),          // OCR 虚拟环境（装了 faster-whisper 也能用）
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      execFileSync(c, ['-c', 'import faster_whisper'], { stdio: 'ignore', timeout: 60000, windowsHide: true });
      asrPython = c;
      return c;
    } catch { /* 换下一个候选 */ }
  }
  return null;
}

function emit(job) {
  replayEvents.emit('update', publicJob(job));
}

function publicJob(j) {
  return {
    id: j.id,
    kind: 'replay',
    status: j.status,              // pending | running | done | error | canceled
    stage: j.stage,                // capture | extract | transcribe | ''
    audioOnly: j.audioOnly,        // 只抓音轨不转写
    courseId: j.courseId,
    subId: j.subId,
    courseTitle: j.courseTitle,
    subTitle: j.subTitle,
    relDir: j.relDir,
    audioRel: j.audioRel,
    audioUrl: j.audioRel ? '/files/' + j.audioRel.split(path.sep).map(encodeURIComponent).join('/') : null,
    transRel: j.transRel,
    transUrl: j.transRel ? '/notes/' + j.transRel.split(path.sep).map(encodeURIComponent).join('/') : null,
    model: j.model,
    device: j.device,
    progress: j.progress,          // { done, total, unit }
    bytes: j.bytes,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    error: j.error,
    log: j.log.slice(-8),
  };
}

export function listReplayJobs() {
  return [...jobs.values()].map(publicJob);
}

export function getReplayJob(id) {
  const j = jobs.get(Number(id));
  return j ? publicJob(j) : null;
}

export function cancelReplayJob(id) {
  const j = jobs.get(Number(id));
  if (!j) return null;
  if (j.status === 'pending' || j.status === 'running') {
    j.canceled = true;
    j.log.push('收到取消请求');
    if (j.ffmpeg) j.ffmpeg.kill().catch(() => {});
    if (j.python) j.python.kill().catch(() => {});
    if (j.abortCapture) j.abortCapture();
    emit(j);
  }
  return publicJob(j);
}

/**
 * 创建转写任务。
 * @param {{ courseId: string, subId: string, courseTitle: string, subTitle: string, model?: string, force?: boolean }} opts
 */
export function createReplayJob(opts) {
  const course = sanitizeName(opts.courseTitle || '未命名课程');
  const lesson = sanitizeName(opts.subTitle || String(opts.subId));
  const relDir = path.join(course, lesson);

  const audioRel = path.join('audio', course, `${lesson}.m4a`);
  const audioAbs = path.join(DATA_DIR, audioRel);
  const transRel = path.join(course, `${lesson}.trans.json`);
  const transAbs = path.join(NOTES_DIR, transRel);

  // 幂等：同一课次已有排队/进行中的任务 → 复用
  const dup = [...jobs.values()].find(
    (j) => j.subId === String(opts.subId)
      && (j.status === 'pending' || j.status === 'running'),
  );
  if (dup) return { ...publicJob(dup), reused: true };

  // 幂等：音轨已在（audioOnly 任务）或笔记所需的转写已在 → 直接跳过
  if (!opts.force && fs.existsSync(audioAbs) && (opts.audioOnly || fs.existsSync(transAbs))) {
    return { skipped: true, reason: 'already-done', relDir, transRel, audioRel };
  }

  const job = {
    id: nextJobId++,
    status: 'pending',
    stage: '',
    courseId: String(opts.courseId),
    subId: String(opts.subId),
    courseTitle: course,
    subTitle: lesson,
    relDir,
    audioRel,
    transRel,
    model: opts.model || 'large-v3-turbo',
    audioOnly: opts.audioOnly === true,   // 只抓音轨不转写（下载时顺手抓、之后单独转写）
    device: '',
    progress: { done: 0, total: 0, unit: 'bytes' },
    bytes: 0,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    error: null,
    log: [],
    canceled: false,
    ffmpeg: null,
    python: null,
    abortCapture: null,
  };
  jobs.set(job.id, job);
  emit(job);
  queue.push(job);
  pump();
  return publicJob(job);
}

/** 播放页地址：进 /coursevideo 会被前端重定向到 /videoroom 并自动起播 */
function playerUrl(courseId, subId) {
  const q = new URLSearchParams({ tenant_code: '21', id: String(courseId), sub_id: String(subId) });
  return `${WQ_BASE}/coursevideo?${q}`;
}

/**
 * 截播放器的媒体响应，把视频流落到临时文件。
 *
 * 为什么不边收边喂 ffmpeg：管道是不可 seek 的，MP4 的 moov/索引在流中途会出问题
 * （实测喂到约 700 MB 时 ffmpeg 提前退出）；落文件后 ffmpeg 能正常 seek，
 * 代价是每个课次多一次约 1 GB 的临时读写，抽完音轨即删。
 */
async function captureVideo(job, tmpPath) {
  ensureDir(path.dirname(tmpPath));
  const browser = await ensureBrowser();
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  let settled = false;
  const out = fs.createWriteStream(tmpPath);

  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: 'https://resource.wqxt.cdut.edu.cn/play/*', requestStage: 'Response' }],
  });

  let resolveCapture;
  let rejectCapture;
  const captured = new Promise((resolve, reject) => { resolveCapture = resolve; rejectCapture = reject; });
  let startTimer = null;
  let hardTimer = null;

  job.abortCapture = () => {
    settled = true;
    rejectCapture(new Error('已取消'));
  };

  cdp.on('Fetch.requestPaused', async (ev) => {
    const isMp4 = /\.mp4(\?|$)/.test(ev.request.url);
    if (!isMp4) {
      await cdp.send('Fetch.continueResponse', { requestId: ev.requestId }).catch(() => {});
      return;
    }
    if (settled) {
      await cdp.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'Aborted' }).catch(() => {});
      return;
    }
    settled = true;
    clearTimeout(startTimer);          // 已经开流，等待超时计时器作废
    hardTimer = setTimeout(() => {
      settled = false;
      rejectCapture(new Error('抓流超时（超过 60 分钟）'));
    }, CAPTURE_MAX_MS);
    const headers = Object.fromEntries((ev.responseHeaders || []).map((h) => [String(h.name).toLowerCase(), h.value]));
    const totalBytes = Number(headers['content-range']?.split('/')?.[1] || headers['content-length'] || 0);
    job.log.push(`抓到媒体响应（HTTP ${ev.responseStatusCode}${totalBytes ? `，约 ${(totalBytes / 1048576).toFixed(0)} MB` : ''}）`);
    emit(job);

    try {
      const { stream } = await cdp.send('Fetch.takeResponseBodyAsStream', { requestId: ev.requestId });
      if (totalBytes) job.progress = { done: 0, total: totalBytes, unit: 'bytes' };
      let bytes = 0;
      for (;;) {
        if (job.canceled) throw new Error('已取消');
        const r = await cdp.send('IO.read', { handle: stream, size: 2 * 1024 * 1024 });
        if (r.data) {
          const buf = Buffer.from(r.data, r.base64Encoded ? 'base64' : 'utf8');
          // 背压：磁盘写不动就等 drain，避免把内存撑爆
          if (!out.write(buf)) {
            await new Promise((res) => out.once('drain', res));
          }
          bytes += buf.length;
          job.bytes = bytes;
          job.progress = { done: bytes, total: totalBytes || job.progress.total, unit: 'bytes' };
          if (bytes % (16 * 1024 * 1024) < buf.length) emit(job);
        }
        if (r.eof) break;
      }
      await cdp.send('IO.close', { handle: stream }).catch(() => {});
      await new Promise((res) => out.end(res));
      resolveCapture(bytes);
    } catch (e) {
      out.destroy();
      rejectCapture(e);
    } finally {
      await cdp.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'Aborted' }).catch(() => {});
    }
  });

  try {
    // 等待开流的计时器必须在 goto 之前起：媒体请求可能在 goto 返回前就被截到
    const startTimeout = new Promise((_, rej) => {
      startTimer = setTimeout(
        () => rej(new Error('等待播放器取流超时（可能是未开播或该课次无回放）')),
        CAPTURE_START_TIMEOUT_MS,
      );
    });
    await page.goto(playerUrl(job.courseId, job.subId), { waitUntil: 'domcontentloaded', timeout: 60000 });
    const bytes = await Promise.race([captured, startTimeout]);
    return bytes;
  } finally {
    clearTimeout(startTimer);
    clearTimeout(hardTimer);
    job.abortCapture = null;
    await cdp.send('Fetch.disable').catch(() => {});
    await page.close().catch(() => {});
  }
}

/** 从落好的视频里抽音轨（16 kHz 单声道 AAC，够语音识别用） */
function extractAudio(job, videoPath, audioAbs) {
  ensureDir(path.dirname(audioAbs));
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', videoPath,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '64k',
      audioAbs, '-y',
    ], { windowsHide: true });
    job.ffmpeg = ffmpeg;
    let err = '';
    ffmpeg.stderr.on('data', (d) => { err += String(d); });
    ffmpeg.on('error', reject);
    ffmpeg.on('exit', (code) => {
      job.ffmpeg = null;
      if (job.canceled) return reject(new Error('已取消'));
      if (code !== 0) return reject(new Error(`抽音轨失败（ffmpeg ${code}）：${err.trim().split('\n').slice(-1)[0]?.slice(0, 200) || ''}`));
      if (!fs.existsSync(audioAbs) || fs.statSync(audioAbs).size < 1024) return reject(new Error('抽音轨失败：音频文件为空'));
      resolve();
    });
  });
}

/**
 * 语音识别提示词（whisper 的 initial_prompt）。
 *
 * 实测（2026-10-09，3 分钟样本 A/B）：
 *   - 塞 300 字课件术语 → **污染输出**：模型把提示词本身接进正文
 *     （「其实是代表强性波动力学2026-06-29第1-2节目」），还反复回吐提示里的词；
 *   - 只留课程名（几字）→ 干净，无回显。
 * 原因是 initial_prompt 走 `sot_prev` 上下文，等于「上文」，越长越容易被续写。
 * 所以这里只放极短的课程名，术语纠错交给后面的整理/审计环节（那里有课件原文可对照）。
 */
function buildGlossary(job) {
  return String(job.courseTitle || '').replace(/\s+/g, ' ').trim().slice(0, 24);
}

/** 调 transcribe.py 转写，逐行解析 JSON 进度 */
function transcribe(job, audioAbs, transAbs) {
  const python = findAsrPython();
  if (!python) {
    throw new Error('未找到装了 faster-whisper 的 Python：请执行 pip install faster-whisper，'
      + '或用环境变量 QINGQU_ASR_PYTHON 指定解释器');
  }
  ensureDir(path.dirname(transAbs));

  return new Promise((resolve, reject) => {
    const glossary = buildGlossary(job);
    if (glossary) job.log.push(`术语提示：${glossary.slice(-60)}`);
    const child = spawn(python, [
      '-u', path.join(ROOT_DIR, 'transcribe.py'),
      audioAbs,
      '-o', transAbs,
      '--model', job.model,
      '--model-dir', MODEL_DIR,
      '--device', 'auto',
      '--title', `${job.courseTitle} ${job.subTitle}`,
      '--prompt', glossary,
      '--json',
    ], {
      cwd: ROOT_DIR,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    job.python = child;

    let buf = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      buf += String(chunk);
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        let msg;
        try { msg = JSON.parse(t); } catch { continue; }
        if (msg.type === 'download') {
          job.stage = 'download-model';
          job.progress = { done: msg.done, total: msg.total, unit: 'bytes' };
          emit(job);
        } else if (msg.type === 'model-ready') {
          job.log.push(`模型就绪（${msg.secs}s）`);
          emit(job);
        } else if (msg.type === 'ready') {
          job.stage = 'transcribe';
          job.device = msg.device;
          job.log.push(`开始转写（${msg.device}，加载 ${msg.secs}s）`);
          emit(job);
        } else if (msg.type === 'start') {
          job.progress = { done: 0, total: msg.duration, unit: 'seconds' };
          emit(job);
        } else if (msg.type === 'progress') {
          job.progress = { done: msg.done, total: msg.total, unit: 'seconds' };
          emit(job);
        } else if (msg.type === 'log') {
          job.log.push(String(msg.msg).slice(0, 200));
          emit(job);
        } else if (msg.type === 'done') {
          job.device = msg.device;
          job.log.push(`转写完成：${msg.segments} 段，耗时 ${(msg.elapsed / 60).toFixed(1)} 分钟`);
        }
      }
    });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', reject);
    child.on('exit', (code) => {
      job.python = null;
      if (job.canceled) return reject(new Error('已取消'));
      if (code !== 0) return reject(new Error(`转写失败（退出码 ${code}）${stderr ? '：' + stderr.trim().split('\n').slice(-1)[0].slice(0, 200) : ''}`));
      resolve();
    });
  });
}

async function runJob(job) {
  job.status = 'running';
  job.startedAt = Date.now();
  const audioAbs = path.join(DATA_DIR, job.audioRel);
  const transAbs = path.join(NOTES_DIR, job.transRel);
  try {
    // 音轨已在就直接转写：换模型重跑、转写失败重试都不必再抓一遍一 GB 的流
    if (fs.existsSync(audioAbs) && fs.statSync(audioAbs).size > 1024 * 1024) {
      job.log.push(`已有音轨 ${(fs.statSync(audioAbs).size / 1048576).toFixed(1)} MB，跳过抓流`);
      emit(job);
    } else {
      job.stage = 'capture';
      job.log.push('打开播放页，等待播放器取流…');
      emit(job);
      const tmpVideo = path.join(DATA_DIR, 'tmp', `${job.courseTitle}-${job.subTitle}.mp4`);
      const bytes = await captureVideo(job, tmpVideo);
      job.log.push(`抓到 ${(bytes / 1048576).toFixed(0)} MB 视频流，开始抽音轨…`);
      emit(job);

      job.stage = 'extract';
      emit(job);
      try {
        await extractAudio(job, tmpVideo, audioAbs);
        job.log.push(`音轨已存：${(fs.statSync(audioAbs).size / 1048576).toFixed(1)} MB`);
      } finally {
        fs.rm(tmpVideo, { force: true }, () => {});   // 视频只是中转，抽完即删
      }
      emit(job);
    }

    // 只要音轨的任务到此为止（下载时顺手抓），转写留给之后生成笔记或手动触发
    if (job.audioOnly) {
      job.status = 'done';
      job.finishedAt = Date.now();
      job.log.push('已按需只抓音轨（转写未执行）');
      emit(job);
      return;
    }

    job.stage = 'transcribe';
    job.progress = { done: 0, total: 0, unit: 'seconds' };
    emit(job);
    await transcribe(job, audioAbs, transAbs);

    job.status = 'done';
    job.finishedAt = Date.now();
    emit(job);
  } catch (e) {
    job.status = job.canceled ? 'canceled' : 'error';
    job.error = String(e?.message || e);
    job.finishedAt = Date.now();
    emit(job);
  }
}
