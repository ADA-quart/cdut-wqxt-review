/* 复习工作台：左 md / 右上课件图 / 右下 AI 对话 + 划词提问 + 知识链 */

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const dir = (params.get('dir') || '').replace(/^\/+|\/+$/g, '');
const dirParts = dir.split('/').filter(Boolean);
const lessonName = dirParts[dirParts.length - 1] || '';
const courseDir = dirParts.slice(0, -1).join('/');
const courseName = dirParts[dirParts.length - 2] || courseDir;

const state = {
  md: '',
  pages: [],        // [{ n, name }] 顺序 = PDF 页序
  pageIndex: 0,
  messages: [],     // [{ role, content, display? }]
  sending: false,
  mdUrl: '',
};

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const fileUrl = (p) => '/files/' + enc(p);
const imgUrl = (name) => fileUrl(`${dir}/${name}`);
// md 文件在 downloads/<课程>/<课次>.md，其中的相对资源（xxx_assets/figures/…）按课程目录解析
const mdBaseUrl = '/files/' + (courseDir ? enc(courseDir) + '/' : '');

/** 把 md 里的相对图片地址改写成 /files/ 下的真实地址 */
function resolveMdAssets(root) {
  root.querySelectorAll('img[src]').forEach((img) => {
    let src = img.getAttribute('src') || '';
    if (!src || /^([a-z][a-z0-9+.-]*:|\/\/|\/|#|data:)/i.test(src)) return;
    try { src = decodeURIComponent(src); } catch { /* 保持原样 */ }
    img.src = mdBaseUrl + enc(src.replace(/^\.\//, ''));
  });
}

// ---------- Markdown 渲染 ----------

function renderMarkdown(text) {
  try {
    return marked.parse(text, { gfm: true, breaks: false });
  } catch {
    return `<pre>${text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre>`;
  }
}

function renderMath(root) {
  if (typeof renderMathInElement !== 'function') return;
  try {
    renderMathInElement(root, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
        { left: '\\[', right: '\\]', display: true },
      ],
      throwOnError: false,
      strict: false,
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
    });
  } catch { /* 公式渲染失败不影响正文 */ }
}

/** 把 [[target|label]] 文本节点替换成可点击的 a.wikilink */
function transformWikilinks(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeValue && node.nodeValue.includes('[[')) nodes.push(node);
  }
  const re = /\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g;
  for (const tn of nodes) {
    const text = tn.nodeValue;
    let last = 0;
    let m;
    let matched = false;
    const frag = document.createDocumentFragment();
    while ((m = re.exec(text))) {
      matched = true;
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement('a');
      a.className = 'wikilink';
      a.dataset.target = m[1].trim();
      a.textContent = (m[2] ?? m[1]).trim();
      a.href = '#';
      frag.appendChild(a);
      last = re.lastIndex;
    }
    if (!matched) continue;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    tn.parentNode.replaceChild(frag, tn);
  }
}

function renderFullMd() {
  const container = $('mdContent');
  container.innerHTML = '';

  const re = /<!-- page (\d+): ([^>]+) -->/g;
  const marks = [];
  let m;
  while ((m = re.exec(state.md))) marks.push({ idx: m.index, end: re.lastIndex, n: Number(m[1]), name: m[2].trim() });

  if (marks.length === 0) {
    container.innerHTML = renderMarkdown(state.md);
  } else {
    const head = state.md.slice(0, marks[0].idx);
    if (head.trim()) {
      const headDiv = document.createElement('div');
      headDiv.className = 'md-head';
      headDiv.innerHTML = renderMarkdown(head);
      container.appendChild(headDiv);
    }
    marks.forEach((mk, i) => {
      const body = state.md.slice(mk.end, i + 1 < marks.length ? marks[i + 1].idx : state.md.length);
      const sec = document.createElement('section');
      sec.className = 'page-sec';
      sec.dataset.page = String(mk.n);
      sec.dataset.img = mk.name;
      sec.id = 'sec-' + mk.n;
      sec.innerHTML = renderMarkdown(body);
      container.appendChild(sec);
    });
  }

  transformWikilinks(container);
  resolveMdAssets(container);
  renderMath(container);
  container.querySelectorAll('a[href^="http"]').forEach((a) => { a.target = '_blank'; a.rel = 'noreferrer'; });
}

// ---------- 课件图片 ----------

function buildPages() {
  const re = /<!-- page (\d+): ([^>]+) -->/g;
  const pages = [];
  let m;
  while ((m = re.exec(state.md))) pages.push({ n: Number(m[1]), name: m[2].trim() });
  state.pages = pages;
}

