/* 清渠 · 阅读舒适：主题管理（跟随系统/浅色/深色/护眼）+ 20-20-20 护眼提醒。
   在 <head> 同步引入：先于渲染设置 data-theme（避免闪白），DOM 就绪后接管按钮与提醒。
   桌面（浏览器 / Electron）与移动端（Capacitor WebView）通用。 */
(function () {
  'use strict';

  // ---------- 主题 ----------
  var THEME_KEY = 'wqppt_theme';
  var MODES = ['auto', 'light', 'dark', 'eye'];
  var LABEL = { auto: '跟随系统', light: '浅色', dark: '深色', eye: '护眼' };
  var ICON = { auto: '🌗', light: '☀️', dark: '🌙', eye: '📜' };

  function storedMode() {
    try {
      var v = localStorage.getItem(THEME_KEY);
      return MODES.indexOf(v) >= 0 ? v : 'auto';
    } catch (e) { return 'auto'; }
  }

  function systemTheme() {
    try { return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
    catch (e) { return 'light'; }
  }

  function resolveMode(mode) {
    return mode === 'auto' ? systemTheme() : mode;
  }

  function applyTheme() {
    var mode = storedMode();
    document.documentElement.setAttribute('data-theme', resolveMode(mode));
    document.documentElement.setAttribute('data-theme-mode', mode);
    var btn = document.getElementById('btnTheme');
    if (btn) {
      btn.textContent = ICON[mode] + ' ' + LABEL[mode];
      btn.title = '主题：' + LABEL[mode] + '（点击切换：跟随系统 → 浅色 → 深色 → 护眼）';
    }
    try {
      window.dispatchEvent(new CustomEvent('wqppt-theme', { detail: { mode: mode, resolved: resolveMode(mode) } }));
    } catch (e) { /* 忽略 */ }
    syncSystemBars();
  }

  // 安卓（Capacitor）：状态栏 / 手势条图标颜色跟随应用主题
  function syncSystemBars() {
    try {
      var sb = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SystemBars;
      if (sb && sb.setStyle) {
        sb.setStyle({ style: resolveMode(storedMode()) === 'dark' ? 'DARK' : 'LIGHT' });
      }
    } catch (e) { /* 非原生环境忽略 */ }
  }

  function setTheme(mode) {
    if (MODES.indexOf(mode) < 0) mode = 'auto';
    try { localStorage.setItem(THEME_KEY, mode); } catch (e) { /* 忽略 */ }
    applyTheme();
  }

  function cycleTheme() {
    setTheme(MODES[(MODES.indexOf(storedMode()) + 1) % MODES.length]);
  }

  // 立即应用（脚本位于 <head>，先于 CSS 渲染完成）——避免闪白/闪黑
  document.documentElement.setAttribute('data-theme', resolveMode(storedMode()));
  document.documentElement.setAttribute('data-theme-mode', storedMode());

  // ---------- 正文字号（作用于笔记与对话正文） ----------
  var FONT_KEY = 'wqppt_fontsize';
  var FONT_SIZES = ['s', 'm', 'l', 'xl'];

  function storedFont() {
    try {
      var v = localStorage.getItem(FONT_KEY);
      return FONT_SIZES.indexOf(v) >= 0 ? v : 'm';
    } catch (e) { return 'm'; }
  }

  function applyFont() {
    document.documentElement.setAttribute('data-fontsize', storedFont());
    try {
      window.dispatchEvent(new CustomEvent('wqppt-fontsize', { detail: { size: storedFont() } }));
    } catch (e) { /* 忽略 */ }
  }

  function setFontSize(size) {
    if (FONT_SIZES.indexOf(size) < 0) size = 'm';
    try { localStorage.setItem(FONT_KEY, size); } catch (e) { /* 忽略 */ }
    applyFont();
  }

  document.documentElement.setAttribute('data-fontsize', storedFont());

  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (storedMode() === 'auto') applyTheme();
    });
  } catch (e) { /* 旧浏览器忽略 */ }

  // ---------- 20-20-20 护眼提醒 ----------
  var REMIND_KEY = 'wqppt_eye_reminder';
  var REMIND_MS = 20 * 60 * 1000;
  var timer = null;
  var nextAt = 0;

  function reminderOn() {
    try { return localStorage.getItem(REMIND_KEY) === '1'; } catch (e) { return false; }
  }

  function intervalMs() {
    // 测试/调试可覆盖：window.__wqpptReminderIntervalMs = 5000
    return Number(window.__wqpptReminderIntervalMs) || REMIND_MS;
  }

  function stopReminder() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function scheduleReminder() {
    stopReminder();
    if (!reminderOn()) return;
    nextAt = Date.now() + intervalMs();
    timer = setInterval(tick, 30 * 1000);
    document.addEventListener('visibilitychange', tick);
  }

  function tick() {
    if (!reminderOn()) return;
    if (Date.now() >= nextAt) fireReminder();
  }

  function fireReminder() {
    nextAt = Date.now() + intervalMs();
    var el = document.getElementById('comfortBar');
    if (!el) {
      el = document.createElement('div');
      el.id = 'comfortBar';
      el.className = 'comfort-bar';
      el.innerHTML =
        '<span>🫧</span>' +
        '<span>护眼时间到：抬头看看 6 米外的东西，休息 20 秒（20-20-20）</span>' +
        '<button class="cb-btn" id="cbDone">好的</button>' +
        '<button class="cb-btn" id="cbDelay">5 分钟后</button>' +
        '<button class="cb-btn" id="cbOff">关闭提醒</button>';
      document.body.appendChild(el);
      el.querySelector('#cbDone').addEventListener('click', function () { el.hidden = true; });
      el.querySelector('#cbDelay').addEventListener('click', function () {
        el.hidden = true;
        nextAt = Date.now() + 5 * 60 * 1000;
      });
      el.querySelector('#cbOff').addEventListener('click', function () {
        el.hidden = true;
        setReminder(false);
      });
    }
    el.hidden = false;
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(function () { el.hidden = true; }, 30000);
  }

  function setReminder(on) {
    try { localStorage.setItem(REMIND_KEY, on ? '1' : '0'); } catch (e) { /* 忽略 */ }
    if (on) scheduleReminder(); else stopReminder();
    try {
      window.dispatchEvent(new CustomEvent('wqppt-reminder', { detail: { on: !!on } }));
    } catch (e) { /* 忽略 */ }
  }

  // ---------- 初始化 ----------
  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    applyTheme();
    applyFont();
    var btn = document.getElementById('btnTheme');
    if (btn) btn.addEventListener('click', cycleTheme);
    if (reminderOn()) scheduleReminder();
  });

  // 暴露接口（设置界面、测试用）
  window.Comfort = {
    theme: storedMode,
    setTheme: setTheme,
    cycleTheme: cycleTheme,
    fontSize: storedFont,
    setFontSize: setFontSize,
    reminderOn: reminderOn,
    setReminder: setReminder,
    fireNow: fireReminder,     // 调试/测试：立即弹一次提醒
    MODES: MODES,
    LABEL: LABEL,
  };
})();
