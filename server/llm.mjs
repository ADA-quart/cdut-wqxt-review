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
import { DOWNLOAD_DIR, ensureInside } from './paths.mjs';
import { loadConfig, getProfile, PROFILE_KEYS } from './config.mjs';

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
  if (maxTokens) body.max_tokens = maxTokens;

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${prof.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM 接口 ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content || !String(content).trim()) throw new Error('LLM 返回为空');
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

async function proofreadPage(page, { mode, mediaDir, job }) {
  const raw = page.body;
  const body = raw.trim();
  if (!body || body.length < 8) return raw;
  // 保留原文首尾空白（页标记/链接之间的换行），拼回时不丢格式
  const lead = /^\s*/.exec(raw)[0];
  const trail = /\s*$/.exec(raw)[0];

  const profile = mode === 'text' ? 'text' : mode;
  const system = mode === 'text' ? PROOF_SYSTEM_TEXT : PROOF_SYSTEM_VISION;
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
  job.progress.total = chunks.length + 1;
  emit(job);

  const limit = loadConfig().llm.concurrency || 3;
  let done = 0;
  const partSummaries = await mapLimit(chunks, limit, async (c, i) => {
    const { content: s, usage } = await chatRetry(
      [
        { role: 'system', content: '你在帮大学生整理课件复习提纲。提取给定内容的重点，用中文输出 3-8 条要点（- 开头）。公式用 LaTeX（$...$）。只输出要点，不要前言后语。' },
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
        content: `你在帮大学生生成一节课的复习要点。下面是分块提取的要点，请合并去重、按主题重新组织，输出一份精炼的「重点总结」，包含：
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

export function createLlmJob({ op, dir, mode }) {
  if (!['proofread', 'summarize'].includes(op)) throw new Error(`不支持的操作：${op}`);
  const relDir = String(dir || '').replace(/^[/\\]+/, '');
  const absDir = ensureInside(DOWNLOAD_DIR, path.join(DOWNLOAD_DIR, relDir));
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) throw new Error(`目录不存在：${relDir}`);

  const name = path.basename(absDir);
  const mdPath = path.join(path.dirname(absDir), `${name}.md`);
  if (!fs.existsSync(mdPath)) throw new Error('还没有 Markdown——先对该课次「转 MD」');

  const cfg = loadConfig().llm;
  const useMode = op === 'proofread'
    ? (PROFILE_KEYS.includes(mode) ? mode : cfg.defaultMode || 'text')
    : 'text';

  const job = {
    id: nextJobId++,
    op,
    mode: useMode,
    status: 'pending',
    relDir,
    title: name,
    mdPath,
    mediaDir: absDir,
    outMd: path.relative(DOWNLOAD_DIR, mdPath).split(path.sep).join('/'),
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
      const r = op === 'proofread' ? await runProofread(job) : await runSummarize(job);
      if (job.canceled) {
        job.status = 'canceled';
      } else {
        job.status = 'done';
        const tok = `tokens 输入 ${job.usage.prompt} / 输出 ${job.usage.completion}`;
        if (op === 'proofread') job.log.push(`完成：${r.pages} 页，保留原文 ${r.kept} 页；${tok}`);
        else job.log.push(`完成：分 ${r.chunks} 块提取并汇总；${tok}`);
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
  const { content } = await chat([{ role: 'user', content: '请只回复两个字：正常' }], { profile, maxTokens: 32 });
  return { ok: true, ms: Date.now() - t0, reply: content.slice(0, 40) };
}
