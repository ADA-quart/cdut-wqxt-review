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
  };
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
  };
}

/** 兼容旧调用（chat 等按 profile 取） */
export { maskKey };
