/**
 * 课件页的时间轴：第 N 张图出现在录播的第几秒。
 *
 * 学校返回的图片直链里带着毫秒时间戳（`.../34160.jpg` = 第 34.16 秒），
 * 但下载时会重命名成 `0001.jpg`，所以：
 *   - 新下载：抓列表时顺手把时间写进 `<课次>.pages.json`；
 *   - 老课件：按标题反查课程 / 课次，重新取一次列表补齐（需要登录）。
 *
 * 有了它，讲稿（转写）就能按页切片，做到「每一页 PPT 配老师当时讲的那段话」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ensureDir, sanitizeName } from './paths.mjs';

/** 时间轴文件路径（与 .dedup.json 等辅助文件同放课程目录下） */
export function pageTimesPath(course, lesson) {
  return path.join(DATA_DIR, sanitizeName(course), `${sanitizeName(lesson)}.pages.json`);
}

/** 读取已保存的时间轴 */
export function readPageTimes(course, lesson) {
  try {
    const raw = JSON.parse(fs.readFileSync(pageTimesPath(course, lesson), 'utf8'));
    const pages = Array.isArray(raw?.pages) ? raw.pages : [];
    return pages.length ? pages : null;
  } catch {
    return null;
  }
}

/**
 * 保存时间轴。
 * @param {Array<{url?:string, createdSec?:number, created?:number}>} items listSubPpt 的返回值（已按时间排序）
 */
export function savePageTimes(course, lesson, items, extra = {}) {
  const pages = items.map((it, i) => ({
    file: `${String(i + 1).padStart(4, '0')}.jpg`,
    sec: Number(it.createdSec || (it.created ? it.created / 1000 : 0)),
    url: it.url || '',
  }));
  const file = pageTimesPath(course, lesson);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ course, lesson, savedAt: new Date().toISOString(), ...extra, pages }, null, 1), 'utf8');
  return pages;
}

/**
 * 确保拿到时间轴：本地有就读，没有就反查补齐（需要登录态；失败返回 null，调用方降级处理）。
 * @param {(course: string, lesson: string) => Promise<Array|null>} backfill 由 wqxt 提供的反查函数
 */
export async function ensurePageTimes(course, lesson, backfill) {
  const local = readPageTimes(course, lesson);
  if (local) return local;
  if (!backfill) return null;
  try {
    const items = await backfill(course, lesson);
    if (!items?.length) return null;
    return savePageTimes(course, lesson, items, { source: 'backfill' });
  } catch {
    return null;
  }
}

/**
 * 讲稿按页切片：第 i 页的讲解 = 时间落在 [该页出现时刻, 下一页出现时刻) 的转写段落。
 * @param {Array<{file:string, sec:number}>} pages 时间轴
 * @param {Array<{start:number, end:number, text:string}>} segments 转写段落
 * @returns {Map<number, string>} 页码（1 起）→ 该页讲解文本
 */
export function narrationByPage(pages, segments) {
  const out = new Map();
  if (!pages?.length || !segments?.length) return out;
  for (let i = 0; i < pages.length; i += 1) {
    const from = Number(pages[i].sec) || 0;
    const to = i + 1 < pages.length ? Number(pages[i + 1].sec) || Infinity : Infinity;
    const text = segments
      .filter((s) => s.start >= from && s.start < to)
      .map((s) => String(s.text || '').trim())
      .filter(Boolean)
      .join(' ');
    if (text) out.set(Number(String(pages[i].file).replace(/\D/g, '')) || i + 1, text);
  }
  return out;
}

/** 读转写结果（<课次>.trans.json） */
export function readTranscript(notesDir, course, lesson) {
  const p = path.join(notesDir, sanitizeName(course), `${sanitizeName(lesson)}.trans.json`);
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(raw?.segments) && raw.segments.length ? raw : null;
  } catch {
    return null;
  }
}
