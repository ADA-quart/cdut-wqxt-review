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
      box.innerHTML = '<p class="empty">还没有内容。<br>在电脑端「设置 → 导出」里导出「内容包」，把 zip 传到平板上，点右上角「＋ 导入内容包」。' +
        '<br><span style="color:var(--ink-3);font-size:12.5px">提示：App 数据存在本机，卸载或系统清理会丢失；电脑端导出的 zip 建议留作备份。</span></p>';
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
      var head = document.createElement('div');
      head.className = 'course-head';
      var h2 = document.createElement('h2');
      h2.textContent = c.name;
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn ghost small course-del';
      del.textContent = '删除';
      del.title = '删除本课程的导入内容';
      del.onclick = function () { openCourseDelete(c.name); };
      head.appendChild(h2);
      head.appendChild(del);
      card.appendChild(head);
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = lessons.length + ' 节课' + (date ? ' · 导入于 ' + date : '');
      card.appendChild(meta);
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

  // ---------- 删除课程 / 数据管理 ----------
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }

  async function doDeleteCourse(name, all) {
    hint.textContent = '正在删除《' + name + '》' + (all ? '全部数据' : '的课件与笔记') + '…';
    try {
      var r = await window.QingquLocal.deleteCourse(name, { all: all });
      hint.textContent = '';
      toast('已删除《' + name + '》：' + r.removed + ' 个文件，释放 ' + fmtBytes(r.bytes), 3600);
      await render();
    } catch (e) {
      hint.textContent = '删除失败：' + ((e && e.message) || e);
    }
  }

  function openCourseDelete(name) {
    var Q = window.QingquLocal;
    var body = document.createElement('div');
    var p = document.createElement('p');
    p.style.margin = '0 0 6px';
    p.textContent = '两种删法：';
    var ul = document.createElement('ul');
    ul.style.cssText = 'margin:0 0 6px;padding-left:18px';
    ul.innerHTML =
      '<li><b>仅删课件与笔记</b>：保留学习进度、历史对话、复习卡（重新导入新版内容包后接着用）</li>' +
      '<li><b>全部删除</b>：连进度、对话、复习卡一并删除，本机不再留该课程任何数据</li>';
    var occ = document.createElement('p');
    occ.style.cssText = 'margin:10px 0 0;color:var(--ink-3);font-size:12.5px';
    occ.textContent = '统计占用中…';
    body.appendChild(p);
    body.appendChild(ul);
    body.appendChild(occ);
    Q.storageStats().then(function (st) {
      var c = st.courses[name];
      occ.textContent = '本机占用：' + fmtBytes(c ? c.bytes : 0) + '（' + (c ? c.files : 0) + ' 个文件）';
    }).catch(function () { occ.textContent = ''; });
    Q.sheet('删除《' + name + '》', body, [
      { text: '仅删课件与笔记', onClick: function (close) { close(); doDeleteCourse(name, false); } },
      { text: '全部删除', danger: true, onClick: function (close) { close(); doDeleteCourse(name, true); } },
    ]);
  }

  function doClearAll() {
    window.QingquLocal.clearAll().then(function () {
      toast('已清空本机全部数据');
      return render();
    }).catch(function (e) {
      toast('清空失败：' + ((e && e.message) || e));
    });
  }

  function openClearAll() {
    var body = document.createElement('div');
    var p1 = document.createElement('p');
    p1.style.margin = '0 0 6px';
    p1.textContent = '将删除本机清渠的全部数据：所有课程的课件、笔记、图片、复习卡、学习进度与历史对话。无法恢复。';
    var p2 = document.createElement('p');
    p2.style.margin = '0';
    p2.textContent = 'AI 接口设置会保留；删除后可随时重新导入电脑端导出的内容包。';
    body.appendChild(p1);
    body.appendChild(p2);
    window.QingquLocal.sheet('清空全部数据', body, [
      { text: '确认清空', danger: true, onClick: function (close) { close(); doClearAll(); } },
    ]);
  }

  async function openDataManage() {
    var Q = window.QingquLocal;
    var body = document.createElement('div');
    var sum = document.createElement('p');
    sum.style.margin = '0 0 6px';
    sum.textContent = '统计中…';
    var list = document.createElement('div');
    var note = document.createElement('p');
    note.className = 'dm-note';
    note.textContent = '首页每张课程卡片上也有「删除」，可按课程清理。';
    body.appendChild(sum);
    body.appendChild(list);
    body.appendChild(note);
    Q.sheet('数据管理', body, [
      { text: '清空全部数据', danger: true, onClick: function (close) { close(); openClearAll(); } },
    ]);
    try {
      var st = await Q.storageStats();
      var names = Object.keys(st.courses).sort();
      sum.textContent = '共 ' + names.length + ' 门课程 · ' + st.files + ' 个文件 · 约 ' + fmtBytes(st.bytes);
      var bits = [];
      if (st.quota) bits.push('系统分配 ' + fmtBytes(st.usage || 0) + ' / ' + fmtBytes(st.quota));
      if (st.persisted === 'granted') bits.push('存储保护：已开启');
      else if (st.persisted === 'denied') bits.push('存储保护：未开启（磁盘紧张时系统可能清理数据，请保留电脑端导出的 zip）');
      if (bits.length) {
        var extra = document.createElement('p');
        extra.style.cssText = 'margin:6px 0 0;color:var(--ink-3);font-size:12.5px';
        extra.textContent = bits.join(' · ');
        body.insertBefore(extra, note);
      }
      names.forEach(function (n) {
        var row = document.createElement('div');
        row.className = 'dm-row';
        var a = document.createElement('span');
        a.textContent = n;
        var b = document.createElement('span');
        b.className = 'dm-sz';
        b.textContent = fmtBytes(st.courses[n].bytes);
        row.appendChild(a);
        row.appendChild(b);
        list.appendChild(row);
      });
      if (!names.length) {
        sum.textContent = '本机还没有导入数据';
      }
    } catch (e) {
      sum.textContent = '统计失败：' + ((e && e.message) || e);
    }
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

  $('btnData').onclick = function () {
    if (!window.QingquLocal) { toast('本地图书馆未启用'); return; }
    openDataManage();
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

  // App 内更新：优先走原生 DownloadManager（下载完自动弹安装器，不切到浏览器）；
  // 原生插件不可用（如网页预览）时才回退到系统浏览器
  async function startUpdate(url) {
    var name = 'qingqu-update.apk';
    try {
      var base = decodeURIComponent(String(url).split('?')[0].split('/').pop() || '');
      if (/\.apk$/i.test(base)) name = base;
    } catch (e) { /* 用默认名 */ }
    var Native = capPlugin('UpdateInstaller');
    if (Native && Native.download) {
      try {
        await Native.download({ url: url, fileName: name });
        toast('已开始下载更新，完成后会自动弹出安装', 4000);
        return;
      } catch (e) { /* 原生失败 → 回退浏览器 */ }
    }
    openExternal(url);
  }

  function showBanner(info) {
    if (!appInfo) return;
    $('updateBannerText').innerHTML = '发现新版本 <b>v' + esc(info.version) + '</b>（当前 v' + esc(appInfo.version) + '）';
    var banner = $('updateBanner');
    banner.hidden = false;
    $('btnUpdateDownload').onclick = function () { startUpdate(info.url); };
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
