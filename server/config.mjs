/**
 * 本地配置（config.json，已 gitignore）。
 *
 * 三档 LLM 档位（都是 OpenAI 兼容接口）：
 *   text        纯文本：纠错/总结只发 OCR 文字，最省 token
 *   visionCloud 图片上云：把页面图 + OCR 文字发给云端视觉模型，精度最高
 *   visionLocal 图片本地：发给本机推理服务（Ollama / vLLM），零 API 费用
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from './paths.mjs';

const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');

export const PROFILE_KEYS = ['text', 'visionCloud', 'visionLocal'];

const DEFAULTS = {
  llm: {
    profiles: {
      text: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' },
      visionCloud: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: '', model: 'qwen-vl-max' },
      visionLocal: { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'ollama', model: 'qwen2.5vl:7b' },
    },
    temperature: 0.2,
    concurrency: 3,
    defaultMode: 'text', // text | visionCloud | visionLocal
    // 笔记生成链路：auto = 有能读图的档位就走视觉（省 3/4 token、快 3 倍），否则回落文本
    notePipeline: 'auto', // auto | vision | text
  },
  // 转 MD（Pix2Text）并行任务数：1 个任务约 6~7GB 显存，按显卡容量调
  md: { parallel: 'auto' },   // 'auto' = 按显存自动，或 1~4
  // 简化流水线：转 MD 后自动校订；生成笔记后自动复核（质量审计）
  automation: {
    polishAfterMd: true,        // 转 MD 完成后自动校订
    auditAfterNote: true,       // 生成笔记后自动质量审计
    supplementAfterAudit: true, // 审计后自动补全缺失知识点
    transcribeBeforeNote: true, // 生成笔记前，对还没有讲稿的课次自动抓音轨 + 转写
  },
};

function readFile() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/** 旧版扁平配置（llm.baseUrl…）迁移到 profiles.text */
function migrateLegacy(raw) {
  const llm = raw?.llm;
  if (llm && !llm.profiles && (llm.baseUrl || llm.apiKey || llm.model)) {
    return {
      ...raw,
      llm: {
        ...llm,
        profiles: { text: { baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model } },
      },
    };
  }
  return raw;
}

export function loadConfig() {
  const raw = migrateLegacy(readFile());
  const profiles = {};
  for (const key of PROFILE_KEYS) {
    profiles[key] = { ...DEFAULTS.llm.profiles[key], ...(raw?.llm?.profiles?.[key] || {}) };
  }
  return {
    llm: {
      ...DEFAULTS.llm,
      ...(raw.llm || {}),
      profiles,
    },
    md: { ...DEFAULTS.md, ...(raw.md || {}) },
    automation: { ...DEFAULTS.automation, ...(raw.automation || {}) },
  };
}

/** 记住的登录凭据（本机保存；password 以 base64 混淆，非加密） */
export function loadLogin() {
  const raw = readFile();
  const l = raw?.login || {};
  let password = '';
  if (l.passwordB64) {
    try { password = Buffer.from(String(l.passwordB64), 'base64').toString('utf8'); } catch { password = ''; }
  }
  return { username: String(l.username || ''), password, remember: !!l.remember };
}

/** 保存 / 清除记住的登录凭据 */
export function saveLogin({ username, password, remember } = {}) {
  const raw = readFile();
  const next = { ...raw };
  if (remember && username && password) {
    next.login = {
      username: String(username),
      passwordB64: Buffer.from(String(password), 'utf8').toString('base64'),
      remember: true,
    };
  } else {
    delete next.login;
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
}

/** 取某个档位（供 LLM 调用方使用） */
export function getProfile(key) {
  const { llm } = loadConfig();
  return llm.profiles[key] || llm.profiles.text;
}

/**
 * 局部更新并落盘。
 * 支持：{ llm: { profiles: { text: {baseUrl,model,apiKey} }, temperature, concurrency, defaultMode } }
 * apiKey 语义：未提供=保持，null=清空，字符串=覆盖。
 */
export function saveConfig(patch = {}) {
  const current = loadConfig();
  const next = { ...current };
  const p = patch.llm || {};

  if (p.profiles) {
    const profiles = { ...current.llm.profiles };
    for (const key of PROFILE_KEYS) {
      const incoming = p.profiles[key];
      if (!incoming) continue;
      const merged = { ...profiles[key], ...incoming };
      if ('apiKey' in incoming) {
        merged.apiKey = incoming.apiKey == null ? '' : String(incoming.apiKey);
      }
      profiles[key] = merged;
    }
    next.llm = { ...next.llm, profiles };
  }
  if (p.temperature !== undefined) next.llm.temperature = Number(p.temperature) || 0;
  if (p.concurrency !== undefined) next.llm.concurrency = Math.min(Math.max(Number(p.concurrency) || 3, 1), 8);
  if (p.defaultMode !== undefined) {
    next.llm.defaultMode = PROFILE_KEYS.includes(p.defaultMode) ? p.defaultMode : 'text';
  }
  // 笔记生成链路：auto（有能读图的档位就走视觉）/ vision / text
  if (p.notePipeline !== undefined) {
    next.llm.notePipeline = ['auto', 'vision', 'text'].includes(p.notePipeline) ? p.notePipeline : 'auto';
  }

  // 转 MD 并行数（1~3）
  const mdPatch = patch.md;
  if (mdPatch && typeof mdPatch === 'object' && mdPatch.parallel !== undefined) {
    const v = mdPatch.parallel;
    const parallel = v === 'auto' ? 'auto' : Math.min(Math.max(Number(v) || 1, 1), 4);
    next.md = { ...(current.md || DEFAULTS.md), parallel };
  }

  // 目录配置（PPT 数据目录 / 笔记目录）
  const pp = patch.paths;
  if (pp && typeof pp === 'object') {
    const merged = { ...(current.paths || {}) };
    if (typeof pp.dataDir === 'string') merged.dataDir = pp.dataDir.trim();
    if (typeof pp.notesDir === 'string') merged.notesDir = pp.notesDir.trim();
    next.paths = merged;
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 10) return '****';
  return `${k.slice(0, 5)}****${k.slice(-4)}`;
}

export const PROFILE_LABELS = {
  text: '纯文本',
  visionCloud: '图片上云',
  visionLocal: '图片本地',
};

/** 给前端的版本：不回传明文 key */
export function publicConfig() {
  const { llm } = loadConfig();
  const profiles = {};
  for (const key of PROFILE_KEYS) {
    const prof = llm.profiles[key];
    profiles[key] = {
      label: PROFILE_LABELS[key],
      baseUrl: prof.baseUrl,
      model: prof.model,
      hasKey: Boolean(prof.apiKey),
      apiKeyMasked: maskKey(prof.apiKey),
    };
  }
  return {
    profiles,
    temperature: llm.temperature,
    concurrency: llm.concurrency,
    defaultMode: llm.defaultMode,
    notePipeline: llm.notePipeline || 'auto',   // auto | vision | text
  };
}

/** 兼容旧调用（chat 等按 profile 取） */
export { maskKey };
