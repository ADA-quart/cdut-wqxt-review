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
 * 讲稿按页切片。
 *
 * 两个必须踩准的点（都会被「清洗」影响）：
 *   1) **只用清洗后仍在的页划时间片**。被删掉的重复帧 / 二维码页在原文 md 里没有对应页，
 *      若参与切片，这段时间的讲解会挂到不存在的页号上直接丢失（实测某节课丢了 88 秒）。
 *      正确语义：某页的讲解 = 从该页出现，到**下一张保留下来的页**出现为止。
 *   2) **键用 md 里的页号**（第 1 页、第 2 页…），不是文件名编号——清洗掉的帧会让两者错开
 *      （md 第 1 页可能是 0050.jpg）。
 *
 * @param {Array<{file:string, sec:number}>} pages 完整时间轴（含已被清洗掉的帧）
 * @param {Array<{start:number,end:number,text:string}>} segments 转写段落
 * @param {Array<{n:number|string, name:string}>} survivors 清洗后仍在原文里的页（顺序即 md 顺序）
 * @returns {Map<number, string>} md 页号 → 该页讲解文本
 */
export function narrationByPage(pages, segments, survivors) {
  const out = new Map();
  if (!pages?.length || !segments?.length) return out;
  const secOf = new Map(pages.map((p) => [p.file, Number(p.sec) || 0]));
  const list = (survivors?.length ? survivors : pages.map((p, i) => ({ n: i + 1, name: p.file })))
    .map((s) => ({ n: Number(s.n), sec: secOf.get(s.name) }))
    .filter((s) => Number.isFinite(s.n) && s.sec !== undefined)
    .sort((a, b) => a.sec - b.sec);
  for (let i = 0; i < list.length; i += 1) {
    const from = list[i].sec;
    const to = i + 1 < list.length ? list[i + 1].sec : Infinity;
    const text = segments
      .filter((s) => s.start >= from && s.start < to)
      .map((s) => String(s.text || '').trim())
      .filter(Boolean)
      .join(' ');
    if (text) out.set(list[i].n, text);
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
