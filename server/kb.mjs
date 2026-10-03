/**
 * 知识库层：
 *  1) 把 downloads/<课程>/<课次>.md 按页拆成片段，做 BM25 风格检索（无 embedding，千页规模够用）
 *  2) 汇总全库 [[双链]] 与课程关联，供前端画知识图谱
 */
import fs from 'node:fs';
import path from 'node:path';
import { DOWNLOAD_DIR } from './paths.mjs';

const PAGE_RE = /<!-- page (\d+): ([^>]+) -->/g;
const WJ_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
const MAX_PASSAGE_CHARS = 2000;

/** 课程目录（跳过 _smoke 之类的辅助目录） */
export function listCourses() {
  if (!fs.existsSync(DOWNLOAD_DIR)) return [];
  return fs.readdirSync(DOWNLOAD_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'zh'));
}

/** 某课程下已转 MD 的课次（不含课程索引自身） */
export function listLessons(course) {
  const dir = path.join(DOWNLOAD_DIR, course);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.includes('.ocr-backup.'))
    .map((e) => e.name.replace(/\.md$/i, ''))
    .filter((name) => name !== course)
    .sort((a, b) => a.localeCompare(b, 'zh'));
}

function readMd(rel) {
  try {
    return fs.readFileSync(path.join(DOWNLOAD_DIR, rel), 'utf8');
  } catch {
    return null;
  }
}

/** 去掉图片/注释/链接语法，留下可检索的正文 */
function stripForIndex(md) {
  return String(md || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t, a) => a || t)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/[#>*_`~\[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function makePassage({ course, lesson, page, rel, text, kind }) {
  const body = String(text || '').trim().slice(0, MAX_PASSAGE_CHARS);
  return {
    id: `${rel}#${page ?? 'x'}${kind ? ':' + kind : ''}`,
    course,
    lesson,
    page: page ?? null,
    kind: kind || (page ? 'page' : 'note'),
    rel,
    text: body,
    index: stripForIndex(body),
  };
}

/** 构建片段集，可按课程/课次过滤 */
export function buildPassages({ course: courseFilter = '', lesson: lessonFilter = '' } = {}) {
  const out = [];
  for (const course of listCourses()) {
    if (courseFilter && course !== courseFilter) continue;
    for (const lesson of listLessons(course)) {
      if (lessonFilter && lesson !== lessonFilter) continue;
      const rel = `${course}/${lesson}.md`;
      const md = readMd(rel);
      if (!md) continue;
      const marks = [...md.matchAll(PAGE_RE)];
      if (marks.length === 0) {
        out.push(makePassage({ course, lesson, page: null, rel, text: md, kind: 'note' }));
        continue;
      }
      const head = md.slice(0, marks[0].index);
      if (stripForIndex(head)) out.push(makePassage({ course, lesson, page: null, rel, text: head, kind: 'head' }));
      for (let i = 0; i < marks.length; i++) {
        const start = marks[i].index + marks[i][0].length;
        const end = i + 1 < marks.length ? marks[i + 1].index : md.length;
        out.push(makePassage({ course, lesson, page: Number(marks[i][1]), rel, text: md.slice(start, end) }));
      }
    }
    if (!lessonFilter) {
      const rel = `${course}/${course}.md`;
      const md = readMd(rel);
      if (md) out.push(makePassage({ course, lesson: course, page: null, rel, text: md, kind: 'index' }));
    }
  }
  return out;
}

/** 中英文混合分词：英文按词、中文按二元组 */
function tokenize(text) {
  const t = String(text || '').toLowerCase();
  const ascii = t.match(/[a-z0-9][a-z0-9._-]{1,}/g) || [];
  const grams = [];
  for (const run of t.match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) grams.push(run);
    for (let i = 0; i + 1 < run.length; i++) grams.push(run.slice(i, i + 2));
  }
  return [...ascii, ...grams];
}

function snippetOf(passage, query) {
  const text = passage.index;
  const terms = [...new Set(tokenize(query))].sort((a, b) => b.length - a.length).slice(0, 6);
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return text.slice(0, 140);
  const from = Math.max(0, at - 60);
  return (from > 0 ? '…' : '') + text.slice(from, from + 160);
}

function scopeFilter({ scope, dir }) {
  const parts = String(dir || '').split('/').filter(Boolean);
  const course = parts[0] || '';
  const lesson = parts[1] || '';
  if (scope === 'lesson') return { course, lesson };
  if (scope === 'course') return { course, lesson: '' };
  return { course: '', lesson: '' };
}

