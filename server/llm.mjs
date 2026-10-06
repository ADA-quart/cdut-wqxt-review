/**
 * LLM 文档操作：OCR 纠错（proofread）与重点总结（summarize）。
 *
 * 纠错三档模式（对应 config 里的三个 profile，均为 OpenAI 兼容接口）：
 *   text        纯文本   —— 只发 OCR 文字，最省 token（默认）
 *   visionCloud 图片上云 —— 页面图 + 文字发给云端视觉模型，精度最高
 *   visionLocal 图片本地 —— 发给本机推理服务（Ollama / vLLM），零 API 费用
 *
 * 任务串行排队；任务内部按页/按块并发（并发数可配）。
 * 每个任务统计 token 用量（接口返回 usage 时）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DATA_DIR, NOTES_DIR, DOWNLOAD_DIR, ensureInside } from './paths.mjs';
import { loadConfig, getProfile, PROFILE_KEYS } from './config.mjs';
import { describeFetchError } from './net.mjs';
import { findMath, findBrokenMath, mathError, applyMathFixes } from './mdmath.mjs';

export const events = new EventEmitter();
events.setMaxListeners(50);

const llmJobs = new Map();
let nextJobId = 1;
let queue = Promise.resolve();

const MODE_LABELS = { text: '纯文本', visionCloud: '图片上云', visionLocal: '图片本地' };

// ---------- LLM 调用 ----------

/**
 * @returns {Promise<{content: string, usage: {prompt_tokens?: number, completion_tokens?: number}|null}>}
 */
/**
 * 模型能力（上下文 / 最大输出）：能从 /v1/models 拿到就用真值，否则查内置表，
 * 再不行给保守默认值。key = baseUrl|model。
 */
const modelCaps = new Map();

function guessCaps(model) {
  const m = String(model || '').toLowerCase();
  if (/deepseek/.test(m)) return { context: 65536, output: 8192, source: '内置估算' };
  if (/gpt-4o|gpt-4\.1|o[13]/.test(m)) return { context: 128000, output: 16384, source: '内置估算' };
  if (/qwen/.test(m)) return { context: 131072, output: 8192, source: '内置估算' };
  if (/glm/.test(m)) return { context: 128000, output: 4096, source: '内置估算' };
  if (/kimi|moonshot/.test(m)) return { context: 262144, output: 8192, source: '内置估算' };
  if (/llama|mistral|qwen2\.5vl/.test(m)) return { context: 32768, output: 4096, source: '内置估算' };
  return { context: 32768, output: 4096, source: '默认值' };
}

export function rememberCaps(base, model, caps) {
  if (!base || !model) return;
  modelCaps.set(base + '|' + model, { ...caps, at: Date.now() });
}

export function getCaps(profile = 'text') {
  const prof = getProfile(profile);
  const key = String(prof.baseUrl || '').replace(/\/+$/, '') + '|' + prof.model;
  const hit = modelCaps.get(key);
  if (hit) return hit;
  return guessCaps(prof.model);
}