function renderThumbs() {
  const box = $('thumbs');
  box.innerHTML = '';
  state.pages.forEach((p, i) => {
    const img = document.createElement('img');
    img.src = imgUrl(p.name);
    img.loading = 'lazy';
    img.title = `第 ${p.n} 页 · ${p.name}`;
    img.dataset.index = String(i);
    img.onclick = () => showPage(i);
    box.appendChild(img);
  });
}

function showPage(i) {
  if (!state.pages.length) return;
  const idx = Math.max(0, Math.min(i, state.pages.length - 1));
  state.pageIndex = idx;
  const p = state.pages[idx];

  const stage = $('imgStage');
  stage.innerHTML = '';
  const img = document.createElement('img');
  img.src = imgUrl(p.name);
  img.alt = `第 ${p.n} 页`;
  stage.appendChild(img);

  $('imgCounter').textContent = `${idx + 1}/${state.pages.length}`;
  $('btnRaw').href = imgUrl(p.name);
  $('thumbs').querySelectorAll('img').forEach((el) => {
    el.classList.toggle('current', Number(el.dataset.index) === idx);
  });
  const cur = $('thumbs').querySelector('img.current');
  if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'center' });

  document.querySelectorAll('.page-sec.active').forEach((el) => el.classList.remove('active'));
  const sec = document.querySelector(`.page-sec[data-page="${p.n}"]`);
  if (sec) sec.classList.add('active');
}

function pageIndexByNumber(n) {
  return state.pages.findIndex((p) => p.n === Number(n));
}

function currentSection() {
  const active = document.querySelector('.page-sec.active');
  return active || null;
}

/** 按左侧滚动位置判断"当前正在读的页"（与图片面板是否跟随无关） */
function currentVisibleSection() {
  const scroll = $('mdScroll');
  const top = scroll.scrollTop + 80;
  const secs = [...document.querySelectorAll('.page-sec')];
  let best = null;
  for (const s of secs) {
    if (s.offsetTop <= top) best = s; else break;
  }
  return best || secs[0] || currentSection();
}

// 跟随滚动：左侧滚到哪一节，右侧切到对应页
let followRaf = null;
function onMdScroll() {
  if (!($('followScroll')?.checked)) return;
  if (followRaf) return;
  followRaf = requestAnimationFrame(() => {
    followRaf = null;
    const scroll = $('mdScroll');
    const top = scroll.scrollTop + 80;
    const secs = [...document.querySelectorAll('.page-sec')];
    let best = null;
    for (const s of secs) {
      if (s.offsetTop <= top) best = s; else break;
    }
    if (!best) best = secs[0];
    if (!best) return;
    const n = Number(best.dataset.page);
    if (state.pages[state.pageIndex]?.n === n) return;
    const idx = pageIndexByNumber(n);
    if (idx >= 0) showPage(idx);
  });
}

// ---------- wiki 链接跳转 ----------

function openWikilink(target) {
  const [pathPart, hash] = target.split('#');
  const clean = pathPart.trim();
  const pageMatch = /page=(\d+)/.exec(hash || '');

  // PDF 页码链接 → 切换右侧图片
  if (/\.pdf$/i.test(clean) && pageMatch) {
    const idx = pageIndexByNumber(Number(pageMatch[1]));
    if (idx >= 0) showPage(idx);
    return;
  }
  // 笔记链接
  const note = clean.replace(/\.md$/i, '');
  if (!note) return;
  if (note === courseName) {
    window.open(fileUrl(`${courseDir}/${courseName}.md`), '_blank');
    return;
  }
  if (note.includes('/')) {
    location.href = '/review.html?dir=' + encodeURIComponent(note);
    return;
  }
  location.href = '/review.html?dir=' + encodeURIComponent(`${courseDir}/${note}`);
}

// ---------- AI 对话 ----------

function sectionText(sec) {
  if (!sec) return '';
  return sec.innerText.replace(/\n{3,}/g, '\n\n').trim();
}

function addMessage(role, content, { html = false, error = false, display } = {}) {
  const box = $('chatMsgs');
  const el = document.createElement('div');
  el.className = `msg ${role}${error ? ' error' : ''}`;
  if (html) el.innerHTML = content;
  else el.textContent = content;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  return el;
}

function renderAssistantHtml(text) {
  const div = document.createElement('div');
  div.innerHTML = renderMarkdown(text);
  transformWikilinks(div);
  renderMath(div);
  return div.innerHTML;
}