/** BM25 风格检索：返回 { passages, stats } */
export function searchKb({ q, scope = 'all', dir = '', topK = 6 } = {}) {
  const query = String(q || '').trim();
  const all = buildPassages();
  const { course, lesson } = scopeFilter({ scope, dir });
  const pool = all.filter((p) => (!course || p.course === course) && (!lesson || p.lesson === lesson));
  if (!query || pool.length === 0) {
    return { passages: [], stats: { courses: listCourses().length, lessons: countLessons(), passages: all.length, matched: 0, scanned: pool.length } };
  }

  const qTerms = [...new Set(tokenize(query))];
  const docs = pool.map((p) => {
    const tokens = tokenize(p.index);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    return { p, tf, len: tokens.length };
  });
  const df = new Map();
  for (const d of docs) for (const t of qTerms) if (d.tf.has(t)) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length;

  const scored = [];
  for (const d of docs) {
    let score = 0;
    for (const t of qTerms) {
      const f = d.tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + N / (1 + (df.get(t) || 0)));
      score += idf * ((f * 2.2) / (f + 1.2));
    }
    if (score <= 0) continue;
    const norm = 1 / (1 + Math.log(1 + d.len / 160));
    score *= norm;
    const title = `${d.p.course} ${d.p.lesson}`;
    for (const t of qTerms) if (t.length >= 2 && title.toLowerCase().includes(t)) { score += 1.6; break; }
    scored.push({ p: d.p, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, Math.max(1, Math.min(Number(topK) || 6, 12)));
  return {
    passages: picked.map(({ p, score }) => ({
      id: p.id, course: p.course, lesson: p.lesson, page: p.page, kind: p.kind, rel: p.rel,
      text: p.text.slice(0, 1200), score: Number(score.toFixed(3)), snippet: snippetOf(p, query),
    })),
    stats: {
      courses: listCourses().length,
      lessons: countLessons(),
      passages: all.length,
      scanned: pool.length,
      matched: picked.length,
    },
  };
}

function countLessons() {
  return listCourses().reduce((n, c) => n + listLessons(c).length, 0);
}

function normalizeLink(raw) {
  return String(raw || '')
    .trim()
    .replace(/\.md$/i, '')
    .replace(/\.pdf(#page=\d+)?$/i, '')
    .replace(/#page=\d+$/i, '')
    .replace(/^\.?\//, '');
}

/** 课程 / 课次 / [[双链]] → 图谱数据 */
export function buildGraph() {
  const nodes = new Map();
  const edges = [];
  const byLessonName = new Map();
  const courses = listCourses();

  for (const course of courses) {
    nodes.set(course, { id: course, label: course, type: 'course' });
  }
  for (const course of courses) {
    for (const lesson of listLessons(course)) {
      const id = `${course}/${lesson}`;
      nodes.set(id, { id, label: lesson, type: 'lesson', course });
      edges.push({ source: id, target: course, type: 'contain' });
      if (!byLessonName.has(lesson)) byLessonName.set(lesson, []);
      byLessonName.get(lesson).push(id);
    }
  }

  for (const node of nodes.values()) {
    if (node.type !== 'lesson') continue;
    const md = readMd(`${node.id}.md`);
    if (!md) continue;
    const links = new Set();
    for (const m of md.matchAll(WJ_RE)) {
      const target = normalizeLink(m[1]);
      if (!target) continue;
      if (target.includes('/') && nodes.has(target)) { links.add(target); continue; }
      const sameCourse = `${node.course}/${target}`;
      if (nodes.has(sameCourse)) { links.add(sameCourse); continue; }
      const hits = byLessonName.get(target) || [];
      if (hits.length === 1) { links.add(hits[0]); continue; }
      if (nodes.has(target) && nodes.get(target).type === 'course') links.add(target);
    }
    for (const t of links) if (t !== node.id) edges.push({ source: node.id, target: t, type: 'link' });
  }

  // 课程间关联（由「课程间知识链」写进课程索引的 llm-courses 块）
  for (const course of courses) {
    const md = readMd(`${course}/${course}.md`);
    if (!md) continue;
    const block = md.match(/<!-- llm-courses:start -->[\s\S]*?<!-- llm-courses:end -->/);
    if (!block) continue;
    for (const m of block[0].matchAll(WJ_RE)) {
      const target = normalizeLink(m[1]);
      if (target !== course && nodes.get(target)?.type === 'course') {
        edges.push({ source: course, target, type: 'course' });
      }
    }
  }

  const seen = new Set();
  const uniqueEdges = edges.filter((e) => {
    const key = `${e.source}>${e.target}>${e.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    nodes: [...nodes.values()],
    edges: uniqueEdges,
    stats: {
      courses: courses.length,
      lessons: countLessons(),
      passages: buildPassages().length,
      links: uniqueEdges.filter((e) => e.type !== 'contain').length,
    },
  };
}
