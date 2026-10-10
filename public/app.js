/* 清渠 — 前端逻辑（零依赖） */

const $ = (id) => document.getElementById(id);
const state = {
  loggedIn: false,
  courses: [],
  termId: '',
  jobs: new Map(),
  mdJobs: new Map(),
  llmJobs: new Map(),
  replayJobs: new Map(),
  llmConfig: null,
  mdTool: null,
  subsCache: new Map(),
  selectedCourses: new Set(),
  delSel: new Set(),
  lessonRels: [],
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
    // 记住过账号 → 会话过期时自动恢复登录（每次页面加载只试一次，失败回退手动登录）
    if (!s.loggedIn && s.savedLogin && !state.autoLoginTried) {
      state.autoLoginTried = true;
      $('statusText').textContent = '正在自动登录…';
      try {
        const r = await api('/auto-login', { method: 'POST' });
        toast('已自动登录：' + (r.account || s.savedUser || ''), 'ok');
        return await refreshStatus();
      } catch (e) {
        $('statusText').textContent = '未登录（自动登录失败，请手动登录）';
      }
    }
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

/** 「同时抓音轨」是个会记住的偏好：勾一次以后每次下载都带上（课次弹窗里可以改） */
const AUDIO_PREF_KEY = 'wqppt_download_audio';

function audioPref() {
  return localStorage.getItem(AUDIO_PREF_KEY) === '1';
}

function setAudioPref(on) {
  localStorage.setItem(AUDIO_PREF_KEY, on ? '1' : '0');
  // 两处开关（课程区工具栏 / 课次弹窗）保持同步
  const a = $('toolbarWithAudio');
  const b = $('subsWithAudio');
  if (a) a.checked = !!on;
  if (b) b.checked = !!on;
}

// 勾选即生效：以前只在点「下载此课次」时才保存，导致「勾完直接批量下载」丢设置
$('toolbarWithAudio').onchange = (e) => setAudioPref(e.target.checked);
$('subsWithAudio').onchange = (e) => setAudioPref(e.target.checked);
$('toolbarWithAudio').checked = audioPref();   // 打开页面就显示上次的选择

async function openSubs(course) {
  $('subsTitle').textContent = course.title;
  $('subsList').innerHTML = '<p class="empty">加载中…</p>';
  $('subsWithAudio').checked = audioPref();   // 恢复上次的选择（与工具栏那个同步）
  renderSubsToolsHint();
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

/**
 * 课次弹窗底部那行状态：ffmpeg / faster-whisper / 识别模型 / 已抓音轨。
 * 「模型下没下」是用户最常问的，所以直接写在能点到「转写讲稿」的地方。
 */
async function renderSubsToolsHint() {
  const el = $('subsToolsHint');
  if (!el) return;
  el.textContent = '转写环境检查中…';
  try {
    const t = await api('/replay-tools');
    const parts = [];
    parts.push(t.ffmpeg.available ? `ffmpeg ✓ ${t.ffmpeg.version || ''}`.trim() : 'ffmpeg ✗（winget install Gyan.FFmpeg）');
    parts.push(t.whisper.available ? 'faster-whisper ✓' : 'faster-whisper ✗（pip install faster-whisper）');
    if (!t.model.ready) {
      parts.push(`识别模型未下载（首次转写自动下 1.6GB，存到 ${t.model.dir}）`);
    } else {
      parts.push(`识别模型 ✓ ${t.model.model}（${t.model.mb} MB）`);
    }
    parts.push(t.audio.count ? `已抓音轨 ${t.audio.count} 节 / ${t.audio.mb} MB` : '还没有抓过音轨');
    el.textContent = parts.join(' ｜ ');
  } catch (e) {
    el.textContent = '转写环境检查失败：' + e.message;
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

      const btnTrans = document.createElement('button');
      btnTrans.className = 'btn';
      btnTrans.textContent = '转写讲稿';
      btnTrans.title = '抓这节课的回放音轨，本地转成带时间戳的讲稿（约 10~30 分钟/节）';
      btnTrans.onclick = () => startReplayJob(course, s, btnTrans);

      actions.append(btnPreview, btnDl, btnTrans);
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
    const withAudio = Boolean($('subsWithAudio') && $('subsWithAudio').checked);
    setAudioPref(withAudio);
    await api('/jobs', { method: 'POST', body: { mode: 'sub', courseId: course.courseId, subId: sub.subId, termId: state.termId, force, withAudio } });
    toast(`已创建任务：${course.title} — ${sub.title}${force ? '（强制重下）' : ''}${withAudio ? '（含抓音轨）' : ''}`, 'ok');
  } catch (e) {
    toast('创建失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '下载此课次';
  }
}

/** 抓回放音轨并本地转写讲稿（视频不落盘，只留音轨 + 讲稿） */
async function startReplayJob(course, sub, btn) {
  btn.disabled = true;
  btn.textContent = '创建中…';
  try {
    // 先看环境：缺 ffmpeg / faster-whisper 时直接说清装什么，别等任务跑一半才报错
    try {
      const t = await api('/replay-tools');
      if (!t.ffmpeg.available) {
        toast('缺少 ffmpeg（抽音轨要用）：Windows 运行 winget install Gyan.FFmpeg，装完重开清渠', 'err');
        return;
      }
      if (!t.whisper.available) {
        toast(t.whisper.hint || '缺少 faster-whisper：pip install faster-whisper', 'err');
        return;
      }
    } catch { /* 自检查询失败不拦，交给任务自己报错 */ }
    const force = Boolean($('subsForce') && $('subsForce').checked);
    const { job } = await api('/replay-jobs', {
      method: 'POST',
      body: {
        courseId: course.courseId,
        subId: sub.subId,
        courseTitle: course.title,
        subTitle: sub.title,
        force,
      },
    });
    toast(job?.skipped
      ? `该课次已有讲稿：${job.transRel}`
      : `已创建转写任务：${course.title} — ${sub.title}`, 'ok');
  } catch (e) {
    toast('创建失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '转写讲稿';
  }
}

// ---------- 任务列表 ----------

function renderJobs() {
  const box = $('jobList');
  const dl = [...state.jobs.values()].map((j) => ({ ...j, kind: 'download' }));
  const md = [...state.mdJobs.values()].map((j) => ({ ...j, kind: 'md' }));
  const llm = [...state.llmJobs.values()].map((j) => ({ ...j, kind: 'llm' }));
  const replay = [...state.replayJobs.values()].map((j) => ({ ...j, kind: 'replay' }));
  const all = [...dl, ...md, ...llm, ...replay].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
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
    if (j.kind === 'replay') {
      box.appendChild(renderReplayJobCard(j));
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

/** 回放转写任务卡：抓流 → 抽音轨 → 转写，三段各有自己的进度口径 */
function renderReplayJobCard(j) {
  const el = document.createElement('div');
  el.className = 'job';

  const STAGE = { capture: '抓取音轨', 'download-model': '下载识别模型', transcribe: '语音识别', '': '排队' };
  const head = document.createElement('div');
  head.className = 'job-head';

  const left = document.createElement('div');
  const title = document.createElement('p');
  title.className = 'job-title';
  // 只抓音轨的任务（下载时勾了「同时抓音轨」）别说成转写——它不跑识别
  title.textContent = `#${j.id} ${j.audioOnly ? '抓取音轨' : '转写讲稿'} · ${j.courseTitle} — ${j.subTitle}`;

  const stats = document.createElement('div');
  stats.className = 'job-stats';
  const stage = STAGE[j.stage] || j.stage;
  if (j.status === 'running') {
    const p = j.progress || {};
    const detail = p.unit === 'bytes' && p.done
      ? `${fmtSize(p.done)}${p.total ? ' / ' + fmtSize(p.total) : ''}`
      : p.unit === 'seconds' && p.total
        ? `${p.done}/${p.total} 秒（${pct(p.done, p.total)}%）`
        : '准备中…';
    stats.textContent = `${stage} · ${detail}`;
  } else if (j.status === 'done') {
    stats.textContent = `完成：${j.transRel || ''}${j.device ? '（' + j.device + '）' : ''}`;
  } else if (j.status === 'error') {
    stats.textContent = j.error || '失败';
  } else if (j.status === 'canceled') {
    stats.textContent = '已取消';
  } else {
    stats.textContent = '排队中…';
  }
  left.append(title, stats);

  const right = document.createElement('div');
  const badge = document.createElement('span');
  badge.className = 'badge ' + j.status + ' md';
  badge.textContent = j.status === 'running' ? stage : statusLabel(j.status);
  right.appendChild(badge);

  if (j.status === 'done' && j.transUrl) {
    const open = document.createElement('button');
    open.className = 'btn';
    open.textContent = '打开讲稿';
    open.onclick = () => window.open(j.transUrl, '_blank');
    right.append(document.createTextNode(' '), open);
  }
  if (j.status === 'running' || j.status === 'pending') {
    const cancel = document.createElement('button');
    cancel.className = 'btn danger';
    cancel.textContent = '取消';
    cancel.onclick = async () => {
      try { await api(`/replay-jobs/${j.id}/cancel`, { method: 'POST' }); } catch {}
    };
    right.append(document.createTextNode(' '), cancel);
  }
  head.append(left, right);
  el.appendChild(head);

  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('i');
  const p = j.progress || {};
  const width = j.status === 'done' ? 100
    : j.status === 'running' && p.unit === 'bytes' && p.done
      ? (p.total ? pct(p.done, p.total) : Math.min(95, Math.round(p.done / 1048576)))
      : j.status === 'running' && p.total ? pct(p.done, p.total) : 0;
  fill.style.width = width + '%';
  bar.appendChild(fill);
  el.appendChild(bar);

  if (j.log && j.log.length) {
    const log = document.createElement('div');
    log.className = 'job-log';
    log.textContent = j.log.slice(-3).join(' · ');
    el.appendChild(log);
  }
  return el;
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
  renderVisionHint();
}

/**
 * 显示「哪些档位能读图、笔记实际会走哪条链路」。
 * 笔记链路不在这里选：默认自动（有能读图的档位走视觉，否则回落文本）。
 * 要强制走文本（技术储备路径），改 config.json 的 llm.notePipeline 或调 PUT /api/llm-config。
 */
async function renderVisionHint() {
  const el = $('llmVisionHint');
  if (!el) return;
  el.textContent = '检测中…';
  try {
    const s = await api('/llm-vision');
    const LABEL = { text: '纯文本', visionCloud: '图片上云', visionLocal: '图片本地' };
    const okList = s.details.filter((d) => d.ok).map((d) => `${LABEL[d.key] || d.key}（${d.model}）`);
    const badList = s.details.filter((d) => !d.ok).map((d) => `${LABEL[d.key] || d.key}：${d.reason}`);
    const eff = s.effective === 'vision' ? '视觉（看图写）' : '文本（按 OCR 原文写）';
    el.textContent = `笔记自动选择链路，当前会走：${eff}。`
      + (okList.length ? ` 能读图：${okList.join('、')}。` : ' 当前没有能读图的模型。')
      + (badList.length ? ` 不可用：${badList.join('；')}。` : '')
      + (okList.length ? '' : ' 没有可读图的模型时自动按 OCR 原文写。');
  } catch (e) {
    el.textContent = '读图能力检测失败：' + e.message;
  }
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
    state.lessonRels = lessons.map((l) => l.rel);
    // 清理已经不存在的选中项
    for (const rel of [...state.delSel]) {
      if (!state.lessonRels.includes(rel)) state.delSel.delete(rel);
    }
    updateDelBar();
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
        mk('批量生成笔记', '对所有已转 MD 的课次生成深度笔记（转 MD 后自动校订；生成后自动复核；队列串行）', batchNoteCourse);
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
      // 批量选择：课次行加复选框
      if (hasImages || node.hasMd) {
        const pick = document.createElement('input');
        pick.type = 'checkbox';
        pick.className = 'pick';
        pick.dataset.rel = node.rel;
        pick.checked = state.delSel.has(node.rel);
        pick.title = '选中以便批量删除';
        pick.onclick = (e) => e.stopPropagation();
        pick.onchange = () => {
          if (pick.checked) state.delSel.add(node.rel); else state.delSel.delete(node.rel);
          updateDelBar();
        };
        summary.insertBefore(pick, summary.firstChild);
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
        del.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const parts = String(node.rel || '').split('/');
          openDeleteModal([{ course: parts[0] || '', lesson: parts.slice(1).join('/') || node.name || '', rel: node.rel }]);
        };
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
  const remember = $('inpRemember') ? $('inpRemember').checked : true;
  if (!username || !password) return toast('请填写学号和密码', 'err');
  const btn = $('btnDoLogin');
  btn.disabled = true;
  btn.textContent = '登录中…';
  try {
    const r = await api('/login', { method: 'POST', body: { username, password, remember } });
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
  try {
    await api('/logout', { method: 'POST' });
    toast('已退出登录');
  } catch (e) {
    toast('退出失败：' + e.message, 'err');
  }
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
  syncComfortSettings();
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

// ---------- 阅读舒适（主题 / 护眼提醒） ----------

function syncComfortSettings() {
  document.querySelectorAll('input[name="themePick"]').forEach((r) => {
    r.checked = r.value === Comfort.theme();
  });
  $('fontSizeSel').value = Comfort.fontSize();
  $('eyeRemindChk').checked = Comfort.reminderOn();
}

document.querySelectorAll('input[name="themePick"]').forEach((r) => {
  r.onchange = () => { if (r.checked) Comfort.setTheme(r.value); };
});

$('fontSizeSel').onchange = () => { Comfort.setFontSize($('fontSizeSel').value); };

$('eyeRemindChk').onchange = () => {
  Comfort.setReminder($('eyeRemindChk').checked);
  toast($('eyeRemindChk').checked ? '护眼提醒已开启（每 20 分钟一次）' : '护眼提醒已关闭', 'ok');
};

window.addEventListener('wqppt-theme', () => { syncComfortSettings(); });
window.addEventListener('wqppt-fontsize', () => { $('fontSizeSel').value = Comfort.fontSize(); });
window.addEventListener('wqppt-reminder', () => { $('eyeRemindChk').checked = Comfort.reminderOn(); });

// ---------- 删除已下载（回收站） ----------

let delItems = [];

function updateDelBar() {
  const bar = $('fileTools');
  if (!bar) return;
  const n = state.delSel.size;
  bar.hidden = n === 0;
  $('fileSelCount').textContent = `已选 ${n} 个课次`;
}

function syncDelChecks() {
  document.querySelectorAll('#fileTree input.pick').forEach((cb) => {
    cb.checked = state.delSel.has(cb.dataset.rel);
  });
}

async function openDeleteModal(items) {
  delItems = Array.isArray(items) ? items : [];
  if (!delItems.length) return;
  $('delTitle').textContent = delItems.length === 1
    ? `「${delItems[0].course} / ${delItems[0].lesson}」`
    : `${delItems.length} 个课次（${delItems[0].course} 等）`;
  $('delMediaInfo').textContent = '统计中…';
  $('delRecordsInfo').textContent = '统计中…';
  $('delHint').textContent = '';
  $('delMedia').checked = true;
  $('delRecords').checked = false;
  $('delRecords').disabled = false;
  $('delModal').hidden = false;
  try {
    const p = await api('/trash/preview-multi', {
      method: 'POST',
      body: { items: delItems.map((x) => ({ course: x.course, lesson: x.lesson })) },
    });
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
  if (!delItems.length) return;
  const media = $('delMedia').checked;
  const records = $('delRecords').checked;
  if (!media && !records) { $('delHint').textContent = '至少勾选一项'; return; }
  $('delHint').textContent = '正在移到回收站…';
  try {
    const r = await api('/trash/remove', {
      method: 'POST',
      body: {
        items: delItems.map((x) => ({ course: x.course, lesson: x.lesson })),
        media,
        records,
      },
    });
    for (const it of delItems) {
      if (it.rel) { try { localStorage.removeItem('wqppt_page:' + it.rel); } catch { /* 忽略 */ } }
    }
    state.delSel.clear();
    $('delModal').hidden = true;
    toast(`已移到回收站（${fmtSize(r.size)}），可在「设置 → 回收站」恢复`, 'ok');
    loadFiles();
  } catch (e) {
    $('delHint').textContent = '删除失败：' + e.message;
  }
};

$('btnSelAll').onclick = () => {
  for (const rel of state.lessonRels) state.delSel.add(rel);
  syncDelChecks();
  updateDelBar();
};

$('btnSelClear').onclick = () => {
  state.delSel.clear();
  syncDelChecks();
  updateDelBar();
};

$('btnDelSelected').onclick = () => {
  if (!state.delSel.size) return;
  openDeleteModal([...state.delSel].map((rel) => {
    const parts = String(rel).split('/');
    return { course: parts[0] || '', lesson: parts.slice(1).join('/') || '', rel };
  }));
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
      name.textContent = it.summary || `${it.course} · ${it.lesson}`;
      name.title = it.summary || `${it.course} / ${it.lesson}`;
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

// ---------- 导入自定义课件（PPT / PDF / 图片） ----------

function openImportLesson() {
  $('impLessonFiles').value = '';
  $('impLessonName').value = '';
  $('impLessonDpiWrap').hidden = true;
  $('impLessonHint').textContent = '';
  $('impLessonHint').className = 'test-result';
  $('impLessonModal').hidden = false;
  const dl = $('dlCourseOptions');
  dl.innerHTML = '';
  for (const name of state.dlCourseNames || []) {
    const opt = document.createElement('option');
    opt.value = name;
    dl.appendChild(opt);
  }
  if (!$('impLessonCourse').value.trim() && (state.dlCourseNames || []).length === 1) {
    $('impLessonCourse').value = state.dlCourseNames[0];
  }
}

$('btnImportCourse').onclick = async () => {
  try {
    const { tree } = await api('/files');
    state.dlCourseNames = tree.filter((x) => x.type === 'dir').map((x) => x.name);
  } catch { /* 忽略 */ }
  openImportLesson();
};

$('impLessonCancel').onclick = () => { $('impLessonModal').hidden = true; };

$('impLessonFiles').onchange = () => {
  const files = [...$('impLessonFiles').files];
  if (!files.length) return;
  const hasPdf = files.some((f) => /\.pdf$/i.test(f.name));
  $('impLessonDpiWrap').hidden = !hasPdf;
  if (!$('impLessonName').value.trim()) {
    $('impLessonName').value = files[0].name.replace(/\.[^.]+$/, '');
  }
};

async function uploadLessonFile(file, { course, lesson, kind, seq, dpi }) {
  const q = new URLSearchParams({ course, lesson, filename: file.name, kind, seq: String(seq) });
  if (dpi) q.set('dpi', String(dpi));
  const res = await fetch('/api/import-lesson?' + q.toString(), { method: 'POST', body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

$('impLessonGo').onclick = async () => {
  const hint = $('impLessonHint');
  const files = [...$('impLessonFiles').files];
  const course = $('impLessonCourse').value.trim();
  let lesson = $('impLessonName').value.trim();
  if (!files.length) { hint.textContent = '先选择课件文件'; hint.className = 'test-result err'; return; }
  if (!course) { hint.textContent = '请填写课程名'; hint.className = 'test-result err'; return; }
  if (!lesson) lesson = files[0].name.replace(/\.[^.]+$/, '');
  const isImg = (f) => /\.(jpe?g|png|webp|bmp)$/i.test(f.name);
  const isPdf = (f) => /\.pdf$/i.test(f.name);
  const isPpt = (f) => /\.(ppt|pptx)$/i.test(f.name);
  const mains = files.filter((f) => isPdf(f) || isPpt(f));
  const imgs = files.filter(isImg);
  const others = files.filter((f) => !isImg(f) && !isPdf(f) && !isPpt(f));
  if (others.length) {
    hint.textContent = `不支持的文件：${others[0].name}（可先另存为 PDF 再导入）`;
    hint.className = 'test-result err';
    return;
  }
  if (mains.length > 1 || (mains.length === 1 && imgs.length)) {
    hint.textContent = '一次只导入一个 PPT/PDF；图片可以多选（多张合成一节课）';
    hint.className = 'test-result err';
    return;
  }
  try {
    const chk = await api(`/import-lesson/check?course=${encodeURIComponent(course)}&lesson=${encodeURIComponent(lesson)}`);
    if (chk.images > 0 || chk.exists) {
      if (!confirm(`「${course} / ${lesson}」已存在（${chk.images} 张图片）。继续导入会与已有内容合并（同名序号会被覆盖）。是否继续？`)) return;
    }
  } catch { /* 检查失败不拦截，后端会再校验 */ }
  $('impLessonGo').disabled = true;
  try {
    if (mains.length === 1) {
      const f = mains[0];
      hint.textContent = `正在上传 ${f.name}（${(f.size / 1048576).toFixed(1)} MB）…转换可能需要一会儿`;
      hint.className = 'test-result';
      const r = await uploadLessonFile(f, {
        course, lesson, kind: isPdf(f) ? 'pdf' : 'pptx', seq: 1,
        dpi: isPdf(f) ? Number($('impLessonDpi').value) || 160 : 0,
      });
      hint.textContent = `✓ 已导入 ${r.pages} 页 →「${course} / ${lesson}」，现在可以「转 MD」了`;
    } else {
      imgs.sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true }));
      for (let i = 0; i < imgs.length; i++) {
        hint.textContent = `上传中 ${i + 1}/${imgs.length}…`;
        hint.className = 'test-result';
        await uploadLessonFile(imgs[i], { course, lesson, kind: 'image', seq: i + 1 });
      }
      hint.textContent = `✓ 已导入 ${imgs.length} 张图片 →「${course} / ${lesson}」，现在可以「转 MD」了`;
    }
    hint.className = 'test-result ok';
    toast('课件导入完成', 'ok');
    loadFiles();
  } catch (e) {
    hint.textContent = '导入失败：' + e.message;
    hint.className = 'test-result err';
  } finally {
    $('impLessonGo').disabled = false;
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

// ---------- 导出范围选择（全部 / 课程 / 单课） ----------

let exportCoursesCache = null;

async function fillExportCourses() {
  const scope = $('expScope').value;
  $('expCourseWrap').hidden = scope === 'all';
  $('expLessonWrap').hidden = scope !== 'lesson';
  if (scope === 'all') return;
  try {
    const { tree } = await api('/files');
    exportCoursesCache = tree.filter((x) => x.type === 'dir');
  } catch (e) {
    $('exportHint').textContent = '拉取课程列表失败：' + e.message;
    $('exportHint').className = 'test-result err';
    return;
  }
  const sel = $('expCourse');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const c of exportCoursesCache) {
    const opt = document.createElement('option');
    opt.value = c.name;
    opt.textContent = c.name;
    sel.appendChild(opt);
  }
  if (prev && exportCoursesCache.some((c) => c.name === prev)) sel.value = prev;
  fillExportLessons();
}

function fillExportLessons() {
  const node = (exportCoursesCache || []).find((c) => c.name === $('expCourse').value);
  const sel = $('expLesson');
  const prev = sel.value;
  sel.innerHTML = '';
  const lessons = (node?.children || []).filter((x) =>
    x.type === 'dir' && !x.name.startsWith('_') && !x.name.endsWith('_assets'));
  for (const l of lessons) {
    const opt = document.createElement('option');
    opt.value = l.name;
    opt.textContent = l.name;
    sel.appendChild(opt);
  }
  if (prev && lessons.some((l) => l.name === prev)) sel.value = prev;
}

$('expScope').onchange = fillExportCourses;
$('expCourse').onchange = fillExportLessons;

$('btnExport').onclick = () => {
  const type = $('expType').value;
  const scope = $('expScope').value;
  const qp = new URLSearchParams({ type });
  if (type === 'content' && !$('expImages').checked) qp.set('images', '0');
  if (type === 'full' && $('expImages').checked) qp.set('images', '1');
  if (scope !== 'all') {
    const course = $('expCourse').value;
    if (!course) {
      $('exportHint').textContent = '先选要导出的课程';
      $('exportHint').className = 'test-result err';
      return;
    }
    qp.set('course', course);
    if (scope === 'lesson') {
      const lesson = $('expLesson').value;
      if (!lesson) {
        $('exportHint').textContent = '先选要导出的课次';
        $('exportHint').className = 'test-result err';
        return;
      }
      qp.set('lesson', lesson);
    }
  }
  const withImages = $('expImages').checked && (type === 'content' || type === 'full');
  $('exportHint').textContent = withImages ? '正在打包（含图片，可能较慢）…' : '正在打包…';
  $('exportHint').className = 'test-result';
  // 用隐藏 iframe 触发下载，避免整页跳转
  const a = document.createElement('a');
  a.href = '/api/export?' + qp.toString();
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => {
    $('exportHint').textContent = '✓ 已开始下载（浏览器下载目录里）';
    $('exportHint').className = 'test-result ok';
  }, 1500);
};

// ---------- 一键批处理（今天 / 本周 / 本月） ----------

const RANGE_LABEL = { today: '今天', week: '本周', month: '本月' };

/** 客户端的周期起止（YYYY-MM-DD，和服务器端口径一致：周一为一周开始） */
function rangeDates(range) {
  const now = new Date();
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === 'today') return [fmt(day0), fmt(day0)];
  if (range === 'week') {
    const off = (now.getDay() + 6) % 7;
    const mon = new Date(day0.getTime() - off * 86400000);
    const sun = new Date(mon.getTime() + 6 * 86400000);
    return [fmt(mon), fmt(sun)];
  }
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return [fmt(first), fmt(last)];
}

function rangeHint(text, cls) {
  const el = $('rangeHint');
  el.textContent = text || '';
  el.className = 'range-hint' + (cls ? ' test-result ' + cls : '');
}

/** 给按钮挂一个「今天 / 本周 / 本月」小菜单 */
function makeRangeMenu(btn, onPick) {
  if (!btn) return;
  btn.onclick = (e) => {
    e.stopPropagation();
    const old = document.getElementById('rangeMenu');
    const sameOwner = old && old.dataset.owner === btn.id;
    if (old) old.remove();
    if (sameOwner) return;
    const menu = document.createElement('div');
    menu.className = 'range-menu';
    menu.id = 'rangeMenu';
    menu.dataset.owner = btn.id;
    for (const r of ['today', 'week', 'month']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = RANGE_LABEL[r];
      b.onclick = () => { menu.remove(); onPick(r); };
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const rect = btn.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(window.innerWidth - 140, rect.left)) + 'px';
    menu.style.top = (rect.bottom + 6) + 'px';
  };
}

document.addEventListener('click', () => {
  const m = document.getElementById('rangeMenu');
  if (m) m.remove();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const m = document.getElementById('rangeMenu');
  if (m) m.remove();
});

// 下载：今天 / 本周 / 本月 的课件（服务端跨课程检索课次并加入下载队列）
makeRangeMenu($('btnRangeDownload'), async (range) => {
  const btn = $('btnRangeDownload');
  const label = RANGE_LABEL[range];
  btn.disabled = true;
  rangeHint(`正在检索「${label}」的课次…`);
  try {
    const r = await api('/download-range', { method: 'POST', body: { range, termId: state.termId, withAudio: audioPref() } });
    if (!r.matched) {
      rangeHint(`「${label}」没有找到可下载的课次`);
    } else {
      rangeHint(`「${label}」匹配 ${r.matched} 个课次，已加入 ${r.queued} 个下载任务${r.failed?.length ? `（${r.failed.length} 个失败）` : ''}`);
      if (r.queued) toast(`已加入 ${r.queued} 个下载任务（进度见下方任务列表）${r.withAudio ? '｜同时抓音轨已开启' : ''}`, 'ok');
    }
  } catch (e) {
    rangeHint('下载失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

// 一键笔记：转 MD → 校订 → 生成笔记 → 复核（服务端逐个课次串行执行）
makeRangeMenu($('btnRangeNote'), async (range) => {
  const label = RANGE_LABEL[range];
  if (!confirm(`对「${label}」内已下载的课次执行全流程？\n转 MD → 校订 → 生成笔记 → 复核（调用 AI；已有且未过期的笔记会自动跳过）`)) return;
  const btn = $('btnRangeNote');
  btn.disabled = true;
  rangeHint(`正在排队「${label}」的笔记流程…`);
  try {
    const r = await api('/note-range', { method: 'POST', body: { range } });
    if (r.queued) {
      rangeHint(`「${label}」已排队 ${r.queued} 个课次（跳过 ${r.skipped} 个），在下方任务列表逐个执行`);
      toast(`已排队 ${r.queued} 个课次的笔记流程`, 'ok');
    } else {
      rangeHint(`「${label}」没有需要处理的课次（都已是最新）`);
    }
  } catch (e) {
    rangeHint('排队失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

// 一键导出：把该周期的笔记 + 课件图打包成内容包
makeRangeMenu($('btnRangeExport'), (range) => {
  const [from, to] = rangeDates(range);
  const qp = new URLSearchParams({ type: 'content', images: '1', from, to });
  const a = document.createElement('a');
  a.href = '/api/export?' + qp.toString();
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  rangeHint(`正在导出「${RANGE_LABEL[range]}」（${from} ~ ${to}）的内容包…`);
});

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
    const m = data.merged || {};
    const bits = [];
    if (m.progress) bits.push(`进度 ${m.progress} 节`);
    if (m.cardsAdded || m.cardsUpdated) bits.push(`卡片 +${m.cardsAdded}/~${m.cardsUpdated}`);
    if (m.chatsAdded) bits.push(`对话 +${m.chatsAdded} 条`);
    hint.textContent = `✓ 写入 ${data.written} 个文件，跳过 ${data.skipped} 个${bits.length ? '；合并 ' + bits.join('、') : ''}${data.errors?.length ? '，失败 ' + data.errors.length : ''}`;
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
    const withAudio = audioPref();
    for (const courseId of ids) {
      const c = state.courses.find((x) => String(x.courseId) === courseId);
      btn.textContent = `创建中… ${c ? c.title : courseId}`;
      await api('/jobs', { method: 'POST', body: { mode: 'course', courseId, withAudio } });
    }
    toast(`已为 ${ids.length} 门课创建下载任务${withAudio ? '（同时抓音轨已开启，可在课次弹窗里关）' : ''}`, 'ok');
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
      } else if (msg.type === 'hello-replay') {
        for (const j of msg.jobs) state.replayJobs.set(j.id, j);
        renderJobs();
      } else if (msg.type === 'replay-job') {
        state.replayJobs.set(msg.job.id, msg.job);
        renderJobs();
        if (msg.job.status === 'done' && msg.job.finishedAt && !notified.has('rp' + msg.job.id)) {
          notified.add('rp' + msg.job.id);
          toast(msg.job.audioOnly
            ? '✅ 音轨已就绪（点「生成笔记」时会自动转写；也可点课次的「转写讲稿」立即转）'
            : '✅ 讲稿转写完成 → 打开「讲稿」查看', 'ok');
        }
        if (msg.job.status === 'error' && !notified.has('rpe' + msg.job.id)) {
          notified.add('rpe' + msg.job.id);
          toast((msg.job.audioOnly ? '抓音轨失败：' : '转写失败：') + (msg.job.error || '未知错误'), 'err');
        }
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
  const [{ jobs }, mdTool, md, llm, replay] = await Promise.all([
    api('/jobs').catch(() => ({ jobs: [] })),
    api('/md-tools').catch(() => null),
    api('/md-jobs').catch(() => ({ jobs: [] })),
    api('/llm-jobs').catch(() => ({ jobs: [] })),
    api('/replay-jobs').catch(() => ({ jobs: [] })),
  ]);
  for (const j of jobs) state.jobs.set(j.id, j);
  state.mdTool = mdTool;
  for (const j of md.jobs || []) state.mdJobs.set(j.id, j);
  for (const j of llm.jobs || []) state.llmJobs.set(j.id, j);
  for (const j of replay.jobs || []) state.replayJobs.set(j.id, j);
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
