/**
 * 兜底：单行里 `$` 个数为奇数（公式没写完/漏闭合，多来自模型输出被 maxTokens 截断）时，
 * 砍掉最后一个未闭合 `$` 之后的内容——否则一个坏行会把后面整段的渲染带歪。
 * 跳过 `$$` 块公式区间与图片/HTML/标题行。
 */
export function trimUnbalancedMath(mdText) {
  let trimmed = 0;
  let inBlock = false;
  const out = String(mdText).split('\n').map((l) => {
    const t = l.trim();
    if (t.startsWith('$$')) {
      if ((t.match(/\$\$/g) || []).length % 2 === 1) inBlock = !inBlock;   // 围栏行
      return l;
    }
    if (inBlock || !t || t.startsWith('<') || t.startsWith('!') || t.startsWith('#')) return l;
    const count = (t.match(/\$/g) || []).length;
    if (count % 2 === 0) return l;
    const last = l.lastIndexOf('$');
    if (last < 0) return l;
    trimmed += 1;
    return l.slice(0, last).replace(/[\s，、,（(【\[]+$/u, '');
  });
  return { text: out.join('\n'), trimmed };
}
