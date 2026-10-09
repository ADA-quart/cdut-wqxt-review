/**
 * 浏览器会话管理（Windows / macOS / Linux）。
 *
 * 问渠学堂（classroom.wqxt.cdut.edu.cn）全站有瑞数式动态防护（WAF）：
 *   - 直接 HTTP 请求 → 412 挑战页
 *   - Playwright 直接 launch / headless → 挑战 JS 执行后仍 400
 *   - 手动拉起真实 Edge / Chrome + CDP 连接 → 正常访问（已实测）
 *
 * 所以本模块以「独立 profile 拉起本机真实浏览器 + 连接调试端口」的方式工作：
 *   - profile 目录持久化，登录状态（cookie/localStorage）跨重启保留
 *   - 只有在浏览器未运行时才拉起新实例，已有实例直接复用
 *   - 窗口默认挪到屏幕外（见下方 OFFSCREEN），需要验证码时再用 /api/browser/show 唤出
 *   - 业务 API 一律在真实页面上下文里 fetch（同源、带 cookie、免签名）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { PROFILE_DIR, ensureDir } from './paths.mjs';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

/** 各平台候选浏览器（Chromium 系真实内核，用来过瑞数 WAF） */
function browserCandidates() {
  const home = os.homedir();
  if (IS_WIN) {
    return [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ];
  }
  if (IS_MAC) {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      path.join(home, 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
  }
  return [
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
}

/** 在 PATH 里找一个可执行文件（Linux 发行版路径经常不一致） */
function findInPath(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* 忽略无权限的目录 */ }
  }
  return null;
}

export const CDP_PORT = 9333;
export const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
export const WQ_BASE = 'https://classroom.wqxt.cdut.edu.cn';

let edgeChild = null;
/** 实际使用的浏览器可执行文件路径（便于在 Mac/Linux 上排查） */
let browserPath = null;
let browser = null;
let workPage = null;
let launching = null;
let navPromise = null;
/** 窗口是否被挪到可见区域（登录需要输验证码时唤出） */
let windowVisible = false;
/** 首次拿到工作页面后，把窗口挪到屏幕外（--window-position 部分版本会被忽略） */
let positioned = false;
/** 窗口被移出屏幕时的坐标（屏幕外，避免打扰用户） */
const OFFSCREEN = { left: -32000, top: -32000 };
const ONSCREEN = { left: 120, top: 80, width: 1280, height: 860 };

/** 连接后立刻把窗口挪出屏幕（不等页面加载，避免启动瞬间闪窗） */
async function nudgeOffscreen(b) {
  let session = null;
  try {
    session = await b.newBrowserCDPSession();
    const { targetInfos } = await session.send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    if (!page) return false;
    const { windowId } = await session.send('Browser.getWindowForTarget', { targetId: page.targetId });
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await session.send('Browser.setWindowBounds', { windowId, bounds: { left: OFFSCREEN.left, top: OFFSCREEN.top } });
    positioned = true;
    return true;
  } catch {
    return false;
  } finally {
    if (session) await session.detach().catch(() => {});
  }
}

function findEdge() {
  // 手动指定优先：WQ_BROWSER="/Applications/xxx.app/Contents/MacOS/xxx"
  const override = process.env.WQ_BROWSER;
  if (override && fs.existsSync(override)) return override;

  for (const p of browserCandidates()) {
    if (fs.existsSync(p)) return p;
  }
  if (!IS_WIN && !IS_MAC) {
    for (const name of ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser']) {
      const p = findInPath(name);
      if (p) return p;
    }
  }
  throw new Error(
    IS_MAC
      ? '未找到 Edge / Chrome / Chromium / Brave，请先安装其中之一，或用 WQ_BROWSER 指定路径'
      : '未找到 Microsoft Edge（或 Chrome），请先安装 Chromium 系浏览器',
  );
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
  browserPath = edgePath;
  ensureDir(PROFILE_DIR);
  edgeChild = spawn(
    edgePath,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=msEdgeFirstRunExperience',
      // 窗口默认放到屏幕外：真实 Edge 内核保持不变（绕开 WAF 指纹检测），
      // 但用户不会被每次弹出的窗口打扰；需要输验证码时再一键唤出。
      '--window-position=-32000,-32000',
      '--window-size=1280,860',
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
    // 立刻把窗口挪出屏幕，避免启动瞬间闪一下
    await nudgeOffscreen(browser).catch(() => {});
    return browser;
  })().finally(() => { launching = null; });

  return launching;
}

/** 统一认证（CAS）主机：登录/退出流程中工作页面会停在这里 */
export const CAS_HOST = 'cas.paas.cdut.edu.cn';

/**
 * 工作页面判定：问渠学堂站点，或统一认证页。
 * 退出登录后页面会停在 CAS，必须认它——否则每次状态查询都认不出旧页面，会不断新开标签页。
 */
function isWorkUrl(u) {
  return u.startsWith(WQ_BASE) || u.includes(CAS_HOST);
}

/** 是否 cdut 域（用于兜底复用标签页） */
function isCdutUrl(u) {
  try {
    return /(^|\.)cdut\.edu\.cn$/.test(new URL(u).hostname);
  } catch {
    return false;
  }
}

