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
  note: null,     // AI 整理的复习笔记（左栏默认显示它）
  audit: null,    // 质量审计结果（<课次>.audit.json）
  noteMarks: null, // 笔记多色标记 [{i, head, color}]
  view: 'note',   // note | raw
  pages: [],        // [{ n, name }] 顺序 = PDF 页序
  pageIndex: 0,
  messages: [],     // [{ role, content, display? }]
  sending: false,
  chatPending: [],
  mdUrl: '',
};

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
// 阅读进度按课次保存在浏览器本地（对话历史走服务端 <课次>.chat.json）
const pageStoreKey = () => 'wqppt_page:' + dir;
const fileUrl = (p) => '/files/' + enc(p);
const noteUrl = (p) => '/notes/' + enc(p);
const imgUrl = (name) => fileUrl(`${dir}/${name}`);
// md 文件在 downloads/<课程>/<课次>.md，其中的相对资源（xxx_assets/figures/…）按课程目录解析
const mdBaseUrl = '/notes/' + (courseDir ? enc(courseDir) + '/' : '');

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

/**
 * 公式保护：先把 $$...$$ / $...$ 抽成占位符，再交给 markdown 解析。
 * 否则 LaTeX 里的下划线会被当成斜体（E_{{}_{d}} → E_{{}<em>{d}}），
 * 公式被 <em> 劈成多个文本节点，KaTeX 就匹配不到完整的 $$，只能原样显示。
 */
function extractMathSpans(text) {
  const store = [];
  const re = /\$\$([\s\S]+?)\$\$|\$(?!\$)(?!\s)([^$\n]+?)(?<!\s)\$(?!\$)/g;
  const out = String(text).replace(re, (raw, disp, inline) => {
    const display = disp !== undefined;
    const tex = String(display ? disp : inline).trim();
    const token = '@@MATH' + store.length + '@@';
    store.push({ tex: tex, display: display, raw: raw });
    return token;
  });
  return { text: out, store: store };
}

function renderMarkdown(text) {
  const src = String(text == null ? '' : text);
  const parts = src.split(/(```[\s\S]*?```)/g);
  const store = [];
  const tokenized = parts.map((seg, i) => {
    if (i % 2 === 1) return seg;
    const r = extractMathSpans(seg);
    const base = store.length;
    r.store.forEach((item) => store.push(item));
    return r.text.replace(/@@MATH(\d+)@@/g, (m, n) => '@@MATH' + (base + Number(n)) + '@@');
  }).join('');

  let html;
  try {
    html = marked.parse(tokenized, { gfm: true, breaks: false });
  } catch {
    html = '<pre>' + src.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</pre>';
  }

  if (store.length && typeof katex !== 'undefined') {
    html = html.replace(/@@MATH(\d+)@@/g, (m, n) => {
      const item = store[Number(n)];
      if (!item) return m;
      try {
        return katex.renderToString(item.tex, { displayMode: item.display, throwOnError: false, strict: false });
      } catch {
        return '<span class="katex-error math-broken">' + item.raw.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</span>';
      }
    });
  }
  return html;
}

