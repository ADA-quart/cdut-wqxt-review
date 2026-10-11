/**
 * 合并笔记里"同一小节内的近似重复条目"。
 *
 * 为什么需要：课件常按"分步动画"一页页长出来，逐页整理会把同一条知识写成
 * 「声波全波列资料的应用包括判别油气层 / 应用之一：判别油气层 / 利用全波列信息判别油气层」
 * 这种近义条目。生成笔记的最后一歩跑这个合并，把同小节内近似/包含的条目并成一条
 * （保留信息最全的一条，页码角标取并集）。
 *
 * 护栏（2026-10-12 全库实测后定）：
 *   - 只在同一小节（## / ###）内合并，跨小节与补充区不动；
 *   - 只动顶层条目（`- ` 开头、非 💭/【、非折叠答案），关键图图注（第 N 页…）不参与；
 *   - 数字不同不并（Z+1 与 Z−1）；正反义冲突不并（上方/下方、增大/减小、正比/反比、左/右…）；
 *   - 包含关系需去虚词后仍包含且长度比 ≥ 0.3；否则要求字面相似度 ≥ 0.78。
 */

const norm = (s) => String(s)
  .replace(/\[\[[^\]]*\]\]/g, '')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  .replace(/\$[^$]*\$/g, '公式')
  .replace(/[^\p{L}\p{N}]/gu, '')
  .trim();

const bigrams = (s) => {
  const g = new Set();
  for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
  return g;
};

const dice = (a, b) => {
  if (a === b) return 1;
  const A = bigrams(a); const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return (2 * inter) / (A.size + B.size);
};

const OPPOSITES = [
  ['上方', '下方'], ['上部', '下部'], ['顶部', '底部'], ['向上', '向下'], ['上升', '下降'],
  ['增大', '减小'], ['升高', '降低'], ['大于', '小于'], ['高于', '低于'], ['上游', '下游'],
  ['正比', '反比'], ['左侧', '右侧'], ['左', '右'], ['内部', '外部'],
  ['⁻', '⁺'], ['−', '+'], ['>', '≤'], ['≥', '<'],
];

const filler = (s) => s.replace(/[可的等了是为在与及和把将]/g, '');

function mergeable(a, b) {
  if (/^第\s*\d+\s*页/.test(a.raw) || /^第\s*\d+\s*页/.test(b.raw)) return false;
  const digits = (s) => (s.match(/\d+/g) || []).join(',');
  if (digits(a.n) !== digits(b.n)) return false;
  if (OPPOSITES.some(([x, y]) => (a.raw.includes(x) && b.raw.includes(y)) || (a.raw.includes(y) && b.raw.includes(x)))) return false;
  if (a.n.length < 6 || b.n.length < 6) return false;
  if (a.n.includes(b.n) || b.n.includes(a.n)) return Math.min(a.n.length, b.n.length) / Math.max(a.n.length, b.n.length) >= 0.45;
  const fa = filler(a.n); const fb = filler(b.n);
  if (fa.includes(fb) || fb.includes(fa)) return Math.min(fa.length, fb.length) / Math.max(fa.length, fb.length) >= 0.3;
  return dice(a.n, b.n) >= 0.78;
}

/**
 * @param {string} mdText 笔记正文（可含标题/图/折叠块）
 * @param {string} [lessonName] 用来重建角标文件名；缺省时沿用保留行里的角标原样
 * @returns {{ text: string, groups: number, removed: number, report: string[] }}
 */
export function mergeNoteDuplicates(mdText, lessonName = '') {
  const lines = String(mdText).split('\n');
  const sections = [];
  let cur = { title: '', items: [] };
  lines.forEach((line, idx) => {
    if (/^#{2,3}\s/.test(line.trim())) { sections.push(cur); cur = { title: line.trim(), items: [] }; return; }
    const t = line.trim();
    if (t.startsWith('- ') && !t.startsWith('- 💭') && !t.startsWith('- 【') && !t.includes('<details') && line === t) {
      cur.items.push({ raw: t.slice(2), lineNo: idx, n: norm(t.slice(2)) });
    }
  });
  sections.push(cur);

  const toDelete = new Set();
  const replacements = new Map();
  const report = [];
  let groups = 0; let removed = 0;

  for (const sec of sections) {
    const items = sec.items.filter((x) => x.n.length >= 8);
    if (items.length < 2) continue;
    const parent = items.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        if (mergeable(items[i], items[j])) { const a = find(i); const b = find(j); if (a !== b) parent[a] = b; }
      }
    }
    const byRoot = new Map();
    items.forEach((x, i) => { const r = find(i); if (!byRoot.has(r)) byRoot.set(r, []); byRoot.get(r).push(x); });
    for (const g of byRoot.values()) {
      if (g.length < 2) continue;
      const keep = g.reduce((a, b) => (b.n.length > a.n.length ? b : a), g[0]);
      const refs = [];
      for (const it of g) for (const m of it.raw.matchAll(/#page=(\d+)/g)) if (!refs.includes(Number(m[1]))) refs.push(Number(m[1]));
      const textOnly = keep.raw.replace(/\[\[[^\]]*\]\]/g, '').replace(/\s+/g, ' ').trim();
      const rebuilt = lessonName
        ? refs.map((n) => `[[${lessonName}.pdf#page=${n}|${n}]]`).join(' ')
        : (keep.raw.match(/\[\[[^\]]*\]\]/g) || []).join(' ');
      replacements.set(keep.lineNo, `- ${textOnly}${rebuilt ? ' ' + rebuilt : ''}`.trimEnd());
      for (const it of g) if (it !== keep) toDelete.add(it.lineNo);
      groups += 1;
      removed += g.length - 1;
      report.push(`【${sec.title.replace(/^#+\s*/, '') || '开头'}】保留「${keep.raw.slice(0, 60)}」，并入 ${g.length - 1} 条`);
    }
  }

  if (!groups) return { text: String(mdText), groups: 0, removed: 0, report };
  const out = [];
  lines.forEach((line, idx) => {
    if (toDelete.has(idx)) return;
    out.push(replacements.has(idx) ? replacements.get(idx) : line);
  });
  return { text: out.join('\n'), groups, removed, report };
}
