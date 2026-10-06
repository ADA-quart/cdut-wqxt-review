/* 清渠 — 前端逻辑（零依赖） */

const $ = (id) => document.getElementById(id);
const state = {
  loggedIn: false,
  courses: [],
  termId: '',
  jobs: new Map(),
  mdJobs: new Map(),
  llmJobs: new Map(),
  llmConfig: null,
  mdTool: null,
  subsCache: new Map(),
  selectedCourses: new Set(),
};

// ---------- 工具 ----------

async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

function toast(msg, kind = '') {
  let box = document.querySelector('.toasts');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toasts';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function fmtSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let x = v, i = -1;
  do { x /= 1024; i++; } while (x >= 1024 && i < u.length - 1);
  return (x >= 100 ? x.toFixed(0) : x.toFixed(1)) + ' ' + u[i];
}

function pct(done, total) {
  if (!total) return 0;
  return Math.round((done / total) * 100);
}

// ---------- 登录状态 ----------

async function refreshStatus() {
  try {
    const s = await api('/status');
    state.loggedIn = !!s.loggedIn;
    $('statusDot').className = 'dot ' + (s.loggedIn ? 'online' : 'offline');
    $('statusText').textContent = s.loggedIn
      ? `已登录${s.account ? '：' + s.account : ''}`
      : '未登录';
    $('btnLogin').hidden = s.loggedIn;
    $('btnLogout').hidden = !s.loggedIn;
    updateFlowBar();
    return s;
  } catch (e) {
    $('statusDot').className = 'dot offline';
    $('statusText').textContent = '服务未启动';
    return null;
  }
}

// ---------- 课程列表 ----------

async function loadTerms() {
  const sel = $('termSel');
  try {
    const { terms } = await api('/terms');
    if (!Array.isArray(terms) || terms.length === 0) {
      sel.innerHTML = '<option value="">无学期数据</option>';
      return;
    }
    // 按开始日期倒序（最新在前）
    terms.sort((a, b) => String(b.beginDate || '').localeCompare(String(a.beginDate || '')));
    const prev = state.termId;
    sel.innerHTML = '';
    for (const t of terms) {
      const opt = document.createElement('option');
      opt.value = String(t.id);
      opt.textContent = `${t.label}${t.current ? '（当前）' : ''}`;
      sel.appendChild(opt);
    }
    const current = terms.find((t) => t.current);
    const wanted = prev && terms.some((t) => String(t.id) === String(prev))
      ? String(prev)
      : String(current?.id ?? terms[0].id);
    sel.value = wanted;
    state.termId = wanted;
  } catch (e) {
    sel.innerHTML = '<option value="">学期加载失败</option>';
  }
}

async function loadCourses() {
  const box = $('courseList');
  if (!state.loggedIn) {
    box.innerHTML = '<p class="empty">登录后加载课程列表</p>';
    return;
  }
  box.innerHTML = '<p class="empty">加载中…</p>';
  try {
    const termId = $('termSel').value;
    state.termId = termId;
    const qs = termId ? `term=${encodeURIComponent(termId)}` : 'months=12';
    const { courses } = await api(`/courses?${qs}`);
    state.courses = courses;
    renderCourses();
  } catch (e) {
    box.innerHTML = `<p class="empty">加载失败：${e.message}</p>`;
  }
}

function renderCourses() {
  const box = $('courseList');
  if (state.courses.length === 0) {
    box.innerHTML = '<p class="empty">该时间范围内没有课程</p>';
    return;
  }
  box.innerHTML = '';
  updatePickCount();
  for (const c of state.courses) {
    const el = document.createElement('div');
    el.className = 'course-item';
    const pick = document.createElement('input');
    pick.type = 'checkbox';
    pick.className = 'course-pick';
    pick.title = '勾选后点右上「下载所选」批量下载';
    if (c.delisted) pick.disabled = true;
    pick.checked = state.selectedCourses.has(String(c.courseId));
    pick.onchange = () => {
      if (pick.checked) state.selectedCourses.add(String(c.courseId));
      else state.selectedCourses.delete(String(c.courseId));
      updatePickCount();
    };
    el.appendChild(pick);
    if (c.delisted) el.classList.add('delisted');

    const main = document.createElement('div');
    main.className = 'course-main';

    const title = document.createElement('p');
    title.className = 'course-title';
    title.textContent = c.title;
    title.title = c.title;

    const meta = document.createElement('div');
    meta.className = 'course-meta';
    const bits = [];
    if (c.teacher) bits.push(c.teacher);
    if (c.kkxyName) bits.push(c.kkxyName);
    if (c.courseCode) bits.push(c.courseCode);
    for (const b of bits) {
      const span = document.createElement('span');
      span.textContent = b;
      meta.appendChild(span);
    }
    if (c.delisted) {
      const badge = document.createElement('span');
      badge.className = 'badge delisted';
      badge.textContent = '已下架 · 无 PPT/回放';
      meta.appendChild(badge);
    }

    main.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'course-actions';

    const btnSubs = document.createElement('button');
    btnSubs.className = 'btn';
    btnSubs.textContent = '课次';
    btnSubs.onclick = () => openSubs(c);

    const btnDl = document.createElement('button');
    btnDl.className = 'btn primary';
    btnDl.textContent = '下载';
    if (c.delisted) {
      btnDl.disabled = true;
      btnDl.title = '该课程已下架，没有 PPT 和回放';
    } else {
      btnDl.onclick = () => startCourseJob(c, btnDl);
    }

    actions.append(btnSubs, btnDl);
    el.append(main, actions);
    box.appendChild(el);
  }
}

