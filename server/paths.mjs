/**
 * 路径与目录管理：项目根 / 静态目录 / 数据目录（downloads）/ 笔记目录（可指向 Obsidian 库）。
 * 目录配置存 config.json 的 paths，改完经 /api/paths 热更新（applyPathSettings）。
 * 工具：sanitizeName（安全文件名）、ensureInside（防目录穿越）、ensureDir。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(SERVER_DIR, '..');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const PROFILE_DIR = path.join(ROOT_DIR, '.edge-profile');

const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');

/** 读取 config.json 里的 paths 配置（读不到就用默认值） */
function readPathConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return raw?.paths && typeof raw.paths === 'object' ? raw.paths : {};
  } catch {
    return {};
  }
}

const DEFAULT_DATA_DIR = path.join(ROOT_DIR, 'downloads');

/** 相对路径按项目根解析；空值用兜底 */
function resolveDir(value, fallback) {
  const v = String(value || '').trim();
  if (!v) return fallback;
  return path.isAbsolute(v) ? path.normalize(v) : path.resolve(ROOT_DIR, v);
}

const initialPaths = readPathConfig();

/** 数据目录：PPT 原始帧、PDF 之外的图片产物、去冗报告、复习卡 */
export let DATA_DIR = resolveDir(initialPaths.dataDir, DEFAULT_DATA_DIR);
/** 笔记目录：Markdown / PDF / assets（可指向 Obsidian 库；默认与数据目录相同） */
export let NOTES_DIR = resolveDir(initialPaths.notesDir, DATA_DIR);
/** 兼容旧名：= 数据目录 */
export let DOWNLOAD_DIR = DATA_DIR;

/** 应用新的目录配置（由 /api/paths 调用，改完立即生效） */
export function applyPathSettings({ dataDir, notesDir } = {}) {
  DATA_DIR = resolveDir(dataDir, DEFAULT_DATA_DIR);
  NOTES_DIR = resolveDir(notesDir, DATA_DIR);
  DOWNLOAD_DIR = DATA_DIR;
  ensureDir(DATA_DIR);
  ensureDir(NOTES_DIR);
  return getPaths();
}

export function getPaths() {
  return {
    dataDir: DATA_DIR,
    notesDir: NOTES_DIR,
    sameDir: path.resolve(DATA_DIR) === path.resolve(NOTES_DIR),
    defaultDataDir: DEFAULT_DATA_DIR,
  };
}

/** 课次 Markdown 的绝对路径（在笔记目录下） */
export function mdPathOf(course, lesson) {
  return path.join(NOTES_DIR, course, `${lesson}.md`);
}

/** 课程笔记目录（绝对路径） */
export function courseNotesDir(course) {
  return path.join(NOTES_DIR, course);
}

/**
 * 把任意文本清洗成安全的文件/目录名。
 * 去掉 Windows 非法字符与控制字符，合并空白，去掉结尾的点和空格。
 */
export function sanitizeName(name, fallback = '未命名') {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return cleaned || fallback;
}

/** 确保 target 位于 base 目录内，返回解析后的绝对路径；越界时抛错 */
export function ensureInside(base, target) {
  const resolved = path.resolve(target);
  const rel = path.relative(path.resolve(base), resolved);
  if (rel === '') return resolved;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('路径越界：' + target);
  }
  return resolved;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
