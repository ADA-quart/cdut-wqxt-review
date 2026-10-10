// 临时脚本：在 GitHub 克隆实例上跑一次转写，验证「识别」在干净副本里可用（用后即删）
const BASE = 'http://127.0.0.1:3903/api';
const call = async (p, opts = {}) => {
  const { body, ...rest } = opts;
  const r = await fetch(BASE + p, {
    headers: { 'Content-Type': 'application/json' },
    ...rest,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p} → ${data.error || r.status}`);
  return data;
};

const payload = {
  courseId: '75240', subId: '324033',
  courseTitle: '弹性波动力学', subTitle: '2026-06-29第1-2节',
};

// 先提交「只抓音轨」：克隆里已有音轨 → 应直接跳过（不重复抓 1GB）
const a = await call('/replay-jobs', { method: 'POST', body: { ...payload, audioOnly: true } });
console.log('只抓音轨 →', a.job?.skipped ? `跳过（${a.job.reason}）` : `任务 #${a.job?.id} ${a.job?.status}`);

// 再提交完整转写：应跳过抓流、直接跑识别
const r = await call('/replay-jobs', { method: 'POST', body: payload });
if (r.job?.skipped) { console.log('完整转写 → 跳过（已存在）'); process.exit(0); }
const id = r.job.id;
console.log(`完整转写 → 任务 #${id}，等待识别…`);

const t0 = Date.now();
let last = '';
for (;;) {
  await new Promise((res) => setTimeout(res, 5000));
  const j = (await call(`/replay-jobs/${id}`)).job;
  const line = `${j.status}/${j.stage} ${j.progress?.unit === 'seconds' ? `${j.progress.done}/${j.progress.total}s` : ''} ${j.device || ''}`;
  if (line !== last) { console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${line}`); last = line; }
  if (['done', 'error', 'canceled'].includes(j.status)) {
    console.log('最终:', j.status, j.error || '');
    console.log('日志:\n' + (j.log || []).map((l) => '  · ' + l).join('\n'));
    break;
  }
  if (Date.now() - t0 > 40 * 60 * 1000) { console.log('超时'); break; }
}
