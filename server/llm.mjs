/**
 * LLM 文档操作（统一任务队列，任务串行、任务内按页/块并发）：
 *   proofread  纠错（OCR 错字）/ fixmath 修公式 / polish 校订（两者合并）
 *   note       深度笔记：整理稿 → 成稿（💭 讲解 / 习题折叠答案）→ 课末必记；整理稿按 mtime 缓存
 *   audit      质量审计：页覆盖 + 忠实度核对 + 知识点清单，与原文不符处自动修正
 *   summarize  快速摘要（写原文顶部 llm-summary 块；无独立入口，保留 API）
 *   weave      知识链（课程内 / 课程间）
 * 另有：expandQuery / generateQaCards / feynmanReview / listModels（复习台用）。
 *
 * 纠错/校订三档模式（config 的 profile，均为 OpenAI 兼容接口）：
 *   text 纯文本 / visionCloud 图片上云 / visionLocal 图片本地
 * DeepSeek 推理模型自动管理思考预算；批量环节可 thinking:'off' 关思考省 token。
 * 每个任务统计 token 用量（接口返回 usage 时）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DATA_DIR, NOTES_DIR, DOWNLOAD_DIR, ensureInside } from './paths.mjs';
import { loadConfig, getProfile, PROFILE_KEYS } from './config.mjs';
import { describeFetchError } from './net.mjs';
import { findMath, findBrokenMath, mathError, applyMathFixes } from './mdmath.mjs';
import { ensurePageTimes, narrationByPage, readTranscript } from './pages.mjs';
import { pageTimesByTitle } from './wqxt.mjs';

export const events = new EventEmitter();
events.setMaxListeners(50);

const llmJobs = new Map();
let nextJobId = 1;
let queue = Promise.resolve();

const MODE_LABELS = { text: '纯文本', visionCloud: '图片上云', visionLocal: '图片本地' };

/** 知识点清单的提取口径版本：改动提取逻辑（如纳入讲稿）就 +1，让旧缓存自动失效 */
const POINTS_CACHE_V = 2;

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