async function startCourseJob(course, btn) {
  btn.disabled = true;
  btn.textContent = '创建中…';
  try {
    await api('/jobs', { method: 'POST', body: { mode: 'course', courseId: course.courseId, termId: state.termId } });
    toast(`已创建下载任务：${course.title}`, 'ok');
  } catch (e) {
    toast('创建失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '下载';
  }
}

// ---------- 课次弹窗 ----------

async function openSubs(course) {
  $('subsTitle').textContent = course.title;
  $('subsList').innerHTML = '<p class="empty">加载中…</p>';
  $('subsModal').hidden = false;
  try {
    let subs = state.subsCache.get(course.courseId);
    if (!subs) {
      const r = await api(`/courses/${course.courseId}/subs`);
      subs = r.subs;
      state.subsCache.set(course.courseId, subs);
    }
    renderSubs(course, subs);
  } catch (e) {
    $('subsList').innerHTML = `<p class="empty">加载失败：${e.message}</p>`;
  }
}

function renderSubs(course, subs) {
  const box = $('subsList');
  if (subs.length === 0) {
    box.innerHTML = course.delisted
      ? '<p class="empty">该课程已下架，没有 PPT 和回放</p>'
      : '<p class="empty">该课程暂无可下载课次</p>';
    return;
  }
  box.innerHTML = '';
  for (const s of subs) {
    const row = document.createElement('div');
    row.className = 'subs-row';

    const info = document.createElement('div');
    info.className = 'subs-info';

    const t = document.createElement('p');
    t.className = 'subs-title';
    t.textContent = s.title;

    const meta = document.createElement('div');
    meta.className = 'subs-meta';
    const bits = [];
    if (s.lecturerName) bits.push(s.lecturerName);
    if (s.startAt) bits.push(new Date(s.startAt * 1000).toLocaleString('zh-CN', { hour12: false }));
    bits.push(s.hasPlayback ? '录播可用' : '暂未开放');
    meta.textContent = bits.join(' · ');

    info.append(t, meta);

    const actions = document.createElement('div');
    actions.className = 'subs-actions';

    if (s.hasPlayback) {
      const btnPreview = document.createElement('button');
      btnPreview.className = 'btn';
      btnPreview.textContent = '预览图片';
      btnPreview.onclick = () => previewPpt(course.courseId, s, btnPreview);

      const btnDl = document.createElement('button');
      btnDl.className = 'btn primary';
      btnDl.textContent = '下载此课次';
      btnDl.onclick = () => startSubJob(course, s, btnDl);

      actions.append(btnPreview, btnDl);
    } else {
      const badge = document.createElement('span');
      badge.className = 'badge skipped';
      badge.textContent = '暂未开放';
      actions.appendChild(badge);
    }

    row.append(info, actions);
    box.appendChild(row);
  }
}

async function previewPpt(courseId, sub, btn) {
  btn.disabled = true;
  btn.textContent = '查询中…';
  try {
    const { images } = await api(`/subs/${courseId}/${sub.subId}/ppt`);
    toast(`「${sub.title}」共 ${images.length} 张 PPT 图片`, images.length ? 'ok' : '');
    if (images.length) window.open(images[0].url, '_blank');
  } catch (e) {
    toast('查询失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '预览图片';
  }
}

async function startSubJob(course, sub, btn) {
  btn.disabled = true;
  btn.textContent = '创建中…';
  try {
    const force = Boolean($('subsForce') && $('subsForce').checked);
    await api('/jobs', { method: 'POST', body: { mode: 'sub', courseId: course.courseId, subId: sub.subId, termId: state.termId, force } });
    toast(`已创建任务：${course.title} — ${sub.title}${force ? '（强制重下）' : ''}`, 'ok');
  } catch (e) {
    toast('创建失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '下载此课次';
  }
}

// ---------- 任务列表 ----------

function renderJobs() {
  const box = $('jobList');
  const dl = [...state.jobs.values()].map((j) => ({ ...j, kind: 'download' }));
  const md = [...state.mdJobs.values()].map((j) => ({ ...j, kind: 'md' }));
  const llm = [...state.llmJobs.values()].map((j) => ({ ...j, kind: 'llm' }));
  const all = [...dl, ...md, ...llm].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (all.length === 0) {
    box.innerHTML = '<p class="empty">暂无任务</p>';
    return;
  }
  box.innerHTML = '';
  for (const j of all) {
    if (j.kind === 'md') {
      box.appendChild(renderMdJobCard(j));
      continue;
    }
    if (j.kind === 'llm') {
      box.appendChild(renderLlmJobCard(j));
      continue;
    }
    const el = document.createElement('div');
    el.className = 'job';

    const head = document.createElement('div');
    head.className = 'job-head';

    const left = document.createElement('div');
    const title = document.createElement('p');
    title.className = 'job-title';
    title.textContent = `#${j.id} ${j.mode === 'all' ? '全部课程' : j.courseTitles.join('、')}`;

    const stats = document.createElement('div');
    stats.className = 'job-stats';
    stats.textContent = `课次 ${j.stats.done}/${j.stats.total} · 已下载 ${j.stats.images} 张` +
      (j.stats.imagesSkipped ? ` · 跳过 ${j.stats.imagesSkipped} 张（本地已有）` : '') +
      (j.stats.imagesFailed ? ` · 失败 ${j.stats.imagesFailed}` : '');

    left.append(title, stats);

    const right = document.createElement('div');
    const badge = document.createElement('span');
    badge.className = 'badge ' + j.status;
    badge.textContent = statusLabel(j.status);

    const toggle = document.createElement('span');
    toggle.className = 'job-toggle';
    toggle.textContent = '详情';
    toggle.onclick = () => el.querySelector('.task-list').classList.toggle('open');

    right.append(badge, document.createTextNode(' '), toggle);

    if (j.status === 'running' || j.status === 'pending') {
      const cancel = document.createElement('button');
      cancel.className = 'btn danger';
      cancel.textContent = '取消';
      cancel.onclick = async () => {
        await api(`/jobs/${j.id}/cancel`, { method: 'POST' });
      };
      right.append(document.createTextNode(' '), cancel);
    }

    head.append(left, right);

    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('i');
    fill.style.width = pct(j.stats.images, estimateTotal(j)) + '%';
    bar.appendChild(fill);

    const taskList = document.createElement('div');
    taskList.className = 'task-list';
    for (const t of j.tasks) {
      const row = document.createElement('div');
      row.className = 'task-row';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = t.subTitle;
      name.title = t.subTitle;
      const val = document.createElement('span');
      val.textContent = t.status === 'done'
        ? `${t.done} 张${t.forcedClean ? `（清理旧帧 ${t.forcedClean}）` : ''}`
        : t.status === 'error'
          ? (t.error || '失败')
          : t.status === 'skipped'
            ? (t.error || '跳过')
            : t.status === 'running'
              ? `${t.done}/${t.total || '…'}`
              : '等待';
      row.append(name, val);
      taskList.appendChild(row);
    }

    el.append(head, bar, taskList);
    box.appendChild(el);
  }
}

function statusLabel(s) {
  return { pending: '等待中', running: '下载中', done: '已完成', error: '有错误', canceled: '已取消' }[s] || s;
}

function renderMdJobCard(j) {
  const el = document.createElement('div');
  el.className = 'job';

  const head = document.createElement('div');
  head.className = 'job-head';

  const left = document.createElement('div');
  const title = document.createElement('p');
  title.className = 'job-title';
  title.textContent = `#${j.id} 转 Markdown · ${j.title}`;
  const stats = document.createElement('div');
  stats.className = 'job-stats';
  stats.textContent = j.status === 'running'
    ? `进度 ${j.progress.done}/${j.progress.total || '…'}${j.progress.current ? ' · ' + j.progress.current : ''}${j.parallel ? ' · 并行 ' + j.parallel + ' 页' : ''}`
    : j.status === 'done'
      ? `完成：${j.outMd || ''}${j.parallel ? `（并行 ${j.parallel} 页）` : ''}`
      : j.status === 'error'
        ? (j.error || '失败')
        : j.status === 'canceled' ? '已取消' : '排队中…';
  left.append(title, stats);

  const right = document.createElement('div');
  const badge = document.createElement('span');
  badge.className = 'badge ' + j.status + ' md';
  badge.textContent = j.status === 'running' ? '转换中' : statusLabel(j.status);
  right.appendChild(badge);

  if (j.status === 'running' || j.status === 'pending') {
    const cancel = document.createElement('button');
    cancel.className = 'btn danger';
    cancel.textContent = '取消';
    cancel.onclick = async () => {
      try { await api(`/md-jobs/${j.id}/cancel`, { method: 'POST' }); } catch {}
    };
    right.append(document.createTextNode(' '), cancel);
  }
  if (j.status === 'done' && j.outMd) {
    const open = document.createElement('a');
    open.className = 'btn';
    // 打开复习台（渲染好的笔记）；原始 markdown 用文件树里的「原文」
    open.href = '/review.html?dir=' + encodeURIComponent(j.dir || '');
    open.target = '_blank';
    open.textContent = '打开复习台';
    const raw = document.createElement('a');
    raw.className = 'btn';
    raw.href = j.outMdUrl || ('/notes/' + j.outMd.split('/').map(encodeURIComponent).join('/'));
    raw.target = '_blank';
    raw.textContent = '原文';
    right.append(document.createTextNode(' '), raw);
    right.append(document.createTextNode(' '), open);
  }
  if (j.status === 'done' && j.pdf) {
    const openPdf = document.createElement('a');
    openPdf.className = 'btn';
    openPdf.href = j.pdfUrl || ('/notes/' + j.pdf.split('/').map(encodeURIComponent).join('/'));
    openPdf.target = '_blank';
    openPdf.textContent = '打开 PDF';
    right.append(document.createTextNode(' '), openPdf);
  }
  if (j.status === 'done' && j.report) {
    const openReport = document.createElement('a');
    openReport.className = 'btn';
    openReport.href = j.reportUrl || ('/files/' + j.report.split('/').map(encodeURIComponent).join('/'));
    openReport.target = '_blank';
    openReport.textContent = '清洗复核';
    right.append(document.createTextNode(' '), openReport);
  }
  if (j.status === 'done' && j.dir) {
    const review = document.createElement('a');
    review.className = 'btn';
    review.href = '/review.html?dir=' + encodeURIComponent(j.dir);
    review.target = '_blank';
    review.textContent = '复习';
    right.append(document.createTextNode(' '), review);
  }

  head.append(left, right);

  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('i');
  fill.style.width = pct(j.progress.done, j.progress.total) + '%';
  bar.appendChild(fill);

  el.append(head, bar);
  return el;
}

function renderLlmJobCard(j) {
  const el = document.createElement('div');
  el.className = 'job';

  const head = document.createElement('div');
  head.className = 'job-head';

  const left = document.createElement('div');
  const title = document.createElement('p');
  title.className = 'job-title';
  const modeLabel = LLM_FIELDS[j.mode]?.label || '';
  const opLabel = { proofread: '纠错', polish: '校订', summarize: '总结', weave: '知识链', fixmath: '修公式' }[j.op] || j.op;
  title.textContent = `#${j.id} ${opLabel} · ${j.title}${j.op === 'proofread' && modeLabel ? `（${modeLabel}）` : ''}`;
  const stats = document.createElement('div');
  stats.className = 'job-stats';
  const tokenText = j.usage && (j.usage.prompt || j.usage.completion)
    ? ` · tokens ${j.usage.prompt}+${j.usage.completion}`
    : '';
  stats.textContent = j.status === 'running'
    ? `进度 ${j.progress.done}/${j.progress.total || '…'}${j.progress.current ? ' · ' + j.progress.current : ''}${tokenText}`
    : j.status === 'done'
      ? (j.log[j.log.length - 1] || '完成')
      : j.status === 'error'
        ? (j.error || '失败')
        : j.status === 'canceled' ? '已取消' : '排队中…';
  left.append(title, stats);

  const right = document.createElement('div');
  const badge = document.createElement('span');
  badge.className = 'badge ' + j.status + ' llm';
  badge.textContent = j.status === 'running' ? '处理中' : statusLabel(j.status);
  right.appendChild(badge);

  if (j.status === 'running' || j.status === 'pending') {
    const cancel = document.createElement('button');
    cancel.className = 'btn danger';
    cancel.textContent = '取消';
    cancel.onclick = async () => {
      try { await api(`/llm-jobs/${j.id}/cancel`, { method: 'POST' }); } catch {}
    };
    right.append(document.createTextNode(' '), cancel);
  }
  if (j.status === 'done' && j.outMd) {
    const open = document.createElement('a');
    open.className = 'btn';
    open.href = '/review.html?dir=' + encodeURIComponent(j.dir || '');
    open.target = '_blank';
    open.textContent = '打开复习台';
    right.append(document.createTextNode(' '), open);
  }

  head.append(left, right);

  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('i');
  fill.style.width = pct(j.progress.done, j.progress.total) + '%';
  bar.appendChild(fill);

  el.append(head, bar);
  return el;
}

// ---------- LLM 设置 ----------

const LLM_FIELDS = {
  text: { base: 'pTextBaseUrl', model: 'pTextModel', key: 'pTextKey', test: 'testText', btn: 'btnTestText', label: '纯文本' },
  visionCloud: { base: 'pCloudBaseUrl', model: 'pCloudModel', key: 'pCloudKey', test: 'testCloud', btn: 'btnTestCloud', label: '图片上云' },
  visionLocal: { base: 'pLocalBaseUrl', model: 'pLocalModel', key: 'pLocalKey', test: 'testLocal', btn: 'btnTestLocal', label: '图片本地' },
};

/** 模型候选列表 <datalist> 与「拉取模型列表」按钮 */
const LLM_MODEL_UI = {
  text: { list: 'pTextModelList', btn: 'btnModelsText' },
  visionCloud: { list: 'pCloudModelList', btn: 'btnModelsCloud' },
  visionLocal: { list: 'pLocalModelList', btn: 'btnModelsLocal' },
};

async function loadLlmConfig() {
  try {
    state.llmConfig = await api('/llm-config');
  } catch {
    state.llmConfig = null;
  }
  const btn = $('btnLlmConfig');
  if (btn) {
    const mode = state.llmConfig?.defaultMode || 'text';
    const prof = state.llmConfig?.profiles?.[mode];
    btn.title = prof?.hasKey
      ? `默认模式：${LLM_FIELDS[mode]?.label || mode} · ${prof.model}`
      : '未配置 LLM（点此设置）';
    btn.textContent = prof?.hasKey ? 'LLM 设置 ●' : 'LLM 设置';
  }
  return state.llmConfig;
}

function openLlmConfig() {
  const c = state.llmConfig || {};
  for (const [key, f] of Object.entries(LLM_FIELDS)) {
    const p = c.profiles?.[key] || {};
    $(f.base).value = p.baseUrl || '';
    $(f.model).value = p.model || '';
    $(f.key).value = '';
    $(f.key).placeholder = p.hasKey ? `已保存 ${p.apiKeyMasked}（留空不变）` : '留空保持原样';
    $(f.test).textContent = '';
    $(f.test).className = 'test-result';
  }
  $('llmDefaultMode').value = c.defaultMode || 'text';
  $('llmConcurrency').value = String(c.concurrency || 3);
  $('llmModal').hidden = false;
}

function collectLlmForm() {
  const profiles = {};
  for (const [key, f] of Object.entries(LLM_FIELDS)) {
    const prof = { baseUrl: $(f.base).value.trim(), model: $(f.model).value.trim() };
    const k = $(f.key).value;
    if (k) prof.apiKey = k;
    profiles[key] = prof;
  }
  return {
    profiles,
    defaultMode: $('llmDefaultMode').value,
    concurrency: Number($('llmConcurrency').value) || 3,
  };
}

async function saveLlmConfig() {
  try {
    state.llmConfig = await api('/llm-config', { method: 'PUT', body: collectLlmForm() });
    $('llmModal').hidden = true;
    toast('LLM 设置已保存', 'ok');
    await loadLlmConfig();
  } catch (e) {
    toast('保存失败：' + e.message, 'err');
  }
}

/** 拉取该档位的可用模型列表，填进 <datalist>（输入框仍可手填） */
async function fetchLlmModels(key) {
  const f = LLM_FIELDS[key];
  const ui = LLM_MODEL_UI[key];
  const span = $(f.test);
  const btn = $(ui.btn);
  btn.disabled = true;
  span.textContent = '拉取模型列表中…';
  span.className = 'test-result';
  try {
    const body = { profile: key, baseUrl: $(f.base).value.trim() };
    const typedKey = $(f.key).value;
    if (typedKey) body.apiKey = typedKey; // 还没保存时也能先拉一把
    const { models, caps } = await api('/llm-models', { method: 'POST', body });
    const list = $(ui.list);
    list.innerHTML = '';
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m;
      list.appendChild(opt);
    }
    if (models.length) {
      if (!$(f.model).value.trim()) $(f.model).value = models[0];
      const capText = caps && caps.context
        ? ` · 上下文 ${(caps.context / 1024).toFixed(0)}K / 最大输出 ${caps.output ? (caps.output / 1024).toFixed(0) + 'K' : '?'}（${caps.source}）`
        : '';
      span.textContent = `✓ 找到 ${models.length} 个模型：${models.slice(0, 4).join('、')}${models.length > 4 ? '…' : ''}${capText}`;
      span.className = 'test-result ok';
    } else {
      span.textContent = '接口没返回模型，手动填写即可';
      span.className = 'test-result';
    }
  } catch (e) {
    span.textContent = '✗ ' + String(e.message || e).slice(0, 110);
    span.className = 'test-result err';
  } finally {
    btn.disabled = false;
  }
}

async function testLlmProfile(key) {
  const f = LLM_FIELDS[key];
  const span = $(f.test);
  span.textContent = '保存并测试中…';
  span.className = 'test-result';
  try {
    state.llmConfig = await api('/llm-config', { method: 'PUT', body: collectLlmForm() });
    const r = await api('/llm-test', { method: 'POST', body: { profile: key } });
    span.textContent = `✓ ${r.ms}ms：${r.reply}`;
    span.className = 'test-result ok';
  } catch (e) {
    span.textContent = '✗ ' + String(e.message || e).slice(0, 90);
    span.className = 'test-result err';
  }
}

function estimateTotal(job) {
  let total = 0;
  for (const t of job.tasks) total += t.total || 0;
  return total || Math.max(1, job.stats.total);
}

// ---------- 文件树 ----------

/** 课次目录里的图片张数 */
function lessonImgCount(node) {
  return (node.children || []).filter((f) => f.type === 'file' && /\.(jpe?g|png|webp|bmp)$/i.test(f.name)).length;
}

/** 课程节点下的课次目录 */
function courseLessons(node) {
  return (node.children || []).filter((c) =>
    c.type === 'dir' && !c.name.endsWith('_assets') && !c.name.startsWith('_'));
}

/** 批量清洗：对该课程所有含图课次依次做去重预检（串行） */
async function batchCleanCourse(courseNode, btn) {
  const subs = courseLessons(courseNode).filter((c) => lessonImgCount(c) > 0);
  if (!subs.length) { toast('这门课没有已下载的课次', 'err'); return; }
  if (!confirm(`对「${courseNode.name}」的 ${subs.length} 个课次依次做清洗预检？\n每个课次约几十秒，将串行执行。`)) return;
  const old = btn.textContent;
  btn.disabled = true;
  let done = 0;
  try {
    for (const sub of subs) {
      btn.textContent = `清洗 ${done + 1}/${subs.length}…`;
      try {
        const r = await api('/dedup-scan', { method: 'POST', body: { dir: sub.rel } });
        done += 1;
        toast(`${sub.name}：保留 ${r.kept}/${r.total}（移除 ${r.removed}）`, 'ok');
      } catch (e) {
        toast(`${sub.name} 清洗失败：${e.message}`, 'err');
      }
    }
    toast(`批量清洗完成：${done}/${subs.length} 个课次`, 'ok');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
    loadFiles();
  }
}

/** 批量转 MD：只提交还没转过的课次 */
async function batchMdCourse(courseNode, btn) {
  const subs = courseLessons(courseNode).filter((c) => lessonImgCount(c) > 0 && !c.hasMd);
  if (!subs.length) { toast('这门课的课次都已经转过 MD 了', 'err'); return; }
  if (!confirm(`把「${courseNode.name}」尚未转 MD 的 ${subs.length} 个课次加入转换队列？\n（已转过的会自动跳过）`)) return;
  const old = btn.textContent;
  btn.disabled = true;
  let ok = 0;
  try {
    for (const sub of subs) {
      btn.textContent = `提交 ${ok + 1}/${subs.length}…`;
      try { await api('/md-jobs', { method: 'POST', body: { dir: sub.rel } }); ok += 1; } catch { /* 单个失败跳过 */ }
    }
    toast(`已提交 ${ok} 个转 MD 任务（队列串行执行，进度见任务卡片）`, 'ok');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/** 批量生成笔记：对已转 MD 的课次提交 note 任务（队列串行） */
async function batchNoteCourse(courseNode, btn) {
  const subs = courseLessons(courseNode).filter((c) => c.hasMd);
  if (!subs.length) { toast('先转 MD，再生成笔记', 'err'); return; }
  if (!confirm(`对「${courseNode.name}」的 ${subs.length} 个课次生成深度笔记？\n（调用 AI；已有笔记的会复用整理稿缓存，较快）`)) return;
  const old = btn.textContent;
  btn.disabled = true;
  let ok = 0;
  try {
    const mode = state.llmConfig?.defaultMode || 'text';
    for (const sub of subs) {
      btn.textContent = `提交 ${ok + 1}/${subs.length}…`;
      try { await api('/llm-jobs', { method: 'POST', body: { op: 'note', dir: sub.rel, mode } }); ok += 1; } catch { /* 跳过 */ }
    }
    toast(`已提交 ${ok} 个生成笔记任务（队列串行执行，进度见任务卡片）`, 'ok');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

async function loadFiles() {
  const box = $('fileTree');
  try {
    const { tree } = await api('/files');
    // 统计「有几次课 / 几次已转 MD」，用于流程条提示
    const lessons = [];
    for (const course of tree) {
      if (course.type !== 'dir') continue;
      for (const child of course.children || []) {
        if (child.type === 'dir' && !child.name.endsWith('_assets') && !child.name.startsWith('_')
          && Array.isArray(child.children) && child.children.some((f) => f.type === 'file' && /\.(jpe?g|png)$/i.test(f.name))) {
          lessons.push(child);
        }
      }
    }
    state.flow = { lessons: lessons.length, withMd: lessons.filter((l) => l.hasMd).length };
    updateFlowBar();
    if (tree.length === 0) {
      box.innerHTML = state.loggedIn
        ? '<p class="empty">还没有下载任何课件。<br>在左边选一门课，点「下载」整门，或点「课次」只挑一次课。</p>'
        : '<p class="empty">还没有下载任何课件。<br>先点右上角「登录」，再到左边选一门课点「下载」。</p>';
      return;
    }
    box.innerHTML = '';
    box.appendChild(renderTree(tree));
  } catch (e) {
    box.innerHTML = `<p class="empty">加载失败：${e.message}</p>`;
  }
}

function renderTree(nodes) {
  return renderTreeLevel(nodes, 1);
}

function renderTreeLevel(nodes, level) {
  const root = document.createElement('div');
  root.className = 'tree';
  for (const node of nodes) {
    if (node.type === 'dir') {
      const details = document.createElement('details');
      details.className = `dir lvl-${Math.min(level, 2)}`;
      const summary = document.createElement('summary');
      const label = document.createElement('span');
      label.className = 'tree-name';
      label.textContent = (level === 1 ? '📚 ' : '🗂 ') + node.name;
      summary.appendChild(label);
      // 课程层：批量操作（清洗 / 转 MD / 生成笔记）
      if (level === 1 && (node.children || []).some((c) => c.type === 'dir')) {
        const mk = (text, title, fn) => {
          const b = document.createElement('button');
          b.className = 'btn tiny';
          b.textContent = text;
          b.title = title;
          b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(node, b); };
          summary.appendChild(b);
        };
        mk('批量清洗', '对这门课所有已下载课次依次做去重预检（串行，每节约几十秒）', batchCleanCourse);
        mk('批量转 MD', '把这门课里还没转过的课次批量加入转换队列（已转的自动跳过）', batchMdCourse);
        mk('批量生成笔记', '对所有已转 MD 的课次生成深度笔记（队列串行；已有笔记走整理稿缓存）', batchNoteCourse);
      }
      // 目录内直接含图片（= 一个课次）→ 提供「转 Markdown」
      const kids = node.children || [];
      const hasImages = kids.some((c) => c.type === 'file' && /\.(jpe?g|png|webp|bmp)$/i.test(c.name));
      if (hasImages) {
        const clean = document.createElement('button');
        clean.className = 'btn tiny';
        clean.textContent = '清洗';
        clean.title = '先做去重预检：生成「前一帧/被删帧/后一帧」复核页，可勾选恢复';
        clean.onclick = (e) => { e.preventDefault(); e.stopPropagation(); startDedupScan(node, clean); };
        summary.appendChild(clean);

        const btn = document.createElement('button');
        btn.className = 'btn tiny';
        btn.textContent = node.hasMd ? '重新转 MD' : '转 MD';
        btn.title = state.mdTool && !state.mdTool.available ? state.mdTool.hint : '把这些图片转成带公式的 Markdown';
        btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); startMdJob(node, btn); };
        summary.appendChild(btn);
      }
      if (node.hasMd) {
        const review = document.createElement('button');
        review.className = 'btn tiny';
        review.textContent = '复习';
        review.title = '打开复习工作台：左看笔记 / 右上翻课件 / 右下问 AI';
        review.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          window.open('/review.html?dir=' + encodeURIComponent(node.rel), '_blank');
        };
        summary.appendChild(review);

        const proof = document.createElement('button');
        proof.className = 'btn tiny';
        proof.textContent = '校订';
        proof.title = '一次完成：OCR 错字纠错 + 修复 KaTeX 解析不了的公式（分别备份 .ocr-backup.md / .math-backup.md）';
        proof.onclick = (e) => { e.preventDefault(); e.stopPropagation(); startLlmJob(node, 'polish', proof); };
        summary.appendChild(proof);

      }
      // 有复核页时给个入口（辅助文件本身不上树）
      if (node.hasDedup) {
        const report = document.createElement('button');
        report.className = 'btn tiny';
        report.textContent = '复核';
        report.title = '打开清洗复核页：把误删的帧拉回来';
        report.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          window.open('/files/' + node.rel.split('/').map(encodeURIComponent).join('/') + '.dedup.html', '_blank');
        };
        summary.appendChild(report);
      }
      // 删除课次（移到回收站，可恢复）
      if (hasImages || node.hasMd) {
        const del = document.createElement('button');
        del.className = 'btn tiny danger';
        del.textContent = '删除';
        del.title = '把这个课次移到回收站（可恢复，设置里能找回）';
        del.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openDeleteModal(node); };
        summary.appendChild(del);
      }
      details.appendChild(summary);
      if (kids.length) details.appendChild(renderTreeLevel(kids, level + 1));
      root.appendChild(details);
    } else if (/\.md$/i.test(node.name)) {
      const row = document.createElement('div');
      row.className = 'file-row';
      const a = document.createElement('a');
      a.href = node.url;
      a.target = '_blank';
      a.textContent = '📄 ' + node.name;
      a.title = '打开 Markdown';
      row.appendChild(a);
      root.appendChild(row);
    } else if (/\.(jpe?g|png|webp|bmp)$/i.test(node.name)) {
      const fig = document.createElement('figure');
      fig.className = 'thumb';
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = node.url;
      img.alt = node.name;
      const cap = document.createElement('figcaption');
      cap.textContent = node.name.replace(/\.jpg$/, '');
      fig.append(img, cap);
      root.appendChild(fig);
    } else {
      const row = document.createElement('div');
      row.className = 'file-row';
      const a = document.createElement('a');
      a.href = node.url;
      a.target = '_blank';
      a.textContent = (/\.pdf$/i.test(node.name) ? '📕 ' : '📎 ') + node.name;
      row.appendChild(a);
      root.appendChild(row);
    }
  }
  return root;
}

