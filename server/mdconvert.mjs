/**
 * PPT 图片 → Markdown 转换任务管理。
 *
 * 复用 ppt2md.py（Pix2Text）：整目录图片按序转成一个 Markdown（公式保留为 LaTeX），
 * 图形元素抽屉到 <lesson>_assets/ 子目录。Node 只负责调度与进度透传：
 *   python -u ppt2md.py <dir> --json [--device auto]
 * 子进程逐行输出 JSONL（start/ready/progress/skip/done），这里解析成任务进度。
 *
 * 串行执行：同一时刻只跑一个转换任务（GPU / 内存占用友好）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DOWNLOAD_DIR, ROOT_DIR, ensureInside } from './paths.mjs';

export const events = new EventEmitter();
events.setMaxListeners(50);

const mdJobs = new Map();
let nextJobId = 1;
let queue = Promise.resolve();

const IS_WIN = process.platform === 'win32';

/** 定位 Pix2Text 虚拟环境里的 Python 解释器 */
export function findPython() {
  const candidates = IS_WIN
    ? ['.venv-p2t/Scripts/python.exe', '.venv/Scripts/python.exe']
    : ['.venv-p2t/bin/python', '.venv/bin/python'];
  for (const rel of candidates) {
    const full = path.join(ROOT_DIR, rel);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

export function findScript() {
  const full = path.join(ROOT_DIR, 'ppt2md.py');
  return fs.existsSync(full) ? full : null;
}

/** 工具可用性：前端据此提示"先装环境" */
export function mdToolStatus() {
  const python = findPython();
  const script = findScript();
  return {
    available: Boolean(python && script),
    python,
    script,
    hint: python && script
      ? null
      : '未找到转换环境：请先安装 Python 3.12 并执行 `uv venv .venv-p2t --python 3.12` + `uv pip install --python .venv-p2t/Scripts/python.exe pix2text onnxruntime-gpu torch --index-url https://download.pytorch.org/whl/cu124`',
  };
}

function publicMdJob(j) {
  return {
    id: j.id,
    kind: 'md',
    status: j.status,          // pending | running | done | error | canceled
    dir: j.relDir,             // downloads 下的相对目录
    title: j.title,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    progress: j.progress,      // { done, total, current }
    device: j.device,
    outMd: j.outMd,            // 相对 downloads 的 md 路径
    pdf: j.pdfRel,             // 相对 downloads 的课件 PDF 路径
    assets: j.assets,
    error: j.error,
    log: j.log.slice(-8),
  };
}

function emit(job) {
  events.emit('update', publicMdJob(job));
}

export function listMdJobs() {
  return [...mdJobs.values()].map(publicMdJob);
}

export function getMdJob(id) {
  const j = mdJobs.get(id);
  return j ? publicMdJob(j) : null;
}

/**
 * 创建一个转换任务。
 * @param {{ dir: string, device?: 'auto'|'cuda'|'cpu' }} opts dir = downloads 下的相对路径
 */
export function createMdJob(opts) {
  const tool = mdToolStatus();
  if (!tool.available) throw new Error(tool.hint || '转换环境不可用');

  const relDir = String(opts.dir || '').replace(/^[/\\]+/, '');
  const absDir = ensureInside(DOWNLOAD_DIR, path.join(DOWNLOAD_DIR, relDir));
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    throw new Error(`目录不存在：${relDir}`);
  }
  const hasImages = fs.readdirSync(absDir).some((f) => /\.(jpe?g|png|webp|bmp)$/i.test(f));
  if (!hasImages) throw new Error(`目录中没有图片：${relDir}`);

  const job = {
    id: nextJobId++,
    status: 'pending',
    relDir,
    title: path.basename(absDir),
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    progress: { done: 0, total: 0, current: '' },
    device: opts.device || 'auto',
    outMd: null,
    pdfRel: null,
    assets: null,
    error: null,
    log: [],
    child: null,
    canceled: false,
  };
  mdJobs.set(job.id, job);
  emit(job);

  // 串行排队
  queue = queue.then(() => runMdJob(job)).catch((e) => {
    job.status = 'error';
    job.error = String(e?.message || e);
    job.finishedAt = Date.now();
    emit(job);
  });

  return publicMdJob(job);
}

async function runMdJob(job) {
  if (job.canceled) {
    job.status = 'canceled';
    job.finishedAt = Date.now();
    emit(job);
    return;
  }

  const tool = mdToolStatus();
  if (!tool.available) throw new Error(tool.hint || '转换环境不可用');

  const absDir = ensureInside(DOWNLOAD_DIR, path.join(DOWNLOAD_DIR, job.relDir));
  job.status = 'running';
  job.startedAt = Date.now();
  emit(job);

  await new Promise((resolve) => {
    const child = spawn(
      tool.python,
      ['-u', tool.script, absDir, '--json', '--device', job.device],
      {
        cwd: ROOT_DIR,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      },
    );
    job.child = child;

    let buf = '';
    const onLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (msg.type === 'start') {
        job.progress.total = msg.total || 0;
      } else if (msg.type === 'ready') {
        job.device = msg.device || job.device;
        job.log.push(`模型加载完成（${msg.secs}s, ${msg.device}）`);
      } else if (msg.type === 'progress') {
        job.progress.done = msg.i;
        job.progress.total = msg.total;
        job.progress.current = msg.name;
      } else if (msg.type === 'skip') {
        job.log.push(`跳过 ${msg.name}: ${msg.error}`);
      } else if (msg.type === 'pdf') {
        job.log.push(`课件 PDF 已生成（${msg.pages} 页, ${msg.secs}s）`);
      } else if (msg.type === 'warn') {
        job.log.push(String(msg.error || '').slice(0, 200));
      } else if (msg.type === 'done') {
        job.outMd = path.relative(DOWNLOAD_DIR, msg.out).split(path.sep).join('/');
        if (msg.pdf) job.pdfRel = path.relative(DOWNLOAD_DIR, msg.pdf).split(path.sep).join('/');
        job.assets = path.relative(DOWNLOAD_DIR, msg.assets).split(path.sep).join('/');
        job.log.push(`完成 ${msg.ok}/${msg.total} 页，耗时 ${msg.secs}s`);
      } else if (msg.type === 'error') {
        job.error = msg.error;
      }
      emit(job);
    };

    const consume = (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        onLine(line);
      }
    };

    child.stdout.on('data', consume);
    child.stderr.on('data', (chunk) => {
      // 记录非进度噪声的最后一行，便于排查
      const text = chunk.toString('utf8').trim();
      if (text && !text.includes('%|')) job.log.push(text.slice(0, 200));
    });

    child.on('error', (e) => {
      job.error = String(e.message || e);
      job.status = 'error';
      job.finishedAt = Date.now();
      emit(job);
      resolve();
    });

    child.on('close', (code) => {
      job.child = null;
      if (job.canceled) {
        job.status = 'canceled';
      } else if (code === 0 && !job.error) {
        job.status = 'done';
      } else {
        job.status = 'error';
        job.error = job.error || `转换进程退出码 ${code}`;
      }
      job.finishedAt = Date.now();
      if (buf.trim()) onLine(buf);
      emit(job);
      resolve();
    });
  });
}

export function cancelMdJob(id) {
  const job = mdJobs.get(id);
  if (!job) return null;
  if (job.status === 'pending' || job.status === 'running') {
    job.canceled = true;
    if (job.child) {
      try { job.child.kill(); } catch {}
    } else {
      job.status = 'canceled';
      job.finishedAt = Date.now();
      emit(job);
    }
  }
  return publicMdJob(job);
}