async function chat(messages, { profile = 'text', temperature, maxTokens } = {}) {
  const cfg = loadConfig().llm;
  const prof = getProfile(profile);
  const label = MODE_LABELS[profile] || profile;
  if (!prof.apiKey) throw new Error(`未配置「${label}」的 API Key（右上角 LLM 设置）`);
  const base = String(prof.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error(`未配置「${label}」的接口地址`);

  const body = {
    model: prof.model,
    messages,
    temperature: temperature ?? cfg.temperature ?? 0.2,
    stream: false,
  };
  const caps = getCaps(profile);
  if (maxTokens) body.max_tokens = caps.output ? Math.min(maxTokens, caps.output) : maxTokens;

  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${prof.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
  } catch (err) {
    throw describeFetchError(err, { base, label, timeoutSec: 180 });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM 接口 ${res.status}：${text.slice(0, 300)}`);
  }
  let data = await res.json();
  let message = data?.choices?.[0]?.message;
  let content = message?.content;

  // 推理型模型（deepseek-v4-pro / deepseek-flash 等）：思考也吃 max_tokens，
  // 预算给小了会「只有思考、没有正文」。循环加大预算（×3）直到出正文或到模型上限。
  let bump = 0;
  while (!String(content || '').trim() && message?.reasoning_content && bump < 4) {
    const curTokens = Number(body.max_tokens) || 1200;
    const bigger = Math.min(curTokens * 3, caps.output || 8000);
    if (bigger <= curTokens) break;
    body.max_tokens = bigger;
    bump += 1;
    let res2;
    try {
      res2 = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${prof.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000),
      });
    } catch (err) {
      throw describeFetchError(err, { base, label, timeoutSec: 180 });
    }
    if (!res2.ok) break;
    data = await res2.json();
    message = data?.choices?.[0]?.message;
    content = message?.content;
  }

  if (!content || !String(content).trim()) {
    const finish = data?.choices?.[0]?.finish_reason;
    const reasoning = message?.reasoning_content;
    throw new Error(
      finish === 'length' || reasoning
        ? '模型返回为空（推理型模型把 token 用在思考上；已自动加大到 ' + (body.max_tokens || '?') + ' tokens，模型上限 ' + (caps.output || '?') + '，仍没有正文，建议换非推理模型）'
        : 'LLM 返回为空',
    );
  }
  return { content: String(content).trim(), usage: data?.usage || null };
}

function addUsage(job, usage) {
  if (!usage) return;
  job.usage.prompt += Number(usage.prompt_tokens) || 0;
  job.usage.completion += Number(usage.completion_tokens) || 0;
}

// ---------- 通用工具 ----------

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

async function chatRetry(messages, opts, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await chat(messages, opts);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
  throw lastErr;
}

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', bmp: 'image/bmp' };

function toImageDataUrl(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime = MIME[ext] || 'image/jpeg';
  const b64 = fs.readFileSync(filePath).toString('base64');
  return `data:${mime};base64,${b64}`;
}

// ---------- Markdown 结构工具 ----------

function splitPages(md) {
  const re = /<!-- page (\d+): ([^>]+) -->/g;
  const marks = [];
  let m;
  while ((m = re.exec(md))) marks.push({ idx: m.index, end: re.lastIndex, n: m[1], name: m[2], marker: m[0] });
  if (marks.length === 0) return { head: md, pages: [] };
  const head = md.slice(0, marks[0].idx);
  const pages = marks.map((mk, i) => ({
    n: mk.n,
    name: mk.name,
    marker: mk.marker,
    body: md.slice(mk.end, i + 1 < marks.length ? marks[i + 1].idx : md.length),
  }));
  return { head, pages };
}

function imageRefs(text) {
  return (text.match(/!\[[^\]]*\]\([^)]*\)/g) || []).sort();
}

function wikiLinks(text) {
  return (text.match(/\[\[[^\]]+\]\]/g) || []).sort();
}

function stripForSummary(md) {
  return md
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (t.startsWith('<!--')) return false;
      if (/^📄\s*\[\[/.test(t)) return false;
      if (/^!\[[^\]]*\]\([^)]*\)$/.test(t)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function chunkText(text, maxLen = 6000) {
  const paras = text.split(/\n{2,}/).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    if (cur.length + p.length > maxLen && cur) {
      chunks.push(cur);
      cur = '';
    }
    cur += (cur ? '\n\n' : '') + p;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks.length ? chunks : [text];
}

// ---------- 纠错 ----------

const PROOF_SYSTEM_TEXT = `你是一名严谨的中文理工科教材校对员。输入是某页 PPT 的 OCR 识别结果（Markdown，含 LaTeX 公式与图片引用）。

任务：只修正明显的 OCR 字符错误（形近字、音近字、多字漏字），例如：
- 「也位差」→「电位差」
- 「人地电阳率」→「大地电阻率」
- 「口极装置」→「二极装置」
- 「跑极」保留（专业术语），「测点」「供电电流」等专业词优先保留

硬性要求（违反即视为失败）：
1. 不改动、不删除、不新增任何图片引用（![](...)）、wiki 链接（[[...]]）和 HTML 注释。
2. LaTeX 公式（$...$ 与 $$...$$）原样保留，不重写、不"修正"公式内容。
3. 保持段落与列表结构，顺序不变。
4. 不确定的地方保持原样——宁可不改。
5. 只输出修正后的完整 Markdown 正文，不要解释，不要用代码块包裹。`;

const PROOF_SYSTEM_VISION = `${PROOF_SYSTEM_TEXT}

另外：你会同时收到这页 PPT 的原始截图。请以截图为准校对文字——
特别是专业术语、公式符号、上下标、变量名（如 ρ、ΔU、K、AM 等）要与截图一致。
仍然遵守上述硬性要求：图片引用、链接、注释、LaTeX 公式的结构不变。`;

/** 从 job 里取出课程 / 课次名，拼成提示词用的上下文 */
function courseContext(job) {
  const parts = String(job?.relDir || '').split('/').filter(Boolean);
  const course = job?.courseName || parts[0] || '';
  const lesson = parts[1] || job?.title || '';
  return { course, lesson };
}

async function proofreadPage(page, { mode, mediaDir, job }) {
  const raw = page.body;
  const body = raw.trim();
  if (!body || body.length < 8) return raw;
  // 保留原文首尾空白（页标记/链接之间的换行），拼回时不丢格式
  const lead = /^\s*/.exec(raw)[0];
  const trail = /\s*$/.exec(raw)[0];

  const profile = mode === 'text' ? 'text' : mode;
  const ctx = courseContext(job);
  if (ctx.course && !job._ctxLogged) { job._ctxLogged = true; job.log.push('提示词上下文：《' + ctx.course + '》'); }
  const scopeNote = ctx.course
    ? `\n\n【当前课程】${ctx.course}\n` +
      '请按这门课的专业术语（该领域的行话、符号、变量名）来判断哪些是 OCR 错字；'
      + '拿不准的术语保持原样，不要改成通用词。'
    : '';
  const system = (mode === 'text' ? PROOF_SYSTEM_TEXT : PROOF_SYSTEM_VISION) + scopeNote;
  let userContent = body;

  if (mode !== 'text') {
    const imgPath = path.join(mediaDir, page.name);
    if (!fs.existsSync(imgPath)) {
      job.log.push(`第 ${page.n} 页缺少原图（${page.name}），已按纯文本处理`);
    } else {
      userContent = [
        { type: 'text', text: body },
        { type: 'image_url', image_url: { url: toImageDataUrl(imgPath) } },
      ];
    }
  }

  const { content: corrected, usage } = await chatRetry(
    [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ],
    { profile, temperature: 0.1, maxTokens: Math.min(4000, Math.max(600, body.length * 2)) },
  );
  addUsage(job, usage);

  const sameImages = JSON.stringify(imageRefs(corrected)) === JSON.stringify(imageRefs(body));
  const sameLinks = JSON.stringify(wikiLinks(corrected)) === JSON.stringify(wikiLinks(body));
  const lenOk = corrected.length >= body.length * 0.5 && corrected.length <= body.length * 1.6;
  const noComment = !corrected.includes('<!--') && !body.includes('<!--');
  if (!(sameImages && sameLinks && lenOk && noComment)) {
    const err = new Error('结构校验未通过（图片/链接/长度异常），本页保留原文');
    err.keepOriginal = true;
    throw err;
  }
  return lead + corrected + trail;
}

async function runProofread(job) {
  const mdPath = job.mdPath;
  const original = fs.readFileSync(mdPath, 'utf8');
  const { head, pages } = splitPages(original);
  const limit = loadConfig().llm.concurrency || 3;
  let done = 0;

  if (pages.length === 0) {
    job.progress.total = 1;
    const corrected = await proofreadPage({ n: 1, name: '', body: original }, { mode: job.mode, mediaDir: job.mediaDir, job });
    fs.writeFileSync(mdPath, corrected.endsWith('\n') ? corrected : corrected + '\n', 'utf8');
    job.progress.done = 1;
    emit(job);
    return { pages: 1, kept: 0 };
  }

  job.progress.total = pages.length;
  emit(job);

  let kept = 0;
  const correctedBodies = await mapLimit(pages, limit, async (p) => {
    try {
      return await proofreadPage(p, { mode: job.mode, mediaDir: job.mediaDir, job });
    } catch (e) {
      if (e.keepOriginal) {
        kept++;
        job.log.push(`第 ${p.n} 页保留原文（${e.message}）`);
        return p.body;
      }
      const msg = String(e?.message || e);
      if (/未配置|400|401|403|404/.test(msg)) throw e;
      kept++;
      job.log.push(`第 ${p.n} 页保留原文（${msg.slice(0, 120)}）`);
      return p.body;
    } finally {
      done++;
      job.progress.done = done;
      job.progress.current = `第 ${p.n} 页`;
      emit(job);
    }
  });

  if (job.canceled) return { pages: pages.length, kept };

  const bak = mdPath.replace(/\.md$/i, '') + '.ocr-backup.md';
  if (!fs.existsSync(bak)) fs.copyFileSync(mdPath, bak);

  const rebuilt = head + pages.map((p, i) => p.marker + correctedBodies[i]).join('');
  fs.writeFileSync(mdPath, rebuilt, 'utf8');
  return { pages: pages.length, kept };
}

// ---------- 总结（始终用 text 档位，省钱且够用） ----------

async function runSummarize(job) {
  const mdPath = job.mdPath;
  const original = fs.readFileSync(mdPath, 'utf8');

  const cleaned = original.replace(/<!-- llm-summary:start -->[\s\S]*?<!-- llm-summary:end -->\s*/g, '');
  const text = stripForSummary(cleaned);
  if (!text) throw new Error('内容为空，无法总结');

  const chunks = chunkText(text, 6000);
  const ctx = courseContext(job);
  if (ctx.course) job.log.push('提示词上下文：《' + ctx.course + '》');
  job.progress.total = chunks.length + 1;
  emit(job);

  const limit = loadConfig().llm.concurrency || 3;
  let done = 0;
  const partSummaries = await mapLimit(chunks, limit, async (c, i) => {
    const { content: s, usage } = await chatRetry(
      [
        { role: 'system', content: `你在帮大学生整理《${ctx.course || '本课程'}》这门课的复习提纲。提取给定内容的重点，用中文输出 3-8 条要点（- 开头）。公式用 LaTeX（$...$）。只输出要点，不要前言后语。` },
        { role: 'user', content: `第 ${i + 1}/${chunks.length} 段课件内容：\n\n${c}` },
      ],
      { profile: 'text', temperature: 0.3, maxTokens: 1200 },
    );
    addUsage(job, usage);
    done++;
    job.progress.done = done;
    job.progress.current = `分块 ${i + 1}/${chunks.length}`;
    emit(job);
    return s;
  });

  if (job.canceled) return { chunks: chunks.length };

  const { content: merged, usage } = await chatRetry(
    [
      {
        role: 'system',
        content: `你在帮大学生生成《${ctx.course || '本课程'}》这门课课件的复习要点。下面是分块提取的要点，请合并去重、按主题重新组织，输出一份精炼的「重点总结」，包含：
1) ## 重点总结（标题行固定用这个）
2) 随后按内容组织成 2-4 个三级标题（### xxx），每节 3-6 条要点
3) 关键公式用 LaTeX（$...$ 或 $$...$$），保留课程中的符号定义
4) 最后加一节「### 易错点提醒」（如有）
只输出总结正文（从 ## 重点总结 开始），不要任何解释。`,
      },
      { role: 'user', content: partSummaries.join('\n\n---\n\n') },
    ],
    { profile: 'text', temperature: 0.3, maxTokens: 2500 },
  );
  addUsage(job, usage);
  done++;
  job.progress.done = done;
  job.progress.current = '汇总';
  emit(job);

  const block = `<!-- llm-summary:start -->\n${merged.trim()}\n<!-- llm-summary:end -->\n\n`;
  const titleMatch = /^#\s.*\n/m.exec(cleaned);
  const next = titleMatch
    ? cleaned.slice(0, titleMatch.index + titleMatch[0].length) + '\n' + block + cleaned.slice(titleMatch.index + titleMatch[0].length)
    : block + cleaned;
  fs.writeFileSync(mdPath, next, 'utf8');
  return { chunks: chunks.length };
}

