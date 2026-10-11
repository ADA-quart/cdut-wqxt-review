/**
 * 把笔记里「【图】<路径>」这种"空引用"行处理成真正的 Markdown 图片。
 *
 * 背景：视觉链路的逐页整理稿约定用「【图】路径」当标记（见 `runNoteVision` 的 SYS_READ）。
 * 重组阶段提示词不到位时，模型会把标记原样贴进成稿——复习页 / Obsidian 里就只剩一行
 * `- 【图】2026-09-01第7-8节/0048.jpg` 的死引用（实测 29 篇里篇均 20+ 条）。
 * 这里做确定性的兜底：
 *   - 路径能解析到文件（原图在数据目录的课次文件夹里）→ 换成 `![图](相对路径)`，复习页会把它
 *     改写成 /notes/… 下的真实地址（见 public/review.js 的 mdBaseUrl 处理），Obsidian 也能直接显示；
 *   - 同一张图重复出现只贴一次；
 *   - 解析不到的一律删行（宁缺毋滥）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, NOTES_DIR } from './paths.mjs';

const RE = /^(\s*(?:[-*]\s*)?)【图】\s*(.+?)\s*$/;

/**
 * @param {string} mdText 笔记正文
 * @param {{ course?: string }} opts 课程名（用于把「课次/文件.jpg」这类路径解析到数据目录）
 * @returns {{ text: string, converted: number, dropped: number, refs: string[] }}
 */
export function resolveFigureRefs(mdText, { course = '' } = {}) {
  const lines = String(mdText).split('\n');
  const out = [];
  const refs = [];
  const seen = new Set();
  let converted = 0;
  let dropped = 0;
  for (const line of lines) {
    const m = RE.exec(line);
    if (!m) { out.push(line); continue; }
    const raw = m[2].trim().replace(/^["'（(]+|["'）)]+$/g, '');
    const candidates = [
      course ? path.join(DATA_DIR, course, raw) : null,
      path.join(DATA_DIR, raw),
      course ? path.join(NOTES_DIR, course, raw) : null,
      path.isAbsolute(raw) ? raw : null,
    ].filter(Boolean);
    const abs = candidates.find((p) => {
      try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
    });
    if (!abs) { dropped += 1; continue; }
    const rel = path.relative(path.join(NOTES_DIR, course), abs).split(path.sep).join('/');
    const key = rel.toLowerCase();
    if (seen.has(key)) { dropped += 1; continue; }
    seen.add(key);
    refs.push(rel);
    converted += 1;
    out.push(`![图](${rel})`);
  }
  return { text: out.join('\n'), converted, dropped, refs };
}
