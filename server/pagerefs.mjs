/**
 * 规整笔记里的页码角标：`[[课次.pdf#page=N]]`（没写别名）→ `[[课次.pdf#page=N|N]]`。
 *
 * 为什么：别名缺失时，复习页会把整串「课次.pdf#page=N」当链接文字显示（实测全库 287 处），
 * Obsidian 里同样显示成路径。生成提示词要求带别名，但模型偶尔漏——这里做确定性兜底。
 */
const REF = /\[\[([^\]|]*?\.pdf)#page=(\d+)(?:\|([^\]]*))?\]\]/gi;

/**
 * @param {string} mdText
 * @returns {{ text: string, fixed: number }}
 */
export function normalizePageRefs(mdText) {
  let fixed = 0;
  const text = String(mdText).replace(REF, (all, file, n, label) => {
    if (label !== undefined && String(label).trim()) return all;   // 已有别名，不动
    fixed += 1;
    return `[[${file}#page=${n}|${n}]]`;
  });
  return { text, fixed };
}
