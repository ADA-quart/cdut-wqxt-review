/* 清渠 · 移动端首页：课程/课次列表 + 导入内容包 */
(async function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var hint = $('importHint');
  var toastTimer = null;

  function toast(msg, ms) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, ms || 2800);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c];
    });
  }

  async function render() {
    var box = $('catalog');
    if (!window.QingquLocal) {
      box.innerHTML = '<p class="empty">本地图书馆未启用。<br>此页面用于安卓 App；浏览器调试需先开启 qingqu_local_mode。</p>';
      return;
    }
    var cat = await window.QingquLocal.getCatalog();
    if (!cat || !cat.courses || !cat.courses.length) {
      box.innerHTML = '<p class="empty">还没有内容。<br>在电脑端「设置 → 导出」里导出「内容包」，把 zip 传到平板上，点右上角「＋ 导入内容包」。</p>';
      return;
    }
    box.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'courses';
    cat.courses.forEach(function (c) {
      var card = document.createElement('section');
      card.className = 'course';
      var lessons = (c.lessons || []).slice().sort(function (a, b) {
        return String(a.name).localeCompare(String(b.name), 'zh', { numeric: true });
      });
      var date = cat.importedAt ? new Date(cat.importedAt).toLocaleDateString('zh-CN') : '';
      card.innerHTML = '<h2>' + esc(c.name) + '</h2>' +
        '<div class="meta">' + lessons.length + ' 节课' + (date ? ' · 导入于 ' + date : '') + '</div>';
      var list = document.createElement('div');
      list.className = 'lessons';
      lessons.forEach(function (l) {
        var a = document.createElement('a');
        a.className = 'lesson';
        a.href = 'review.html?dir=' + encodeURIComponent(c.name + '/' + l.name);
        a.innerHTML = '<span>' + esc(l.name) + '</span><span class="pages">' +
          (l.pages ? l.pages + ' 页' : '') + (l.note ? ' · 笔记' : '') + '</span>';
        list.appendChild(a);
      });
      card.appendChild(list);
      wrap.appendChild(card);
    });
    box.appendChild(wrap);
  }

  $('pkgInput').onchange = async function () {
    var f = $('pkgInput').files && $('pkgInput').files[0];
    if (!f) return;
    if (!window.QingquLocal) { hint.textContent = '本地图书馆未启用，无法导入'; return; }
    hint.textContent = '正在导入 ' + f.name + '（' + (f.size / 1048576).toFixed(1) + ' MB）…';
    try {
      var buf = await f.arrayBuffer();
      var r = await window.QingquLocal.importZip(buf, f.name);
      var courseCount = r.manifest && r.manifest.courses ? r.manifest.courses.length : 0;
      hint.textContent = '✓ 导入完成：' + r.count + ' 个文件' + (courseCount ? '，' + courseCount + ' 门课程' : '');
      await render();
    } catch (e) {
      hint.textContent = '导入失败：' + ((e && e.message) || e);
    }
    $('pkgInput').value = '';
  };

  // ---------- 更新检查（仅安卓 App 内可用；网页预览时禁用） ----------
  var REPO = 'ADA-quart/cdut-wqxt-review';
  var SKIP_KEY = 'wqppt_skip_update';
  var appInfo = null;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function capPlugin(name) {
    try {
      return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[name]) || null;
    } catch (e) { return null; }
  }

  function parseVersion(s) {
    var m = String(s || '').match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }

  function isNewer(a, b) {
    var va = parseVersion(a);
    var vb = parseVersion(b);
    if (!va || !vb) return false;
    for (var i = 0; i < 3; i++) {
      if (va[i] > vb[i]) return true;
      if (va[i] < vb[i]) return false;
    }
    return false;
  }

  // Capacitor 桥可能晚于页面脚本注入，轮询等待
  async function getAppInfo() {
    for (var i = 0; i < 25; i++) {
      var App = capPlugin('App');
      if (App && App.getInfo) {
        try { return await App.getInfo(); } catch (e) { return null; }
      }
      await sleep(120);
    }
    return null;
  }

  function fetchWithTimeout(url) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) { /* 忽略 */ } }, 12000) : null;
    return fetch(url, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : undefined,
    }).finally(function () { if (timer) clearTimeout(timer); });
  }

  async function fetchLatestFromApi() {
    var res = await fetchWithTimeout('https://api.github.com/repos/' + REPO + '/releases/latest');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var j = await res.json();
    var version = String(j.tag_name || '').replace(/^v/i, '');
    if (!parseVersion(version)) throw new Error('无法解析版本号');
    var asset = null;
    (j.assets || []).forEach(function (a) {
      if (!asset && /\.apk$/i.test(a.name || '')) asset = a;
    });
    return { version: version, url: asset ? asset.browser_download_url : j.html_url };
  }

  // 兜底：GitHub API 未认证限流（60 次/时/IP）或不可用时，读 main 分支 package.json 的版本号
  async function fetchLatestFromRaw() {
    var res = await fetchWithTimeout('https://raw.githubusercontent.com/' + REPO + '/main/package.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var j = await res.json();
    var version = String(j.version || '').trim();
    if (!parseVersion(version)) throw new Error('无法解析版本号');
    var tag = 'v' + version;
    return { version: version, url: 'https://github.com/' + REPO + '/releases/download/' + tag + '/qingqu-' + tag + '.apk' };
  }

  async function fetchLatest() {
    try {
      return await fetchLatestFromApi();
    } catch (e) {
      return await fetchLatestFromRaw();
    }
  }

  async function openExternal(url) {
    var Browser = capPlugin('Browser');
    if (Browser && Browser.open) {
      try { await Browser.open({ url: url }); return; } catch (e) { /* 回退 new window */ }
    }
    window.open(url, '_blank');
  }

  function showBanner(info) {
    if (!appInfo) return;
    $('updateBannerText').innerHTML = '发现新版本 <b>v' + esc(info.version) + '</b>（当前 v' + esc(appInfo.version) + '）';
    var banner = $('updateBanner');
    banner.hidden = false;
    $('btnUpdateDownload').onclick = function () { openExternal(info.url); };
    $('btnUpdateSkip').onclick = function () {
      try { localStorage.setItem(SKIP_KEY, info.version); } catch (e) { /* 忽略 */ }
      banner.hidden = true;
    };
  }

  async function checkUpdate(manual) {
    var btn = $('btnCheckUpdate');
    if (manual) {
      btn.disabled = true;
      btn.textContent = '检查中…';
    }
    try {
      var info = await fetchLatest();
      if (isNewer(info.version, appInfo.version)) {
        if (manual) {
          try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { /* 忽略 */ }
        } else {
          try { if (localStorage.getItem(SKIP_KEY) === info.version) return; } catch (e) { /* 忽略 */ }
        }
        showBanner(info);
        if (manual) toast('发现新版本 v' + info.version);
      } else if (manual) {
        toast('已是最新版本（v' + appInfo.version + '）');
      }
    } catch (e) {
      if (manual) toast('检查失败：' + ((e && e.message) || e) + '（需能访问 GitHub）', 4000);
    } finally {
      if (manual) {
        btn.disabled = false;
        btn.textContent = '检查更新';
      }
    }
  }

  (async function initUpdate() {
    appInfo = await getAppInfo();
    var verText = $('verText');
    var btn = $('btnCheckUpdate');
    if (appInfo && appInfo.version) {
      verText.textContent = '清渠 v' + appInfo.version;
      btn.onclick = function () { checkUpdate(true); };
      checkUpdate(false); // 启动时静默检查，发现新版本才提示
    } else {
      verText.textContent = '清渠（网页预览）';
      btn.disabled = true;
      btn.title = '更新检查仅在安卓 App 内可用';
    }
  })();

  render();
})();
