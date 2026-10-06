/**
 * 笔记 PDF：把 <课次>.note.md 用无头 Edge 渲染成 A4 PDF。
 * - 懒生成 + mtime 缓存：note.pdf 比 note.md 新则直接复用
 * - 渲染页：public/print.html（marked + KaTeX，习题折叠全部展开）
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { NOTES_DIR, ensureDir } from './paths.mjs';

export function notePaths(relDir) {
  const rel = String(relDir || '').replace(/^[/\\]+/, '');
  const noteAbs = path.join(NOTES_DIR, `${rel}.note.md`);
  const pdfAbs = path.join(NOTES_DIR, `${rel}.note.pdf`);
  return { rel, noteAbs, pdfAbs };
}

function isFresh(pdfAbs, noteAbs) {
  try {
    return fs.existsSync(pdfAbs) && fs.statSync(pdfAbs).mtimeMs + 500 >= fs.statSync(noteAbs).mtimeMs;
  } catch {
    return false;
  }
}

async function renderWithBrowser(browser, rel, pdfAbs, port) {
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/print.html?dir=${encodeURIComponent(rel)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForFunction(() => window.__noteReady === true, null, { timeout: 30000 });
    await page.pdf({
      path: pdfAbs,
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' },
    });
  } finally {
    await page.close().catch(() => {});
  }
}

/** 生成（或复用）某课次的笔记 PDF；port 为本机服务端口 */
export async function renderNotePdf(relDir, { port = process.env.PORT || 3901 } = {}) {
  const { rel, noteAbs, pdfAbs } = notePaths(relDir);
  if (!fs.existsSync(noteAbs)) return { ok: false, reason: 'no-note' };
  if (isFresh(pdfAbs, noteAbs)) return { ok: true, path: pdfAbs, rel: `${rel}.note.pdf`, cached: true };
  ensureDir(path.dirname(pdfAbs));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    await renderWithBrowser(browser, rel, pdfAbs, port);
    return { ok: true, path: pdfAbs, rel: `${rel}.note.pdf`, cached: false };
  } finally {
    await browser.close().catch(() => {});
  }
}
