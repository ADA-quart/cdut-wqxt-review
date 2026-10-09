/**
 * 问渠学堂业务操作层。
 *
 * 数据流：
 *   登录(CAS) → 我的课程(get-my-course-month，按月) → 课次目录(course/catalogue)
 *   → 课次 PPT 图列表(pptnote/schedule/search-ppt) → 图片直链(video.wqxt.cdut.edu.cn，可直下)
 *
 * 所有业务接口均在浏览器页面上下文内 fetch（同源、自动带 cookie），已实测无需签名参数。
 */
import { apiGet, clearAuthCookies, getWorkPage, WQ_BASE } from './browser.mjs';

export const API = {
  infoSimple: '/userapi/v1/infosimple',
  myCourseMonth: '/courseapi/v2/course-live/get-my-course-month',
  myCourseDay: '/courseapi/v2/course-live/get-my-course-day',
  catalogue: '/courseapi/v2/course/catalogue',
  searchPpt: '/pptnote/v1/schedule/search-ppt',
  termList: '/courseapi/v2/schedule/get-format-term-list',
};

/** 登录态检测：访问 infosimple，能拿到 account 视为已登录 */
export async function checkLogin() {
  const page = await getWorkPage();
  const url = page.url();
  if (!url.startsWith(WQ_BASE)) {
    return { loggedIn: false, reason: 'not-on-site', url };
  }
  const r = await apiGet(API.infoSimple);
  if (r.ok && r.data?.params?.account) {
    return {
      loggedIn: true,
      account: r.data.params.account,
      name: r.data.params.realname || r.data.params.name || '',
      user: r.data.params,
    };
  }
  // 可能是 412 挑战页或跳到了登录
  return { loggedIn: false, reason: r.ok ? 'no-account-field' : 'request-failed', preview: r.text || r.error };
}

/**
 * 在真实浏览器里执行 CAS 登录。
 * 页面此刻可能已在 CAS 登录页，也可能停在问渠首页——两种都处理。
 */
export async function login(username, password) {
  const page = await getWorkPage();

  // 若当前不在登录页，先访问首页触发 CAS 跳转
  if (!page.url().includes('cas.paas.cdut.edu.cn')) {
    await page.goto(WQ_BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    // 等可能的跳转
    for (let i = 0; i < 20; i++) {
      if (page.url().includes('cas.paas.cdut.edu.cn')) break;
      const logged = await checkLogin();
      if (logged.loggedIn) return { ok: true, alreadyLoggedIn: true, ...logged };
      await page.waitForTimeout(1000);
    }
  }

  if (page.url().includes('cas.paas.cdut.edu.cn')) {
    await page.waitForSelector('input[type="password"]', { timeout: 30000 });

    const userInput = page.locator('input[type="text"]:visible').first();
    await userInput.fill(username);

    const pwdInput = page.locator('input[type="password"]:visible').first();
    await pwdInput.fill(password);

    // 勾选同意（若有）
    const cb = page.locator('input[type="checkbox"]:visible').first();
    if ((await cb.count()) > 0) await cb.check({ force: true }).catch(() => {});

    await page.waitForTimeout(300);
    const btn = page.locator('button:visible, [type="submit"]:visible').first();
    await btn.click().catch(async () => { await page.keyboard.press('Enter'); });
  }

  // 等回到问渠学堂并确认登录
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1500);
    const url = page.url();
    if (url.startsWith(WQ_BASE) && !url.includes('cas.paas')) {
      const logged = await checkLogin();
      if (logged.loggedIn) return { ok: true, ...logged };
    }
    // 登录失败（密码错误时 CAS 会停在本页并提示）
    if (url.includes('cas.paas') && i > 6) {
      const errText = await page
        .locator('.el-message, .error, .login-error')
        .first()
        .textContent()
        .catch(() => '');
      if (errText && errText.trim()) return { ok: false, error: errText.trim() };
    }
  }
  return { ok: false, error: '登录超时：请在弹出的浏览器窗口中完成登录后重试' };
}

/**
 * 退出登录。
 *
 * 站点的 `/logout` 只是前端路由，不清会话（实测：访问后 infosimple 仍返回账号），
 * 所以这里按站点自身的登出流程走：
 *   1. 用页面里的 window.CONFIG 拼官方 CAS 登出地址，让服务端注销 SSO 会话；
 *   2. 清掉 cdut 域下的鉴权 cookie，兜住 CAS 没清干净的情况；
 *   3. 回到站点复检，未清干净时如实返回 ok:false，不假装成功。
 */