async function send(text, { display } = {}) {
  const q = String(text || '').trim();
  if (!q || state.sending) return;
  state.sending = true;
  $('btnSend').disabled = true;

  const shown = display ?? q;
  state.messages.push({ role: 'user', content: q, display: shown });
  addMessage('user', shown);

  const bubble = addMessage('assistant', '思考中…');
  let acc = '';
  try {
    const attach = $('attachPage').checked;
    const sec = currentVisibleSection();
    const payload = [];
    const lessonTitle = $('lessonTitle').textContent;
    payload.push({
      role: 'system',
      content: `你是《${lessonTitle}》这门课的复习助手。用中文回答，尽量简洁准确；涉及公式时用 LaTeX（$...$ 或 $$...$$）。`,
    });
    for (const m of state.messages.slice(-13, -1)) {
      payload.push({ role: m.role, content: m.content });
    }
    let userContent = q;
    if (attach && sec) {
      userContent = `【当前页（第 ${sec.dataset.page} 页）OCR 内容，可能有少量错字】\n"""\n${sectionText(sec)}\n"""\n\n${q}`;
    }
    payload.push({ role: 'user', content: userContent });

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: payload, profile: 'text' }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(t.slice(0, 300) || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      acc += decoder.decode(value, { stream: true });
      bubble.textContent = acc;
      $('chatMsgs').scrollTop = $('chatMsgs').scrollHeight;
    }
    acc = acc.trim();
    if (!acc) throw new Error('模型没有返回内容');
    const isError = acc.startsWith('[错误]');
    bubble.innerHTML = isError ? '' : renderAssistantHtml(acc);
    if (isError) {
      bubble.textContent = acc;
      bubble.classList.add('error');
    }
    state.messages.push({ role: 'assistant', content: acc });
  } catch (e) {
    bubble.textContent = '请求失败：' + String(e.message || e);
    bubble.classList.add('error');
  } finally {
    state.sending = false;
    $('btnSend').disabled = false;
    $('chatMsgs').scrollTop = $('chatMsgs').scrollHeight;
  }
}

function quoteToInput(text) {
  const ta = $('chatInput');
  const quoted = String(text).split('\n').map((l) => '> ' + l).join('\n');
  ta.value = (ta.value ? ta.value.replace(/\s*$/, '\n\n') : '') + quoted + '\n\n';
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

// ---------- 划词提问 ----------

function setupSelection() {
  const menu = $('selMenu');
  let lastText = '';

  const inPane = (node) =>
    node && (($('mdPane').contains(node)) || ($('chatPane').contains(node)));

  document.addEventListener('mouseup', (e) => {
    if (menu.contains(e.target)) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel && !sel.isCollapsed ? String(sel).toString().trim() : '';
      if (!text || !sel.rangeCount || !inPane(sel.anchorNode)) {
        menu.hidden = true;
        return;
      }
      lastText = text;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      menu.hidden = false;
      menu.style.left = Math.max(8, Math.min(window.innerWidth - 210, rect.left + rect.width / 2 - 90)) + 'px';
      menu.style.top = Math.max(8, rect.top - 44) + 'px';
    }, 0);
  });

  menu.addEventListener('mousedown', (e) => e.preventDefault());
  menu.querySelector('[data-act="quote"]').onclick = () => { quoteToInput(lastText); menu.hidden = true; };
  menu.querySelector('[data-act="explain"]').onclick = () => {
    menu.hidden = true;
    send(`请解释以下内容（结合课程上下文）：\n\n${lastText}`);
  };
  $('mdScroll').addEventListener('scroll', () => { menu.hidden = true; });
}

// ---------- 知识链 ----------

function collectOutgoing() {
  const out = new Set();
  const re = /\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g;
  let m;
  while ((m = re.exec(state.md))) {
    const target = m[1].split('#')[0].trim().replace(/\.md$/i, '');
    if (!target || /\.pdf$/i.test(target)) continue;
    out.add(target);
  }
  return [...out];
}

function renderOutLinks() {
  const box = $('outLinks');
  const links = collectOutgoing();
  box.innerHTML = '';
  if (links.length === 0) {
    box.innerHTML = '<p class="empty">这篇笔记还没有链接其他笔记。可以点上方「生成课程索引」，把课次串成链。</p>';
    return;
  }
  for (const target of links) {
    const el = document.createElement('div');
    el.className = 'link-item';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = target;
    el.appendChild(name);
    el.onclick = () => openWikilink(target);
    box.appendChild(el);
  }
}