// ---------- 知识链（AI 织网）----------

/** 收集某课程下已转 MD 的课次 */
function collectLessonMds(courseAbs) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(courseAbs, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name.endsWith('_assets')) continue;
    const mdPath = path.join(courseAbs, `${e.name}.md`);
    if (fs.existsSync(mdPath)) out.push({ name: e.name, mdPath });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

/** 课次摘要：优先用重点总结块，其次正文前段 */
function lessonSummaryText(md) {
  const m = /<!-- llm-summary:start -->([\s\S]*?)<!-- llm-summary:end -->/.exec(md);
  const src = m ? m[1] : stripForSummary(md);
  return src.replace(/^##\s*重点总结\s*$/m, '').trim().slice(0, 600);
}

function parseJsonLoose(text) {
  let t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

function extractBlock(text, marker) {
  const re = new RegExp(`<!-- ${marker}:start -->[\\s\\S]*?<!-- ${marker}:end -->`);
  const m = re.exec(text);
  return m ? m[0] : '';
}

/** 替换/插入带标记的块；block 为 null 时移除 */
function upsertBlock(text, marker, block) {
  const re = new RegExp(`<!-- ${marker}:start -->[\\s\\S]*?<!-- ${marker}:end -->\\n?`);
  if (!block) return text.replace(re, '');
  if (re.test(text)) return text.replace(re, block);
  const summaryRe = /<!-- llm-summary:start -->[\s\S]*?<!-- llm-summary:end -->\n?/;
  const sm = summaryRe.exec(text);
  if (sm) {
    const pos = sm.index + sm[0].length;
    return text.slice(0, pos) + '\n' + block + text.slice(pos);
  }
  const t = /^#\s.*\n/m.exec(text);
  const pos = t ? t.index + t[0].length : 0;
  return text.slice(0, pos) + '\n' + block + text.slice(pos);
}

const relOf = (p) => path.relative(NOTES_DIR, p).split(path.sep).join('/');

/** 公式修复：找出 KaTeX 解析不了的公式，让 LLM 重写，再用 KaTeX 验一遍才写回 */
async function runFixMath(job) {
  const mdPath = job.mdPath;
  const original = fs.readFileSync(mdPath, 'utf8');
  const all = findMath(original);
  const broken = findBrokenMath(original);
  const ctx2 = courseContext(job);
  if (ctx2.course) job.log.push('提示词上下文：《' + ctx2.course + '》');
  job.progress.total = broken.length;
  emit(job);
  if (!broken.length) {
    job.log.push('没有发现解析不了的公式');
    return { checked: all.length, broken: 0, fixed: 0 };
  }
  job.log.push(`共 ${all.length} 条公式，其中 ${broken.length} 条无法解析`);

  const fixes = [];
  let done = 0;
  for (const item of broken) {
    if (job.canceled) break;
    job.progress.current = `公式 ${done + 1}/${broken.length}`;
    emit(job);
    const ask = [
      `下面是从《${ctx2.course || '课件'}》OCR 得到的 LaTeX 公式，KaTeX 解析报错。请把它改成等价的、KaTeX 能解析的 LaTeX。`,
      '要求：只输出修正后的 LaTeX 本体，不要 $ 或 $ 包裹，不要解释；保持符号含义不变（如 \\slash → /、\\verb( → ( 、括号配平）。',
      '',
      'KaTeX 报错：' + item.error,
      '原公式：' + item.tex,
      item.before ? '前文：' + item.before : '',
      item.after ? '后文：' + item.after : '',
    ].filter(Boolean).join('\n');
    try {
      const { content, usage } = await chatRetry([{ role: 'user', content: ask }], { profile: 'text', temperature: 0.1, maxTokens: 500 });
      addUsage(job, usage);
      let tex = String(content).trim().replace(/^```(?:latex|tex)?/i, '').replace(/```$/, '').trim();
      tex = tex.replace(/^\$\$?/, '').replace(/\$\$?$/, '').trim();
      const err2 = mathError(tex, item.display);
      if (!err2) {
        fixes.push({ ...item, tex });
        job.log.push('已修复一处公式');
      } else {
        job.log.push('有一处修复后仍无法解析，已跳过：' + err2.slice(0, 60));
      }
    } catch (e) {
      job.log.push('修复失败：' + String(e?.message || e).slice(0, 80));
    }
    done += 1;
    job.progress.done = done;
    emit(job);
  }

  if (fixes.length) {
    fs.writeFileSync(mdPath.replace(/\.md$/, '.math-backup.md'), original, 'utf8');
    fs.writeFileSync(mdPath, applyMathFixes(original, fixes), 'utf8');
  }
  return { checked: all.length, broken: broken.length, fixed: fixes.length };
}

/**
 * 生成「给人看的笔记」：<课次>.note.md
 * 特点：按页分块（不按字符瞎切）→ 每块产出带页码引用的小节，
 * 引用格式沿用 [[xxx.pdf#page=N|N]]，复习页点击即可跳到对应 PPT 页。
 */
async function runNote(job) {
  const mdPath = job.mdPath;
  const original = fs.readFileSync(mdPath, 'utf8');
  const ctx = courseContext(job);
  if (ctx.course) job.log.push('提示词上下文：《' + ctx.course + '》');

  // 按页切分原文
  const re = /<!-- page (\d+): [^>]+ -->/g;
  const marks = [...original.matchAll(re)];
  const pages = marks.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : original.length;
    return { n: Number(m[1]), text: stripForSummary(original.slice(start, end)) };
  }).filter((p) => p.text);
  if (!pages.length) throw new Error('没有可用的页面内容（先转 MD）');

  // 按「页数 + 字符预算」分块，保证每块落在页边界上
  const CHUNK_CHARS = 5200;
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const p of pages) {
    if (cur.length && (size + p.text.length > CHUNK_CHARS || cur.length >= 10)) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(p);
    size += p.text.length;
  }
  if (cur.length) chunks.push(cur);

  const lessonName = path.basename(mdPath).replace(/\.md$/i, '');
  job.progress.total = chunks.length + 1;
  emit(job);

  const limit = loadConfig().llm.concurrency || 3;
  let done = 0;
  const sections = await mapLimit(chunks, limit, async (chunk, i) => {
    const from = chunk[0].n;
    const to = chunk[chunk.length - 1].n;
    const body = chunk.map((p) => `[第 ${p.n} 页]\n${p.text}`).join('\n\n');
    const { content, usage } = await chatRetry(
      [
        {
          role: 'system',
          content: `你在帮大学生把《${ctx.course || '本课程'}》的课件原文整理成复习笔记（第 ${from}-${to} 页这一部分）。
要求：
1) 按主题分成 1-3 个小节，每节一个三级标题（### 小节名）；
2) 每节 3-6 条要点，用「- 」开头，一条讲清一个知识点；
3) **每条要点末尾标注它来自哪一页**，格式固定为 [[${lessonName}.pdf#page=N|N]]（N 是上方「[第 N 页]」里的页码，必须真实存在，不许编）；
4) 关键公式用 LaTeX（$...$ 或 $...$），保留原文符号；
5) 只输出笔记正文（从 ### 开始），不要前言、不要解释、不要代码块。`,
        },
        { role: 'user', content: body },
      ],
      { profile: 'text', temperature: 0.3, maxTokens: 4000 },
    );
    addUsage(job, usage);
    done += 1;
    job.progress.done = done;
    job.progress.current = `第 ${from}-${to} 页`;
    emit(job);
    return content.trim();
  });

  // 页码校验：丢掉超出范围的引用编号
  const valid = new Set(pages.map((p) => String(p.n)));
  const fix = (s) => s.replace(/\[\[[^\]]*\.pdf#page=(\d+)\|([^\]]*)\]\]/g, (m, n, label) =>
    valid.has(String(Number(n))) ? m : label);
  let note = sections.map(fix).join('\n\n').trim();
  if (!note) throw new Error('笔记生成结果为空');

  const head = `# ${lessonName} · 复习笔记\n\n> 由课件原文整理，每条要点末尾的角标是对应页码，点击可跳到右侧课件。\n\n`;
  const notePath = mdPath.replace(/\.md$/i, '.note.md');
  fs.writeFileSync(notePath, head + note + '\n', 'utf8');
  job.noteRel = path.relative(NOTES_DIR, notePath).split(path.sep).join('/');

  job.progress.done = job.progress.total;
  job.progress.current = '完成';
  emit(job);
  return { chunks: chunks.length, pages: pages.length, note: job.noteRel };
}

