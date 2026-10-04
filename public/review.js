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
      const res = await fetch(fileUrl(`${rel}.md`));
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
  if (!s.page) return fileUrl(s.rel);
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
  $('btnGraph').onclick = openGraph;
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
    if (node.type === 'course') window.open(fileUrl(`${node.id}/${node.id}.md`), '_blank');
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
          : fileUrl(p.rel);
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
    const { dueCount } = await r.json();
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
    toast(`${KIND_META[kind].icon} 第 ${page} 页已加入复习队列`);
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
    if (!data.added) { toast('这一页没生成出卡片（内容可能太少）'); return; }
    toast(`🧠 第 ${page} 页已生成 ${data.added} 张问答卡，打开「复习」开始自测`);
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
  const pageParam = Number(params.get('page')) || 0;
  if (state.pages.length) showPage(pageParam > 0 ? Math.min(pageParam, state.pages.length) - 1 : 0);
  if (pageParam > 0) {
    const sec = document.getElementById('sec-' + pageParam);
    if (sec) setTimeout(() => sec.scrollIntoView({ block: 'start' }), 80);
  }
  const blkParam = params.get('blk');
  if (blkParam) setTimeout(() => jumpToBlock(blkParam), 160);
  markCardBadges();
  refreshDueBadge();
  renderOutLinks();
})();