async function startMdJob(node, btn) {
  if (!node.rel) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    const dedup = $('dedupChk') ? $('dedupChk').checked : true;
    const r = await api('/md-jobs', { method: 'POST', body: { dir: node.rel, dedup } });
    if (r.job && r.job.reused) {
      toast(`「${node.name}」已有转换任务在跑（#${r.job.id}），等它出结果就行`, 'ok');
    } else {
      toast(`已提交转换：${node.name}${dedup ? '（自动去重）' : ''}`, 'ok');
    }
  } catch (e) {
    toast('转换提交失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function startDedupScan(node, btn) {
  if (!node.rel) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '分析中…';
  try {
    const r = await api('/dedup-scan', { method: 'POST', body: { dir: node.rel } });
    toast(`清洗预检：保留 ${r.kept}/${r.total}，移除 ${r.removed}（已恢复 ${r.restored}）`, 'ok');
    window.open(r.report, '_blank');
  } catch (e) {
    toast('清洗预检失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function startLlmJob(node, op, btn) {
  if (!node.rel) return;
  const cfg = state.llmConfig;
  const mode = cfg?.defaultMode || 'text';
  if (!cfg?.profiles?.[mode]?.hasKey) {
    toast(`请先在「LLM 设置」里配置「${LLM_FIELDS[mode]?.label || mode}」的 API Key`, 'err');
    openLlmConfig();
    return;
  }
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    const r = await api('/llm-jobs', { method: 'POST', body: { op, dir: node.rel, mode } });
    const label = op === 'polish' ? '校订' : op === 'proofread' ? '纠错' : '总结';
    if (r.job && r.job.reused) {
      toast(`${node.name} 的「${label}」已在跑（#${r.job.id}），等它完成就行`, 'ok');
    } else {
      toast(`已提交${label}：${node.name}（${LLM_FIELDS[mode]?.label || mode}）`, 'ok');
    }
  } catch (e) {
    toast('提交失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ---------- 事件绑定 ----------

$('btnLogin').onclick = () => {
  $('loginModal').hidden = false;
  $('inpUser').focus();
};

$('btnCancelLogin').onclick = () => { $('loginModal').hidden = true; };

$('btnDoLogin').onclick = async () => {
  const username = $('inpUser').value.trim();
  const password = $('inpPass').value;
  if (!username || !password) return toast('请填写学号和密码', 'err');
  const btn = $('btnDoLogin');
  btn.disabled = true;
  btn.textContent = '登录中…';
  try {
    const r = await api('/login', { method: 'POST', body: { username, password } });
    $('loginModal').hidden = true;
    toast('登录成功：' + (r.account || username), 'ok');
    // 登录完成，把窗口挪回屏幕外
    try {
      const w = await api('/browser/hide', { method: 'POST' });
      browserVisible = !!w.visible;
      renderBrowserBtn();
    } catch { /* 忽略 */ }
    await refreshStatus();
    await loadTerms();
    await loadCourses();
  } catch (e) {
    toast('登录失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '登录';
  }
};

$('btnLogout').onclick = async () => {
  await api('/logout', { method: 'POST' });
  toast('已退出');
  await refreshStatus();
  $('courseList').innerHTML = '<p class="empty">登录后加载课程列表</p>';
};

// Edge 窗口控制：平时躲在屏幕外；登录/验证码时唤出
let browserVisible = false;
let browserBusy = false;

function renderBrowserBtn() {
  const btn = $('btnBrowser');
  btn.textContent = browserVisible ? '隐藏浏览器' : '显示浏览器';
  btn.title = browserVisible
    ? '把 Edge 窗口挪回屏幕外（不影响后台请求）'
    : 'Edge 窗口平时躲在屏幕外；需要输验证码或手动操作时唤出';
}

$('btnBrowser').onclick = async () => {
  const btn = $('btnBrowser');
  btn.disabled = true;
  browserBusy = true;
  try {
    const r = await api(browserVisible ? '/browser/hide' : '/browser/show', { method: 'POST' });
    browserVisible = !!r.visible;
    renderBrowserBtn();
    if (browserVisible) toast('已唤出浏览器窗口，用完点「隐藏浏览器」', 'ok');
  } catch (e) {
    toast('操作失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    browserBusy = false;
  }
};

async function syncBrowserBtn() {
  try {
    const r = await api('/browser/window');
    // 冷启动时这个响应可能很慢，别覆盖用户已经点过的结果
    if (!browserBusy) browserVisible = !!r.visible;
  } catch { /* 服务未启动时忽略 */ }
  if (!browserBusy) renderBrowserBtn();
}

$('btnRefresh').onclick = loadCourses;

// ---------- 设置：目录 / 导入导出 / 升级 / 退出 ----------

async function openSettings() {
  $('settingsModal').hidden = false;
  loadTrash();
  try {
    const m = await api('/md-config');
    $('mdParallel').value = String(m.parallel ?? 'auto');
    const r = m.resolved || {};
    $('mdParallelHint').textContent = r.parallel ? `当前：自动会选 ${r.parallel} 页 · ${r.reason || ''}` : '';
    $('mdParallelHint').className = 'test-result';
  } catch { /* 忽略 */ }
  try {
    const p = await api('/paths');
    $('setDataDir').value = p.dataDir || '';
    $('setNotesDir').value = p.sameDir ? '' : (p.notesDir || '');
    $('pathsHint').textContent = p.sameDir ? '（笔记与数据同目录）' : '（笔记目录独立）';
    $('pathsHint').className = 'test-result';
  } catch (e) {
    $('pathsHint').textContent = '读取失败：' + String(e.message || e);
    $('pathsHint').className = 'test-result err';
  }
}

async function pickFolderInto(inputId, hintId) {
  const hint = $(hintId);
  hint.textContent = '等待选择…';
  hint.className = 'test-result';
  try {
    const r = await api('/pick-folder', { method: 'POST', body: { initial: $(inputId).value.trim() } });
    if (r.canceled) { hint.textContent = '已取消'; return; }
    $(inputId).value = r.path;
    hint.textContent = '';
  } catch (e) {
    hint.textContent = '打开对话框失败：' + String(e.message || e).slice(0, 60);
    hint.className = 'test-result err';
  }
}

$('btnSettings').onclick = openSettings;

// ---------- 删除已下载（回收站） ----------

let delTarget = null;

async function openDeleteModal(node) {
  delTarget = node;
  const parts = String(node.rel || '').split('/');
  const course = parts[0] || '';
  const lesson = parts.slice(1).join('/') || node.name || '';
  $('delTitle').textContent = `「${parts.join(' / ')}」`;
  $('delMediaInfo').textContent = '统计中…';
  $('delRecordsInfo').textContent = '统计中…';
  $('delHint').textContent = '';
  $('delMedia').checked = true;
  $('delRecords').checked = false;
  $('delRecords').disabled = false;
  $('delModal').hidden = false;
  try {
    const p = await api(`/trash/preview?course=${encodeURIComponent(course)}&lesson=${encodeURIComponent(lesson)}`);
    $('delMediaInfo').textContent = p.media.count ? `${fmtSize(p.media.size)} · ${p.media.count} 项` : '（没有）';
    $('delRecordsInfo').textContent = p.records.count ? `${fmtSize(p.records.size)} · ${p.records.count} 项` : '（没有）';
    if (!p.media.count) $('delMedia').checked = false;
    $('delRecords').disabled = !p.records.count;
  } catch (e) {
    $('delMediaInfo').textContent = '';
    $('delRecordsInfo').textContent = '';
    $('delHint').textContent = '统计失败：' + e.message;
  }
}

$('delCancel').onclick = () => { $('delModal').hidden = true; };

$('delConfirm').onclick = async () => {
  if (!delTarget) return;
  const parts = String(delTarget.rel || '').split('/');
  const course = parts[0] || '';
  const lesson = parts.slice(1).join('/') || delTarget.name || '';
  const media = $('delMedia').checked;
  const records = $('delRecords').checked;
  if (!media && !records) { $('delHint').textContent = '至少勾选一项'; return; }
  $('delHint').textContent = '正在移到回收站…';
  try {
    const r = await api('/trash/remove', { method: 'POST', body: { course, lesson, media, records } });
    try { localStorage.removeItem('wqppt_page:' + delTarget.rel); } catch { /* 忽略 */ }
    $('delModal').hidden = true;
    toast(`已移到回收站（${fmtSize(r.size)}），可在「设置 → 回收站」恢复`, 'ok');
    loadFiles();
  } catch (e) {
    $('delHint').textContent = '删除失败：' + e.message;
  }
};

async function loadTrash() {
  const box = $('trashList');
  if (!box) return;
  try {
    const r = await api('/trash/list');
    if (!r.items.length) { box.innerHTML = '<p class="empty">（空）</p>'; return; }
    box.innerHTML = '';
    for (const it of r.items) {
      const row = document.createElement('div');
      row.className = 'trash-item';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = `${it.course} · ${it.lesson}`;
      name.title = `${it.course} / ${it.lesson}`;
      const meta = document.createElement('span');
      meta.className = 'meta';
      let atText = '';
      try { atText = new Date(it.at).toLocaleString('zh-CN', { hour12: false }); } catch { atText = ''; }
      meta.textContent = `${fmtSize(it.size)}${atText ? ' · ' + atText : ''}`;
      const restore = document.createElement('button');
      restore.className = 'btn tiny';
      restore.textContent = '恢复';
      restore.onclick = async () => {
        restore.disabled = true;
        try {
          const rr = await api('/trash/restore', { method: 'POST', body: { id: it.id } });
          const skipped = (rr.blocked || []).length;
          toast(skipped ? `已恢复 ${rr.restored} 项；${skipped} 项因目标已存在被跳过` : `已恢复（${rr.restored} 项）`, skipped ? '' : 'ok');
          loadTrash();
          loadFiles();
        } catch (e) {
          toast('恢复失败：' + e.message, 'err');
          restore.disabled = false;
        }
      };
      const purge = document.createElement('button');
      purge.className = 'btn tiny danger';
      purge.textContent = '彻底删除';
      purge.onclick = async () => {
        if (!confirm(`彻底删除「${it.course} / ${it.lesson}」？此操作不可恢复。`)) return;
        purge.disabled = true;
        try {
          await api('/trash/purge', { method: 'POST', body: { id: it.id } });
          toast('已彻底删除', 'ok');
          loadTrash();
        } catch (e) {
          toast('删除失败：' + e.message, 'err');
          purge.disabled = false;
        }
      };
      row.append(name, meta, restore, purge);
      box.appendChild(row);
    }
  } catch (e) {
    box.innerHTML = `<p class="empty">加载失败：${e.message}</p>`;
  }
}

$('btnTrashClear').onclick = async () => {
  if (!confirm('清空回收站？其中所有内容将被彻底删除，无法恢复。')) return;
  try {
    await api('/trash/purge', { method: 'POST', body: { all: true } });
    toast('回收站已清空', 'ok');
    loadTrash();
  } catch (e) {
    $('trashHint').textContent = '清空失败：' + e.message;
  }
};

// ---------- 使用说明 & 四步流程指示 ----------

function openHelp() {
  $('helpModal').hidden = false;
  try { $('helpDontAuto').checked = localStorage.getItem('wqppt_help_auto') === '0'; } catch { /* 忽略 */ }
}

function closeHelp() {
  $('helpModal').hidden = true;
  try { localStorage.setItem('wqppt_help_auto', $('helpDontAuto').checked ? '0' : '1'); } catch { /* 忽略 */ }
}

$('btnHelp').onclick = openHelp;
$('btnCloseHelp').onclick = closeHelp;

/** 根据当前进度高亮流程条，并给出「下一步做什么」 */
function updateFlowBar() {
  const flow = state.flow || { lessons: 0, withMd: 0 };
  let step = 1;
  let hint = '第一步：点右上角「登录」（统一认证学号密码）';
  if (state.loggedIn) {
    step = 2;
    hint = '下一步：勾选左边的课程后点「下载所选」；只想下一两次课就点「课次」自己挑';
    if (flow.lessons > 0) {
      step = 3;
      hint = state.mdTool && state.mdTool.available === false
        ? '下一步：先跑 setup 脚本装转换环境（README 里有命令），再点课次旁的「转 MD」'
        : '下一步：在右下「已下载文件」里，点某次课后面的「转 MD」';
    }
    if (flow.withMd > 0) {
      step = 4;
      hint = '可以复习了：点课次旁的「复习」进入复习台；先用「🧠 出题」自测';
    }
  }
  document.querySelectorAll('.flow-step').forEach((el) => {
    const n = Number(el.dataset.step);
    el.classList.toggle('active', n === step);
    el.classList.toggle('done', n < step);
  });
  $('flowHint').textContent = hint;
}
$('btnCloseSettings').onclick = () => { $('settingsModal').hidden = true; };
$('btnSaveMd').onclick = async () => {
  const hint = $('mdParallelHint');
  try {
    const v = $('mdParallel').value;
    const r = await api('/md-config', { method: 'PUT', body: { parallel: v === 'auto' ? 'auto' : Number(v) } });
    hint.textContent = r.parallel === 'auto'
      ? `✓ 已设为自动：当前会并行 ${r.resolved?.parallel || 1} 页`
      : `✓ 已保存：单节内并行 ${r.parallel} 页`;
    hint.className = 'test-result ok';
  } catch (e) {
    hint.textContent = '✗ ' + String(e.message || e).slice(0, 80);
    hint.className = 'test-result err';
  }
};

$('btnPickData').onclick = () => pickFolderInto('setDataDir', 'pickDataHint');
$('btnPickNotes').onclick = () => pickFolderInto('setNotesDir', 'pickNotesHint');

$('btnSavePaths').onclick = async () => {
  const hint = $('pathsHint');
  hint.textContent = '保存中…';
  hint.className = 'test-result';
  try {
    const p = await api('/paths', {
      method: 'PUT',
      body: { dataDir: $('setDataDir').value.trim(), notesDir: $('setNotesDir').value.trim() },
    });
    hint.textContent = `✓ 已保存：数据 ${p.dataDir}${p.sameDir ? '（笔记同目录）' : '，笔记 ' + p.notesDir}`;
    hint.className = 'test-result ok';
    toast('目录已更新，正在刷新…', 'ok');
    setTimeout(() => location.reload(), 900);
  } catch (e) {
    hint.textContent = '✗ ' + String(e.message || e).slice(0, 90);
    hint.className = 'test-result err';
  }
};

$('btnExport').onclick = () => {
  const qp = new URLSearchParams();
  if ($('expImages').checked) qp.set('images', '1');
  if (!$('expChats').checked) qp.set('chats', '0');
  if ($('expNotesOnly') && $('expNotesOnly').checked) qp.set('onlyNotes', '1');
  const q = qp.toString() ? '?' + qp.toString() : '';
  $('exportHint').textContent = $('expImages').checked ? '正在打包（含图片，可能较慢）…' : '正在打包…';
  $('exportHint').className = 'test-result';
  // 用隐藏 iframe 触发下载，避免整页跳转
  const a = document.createElement('a');
  a.href = '/api/export' + q;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => {
    $('exportHint').textContent = '✓ 已开始下载（浏览器下载目录里）';
    $('exportHint').className = 'test-result ok';
  }, 1500);
};

$('btnImport').onclick = async () => {
  const file = $('impFile').files && $('impFile').files[0];
  const hint = $('importHint');
  if (!file) { hint.textContent = '先选一个 .zip 包'; hint.className = 'test-result err'; return; }
  hint.textContent = `正在导入 ${file.name}（${(file.size / 1048576).toFixed(1)}MB）…`;
  hint.className = 'test-result';
  try {
    const q = $('impOverwrite').checked ? '?overwrite=1' : '';
    const r = await fetch('/api/import' + q, { method: 'POST', body: file });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    hint.textContent = `✓ 写入 ${data.written} 个文件，跳过 ${data.skipped} 个${data.errors?.length ? '，失败 ' + data.errors.length : ''}`;
    hint.className = 'test-result ok';
    toast('导入完成，正在刷新…', 'ok');
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    hint.textContent = '✗ ' + String(e.message || e).slice(0, 100);
    hint.className = 'test-result err';
  }
};

$('btnUpdateCheck').onclick = async () => {
  const hint = $('updateHint');
  hint.textContent = '检查中…';
  hint.className = 'test-result';
  try {
    const r = await api('/system/update-check');
    hint.textContent = (r.ok ? '✓ ' : '✗ ') + (r.message || '');
    hint.className = 'test-result' + (r.ok ? ' ok' : ' err');
  } catch (e) {
    hint.textContent = '✗ ' + String(e.message || e).slice(0, 90);
    hint.className = 'test-result err';
  }
};

$('btnUpdate').onclick = async () => {
  if (!confirm('从 GitHub 拉取最新代码并升级？升级后需要重启程序。')) return;
  const hint = $('updateHint');
  hint.textContent = '升级中（git pull + 可能安装依赖）…';
  hint.className = 'test-result';
  try {
    const r = await api('/system/update', { method: 'POST' });
    hint.textContent = `✓ ${r.message}${r.files?.length ? '（' + r.files.length + ' 个文件）' : ''}`;
    hint.className = 'test-result ok';
    $('shutdownHint').textContent = '升级完成，建议点「退出程序」后重新启动。';
  } catch (e) {
    hint.textContent = '✗ ' + String(e.message || e).slice(0, 120);
    hint.className = 'test-result err';
  }
};

$('btnShutdown').onclick = async () => {
  if (!confirm('退出程序？会关闭服务与后台浏览器进程（下载中的任务会中断）。')) return;
  const hint = $('shutdownHint');
  hint.textContent = '正在退出…';
  try {
    await api('/system/shutdown', { method: 'POST' });
    hint.textContent = '✓ 已退出，可以关闭这个页面了';
    hint.className = 'test-result ok';
    document.body.innerHTML = '<div style="font:16px/1.8 system-ui;padding:48px;text-align:center">' +
      '程序已退出 ✅<br><span style="color:#666;font-size:14px">浏览器窗口会在 1~2 秒内自动关闭，此页面可以直接关掉。</span></div>';
    setTimeout(() => window.close(), 1200);
  } catch (e) {
    hint.textContent = '✗ ' + String(e.message || e).slice(0, 90);
    hint.className = 'test-result err';
  }
};
$('btnRefreshFiles').onclick = loadFiles;

/** 勾选了几门课 → 按钮上显示数量 */
function updatePickCount() {
  const n = state.selectedCourses.size;
  $('btnDownloadSel').textContent = n ? `下载所选（${n}）` : '下载所选';
  $('btnDownloadSel').disabled = n === 0;
}

$('btnSelectAll').onclick = () => {
  const pickable = state.courses.filter((c) => !c.delisted).map((c) => String(c.courseId));
  const allSelected = pickable.length > 0 && pickable.every((id) => state.selectedCourses.has(id));
  state.selectedCourses = new Set(allSelected ? [] : pickable);
  renderCourses();
  updatePickCount();
};

$('btnDownloadSel').onclick = async () => {
  const btn = $('btnDownloadSel');
  const ids = [...state.selectedCourses];
  if (!ids.length) return;
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '创建中…';
  try {
    for (const courseId of ids) {
      const c = state.courses.find((x) => String(x.courseId) === courseId);
      btn.textContent = `创建中… ${c ? c.title : courseId}`;
      await api('/jobs', { method: 'POST', body: { mode: 'course', courseId } });
    }
    toast(`已为 ${ids.length} 门课创建下载任务`, 'ok');
    state.selectedCourses = new Set();
    renderCourses();
  } catch (e) {
    toast('创建失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
    updatePickCount();
  }
};

$('btnCloseSubs').onclick = () => { $('subsModal').hidden = true; };

// 去重开关记忆
try {
  if (localStorage.getItem('wqppt_dedup') === '0') $('dedupChk').checked = false;
} catch {}
$('dedupChk').onchange = () => {
  try { localStorage.setItem('wqppt_dedup', $('dedupChk').checked ? '1' : '0'); } catch {}
};

$('btnLlmConfig').onclick = openLlmConfig;
$('btnCancelLlm').onclick = () => { $('llmModal').hidden = true; };
$('btnSaveLlm').onclick = saveLlmConfig;
for (const [key, f] of Object.entries(LLM_FIELDS)) {
  $(f.btn).onclick = () => testLlmProfile(key);
  $(LLM_MODEL_UI[key].btn).onclick = () => fetchLlmModels(key);
}

$('termSel').onchange = loadCourses;

// ---------- SSE 进度 ----------

function connectEvents() {
  /** 已提示过「下一步」的任务，避免同一条提示重复弹 */
  const notified = new Set();
  const es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'hello') {
        for (const j of msg.jobs) state.jobs.set(j.id, j);
        renderJobs();
      } else if (msg.type === 'hello-md') {
        for (const j of msg.jobs) state.mdJobs.set(j.id, j);
        renderJobs();
      } else if (msg.type === 'job') {
        state.jobs.set(msg.job.id, msg.job);
        renderJobs();
        if (msg.job.status === 'done' && msg.job.finishedAt) {
          loadFiles();
          if (!notified.has('dl' + msg.job.id)) {
            notified.add('dl' + msg.job.id);
            toast('✅ PPT 下载完成 → 下一步：在「已下载文件」里点课次旁的「转 MD」', 'ok');
          }
        }
      } else if (msg.type === 'md-job') {
        state.mdJobs.set(msg.job.id, msg.job);
        renderJobs();
        if (msg.job.status === 'done' && msg.job.finishedAt) {
          loadFiles();
          if (!notified.has('md' + msg.job.id)) {
            notified.add('md' + msg.job.id);
            toast('✅ 转 MD 完成 → 下一步：点课次旁的「复习」进入复习台', 'ok');
          }
        }
      } else if (msg.type === 'hello-llm') {
        for (const j of msg.jobs) state.llmJobs.set(j.id, j);
        renderJobs();
      } else if (msg.type === 'llm-job') {
        state.llmJobs.set(msg.job.id, msg.job);
        renderJobs();
      }
    } catch {}
  };
  es.onerror = () => {
    es.close();
    setTimeout(connectEvents, 5000);
  };
}

// ---------- 启动 ----------

(async function init() {
  const s = await refreshStatus();
  if (s?.loggedIn) {
    // 学期 + 课程列表可能较慢（首次要拉起 Edge，冷启动可达 1~2 分钟），
    // 不阻塞任务列表 / 文件树 / SSE 的初始化
    loadTerms().then(loadCourses);
  } else {
    $('termSel').innerHTML = '<option value="">未登录</option>';
  }
  const [{ jobs }, mdTool, md, llm] = await Promise.all([
    api('/jobs').catch(() => ({ jobs: [] })),
    api('/md-tools').catch(() => null),
    api('/md-jobs').catch(() => ({ jobs: [] })),
    api('/llm-jobs').catch(() => ({ jobs: [] })),
  ]);
  for (const j of jobs) state.jobs.set(j.id, j);
  state.mdTool = mdTool;
  for (const j of md.jobs || []) state.mdJobs.set(j.id, j);
  for (const j of llm.jobs || []) state.llmJobs.set(j.id, j);
  renderJobs();
  loadFiles();
  connectEvents();
  loadLlmConfig();
  syncBrowserBtn();
  // 第一次用：自动弹一次使用说明
  try {
    if (localStorage.getItem('wqppt_help_auto') !== '0' && !localStorage.getItem('wqppt_help_seen')) {
      localStorage.setItem('wqppt_help_seen', '1');
      setTimeout(openHelp, 700);
    }
  } catch { /* 忽略 */ }
})();
