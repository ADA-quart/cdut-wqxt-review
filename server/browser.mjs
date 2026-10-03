/**
 * Edge 浏览器会话管理。
 *
 * 问渠学堂（classroom.wqxt.cdut.edu.cn）全站有瑞数式动态防护（WAF）：
 *   - 直接 HTTP 请求 → 412 挑战页
 *   - Playwright 直接 launch / headless → 挑战 JS 执行后仍 400
 *   - 手动拉起真实 Edge + CDP 连接 → 正常访问（已实测）
 *
 * 所以本模块以「独立 profile 拉起真实 Edge + 连接调试端口」的方式工作：
 *   - profile 目录持久化，登录状态（cookie/localStorage）跨重启保留
 *   - 只有在 Edge 未运行时才拉起新窗口，已有实例直接复用
 *   - 业务 API 一律在真实页面上下文里 fetch（同源、带 cookie、免签名）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { PROFILE_DIR, ensureDir } from './paths.mjs';

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

export const CDP_PORT = 9333;
export const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
export const WQ_BASE = 'https://classroom.wqxt.cdut.edu.cn';

let edgeChild = null;
let browser = null;
let workPage = null;
let launching = null;

function findEdge() {
  for (const p of EDGE_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('未找到 Microsoft Edge，请先安装 Edge 浏览器');
}

async function cdpReachable() {
  try {
    const r = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function waitForCdp(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdpReachable()) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

/** 拉起一个独立的 Edge 实例（独立 profile，不影响用户日常浏览器） */
async function launchEdge() {
  const edgePath = findEdge();
  ensureDir(PROFILE_DIR);
  edgeChild = spawn(
    edgePath,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=msEdgeFirstRunExperience',
      WQ_BASE + '/',
    ],
    { stdio: 'ignore', windowsHide: false },
  );
  edgeChild.on('exit', () => { edgeChild = null; });
  const ok = await waitForCdp();
  if (!ok) throw new Error('Edge 调试端口启动超时');
}

/** 确保浏览器连接可用；首次调用会拉起 Edge（或复用已运行的实例） */
export async function ensureBrowser() {
  if (browser) {
    try {
      // 连接存活探测
      await browser.contexts();
      return browser;
    } catch {
      browser = null;
      workPage = null;
    }
  }
  if (launching) return launching;

  launching = (async () => {
    if (!(await cdpReachable())) {
      await launchEdge();
    }
    browser = await chromium.connectOverCDP(CDP_URL);
    browser.on('disconnected', () => { browser = null; workPage = null; });
    return browser;
  })().finally(() => { launching = null; });

  return launching;
}

/** 取一个位于问渠学堂域下的工作页面（离屏 API 调用均在此页面内执行） */
export async function getWorkPage() {
  const b = await ensureBrowser();
  if (workPage && !workPage.isClosed()) return workPage;

  const ctx = b.contexts()[0];
  // 优先复用已打开的问渠学堂标签
  const existing = ctx.pages().find((p) => p.url().startsWith(WQ_BASE));
  workPage = existing ?? (await ctx.newPage());
  if (!workPage.url().startsWith(WQ_BASE)) {
    await workPage.goto(WQ_BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  return workPage;
}

/**
 * 在页面上下文里发 GET 请求。
 * 相对路径自动落到 classroom.wqxt.cdut.edu.cn 同源；无需签名参数（已实测）。
 */
export async function apiGet(endpoint, params = {}, timeoutMs = 30000) {
  const page = await getWorkPage();
  return page.evaluate(
    async ({ endpoint, params, timeoutMs }) => {
      const qs = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
      ).toString();
      const url = endpoint + (qs ? (endpoint.includes('?') ? '&' : '?') + qs : '');
      try {
        const r = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(timeoutMs) });
        const text = await r.text();
        try {
          return { ok: true, status: r.status, data: JSON.parse(text) };
        } catch {
          return { ok: true, status: r.status, text: text.slice(0, 400) };
        }
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
      }
    },
    { endpoint, params, timeoutMs },
  );
}

/** 当前页面 URL（用于登录流程判断） */
export async function currentUrl() {
  const page = await getWorkPage();
  return page.url();
}

export async function getPageForLogin() {
  return getWorkPage();
}

/** 关闭浏览器与 Edge 进程（服务退出时调用；用户手动关闭窗口也能工作） */
export async function closeBrowser() {
  try { if (browser) await browser.close().catch(() => {}); } catch {}
  browser = null;
  workPage = null;
  if (edgeChild && !edgeChild.killed) {
    try { edgeChild.kill(); } catch {}
    edgeChild = null;
  }
}

export function edgeStatus() {
  return {
    edgeRunning: !!edgeChild,
    cdpPort: CDP_PORT,
    profileDir: PROFILE_DIR,
  };
}