/** KaTeX 解析失败的公式：标红 + 给个说明（原来它会原样吐源码，看着像没渲染） */
function markMathErrors(root) {
  root.querySelectorAll('.katex-error').forEach((el) => {
    el.classList.add('math-broken');
    el.title = '这条公式的 LaTeX 没能解析（多半是 OCR 识别错，比如 \\verb( 、括号不配对）。可以用顶部「修公式」让 AI 试着修。';
  });
  // 没被 KaTeX 接住的裸 $ 块（分隔符错位时会出现）
  root.querySelectorAll('.page-sec, .md-head').forEach((sec) => {
    if (/\$\$/.test(sec.innerText || '')) sec.classList.add('has-raw-math');
  });
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
      const target = m[1].trim();
      // 指向 PPT 页码的链接渲染成小角标（笔记里的引用）
      a.className = /\.pdf#page=\d+/i.test(target) ? 'wikilink pagecite' : 'wikilink';
      a.dataset.target = target;
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

/** 渲染左栏：默认显示 AI 笔记，没有笔记时回落到原文 */
function renderLeftPane() {
  const noteMode = state.view === 'note' && state.note;
  $('tabNote').classList.toggle('active', Boolean(noteMode));
  $('tabRaw').classList.toggle('active', !noteMode);
  $('noteHint').textContent = state.note ? '' : '还没有笔记，点右上「生成笔记」';
  if (!noteMode) { renderFullMd(); return; }
  const container = $('mdContent');
  container.innerHTML = renderMarkdown(state.note);
  transformWikilinks(container);
  hydrateBlockIds(container);
  resolveMdAssets(container);
  markMathErrors(container);
  decorateNote(container);
  applyNoteColors(container);
  applyAuditMarks(container);
  container.querySelectorAll('a[href^="http"]').forEach((a) => { a.target = "_blank"; a.rel = "noreferrer"; });
}

/** 笔记美化：每个小节可折叠 + 顶部生成目录 */
function decorateNote(container) {
  const heads = [...container.querySelectorAll('h3, h2')].filter((h) => h.textContent.trim());
  if (!heads.length) return;
  const titles = heads.map((h) => h.textContent.trim());
  heads.forEach((h, i) => {
    const details = document.createElement('details');
    details.className = 'note-sec';
    details.open = true;
    details.id = 'note-sec-' + (i + 1);
    const summary = document.createElement('summary');
    summary.textContent = titles[i];
    h.replaceWith(details);
    let node = details.nextSibling;
    const move = [];
    while (node && !(node.nodeType === 1 && /^H[23]$/.test(node.tagName))) {
      const next = node.nextSibling;
      move.push(node);
      node = next;
    }
    for (const n of move) details.appendChild(n);
    details.prepend(summary);
  });

  const toc = document.createElement('nav');
  toc.className = 'note-toc';
  toc.innerHTML = '<div class="toc-title">目录（点击跳转，标题可折叠）</div>' +
    titles.map((t, i) => '<a href="#note-sec-' + (i + 1) + '">' + escapeHtml(t) + '</a>').join('');
  const anchor = container.querySelector('blockquote') || container.firstElementChild;
  if (anchor && anchor.nextSibling) container.insertBefore(toc, anchor.nextSibling); else container.prepend(toc);

  toc.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    const target = container.querySelector(a.getAttribute('href'));
    if (!target) return;
    target.open = true;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

async function loadNote() {
  state.note = null;
  try {
    const r = await fetch(noteUrl(`${dir}.note.md`), { cache: 'no-store' });
    if (r.ok) state.note = await r.text();
  } catch { /* 没有就没有 */ }
}

async function loadAudit() {
  state.audit = null;
  try {
    const r = await fetch(noteUrl(`${dir}.audit.json`), { cache: 'no-store' });
    if (r.ok) state.audit = await r.json();
  } catch { /* 没有就没有 */ }
}

async function handleMakeNote() {
  const btn = $('btnMakeNote');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '生成中…';
  try {
    await runLlmJob({ op: 'note', dir }, { label: '「生成笔记」' });
    await loadNote();
    if (state.note) { state.view = 'note'; renderLeftPane(); $('mdScroll').scrollTop = 0; toast('笔记已生成（左栏已切换）'); }
    else toast('笔记生成完成，但没有拿到内容', false);
  } catch (e) {
    toast('生成笔记失败：' + String(e.message || e), false);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

function renderFullMd() {
  const container = $('mdContent');
  container.innerHTML = '';

  // ![[笔记#^块]] → 占位 div，渲染后再异步填充（块引用 / 嵌入）
  const source = state.md.replace(
    /!\[\[([^\]]+)\]\]/g,
    (_m, target) => `\n\n<div class="embed" data-embed="${escapeHtml(String(target).trim())}"></div>\n\n`
  );
  const re = /<!-- page (\d+): ([^>]+) -->/g;
  const marks = [];
  let m;
  while ((m = re.exec(source))) marks.push({ idx: m.index, end: re.lastIndex, n: Number(m[1]), name: m[2].trim() });

  if (marks.length === 0) {
    container.innerHTML = renderMarkdown(source);
  } else {
    const head = source.slice(0, marks[0].idx);
    if (head.trim()) {
      const headDiv = document.createElement('div');
      headDiv.className = 'md-head';
      headDiv.innerHTML = renderMarkdown(head);
      container.appendChild(headDiv);
    }
    marks.forEach((mk, i) => {
      const body = source.slice(mk.end, i + 1 < marks.length ? marks[i + 1].idx : source.length);
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
  hydrateBlockIds(container);
  resolveMdAssets(container);
  renderMath(container);
  markMathErrors(container);
  container.querySelectorAll('a[href^="http"]').forEach((a) => { a.target = '_blank'; a.rel = 'noreferrer'; });
  hydrateEmbeds(container);
}

/** 行尾 ^id → 元素 id=blk-id + 小徽章（Obsidian 块锚点） */
function hydrateBlockIds(root) {
  root.querySelectorAll('p, li, blockquote, h1, h2, h3, h4').forEach((el) => {
    const m = /\s\^([\w-]{2,32})\s*$/.exec(el.textContent || '');
    if (!m) return;
    const id = m[1];
    el.id = 'blk-' + id;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const marker = '^' + id;
      const i = node.nodeValue.lastIndexOf(marker);
      if (i < 0) continue;
      node.nodeValue = node.nodeValue.slice(0, i);
      const span = document.createElement('span');
      span.className = 'block-id';
      span.textContent = marker;
      node.parentNode.insertBefore(span, node.nextSibling);
      break;
    }
  });
}

function jumpToBlock(id) {
  const el = document.getElementById('blk-' + String(id).replace(/^\^/, ''));
  if (!el) return false;
  const sec = el.closest('.page-sec');
  if (sec && sec.dataset.page) showPage(Number(sec.dataset.page) - 1);
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
  return true;
}

/** 渲染 ![[笔记]] / ![[笔记#^块]] 嵌入 */
async function hydrateEmbeds(root) {
  const nodes = [...root.querySelectorAll('.embed[data-embed]')];
  for (const el of nodes) {
    const target = el.dataset.embed;
    const [pathPart, hash = ''] = target.split('#');
    const note = pathPart.trim().replace(/\.md$/i, '');
    const rel = note.includes('/') ? note : `${courseDir}/${note}`;
    try {
      const res = await fetch(noteUrl(`${rel}.md`));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const md = await res.text();
      let text;
      if (hash.startsWith('^')) {
        const id = hash.slice(1);
        const re = new RegExp(`\\s*\\^${id}\\s*$`);
        const line = md.split('\n').find((l) => re.test(l));
        if (!line) throw new Error(`找不到块 ^${id}`);
        text = line.replace(re, '');
      } else {
        text = md.slice(0, 800);
      }
      el.innerHTML =
        `<div class="embed-head">嵌入自 ${escapeHtml(rel)}${hash ? ' ' + escapeHtml(hash) : ''}</div>` +
        `<div class="embed-body">${renderMarkdown(text)}</div>`;
      transformWikilinks(el);
      hydrateBlockIds(el);
      renderMath(el);
    } catch (e) {
      el.innerHTML = `<div class="embed-error">嵌入失败：${escapeHtml(String(e.message || e))}</div>`;
    }
  }
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
  try { localStorage.setItem(pageStoreKey(), String(p.n)); } catch { /* 忽略 */ }

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
/**
 * 阅读线：取滚动视口的中线，只有「跨过中线」的那一页才算当前页。
 * 之前用「顶部 80px」判断，下一页刚露头就会抢走高亮和右侧课件，太早。
 */
function sectionAtReadingLine() {
  const scroll = $('mdScroll');
  const secs = [...document.querySelectorAll('.page-sec')];
  if (!secs.length) return null;
  const box = scroll.getBoundingClientRect();

  // 1) 视口中线落在哪一页 —— 最贴近「我正在看哪一页」
  const center = box.top + box.height * 0.5;
  for (const s of secs) {
    const r = s.getBoundingClientRect();
    if (r.top <= center && r.bottom > center) return s;
  }

  // 2) 没有页跨过中线（页很短）→ 取可见面积最大的那页
  let best = null;
  let bestArea = 0;
  for (const s of secs) {
    const r = s.getBoundingClientRect();
    const area = Math.max(0, Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top));
    if (area > bestArea) { bestArea = area; best = s; }
  }
  return best || secs[0];
}

function currentVisibleSection() {
  return sectionAtReadingLine() || currentSection();
}

// 跟随滚动：左侧滚到哪一节，右侧切到对应页
let followRaf = null;
function onMdScroll() {
  if (!($('followScroll')?.checked)) return;
  if (followRaf) return;
  followRaf = requestAnimationFrame(() => {
    followRaf = null;
    const best = sectionAtReadingLine();
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

  // 块引用 [[#^id]] / [[笔记#^id]]
  if ((hash || '').startsWith('^')) {
    const id = hash.slice(1);
    const note = clean.replace(/\.md$/i, '');
    if (!note || note === lessonName || note === dir) { jumpToBlock(id); return; }
    const rel = note.includes('/') ? note : `${courseDir}/${note}`;
    location.href = `/review.html?dir=${encodeURIComponent(rel)}&blk=${encodeURIComponent(id)}`;
    return;
  }

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
    window.open(noteUrl(`${courseDir}/${courseName}.md`), '_blank');
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

// ---------- 知识库（ima 式「全库问答 + 引用来源」）----------

const SCOPE_LABELS = { lesson: '本课', course: '本课程', all: '全库' };

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function kbSearch(q, scope, topK = 8) {
  const res = await fetch('/api/kb/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, scope, dir, topK }),
  });
  if (!res.ok) throw new Error(`检索失败 HTTP ${res.status}`);
  return res.json();
}

function sourceHref(s) {
  if (!s.page) return noteUrl(s.rel);
  return `/review.html?dir=${encodeURIComponent(`${s.course}/${s.lesson}`)}&page=${s.page}`;
}

/** 把回答里的 [n] 变成可点击的引用角标 */
function decorateCitations(root, sources) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!/\[\d+\]/.test(node.nodeValue)) continue;
    if (node.parentElement?.closest('a, code, pre')) continue;
    targets.push(node);
  }
  for (const node of targets) {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    const re = /\[(\d+)\]/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const n = Number(m[1]);
      const src = sources[n - 1];
      if (!src) { frag.appendChild(document.createTextNode(m[0])); last = re.lastIndex; continue; }
      const a = document.createElement('a');
      a.className = 'cite';
      a.dataset.n = String(n);
      a.href = sourceHref(src);
      a.textContent = m[0];
      frag.appendChild(a);
      last = re.lastIndex;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

function appendSources(bubble, sources) {
  if (!sources.length) return;
  const box = document.createElement('div');
  box.className = 'sources';
  const title = document.createElement('div');
  title.className = 'sources-title';
  title.textContent = `引用来源（${sources.length}）`;
  box.appendChild(title);
  sources.forEach((s, i) => {
    const a = document.createElement('a');
    a.className = 'source';
    a.href = sourceHref(s);
    a.dataset.n = String(i + 1);
    a.innerHTML =
      `<span class="src-idx">[${i + 1}]</span>` +
      `<span class="src-name">${escapeHtml(s.course)} · ${escapeHtml(s.lesson)}${s.page ? ` · 第 ${s.page} 页` : ''}</span>` +
      `<span class="src-snip">${escapeHtml(s.snippet || '')}</span>`;
    box.appendChild(a);
  });
  bubble.appendChild(box);
}

/** 跳到某页：左侧滚动 + 右侧课件翻页 */
function jumpToPage(n) {
  const page = Number(n);
  if (!page || page < 1 || page > state.pages.length) return;
  showPage(page - 1);
  const sec = document.getElementById('sec-' + page);
  if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 消息 id：服务端历史按 id 去重，防重复追加 */
const newMsgId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** 加载该课次的服务端对话历史（<课次>.chat.json） */
async function loadChatHistory() {
  try {
    const r = await fetch('/api/chat-history?dir=' + encodeURIComponent(dir));
    if (!r.ok) return;
    const data = await r.json();
    const arr = Array.isArray(data.messages) ? data.messages : [];
    if (!arr.length) return;
    state.messages = arr;
    renderChatMessages(true);
  } catch { /* 服务端不可用时保持空 */ }
}

/** 聊天区只渲染最近 30 条；更早的完整历史在「历史」抽屉里看 */
function renderChatMessages(scrollBottom = false) {
  const box = $('chatMsgs');
  box.innerHTML = '';
  for (const m of state.messages.slice(-30)) {
    if (!m || typeof m.content !== 'string') continue;
    if (m.role === 'assistant') {
      const el = addMessage('assistant', renderAssistantHtml(m.content), { html: true });
      if (Array.isArray(m.sources) && m.sources.length) {
        try { decorateCitations(el, m.sources); appendSources(el, m.sources); } catch { /* 旧数据不兼容就算了 */ }
      }
    } else if (m.role === 'user') {
      addMessage('user', m.display ?? m.content);
    }
  }
  if (scrollBottom) box.scrollTop = box.scrollHeight;
}

/** 增量把新消息推到服务端；失败时暂存，下一次发送时一起补 */
async function pushChatHistory(msgs) {
  const batch = [...(state.chatPending || []), ...msgs].filter(Boolean);
  if (!batch.length) return;
  try {
    const r = await fetch('/api/chat-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir, messages: batch }),
    });
    state.chatPending = r.ok ? [] : batch.slice(-50);
  } catch {
    state.chatPending = batch.slice(-50);
  }
}

/** 历史抽屉：展示该课次的完整对话 */
function renderHistoryPanel() {
  const box = $('historyBody');
  const arr = state.messages || [];
  $('historyCount').textContent = arr.length ? `共 ${arr.length} 条` : '';
  if (!arr.length) {
    box.innerHTML = '<p class="empty">还没有对话记录。在右下角提问后，这里会保留完整历史。</p>';
    return;
  }
  box.innerHTML = arr.map((m) => {
    const when = m.at ? new Date(m.at).toLocaleString('zh-CN') : '';
    const who = m.role === 'user' ? '你' : 'AI';
    const body = m.role === 'assistant' ? renderAssistantHtml(m.content) : escapeHtml(m.display ?? m.content);
    return `<div class="hist-item ${m.role}"><div class="hist-meta">${who}${when ? ' · ' + when : ''}</div><div class="hist-body">${body}</div></div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}

async function send(text, { display } = {}) {
  const q = String(text || '').trim();
  if (!q || state.sending) return;
  state.sending = true;
  $('btnSend').disabled = true;

  const shown = display ?? q;
  let asstMsg = null;
  const userMsg = { id: newMsgId(), role: 'user', content: q, display: shown, at: Date.now() };
  state.messages.push(userMsg);
  addMessage('user', shown);

  const bubble = addMessage('assistant', '思考中…');
  let acc = '';
  try {
    const scope = $('chatScope').value;
    let sources = [];
    if (scope !== 'lesson') {
      bubble.textContent = '检索知识库…';
      const found = await kbSearch(q, scope, 8);
      sources = found.passages || [];
      bubble.textContent = sources.length ? '思考中…' : '没检索到片段，直接用模型知识回答…';
    }

    const attach = $('attachPage').checked;
    const sec = currentVisibleSection();
    const payload = [];
    const lessonTitle = $('lessonTitle').textContent;
    let sys = `你是《${lessonTitle}》复习工作台的助手（提问范围：${SCOPE_LABELS[scope] || '本课'}）。` +
      '用中文回答，尽量简洁准确；涉及公式时用 LaTeX（$...$ 或 $$...$$）。';
    if (sources.length) {
      sys += '\n\n下面是知识库检索到的片段，编号即出处。要求：\n' +
        '- 优先依据片段回答；引用片段内容时必须在句末标注编号，例如 [1]；\n' +
        '- 片段不足以回答时直接说明，不要编造；用你自己的知识补充时要与片段区分；\n' +
        '- 不要输出片段原文的长段落，用要点归纳。\n\n片段：\n' +
        sources
          .map((s, i) => `[${i + 1}]《${s.course}》${s.lesson}${s.page ? ` 第 ${s.page} 页` : ''}：\n${String(s.text || '').slice(0, 1200)}`)
          .join('\n\n');
    } else if (scope !== 'lesson') {
      sys += '\n\n（知识库没有检索到相关片段，请基于你的知识回答，并在开头说明这不是来自课程资料。）';
    }
    payload.push({ role: 'system', content: sys });
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
    } else {
      decorateCitations(bubble, sources);
      appendSources(bubble, sources);
    }
    asstMsg = { id: newMsgId(), role: 'assistant', content: acc, sources: sources.length ? sources : undefined, at: Date.now() };
    state.messages.push(asstMsg);
  } catch (e) {
    bubble.textContent = '请求失败：' + String(e.message || e);
    bubble.classList.add('error');
  } finally {
    state.sending = false;
    $('btnSend').disabled = false;
    $('chatMsgs').scrollTop = $('chatMsgs').scrollHeight;
    void pushChatHistory([userMsg, asstMsg].filter(Boolean));
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
      el.onclick = () => window.open(noteUrl(b.rel), '_blank');
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
  if (data.job.reused) toast(`${label}已有相同任务在跑（#${id}），直接等这个结果…`);
  else toast(`${label}已提交（任务 #${id}），处理中…`);

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
  await loadNote();
  await loadAudit();
  await loadNoteMarks();
  state.view = state.note ? 'note' : 'raw';
  renderLeftPane();
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
    await runLlmJob({ op: 'summarize', dir }, { label: '「快速摘要」' });
    await reloadMd();
    $('mdScroll').scrollTo({ top: 0, behavior: 'smooth' });
    toast('快速摘要已写入原文顶部（切「原文」可看；生成深度笔记时会自动同步同一份重点）');
  } catch (e) {
    toast('整理失败：' + String(e.message || e), false);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

async function handlePolish() {
  const btn = $('btnPolish');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '校订中…';
  try {
    const job = await runLlmJob({ op: 'polish', dir }, { label: '「校订」' });
    await reloadMd();
    const r = job.resultData || {};
    toast(`校订完成：纠错 ${r.pages || 0} 页（保留原文 ${r.kept || 0} 页），修复公式 ${r.fixed || 0}/${r.broken || 0} 条；备份为 .ocr-backup.md / .math-backup.md`);
  } catch (e) {
    toast('校订失败：' + String(e.message || e), false);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/** 审计结果：把 ⚠️/❌/🔍 徽章贴到左侧笔记的对应条目上 */
function applyAuditMarks(container) {
  const audit = state.audit;
  if (!audit || !Array.isArray(audit.items) || !audit.items.length) return;
  const icon = { partial: '⚠️', unsupported: '❌', figure: '🔍' };
  const lis = [...container.querySelectorAll('li')];
  if (!lis.length) return;
  const stripMath = (s) => String(s || '').replace(/\$\$[\s\S]*?\$\$/g, '').replace(/\$[^$\n]*\$/g, '');
  const norm = (s) => String(s || '').replace(/[^\p{L}\p{N}]+/gu, '');
  // 公式渲染后 KaTeX 的 textContent 会重复（MathML + HTML + 源码），匹配时把公式整块移除
  const liTextOf = (el) => {
    const c = el.cloneNode(true);
    c.querySelectorAll('.katex, .katex-display, .math-broken').forEach((x) => x.remove());
    return c.textContent;
  };
  for (const it of audit.items) {
    const mark = icon[it.verdict];
    if (!mark) continue;
    const head = norm(stripMath(it.text)).slice(0, 10);
    if (!head) continue;
    const li = lis.find((el) => !el.querySelector('.audit-badge') && norm(liTextOf(el)).includes(head));
    if (!li) continue;
    li.classList.add('audit-' + it.verdict);
    const b = document.createElement('span');
    b.className = 'audit-badge';
    b.textContent = mark;
    b.title = (it.fixed ? '已按课件原文自动修正\n' : '') + (it.reason || '');
    li.appendChild(b);
  }
}

/** 渲染审计抽屉内容 */
function renderAuditPanel() {
  const box = $('auditBody');
  const a = state.audit;
  if (!a) {
    box.innerHTML = '<p class="empty">还没有审计结果。点顶部「质量审计」开始。</p>';
    return;
  }
  const cov = a.coverage || {};
  const st = a.stats || {};
  const chips = (list) => (list || []).map((g) =>
    `<button class="audit-chip" data-page="${g.n}" title="${escapeHtml(g.text || '')}">第 ${g.n} 页</button>`).join(' ');
  const label = { partial: '⚠️ 部分支持', unsupported: '❌ 原文不支持', figure: '🔍 需看图核实' };
  const bad = (a.items || []).filter((it) => it.verdict && it.verdict !== 'ok');
  box.innerHTML = [
    `<h4>① 覆盖检查 <span class="muted">（笔记引用了 ${cov.covered === undefined ? '?' : cov.covered} / ${cov.total === undefined ? '?' : cov.total} 页）</span></h4>`,
    (cov.gaps || []).length
      ? `<div class="audit-row"><span class="audit-tag warn">有文字但没进笔记</span><div class="audit-chips">${chips(cov.gaps)}</div></div>`
      : '<p class="audit-ok">✓ 所有有文字的页都进了笔记</p>',
    (cov.picOnly || []).length
      ? `<div class="audit-row"><span class="audit-tag info">图片页，建议翻一眼</span><div class="audit-chips">${chips(cov.picOnly)}</div></div>`
      : '',
    (cov.noText || []).length ? `<p class="audit-skip muted">无实质内容、自动忽略：${cov.noText.map((n) => 'p' + n).join('、')}</p>` : '',
    '<h4>② 忠实度核对 <span class="muted">（逐条对照课件原文）</span></h4>',
    `<div class="audit-stats"><span class="ok">✓ ${st.ok || 0} 条一致</span><span class="warn">⚠️ ${st.partial || 0} 条部分支持</span><span class="bad">❌ ${st.unsupported || 0} 条不支持</span><span class="info">🔍 ${st.figure || 0} 条需看图</span>${st.fixed ? `<span class="ok">✏️ ${st.fixed} 条已按原文修正</span>` : ''}</div>`,
    bad.length
      ? `<div class="audit-items">${bad.map((it) => `
        <div class="audit-item ${it.verdict}${it.fixed ? ' audit-fixed' : ''}" data-page="${(it.pages || [])[0] || ''}">
          <div class="audit-item-head">${label[it.verdict] || it.verdict} <span class="muted">· 第 ${(it.pages || []).join('、')} 页</span>${it.fixed ? ' <span class="audit-tag ok">✏️ 已自动修正</span>' : ''}</div>
          <div class="audit-item-text">${escapeHtml(it.text)}</div>
          ${it.fixed && it.prev ? `<div class="audit-item-reason">修正前：${escapeHtml(it.prev)}</div>` : ''}
          ${it.reason ? `<div class="audit-item-reason">${escapeHtml(it.reason)}</div>` : ''}
        </div>`).join('')}</div>`
      : '<p class="audit-ok">✓ 所有条目都能在课件原文里找到支持</p>',
    (a.knowledge ? [
      `<h4>③ 知识点核对 <span class="muted">（${a.knowledge.covered || 0}/${a.knowledge.total || 0} 条已覆盖）</span></h4>`,
      `<div class="audit-stats"><span class="ok">✅ ${a.knowledge.covered || 0} 覆盖</span><span class="warn">⚠️ ${a.knowledge.partial || 0} 不完整</span><span class="bad">❌ ${a.knowledge.missing || 0} 缺失</span></div>`,
      ((a.knowledge.items || []).filter((k) => k.status !== 'covered').length
        ? `<div class="audit-items">${(a.knowledge.items || []).filter((k) => k.status !== 'covered').map((k) => `
          <div class="audit-item ${k.status === 'missing' ? 'unsupported' : 'partial'}" data-page="${k.page || ''}">
            <div class="audit-item-head">${k.status === 'missing' ? '❌ 笔记没提' : '⚠️ 讲得不完整'} <span class="muted">· 第 ${k.page || '?'} 页</span></div>
            <div class="audit-item-text">${escapeHtml(k.point)}</div>
          </div>`).join('')}</div>`
        : '<p class="audit-ok">✓ 全部知识点在笔记里都有对应内容</p>'),
    ].join('') : ''),

    '<p class="muted audit-note">审计由 AI 辅助，可能有误判，看到 ⚠️/❌ 请点条目跳去核对原文。标了 ✏️ 的条目已按课件原文自动改对（AI 自己的补充内容保留不动，原版备份为 <code>.note-backup.md</code>）。</p>',
  ].join('');
  box.querySelectorAll('.audit-chip[data-page]').forEach((el) => {
    el.onclick = () => { $('auditDrawer').hidden = true; jumpToPage(Number(el.dataset.page)); };
  });
  box.querySelectorAll('.audit-item[data-page]').forEach((el) => {
    el.onclick = () => { if (el.dataset.page) { $('auditDrawer').hidden = true; jumpToPage(Number(el.dataset.page)); } };
  });
}

/** 质量审计：没有结果就跑一次，有结果就打开抽屉 */
async function handleAudit(force) {
  if (state.audit && !force) {
    renderAuditPanel();
    $('auditDrawer').hidden = false;
    return;
  }
  const btn = $('btnAudit');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '审计中…';
  $('auditDrawer').hidden = true;
  try {
    await runLlmJob({ op: 'audit', dir }, { label: '「质量审计」' });
    await loadAudit();
    await loadNote();
    renderLeftPane();
    renderAuditPanel();
    $('auditDrawer').hidden = false;
    const st = (state.audit && state.audit.stats) || {};
    toast(`审计完成：✓ ${st.ok || 0} · ⚠️ ${st.partial || 0} · ❌ ${st.unsupported || 0} · 🔍 ${st.figure || 0}` + (st.fixed ? ` · ✏️ 已修正 ${st.fixed} 条` : ''));
  } catch (e) {
    toast('审计失败：' + String(e.message || e), false);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

// ---------- 笔记多色标记（荧光笔） ----------
const MARK_COLORS = { red: '核心考点', yellow: '要背/公式', green: '已掌握', blue: '存疑待问' };

async function loadNoteMarks() {
  state.noteMarks = null;
  try {
    const r = await fetch(noteUrl(`${dir}.note.marks.json`), { cache: 'no-store' });
    if (!r.ok) return;
    const data = await r.json();
    if (data && Array.isArray(data.marks)) state.noteMarks = data.marks;
  } catch { /* 没有就没有 */ }
}

/** note.md 里的条目行（与渲染后的 li 一一对应） */
function noteLines() {
  return String(state.note || '').split('\n')
    .filter((l) => l.trim().startsWith('- '))
    .map((l) => l.trim().slice(2));
}

/** 条目前 12 个有效字符：用于对账，笔记重生成后旧标记自动失效 */
function markHead(text) {
  return String(text || '')
    .replace(/\$\$[\s\S]*?\$\$/g, '')
    .replace(/\$[^$\n]*\$/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, 12);
}

let markSaveTimer = null;
function scheduleMarksSave() {
  clearTimeout(markSaveTimer);
  markSaveTimer = setTimeout(async () => {
    try {
      await fetch('/api/note-marks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir, marks: state.noteMarks || [] }),
      });
    } catch { /* 静默失败：下次改动会再存一次 */ }
  }, 500);
}

/** 恢复已保存的颜色 + 给每条挂颜色选择器 */
function applyNoteColors(container) {
  const lis = [...container.querySelectorAll('li')];
  const lines = noteLines();
  if (!lis.length || lis.length !== lines.length) return;
  const saved = new Map((state.noteMarks || []).map((m) => [m.i, m]));
  lis.forEach((li, i) => {
    const head = markHead(lines[i]);
    const m = saved.get(i);
    if (m && MARK_COLORS[m.color] && m.head === head) li.classList.add('note-color-' + m.color);
    const picker = document.createElement('span');
    picker.className = 'mark-picker';
    picker.innerHTML = Object.keys(MARK_COLORS)
      .map((c) => `<button type="button" class="mark-dot ${c}" data-color="${c}" title="${MARK_COLORS[c]}（再点一次取消）"></button>`)
      .join('');
    picker.addEventListener('click', (e) => {
      const b = e.target.closest('.mark-dot');
      if (!b) return;
      e.stopPropagation();
      const color = b.dataset.color;
      const off = li.classList.contains('note-color-' + color);
      for (const c of Object.keys(MARK_COLORS)) li.classList.remove('note-color-' + c);
      const arr = (state.noteMarks || []).filter((x) => x.i !== i);
      if (!off) {
        arr.push({ i, head, color });
        li.classList.add('note-color-' + color);
      }
      state.noteMarks = arr.sort((a, b2) => a.i - b2.i);
      scheduleMarksSave();
    });
    li.appendChild(picker);
  });
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

// ---------- 课次导航（课程 / 课次下拉 + 上一节 / 下一节） ----------

async function setupLessonNav() {
  const nav = $('lessonNav');
  let courses = [];
  try {
    const r = await fetch('/api/courses-tree');
    if (r.ok) courses = (await r.json()).courses || [];
  } catch { /* 忽略 */ }
  const cur = courses.find((c) => c.name === courseName);
  if (!cur || !cur.lessons.length) return;

  const courseSel = $('coursePick');
  const lessonSel = $('lessonPick');
  const fill = (sel, items, selected) => {
    sel.innerHTML = '';
    for (const item of items) {
      const o = document.createElement('option');
      o.value = item;
      o.textContent = item;
      sel.appendChild(o);
    }
    if (selected && items.includes(selected)) sel.value = selected;
  };
  fill(courseSel, courses.map((c) => c.name), cur.name);
  fill(lessonSel, cur.lessons, lessonName);

  const go = (c, l) => { location.href = '/review.html?dir=' + encodeURIComponent(`${c}/${l}`); };
  courseSel.onchange = () => {
    const c = courses.find((x) => x.name === courseSel.value);
    if (!c || !c.lessons.length) return;
    fill(lessonSel, c.lessons, c.lessons[0]);
    go(c.name, c.lessons[0]);
  };
  lessonSel.onchange = () => {
    if (lessonSel.value && lessonSel.value !== lessonName) go(cur.name, lessonSel.value);
  };

  const idx = cur.lessons.indexOf(lessonName);
  const prev = $('btnPrevLesson');
  const next = $('btnNextLesson');
  prev.disabled = idx <= 0;
  next.disabled = idx < 0 || idx >= cur.lessons.length - 1;
  prev.onclick = () => { if (idx > 0) go(cur.name, cur.lessons[idx - 1]); };
  next.onclick = () => { if (idx >= 0 && idx < cur.lessons.length - 1) go(cur.name, cur.lessons[idx + 1]); };
  nav.hidden = false;
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

  // 引用角标 / 来源条目：指向本课的按住不发新页面，直接跳页
  $('chatMsgs').addEventListener('click', (e) => {
    const a = e.target.closest('a.cite, a.source');
    if (!a) return;
    let url;
    try { url = new URL(a.href, location.href); } catch { return; }
    if (!url.pathname.endsWith('/review.html')) return;
    const target = url.searchParams.get('dir') || '';
    if (target === dir) {
      e.preventDefault();
      jumpToPage(url.searchParams.get('page') || a.dataset.n);
    }
  });

  const scopeSel = $('chatScope');
  const syncScope = () => {
    const lessonScope = scopeSel.value === 'lesson';
    $('attachPage').disabled = !lessonScope;
    $('attachWrap').style.opacity = lessonScope ? '' : '.45';
    try { localStorage.setItem('wqppt_scope', scopeSel.value); } catch { /* 忽略 */ }
  };
  try {
    const saved = localStorage.getItem('wqppt_scope');
    if (saved && ['lesson', 'course', 'all'].includes(saved)) scopeSel.value = saved;
  } catch { /* 忽略 */ }
  scopeSel.onchange = syncScope;
  syncScope();

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
  $('btnClearChat').onclick = async () => {
    if (!confirm('清空当前对话？（服务端保存的该课次历史也会一起删除）')) return;
    state.messages = [];
    state.chatPending = [];
    $('chatMsgs').innerHTML = '';
    try { await fetch('/api/chat-history?dir=' + encodeURIComponent(dir), { method: 'DELETE' }); } catch { /* 忽略 */ }
    if (!$('historyDrawer').hidden) renderHistoryPanel();
  };
  $('btnHistory').onclick = () => { renderHistoryPanel(); $('historyDrawer').hidden = false; };
  $('btnCloseHistory').onclick = () => { $('historyDrawer').hidden = true; };

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
  $('btnMakeNote').onclick = handleMakeNote;
  $('tabNote').onclick = () => {
    state.view = 'note';
    renderLeftPane();
    try { localStorage.setItem('wqppt_view:' + dir, 'note'); } catch { /* 忽略 */ }
  };
  $('tabRaw').onclick = () => {
    state.view = 'raw';
    renderLeftPane();
    try { localStorage.setItem('wqppt_view:' + dir, 'raw'); } catch { /* 忽略 */ }
  };
  $('btnPolish').onclick = handlePolish;
  $('btnAudit').onclick = () => handleAudit(false);
  $('btnCloseAudit').onclick = () => { $('auditDrawer').hidden = true; };
  $('btnRerunAudit').onclick = () => handleAudit(true);
  $('btnWeaveCourse').onclick = () => handleWeave('course');
  $('btnWeaveAll').onclick = () => handleWeave('all');
  $('btnChain').onclick = () => {
    $('chainDrawer').hidden = false;
    renderOutLinks();
    loadBacklinks();
  };
  $('btnCloseChain').onclick = () => { $('chainDrawer').hidden = true; };
  $('btnGraph').onclick = openGraph;
  $('btnGuide').onclick = () => { $('guideModal').hidden = false; };
  $('btnCloseGuide').onclick = () => { $('guideModal').hidden = true; };
  $('btnMoreHelp').onclick = () => { $('guideModal').hidden = false; };
  $('btnCloseHint').onclick = () => {
    $('hintBar').hidden = true;
    try { localStorage.setItem('wqppt_review_hint', '0'); } catch { /* 忽略 */ }
  };
  $('btnCloseGraph').onclick = () => { $('graphDrawer').hidden = true; };
  $('btnTags').onclick = openTags;
  $('btnCloseTags').onclick = () => { $('tagsDrawer').hidden = true; };
  $('btnQueue').onclick = openQueue;
  $('btnCloseQueue').onclick = () => { $('queueDrawer').hidden = true; };
  $('btnMarkStar').onclick = () => markCurrent('star');
  $('btnMarkWrong').onclick = () => markCurrent('wrong');
  $('btnMarkOk').onclick = () => markCurrent('ok');
  $('btnGenQa').onclick = genQaCurrent;
  $('btnExportMd').onclick = () => window.open('/api/cards/export?format=md', '_blank');
  $('btnCopyCsv').onclick = async () => {
    try {
      const text = await fetch('/api/cards/export?format=csv').then((r) => r.text());
      await navigator.clipboard.writeText(text);
      toast('已复制 CSV，可直接导入 Anki / Excel');
    } catch {
      toast('复制失败，可改用「导出 MD」');
    }
  };
  $('queueBody').addEventListener('click', async (e) => {
    const card = e.target.closest('.q-card');
    if (!card) return;
    const id = card.dataset.id;
    if (e.target.closest('[data-feyn]')) {
      const box = card.querySelector('.q-feyn-box');
      box.hidden = !box.hidden;
      if (!box.hidden) box.querySelector('textarea').focus();
      return;
    }
    if (e.target.closest('[data-feyn-go]')) {
      const box = card.querySelector('.q-feyn-box');
      const answer = box.querySelector('textarea').value.trim();
      if (!answer) { toast('先写一句你的复述'); return; }
      const btn = e.target.closest('[data-feyn-go]');
      btn.disabled = true; btn.textContent = '点评中…';
      try {
        const r = await fetch('/api/cards/feynman', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cardId: id, answer }),
        });
        const v = await r.json();
        if (!r.ok) throw new Error(v.error || ('HTTP ' + r.status));
        const sec = (title, arr, cls) => (arr && arr.length)
          ? `<div class="feyn-sec ${cls}"><b>${title}</b><ul>${arr.map((x) => `<li>${renderAssistantHtml(x)}</li>`).join('')}</ul></div>`
          : '';
        box.insertAdjacentHTML('afterend',
          `<div class="feyn-result">` +
          sec('缺漏', v.missing, 'miss') + sec('不准确', v.wrong, 'wrong') +
          sec('追问', v.followup, 'ask') +
          (!v.missing.length && !v.wrong.length ? '<div class="feyn-sec ok"><b>✓ 表述完整</b></div>' : '') +
          `</div>`);
        box.hidden = true;
      } catch (err) {
        toast('点评失败：' + String(err.message || err));
      }
      btn.disabled = false; btn.textContent = '提交复述';
      return;
    }
    if (e.target.closest('[data-del]')) {
      await fetch('/api/cards/' + encodeURIComponent(id), { method: 'DELETE' });
      await renderQueue();
      return;
    }
    const btn = e.target.closest('[data-g]');
    if (!btn) return;
    btn.disabled = true;
    try {
      const r = await fetch(`/api/cards/${encodeURIComponent(id)}/grade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grade: btn.dataset.g }),
      });
      const data = await r.json();
      toast(`下次复习：${data.card && data.card.interval ? data.card.interval + ' 天后' : '稍后'}`);
    } catch { /* 忽略 */ }
    await renderQueue();
  });

  setupImageViewer();
  setupSearch();
  setupHoverPreview();

  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (e.key === 'ArrowLeft') showPage(state.pageIndex - 1);
    if (e.key === 'ArrowRight') showPage(state.pageIndex + 1);
  });
}

// ---------- 知识图谱（Obsidian 式）----------

let graphData = null;

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** 简易力导向布局：斥力 + 弹簧 + 向心，迭代若干轮（节点几百个以内足够） */
function layoutGraph(nodes, edges, W = 980, H = 660) {
  const n = nodes.length;
  const pos = nodes.map((_, i) => {
    const a = i * 2.399963;
    const r = 80 + (i % 6) * 44;
    return { x: W / 2 + Math.cos(a) * r, y: H / 2 + Math.sin(a) * r, vx: 0, vy: 0 };
  });
  const idx = new Map(nodes.map((node, i) => [node.id, i]));
  const links = edges
    .map((e) => ({ a: idx.get(e.source), b: idx.get(e.target), type: e.type }))
    .filter((e) => e.a !== undefined && e.b !== undefined);

  for (let step = 0; step < 300; step++) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[j].x - pos[i].x;
        let dy = pos[j].y - pos[i].y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const d = Math.sqrt(d2);
        const f = 2600 / d2;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        pos[i].vx -= fx; pos[i].vy -= fy;
        pos[j].vx += fx; pos[j].vy += fy;
      }
    }
    for (const l of links) {
      const A = pos[l.a];
      const B = pos[l.b];
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const target = l.type === 'contain' ? 92 : 165;
      const strength = l.type === 'contain' ? 0.018 : 0.03;
      const f = (d - target) * strength;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      A.vx += fx; A.vy += fy;
      B.vx -= fx; B.vy -= fy;
    }
    for (const p of pos) {
      p.vx += (W / 2 - p.x) * 0.002;
      p.vy += (H / 2 - p.y) * 0.002;
      p.vx *= 0.82; p.vy *= 0.82;
      p.x = Math.max(34, Math.min(W - 34, p.x + Math.max(-18, Math.min(18, p.vx))));
      p.y = Math.max(30, Math.min(H - 30, p.y + Math.max(-18, Math.min(18, p.vy))));
    }
  }
  return pos;
}

function renderGraph({ nodes, edges, stats }) {
  const svg = $('graphSvg');
  svg.innerHTML = '';
  if (!nodes.length) {
    $('graphStats').textContent = '还没有已转 MD 的课次';
    return;
  }
  const W = 980;
  const H = 660;
  const pos = layoutGraph(nodes, edges, W, H);
  // 自适应缩放居中，让小规模图谱也铺得开
  const xs = pos.map((p) => p.x);
  const ys = pos.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const pad = 90;
  const scale = Math.min(
    (W - pad * 2) / Math.max(1, maxX - minX),
    (H - pad * 2) / Math.max(1, maxY - minY),
    2.4
  );
  const ox = (W - (maxX - minX) * scale) / 2 - minX * scale;
  const oy = (H - (maxY - minY) * scale) / 2 - minY * scale;
  for (const p of pos) { p.x = p.x * scale + ox; p.y = p.y * scale + oy; }
  const idx = new Map(nodes.map((node, i) => [node.id, i]));

  const lineLayer = svgEl('g');
  const nodeLayer = svgEl('g');
  svg.appendChild(lineLayer);
  svg.appendChild(nodeLayer);

  for (const e of edges) {
    const a = idx.get(e.source);
    const b = idx.get(e.target);
    if (a === undefined || b === undefined) continue;
    lineLayer.appendChild(svgEl('line', {
      x1: pos[a].x, y1: pos[a].y, x2: pos[b].x, y2: pos[b].y,
      stroke: e.type === 'course' ? '#c9a26b' : '#d7dee8',
      'stroke-width': e.type === 'contain' ? 1 : 1.6,
      'stroke-dasharray': e.type === 'contain' ? '3 4' : '',
    }));
  }

  const go = (node) => {
    if (node.type === 'course') window.open(noteUrl(`${node.id}/${node.id}.md`), '_blank');
    else location.href = '/review.html?dir=' + encodeURIComponent(node.id);
  };

  for (const node of nodes) {
    const i = idx.get(node.id);
    const isCurrent = node.id === dir;
    const isCourse = node.type === 'course';
    const g = svgEl('g', { class: 'graph-node', tabindex: '0' });
    g.style.cursor = 'pointer';
    const circle = svgEl('circle', {
      cx: pos[i].x, cy: pos[i].y,
      r: isCourse ? 13 : isCurrent ? 10.5 : 8,
      fill: isCourse ? '#2f6fed' : isCurrent ? '#ff8a3d' : '#9dbdf5',
      stroke: '#fff', 'stroke-width': 2,
    });
    const title = svgEl('title');
    title.textContent = isCourse ? `课程：${node.label}` : `课次：${node.course} / ${node.label}`;
    const label = svgEl('text', {
      x: pos[i].x, y: pos[i].y - (isCourse ? 18 : 13),
      'text-anchor': 'middle',
      'font-size': isCourse ? 13 : 11,
      'font-weight': isCourse ? 600 : 400,
      fill: isCurrent ? '#c2410c' : '#3a4657',
      'paint-order': 'stroke', stroke: '#fff', 'stroke-width': 3, 'stroke-linejoin': 'round',
    });
    label.textContent = node.label;
    g.appendChild(circle);
    g.appendChild(title);
    g.appendChild(label);
    g.addEventListener('click', () => go(node));
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(node); });
    nodeLayer.appendChild(g);
  }

  $('graphStats').textContent =
    `${stats.courses} 门课 · ${stats.lessons} 个课次 · ${stats.passages} 片段 · ${stats.links} 条关联`;
}

async function openGraph() {
  $('graphDrawer').hidden = false;
  const svg = $('graphSvg');
  if (svg.dataset.ready === '1') return;
  $('graphStats').textContent = '加载中…';
  try {
    if (!graphData) graphData = await fetch('/api/graph').then((r) => r.json());
    renderGraph(graphData);
    svg.dataset.ready = '1';
  } catch (e) {
    $('graphStats').textContent = '加载失败：' + String(e.message || e);
  }
}

// ---------- 标签（Obsidian 式 #tag）----------

async function openTags() {
  const body = $('tagsBody');
  $('tagsDrawer').hidden = false;
  body.innerHTML = '<p class="empty">加载中…</p>';
  try {
    const { tags } = await fetch('/api/tags').then((r) => r.json());
    if (!tags.length) {
      body.innerHTML = '<p class="empty">还没有标签。在 md 里写 #重点、#公式 之类的标记即可（行内任意位置都行）。</p>' +
        '<p class="empty">提示：标题行开头的 # 不会被当成标签。</p>';
      return;
    }
    body.innerHTML = '';
    for (const t of tags) {
      const box = document.createElement('div');
      box.className = 'tag-group';
      const head = document.createElement('div');
      head.className = 'tag-head';
      head.innerHTML = `<span class="tag-chip">#${escapeHtml(t.tag)}</span><span class="tag-count">${t.count} 个课次</span>`;
      box.appendChild(head);
      const links = document.createElement('div');
      links.className = 'links';
      for (const l of t.lessons) {
        const a = document.createElement('a');
        a.className = 'link-item';
        a.href = `/review.html?dir=${encodeURIComponent(l.rel)}`;
        a.innerHTML = `<div class="name">${escapeHtml(l.lesson)}</div><div class="snip">${escapeHtml(l.course)}</div>`;
        links.appendChild(a);
      }
      box.appendChild(links);
      body.appendChild(box);
    }
  } catch (e) {
    body.innerHTML = `<p class="empty">加载失败：${escapeHtml(String(e.message || e))}</p>`;
  }
}

// ---------- 全库搜索（Ctrl+K）----------

function setupSearch() {
  const input = $('searchInput');
  const box = $('searchResults');
  let timer = null;
  let seq = 0;

  const run = async () => {
    const q = input.value.trim();
    if (!q) { box.hidden = true; return; }
    const mine = ++seq;
    box.hidden = false;
    box.innerHTML = '<div class="sr-empty">检索中…</div>';
    try {
      const r = await fetch('/api/kb/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, scope: 'all', topK: 12, smart: true }),
      });
      const data = await r.json();
      if (mine !== seq) return;
      const list = data.passages || [];
      if (!list.length) { box.innerHTML = '<div class="sr-empty">没有匹配的页面</div>'; return; }
      box.innerHTML = '';
      for (const p of list) {
        const a = document.createElement('a');
        a.className = 'sr-item';
        a.href = p.page
          ? `/review.html?dir=${encodeURIComponent(`${p.course}/${p.lesson}`)}&page=${p.page}`
          : noteUrl(p.rel);
        a.innerHTML =
          `<div class="sr-name">${escapeHtml(p.course)} · ${escapeHtml(p.lesson)}${p.page ? ` · 第 ${p.page} 页` : ''}</div>` +
          `<div class="sr-snip">${escapeHtml(p.snippet || '')}</div>`;
        box.appendChild(a);
      }
      if (data.expanded?.length) {
        const hint = document.createElement('div');
        hint.className = 'sr-expanded';
        hint.textContent = '语义扩展：' + data.expanded.join(' · ');
        box.appendChild(hint);
      }
    } catch (e) {
      if (mine === seq) box.innerHTML = `<div class="sr-empty">失败：${escapeHtml(String(e.message || e))}</div>`;
    }
  };

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 350); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(timer); run(); }
    if (e.key === 'Escape') { box.hidden = true; input.blur(); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search-wrap')) box.hidden = true; });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
}

// ---------- 悬浮预览 ----------

function setupHoverPreview() {
  const card = document.createElement('div');
  card.className = 'hover-card';
  card.hidden = true;
  document.body.appendChild(card);
  let showTimer = null;
  let hideTimer = null;
  let want = '';

  const show = async (a) => {
    const target = String(a.dataset.target || '');
    if (/\.pdf(#|$)/i.test(target)) return; // PDF 页链接：不弹笔记预览
    const [pathPart] = target.split('#');
    const note = pathPart.trim().replace(/\.md$/i, '');
    if (!note) return; // [[#^块]] 这类同页引用
    const rel = note.includes('/') ? note : `${courseDir}/${note}`;
    want = rel;
    try {
      const r = await fetch('/api/preview?dir=' + encodeURIComponent(rel));
      if (!r.ok || want !== rel) return;
      const p = await r.json();
      card.innerHTML =
        `<div class="hc-head">${escapeHtml(p.course)} · ${escapeHtml(p.lesson)}</div>` +
        (p.thumb ? `<img class="hc-thumb" src="${p.thumb}" alt="" loading="lazy">` : '') +
        `<div class="hc-body">${escapeHtml(p.summary || '（还没有摘要）')}</div>` +
        `<div class="hc-foot">${p.pages} 页 · 点击打开</div>`;
      const rect = a.getBoundingClientRect();
      card.style.left = Math.max(8, Math.min(window.innerWidth - 340, rect.left)) + 'px';
      card.style.top = Math.min(window.innerHeight - 280, rect.bottom + 8) + 'px';
      card.hidden = false;
    } catch { /* 忽略 */ }
  };
  const hide = () => { want = ''; card.hidden = true; };

  document.addEventListener('mouseover', (e) => {
    const a = e.target.closest('a.wikilink');
    if (!a) return;
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showTimer = setTimeout(() => show(a), 320);
  });
  document.addEventListener('mouseout', (e) => {
    if (!e.target.closest('a.wikilink')) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 280);
  });
  card.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  card.addEventListener('mouseleave', () => { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 160); });
}

// ---------- 复习队列（间隔重复）----------

const KIND_META = {
  star: { icon: '⭐', label: '重点' },
  wrong: { icon: '❓', label: '错题' },
  ok: { icon: '✅', label: '已掌握' },
  qa: { icon: '🧠', label: '问答' },
};

async function refreshDueBadge() {
  try {
    const { dueCount } = await fetch('/api/cards?due=1&limit=1').then((r) => r.json());
    const badge = $('dueBadge');
    badge.textContent = String(dueCount);
    badge.hidden = !dueCount;
    return dueCount;
  } catch {
    return 0;
  }
}

async function markCurrent(kind) {
  const sec = currentVisibleSection();
  if (!sec) { toast('先翻到要标记的那一页'); return; }
  const page = Number(sec.dataset.page);
  const text = (sectionMarkdown(page) || sectionText(sec)).slice(0, 600);
  try {
    const r = await fetch('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir, page, kind, text }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { dueCount, duplicate } = await r.json();
    const badge = $('dueBadge');
    badge.textContent = String(dueCount);
    badge.hidden = !dueCount;
    if (!sec.querySelector('.page-badge')) {
      const b = document.createElement('span');
      b.className = 'page-badge';
      b.textContent = KIND_META[kind].icon;
      b.title = KIND_META[kind].label;
      sec.prepend(b);
    }
    toast(duplicate
      ? '这一页的内容已经在复习队列里，没有重复添加'
      : `${KIND_META[kind].icon} 第 ${page} 页已加入复习队列`);
  } catch (e) {
    toast('标记失败：' + String(e.message || e));
  }
}

/** AI 出题：为当前页生成问答卡并入库 */
async function genQaCurrent() {
  const sec = currentVisibleSection();
  if (!sec) { toast('先翻到要出题的那一页'); return; }
  const page = Number(sec.dataset.page);
  const btn = $('btnGenQa');
  btn.disabled = true; btn.textContent = '出题中…';
  try {
    const r = await fetch('/api/cards/gen-qa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir, page, count: 3 }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    if (!data.added) {
      toast(data.skipped ? '这一页的题目已经在卡里了（没有重复添加）' : '这一页没生成出卡片（内容可能太少）');
      return;
    }
    toast(`🧠 第 ${page} 页已生成 ${data.added} 张问答卡${data.skipped ? `（跳过 ${data.skipped} 张重复）` : ''}，打开「复习」开始自测`);
    await refreshDueBadge();
    await markCardBadges();
  } catch (e) {
    toast('出题失败：' + String(e.message || e));
  } finally {
    btn.disabled = false; btn.textContent = '🧠 出题';
  }
}

/** 从 state.md 里取某页的原始文本（比渲染后的 innerText 干净，公式不会碎） */
function sectionMarkdown(page) {
  const re = /<!-- page (\d+): [^>]+ -->/g;
  const marks = [...state.md.matchAll(re)];
  const i = marks.findIndex((m) => Number(m[1]) === Number(page));
  if (i < 0) return '';
  const start = marks[i].index + marks[i][0].length;
  const end = i + 1 < marks.length ? marks[i + 1].index : state.md.length;
  return state.md.slice(start, end)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function openQueue() {
  $('queueDrawer').hidden = false;
  await renderQueue();
}

async function renderQueue() {
  const body = $('queueBody');
  body.innerHTML = '<p class="empty">加载中…</p>';
  let data;
  try {
    data = await fetch('/api/cards?due=1').then((r) => r.json());
  } catch (e) {
    body.innerHTML = `<p class="empty">加载失败：${escapeHtml(String(e.message || e))}</p>`;
    return;
  }
  const cards = data.cards || [];
  $('queueNote').textContent = cards.length ? `待复习 ${cards.length} 张` : '';
  const badge = $('dueBadge');
  badge.textContent = String(data.dueCount || 0);
  badge.hidden = !data.dueCount;
  if (!cards.length) {
    body.innerHTML = '<p class="empty">今天没有待复习的卡片 🎉<br>在课件右上角用「⭐ 重点 / ❓ 错题 / ✓ 掌握」给页面打标，到期的卡片会出现在这里。</p>';
    return;
  }
  body.innerHTML = '';
  for (const c of cards) {
    const meta = KIND_META[c.kind] || KIND_META.star;
    const [course, lesson] = c.dir.split('/');
    const el = document.createElement('div');
    el.className = 'q-card';
    el.dataset.id = c.id;
    el.innerHTML =
      `<div class="q-head"><span class="q-kind q-${escapeHtml(c.kind)}">${meta.icon} ${meta.label}</span>` +
      `<a class="q-link" href="/review.html?dir=${encodeURIComponent(c.dir)}${c.page ? `&page=${c.page}` : ''}">` +
      `${escapeHtml(course)} · ${escapeHtml(lesson)}${c.page ? ` · 第 ${c.page} 页` : ''}</a></div>` +
      (c.kind === 'qa' && c.front
        ? `<div class="q-text">❓ ${renderAssistantHtml(c.front)}</div>` +
          (c.back ? `<details class="q-details"><summary>显示答案</summary><div class="q-back">${renderAssistantHtml(c.back)}</div></details>` : '') +
          `<div class="q-feyn"><button class="btn tiny" data-feyn="1">我来复述（费曼）</button>` +
          `<div class="q-feyn-box" hidden><textarea rows="2" placeholder="用自己的话讲一遍，AI 对照课件点评缺漏"></textarea>` +
          `<button class="btn tiny primary" data-feyn-go="1">提交复述</button></div></div>`
        : (c.text ? `<div class="q-text">${renderAssistantHtml(c.text.slice(0, 400))}</div>` : '')) +
      `<div class="q-actions">` +
      `<button class="btn tiny" data-g="again">再来一次</button>` +
      `<button class="btn tiny" data-g="hard">有点难</button>` +
      `<button class="btn tiny primary" data-g="good">记住了</button>` +
      `<button class="btn tiny" data-g="easy">太简单</button>` +
      `<button class="btn tiny danger" data-del="1">移除</button>` +
      `</div>`;
    body.appendChild(el);
  }
}

/** 页面上的卡片角标（⭐/❓/✅） */
async function markCardBadges() {
  try {
    const { cards } = await fetch('/api/cards?dir=' + encodeURIComponent(dir)).then((r) => r.json());
    for (const c of cards || []) {
      if (!c.page) continue;
      const sec = document.getElementById('sec-' + c.page);
      if (!sec || sec.querySelector('.page-badge')) continue;
      const b = document.createElement('span');
      b.className = 'page-badge';
      b.textContent = (KIND_META[c.kind] || KIND_META.star).icon;
      b.title = (KIND_META[c.kind] || {}).label || '';
      sec.prepend(b);
    }
  } catch { /* 忽略 */ }
}

// ---------- 启动 ----------

(async function init() {
  if (!dir) {
    $('mdContent').innerHTML = '<p class="empty">缺少 dir 参数，请从下载器的课次列表进入「复习」。</p>';
    return;
  }
  $('lessonTitle').textContent = lessonName || dir;
  $('lessonSub').textContent = [courseDir.replace(/\//g, ' · '), '问渠学堂复习工作台'].filter(Boolean).join(' — ');

  state.mdUrl = noteUrl(`${dir}.md`);
  $('linkDownloadMd').href = state.mdUrl;
  $('linkOpenMd').href = state.mdUrl;

  setupSplitters();
  setupEvents();
  setupSelection();
  void loadChatHistory();
  void setupLessonNav();

  try {
    const r = await fetch(state.mdUrl);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.md = await r.text();
  } catch (e) {
    $('mdContent').innerHTML = `<p class="empty">读取 Markdown 失败（${e.message}）。<br>如果这个课次还没转过 Markdown，请回下载器先点「转 MD」。</p>`;
    return;
  }

  await loadNote();
  await loadAudit();
  await loadNoteMarks();
  let savedView = null;
  try { savedView = localStorage.getItem('wqppt_view:' + dir); } catch { /* 忽略 */ }
  state.view = (savedView === 'raw' || (savedView === 'note' && state.note)) ? savedView : (state.note ? 'note' : 'raw');
  renderLeftPane();
  buildPages();
  renderThumbs();
  const pageParam = Number(params.get('page')) || 0;
  let savedPage = 0;
  if (!pageParam) {
    try { savedPage = Number(localStorage.getItem(pageStoreKey())) || 0; } catch { /* 忽略 */ }
  }
  const initialPage = pageParam > 0 ? pageParam : savedPage;
  if (state.pages.length) {
    const idx = initialPage > 0 ? pageIndexByNumber(initialPage) : -1;
    showPage(idx >= 0 ? idx : 0);
  }
  if (initialPage > 0) {
    const sec = document.getElementById('sec-' + initialPage);
    if (sec) setTimeout(() => sec.scrollIntoView({ block: 'start' }), 80);
  }
  const blkParam = params.get('blk');
  if (blkParam) setTimeout(() => jumpToBlock(blkParam), 160);
  try {
    if (localStorage.getItem('wqppt_review_hint') !== '0') $('hintBar').hidden = false;
  } catch { $('hintBar').hidden = false; }
  markCardBadges();
  refreshDueBadge();
  renderOutLinks();
})();

// ---------- 图片查看器（点击放大 / 滚轮缩放 / 拖拽 / 前后切换）----------

function setupImageViewer() {
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.hidden = true;
  box.innerHTML = `
    <img alt="">
    <div class="lb-bar">
      <button class="btn tiny" data-act="prev">◀ 上一张</button>
      <span class="lb-pos"></span>
      <button class="btn tiny" data-act="next">下一张 ▶</button>
      <button class="btn tiny" data-act="zoomout">−</button>
      <button class="btn tiny" data-act="zoomin">＋</button>
      <button class="btn tiny" data-act="reset">适应</button>
      <button class="btn tiny" data-act="close">关闭 (Esc)</button>
    </div>`;
  document.body.appendChild(box);
  const img = box.querySelector('img');
  const pos = box.querySelector('.lb-pos');
  let list = [];
  let idx = 0;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let drag = null;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const applyT = () => { img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; };
  const show = (i) => {
    if (!list.length) return;
    idx = (i + list.length) % list.length;
    img.src = list[idx];
    scale = 1; tx = 0; ty = 0; applyT();
    pos.textContent = `${idx + 1} / ${list.length}`;
  };
  const open = (items, i) => { if (!items.length) return; list = items; box.hidden = false; show(i); };
  const close = () => { box.hidden = true; img.src = ""; };

  // 点笔记里的图片 → 看整篇文档的图；点右侧课件 → 看整节课的 PPT
  document.addEventListener('click', (e) => {
    const inMd = e.target.closest('#mdContent img');
    if (inMd) {
      const imgs = [...document.querySelectorAll('#mdContent img')].map((el) => el.src);
      open(imgs, imgs.indexOf(inMd.src));
      return;
    }
    const inStage = e.target.closest('#imgStage img');
    if (inStage && state.pages.length) {
      const imgs = state.pages.map((p) => imgUrl(p.name));
      open(imgs, state.pageIndex);
    }
  });

  box.querySelector('.lb-bar').addEventListener('click', (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    if (act === 'prev') show(idx - 1);
    else if (act === 'next') show(idx + 1);
    else if (act === 'zoomin') { scale = clamp(scale * 1.25, 0.2, 8); applyT(); }
    else if (act === 'zoomout') { scale = clamp(scale / 1.25, 0.2, 8); applyT(); }
    else if (act === 'reset') { scale = 1; tx = 0; ty = 0; applyT(); }
    else if (act === 'close') close();
  });
  box.addEventListener('click', (e) => { if (e.target === box) close(); });
  box.addEventListener('wheel', (e) => {
    if (box.hidden) return;
    e.preventDefault();
    scale = clamp(scale * (e.deltaY < 0 ? 1.12 : 0.89), 0.2, 8);
    applyT();
  }, { passive: false });

  img.addEventListener('pointerdown', (e) => {
    if (box.hidden) return;
    drag = { x: e.clientX - tx, y: e.clientY - ty };
    img.setPointerCapture(e.pointerId);
    img.style.cursor = 'grabbing';
  });
  img.addEventListener('pointermove', (e) => {
    if (!drag) return;
    tx = e.clientX - drag.x; ty = e.clientY - drag.y; applyT();
  });
  img.addEventListener('pointerup', () => { drag = null; img.style.cursor = 'grab'; });

  // 捕获阶段拦掉翻页快捷键，避免和课件翻页冲突
  document.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    if (e.key === 'Escape') { close(); e.stopPropagation(); }
    else if (e.key === 'ArrowLeft') { show(idx - 1); e.stopPropagation(); }
    else if (e.key === 'ArrowRight') { show(idx + 1); e.stopPropagation(); }
  }, true);
}
