/* 问渠学堂 PPT 下载器 — 前端逻辑（零依赖） */

const $ = (id) => document.getElementById(id);
const state = {
  loggedIn: false,
  courses: [],
  jobs: new Map(),
  subsCache: new Map(),
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
    return s;
  } catch (e) {
    $('statusDot').className = 'dot offline';
    $('statusText').textContent = '服务未启动';
    return null;
  }
}

// ---------- 课程列表 ----------

async function loadCourses() {
  const box = $('courseList');
  if (!state.loggedIn) {
    box.innerHTML = '<p class="empty">登录后加载课程列表</p>';
    return;
  }
  box.innerHTML = '<p class="empty">加载中…</p>';
  try {
    const months = $('monthsSel').value;
    const { courses } = await api(`/courses?months=${months}`);
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
  for (const c of state.courses) {
    const el = document.createElement('div');
    el.className = 'course-item';

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
    btnDl.onclick = () => startCourseJob(c, btnDl);

    actions.append(btnSubs, btnDl);
    el.append(main, actions);
    box.appendChild(el);
  }
}

async function startCourseJob(course, btn) {
  btn.disabled = true;
  btn.textContent = '创建中…';
  try {
    await api('/jobs', { method: 'POST', body: { mode: 'course', courseId: course.courseId } });
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
    box.innerHTML = '<p class="empty">该课程暂无可下载课次</p>';
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
    await api('/jobs', { method: 'POST', body: { mode: 'sub', courseId: course.courseId, subId: sub.subId } });
    toast(`已创建任务：${course.title} — ${sub.title}`, 'ok');
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
  const jobs = [...state.jobs.values()].sort((a, b) => b.id - a.id);
  if (jobs.length === 0) {
    box.innerHTML = '<p class="empty">暂无任务</p>';
    return;
  }
  box.innerHTML = '';
  for (const j of jobs) {
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
    stats.textContent = `课次 ${j.stats.done}/${j.stats.total} · 图片 ${j.stats.images} 张` +
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
        ? `${t.done} 张`
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

function estimateTotal(job) {
  let total = 0;
  for (const t of job.tasks) total += t.total || 0;
  return total || Math.max(1, job.stats.total);
}

// ---------- 文件树 ----------

async function loadFiles() {
  const box = $('fileTree');
  try {
    const { tree } = await api('/files');
    if (tree.length === 0) {
      box.innerHTML = '<p class="empty">downloads/ 目录为空</p>';
      return;
    }
    box.innerHTML = '';
    box.appendChild(renderTree(tree));
  } catch (e) {
    box.innerHTML = `<p class="empty">加载失败：${e.message}</p>`;
  }
}

function renderTree(nodes) {
  const root = document.createElement('div');
  root.className = 'tree';
  for (const node of nodes) {
    if (node.type === 'dir') {
      const details = document.createElement('details');
      details.className = 'dir';
      const summary = document.createElement('summary');
      summary.textContent = '📁 ' + node.name;
      details.appendChild(summary);
      if (node.children?.length) details.appendChild(renderTree(node.children));
      root.appendChild(details);
    } else {
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
    }
  }
  return root;
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
    await refreshStatus();
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

$('btnRefresh').onclick = loadCourses;
$('btnRefreshJobs').onclick = async () => {
  const { jobs } = await api('/jobs');
  for (const j of jobs) state.jobs.set(j.id, j);
  renderJobs();
};
$('btnRefreshFiles').onclick = loadFiles;

$('btnDownloadAll').onclick = async () => {
  const btn = $('btnDownloadAll');
  btn.disabled = true;
  btn.textContent = '创建中…';
  try {
    await api('/jobs', { method: 'POST', body: { mode: 'all' } });
    toast('已创建全部课程下载任务', 'ok');
  } catch (e) {
    toast('创建失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '全部下载';
  }
};

$('btnCloseSubs').onclick = () => { $('subsModal').hidden = true; };

$('monthsSel').onchange = loadCourses;

// ---------- SSE 进度 ----------

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'hello') {
        for (const j of msg.jobs) state.jobs.set(j.id, j);
        renderJobs();
      } else if (msg.type === 'job') {
        state.jobs.set(msg.job.id, msg.job);
        renderJobs();
        if (msg.job.status === 'done' && msg.job.finishedAt) loadFiles();
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
  if (s?.loggedIn) await loadCourses();
  const { jobs } = await api('/jobs').catch(() => ({ jobs: [] }));
  for (const j of jobs) state.jobs.set(j.id, j);
  renderJobs();
  loadFiles();
  connectEvents();
})();