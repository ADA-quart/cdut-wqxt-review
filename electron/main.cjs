/**
 * 清渠 — Electron 桌面壳。
 *
 * 行为：
 *  - 启动时先探测本地服务（默认 3901）；没在跑就自己拉起 server/index.mjs
 *  - 窗口加载 http://127.0.0.1:<port>；外部链接交给系统浏览器
 *  - 关闭窗口 = 退出程序；壳自己启动的服务会优雅关停（手动先开的服务保持不动）
 *  - 快捷键：Ctrl+R 刷新、F12 / Ctrl+Shift+I 开发者工具
 */
const { app, BrowserWindow, Menu, dialog, shell, nativeTheme } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.WQPPT_ELECTRON_PORT || process.env.PORT || 3901);
const BASE = `http://127.0.0.1:${PORT}`;
const TEST = process.env.WQPPT_ELECTRON_TEST === '1';

let win = null;
let serverChild = null;
let quitting = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isOurServer() {
  try {
    const res = await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return false;
    const data = await res.json();
    return typeof data.loggedIn === 'boolean';
  } catch {
    return false;
  }
}

async function startServer() {
  // 优先复用 Electron 自带的 Node（ELECTRON_RUN_AS_NODE），不依赖系统 PATH 里的 node
  const custom = process.env.WQPPT_NODE;
  const bin = custom || process.execPath;
  const env = { ...process.env, PORT: String(PORT), WQPPT_ELECTRON_PORT: String(PORT) };
  if (!custom) env.ELECTRON_RUN_AS_NODE = '1';
  serverChild = spawn(bin, [path.join(ROOT, 'server', 'index.mjs')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  serverChild.stderr.on('data', (d) => console.error('[server]', String(d).trim()));
  serverChild.on('exit', () => { serverChild = null; });
  for (let i = 0; i < 60; i++) {
    if (await isOurServer()) return true;
    if (!serverChild) return false;
    await sleep(400);
  }
  return false;
}

async function stopServer() {
  if (!serverChild) return;
  try {
    await fetch(`${BASE}/api/system/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch { /* 服务可能已退出 */ }
  for (let i = 0; i < 50; i++) {
    if (!serverChild) return;
    await sleep(120);
  }
  try { serverChild.kill(); } catch { /* 忽略 */ }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    title: '清渠',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121212' : '#f5f6f8',
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  win.once('ready-to-show', () => {
    if (TEST) return;
    win.show();
    win.focus();
    // 兜底：个别启动方式（如带隐藏窗口样式启动）会让窗口保持不可见，稍后再确认一次
    setTimeout(() => {
      if (win && !win.isDestroyed() && !win.isVisible()) {
        win.show();
        win.focus();
      }
    }, 1500);
  });
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(url)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (child) => {
    child.setMenuBarVisibility(false);
    try { child.setIcon(path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png')); } catch { /* 忽略 */ }
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    const mod = input.control || input.meta;
    if (mod && key === 'r') { win.webContents.reload(); e.preventDefault(); }
    else if (key === 'f12' || (mod && input.shift && key === 'i')) { win.webContents.toggleDevTools(); e.preventDefault(); }
  });
  return win;
}

async function boot() {
  if (!(await isOurServer())) {
    const ok = await startServer();
    if (!ok) {
      dialog.showErrorBox('无法启动本地服务', `端口 ${PORT} 没有运行清渠本地服务，且自动启动失败。\n请检查项目目录是否完整，或先运行项目里的启动脚本。`);
      app.quit();
      return;
    }
  }
  const w = createWindow();
  w.loadURL(BASE).catch((e) => {
    dialog.showErrorBox('加载失败', String((e && e.message) || e));
    app.quit();
  });
}

app.setAppUserModelId('com.wqppt.desktop');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (!win.isVisible()) win.show();
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    boot();
  });

  app.on('window-all-closed', () => { app.quit(); });

  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    stopServer().finally(() => app.quit());
  });
}