/** 课程内知识链：生成课程索引 + 每个课次的「相关课次」块 */
async function runWeaveCourse(job) {
  const courseName = job.courseName || path.basename(job.absDir);
  const courseAbs = path.join(NOTES_DIR, courseName);
  const lessons = collectLessonMds(courseAbs);
  if (lessons.length === 0) throw new Error('该课程还没有已转 MD 的课次');

  job.progress.total = 2;
  job.progress.current = '读取课次摘要';
  emit(job);
  const items = lessons.map((l) => ({
    name: l.name,
    summary: lessonSummaryText(fs.readFileSync(l.mdPath, 'utf8')),
  }));
  job.progress.done = 1;
  emit(job);

  const payload = items.map((it) => `【${it.name}】\n${it.summary}`).join('\n\n');
  const { content, usage } = await chatRetry(
    [
      {
        role: 'system',
        content: `你是课程知识地图助手。给定一门课的课次与摘要，请输出 JSON（不要代码块）：
{"groups":[{"topic":"主题名","lessons":["课次名"]}],"related":[{"from":"课次名","to":"课次名","reason":"一句话说明关系"}]}
要求：
- 课次名必须与给定名称完全一致
- groups 按知识主题分组，覆盖所有课次
- related 只列真正有知识关联的课次对（每课最多 2 条），reason 用中文、20 字以内
只输出 JSON。`,
      },
      { role: 'user', content: payload },
    ],
    { profile: 'text', temperature: 0.2, maxTokens: 2000 },
  );
  addUsage(job, usage);

  const parsed = parseJsonLoose(content);
  const names = new Set(lessons.map((l) => l.name));
  const groups = (parsed.groups || [])
    .map((g) => ({
      topic: String(g.topic || '').trim(),
      lessons: (g.lessons || []).map(String).filter((n) => names.has(n)),
    }))
    .filter((g) => g.topic && g.lessons.length);
  const related = (parsed.related || [])
    .map((r) => ({ from: String(r.from || '').trim(), to: String(r.to || '').trim(), reason: String(r.reason || '').trim() }))
    .filter((r) => names.has(r.from) && names.has(r.to) && r.from !== r.to);

  const inGroups = new Set(groups.flatMap((g) => g.lessons));
  const rest = lessons.map((l) => l.name).filter((n) => !inGroups.has(n));
  if (rest.length) groups.push({ topic: '其他课次', lessons: rest });

  // 课程索引（保留课程间关联块）
  const idxPath = path.join(courseAbs, `${courseName}.md`);
  const lines = [`# ${courseName}`, '', '> 课程索引（AI 生成，重新生成会覆盖本文件）', '', '## 知识结构', ''];
  for (const g of groups) {
    lines.push(`### ${g.topic}`, '');
    for (const n of g.lessons) lines.push(`- [[${n}]]`);
    lines.push('');
  }
  lines.push('## 课次索引', '');
  for (const l of lessons) lines.push(`- [[${l.name}]]`);
  lines.push('');
  let idxMd = lines.join('\n');
  if (fs.existsSync(idxPath)) {
    const kept = extractBlock(fs.readFileSync(idxPath, 'utf8'), 'llm-courses');
    if (kept) idxMd = idxMd.trimEnd() + '\n\n' + kept + '\n';
  }
  fs.writeFileSync(idxPath, idxMd, 'utf8');
  job.resultRel = relOf(idxPath);

  // 双向「相关课次」
  const byLesson = new Map();
  const push = (a, b, reason) => {
    if (!byLesson.has(a)) byLesson.set(a, []);
    byLesson.get(a).push({ to: b, reason });
  };
  for (const r of related) { push(r.from, r.to, r.reason); push(r.to, r.from, r.reason); }
  for (const l of lessons) {
    const rels = byLesson.get(l.name) || [];
    const block = rels.length
      ? `<!-- llm-related:start -->\n## 相关课次\n\n${rels.map((r) => `- [[${r.to}]] — ${r.reason}`).join('\n')}\n<!-- llm-related:end -->\n`
      : null;
    fs.writeFileSync(l.mdPath, upsertBlock(fs.readFileSync(l.mdPath, 'utf8'), 'llm-related', block), 'utf8');
  }

  job.progress.done = 2;
  emit(job);
  return { lessons: lessons.length, groups: groups.length, related: related.length };
}

