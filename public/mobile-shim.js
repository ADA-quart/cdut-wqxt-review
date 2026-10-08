/* 清渠 · 移动端数据层（本地图书馆模式）
 *
 * 职责：
 *  1) 把电脑端导出的 zip 包解压进 IndexedDB 私有图书馆（manifest / notes / images / cards / chats / progress）
 *  2) 本地模式下拦截 fetch('/api/*')、fetch('/notes/*')，用图书馆数据响应（复习页零改动复用）
 *  3) 预载课次图片为 blob URL，通过 window.QingquFiles 钩子供 <img src> 同步取用
 *
 * 启用条件：Capacitor 原生环境，或浏览器调试时 localStorage.setItem('qingqu_local_mode','1')。
 */
(function () {
  'use strict';

  var NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  var LOCAL = false;
  try { LOCAL = NATIVE || localStorage.getItem('qingqu_local_mode') === '1'; } catch (e) { /* 忽略 */ }
  if (!LOCAL) return;

  document.documentElement.classList.add('local-app');

  // ---------- 通用小面板（外链提示 / AI 设置共用） ----------
  var injectSheetStyle = function () {
    if (document.getElementById('qzSheetStyle')) return;
    var css = ''
      + '.qz-mask{position:fixed;inset:0;background:var(--mask,rgba(12,16,22,.5));z-index:200;display:flex;align-items:center;justify-content:center;padding:20px}'
      + '.qz-sheet{background:var(--panel,#fff);color:var(--ink,#222);border-radius:14px;max-width:min(560px,92vw);width:100%;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 18px 50px rgba(15,22,36,.3)}'
      + '.qz-sheet-head{padding:12px 16px;font-weight:600;border-bottom:1px solid var(--line,#e3e6ea);display:flex;justify-content:space-between;align-items:center;gap:10px}'
      + '.qz-sheet-body{padding:14px 16px;overflow:auto;font-size:13.5px;line-height:1.7;word-break:break-all}'
      + '.qz-sheet-body pre{white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.7;margin:0}'
      + '.qz-sheet-acts{padding:10px 16px;border-top:1px solid var(--line,#e3e6ea);display:flex;justify-content:flex-end;gap:8px}'
      + '.qz-sheet .btn{border:1px solid var(--line,#d8dce1);background:var(--panel,#fff);color:var(--ink,#222);border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer}'
      + '.qz-sheet .btn.primary{background:var(--brand,#2f6bff);border-color:var(--brand,#2f6bff);color:#fff}';
    var st = document.createElement('style');
    st.id = 'qzSheetStyle';
    st.textContent = css;
    document.head.appendChild(st);
  };

  // 通用小面板：actions = [{text, primary, onClick(close)}]
  var showSheet = function (title, bodyEl, actions) {
    injectSheetStyle();
    var mask = document.createElement('div');
    mask.className = 'qz-mask';
    mask.id = 'qzSheet';
    var sheet = document.createElement('div');
    sheet.className = 'qz-sheet';
    var head = document.createElement('div');
    head.className = 'qz-sheet-head';
    var t = document.createElement('span');
    t.textContent = title;
    var x = document.createElement('button');
    x.className = 'btn';
    x.style.padding = '2px 10px';
    x.textContent = '✕';
    head.appendChild(t);
    head.appendChild(x);
    var body = document.createElement('div');
    body.className = 'qz-sheet-body';
    if (bodyEl) body.appendChild(bodyEl);
    var acts = document.createElement('div');
    acts.className = 'qz-sheet-acts';
    var close = function () { mask.remove(); };
    x.onclick = close;
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    (actions || []).forEach(function (a) {
      var b = document.createElement('button');
      b.className = 'btn' + (a.primary ? ' primary' : '');
      b.textContent = a.text;
      b.onclick = function () { a.onClick ? a.onClick(close) : close(); };
      acts.appendChild(b);
    });
    var plain = document.createElement('button');
    plain.className = 'btn';
    plain.textContent = '关闭';
    plain.onclick = close;
    acts.appendChild(plain);
    sheet.appendChild(head);
    sheet.appendChild(body);
    sheet.appendChild(acts);
    mask.appendChild(sheet);
    document.body.appendChild(mask);
  };

  // ---------- AI 配置（App 内提问用；OpenAI 兼容接口） ----------
  var AI_CONFIG_KEY = 'wqppt_ai_config';

  function getAiConfig() {
    try {
      var c = JSON.parse(localStorage.getItem(AI_CONFIG_KEY) || 'null');
      if (c && c.baseUrl && c.model) return c;
    } catch (e) { /* 忽略 */ }
    return null;
  }

  function setAiConfig(c) {
    try { localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(c)); } catch (e) { /* 忽略 */ }
  }

  // 优先走原生 HTTP（CapacitorHttp，不受 CORS 限制）；浏览器调试回退 fetch
  function httpRequest(opts) {
    var Http = null;
    try { Http = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp; } catch (e) { /* 忽略 */ }
    if (Http && Http.request) return Http.request(opts);
    var headers = Object.assign({}, opts.headers || {});
    var fOpts = { method: opts.method || 'GET', headers: headers };
    if (opts.data !== undefined) {
      fOpts.body = JSON.stringify(opts.data);
      if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
    }
    return fetch(opts.url, fOpts).then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        try { d = JSON.parse(t); } catch (e2) { /* 非 JSON */ }
        return { status: r.status, data: d, headers: {}, url: r.url };
      });
    });
  }

  function showAiSettings() {
    var cur = getAiConfig() || {};
    var wrap = document.createElement('div');
    var mkField = function (label, value, type, placeholder) {
      var box = document.createElement('label');
      box.style.display = 'block';
      box.style.margin = '0 0 10px';
      var sp = document.createElement('div');
      sp.textContent = label;
      sp.style.cssText = 'font-size:12.5px;color:var(--ink-3,#8892a0);margin-bottom:4px';
      var inp = document.createElement('input');
      inp.type = type || 'text';
      inp.value = value || '';
      inp.placeholder = placeholder || '';
      inp.style.cssText = 'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--line,#d8dce1);border-radius:8px;background:var(--panel,#fff);color:var(--ink,#222);font-size:13.5px';
      box.appendChild(sp);
      box.appendChild(inp);
      wrap.appendChild(box);
      return inp;
    };
    var baseInput = mkField('接口地址（OpenAI 兼容）', cur.baseUrl || '', 'text', 'https://api.deepseek.com/v1');
    var modelInput = mkField('模型', cur.model || '', 'text', 'deepseek-chat');
    var keyInput = mkField('API Key', cur.apiKey || '', 'password', 'sk-…');
    var hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px;color:var(--ink-3,#8892a0);min-height:16px;margin-bottom:8px';
    hint.textContent = 'Key 只保存在本机；支持 DeepSeek / 通义 / OpenAI / Ollama 等兼容接口。';
    wrap.appendChild(hint);
    var fetchBtn = document.createElement('button');
    fetchBtn.className = 'btn';
    fetchBtn.textContent = '拉取模型列表';
    fetchBtn.onclick = async function () {
      var base = baseInput.value.trim().replace(/\/+$/, '');
      if (!base) { hint.textContent = '先填接口地址'; return; }
      fetchBtn.disabled = true;
      hint.textContent = '拉取模型列表…';
      try {
        var key2 = keyInput.value.trim();
        var r = await httpRequest({
          url: base + '/models', method: 'GET',
          headers: key2 ? { Authorization: 'Bearer ' + key2 } : {},
          responseType: 'json', connectTimeout: 15000, readTimeout: 20000,
        });
        var arr = (r && r.data && (r.data.data || r.data.models)) || [];
        var ids = arr.map(function (m) { return (m && (m.id || m.name)) || ''; }).filter(Boolean);
        if (!ids.length) throw new Error('接口没有返回模型列表');
        var list = document.getElementById('qzModelList');
        if (!list) {
          list = document.createElement('datalist');
          list.id = 'qzModelList';
          document.body.appendChild(list);
        }
        list.innerHTML = '';
        ids.forEach(function (id2) {
          var o = document.createElement('option');
          o.value = id2;
          list.appendChild(o);
        });
        modelInput.setAttribute('list', 'qzModelList');
        hint.textContent = '找到 ' + ids.length + ' 个模型（模型输入框可下拉选择）';
      } catch (e) {
        hint.textContent = '拉取失败：' + ((e && e.message) || e);
      } finally {
        fetchBtn.disabled = false;
      }
    };
    wrap.appendChild(fetchBtn);
    showSheet('AI 设置（App 内提问）', wrap, [{
      text: '保存',
      primary: true,
      onClick: function (close) {
        var baseUrl = baseInput.value.trim().replace(/\/+$/, '');
        var model = modelInput.value.trim();
        if (!baseUrl || !model) { hint.textContent = '接口地址和模型是必填项'; return; }
        setAiConfig({ baseUrl: baseUrl, model: model, apiKey: keyInput.value.trim() });
        close();
      },
    }]);
  }

  // ---------- 本地知识库检索（App 内的「本课程 / 全库」范围） ----------
  async function localKbSearch(q, scope, dir, topK) {
    q = String(q || '').trim();
    if (!q) return [];
    var parts = String(dir || '').split('/').filter(Boolean);
    var courseFilter = scope === 'all' ? '' : (parts[0] || '');
    var lessonFilter = scope === 'lesson' ? (parts[1] || '') : '';

    var recs = [];
    try { recs = await listFiles('notes/'); } catch (e) { recs = []; }
    var byLesson = new Map();
    recs.forEach(function (rec) {
      var path2 = String(rec.path || '');
      if (!/\.md$/i.test(path2) || /\.note\.work\.md$/i.test(path2)) return;
      var rel = path2.slice('notes/'.length);
      var segs = rel.split('/');
      if (segs.length < 2) return;
      var lessonFile = segs[segs.length - 1];
      var lesson = lessonFile.replace(/\.md$/i, '');
      var course = segs.slice(0, -1).join('/');
      if (courseFilter && course !== courseFilter) return;
      if (lessonFilter && lesson !== lessonFilter) return;
      var isBase = !/\.note\.md$/i.test(lessonFile);
      var text = typeof rec.text === 'string' ? rec.text : '';
      if (!text) return;
      var key = course + '/' + lesson;
      var hit = byLesson.get(key);
      if (!hit || (isBase && !hit.base)) byLesson.set(key, { course: course, lesson: lesson, text: text, base: isBase });
    });

    var keys = [];
    q.split(/[\s,，。；;：:、!！?？()（）\[\]【】"'“”]+/).forEach(function (w) {
      w = w.trim().toLowerCase();
      if (w.length >= 2) keys.push(w);
      var cn = w.replace(/[^\u4e00-\u9fff]/g, '');
      for (var i = 0; i + 2 <= cn.length; i++) keys.push(cn.slice(i, i + 2));
    });
    keys = keys.filter(function (s, i) { return keys.indexOf(s) === i; });
    if (!keys.length) return [];

    var out = [];
    byLesson.forEach(function (doc) {
      var segments = [];
      var re = /<!-- page (\d+): [^>]+ -->/g;
      var marks = [];
      var m;
      while ((m = re.exec(doc.text))) marks.push(m);
      if (marks.length) {
        for (var i = 0; i < marks.length; i++) {
          var start = marks[i].index + marks[i][0].length;
          var end = i + 1 < marks.length ? marks[i + 1].index : doc.text.length;
          segments.push({ page: Number(marks[i][1]), text: doc.text.slice(start, end) });
        }
      } else {
        doc.text.split(/\n{2,}/).forEach(function (para) {
          if (para.trim()) segments.push({ page: null, text: para });
        });
      }
      segments.forEach(function (seg) {
        var low = seg.text.toLowerCase();
        var score = 0;
        var firstHit = -1;
        keys.forEach(function (k2) {
          var idx = low.indexOf(k2);
          if (idx >= 0) {
            score += 1;
            if (firstHit < 0 || idx < firstHit) firstHit = idx;
          }
        });
        if (score <= 0) return;
        var snippet = '';
        if (firstHit >= 0) {
          var s0 = Math.max(0, firstHit - 40);
          snippet = seg.text.slice(s0, s0 + 120).replace(/\s+/g, ' ').trim();
        }
        out.push({
          course: doc.course, lesson: doc.lesson, page: seg.page, kind: doc.base ? 'note' : 'md',
          rel: doc.course + '/' + doc.lesson + '.md',
          text: seg.text.trim().slice(0, 1200), score: score, snippet: snippet,
        });
      });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, Math.max(1, Math.min(Number(topK) || 8, 12)));
  }

  // ---------- 应用内打开：不把系统浏览器拉进任务栈 ----------
  // 安卓 WebView 里，window.open / 指向外站的链接都会被 Capacitor 交给系统浏览器（Chrome），
  // 任务栈里会多出一个浏览器任务——退出 App 时就会落回浏览器界面。
  // App 内统一拦截：本地笔记 → 对应课次的复习页；外部链接 → 应用内小面板（复制链接）。
  if (NATIVE) {
    var isExternalUrl = function (u) {
      return /^https?:\/\//i.test(u) && !/^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(u);
    };

    var injectSheetStyle = function () {
      if (document.getElementById('qzSheetStyle')) return;
      var css = ''
        + '.qz-mask{position:fixed;inset:0;background:var(--mask,rgba(12,16,22,.5));z-index:200;display:flex;align-items:center;justify-content:center;padding:20px}'
        + '.qz-sheet{background:var(--panel,#fff);color:var(--ink,#222);border-radius:14px;max-width:min(560px,92vw);width:100%;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 18px 50px rgba(15,22,36,.3)}'
        + '.qz-sheet-head{padding:12px 16px;font-weight:600;border-bottom:1px solid var(--line,#e3e6ea);display:flex;justify-content:space-between;align-items:center;gap:10px}'
        + '.qz-sheet-body{padding:14px 16px;overflow:auto;font-size:13.5px;line-height:1.7;word-break:break-all}'
        + '.qz-sheet-body pre{white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.7;margin:0}'
        + '.qz-sheet-acts{padding:10px 16px;border-top:1px solid var(--line,#e3e6ea);display:flex;justify-content:flex-end;gap:8px}'
        + '.qz-sheet .btn{border:1px solid var(--line,#d8dce1);background:var(--panel,#fff);color:var(--ink,#222);border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer}'
        + '.qz-sheet .btn.primary{background:var(--brand,#2f6bff);border-color:var(--brand,#2f6bff);color:#fff}';
      var st = document.createElement('style');
      st.id = 'qzSheetStyle';
      st.textContent = css;
      document.head.appendChild(st);
    };

    // 通用小面板：actions = [{text, primary, onClick}]
    var showSheet = function (title, bodyEl, actions) {
      injectSheetStyle();
      var mask = document.createElement('div');
      mask.className = 'qz-mask';
      mask.id = 'qzSheet';
      var sheet = document.createElement('div');
      sheet.className = 'qz-sheet';
      var head = document.createElement('div');
      head.className = 'qz-sheet-head';
      var t = document.createElement('span');
      t.textContent = title;
      var x = document.createElement('button');
      x.className = 'btn';
      x.style.padding = '2px 10px';
      x.textContent = '✕';
      head.appendChild(t);
      head.appendChild(x);
      var body = document.createElement('div');
      body.className = 'qz-sheet-body';
      if (bodyEl) body.appendChild(bodyEl);
      var acts = document.createElement('div');
      acts.className = 'qz-sheet-acts';
      var close = function () { mask.remove(); };
      x.onclick = close;
      mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
      (actions || []).forEach(function (a) {
        var b = document.createElement('button');
        b.className = 'btn' + (a.primary ? ' primary' : '');
        b.textContent = a.text;
        b.onclick = function () { a.onClick ? a.onClick(close) : close(); };
        acts.appendChild(b);
      });
      var plain = document.createElement('button');
      plain.className = 'btn';
      plain.textContent = '关闭';
      plain.onclick = close;
      acts.appendChild(plain);
      sheet.appendChild(head);
      sheet.appendChild(body);
      sheet.appendChild(acts);
      mask.appendChild(sheet);
      document.body.appendChild(mask);
    };

    var showNotePreview = function (rel, url) {
      fetch(url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      }).then(function (text) {
        var pre = document.createElement('pre');
        pre.textContent = text;
        showSheet(rel, pre, []);
      }).catch(function () {
        showSheet(rel, document.createTextNode('读取失败：' + url), []);
      });
    };

    var showLinkSheet = function (u) {
      var wrap = document.createElement('div');
      var p = document.createElement('p');
      p.style.margin = '0 0 8px';
      p.textContent = 'App 内不打开浏览器（会把浏览器任务留在后台）。链接如下，可复制后自行前往：';
      var code = document.createElement('div');
      code.style.userSelect = 'all';
      code.textContent = u;
      wrap.appendChild(p);
      wrap.appendChild(code);
      showSheet('外部链接', wrap, [{
        text: '复制链接',
        primary: true,
        onClick: function (close) {
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(u).then(close).catch(close);
              return;
            }
          } catch (e) { /* 回退手选 */ }
          close();
        },
      }]);
    };

    var openAppUrl = function (u) {
      u = String(u || '').trim();
      if (!u) return;
      var m = u.match(/^(?:https?:\/\/localhost)?\/notes\/(.+?)\.md(?:[?#].*)?$/i);
      if (m) {
        var rel = m[1];
        try { rel = decodeURIComponent(rel); } catch (e) { /* 忽略 */ }
        var parts = rel.split('/').filter(Boolean);
        if (parts.length >= 2 && parts[parts.length - 1] !== parts[parts.length - 2]) {
          location.href = 'review.html?dir=' + encodeURIComponent(rel);
        } else {
          showNotePreview(rel, '/notes/' + rel.split('/').map(encodeURIComponent).join('/') + '.md');
        }
        return;
      }
      if (isExternalUrl(u)) { showLinkSheet(u); return; }
      location.href = u;
    };

    try {
      window.open = function (url) {
        if (url) openAppUrl(url);
        return null;
      };
    } catch (e) { /* 忽略 */ }

    // 捕获阶段拦截外链与笔记链接（含 target=_blank）
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      var href = a.getAttribute('href') || '';
      if (!href || href.charAt(0) === '#') return;
      var abs = a.href || href;
      if (/^\/notes\//i.test(href) || isExternalUrl(abs)) {
        e.preventDefault();
        e.stopPropagation();
        openAppUrl(abs);
      }
    }, true);
  }

  // ---------- 安卓返回手势 / 返回键 ----------
  // @capacitor/app 注册的返回回调在「无 JS 监听者且 WebView 无历史可退」时什么都不做，
  // 会把返回事件吞掉（根页面返回手势退不回桌面，v0.1.1 起引入）。
  // 这里接管：能退历史就退，退不了就退出 App（回到桌面）。
  if (NATIVE) {
    var backTries = 0;
    (function hookBackButton() {
      var AppPlugin = null;
      try { AppPlugin = window.Capacitor.Plugins.App; } catch (e) { /* 忽略 */ }
      if (AppPlugin && AppPlugin.addListener) {
        try {
          var p = AppPlugin.addListener('backButton', function (ev) {
            // 快速路径：事件的 canGoBack 可用时直接后退。
            if (ev && ev.canGoBack) { history.back(); return; }
            // 兜底：部分 WebView 在本 App 的本地服务器场景下 canGoBack 恒为 false（实测 133），
            // 改为「尝试后退 + pagehide 检测」——页面没有开始离开说明已在根页面，则退出到桌面。
            var leaving = false;
            var onHide = function () { leaving = true; };
            window.addEventListener('pagehide', onHide, { once: true });
            try { history.back(); } catch (e) { /* 忽略 */ }
            setTimeout(function () {
              window.removeEventListener('pagehide', onHide);
              if (!leaving && AppPlugin.exitApp) AppPlugin.exitApp();
            }, 350);
          });
          if (p && p.catch) p.catch(function () { /* 忽略 */ });
        } catch (e) { /* 忽略 */ }
        return;
      }
      if (++backTries < 25) setTimeout(hookBackButton, 120);
    })();
  }

  // ---------- IndexedDB ----------
  var DB_NAME = 'qingqu-library';
  var dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'path' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function done(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = resolve;
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error('事务中止')); };
    });
  }

  function reqP(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function store(mode) {
    var db = await openDB();
    return db.transaction('files', mode).objectStore('files');
  }

  async function getFileRecord(path) {
    var st = await store('readonly');
    return reqP(st.get(path));
  }

  async function putFileRecord(rec) {
    var st = await store('readwrite');
    var tx = st.transaction;
    st.put(rec);
    await done(tx);
  }

  async function listFiles(prefix) {
    var st = await store('readonly');
    var range = IDBKeyRange.bound(prefix, prefix + '\uffff');
    return reqP(st.getAll(range));
  }

  async function getMeta(key) {
    var db = await openDB();
    var tx = db.transaction('meta', 'readonly');
    var row = await reqP(tx.objectStore('meta').get(key));
    return row ? row.value : null;
  }

  async function putMeta(key, value) {
    var db = await openDB();
    var tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key: key, value: value });
    await done(tx);
  }

  // ---------- 导入 zip ----------
  var BIN_RE = /\.(jpe?g|png|webp|gif|bmp|pdf|woff2?|ttf|otf|ico)$/i;

  async function importZip(arrayBuffer, pkgName) {
    var zip = await JSZip.loadAsync(arrayBuffer);
    var entries = Object.keys(zip.files).map(function (k) { return zip.files[k]; }).filter(function (e) { return !e.dir; });
    var manifest = null;
    var count = 0;
    var bytes = 0;
    if (zip.file('manifest.json')) {
      try { manifest = JSON.parse(await zip.file('manifest.json').async('string')); } catch (e) { /* 忽略 */ }
    }
    // 先全部解码到内存（JSZip 异步），其间不持有 IndexedDB 事务——
    // 事务内 await 非 IDB 异步操作会让事务提前提交失效（经典坑）。
    var decoded = await Promise.all(entries.map(function (e) {
      if (BIN_RE.test(e.name)) {
        return e.async('blob').then(function (blob) { bytes += blob.size; return { path: e.name, blob: blob }; });
      }
      return e.async('string').then(function (text) { bytes += text.length; return { path: e.name, text: text }; });
    }));
    count = decoded.length;
    var db = await openDB();
    var BATCH = 16;
    for (var i = 0; i < decoded.length; i += BATCH) {
      var slice = decoded.slice(i, i + BATCH);
      var tx = db.transaction('files', 'readwrite');
      var st = tx.objectStore('files');
      slice.forEach(function (rec) {
        if (rec.blob) st.put({ path: rec.path, blob: rec.blob, size: rec.blob.size, updatedAt: Date.now() });
        else st.put({ path: rec.path, text: rec.text, size: rec.text.length, updatedAt: Date.now() });
      });
      await done(tx);
    }
    // 合并目录（从 manifest.courses 构列表）
    if (manifest && Array.isArray(manifest.courses)) {
      var catalog = (await getMeta('catalog')) || { courses: [], importedAt: 0, packages: 0 };
      for (var ci = 0; ci < manifest.courses.length; ci++) {
        var c = manifest.courses[ci];
        var pc = catalog.courses.find(function (x) { return x.name === c.name; });
        if (!pc) { pc = { name: c.name, lessons: [] }; catalog.courses.push(pc); }
        (c.lessons || []).forEach(function (l) {
          var ex = pc.lessons.find(function (x) { return x.name === l.name; });
          if (!ex) {
            ex = { name: l.name, pages: 0, note: false, images: 0 };
            pc.lessons.push(ex);
          }
          // 只接受有意义的字段——记录包（state）的空字段不覆盖内容包信息
          if (l.pages) ex.pages = l.pages;
          if (l.note) ex.note = true;
          if (l.images) ex.images = l.images;
        });
      }
      catalog.importedAt = Date.now();
      catalog.packages = (catalog.packages || 0) + 1;
      catalog.lastPackage = pkgName || '';
      await putMeta('catalog', catalog);
      await putMeta('manifest-last', manifest);
    }
    await putMeta('library-updated', Date.now());
    return { count: count, bytes: bytes, manifest: manifest };
  }

  // ---------- 图片预载（blob URL 缓存） ----------
  var blobCache = new Map();   // 'files:课程/课次/1.jpg' / 'notes:课程/assets/x.png' → blobURL
  var preloaded = new Set();

  function joinKey(kind, p) {
    return kind + ':' + String(p || '').split('/').map(decodeURIComponent).join('/');
  }

  async function preloadLesson(dir) {
    if (!dir || preloaded.has(dir)) return;
    preloaded.add(dir);
    try {
      // 课次课件图：images/{课程}/{课次}/xxx
      var imgs = await listFiles('images/' + dir + '/');
      imgs.forEach(function (rec) {
        var name = rec.path.slice(('images/' + dir + '/').length);
        blobCache.set(joinKey('files', dir + '/' + name), URL.createObjectURL(rec.blob));
      });
      // 笔记目录内的资源（笔记 md 里的图片）：notes/{课程}/...（跨课次安全，量小）
      var courseDir = dir.split('/').slice(0, -1).join('/');
      if (courseDir) {
        var notes = await listFiles('notes/' + courseDir + '/');
        notes.forEach(function (rec) {
          if (rec.blob) {
            var rel = rec.path.slice('notes/'.length);
            blobCache.set(joinKey('notes', rel), URL.createObjectURL(rec.blob));
          }
        });
      }
    } catch (e) { /* 预载失败不阻塞 */ }
  }

  window.QingquFiles = {
    fileUrl: function (p) {
      var hit = blobCache.get(joinKey('files', p));
      if (hit) return hit;
      return '/files/' + String(p || '').split('/').map(encodeURIComponent).join('/');
    },
    noteUrl: function (p) {
      var hit = blobCache.get(joinKey('notes', p));
      if (hit) return hit;
      return '/notes/' + String(p || '').split('/').map(encodeURIComponent).join('/');
    },
  };

  // ---------- 工具 ----------
  function json(obj, status) {
    return new Response(JSON.stringify(obj), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function notFound() {
    return new Response('Not Found', { status: 404 });
  }

  function deskmode(feature) {
    return json({ error: feature + ' 是电脑端功能，App 里暂不提供' }, 501);
  }

  function guessType(p) {
    if (/\.json$/i.test(p)) return 'application/json';
    if (/\.(jpe?g)$/i.test(p)) return 'image/jpeg';
    if (/\.png$/i.test(p)) return 'image/png';
    if (/\.webp$/i.test(p)) return 'image/webp';
    if (/\.css$/i.test(p)) return 'text/css';
    return 'text/markdown; charset=utf-8';
  }

  async function readText(path) {
    var rec = await getFileRecord(path);
    if (!rec) return null;
    if (rec.text != null) return rec.text;
    if (rec.blob) return await rec.blob.text();
    return null;
  }

  async function writeText(path, text) {
    await putFileRecord({ path: path, text: text, size: text.length, updatedAt: Date.now() });
  }

  async function readJson(path, fallback) {
    try {
      var t = await readText(path);
      return t == null ? fallback : JSON.parse(t);
    } catch (e) { return fallback; }
  }

  async function writeJson(path, obj) {
    await writeText(path, JSON.stringify(obj, null, 2));
  }

  function lessonDirOfNotePath(rel) {
    var m = String(rel).match(/^(.+\/[^/]+?)\.(note\.md|md|note\.marks\.json|audit\.json|note\.pdf|pdf|ocr-backup\.md|math-backup\.md)$/);
    return m ? m[1] : null;
  }

  // ---------- 本地 API 路由 ----------
  async function localFetch(u, init) {
    var p = decodeURIComponent(u.pathname);
    var q = u.searchParams;
    var method = (init.method || 'GET').toUpperCase();
    try {
      // 进度
      if (p === '/api/progress') {
        var dir = q.get('dir') || '';
        if (method === 'GET') {
          var prog = await readJson('progress/' + dir + '.json', null);
          return json(prog || { page: 0, updatedAt: 0 });
        }
        if (method === 'PUT') {
          var body = JSON.parse(init.body || '{}');
          var payload = { v: 1, page: Number(body.page) || 0, updatedAt: Date.now() };
          await writeJson('progress/' + dir + '.json', payload);
          return json(Object.assign({ ok: true }, payload));
        }
      }

      // 历史对话
      if (p === '/api/chat-history') {
        var cdir = q.get('dir') || '';
        if (method === 'GET') {
          var chat = await readJson('chats/' + cdir + '.json', { messages: [] });
          return json({ messages: chat.messages || [], count: (chat.messages || []).length });
        }
        if (method === 'POST') {
          var cbody = JSON.parse(init.body || '{}');
          var cur = await readJson('chats/' + cdir + '.json', { v: 1, messages: [] });
          var seen = new Set((cur.messages || []).map(function (m) { return m && m.id; }).filter(Boolean));
          (cbody.messages || []).forEach(function (m) {
            if (!m || (m.id && seen.has(m.id))) return;
            cur.messages = cur.messages || [];
            cur.messages.push(m);
          });
          cur.messages = cur.messages.slice(-2000);
          cur.updatedAt = Date.now();
          await writeJson('chats/' + cdir + '.json', cur);
          return json({ ok: true, count: cur.messages.length });
        }
        if (method === 'DELETE') {
          await writeJson('chats/' + cdir + '.json', { v: 1, messages: [], updatedAt: Date.now() });
          return json({ ok: true });
        }
      }

      // 复习卡
      if (p === '/api/cards') {
        var kdir = q.get('dir') || '';
        if (method === 'GET') {
          var all = [];
          if (kdir) {
            var arr = await readJson('cards/' + kdir + '.json', []);
            all = Array.isArray(arr) ? arr.map(function (c) { return Object.assign({ dir: kdir }, c); }) : [];
          } else {
            var cardFiles = await listFiles('cards/');
            for (var fi = 0; fi < cardFiles.length; fi++) {
              try {
                var one = JSON.parse(cardFiles[fi].text || '[]');
                var krel = cardFiles[fi].path.slice('cards/'.length).replace(/\.json$/i, '');
                (Array.isArray(one) ? one : []).forEach(function (c) { all.push(Object.assign({ dir: krel }, c)); });
              } catch (e) { /* 忽略 */ }
            }
          }
          if (q.get('due') === '1') {
            var now = Date.now();
            all = all.filter(function (c) { return !c.due || c.due <= now; });
          }
          var limit = Number(q.get('limit')) || 0;
          if (limit > 0) all = all.slice(0, limit);
          return json({ cards: all, dueCount: all.length });
        }
        if (method === 'POST') {
          var nb = JSON.parse(init.body || '{}');
          var target = nb.dir || '';
          var cards = await readJson('cards/' + target + '.json', []);
          if (!Array.isArray(cards)) cards = [];
          var nid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          var card = Object.assign({
            id: nid, dir: target, page: null, kind: 'star', text: '', front: '', back: '',
            created: Date.now(), updated: Date.now(), due: Date.now(), interval: 0, ease: 2.5, reps: 0, lapses: 0,
          }, nb, { id: nid, dir: target, created: Date.now(), updated: Date.now() });
          cards.push(card);
          await writeJson('cards/' + target + '.json', cards);
          return json({ ok: true, card: card });
        }
      }
      var gradeMatch = p.match(/^\/api\/cards\/([^/]+)\/grade$/);
      if (gradeMatch && method === 'POST') {
        var gid = decodeURIComponent(gradeMatch[1]);
        var gb = JSON.parse(init.body || '{}');
        var cardFiles2 = await listFiles('cards/');
        for (var gi = 0; gi < cardFiles2.length; gi++) {
          try {
            var gcards = JSON.parse(cardFiles2[gi].text || '[]');
            var gcard = (Array.isArray(gcards) ? gcards : []).find(function (c) { return c.id === gid; });
            if (!gcard) continue;
            var now2 = Date.now();
            var DAY = 86400000;
            if (gb.grade === 'again') { gcard.interval = 0; gcard.ease = Math.max(1.3, (gcard.ease || 2.5) - 0.2); gcard.lapses = (gcard.lapses || 0) + 1; gcard.due = now2 + 10 * 60000; }
            else if (gb.grade === 'easy') { gcard.interval = Math.max(1, Math.round((gcard.interval || 1) * (gcard.ease || 2.5) * 1.4)); gcard.ease = Math.min(3, (gcard.ease || 2.5) + 0.15); gcard.due = now2 + gcard.interval * DAY; }
            else { gcard.interval = Math.max(1, Math.round((gcard.interval || 1) * (gcard.ease || 2.5))); gcard.due = now2 + gcard.interval * DAY; }
            gcard.reps = (gcard.reps || 0) + 1;
            gcard.lastGrade = gb.grade || 'good';
            gcard.updated = now2;
            await writeText(cardFiles2[gi].path, JSON.stringify(gcards, null, 2));
            return json({ ok: true, card: gcard });
          } catch (e) { /* 忽略 */ }
        }
        return notFound();
      }
      var delMatch = p.match(/^\/api\/cards\/([^/]+)$/);
      if (delMatch && method === 'DELETE') {
        var did = decodeURIComponent(delMatch[1]);
        var cardFiles3 = await listFiles('cards/');
        for (var di = 0; di < cardFiles3.length; di++) {
          try {
            var dcards = JSON.parse(cardFiles3[di].text || '[]');
            var before = dcards.length;
            dcards = dcards.filter(function (c) { return c.id !== did; });
            if (dcards.length !== before) {
              await writeText(cardFiles3[di].path, JSON.stringify(dcards, null, 2));
              return json({ ok: true });
            }
          } catch (e) { /* 忽略 */ }
        }
        return notFound();
      }
      if (p === '/api/cards/gen-qa' || p === '/api/cards/feynman') return deskmode('AI 出题 / 费曼卡');
      if (p === '/api/cards/export') return new Response('', { status: 200, headers: { 'Content-Type': 'text/csv' } });

      // 笔记标记
      if (p === '/api/note-marks') {
        var mdir = q.get('dir') || '';
        if (method === 'GET') {
          var marks = await readJson('notes/' + mdir + '.note.marks.json', { marks: [] });
          return json(marks);
        }
        if (method === 'POST') {
          await writeText('notes/' + mdir + '.note.marks.json', init.body || '{}');
          return json({ ok: true });
        }
      }

      // 课次树（课次切换下拉）
      if (p === '/api/courses-tree') {
        var cat = await getMeta('catalog');
        var tree = ((cat && cat.courses) || []).map(function (c) {
          return { name: c.name, lessons: (c.lessons || []).map(function (l) { return l.name; }) };
        });
        return json({ courses: tree });
      }

      // 知识库检索（对话「本课程 / 全库」与全库搜索共用，返回 passages）
      if (p === '/api/kb/search') {
        var sb = {};
        try { sb = JSON.parse(init.body || '{}'); } catch (e) { sb = {}; }
        var passages = await localKbSearch(sb.q, sb.scope || 'all', sb.dir || '', Number(sb.topK) || 8);
        return json({ passages: passages, stats: { matched: passages.length } });
      }

      // AI 对话：App 内直接用配置的 OpenAI 兼容接口提问（原生 HTTP，不受 CORS 限制）
      if (p === '/api/chat') {
        var cb = {};
        try { cb = JSON.parse(init.body || '{}'); } catch (e) { cb = {}; }
        var cfg = getAiConfig();
        var textRsp = function (t) {
          return new Response(t, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        };
        if (!cfg) {
          return textRsp('[错误] 还没配置 AI 接口：点「AI 对话」右上角的「AI 设置」，填写接口地址 / 模型 / API Key 后再提问。');
        }
        try {
          var cr = await httpRequest({
            url: cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer ' + (cfg.apiKey || ''),
            },
            data: { model: cfg.model, messages: cb.messages || [], stream: false },
            responseType: 'json',
            connectTimeout: 20000,
            readTimeout: 120000,
          });
          var cj = cr && cr.data;
          if (!cr || cr.status >= 400) {
            var em = (cj && cj.error && cj.error.message) || ('HTTP ' + (cr && cr.status));
            return textRsp('[错误] ' + em);
          }
          var answer = cj && cj.choices && cj.choices[0] && cj.choices[0].message && cj.choices[0].message.content;
          if (!answer) return textRsp('[错误] 模型没有返回内容');
          return textRsp(String(answer));
        } catch (e) {
          return textRsp('[错误] 请求失败：' + ((e && e.message) || e));
        }
      }

      // 未实现的电脑端功能
      if (p === '/api/llm-jobs' || /^\/api\/llm-jobs\//.test(p)) return deskmode('AI 作业');
      if (p === '/api/note-pdf') return deskmode('笔记 PDF');
      if (p === '/api/preview') return notFound();
      if (p === '/api/backlinks') return json({ backlinks: [] });
      if (p === '/api/graph') return json({ nodes: [], links: [] });
      if (p === '/api/tags') return json({ tags: [] });
      if (p === '/api/note') return json({ note: null });

      // /notes/*：笔记 / 原文 / 审计 / 资源（fetch 读取）
      if (p.indexOf('/notes/') === 0) {
        var nrel = p.slice('/notes/'.length);
        var lessonDir = lessonDirOfNotePath(nrel);
        if (lessonDir) await preloadLesson(lessonDir);
        var nrec = await getFileRecord('notes/' + nrel);
        if (!nrec) return notFound();
        if (nrec.blob) return new Response(nrec.blob, { status: 200, headers: { 'Content-Type': nrec.blob.type || guessType(nrel) } });
        return new Response(nrec.text, { status: 200, headers: { 'Content-Type': guessType(nrel) } });
      }

      return notFound();
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  }

  // ---------- fetch 拦截 ----------
  var origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var pathname = '';
    try { pathname = new URL(url, location.href).pathname; } catch (e) { return origFetch(input, init); }
    if (pathname.indexOf('/api/') === 0 || pathname.indexOf('/notes/') === 0) {
      return localFetch(new URL(url, location.href), init || {});
    }
    return origFetch(input, init);
  };

  // ---------- 对外接口（首页用） ----------
  window.QingquLocal = {
    active: true,
    native: NATIVE,
    importZip: importZip,
    openAiSettings: showAiSettings,
    aiConfigured: function () { return !!getAiConfig(); },
    getCatalog: function () { return getMeta('catalog'); },
    getMeta: getMeta,
    listFiles: listFiles,
    clearAll: async function () {
      var db = await openDB();
      var tx = db.transaction(['files', 'meta'], 'readwrite');
      tx.objectStore('files').clear();
      tx.objectStore('meta').clear();
      await done(tx);
    },
  };
})();
