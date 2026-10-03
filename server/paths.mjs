import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(SERVER_DIR, '..');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const DOWNLOAD_DIR = path.join(ROOT_DIR, 'downloads');
export const PROFILE_DIR = path.join(ROOT_DIR, '.edge-profile');

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