export async function logout() {
  const page = await getWorkPage();

  // tenant_code 必须是当前租户，写死 21 换校区就废了，所以从页面配置里读
  const casLogoutUrl = await page
    .evaluate(() => {
      const c = window.CONFIG || {};
      if (!c.CASAPI) return '';
      let tenant = c.TENANT_ID || '';
      try {
        tenant = JSON.parse(sessionStorage.getItem('user') || '{}').tenant_id || tenant;
      } catch { /* 忽略 */ }
      // forward 必须是完整 URL（WEB_DOMAIN 是 cookie 域，不能直接用）
      const forward = location.origin + '/';
      return `${c.CASAPI}/index.php?r=auth/cmc-loginout&tenant_code=${tenant}&forward=${encodeURIComponent(forward)}`;
    })
    .catch(() => '');

  let casError = '';
  if (casLogoutUrl) {
    await page
      .goto(casLogoutUrl, { waitUntil: 'domcontentloaded', timeout: 45000 })
      .catch((e) => { casError = String(e?.message || e); });
    await page.waitForTimeout(500);
  }

  await clearAuthCookies();

  // 回站点复检：CAS 若仍认为会话有效，会静默重新发票，这里能立刻发现
  await page.goto(WQ_BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(800);
  const state = await checkLogin();
  return {
    ok: !state.loggedIn,
    casLogoutUrl,
    casError,
    loggedIn: !!state.loggedIn,
    reason: state.loggedIn ? 'session-still-alive' : state.reason || 'logged-out',
  };
}

/** 学期列表（含 current 标记） */
export async function listTerms() {
  const r = await apiGet(API.termList, { tenant: 21 });
  if (!r.ok || !r.data?.list) return [];
  const out = [];
  for (const [year, seasons] of Object.entries(r.data.list)) {
    for (const [season, info] of Object.entries(seasons)) {
      out.push({
        id: info.id,
        label: `${info.year} 第${season === '1' ? '一' : '二'}学期`,
        termName: info.term_name,
        year: info.year,
        season,
        beginDate: info.begin_date,
        endDate: info.end_date,
        current: !!info.current,
      });
    }
  }
  return out;
}

/**
 * 「我的课程」——按月或按学期查询。
 * - months: 直接指定月份列表（如 ['2026-09', ...]）
 * - termId: 按学期查询（自动换算学期起止月份，并只保留属于该学期的课程）
 * 返回扁平课程列表，按课程去重；已下架课程带 delisted 标记。
 */
export async function listMyCourses({ months, termId } = {}) {
  let monthList = months && months.length ? months : recentMonths(6);
  let filterTerm = null;
  if (termId != null && termId !== '') {
    const terms = await listTerms();
    const term = terms.find((t) => String(t.id) === String(termId));
    if (!term) throw new Error('未找到该学期');
    monthList = monthsBetween(term.beginDate, term.endDate);
    filterTerm = `_${term.id}_`;
  }
  const map = new Map();
  for (const month of monthList) {
    for (let page = 1; page <= 10; page++) {
      const r = await apiGet(API.myCourseMonth, { month, page, per_page: 200 });
      const sections = r.data?.list;
      if (!r.ok || !Array.isArray(sections) || sections.length === 0) break;
      let got = 0;
      for (const sec of sections) {
        for (const c of sec.course || []) {
          if (filterTerm && String(c.term) !== filterTerm) continue;
          got++;
          const key = String(c.id);
          if (!map.has(key)) {
            map.set(key, {
              courseId: key,
              title: c.title,
              teacher: c.realname || '',
              term: c.term,
              termId: parseTermId(c.term),
              kkxyName: c.kkxy_name || '',
              courseCode: c.course_code || '',
              studentNum: c.student_num || '',
              // 已下架的课程没有 PPT 和回放（课次目录为空）
              delisted: /【已下架】/.test(String(c.title || '')),
              sections: [],
            });
          }
          const entry = map.get(key);
          if (sec.section && !entry.sections.includes(sec.section)) entry.sections.push(sec.section);
        }
      }
      if (got === 0) break;
    }
  }
  return [...map.values()];
}

/** 课次的课节信息（"01" → "上午"）暂存到课程对象 */
function parseTermId(term) {
  const m = /^_(\d+)_$/.exec(String(term || ''));
  return m ? Number(m[1]) : null;
}

function recentMonths(count) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/** 学期起止日期 → 覆盖的月份列表（如 2026-08-31 ~ 2027-01-17 → 2026-08..2027-01） */
function monthsBetween(beginDate, endDate) {
  const out = [];
  const start = new Date(beginDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return recentMonths(6);
  const cur = new Date(start.getFullYear(), start.getMonth(), 1);
  const last = new Date(end.getFullYear(), end.getMonth(), 1);
  while (cur <= last && out.length < 24) {
    out.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
    cur.setMonth(cur.getMonth() + 1);
  }
  return out;
}

/** 课程的全部课次（含录播状态与视频地址） */
export async function listCourseSubs(courseId) {
  const r = await apiGet(API.catalogue, { course_id: courseId });
  const subs = r.data?.result?.data;
  if (!Array.isArray(subs)) return [];
  return subs.map((s) => {
    let content = null;
    try { content = JSON.parse(s.content || '{}'); } catch {}
    return {
      subId: String(s.sub_id),
      courseId: String(s.course_id || courseId),
      title: s.title,
      status: String(s.status),          // 6=回放可用（含纯录播）
      startAt: Number(s.start_at || 0),  // 单位：秒
      lecturerName: s.lecturer_name || '',
      room: s.room || '',
      type: s.type || '',
      hasPlayback: String(s.status) === '6',
      pptStatus: content?.api_pass?.ppt_status || '',
      videoUrl: content?.playback?.url || content?.save_playback?.contents || '',
      pic: s.pic || s.thumb || '',
    };
  });
}

/**
 * 课次的 PPT 图片列表（按时间排序的直链）。
 * 接口分页：page 从 1 开始，per_page 最大 200（实测 200 可覆盖单节课）。
 */
export async function listSubPpt(courseId, subId) {
  const all = [];
  let total = null;
  for (let page = 1; page <= 10; page++) {
    const r = await apiGet(API.searchPpt, { course_id: courseId, sub_id: subId, page, per_page: 200 });
    const list = r.data?.list;
    if (!r.ok || !Array.isArray(list)) break;
    total = typeof r.data.total === 'number' ? r.data.total : total;
    for (const item of list) {
      let content = null;
      try { content = JSON.parse(item.content || '{}'); } catch {}
      const url = content?.pptimgurl;
      if (!url) continue;
      all.push({
        id: item.id,
        url: url.replace(/^http:\/\//, 'https://').replace(/^\/\//, 'https://'),
        thumb: (content?.pptthumb || '').replace(/^http:\/\//, 'https://'),
        created: Number(content?.created || 0),
        createdSec: Number(item.created_sec || 0),
      });
    }
    if (total !== null && all.length >= total) break;
    if (list.length === 0) break;
  }
  // created 可能为 0，用 createdSec 兜底排序（保持时间轴顺序）
  all.sort((a, b) => (a.created || a.createdSec * 1000) - (b.created || b.createdSec * 1000));
  return all;
}

let courseIndexCache = null;

/** 课程标题 → 课程（含 courseId），近 24 个月，缓存 10 分钟（列表接口较重） */
async function courseByTitle() {
  const now = Date.now();
  if (courseIndexCache && now - courseIndexCache.at < 10 * 60 * 1000) return courseIndexCache.map;
  const months = [];
  const d = new Date();
  for (let i = 0; i < 24; i += 1) {
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    d.setMonth(d.getMonth() - 1);
  }
  const courses = await listMyCourses({ months });
  const map = new Map(courses.map((c) => [c.title, c]));
  courseIndexCache = { at: now, map };
  return map;
}

/**
 * 按标题反查课次的 PPT 列表（老课件补页码时间轴用）。
 * 本地目录里只有「课程名 / 课次名」，要拿 createdSec 得先换回 course_id / sub_id。
 */
export async function pageTimesByTitle(courseTitle, lessonTitle) {
  const map = await courseByTitle();
  const course = map.get(String(courseTitle));
  if (!course || course.delisted) return null;
  const subs = await listCourseSubs(course.courseId);
  const sub = subs.find((s) => s.title === String(lessonTitle));
  if (!sub) return null;
  return listSubPpt(course.courseId, sub.subId);
}