/** 取一个位于问渠学堂域下的工作页面（离屏 API 调用均在此页面内执行） */
export async function getWorkPage() {
  const b = await ensureBrowser();
  if (workPage && !workPage.isClosed() && isWorkUrl(workPage.url())) return workPage;

  // 并发保护：页面初始化/导航期间，多个请求共享同一个 promise，
  // 避免第二个请求在导航中途执行页面脚本（否则报 Execution context was destroyed）
  if (navPromise) return navPromise;

  navPromise = (async () => {
    const ctx = b.contexts()[0];
    // 优先复用问渠/统一认证标签页，其次复用任意 cdut 页面，最后才新开（避免标签页堆积）
    const existing =
      ctx.pages().find((p) => isWorkUrl(p.url())) ??
      ctx.pages().find((p) => isCdutUrl(p.url())) ??
      (await ctx.newPage());
    const page = existing;
    if (!isWorkUrl(page.url())) {
      await page.goto(WQ_BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    workPage = page;
    if (!positioned) {
      positioned = true;
      setWindowBounds({ windowState: 'normal', ...OFFSCREEN }).catch(() => {});
    }
    return page;
  })().finally(() => { navPromise = null; });

  return navPromise;
}

/**
 * 在页面上下文里发 GET 请求。
 * 相对路径自动落到 classroom.wqxt.cdut.edu.cn 同源；无需签名参数（已实测）。
 */
export async function apiGet(endpoint, params = {}, timeoutMs = 30000) {
  const page = await getWorkPage();
  const run = () => page.evaluate(
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

  try {
    return await run();
  } catch (e) {
    // 页面恰好发生导航时重试一次
    if (/Execution context was destroyed|Target closed|Cannot find context/i.test(String(e?.message || e))) {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await new Promise((r) => setTimeout(r, 800));
      return run();
    }
    throw e;
  }
}

/** 当前页面 URL（用于登录流程判断） */
export async function currentUrl() {
  const page = await getWorkPage();
  return page.url();
}

/**
 * 清掉登录会话类 cookie（退出登录用）。
 *
 * 只删鉴权 cookie，保留瑞数 WAF 与埋点 cookie：WAF cookie 被清会触发重新挑战，
 * 而它不携带身份信息。
 */
const AUTH_COOKIE_NAMES = ['JWTUser', '_token', 'live_token', 'iPlanetDirectoryPro', 'SESSION', 'PHPSESSID'];

export async function clearAuthCookies() {
  const b = await ensureBrowser();
  const ctx = b.contexts()[0];
  const cleared = [];
  for (const name of AUTH_COOKIE_NAMES) {
    try {
      // 限定在 cdut 域下，避免误删其它站点的同名 cookie
      await ctx.clearCookies({ name, domain: /cdut\.edu\.cn$/ });
      cleared.push(name);
    } catch { /* 忽略：cookie 不存在时无操作 */ }
  }
  return cleared;
}

export async function getPageForLogin() {
  return getWorkPage();
}

/** 关闭浏览器与 Edge 进程（服务退出时调用；用户手动关闭窗口也能工作） */
export async function closeBrowser() {
  try { if (browser) await browser.close().catch(() => {}); } catch {}
  browser = null;
  workPage = null;
  windowVisible = false;
  positioned = false;
  if (edgeChild && !edgeChild.killed) {
    try { edgeChild.kill(); } catch {}
    edgeChild = null;
  }
}

/** 用 CDP 设置浏览器窗口位置（Edge 没有"最小化启动"开关，只能连上后挪） */
async function setWindowBounds(bounds) {
  const page = await getWorkPage();
  const session = await page.context().newCDPSession(page);
  try {
    const { windowId } = await session.send('Browser.getWindowForTarget');
    if (bounds.windowState) {
      await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: bounds.windowState } });
    }
    const { windowState, ...rest } = bounds;
    await session.send('Browser.setWindowBounds', { windowId, bounds: rest });
    return true;
  } finally {
    await session.detach().catch(() => {});
  }
}

/** 把 Edge 窗口唤到屏幕上（登录、输验证码时用） */
export async function showBrowserWindow() {
  try {
    await setWindowBounds({ windowState: 'normal', ...ONSCREEN });
    const page = await getWorkPage();
    await page.bringToFront().catch(() => {});
    windowVisible = true;
    return { ok: true, visible: true };
  } catch (e) {
    return { ok: false, visible: windowVisible, error: String(e?.message || e) };
  }
}

/** 把 Edge 窗口挪回屏幕外（平时不打扰用户） */
export async function hideBrowserWindow() {
  try {
    await setWindowBounds({ windowState: 'normal', ...OFFSCREEN });
    windowVisible = false;
    return { ok: true, visible: false };
  } catch (e) {
    return { ok: false, visible: windowVisible, error: String(e?.message || e) };
  }
}

export function browserWindowVisible() {
  return windowVisible;
}

export function edgeStatus() {
  return {
    edgeRunning: !!edgeChild,
    cdpPort: CDP_PORT,
    profileDir: PROFILE_DIR,
    browserPath,
    windowVisible,
  };
}