/** 课程间知识链：课程索引互链 + 根目录「知识链.md」 */
async function runWeaveCourses(job) {
  const courses = [];
  let entries = [];
  try { entries = fs.readdirSync(NOTES_DIR, { withFileTypes: true }); } catch { entries = []; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const courseAbs = path.join(NOTES_DIR, e.name);
    const lessons = collectLessonMds(courseAbs);
    if (lessons.length > 0) courses.push({ name: e.name, abs: courseAbs, lessons });
  }
  if (courses.length < 2) throw new Error('至少需要两门已转 MD 的课程，才能生成课程间知识链');

  job.progress.total = 2;
  job.progress.current = '分析课程结构';
  emit(job);
  const payload = courses
    .map((c) => {
      const idxPath = path.join(c.abs, `${c.name}.md`);
      const idxText = fs.existsSync(idxPath) ? stripForSummary(fs.readFileSync(idxPath, 'utf8')).slice(0, 300) : '';
      return `【${c.name}】课次：${c.lessons.map((l) => l.name).join('、')}${idxText ? `\n概述：${idxText}` : ''}`;
    })
    .join('\n\n');
  job.progress.done = 1;
  emit(job);

  const { content, usage } = await chatRetry(
    [
      {
        role: 'system',
        content: `你是课程体系地图助手。给定一位学生学过的课程（课程名 + 课次列表 + 概述），请找出课程之间的知识关联（如：同一学科方向、先修-后续关系、方法论相通）。输出 JSON（不要代码块）：
{"related":[{"from":"课程A","to":"课程B","reason":"一句话说明关联"}]}
要求：
- 课程名必须与给定名称完全一致
- 只列真正相关的课程对，宁缺毋滥；每门课最多 2 条
- reason 用中文、20-30 字
只输出 JSON。`,
      },
      { role: 'user', content: payload },
    ],
    { profile: 'text', temperature: 0.2, maxTokens: 1500 },
  );
  addUsage(job, usage);

  const parsed = parseJsonLoose(content);
  const names = new Set(courses.map((c) => c.name));
  const related = (parsed.related || [])
    .map((r) => ({ from: String(r.from || '').trim(), to: String(r.to || '').trim(), reason: String(r.reason || '').trim() }))
    .filter((r) => names.has(r.from) && names.has(r.to) && r.from !== r.to);

  const byCourse = new Map();
  const push = (a, b, reason) => {
    if (!byCourse.has(a)) byCourse.set(a, []);
    byCourse.get(a).push({ to: b, reason });
  };
  for (const r of related) { push(r.from, r.to, r.reason); push(r.to, r.from, r.reason); }

  for (const c of courses) {
    const idxPath = path.join(c.abs, `${c.name}.md`);
    let md = fs.existsSync(idxPath)
      ? fs.readFileSync(idxPath, 'utf8')
      : `# ${c.name}\n\n> 课程索引（AI 生成）\n\n## 课次索引\n\n${c.lessons.map((l) => `- [[${l.name}]]`).join('\n')}\n`;
    const rels = byCourse.get(c.name) || [];
    const body = rels.length
      ? rels.map((r) => `- [[${r.to}]] — ${r.reason}`).join('\n')
      : '（暂未识别到明显关联）';
    const block = `<!-- llm-courses:start -->\n## 相关课程\n\n${body}\n<!-- llm-courses:end -->\n`;
    fs.writeFileSync(idxPath, upsertBlock(md, 'llm-courses', block), 'utf8');
  }

  const rootLines = ['# 知识链', '', '> AI 生成的课程关系总览', '', '## 课程', ''];
  for (const c of courses) rootLines.push(`- [[${c.name}]]`);
  rootLines.push('', '## 课程关系', '');
  if (related.length) rootLines.push(...related.map((r) => `- [[${r.from}]] ↔ [[${r.to}]] — ${r.reason}`));
  else rootLines.push('（暂未识别出明确的课程关联）');
  rootLines.push('');
  const rootPath = path.join(NOTES_DIR, '知识链.md');
  fs.writeFileSync(rootPath, rootLines.join('\n'), 'utf8');
  job.resultRel = relOf(rootPath);

  job.progress.done = 2;
  emit(job);
  return { courses: courses.length, related: related.length };
}

