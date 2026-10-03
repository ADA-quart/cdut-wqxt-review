/**
 * PPT 图片下载任务管理器。
 *
 * 任务粒度：一个「课程 × 课次」= 一个任务分组；一次批量下载（一门课或全部课）为一个 Job。
 * 存储布局：downloads/<课程名>/<课次标题>/0001.jpg ...
 * 图片服务器（video.wqxt.cdut.edu.cn）无 WAF，可直接并发 HTTP 下载。
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DOWNLOAD_DIR, ensureDir, ensureInside, sanitizeName } from './paths.mjs';
import { listMyCourses, listCourseSubs, listSubPpt } from './wqxt.mjs';

export const events = new EventEmitter();
events.setMaxListeners(50);

const jobs = new Map();
let nextJobId = 1;

export function listJobs() {
  return [...jobs.values()].map((j) => publicJob(j));
}

export function getJob(id) {
  const job = jobs.get(id);
  return job ? publicJob(job) : null;
}

function publicJob(j) {
  return {
    id: j.id,
    status: j.status,           // pending | running | done | canceled | error
    mode: j.mode,               // course | all
    courseTitles: j.courseTitles,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    tasks: j.tasks.map((t) => ({
      courseId: t.courseId,
      courseTitle: t.courseTitle,
      subId: t.subId,
      subTitle: t.subTitle,
      status: t.status,         // pending | running | done | error | skipped
      total: t.total,
      done: t.done,
      failed: t.failed,
      dir: t.dir,
      relDir: t.relDir,
      error: t.error,
    })),
    stats: computeStats(j),
  };
}

function computeStats(j) {
  const s = { total: j.tasks.length, done: 0, error: 0, skipped: 0, running: 0, pending: 0, images: 0, imagesFailed: 0 };
  for (const t of j.tasks) {
    if (t.status === 'done') s.done++;
    else if (t.status === 'error') s.error++;
    else if (t.status === 'skipped') s.skipped++;
    else if (t.status === 'running') s.running++;
    else s.pending++;
    s.images += t.done;
    s.imagesFailed += t.failed;
  }
  return s;
}

function emit(job) {
  events.emit('update', publicJob(job));
}

/**
 * 创建下载任务。
 * @param {{mode:'course'|'all'|'sub', courseId?:string, subId?:string, monthsBack?:number, termId?:number|string}} options
 */
export async function createJob(options) {
  const { mode = 'course', courseId, subId, monthsBack = 6, termId } = options;

  let courses;
  if (termId != null && termId !== '') {
    // 按学期：只处理该学期的课程
    courses = await listMyCourses({ termId });
  } else {
    const months = [];
    const now = new Date();
    for (let i = 0; i < monthsBack; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    courses = await listMyCourses({ months });
  }
  // 已下架课程没有 PPT 和回放：批量模式直接跳过，单独指定时给出明确提示
  const visible = courses.filter((c) => !c.delisted);
  const targets = mode === 'all' ? visible : visible.filter((c) => String(c.courseId) === String(courseId));
  if (targets.length === 0 && mode !== 'all') {
    const delisted = courses.find((c) => String(c.courseId) === String(courseId) && c.delisted);
    throw new Error(delisted ? '该课程已下架，没有 PPT 和回放' : '未找到目标课程');
  }
  if (targets.length === 0) throw new Error('未找到目标课程');

  const job = {
    id: nextJobId++,
    status: 'pending',
    mode,
    courseTitles: targets.map((c) => c.title),
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    tasks: [],
    canceled: false,
  };

  // 预展开任务列表（课程 → 有回放的课次）
  for (const course of targets) {
    let subs = [];
    try {
      subs = await listCourseSubs(course.courseId);
    } catch (e) {
      job.tasks.push({
        courseId: course.courseId, courseTitle: course.title,
        subId: '-', subTitle: '（课次列表获取失败）',
        status: 'error', total: 0, done: 0, failed: 0, dir: '', relDir: '', error: String(e.message || e),
      });
      continue;
    }
    const playable = subs.filter((s) => s.hasPlayback);
    if (playable.length === 0) {
      job.tasks.push({
        courseId: course.courseId, courseTitle: course.title,
        subId: '-', subTitle: '（本学期暂无可下载课次）',
        status: 'skipped', total: 0, done: 0, failed: 0, dir: '', relDir: '', error: null,
      });
      continue;
    }
    const wanted = mode === 'sub' ? playable.filter((s) => String(s.subId) === String(subId)) : playable;
    if (mode === 'sub' && wanted.length === 0) {
      job.tasks.push({
        courseId: course.courseId, courseTitle: course.title,
        subId: String(subId), subTitle: '（指定课次暂无可下载内容）',
        status: 'skipped', total: 0, done: 0, failed: 0, dir: '', relDir: '', error: null,
      });
      continue;
    }
    for (const sub of wanted) {
      job.tasks.push({
        courseId: course.courseId,
        courseTitle: course.title,
        subId: sub.subId,
        subTitle: sub.title,
        status: 'pending',
        total: 0, done: 0, failed: 0,
        relDir: path.join(sanitizeName(course.title, `course-${course.courseId}`), sanitizeName(sub.title, `sub-${sub.subId}`)),
        dir: path.join('downloads', sanitizeName(course.title, `course-${course.courseId}`), sanitizeName(sub.title, `sub-${sub.subId}`)),
        error: null,
      });
    }
  }

  jobs.set(job.id, job);
  emit(job);

  // 异步执行
  runJob(job).catch((e) => {
    job.status = 'error';
    job.finishedAt = Date.now();
    emit(job);
    console.error('[job] run failed:', e);
  });

  return publicJob(job);
}

async function runJob(job) {
  job.status = 'running';
  job.startedAt = Date.now();
  emit(job);

  // 串行处理各课次分组，组内并发下载图片（对端限速且量小，串行分组减少风控概率）
  for (const task of job.tasks) {
    if (job.canceled) break;
    if (task.status !== 'pending') continue;
    task.status = 'running';
    emit(job);
    try {
      await runTask(job, task);
      task.status = task.failed > 0 && task.done === 0 ? 'error' : 'done';
    } catch (e) {
      task.status = 'error';
      task.error = String(e.message || e);
    }
    emit(job);
  }

  job.status = job.canceled ? 'canceled' : 'done';
  job.finishedAt = Date.now();
  emit(job);
}

async function runTask(job, task) {
  const absDir = ensureInside(DOWNLOAD_DIR, path.join(DOWNLOAD_DIR, task.relDir));
  ensureDir(absDir);

  const images = await listSubPpt(task.courseId, task.subId);
  task.total = images.length;
  emit(job);
  if (images.length === 0) {
    task.error = '该课次没有识别到 PPT 图片';
    emit(job);
    return;
  }

  const concurrency = 5;
  let cursor = 0;
  const worker = async () => {
    while (!job.canceled) {
      const i = cursor++;
      if (i >= images.length) return;
      const img = images[i];
      const fileName = `${String(i + 1).padStart(4, '0')}.jpg`;
      const filePath = path.join(absDir, fileName);
      try {
        await downloadFile(img.url, filePath);
        task.done++;
      } catch {
        task.failed++;
      }
      if ((task.done + task.failed) % 5 === 0 || task.done + task.failed === task.total) emit(job);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  emit(job);
}

async function downloadFile(url, dest) {
  const tmp = dest + '.part';
  const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 100) throw new Error('响应过小，可能是占位图');
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status === 'running' || job.status === 'pending') {
    job.canceled = true;
  }
  return publicJob(job);
}