async function loadBacklinks() {
  const box = $('backLinks');
  try {
    const r = await fetch('/api/backlinks?dir=' + encodeURIComponent(dir));
    const data = await r.json();
    const list = data.backlinks || [];
    box.innerHTML = '';
    if (list.length === 0) {
      box.innerHTML = '<p class="empty">还没有别的笔记引用本课。</p>';
      return;
    }
    for (const b of list) {
      const el = document.createElement('div');
      el.className = 'link-item';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = b.name;
      const snip = document.createElement('div');
      snip.className = 'snip';
      snip.textContent = b.snippet;
      el.append(name, snip);
      el.onclick = () => window.open(fileUrl(b.rel), '_blank');
      box.appendChild(el);
    }
  } catch (e) {
    box.innerHTML = `<p class="empty">反链加载失败：${e.message}</p>`;
  }
}

async function generateIndex() {
  if (!courseDir) return;
  try {
    const r = await fetch('/api/index-note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: courseDir }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    alert(`课程索引已生成/更新：${data.rel}\n（共 ${data.lessons} 个课次；在 Obsidian 里就是课程主页）`);
    loadBacklinks();
  } catch (e) {
    alert('生成失败：' + e.message);
  }
}

// ---------- AI：整理重点 / 织知识链 ----------

function toast(msg, ok = true) {
  let el = document.getElementById('rvToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'rvToast';
    el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:24px;z-index:60;background:#252a31;color:#fff;padding:9px 16px;border-radius:8px;font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:70vw;';
    document.body.appendChild(el);
  }
  el.style.background = ok ? '#252a31' : '#d64541';
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.hidden = true; }, 6000);
}

