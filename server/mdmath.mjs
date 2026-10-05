/**
 * Markdown 里的公式体检 / 修复。
 *
 * OCR 常把公式识别坏（例：`$\verb($`、括号不配对、`$` 个数为奇数导致后面 `$$` 错位）。
 * 这里用 KaTeX 做「能不能解析」的判定（和服务端同一个引擎，浏览器里渲染也用 KaTeX），
 * 坏掉的交给 LLM 按上下文重写，改完再用 KaTeX 验一遍，过了才写回。
 */
import katex from 'katex';

/** 粗提取 md 里的数学片段：先 $$…$$，再 $…$ */
export function findMath(md) {
  const text = String(md || '');
  const items = [];
  const re = /\$\$([\s\S]+?)\$\$|\$(?!\s)([^$\n]+?)(?<!\s)\$/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const display = m[1] !== undefined;
    const tex = String((display ? m[1] : m[2]) || '').trim();
    if (!tex) continue;
    items.push({ index: m.index, end: m.index + m[0].length, raw: m[0], tex, display });
  }
  return items;
}

/** 能不能被 KaTeX 解析；OK 返回 null，失败返回错误信息 */
export function mathError(tex, display) {
  try {
    katex.renderToString(String(tex), { displayMode: Boolean(display), throwOnError: true, strict: false });
    return null;
  } catch (e) {
    return String(e?.message || e).slice(0, 200);
  }
}

/** 找出坏掉的公式（含前后文，便于 LLM 判断） */
export function findBrokenMath(md, contextLen = 160) {
  const text = String(md || '');
  return findMath(text)
    .map((item) => ({
      ...item,
      error: mathError(item.tex, item.display),
      before: text.slice(Math.max(0, item.index - contextLen), item.index).replace(/\s+/g, ' ').trim(),
      after: text.slice(item.end, item.end + contextLen).replace(/\s+/g, ' ').trim(),
    }))
    .filter((it) => it.error);
}

/** 按 {index, end, tex, display} 列表替换回 md（从后往前，保证下标有效） */
export function applyMathFixes(md, fixes) {
  let out = String(md || '');
  const sorted = [...fixes].sort((a, b) => b.index - a.index);
  for (const f of sorted) {
    const wrapped = f.display ? `$$\n${f.tex}\n$$` : `$${f.tex}$`;
    out = out.slice(0, f.index) + wrapped + out.slice(f.end);
  }
  return out;
}
