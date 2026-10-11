/**
 * 在每个小节后面附一块「🎙 老师讲解」折叠引用——该小节引用的页里，老师当时说了什么（语音转写原文）。
 *
 * 为什么加：讲稿在生成时是"证据"（提炼成 💭 转述），但复习时想核对"老师原话到底怎么说"只能去
 * 打开整份讲稿翻时间戳。折叠块把「该页原话」放到对应小节手边，默认收起不打扰阅读。
 *
 * 特性（都是确定性的，零 LLM 调用）：
 *   - 按小节聚合：某小节引用到的页（`#page=N`），只附"有讲解切片"的页，按引用顺序最多 5 页；
 *   - 每页原话最多 800 字（转写原文，可能有同音错字，summary 里注明）；
 *   - 幂等：重复执行会先删掉旧的 🎙 块再加，不会越滚越多；
 *   - 关键图 / 知识点补全这两个"附录"小节不附（避免重复）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, NOTES_DIR } from './paths.mjs';
import { narrationByPage } from './pages.mjs';

const OLD_BLOCK = /\n?<details><summary>🎙 老师讲解[\s\S]*?<\/details>\n?/g;
const PAGE_REF = /#page=(\d+)/g;
const PER_PAGE_CHARS = 800;
const MAX_PAGES = 5;
const SKIP_TITLE = /关键图|知识点补全/;

/**
 * @param {string} noteText 笔记正文
 * @param {{ course: string, lesson: string }} opts
 * @returns {{ text: string, sections: number, pages: number }}
 */
export function attachTeacherQuotes(noteText, { course, lesson }) {
  const transPath = path.join(NOTES_DIR, course, `${lesson}.trans.json`);
  const pagesPath = path.join(DATA_DIR, course, `${lesson}.pages.json`);
  const mdPath = path.join(NOTES_DIR, course, `${lesson}.md`);
  if (!fs.existsSync(transPath) || !fs.existsSync(pagesPath) || !fs.existsSync(mdPath)) {
    return { text: noteText, sections: 0, pages: 0 };
  }
  let narration;
  try {
    const { pages } = JSON.parse(fs.readFileSync(pagesPath, 'utf8'));
    const { segments } = JSON.parse(fs.readFileSync(transPath, 'utf8'));
    const md = fs.readFileSync(mdPath, 'utf8');
    const survivors = [...md.matchAll(/<!-- page (\d+): ([^>]+) -->/g)].map((m) => ({ n: Number(m[1]), name: m[2].trim() }));
    narration = narrationByPage(pages, segments, survivors);
  } catch {
    return { text: noteText, sections: 0, pages: 0 };
  }
  if (!narration.size) return { text: noteText, sections: 0, pages: 0 };

  const clean = String(noteText).replace(OLD_BLOCK, '\n');
  const lines = clean.split('\n');
  // 切小节：## / ### 标题为界（标题行之前的开头块不处理）
  const marks = [];
  lines.forEach((line, idx) => { if (/^#{2,3}\s/.test(line.trim())) marks.push({ idx, title: line.trim() }); });
  if (!marks.length) return { text: clean, sections: 0, pages: 0 };

  const out = [];
  let sections = 0; let usedPages = 0;
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i].idx;
    const end = i + 1 < marks.length ? marks[i + 1].idx : lines.length;
    const head = i === 0 ? lines.slice(0, start) : [];
    if (head.length) out.push(...head);
    const body = lines.slice(start, end);
    out.push(...body);
    if (SKIP_TITLE.test(marks[i].title)) continue;
    const refs = [];
    for (const line of body) for (const m of line.matchAll(PAGE_REF)) if (!refs.includes(Number(m[1]))) refs.push(Number(m[1]));
    const withTalk = refs.filter((n) => narration.get(n));
    if (!withTalk.length) continue;
    const picked = withTalk.slice(0, MAX_PAGES);
    const parts = picked.map((n) => `**第 ${n} 页**：${String(narration.get(n)).slice(0, PER_PAGE_CHARS)}`);
    const pageLabel = `第 ${picked.join('、')} 页${withTalk.length > picked.length ? `（共 ${withTalk.length} 页有讲解）` : ''}`;
    out.push('', `<details><summary>🎙 老师讲解（${pageLabel} · 语音转写原文，可能有同音错字）</summary>`, '', ...parts, '', '</details>', '');
    sections += 1; usedPages += picked.length;
  }
  return { text: out.join('\n'), sections, pages: usedPages };
}
