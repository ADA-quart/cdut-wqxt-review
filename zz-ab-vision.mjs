// A/B 实验：纯视觉（图片直接进模型）vs 当前管线（OCR 文本 + 讲稿）——视觉这一侧（用后即删）
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './server/config.mjs';
import { narrationByPage } from './server/pages.mjs';

const COURSE = '弹性波动力学';
const LESSON = '2026-06-29第1-2节';
const DIR = path.join('downloads', COURSE);
const OUT_DIR = 'zz-ab';
fs.mkdirSync(OUT_DIR, { recursive: true });

const prof = loadConfig().llm.profiles.text;
const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + prof.apiKey };
const url = prof.baseUrl.replace(/\/+$/, '') + '/chat/completions';

const dataUrl = (f) => 'data:image/jpeg;base64,' + fs.readFileSync(f).toString('base64');

// 组装每页素材：图片 + 该页讲稿（讲稿两边都给，变量只有「图 vs OCR 文字」）
const pagesJson = JSON.parse(fs.readFileSync(path.join(DIR, `${LESSON}.pages.json`), 'utf8'));
const tr = JSON.parse(fs.readFileSync(path.join(DIR, `${LESSON}.trans.json`), 'utf8'));
const md = fs.readFileSync(path.join(DIR, `${LESSON}.md`), 'utf8');
const survivors = [...md.matchAll(/<!-- page (\d+): ([^>]+) -->/g)].map((m) => ({ n: Number(m[1]), name: m[2].trim() }));
const narr = narrationByPage(pagesJson.pages, tr.segments, survivors);

const items = survivors.map((p) => ({
  n: p.n,
  name: p.name,
  file: path.join(DIR, LESSON, p.name),
  rel: `${LESSON}/${p.name}`,
  talk: narr.get(p.n) || '',
}));

const SYS = `你是《${COURSE}》的学霸助教。下面按顺序给你这节课**每一页幻灯片的截图**和老师讲解（语音转写，可能有同音错字）。
请直接写出这一部分的**复习笔记正文**，要求：
1) 按知识逻辑重组小节（用 ### 标题），不要按页码流水账；
2) 关键要点用「- 」开头，每条末尾带来源角标 [[${LESSON}.pdf#page=N|N]]（N 就是该页的页号）；
3) 需要理解的地方写「- 💭 讲解：…」（为什么成立、怎么用、容易混淆什么）；
4) 幻灯片上的习题：先给题干，再跟 <details><summary>先自己想，点开看答案</summary>参考答案（AI 推断）+ 解析</details>；
5) 公式用 LaTeX（$…$）；事务性信息（考试时间/地点/题型/作业）照抄原样并标【通知】；
6) 关键图在对应要点下贴出来，格式：感叹号 + 方括号（写「第 N 页图」）+ 圆括号（原样写上面给的图片路径）；
7) 只写你看到/听到的内容，看不清的地方不要猜。直接输出正文，不要前言。`;

const chunks = [items.slice(0, 6), items.slice(6, 12), items.slice(12)];
const bodies = [];
let inTok = 0;
let outTok = 0;
let secs = 0;

for (let ci = 0; ci < chunks.length; ci += 1) {
  const chunk = chunks[ci];
  const content = [];
  for (const p of chunk) {
    content.push({
      type: 'text',
      text: `【第 ${p.n} 页】图片路径（贴图时原样使用）：${p.rel}\n老师讲解：\n${p.talk || '（这一页没有识别到讲解）'}`,
    });
    content.push({ type: 'image_url', image_url: { url: dataUrl(p.file) } });
  }
  const t0 = Date.now();
  const r = await fetch(url, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      model: prof.model,
      max_tokens: 8000,
      thinking: { type: 'disabled' },
      messages: [{ role: 'system', content: SYS }, { role: 'user', content }],
    }),
    signal: AbortSignal.timeout(600000),
  });
  const j = await r.json();
  if (!r.ok) { console.log('失败:', JSON.stringify(j).slice(0, 300)); break; }
  const ms = Date.now() - t0;
  const u = j.usage || {};
  inTok += u.prompt_tokens || 0;
  outTok += u.completion_tokens || 0;
  secs += ms / 1000;
  const txt = (j.choices?.[0]?.message?.content || '').trim();
  bodies.push(txt);
  console.log(`第 ${ci + 1}/${chunks.length} 段（第 ${chunk[0].n}-${chunk[chunk.length - 1].n} 页）：${ms / 1000}s，prompt ${u.prompt_tokens}，completion ${u.completion_tokens}，正文 ${txt.length} 字`);
}

// 顶部块（事务通知 + 脉络 + 必记）
const bodyText = bodies.join('\n\n');
const t1 = Date.now();
const r2 = await fetch(url, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({
    model: prof.model,
    max_tokens: 3000,
    thinking: { type: 'disabled' },
    messages: [
      { role: 'system', content: `下面是《${COURSE}》一节课的复习笔记。请提炼三块，严格按格式输出：
## 📌 事务通知
（只写明确提到的事务性信息：考试时间/地点/题型/范围、作业提交；日期地点数字与原文一致；没有就整块不输出）
## 🧭 本课脉络
（2-4 句讲清这节课的逻辑）
## 🎯 课末必记
（最核心的 6-10 个考点，「- 」开头，能标页码就带角标）` },
      { role: 'user', content: bodyText.slice(0, 20000) },
    ],
  }),
  signal: AbortSignal.timeout(300000),
});
const j2 = await r2.json();
inTok += j2.usage?.prompt_tokens || 0;
outTok += j2.usage?.completion_tokens || 0;
secs += (Date.now() - t1) / 1000;
const head = (j2.choices?.[0]?.message?.content || '').trim();

const out = `# ${LESSON} · 深度复习笔记（纯视觉版）\n\n> 本文件由 A/B 实验生成：输入只有**幻灯片截图 + 老师讲解**，没有用 OCR 文本。\n\n${head}\n\n${bodyText}\n`;
fs.writeFileSync(path.join(OUT_DIR, 'vision.note.md'), out, 'utf8');
console.log(`\n合计：${secs.toFixed(0)}s，prompt ${inTok} tokens，completion ${outTok} tokens，成品 ${out.length} 字`);
console.log('写出：' + path.join(OUT_DIR, 'vision.note.md'));