async function runLlmJob(body, { onDone, label } = {}) {
  const r = await fetch('/api/llm-jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  const id = data.job.id;
  toast(`${label}已提交（任务 #${id}），处理中…`);

  const started = Date.now();
  while (true) {
    await new Promise((res) => setTimeout(res, 2500));
    const jr = await fetch(`/api/llm-jobs/${id}`);
    const jd = await jr.json().catch(() => ({}));
    const job = jd.job;
    if (!job) throw new Error('任务状态丢失');
    if (job.status === 'done') return job;
    if (job.status === 'error') throw new Error(job.error || '任务失败');
    if (job.status === 'canceled') throw new Error('任务已取消');
    if (Date.now() - started > 15 * 60 * 1000) throw new Error('任务超时（>15 分钟）');
  }
}

async function reloadMd() {
  const keepPage = state.pageIndex;
  const r = await fetch(state.mdUrl + '?t=' + Date.now());
  if (!r.ok) throw new Error(`重新读取 Markdown 失败：HTTP ${r.status}`);
  state.md = await r.text();
  renderFullMd();
  buildPages();
  renderThumbs();
  if (state.pages.length) showPage(Math.min(keepPage, state.pages.length - 1));
  renderOutLinks();
}

async function handleSummarize() {
  const btn = $('btnSummarize');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '整理中…';
  try {
    await runLlmJob({ op: 'summarize', dir }, { label: '「整理重点」' });
    await reloadMd();
    $('mdScroll').scrollTo({ top: 0, behavior: 'smooth' });
    toast('重点已整理完成，已插入笔记顶部（可在 Obsidian / ima 中直接使用）');
  } catch (e) {
    toast('整理失败：' + String(e.message || e), false);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

async function handleWeave(scope) {
  const btn = scope === 'all' ? $('btnWeaveAll') : $('btnWeaveCourse');
  btn.style.pointerEvents = 'none';
  try {
    const job = await runLlmJob(
      scope === 'all' ? { op: 'weave', scope: 'all' } : { op: 'weave', dir: courseDir },
      { label: scope === 'all' ? '「课程间知识链」' : '「本课程知识链」' },
    );
    await reloadMd();
    loadBacklinks();
    const result = job.result ? `/files/${job.result.split('/').map(encodeURIComponent).join('/')}` : null;
    toast(scope === 'all' ? '课程间知识链已生成（含「知识链.md」总览）' : '本课程知识链已生成（课程索引 + 相关课次）');
    if (result) window.open(result, '_blank');
  } catch (e) {
    toast('生成失败：' + String(e.message || e), false);
  } finally {
    btn.style.pointerEvents = '';
  }
}

// ---------- 分隔条 ----------

function setupSplitters() {
  const drag = (handle, axis, apply) => {
    let last = 0;
    let active = false;
    handle.addEventListener('mousedown', (e) => {
      active = true;
      last = axis === 'x' ? e.clientX : e.clientY;
      document.body.classList.add('dragging');
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!active) return;
      const cur = axis === 'x' ? e.clientX : e.clientY;
      const delta = cur - last;
      last = cur;
      apply(delta);
    });
    window.addEventListener('mouseup', () => {
      if (!active) return;
      active = false;
      document.body.classList.remove('dragging');
      saveLayout();
    });
  };

  drag($('splitV'), 'x', (dx) => {
    const layout = $('layout');
    const w = $('mdPane').getBoundingClientRect().width;
    const total = layout.clientWidth;
    const next = Math.min(total - 340, Math.max(340, w + dx));
    layout.style.gridTemplateColumns = `${next}px 6px 1fr`;
  });

  drag($('splitH'), 'y', (dy) => {
    const col = $('rightCol');
    const h = $('imgPane').getBoundingClientRect().height;
    const total = col.clientHeight;
    const next = Math.min(total - 240, Math.max(160, h + dy));
    col.style.gridTemplateRows = `${next}px 6px 1fr`;
  });

  // 恢复上次布局
  try {
    const saved = JSON.parse(localStorage.getItem('wqppt_review_layout') || 'null');
    if (saved?.col) $('layout').style.gridTemplateColumns = saved.col;
    if (saved?.row) $('rightCol').style.gridTemplateRows = saved.row;
  } catch { /* 忽略 */ }
}

function saveLayout() {
  try {
    localStorage.setItem('wqppt_review_layout', JSON.stringify({
      col: $('layout').style.gridTemplateColumns || '',
      row: $('rightCol').style.gridTemplateRows || '',
    }));
  } catch { /* 忽略 */ }
}

// ---------- 事件绑定 ----------

function setupEvents() {
  $('mdContent').addEventListener('click', (e) => {
    const a = e.target.closest('a.wikilink');
    if (!a) return;
    e.preventDefault();
    openWikilink(a.dataset.target);
  });

  $('btnPrev').onclick = () => showPage(state.pageIndex - 1);
  $('btnNext').onclick = () => showPage(state.pageIndex + 1);
  $('mdScroll').addEventListener('scroll', onMdScroll);

  $('btnSend').onclick = () => {
    const q = $('chatInput').value;
    if (!q.trim()) return;
    $('chatInput').value = '';
    send(q);
  };
  $('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('btnSend').click();
    }
  });
  $('btnClearChat').onclick = () => {
    if (!confirm('清空当前对话？')) return;
    state.messages = [];
    $('chatMsgs').innerHTML = '';
  };

  $('btnCopyMd').onclick = async () => {
    try {
      await navigator.clipboard.writeText(state.md);
      alert('已复制 Markdown 全文（可直接粘贴进 ima / Obsidian）');
    } catch {
      alert('复制失败，请改用「下载 md」');
    }
  };
  $('btnIndex').onclick = generateIndex;
  $('btnSummarize').onclick = handleSummarize;
  $('btnWeaveCourse').onclick = () => handleWeave('course');
  $('btnWeaveAll').onclick = () => handleWeave('all');
  $('btnChain').onclick = () => {
    $('chainDrawer').hidden = false;
    renderOutLinks();
    loadBacklinks();
  };
  $('btnCloseChain').onclick = () => { $('chainDrawer').hidden = true; };

  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (e.key === 'ArrowLeft') showPage(state.pageIndex - 1);
    if (e.key === 'ArrowRight') showPage(state.pageIndex + 1);
  });
}

// ---------- 启动 ----------

(async function init() {
  if (!dir) {
    $('mdContent').innerHTML = '<p class="empty">缺少 dir 参数，请从下载器的课次列表进入「复习」。</p>';
    return;
  }
  $('lessonTitle').textContent = lessonName || dir;
  $('lessonSub').textContent = [courseDir.replace(/\//g, ' · '), '问渠学堂复习工作台'].filter(Boolean).join(' — ');

  state.mdUrl = fileUrl(`${dir}.md`);
  $('linkDownloadMd').href = state.mdUrl;
  $('linkOpenMd').href = state.mdUrl;

  setupSplitters();
  setupEvents();
  setupSelection();

  try {
    const r = await fetch(state.mdUrl);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.md = await r.text();
  } catch (e) {
    $('mdContent').innerHTML = `<p class="empty">读取 Markdown 失败（${e.message}）。<br>如果这个课次还没转过 Markdown，请回下载器先点「转 MD」。</p>`;
    return;
  }

  renderFullMd();
  buildPages();
  renderThumbs();
  if (state.pages.length) showPage(0);
  renderOutLinks();
})();