async function runWeave(job) {
  return job.scope === 'all' ? runWeaveCourses(job) : runWeaveCourse(job);
}

// ---------- 任务管理 ----------

function publicJob(j) {
  return {
    id: j.id,
    kind: 'llm',
    op: j.op,
    mode: j.mode,
    status: j.status,
    dir: j.relDir,
    title: j.title,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    progress: j.progress,
    outMd: j.outMd,
    scope: j.scope || null,
    result: j.resultRel || null,
    usage: j.usage,
    error: j.error,
    log: j.log.slice(-8),
  };
}

function emit(job) {
  events.emit('update', publicJob(job));
}

export function listLlmJobs() {
  return [...llmJobs.values()].map(publicJob);
}

export function getLlmJob(id) {
  const j = llmJobs.get(id);
  return j ? publicJob(j) : null;
}

export function createLlmJob({ op, dir, mode, scope }) {
  if (!['proofread', 'summarize', 'weave', 'fixmath', 'note'].includes(op)) throw new Error(`不支持的操作：${op}`);
  const relDir = String(dir || '').replace(/^[/\\]+/, '');
  let absDir = null;
  let mdPath = null;
  let title = '';

  if (op === 'weave' && scope === 'all') {
    title = '课程间知识链';
  } else {
    absDir = ensureInside(DOWNLOAD_DIR, path.join(DOWNLOAD_DIR, relDir));
    const parts = relDir.split('/').filter(Boolean);
    const courseName = parts[0] || '';
    const lessonName = parts[1] || '';
    if (op === 'weave') {
      // 课程级操作只依赖笔记目录
      const notesCourse = path.join(NOTES_DIR, courseName);
      if (!fs.existsSync(notesCourse) || !fs.statSync(notesCourse).isDirectory()) {
        throw new Error(`课程目录不存在：${courseName}`);
      }
      title = courseName;
    } else {
      if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) throw new Error(`目录不存在：${relDir}`);
      if (!lessonName) throw new Error('dir 需要是「课程/课次」');
      mdPath = path.join(NOTES_DIR, courseName, `${lessonName}.md`);
      if (!fs.existsSync(mdPath)) throw new Error('还没有 Markdown——先对该课次「转 MD」');
      title = lessonName;
    }
  }

  const cfg = loadConfig().llm;
  const useMode = op === 'proofread'
    ? (PROFILE_KEYS.includes(mode) ? mode : cfg.defaultMode || 'text')
    : 'text';

  const job = {
    id: nextJobId++,
    op,
    mode: useMode,
    scope: scope === 'all' ? 'all' : 'course',
    status: 'pending',
    relDir,
    title,
    courseName: relDir.split('/').filter(Boolean)[0] || '',
    mdPath,
    absDir,
    mediaDir: absDir,
    outMd: mdPath ? relOf(mdPath) : null,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    progress: { done: 0, total: 0, current: '' },
    usage: { prompt: 0, completion: 0 },
    error: null,
    log: [],
    canceled: false,
  };
  llmJobs.set(job.id, job);
  emit(job);

  queue = queue.then(async () => {
    if (job.canceled) {
      job.status = 'canceled';
      job.finishedAt = Date.now();
      emit(job);
      return;
    }
    job.status = 'running';
    job.startedAt = Date.now();
    emit(job);
    try {
      const r = op === 'proofread'
        ? await runProofread(job)
        : op === 'summarize'
          ? await runSummarize(job)
          : op === 'fixmath'
            ? await runFixMath(job)
            : op === 'note'
              ? await runNote(job)
              : await runWeave(job);
      if (job.canceled) {
        job.status = 'canceled';
      } else {
        job.status = 'done';
        const tok = `tokens 输入 ${job.usage.prompt} / 输出 ${job.usage.completion}`;
        if (op === 'proofread') job.log.push(`完成：${r.pages} 页，保留原文 ${r.kept} 页；${tok}`);
        else if (op === 'summarize') job.log.push(`完成：分 ${r.chunks} 块提取并汇总；${tok}`);
        else if (op === 'fixmath') job.log.push(`完成：检查 ${r.checked} 条公式，修复 ${r.fixed}/${r.broken} 条；${tok}`);
        else if (op === 'note') job.log.push(`完成：${r.pages} 页原文 → ${r.chunks} 段笔记（${r.note}）；${tok}`);
        else if (job.scope === 'all') job.log.push(`完成：${r.courses} 门课，识别关联 ${r.related} 对；${tok}`);
        else job.log.push(`完成：${r.lessons} 个课次，关联 ${r.related} 对；${tok}`);
        job.progress.done = job.progress.total;
      }
    } catch (e) {
      job.status = 'error';
      job.error = String(e?.message || e);
    }
    job.finishedAt = Date.now();
    emit(job);
  }).catch((e) => {
    job.status = 'error';
    job.error = String(e?.message || e);
    job.finishedAt = Date.now();
    emit(job);
  });

  return publicJob(job);
}