async function chat(messages, { profile = 'text', temperature, maxTokens, thinking } = {}) {
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
  const isDeepSeek = /api\.deepseek\.com/i.test(base);
  if (isDeepSeek && thinking === 'off') body.thinking = { type: 'disabled' };

  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${prof.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(240000),
    });
  } catch (err) {
    throw describeFetchError(err, { base, label, timeoutSec: 240 });
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
    // DeepSeek：思考没产出正文时，直接关掉思考重试（比加大预算再烧一遍思考省得多）；
    // 其他服务维持「加大预算重试」。
    if (isDeepSeek && body.thinking?.type !== 'disabled') {
      body.thinking = { type: 'disabled' };
    } else {
      const curTokens = Number(body.max_tokens) || 1200;
      const bigger = Math.min(curTokens * 3, caps.output || 8000);
      if (bigger <= curTokens) break;
      body.max_tokens = bigger;
    }
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
        signal: AbortSignal.timeout(240000),
      });
    } catch (err) {
      throw describeFetchError(err, { base, label, timeoutSec: 240 });
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
  return String(md || '')
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

/** 覆盖率自检：笔记引用了哪些页 / 原文里哪些页没被引用（按内容量分三类） */
function coverageReport(pages, noteText) {
  const covered = new Set([...String(noteText).matchAll(/#page=(\d+)/g)].map((m) => Number(m[1])));
  const gaps = [];
  const picOnly = [];
  const noText = [];
  let coveredCount = 0;
  for (const p of pages) {
    const n = Number(p.n);
    if (covered.has(n)) { coveredCount += 1; continue; }
    const src = p.body != null ? p.body : (p.text || '');
    const text = stripForSummary(src).replace(/\s+/g, ' ').trim();
    const imgs = imageRefs(src).length;
    if (text.length >= 40) gaps.push({ n, text: text.slice(0, 80), imgs });
    else if (imgs >= 1) picOnly.push({ n, text: text.slice(0, 40), imgs });
    else noText.push(n);
  }
  return { total: pages.length, covered: coveredCount, gaps, picOnly, noText };
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

/** JSON 破损抢救（LLM 长输出常见：截断/未转义反斜杠）：
 *  从文本里直接捞 {"point":"...","page":N} 对 */
function salvagePoints(text) {
  const out = [];
  const push = (point, page) => {
    const p = String(point || '').replace(/\\(.)/g, '$1').trim();
    if (p) out.push({ point: p, page: Number(page) || 0 });
  };
  let m;
  const reA = /"point"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"page"\s*:\s*(\d+)/g;
  while ((m = reA.exec(text))) push(m[1], m[2]);
  const reB = /"page"\s*:\s*(\d+)\s*,\s*"point"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  while ((m = reB.exec(text))) push(m[2], m[1]);
  return out;
}

/** JSON 破损抢救：从文本里直接捞 {"i":N,"status":"..."} 对 */
function salvageItems(text) {
  const out = [];
  const re = /"i"\s*:\s*(\d+)\s*,\s*"status"\s*:\s*"([a-z]+)"/g;
  let m;
  while ((m = re.exec(text))) out.push({ i: Number(m[1]), status: m[2] });
  return out;
}

/** JSON 破损抢救：{"i":N,"verdict":"...","reason":"..."} */
function salvageVerdicts(text) {
  const out = [];
  const re = /"i"\s*:\s*(\d+)\s*,\s*"verdict"\s*:\s*"([a-z]+)"(?:\s*,\s*"reason"\s*:\s*"((?:[^"\\]|\\.)*)")?/g;
  let m;
  while ((m = re.exec(text))) out.push({ i: Number(m[1]), verdict: m[2], reason: (m[3] || '').replace(/\\(.)/g, '$1') });
  return out;
}

function extractBlock(text, marker) {
  const re = new RegExp(`<!-- ${marker}:start -->[\\s\\S]*?<!-- ${marker}:end -->`);
  const m = re.exec(text);
  return m ? m[0] : '';
}

/** 替换/插入带标记的块；block 为 null 时移除 */
/**
 * 事务通知块可能为空：模型有时仍会写出「（无）」的标题，
 * 这里剥掉整块，免得笔记顶上挂一个空标题。
 */
/**
 * 剥掉正文里的空小节与「本材料中未出现…故无…」这类占位说明。
 * 模型偶尔会把提示词的要求当成正文写出来（实测出现过 `### 通知` + 「本材料中未出现…故无【通知】条目」），
 * 对复习的人是纯噪音，这里按小节确定性清除。
 */
export function stripPlaceholderSections(md) {
  const lines = String(md).split('\n');
  const out = [];
  const PLACEHOLDER = /^(?:本?(?:段)?材料(?:中)?(?:未|没有)(?:出现|提及|涉及)|材料中未见|未出现|未提及)[^。！？]{0,80}(?:故无|没有|无【|不涉及|无需)/;
  for (let i = 0; i < lines.length;) {
    const head = /^(#{2,4})\s+(.+)$/.exec(lines[i]);
    if (!head) { out.push(lines[i]); i += 1; continue; }
    let j = i + 1;
    while (j < lines.length && !/^#{2,4}\s/.test(lines[j])) j += 1;
    const body = lines.slice(i + 1, j).join('\n').trim();
    const placeholder = !body || PLACEHOLDER.test(body.replace(/\s+/g, ' '));
    if (!placeholder) out.push(...lines.slice(i, j));
    else if (out.length && out[out.length - 1].trim() !== '') out.push('');
    i = j;
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripEmptyNotice(text) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((l) => /^##\s*(📌)?\s*事务通知/.test(l.trim()));
  if (start === -1) return text;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i].trim())) { end = i; break; }
  }
  const body = lines.slice(start + 1, end).join('\n').replace(/^[-•\s]+/gm, '').trim();
  const empty = !body || /^(（?\s*(无|暂无|没有|无通知|无事务性通知)[^）]{0,12}）?[。.]?)$/.test(body);
  if (!empty) return text;
  lines.splice(start, end - start);
  return lines.join('\n').replace(/^\n+/, '').trim();
}

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

/** 校订：一次点按依次完成「纠错」（OCR 错字）与「修公式」（KaTeX 解析不了的）两步修订。 */
async function runPolish(job) {
  job.log.push('校订第 1/2 步：纠错（OCR 错字）');
  const a = await runProofread(job);
  if (job.canceled) return { pages: a.pages, kept: a.kept, checked: 0, broken: 0, fixed: 0 };
  job.log.push('校订第 2/2 步：修公式');
  const b = await runFixMath(job);
  job.log.push(`校订完成：纠错 ${a.pages} 页（保留原文 ${a.kept} 页）；公式 ${b.checked} 条中修复 ${b.fixed}/${b.broken} 条`);
  return { pages: a.pages, kept: a.kept, checked: b.checked, broken: b.broken, fixed: b.fixed };
}
/**
 * 生成「有思考的深度笔记」：<课次>.note.md
 * 三遍加工：
 *  ① 逐块把 OCR 原文消化成「知识整理稿」（中间产物 <课次>.note.work.md）
 *  ② 基于整理稿成稿：按知识逻辑重组小节，带页码角标 + 💭 讲解 + 易混提示 + 习题解答（折叠）
 *  ③ 从成稿提炼「本课脉络 + 课末必记」放到笔记最前面。
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
    const body = original.slice(start, end);
    return { n: Number(m[1]), body, text: stripForSummary(body) };
  }).filter((p) => p.text);
  if (!pages.length) throw new Error('没有可用的页面内容（先转 MD）');

  // 讲稿（回放转写）：按页切成「这一页老师当时讲了什么」，补课件里没写的内容
  let narration = new Map();
  let transMtime = 0;
  try {
    const tr = readTranscript(NOTES_DIR, ctx.course, ctx.lesson);
    if (tr) {
      transMtime = (() => {
        try {
          return fs.statSync(path.join(NOTES_DIR, ctx.course, `${ctx.lesson}.trans.json`)).mtimeMs;
        } catch { return 0; }
      })();
      const pageTimes = await ensurePageTimes(ctx.course, ctx.lesson, pageTimesByTitle);
      if (pageTimes) {
        narration = narrationByPage(pageTimes, tr.segments);
        job.log.push(`讲稿已按页对齐：${narration.size}/${pageTimes.length} 页有讲解（转写 ${tr.segments.length} 段）`);
      } else {
        job.log.push('发现讲稿，但缺页码时间轴——重新下载该课次可补上，本次先只用课件');
      }
    }
  } catch (e) {
    job.log.push('讲稿加载失败，本次只用课件：' + String(e?.message || e).slice(0, 120));
  }

  // 按「页数 + 字符预算」分块
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
  const workPath = mdPath.replace(/\.md$/i, '.note.work.md');
  // 原文没变且已有整理稿 → 直接复用，跳过最贵的整理阶段
  let workText = null;
  try {
    // 讲稿后来才转的也要重算：转写文件比整理稿新就作废缓存
    const workMtime = fs.existsSync(workPath) ? fs.statSync(workPath).mtimeMs : 0;
    if (workMtime + 500 >= fs.statSync(mdPath).mtimeMs && workMtime + 500 >= transMtime) {
      workText = fs.readFileSync(workPath, 'utf8').replace(/^# [^\n]*知识整理稿（中间产物）\n+/, '').trim();
    }
  } catch { workText = null; }
  const reusedWork = Boolean(workText && workText.length > 200);
  if (!reusedWork) workText = null;
  job.progress.total = (reusedWork ? 0 : chunks.length) + 3;
  emit(job);

  let done = 0;
  if (reusedWork) {
    job.log.push('原文没变，复用已有整理稿（跳过整理阶段）');
    emit(job);
  } else {
  // ---------- ① 逐块整理（消化，不照抄） ----------
  const limit = loadConfig().llm.concurrency || 3;
  const works = await mapLimit(chunks, limit, async (chunk) => {
    const from = chunk[0].n;
    const to = chunk[chunk.length - 1].n;
    const body = chunk.map((p) => {
      const talk = narration.get(p.n);
      return `[第 ${p.n} 页]\n${p.text}` + (talk ? `\n【老师讲解·语音转写】\n${talk}` : '');
    }).join('\n\n');
    const { content, usage } = await chatRetry(
      [
        {
          role: 'system',
           content: `你是《${ctx.course || '本课程'}》的助教。下面给你课件第 ${from}-${to} 页的 OCR 原文（可能有零星错字）${narration.size ? '，以及带【老师讲解·语音转写】标记的课堂录音转写' : ''}。
第一遍：按 SOAR 笔记框架把它**消化后整理**成一份「知识整理稿」（后面还要基于它写正式笔记，不要照抄原句）：
1) Select（筛选）：只留关键——概念 / 公式 / 结论 / 对比 / 流程；先用一句话说清这一部分在讲什么；
2) Organize + Associate（组织与关联）：把要点按知识逻辑组织，并显式写出相互关系（因果 / 对比 / 流程 / 条件）；
3) Regulate（调节）：标出能看出的考点、易错点和理解难点；
4) **逐页覆盖**：这一块里的每一页都至少有一条整理内容（哪怕该页只有图表，也要写一条「该页在讲什么」）；
5) **题目**：课件里的习题 / 例题要原样保留题干和选项，前面标【题目】；
6) 每条关键内容末尾标注来源页码，格式 [[${lessonName}.pdf#page=N|N]]（N 必须来自上方「[第 N 页]」）；
7) 【老师讲解】是课堂录音的语音识别结果，可能有同音错字、口语和废话：**理解语义后再整理**，
   不要照抄；它讲清了课件没写的内容（尤其是课件只有一张图时）就补进来，与课件冲突时以课件为准；
   **听错的术语不要照抄**：先到课件里找对应说法（如「新一页公司」→「公式」），
   找不到对应就换成稳妥的一般表述或省略，绝不要把明显讲不通的词（如「十二定律」）原样写进笔记；
8) **事务性信息必须原样保留**：考试时间 / 地点 / 题型 / 范围、作业截止、提交要求、课程安排等，
   照抄关键数字与名称、前面标【通知】，不要归纳、不要润色、不要因为「不是知识点」而删掉；
9) 只整理上面材料里有的内容：明显错字可以改顺，但不要编造。
直接输出 Markdown 文本（可用小标题和「- 」列表），不要前言、不要代码块。`,
        },
        { role: 'user', content: body },
      ],
      { profile: 'text', temperature: 0.3, maxTokens: 3000, thinking: 'off' },
    );
    addUsage(job, usage);
    done += 1;
    job.progress.done = done;
    job.progress.current = `整理第 ${from}-${to} 页`;
    emit(job);
    return `<!-- 整理：第 ${from}-${to} 页 -->\n${content.trim()}`;
  });
  workText = works.join('\n\n');
  fs.writeFileSync(workPath, `# ${lessonName} · 知识整理稿（中间产物）\n\n${workText}\n`, 'utf8');
  job.log.push(`整理稿完成（${works.length} 块，中间产物 ${path.basename(workPath)}）`);
  }

  // ---------- ② 成稿（整理稿太长就分两段，避免单次输出超限） ----------
  const segments = [];
  if (workText.length <= 9000) {
    segments.push(workText);
  } else {
    const parts = workText.split('\n\n');
    const a = [];
    const b = [];
    let sizeA = 0;
    for (const part of parts) {
      if (sizeA < workText.length / 2) { a.push(part); sizeA += part.length + 2; }
      else b.push(part);
    }
    segments.push(a.join('\n\n'), b.join('\n\n'));
  }
  job.progress.total = (reusedWork ? 0 : chunks.length) + segments.length + 1;
  emit(job);

  const makeSection = async (segment, idx) => {
    const { content, usage } = await chatRetry(
      [
        {
          role: 'system',
          content: `你是《${ctx.course || '本课程'}》的学霸助教。下面是课件的「知识整理稿」${segments.length > 1 ? `（第 ${idx + 1}/${segments.length} 部分）` : ''}。请按 SOAR 框架把它写成**有思考的复习笔记**：
1) Organize（组织）：按知识逻辑重组小节（### 知识主题标题），不要按页码流水账，也不要用「第几页」「第几块」这类标题；每个小节先用 1-2 句讲清核心结论；
2) Associate（关联）：显式写出与前面知识的联系、对比、适用条件——写成「- 💭 讲解：…」的行（为什么成立、怎么用、容易和什么混淆），**不带页码角标**，一条 1-2 句；
3) 关键要点用「- 」开头，每条末尾保留来源页码角标 [[${lessonName}.pdf#page=N|N]]（N 必须出现过）；**整理稿里出现过的每一页，在成稿里至少要被引用一次**（合并条目时必须保留角标）；
4) 整理稿里标了【题目】的，逐题处理：先原样给出题干和选项，然后紧跟 <details><summary>先自己想，点开看答案</summary>参考答案（AI 推断）+ 解析（为什么选它、其他选项错在哪）</details>；**每道【题目】都必须有一个 details 块**；
5) 整理稿里标了【通知】的（考试时间/地点/题型、作业截止、提交要求等）：**用一个独立小节收进来，
   数字、日期、地点照原文写，不要改写**——这类信息复习时最要紧，漏了就白搭；
6) 公式用 LaTeX（$…$）；不要代码块、不要前言；不要编造整理稿之外的知识。
7) 整理稿里若残留明显听错的词（讲不通的术语）：换成课件里的正确说法，找不到就别写，不要照搬。
8) **不要输出空小节，也不要在笔记里解释材料缺什么**：「本材料中未出现…故无…」这类说明是给系统的，
   不是给复习的人看的——没有的内容直接不写。
直接输出笔记正文（从 ### 开始），不要写全课总结（后面统一写）。`,
        },
        { role: 'user', content: segment },
      ],
      { profile: 'text', temperature: 0.35, maxTokens: 6000 },
    );
    addUsage(job, usage);
    done += 1;
    job.progress.done = done;
    job.progress.current = segments.length > 1 ? `成稿 ${idx + 1}/${segments.length}` : '成稿';
    emit(job);
    return content.trim();
  };

  const sectionTexts = [];
  for (let i = 0; i < segments.length; i++) sectionTexts.push(await makeSection(segments[i], i));
  let note = sectionTexts.join('\n\n').trim();

  // ---------- ②.5 覆盖自检 + 补漏（Self-Refine 式：发现遗漏页就定点补写） ----------
  {
    const coveredNow = new Set([...note.matchAll(/#page=(\d+)/g)].map((m) => Number(m[1])));
    const missing = pages.filter((p) => !coveredNow.has(p.n));
    if (missing.length) {
      job.progress.total += 1;
      const missText = missing.map((p) => `[第 ${p.n} 页]
${p.text}`).join('\n\n').slice(0, 12000);
      const { content: patch, usage: pUsage } = await chatRetry(
        [
          {
            role: 'system',
            content: `下面是《${ctx.course || '本课程'}》课件里**还没有写进复习笔记**的页面原文。请为每一页补 1-2 条要点（「- 」开头，末尾带 [[${lessonName}.pdf#page=N|N]] 角标）；如果该页主要是图片 / 图表，就写「第 N 页为图表页：……（对照课件查看）」，只依据给出的文字和页名，不要编造。
输出格式：以「### 📌 补充要点（自动补漏）」开头，按页顺序逐条列出。`,
          },
          { role: 'user', content: missText },
        ],
        { profile: 'text', temperature: 0.2, maxTokens: 2500, thinking: 'off' },
      );
      addUsage(job, pUsage);
      done += 1;
      job.progress.current = `补漏 ${missing.length} 页`;
      emit(job);
      job.log.push(`覆盖补漏：为未覆盖的 ${missing.length} 页补写要点（${missing.map((p) => p.n).join('、')}）`);
      note = note + '\n\n' + patch.trim();
    }
  }

  // ---------- ③ 本课脉络 + 课末必记 ----------
  // 事务性信息（考试时间/地点、作业截止）常在最后一页，而下面只喂正文前 18k 字，
  // 所以从整理稿和笔记里把相关段落单独捞出来一起给模型，别让它在长度截断里丢掉
  const noticeLines = (() => {
    const lines = `${workText || ''}\n${note}`.split('\n');
    const hits = new Set();
    for (let i = 0; i < lines.length; i += 1) {
      if (/(【通知】|考试|考查|题型|作业|提交|截止|答辩|调课|考场|上课时间)/.test(lines[i])) {
        for (const l of lines.slice(Math.max(0, i - 1), i + 3)) {
          const t = l.trim();
          if (t) hits.add(t);
        }
        if (hits.size > 80) break;
      }
    }
    return [...hits].join('\n').slice(0, 2500);
  })();

  const { content: digestRaw, usage: dUsage } = await chatRetry(
    [
      {
        role: 'system',
        content: `下面是《${ctx.course || '本课程'}》一节课的复习笔记。请提炼三样东西，严格按格式输出：
## 📌 事务通知
（只写这节课明确提到的**事务性信息**：考试时间 / 地点 / 题型 / 考查范围、作业与提交要求、课程安排变化。
 逐条「- 」开头，日期、时间、地点、数字**必须与原文完全一致**，不要改写、不要推测。
 **如果这节课没有任何这类信息，就整块不输出**（连标题也不要写）。）

## 🧭 本课脉络
（2-4 句话讲清这节课的整体逻辑：从什么讲到什么、解决什么问题）

## 🎯 课末必记
（最核心的 6-10 个考点 / 结论，「- 」开头，一条一句话；能标页码就带 [[${lessonName}.pdf#page=N|N]]）

不要重复笔记里的大段内容，不要前言和后记。`,
      },
      {
        role: 'user',
        content: note.slice(0, 18000)
          + (noticeLines ? `\n\n【整理稿里的事务性片段（可能来自老师口头，务必核对）】\n${noticeLines}` : ''),
      },
    ],
    { profile: 'text', temperature: 0.3, maxTokens: 2000, thinking: 'off' },
  );
  addUsage(job, dUsage);
  const digest = stripEmptyNotice(digestRaw);
  done += 1;
  job.progress.done = done;
  job.progress.current = '必记提炼';
  emit(job);

  // 页码校验：丢掉超出范围的引用编号
  const valid = new Set(pages.map((p) => String(p.n)));
  const fix = (s) => s.replace(/\[\[[^\]]*\.pdf#page=(\d+)\|([^\]]*)\]\]/g, (m, n, label) =>
    valid.has(String(Number(n))) ? m : label);
  note = fix(note);

  const head = `# ${lessonName} · 深度复习笔记

> 由 AI 通读课件后整理：带角标的条目来自课件原文（点角标可跳到对应页核对），💭 是讲解与补充（AI 生成，注意甄别），折叠框里是习题参考答案（先自己想再点开）。

${digest.trim()}

`;
  const body = stripPlaceholderSections(note);
  if (body !== note.trim()) job.log.push('已清掉正文里的空小节 / 占位说明');
  const notePath = mdPath.replace(/\.md$/i, '.note.md');
  if (fs.existsSync(notePath)) {
    try { fs.copyFileSync(notePath, mdPath.replace(/\.md$/i, '.note-backup.md')); } catch { /* 忽略 */ }
  }
  fs.writeFileSync(notePath, head + body + '\n', 'utf8');

  // 把「本课脉络 + 课末必记」同步回原文 md 顶部（upsert llm-summary 块），两处重点保持一致
  try {
    const summaryBlock = `<!-- llm-summary:start -->\n${digest.trim()}\n<!-- llm-summary:end -->\n\n`;
    const mdStat = fs.statSync(mdPath);
    let mdText = fs.readFileSync(mdPath, 'utf8');
    if (/<!-- llm-summary:start -->/.test(mdText)) {
      mdText = mdText.replace(/<!-- llm-summary:start -->[\s\S]*?<!-- llm-summary:end -->\n?/, summaryBlock);
    } else {
      const firstPage = mdText.indexOf('<!-- page ');
      mdText = firstPage > 0 ? mdText.slice(0, firstPage) + summaryBlock + mdText.slice(firstPage) : summaryBlock + mdText;
    }
    fs.writeFileSync(mdPath, mdText, 'utf8');
    // 只加了摘要块、页内容没变：恢复原 mtime，避免让 .note.work.md 的整理稿缓存失效
    try { fs.utimesSync(mdPath, mdStat.atime, mdStat.mtime); } catch { /* 忽略 */ }
    job.log.push('重点已同步到原文顶部（llm-summary 块）');
  } catch (e) {
    job.log.push('重点同步失败：' + String(e?.message || e).slice(0, 60));
  }

  const cov = coverageReport(pages, note);
  job.log.push(`覆盖自检：${cov.covered}/${cov.total} 页被引用（💭 讲解行不带角标，不参与审计核对）`);

  job.noteRel = path.relative(NOTES_DIR, notePath).split(path.sep).join('/');
  job.progress.done = job.progress.total;
  job.progress.current = '完成';
  emit(job);
  return { chunks: chunks.length, pages: pages.length, note: job.noteRel };
}