export function cancelLlmJob(id) {
  const job = llmJobs.get(id);
  if (!job) return null;
  if (job.status === 'pending' || job.status === 'running') {
    job.canceled = true;
    emit(job);
  }
  return publicJob(job);
}

// ---------- 连通性测试 ----------

export async function testProfile(profile) {
  if (!PROFILE_KEYS.includes(profile)) throw new Error('未知档位');
  const t0 = Date.now();
  // max_tokens 给足：推理型模型（如 deepseek-v4-pro）会先花 token 思考，给小了会返回空
  const { content } = await chat([{ role: 'user', content: '请只回复两个字：正常' }], { profile, maxTokens: 512 });
  return { ok: true, ms: Date.now() - t0, reply: content.slice(0, 40) };
}

/**
 * 检索用的「语义扩展」：让 LLM 把问题改写成同义关键词，
 * 弥补词面检索（BM25 风格）召回不足——不需要额外 embedding 服务。
 */
export async function expandQuery(q) {
  const { content } = await chat([
    {
      role: 'user',
      content: '把下面的问题改写成 8~14 个中文检索关键词/同义词（可含英文术语），' +
        '只输出关键词，空格分隔，不要解释、不要标点、不要编号：\n' + String(q).slice(0, 400),
    },
  ], { profile: 'text', maxTokens: 800, temperature: 0.1 });
  return content.split(/[\s,，、;；]+/).filter((t) => t.length >= 2).slice(0, 16);
}