/**
 * 质量审计（两层）：
 *  ① 覆盖检查（本地、不花 token）：哪些页有内容但一条笔记都没引用；
 *  ② 忠实度核对（LLM）：把笔记条目按页和课件原文逐条比对，判定
 *     ok / partial / unsupported / figure（依赖图片，需人工看图）。
 * 结果写 <课次>.audit.json（复习页读它画标记）+ <课次>.audit.md（人读报告）。
 */
async function runAudit(job) {
  const mdPath = job.mdPath;
  const notePath = mdPath.replace(/\.md$/i, '.note.md');
  if (!fs.existsSync(notePath)) throw new Error('还没有 AI 笔记——先点「生成笔记」再做质量审计');
  const original = fs.readFileSync(mdPath, 'utf8');
  const noteText = fs.readFileSync(notePath, 'utf8');
  const ctx = courseContext(job);
  const lessonName = path.basename(mdPath).replace(/\.md$/i, '');
  if (ctx.course) job.log.push('提示词上下文：《' + ctx.course + '》');

  // ① 覆盖检查（本地）
  const { pages } = splitPages(original);
  if (!pages.length) throw new Error('原文里没有页标记（先转 MD）');

  // 讲稿（若有）必须一起作为审计依据：否则讲稿带来的内容会被判成「原文不支持」而被削掉
  let narration = new Map();
  let transMtime = 0;
  try {
    const tr = readTranscript(NOTES_DIR, ctx.course, ctx.lesson);
    if (tr) {
      try {
        transMtime = fs.statSync(path.join(NOTES_DIR, ctx.course, `${ctx.lesson}.trans.json`)).mtimeMs;
      } catch { transMtime = 0; }
      const pageTimes = await ensurePageTimes(ctx.course, ctx.lesson, pageTimesByTitle);
      if (pageTimes) {
        narration = narrationByPage(pageTimes, tr.segments);
        job.log.push(`审计纳入讲稿：${narration.size}/${pageTimes.length} 页有老师讲解`);
      }
    }
  } catch (e) {
    job.log.push('讲稿加载失败，本次只按课件审计：' + String(e?.message || e).slice(0, 100));
  }

  const cov = coverageReport(pages, noteText);
  job.log.push(`覆盖检查：${cov.covered}/${cov.total} 页被笔记引用；有文字但未覆盖 ${cov.gaps.length} 页，图片页未覆盖 ${cov.picOnly.length} 页`);

  // ② 忠实度核对：笔记里带页码角标的条目，按「首引用页」分组
  const pageMap = new Map(pages.map((p) => [Number(p.n), stripForSummary(p.body)]));
  const items = [];
  let noRef = 0;
  const noteLinesArr = noteText.split('\n');
  for (let ln = 0; ln < noteLinesArr.length; ln++) {
    const line = noteLinesArr[ln];
    const t = line.trim();
    if (!t.startsWith('- ')) continue;
    const refs = [...t.matchAll(/#page=(\d+)/g)].map((m) => Number(m[1]));
    if (!refs.length) { noRef += 1; continue; }
    items.push({ text: t.slice(2).replace(/\[\[[^\]]*\]\]/g, '').trim(), pages: refs, lineNo: ln });
  }
  if (noRef) job.log.push(`有 ${noRef} 条笔记没带页码角标，未参与核对`);
  if (!items.length) throw new Error('笔记里没有可核对的条目（都没有页码角标）');

  const groups = new Map();
  items.forEach((it) => {
    const key = it.pages[0];
    if (!groups.has(key)) groups.set(key, { page: key, items: [] });
    groups.get(key).items.push(it);
  });
  const groupList = [...groups.values()];

  job.progress.total = groupList.length + 3;
  job.progress.done = 1;
  job.progress.current = '覆盖检查完成，开始核对条目';
  emit(job);

  const limit = loadConfig().llm.concurrency || 3;
  let done = 1;
  await mapLimit(groupList, limit, async (g) => {
    if (job.canceled) return;
    // 条目常引用多页（如 [[page=7]] [[page=8]]）：只拿首引页核对会把别页的内容误判成没依据，
    // 所以把这一组条目引用到的页都带上（最多 4 页）
    const cited = [...new Set(g.items.flatMap((it) => it.pages))].slice(0, 4);
    const src = cited
      .map((n) => `【第 ${n} 页课件原文】\n${String(pageMap.get(n) || '').slice(0, 1800)}`)
      .join('\n\n');
    const talk = cited
      .filter((n) => narration.get(n))
      .map((n) => `【第 ${n} 页老师讲解·语音转写】\n${String(narration.get(n)).slice(0, 1100)}`)
      .join('\n\n');
    const list = g.items.map((it, k) => `${k + 1}. ${it.text}`).join('\n');
    try {
      const { content, usage } = await chatRetry(
        [
          {
            role: 'system',
            content: `你是严谨的课件笔记审计员。逐条核对「笔记条目」是否被材料支持。材料有两部分：
【课件原文】= 课件 OCR 文本；【老师讲解】= 课堂录音的语音转写（可能缺字、同音错字、口语）。
**只要其中之一支持就算被支持**；两者都不支持才是不支持。讲解里的错字不算「不符」，按语义判断即可。
判定等级（只能四选一）：
- ok：课件原文或老师讲解完全支持（允许同义改写；数字、公式、术语一致）
- partial：部分支持——有材料里没有的细节、过度推测、或丢了关键限定条件
- unsupported：两部分都不支持或与之矛盾
- figure：该条依赖图片/图表才能核实，纯文本无法判断
从严对待「材料里没有而笔记自己添加的内容」；reason 用中文、不超过 30 字。
对 partial / unsupported 的条目：如果与材料不符的部分能依据材料改对（错字、公式、数字、术语、丢掉的限定条件），在 fix 里给出「修正后的完整条目正文」——保留条目里属于 AI 自己的补充内容，只把与材料不符/矛盾的部分改对；**依据只来自老师讲解、且不是明显错字的，不要改动它**；不要新增知识、不要删掉补充、不要带页码角标。无法确定或整条主要是 AI 补充时省略 fix。
只输出 JSON：{"items":[{"i":1,"verdict":"ok","reason":"...","fix":"..."}]}，i 是条目序号，fix 可选。`,
          },
          {
            role: 'user',
            content: `${src}\n` + (talk ? `\n${talk}\n` : '') + `\n【待核对的笔记条目】\n${list}`,
          },
        ],
        { profile: 'text', temperature: 0.1, maxTokens: 1500 },
      );
      addUsage(job, usage);
      let ilist2;
      try { ilist2 = parseJsonLoose(content).items || []; } catch { ilist2 = salvageVerdicts(content); }
      const by = new Map(ilist2.map((x) => [Number(x.i), x]));
      g.items.forEach((it, k) => {
        const r = by.get(k + 1) || {};
        it.verdict = ['ok', 'partial', 'unsupported', 'figure'].includes(r.verdict) ? r.verdict : 'figure';
        it.reason = String(r.reason || '').slice(0, 60);
        it.fix = typeof r.fix === 'string' ? r.fix.trim().slice(0, 600) : '';
      });
    } catch (e) {
      job.log.push(`第 ${g.page} 页核对失败：` + String(e?.message || e).slice(0, 60));
      g.items.forEach((it) => { it.verdict = 'figure'; it.reason = '核对失败，建议人工查看'; });
    }
    done += 1;
    job.progress.done = done;
    job.progress.current = `核对第 ${g.page} 页`;
    emit(job);
  });

  // ②.5 依据审计结果修正笔记：把与原文不符的表述改对；AI 自己的补充内容保留不动
  let fixedCount = 0;
  let noteText2 = noteText;
  const fixable = items.filter((it) => it.fix && Number.isInteger(it.lineNo));
  if (fixable.length) {
    const lines = noteText2.split('\n');
    for (const it of fixable) {
      const raw = lines[it.lineNo];
      if (!raw || !raw.trim().startsWith('- ')) continue;
      const clean = it.fix.replace(/^[-•]\s*/, '').replace(/\[\[[^\]]*\]\]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!clean || clean === it.text.replace(/\s+/g, ' ').trim()) continue;
      const angleAt = raw.indexOf('[[');
      const suffix = angleAt >= 0 ? raw.slice(angleAt).trimEnd() : '';
      lines[it.lineNo] = `- ${clean}${suffix ? ' ' + suffix : ''}`;
      it.prev = it.text;
      it.text = clean;
      it.fixed = true;
      fixedCount += 1;
    }
    if (fixedCount) noteText2 = lines.join('\n');
  }
  if (fixedCount) job.log.push(`自动修正 ${fixedCount} 条与原文不符的表述（原笔记已备份为 <课次>.note-backup.md）`);

  const stats = { ok: 0, partial: 0, unsupported: 0, figure: 0, fixed: fixedCount };
  const outItems = items.map((it) => {
    if (stats[it.verdict] === undefined) it.verdict = 'figure';
    stats[it.verdict] += 1;
    return {
      text: it.text.slice(0, 300),
      pages: it.pages,
      verdict: it.verdict,
      reason: it.reason || '',
      ...(it.fixed ? { fixed: true, prev: (it.prev || '').slice(0, 300) } : {}),
    };
  });

  // ③ 知识点清单：优先复用上次审计留下的清单（原文没变就不重复调用 LLM，省 token）
  job.progress.current = '准备知识点清单';
  emit(job);
  const pointsJsonPath = mdPath.replace(/\.md$/i, '.points.json');
  const pointsMdPath = mdPath.replace(/\.md$/i, '.points.md');
  let points = [];
  let reusedPoints = false;
  let pointsVersion = 0;   // 复用旧清单时保留它原本的版本，别让旧内容被贴上「新版」标签
  try {
    const mdMtime = fs.statSync(mdPath).mtimeMs;
    if (fs.existsSync(pointsJsonPath)) {
      const cached = JSON.parse(fs.readFileSync(pointsJsonPath, 'utf8'));
      if (cached && Number(cached.sourceMtimeMs || 0) + 500 >= mdMtime
        && Number(cached.sourceMtimeMs || 0) + 500 >= transMtime
        && Number(cached.v || 0) >= POINTS_CACHE_V   // 提取口径变了就重提，别用旧清单
        && Array.isArray(cached.items)) {
        points = cached.items
          .map((p) => ({ point: String(p.point || '').trim(), page: Number(p.page) || 0 }))
          .filter((p) => p.point);
        reusedPoints = points.length > 0;
        pointsVersion = Number(cached.v) || 0;
      }
    }
    // 兼容旧版：只有 .points.md 时从清单里解析
    // （已有 .points.json 就别走这条——否则版本升级后仍会被旧清单挡住）
    if (!reusedPoints && !fs.existsSync(pointsJsonPath)
      && fs.existsSync(pointsMdPath) && fs.statSync(pointsMdPath).mtimeMs + 500 >= mdMtime
      && fs.statSync(pointsMdPath).mtimeMs + 500 >= transMtime) {
      for (const line of fs.readFileSync(pointsMdPath, 'utf8').split('\n')) {
        const m = /^- (?:✅|⚠️|❌|·)\s+(.+?)\s*\[\[[^\]]*#page=(\d+)\|[^\]]*\]\]\s*$/.exec(line.trim());
        if (m) points.push({ point: m[1].trim(), page: Number(m[2]) || 0 });
      }
      reusedPoints = points.length > 0;
      pointsVersion = 0;
    }
  } catch { points = []; reusedPoints = false; }
  if (!reusedPoints) pointsVersion = POINTS_CACHE_V;

  const pointChunks = [];
  if (reusedPoints) {
    job.log.push(`复用上次的知识点清单（${points.length} 条，跳过提取）`);
  } else {
  {
    let cur = [];
    let size = 0;
    for (const p of pages) {
      // 讲稿也要计入块大小，否则加了讲解以后单块会过大
      const txt = (pageMap.get(Number(p.n)) || '') + (narration.get(Number(p.n)) || '');
      if (cur.length && (cur.length >= 12 || size + txt.length > 15000)) {
        pointChunks.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(p);
      size += txt.length;
    }
    if (cur.length) pointChunks.push(cur);
  }
  job.progress.total = groupList.length + 2 + pointChunks.length;
  emit(job);
  points = [];
  await mapLimit(pointChunks, 2, async (chunk) => {
    if (job.canceled) return;
    const from = Number(chunk[0].n);
    const to = Number(chunk[chunk.length - 1].n);
    job.progress.current = `提取知识点（第 ${from}-${to} 页）`;
    emit(job);
    const body = chunk.map((p) => {
      const talk = narration.get(Number(p.n));
      return `[第 ${p.n} 页]\n${pageMap.get(Number(p.n)) || ''}` + (talk ? `\n【老师讲解·语音转写】\n${talk.slice(0, 1500)}` : '');
    }).join('\n\n');
    try {
      const { content, usage } = await chatRetry(
        [
          {
            role: 'system',
            content: `你是《${ctx.course || '本课程'}》的助教。从下面材料提取「知识点清单」：每条 = 一个可考试/可自测的独立知识点（概念、公式、结论、方法、现象解释等）。
材料可能含【老师讲解·语音转写】（可能有同音错字）——**老师强调的考点、易错点、例题思路也要收进清单**，这是课件上没有的信息。
要求：
1) 覆盖全部页面，宁多勿漏；完全重复的合并；讲解里的错字按语义理解后再写，不要照抄错字；
2) 每条给出来源页码（取原文里的「[第 N 页]」标记）；
3) point 用中文 15-40 字，公式保留 LaTeX；
4) 本段最多 60 条。
只输出 JSON：{"points":[{"point":"...","page":12}]}`,
          },
          { role: 'user', content: body },
        ],
        { profile: 'text', temperature: 0.1, maxTokens: 6000 },
      );
      addUsage(job, usage);
      let plist;
      try { plist = parseJsonLoose(content).points || []; } catch { plist = salvagePoints(content); }
      const batch = plist
        .map((p) => ({ point: String(p.point || '').trim(), page: Number(p.page) || 0 }))
        .filter((p) => p.point);
      points.push(...batch);
      job.log.push(`第 ${from}-${to} 页：提取 ${batch.length} 个知识点`);
    } catch (e) {
      job.log.push(`第 ${from}-${to} 页知识点提取失败：` + String(e?.message || e).slice(0, 60));
    }
    job.progress.done += 1;
    emit(job);
  });
  points.sort((a, b) => (a.page || 0) - (b.page || 0));
  }

  points = points.slice(0, 150);
  if (points.length) job.log.push(`${reusedPoints ? '使用' : '提取到'} ${points.length} 个知识点`);

  // ④ 覆盖判定：分批逐条判断笔记里有没有讲到（文本行输出，避免长 JSON 破损）
  let knowledge = null;
  if (points.length) {
    const K_BATCH = 25;
    const kStarts = [];
    for (let s = 0; s < points.length; s += K_BATCH) kStarts.push(s);
    job.progress.total = groupList.length + 1 + pointChunks.length + kStarts.length;
    job.progress.current = '核对知识点覆盖';
    emit(job);
    const kStatus = new Array(points.length).fill('unknown');
    await mapLimit(kStarts, 2, async (s) => {
      if (job.canceled) return;
      const slice = points.slice(s, s + K_BATCH);
      try {
        const { content, usage } = await chatRetry(
          [
            {
              role: 'system',
              content: `给定「知识点清单」和「笔记全文」，逐条判断笔记是否讲到了该知识点：
- covered：笔记中有对应内容（允许换措辞）
- partial：提到了但不完整或含糊
- missing：笔记里完全没有
输出格式：每行一条「编号 状态」，不要 JSON、不要解释。例如：
1 covered
2 missing
3 partial`,
            },
            {
              role: 'user',
              content: `【知识点清单】\n${slice.map((p, i) => `${i + 1}. ${p.point}（第 ${p.page} 页）`).join('\n')}\n\n【笔记全文】\n${noteText2.slice(0, 30000)}`,
            },
          ],
          { profile: 'text', temperature: 0.1, maxTokens: 6000 },
        );
        addUsage(job, usage);
        const re = /(\d+)\s*[,:：\s]\s*(covered|partial|missing)/gi;
        let m;
        while ((m = re.exec(content))) {
          const k = Number(m[1]) - 1;
          if (k >= 0 && k < slice.length) kStatus[s + k] = m[2].toLowerCase();
        }
      } catch (e) {
        job.log.push(`知识点判定（第 ${s + 1}-${Math.min(s + K_BATCH, points.length)} 条）失败：` + String(e?.message || e).slice(0, 60));
      }
      job.progress.done += 1;
      emit(job);
    });
    const kItems = points.map((p, i) => ({ ...p, status: kStatus[i] }));
    const kStats = { covered: 0, partial: 0, missing: 0, unknown: 0 };
    kItems.forEach((k) => { kStats[k.status] += 1; });
    knowledge = { total: kItems.length, ...kStats, items: kItems };
    job.log.push(`知识点核对：${kStats.covered}/${kItems.length} 已覆盖，${kStats.partial} 条不完整，${kStats.missing} 条缺失`);
  }

  // 修正后的笔记落盘（先备份原文件；AI 补充内容原样保留）
  if (fixedCount) {
    try {
      fs.copyFileSync(notePath, mdPath.replace(/\.md$/i, '.note-backup.md'));
      fs.writeFileSync(notePath, noteText2, 'utf8');
    } catch (e) {
      job.log.push('修正落盘失败：' + String(e?.message || e).slice(0, 60));
    }
  }

  const report = {
    generatedAt: Date.now(),
    lesson: lessonName,
    coverage: cov,
    stats,
    knowledge,
    items: outItems,
  };
  const jsonPath = mdPath.replace(/\.md$/i, '.audit.json');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  job.resultRel = relOf(jsonPath);

  // 知识点清单落盘（含覆盖状态），当复习大纲用
  if (knowledge) {
    // 结构化清单：下次审计直接读取，不再重复调用 LLM 提取
    let knownMtime = 0;
    try { knownMtime = fs.statSync(mdPath).mtimeMs; } catch { /* 忽略 */ }
    try {
      fs.writeFileSync(pointsJsonPath, JSON.stringify({
        v: pointsVersion,
        generatedAt: Date.now(),
        lesson: lessonName,
        sourceMtimeMs: knownMtime,
        items: knowledge.items.map((p) => ({ point: p.point, page: p.page })),
      }, null, 2), 'utf8');
    } catch { /* 写不进去不影响审计结果 */ }
    const kMark = { covered: '✅', partial: '⚠️', missing: '❌', unknown: '·' };
    const pl = [
      `# ${lessonName} · 知识点清单`,
      '',
      `> AI 从课件提取的考点清单（共 ${knowledge.total} 条）；✅ 笔记已覆盖 · ⚠️ 不完整 · ❌ 缺失`,
      '',
      ...knowledge.items.map((p) => `- ${kMark[p.status] || '·'} ${p.point} [[${lessonName}.pdf#page=${p.page}|${p.page}]]`),
      '',
    ];
    fs.writeFileSync(mdPath.replace(/\.md$/i, '.points.md'), pl.join('\n'), 'utf8');
  }

  // 人类可读报告
  const lines = [
    `# ${lessonName} · 质量审计报告`,
    '',
    `> ${new Date(report.generatedAt).toLocaleString('zh-CN')} · AI 辅助审计，可能误判，请以课件原文为准`,
    '',
    '## ① 覆盖检查',
    '',
    `- 笔记引用：**${cov.covered}/${cov.total}** 页`,
  ];
  if (cov.gaps.length) lines.push(`- ⚠️ 有文字但没进笔记：${cov.gaps.map((g) => `第 ${g.n} 页`).join('、')}`);
  if (cov.picOnly.length) lines.push(`- 🖼 图片页未被引用（建议翻原 PPT 确认）：${cov.picOnly.map((g) => `第 ${g.n} 页`).join('、')}`);
  if (cov.noText.length) lines.push(`- 无实质内容、自动忽略：${cov.noText.map((n) => `第 ${n} 页`).join('、')}`);
  lines.push('', '## ② 忠实度核对', '', `- ✅ ${stats.ok} 条 · ⚠️ ${stats.partial} 条 · ❌ ${stats.unsupported} 条 · 🔍 ${stats.figure} 条`);
  if (stats.fixed) lines.push(`- ✏️ 已按课件原文自动修正 ${stats.fixed} 条（AI 自己的补充内容保留不动；原版见 .note-backup.md）`);
  const bad = outItems.filter((it) => it.verdict !== 'ok');
  if (bad.length) {
    lines.push('', '### 需要注意的条目', '');
    for (const it of bad) {
      const mark = { partial: '⚠️', unsupported: '❌', figure: '🔍' }[it.verdict] || '?';
      const fixNote = it.fixed && it.prev ? `（✏️ 已自动修正，原为：${it.prev}）` : '';
      lines.push(`- ${mark} ${it.text}（第 ${it.pages.join('、')} 页）—— ${it.reason}${fixNote}`);
    }
  } else {
    lines.push('', '全部条目都能在课件原文里找到支持。');
  }
  lines.push('');
  fs.writeFileSync(mdPath.replace(/\.md$/i, '.audit.md'), lines.join('\n'), 'utf8');

  job.progress.done = job.progress.total;
  job.progress.current = '完成';
  emit(job);
  return { pages: cov.total, covered: cov.covered, gaps: cov.gaps.length + cov.picOnly.length, ok: stats.ok, partial: stats.partial, unsupported: stats.unsupported, figure: stats.figure, fixed: fixedCount };
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
    resultData: j.resultData || null,
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
  if (!['proofread', 'summarize', 'weave', 'fixmath', 'polish', 'note', 'audit'].includes(op)) throw new Error(`不支持的操作：${op}`);
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
      if (op === 'audit' && !fs.existsSync(mdPath.replace(/\.md$/i, '.note.md'))) throw new Error('还没有 AI 笔记——先点「生成笔记」再做质量审计');
      title = lessonName;
    }
  }

  const cfg = loadConfig().llm;
  const useMode = (op === 'proofread' || op === 'polish')
    ? (PROFILE_KEYS.includes(mode) ? mode : cfg.defaultMode || 'text')
    : 'text';

  // 幂等：同一目标 + 同一操作已有排队/进行中的任务 → 复用，避免重复烧 token
  const jobKey = op === 'weave' && scope === 'all' ? 'weave:*ALL*' : `${op}:${relDir}`;
  const dup = [...llmJobs.values()].find(
    (j) => j.jobKey === jobKey && (j.status === 'pending' || j.status === 'running'),
  );
  if (dup) return { ...publicJob(dup), reused: true };

  const job = {
    id: nextJobId++,
    op,
    jobKey,
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
            : op === 'polish'
              ? await runPolish(job)
              : op === 'note'
                ? await runNote(job)
                : op === 'audit'
                  ? await runAudit(job)
                  : await runWeave(job);
      job.resultData = r;
      if (job.canceled) {
        job.status = 'canceled';
      } else {
        job.status = 'done';
        const tok = `tokens 输入 ${job.usage.prompt} / 输出 ${job.usage.completion}`;
        if (op === 'proofread') job.log.push(`完成：${r.pages} 页，保留原文 ${r.kept} 页；${tok}`);
        else if (op === 'summarize') job.log.push(`完成：分 ${r.chunks} 块提取并汇总；${tok}`);
        else if (op === 'fixmath') job.log.push(`完成：检查 ${r.checked} 条公式，修复 ${r.fixed}/${r.broken} 条；${tok}`);
        else if (op === 'polish') job.log.push(`完成：纠错 ${r.pages} 页（保留原文 ${r.kept} 页）+ 公式 ${r.checked} 条（修复 ${r.fixed}/${r.broken}）；${tok}`);
        else if (op === 'note') job.log.push(`完成：${r.pages} 页原文 → ${r.chunks} 段笔记（${r.note}）；${tok}`);
        else if (op === 'audit') job.log.push('完成：覆盖 ' + r.covered + '/' + r.pages + ' 页；条目 OK ' + r.ok + ' / 部分 ' + r.partial + ' / 不支持 ' + r.unsupported + ' / 需看图 ' + r.figure + (r.fixed ? ' / 已修正 ' + r.fixed : '') + '；' + tok);
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