/**
 * AI 出题：把一页（或一节）的 OCR 文本转成问答卡 [ {front, back, page} ]。
 * 依据：检索练习（Roediger & Karpicke 2006）——先问后答的收益远高于重读。
 */
export async function generateQaCards(text, { count = 3, lesson = '', page = null, maxChars = 3500 } = {}) {
  const body = String(text || '').slice(0, maxChars);
  if (!body.trim()) return [];
  const ask = [
    '你是出题助手。根据下面课件内容出 ' + count + ' 道「先问后答」复习卡，用于自测（检索练习）。',
    '要求：',
    '1. 问题考察理解（为什么/如何推导/区别/适用条件），避免名词背诵式的一问一答；',
    '2. 答案简洁、准确，公式用 LaTeX（$...$）；',
    '3. 只依据给定内容，不要编造；内容不足就少出题；',
    '4. 严格输出 JSON 数组，形如 [{"front":"问题","back":"答案"}]，不要输出其它文字。',
    '',
    (lesson ? '课程：' + lesson + (page ? '（第 ' + page + ' 页）' : '') : ''),
    '内容：',
    body,
  ].join('\n');
  const { content } = await chat([{ role: 'user', content: ask }], { profile: 'text', maxTokens: 1400, temperature: 0.3 });
  const m = content.match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr;
  try { arr = JSON.parse(m[0]); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x) => x && String(x.front || '').trim())
    .slice(0, count)
    .map((x) => ({ front: String(x.front).trim(), back: String(x.back || '').trim(), page }));
}

/**
 * 费曼回评：学生用自己的话复述一张卡/一页，返回「缺漏 / 表述问题 / 追问」三栏点评。
 * 依据：自解释与生成性学习（Chi 自解释原则；Fiorella & Mayer 2015）。
 */
export async function feynmanReview(sourceText, studentText, { lesson = '', page = null } = {}) {
  const ask = [
    '学生在复习「先问后答」卡片。下方是课件原文与学生的复述。',
    '请像严格的助教一样点评学生的复述，用中文，只输出如下 JSON（不要其它文字）：',
    '{"missing":["遗漏的关键点…"],"wrong":["表述不准确的地方…（给正确说法）"],"followup":["一条追问，促使学生补全理解"]}',
    '标准：只对照课件原文判断；学生说对了也要在 missing 里留空数组；每条不超过 60 字；公式用 LaTeX（$...$）。',
    '',
    (lesson ? '课程：' + lesson + (page ? '（第 ' + page + ' 页）' : '') : ''),
    '【课件原文】',
    String(sourceText || '').slice(0, 3000),
    '',
    '【学生复述】',
    String(studentText || '').slice(0, 2000),
  ].join('\n');
  const { content } = await chat([{ role: 'user', content: ask }], { profile: 'text', maxTokens: 1200, temperature: 0.2 });
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return { missing: [], wrong: [], followup: [] };
  try {
    const obj = JSON.parse(m[0]);
    return {
      missing: Array.isArray(obj.missing) ? obj.missing.slice(0, 8).map(String) : [],
      wrong: Array.isArray(obj.wrong) ? obj.wrong.slice(0, 8).map(String) : [],
      followup: Array.isArray(obj.followup) ? obj.followup.slice(0, 3).map(String) : [],
    };
  } catch { return { missing: [], wrong: [], followup: [] }; }
}

/**
 * 拉取某个档位的可用模型列表（OpenAI 兼容的 GET {baseUrl}/models）。
 * override 用于「还没保存配置就想先拉一把」的场景（前端传当前输入框的值）。
 */
export async function listModels(profile = 'text', override = {}) {
  const key = PROFILE_KEYS.includes(profile) ? profile : 'text';
  const label = MODE_LABELS[key] || key;
  const prof = { ...getProfile(key), ...override };
  const base = String(prof.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error(`未配置「${label}」的接口地址`);
  if (!prof.apiKey) throw new Error(`未配置「${label}」的 API Key（本机服务随便填一个，如 ollama）`);

  let res;
  try {
    res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${prof.apiKey}` },
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw describeFetchError(err, { base, label: `「${label}」模型列表`, timeoutSec: 20 });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`拉取模型列表失败（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  const data = await res.json().catch(() => null);
  const raw = data?.data ?? data?.models ?? [];
  // 顺手记录上下文 / 最大输出（DeepSeek 返回 context_window/max_output_tokens，
  // OpenRouter 返回 context_length/top_provider.max_completion_tokens，vLLM 返回 max_model_len）
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const ctx = m.context_window ?? m.context_length ?? m.max_model_len ?? m.top_provider?.context_length;
    const out = m.max_output_tokens ?? m.max_completion_tokens ?? m.top_provider?.max_completion_tokens ?? m.max_tokens;
    if (ctx || out) {
      rememberCaps(String(prof.baseUrl || '').replace(/\/+$/, ''), m.id || m.name, {
        context: Number(ctx) || null,
        output: Number(out) || null,
        source: 'models 接口',
      });
    }
  }
  const models = raw
    .map((m) => (typeof m === 'string' ? m : m?.id || m?.name))
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s) => s.trim());
  return [...new Set(models)].sort();
}
