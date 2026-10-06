#!/usr/bin/env python
"""课次图片清洗：移除空白过渡帧与渐进重复帧（保留每簇最后一帧）。

设计要点：
- 原始图片一律不删除，清洗只影响「转 MD」使用哪些帧。
- 生成 <课次>.dedup.json（决策数据）与 <课次>.dedup.html（人工复核页面：
  全部帧按网格排列，勾选 = 清理、取消勾选 = 保留；自动识别的重复/空白/二维码帧默认勾选）。
- 人工改动记录在 json 的 userRemove 列表，转 MD 时自动带上；被清理的帧进 _回收站，随时可恢复。

用法:
    python dedup.py "downloads/课程/课次目录"          # 分析并生成复核页面
    python dedup.py "downloads/课程/课次目录" --json   # 附带机器可读摘要
"""
import argparse
import html
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image

# 与 tools/dupcheck.py 保持一致的判定参数
CROP_BOTTOM = 0.86
GRAY_SIZE = (320, 180)
BLANK_INK = 2.5      # 幻灯片区域内容密度低于此值视为空白
DUP_MAE = 8.0        # 近重复：平均灰度差
DUP_PCT = 6.0        # 近重复：变化像素占比（%）
QR_DARK = 0.45       # 等待页/二维码页：中心区域暗像素占比阈值
QR_HF = 0.08         # 等待页/二维码页：中心区域黑白跳变率阈值


def qr_like(im_gray):
    """判断是否为「等待页 / 动态二维码」页面。

    特征：中心区域大面积深色底 + 二维码的高频黑白跳变（实测 dark≈0.65 / hf≈0.105，
    普通幻灯片 dark≈0.01 / hf≈0.05），判定阈值取 0.45 / 0.08 留足余量。
    """
    w, h = im_gray.size
    c = im_gray.crop((int(w * 0.20), int(h * 0.15), int(w * 0.80), int(h * 0.85))).resize((240, 240))
    a = np.asarray(c, dtype=np.float32)
    dark = float((a < 90).mean())
    b = a > 128
    hf = float((b[:, 1:] != b[:, :-1]).mean() + (b[1:, :] != b[:-1, :]).mean()) / 2
    return dark > QR_DARK and hf > QR_HF


def trash_dir_of(lesson_dir: Path) -> Path:
    """回收站：<课程目录>/_回收站/<课次>/（在课次目录之外，避免被「转 MD」再扫到）"""
    lesson_dir = Path(lesson_dir)
    return lesson_dir.parent / "_回收站" / lesson_dir.name


def restore_from_trash(lesson_dir: Path) -> int:
    """分析前先把回收站里的帧搬回来，保证每次都从完整集合开始判断。"""
    t = trash_dir_of(lesson_dir)
    if not t.is_dir():
        return 0
    n = 0
    for p in sorted(t.iterdir()):
        if not p.is_file():
            continue
        target = Path(lesson_dir) / p.name
        if not target.exists():
            shutil.move(str(p), str(target))
            n += 1
    return n


def move_to_trash(lesson_dir: Path, names) -> int:
    """把要移除的帧丢进回收站（原地删除改为可恢复的移动）。"""
    t = trash_dir_of(lesson_dir)
    t.mkdir(parents=True, exist_ok=True)
    n = 0
    for name in names:
        src = Path(lesson_dir) / name
        if src.is_file():
            shutil.move(str(src), str(t / name))
            n += 1
    return n


def load_gray(path):
    im = Image.open(path).convert('L')
    w, h = im.size
    im = im.crop((0, 0, w, int(h * CROP_BOTTOM))).resize(GRAY_SIZE, Image.Resampling.LANCZOS)
    return np.asarray(im, dtype=np.float32)


def slide_ink(path):
    im = Image.open(path).convert('L')
    w, h = im.size
    c = im.crop((int(w * 0.16), int(h * 0.03), int(w * 0.84), int(h * 0.88)))
    a = np.asarray(c, dtype=np.float32)
    return float((a < 150).mean() * 100)


def pair_metric(a, b):
    d = np.abs(a - b)
    return float(d.mean()), float((d > 25).mean() * 100)


def analyze(images):
    """返回清洗决策结构（自动判定，尚未应用用户决策）。"""
    n = len(images)
    mats = [load_gray(p) for p in images]
    inks = [slide_ink(p) for p in images]
    qrs = [qr_like(Image.open(p).convert('L')) for p in images]

    near = []
    for i in range(n - 1):
        mae, pct = pair_metric(mats[i], mats[i + 1])
        near.append(mae <= DUP_MAE and pct <= DUP_PCT)

    runs, start = [], None
    for i, is_near in enumerate(near):
        if is_near and start is None:
            start = i
        elif not is_near and start is not None:
            runs.append((start, i))  # 帧下标区间 [start, i]
            start = None
    if start is not None:
        runs.append((start, n - 1))

    keep = [True] * n
    reason = [None] * n
    # 等待页/二维码优先归类，避免被后面的「重复帧」规则吃掉
    for i in range(n):
        if qrs[i]:
            keep[i] = False
            reason[i] = 'qr'
    run_keep = {}   # 被移除帧 -> 该簇保留帧下标
    run_range = {}  # 下标 -> 所属簇

    for (s, e) in runs:
        cand = [i for i in range(s, e + 1) if inks[i] >= BLANK_INK and not qrs[i]]
        k = cand[-1] if cand else e
        for i in range(s, e + 1):
            run_range[i] = (s, e)
            if i != k and reason[i] is None:
                keep[i] = False
                reason[i] = 'dup'
                run_keep[i] = k

    for i in range(n):
        if keep[i] and inks[i] < BLANK_INK:
            keep[i] = False
            reason[i] = 'blank'


    frames = []
    for i, p in enumerate(images):
        entry = {
            'index': i,
            'name': p.name,
            'keep': keep[i],
            'reason': reason[i],
            'ink': round(inks[i], 2),
            'prev': images[i - 1].name if i > 0 else None,
            'next': images[i + 1].name if i + 1 < n else None,
        }
        if reason[i] == 'dup':
            entry['keepName'] = images[run_keep[i]].name
            s, e = run_range[i]
            entry['run'] = [images[s].name, images[e].name]
            entry['runSize'] = e - s + 1
        frames.append(entry)

    return {
        'lesson': images[0].parent.name if images else '',
        'total': n,
        'generatedAt': datetime.now().isoformat(timespec='seconds'),
        'params': {'blankInk': BLANK_INK, 'dupMae': DUP_MAE, 'dupPct': DUP_PCT},
        'frames': frames,
    }


def state_paths(lesson_dir: Path):
    lesson_dir = Path(lesson_dir)
    return (
        lesson_dir.parent / f'{lesson_dir.name}.dedup.json',
        lesson_dir.parent / f'{lesson_dir.name}.dedup.html',
    )


def load_prev_state(lesson_dir: Path):
    """读取上次的决策 JSON（不存在则空）。"""
    json_path, _ = state_paths(lesson_dir)
    try:
        return json.loads(json_path.read_text(encoding='utf-8'))
    except Exception:
        return {}


def initial_remove_set(prev):
    """本次分析的初始「移除名单」：
    - 用户保存过决策 → 沿用（userRemove 优先）
    - 旧版有非空 restore 记录 → 迁移为「自动移除 - 人工恢复」
    - 否则 → None（跟随本次自动判定）
    """
    if prev.get('userDecided') and isinstance(prev.get('userRemove'), list):
        return {str(x) for x in prev['userRemove']}
    restore = prev.get('restore')
    if isinstance(restore, list) and restore:
        auto_removed = {str(f.get('name')) for f in (prev.get('frames') or []) if not f.get('keep')}
        return auto_removed - {str(x) for x in restore}
    return None


def apply_user_remove(state, remove_set):
    """应用最终移除名单：标 trashed、统计保留/移除数量。"""
    names = {str(x) for x in (remove_set or [])}
    valid = {fr['name'] for fr in state['frames']}
    for fr in state['frames']:
        fr['trashed'] = fr['name'] in names
    state['userRemove'] = sorted(names & valid)
    state['keptCount'] = sum(1 for fr in state['frames'] if not fr.get('trashed'))
    state['removedCount'] = state['total'] - state['keptCount']
    return state


def save_state(lesson_dir: Path, state):
    json_path, _ = state_paths(lesson_dir)
    json_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')
    return json_path


def build_report_html(lesson_dir: Path, state):
    lesson = state['lesson']
    rel_dir = f'{Path(lesson_dir).parent.name}/{Path(lesson_dir).name}'
    tpl = r'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>清洗复核 · @@LESSON@@</title>
<style>
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background:#f5f6f8; color:#1f2329; margin:0; padding:18px; }
  h1 { font-size:18px; margin:0 0 6px; }
  .summary { color:#646a73; font-size:13px; margin-bottom:12px; line-height:1.8; }
  .summary b { color:#1f2329; }
  code { background:#eef0f3; padding:1px 5px; border-radius:4px; }
  .toolbar { position:sticky; top:0; background:#f5f6f8; padding:10px 0; z-index:5; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  button { border:1px solid #1a54c8; background:#1a54c8; color:#fff; border-radius:6px; padding:8px 14px; font-size:13px; cursor:pointer; }
  button.ghost { background:#fff; color:#1f2329; border-color:#e5e6eb; }
  #count { font-size:13px; color:#646a73; }
  #status { font-size:13px; color:#0f9d58; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:10px; }
  .cell { background:#fff; border:2px solid #e5e6eb; border-radius:10px; padding:6px; }
  .cell.on { border-color:#d64541; background:#fff6f6; }
  .cell img { width:100%; display:block; border-radius:6px; background:#f0f2f5; cursor:zoom-in; }
  .cell .row { display:flex; justify-content:space-between; align-items:center; gap:6px; margin-top:6px; }
  .cell .pick { font-size:12.5px; cursor:pointer; user-select:none; display:flex; align-items:center; gap:4px; }
  .cell .pick input { width:16px; height:16px; accent-color:#d64541; }
  .cell .why { font-size:11px; color:#fff; background:#d64541; border-radius:8px; padding:1px 7px; }
  .cell .cap { font-size:10.5px; color:#8f959e; text-align:center; margin-top:4px; word-break:break-all; }
  .empty { color:#8f959e; }
</style>
</head>
<body>
<h1>清洗复核 · @@LESSON@@</h1>
<div class="summary">共 <b id="total">…</b> 帧：将清理 <b id="sumRemove">…</b>，保留 <b id="sumKeep">…</b>。
<b>勾选 = 清理</b>（移入 <code>_回收站/@@LESSON@@/</code>，随时可以撤销）；取消勾选 = 保留。
自动识别的重复 / 空白 / 二维码帧已默认勾选，红框即「将清理」的帧。改完点「保存选择」，再回下载器重新「转 MD」生效。</div>
<div class="toolbar">
  <button id="save">保存选择</button>
  <button class="ghost" id="all">全部清理</button>
  <button class="ghost" id="none">全部保留</button>
  <span id="count"></span>
  <span id="status"></span>
</div>
<div class="grid" id="grid"><p class="empty">加载中…</p></div>
<script>
const DIR = @@DIR@@;
const REASON = { dup: '重复', blank: '空白', qr: '二维码' };
const $ = (id) => document.getElementById(id);
function imgUrl(name) {
  return '/api/dedup-image?dir=' + encodeURIComponent(DIR) + '&name=' + encodeURIComponent(name);
}
function checkedNames() {
  return [...document.querySelectorAll('.cell input:checked')].map((cb) => cb.closest('.cell').dataset.name);
}
function refreshCounts() {
  const total = document.querySelectorAll('.cell').length;
  const n = checkedNames().length;
  $('total').textContent = total;
  $('sumRemove').textContent = n;
  $('sumKeep').textContent = total - n;
  $('count').textContent = '将清理 ' + n + ' 帧 · 保留 ' + (total - n) + ' 帧';
}
function render(data) {
  const grid = $('grid');
  grid.innerHTML = '';
  for (const f of data.frames) {
    const checked = data.userRemove.includes(f.name);
    const cell = document.createElement('div');
    cell.className = 'cell' + (checked ? ' on' : '');
    cell.dataset.name = f.name;
    const a = document.createElement('a');
    a.href = imgUrl(f.name);
    a.target = '_blank';
    a.rel = 'noreferrer';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = imgUrl(f.name);
    img.alt = f.name;
    a.appendChild(img);
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('label');
    label.className = 'pick';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.addEventListener('change', () => { cell.classList.toggle('on', cb.checked); refreshCounts(); });
    label.append(cb, document.createTextNode(' 清理'));
    row.appendChild(label);
    if (REASON[f.reason]) {
      const why = document.createElement('span');
      why.className = 'why';
      why.textContent = REASON[f.reason];
      row.appendChild(why);
    }
    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.textContent = f.name;
    cell.append(a, row, cap);
    grid.appendChild(cell);
  }
  refreshCounts();
}
async function load() {
  const r = await fetch('/api/dedup-state?dir=' + encodeURIComponent(DIR));
  if (!r.ok) { $('grid').innerHTML = '<p class="empty">读取清洗数据失败（HTTP ' + r.status + '）</p>'; return; }
  render(await r.json());
}
$('all').onclick = () => {
  document.querySelectorAll('.cell input').forEach((cb) => { cb.checked = true; cb.closest('.cell').classList.add('on'); });
  refreshCounts();
};
$('none').onclick = () => {
  document.querySelectorAll('.cell input').forEach((cb) => { cb.checked = false; cb.closest('.cell').classList.remove('on'); });
  refreshCounts();
};
$('save').onclick = async () => {
  $('status').textContent = '保存中…';
  $('status').style.color = '#646a73';
  try {
    const r = await fetch('/api/dedup-decisions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: DIR, remove: checkedNames() }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    $('status').textContent = '已保存：将清理 ' + d.removed + ' 帧、保留 ' + d.kept + ' 帧（清理的帧在回收站里，随时可改）。回下载器重新「转 MD」生效。';
    $('status').style.color = '#0f9d58';
    await load();
  } catch (e) {
    $('status').textContent = '保存失败：' + e.message;
    $('status').style.color = '#d64541';
  }
};
load();
</script>
</body>
</html>
'''
    return (tpl
            .replace('@@LESSON@@', html.escape(lesson))
            .replace('@@DIR@@', json.dumps(rel_dir, ensure_ascii=False)))


def write_report(lesson_dir: Path, state):
    _, html_path = state_paths(lesson_dir)
    html_path.write_text(build_report_html(lesson_dir, state), encoding='utf-8')
    return html_path


def prepare(images, lesson_dir: Path):
    """一次完成：回收站归位 → 分析 → 应用用户决策（如已保存）→ 移除帧丢回收站 → 写 json/html。"""
    lesson_dir = Path(lesson_dir)
    restore_from_trash(lesson_dir)          # 每次从完整集合重新判断
    images = sorted([p for p in lesson_dir.iterdir()
                     if p.suffix.lower() in ('.jpg', '.jpeg', '.png')])
    if not images:
        raise RuntimeError(f'目录中没有图片：{lesson_dir}')

    prev = load_prev_state(lesson_dir)
    state = analyze(images)
    remove_set = initial_remove_set(prev)
    state['userDecided'] = remove_set is not None
    if remove_set is None:
        # 用户还没做过决策：跟随本次自动判定
        remove_set = {f['name'] for f in state['frames'] if not f['keep']}
    apply_user_remove(state, remove_set)

    to_trash = [f['name'] for f in state['frames'] if f.get('trashed')]
    moved = move_to_trash(lesson_dir, to_trash)
    for f in state['frames']:
        f['trashDir'] = '_回收站/' + lesson_dir.name
    state['trash'] = {'dir': str(trash_dir_of(lesson_dir)), 'moved': moved, 'names': to_trash}

    save_state(lesson_dir, state)
    write_report(lesson_dir, state)
    return state


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path', help='课次图片目录')
    ap.add_argument('--json', action='store_true', help='输出机器可读摘要')
    args = ap.parse_args()

    lesson_dir = Path(args.path).resolve()
    if not lesson_dir.is_dir():
        print(f'目录不存在：{lesson_dir}', file=sys.stderr)
        sys.exit(1)

    # 先把回收站里的帧搬回来再判断（否则上次清空的目录会被误判为「没有图片」）
    restore_from_trash(lesson_dir)
    images = sorted([p for p in lesson_dir.iterdir()
                     if p.suffix.lower() in ('.jpg', '.jpeg', '.png')])
    if not images:
        print(f'目录中没有图片：{lesson_dir}', file=sys.stderr)
        sys.exit(1)

    state = prepare(images, lesson_dir)
    auto_removed = {f['name'] for f in state['frames'] if not f['keep']}
    restored = len(auto_removed - set(state.get('userRemove') or []))
    summary = {
        'lesson': state['lesson'],
        'total': state['total'],
        'kept': state.get('keptCount', 0),
        'removed': state.get('removedCount', 0),
        'restored': restored,
        'report': str(state_paths(lesson_dir)[1]),
    }
    if args.json:
        print(json.dumps(summary, ensure_ascii=False))
    else:
        print(f'共 {summary["total"]} 帧：保留 {summary["kept"]}，移除 {summary["removed"]}'
              f'（已恢复 {summary["restored"]}）')
        print(f'复核页面：{summary["report"]}')


if __name__ == '__main__':
    main()
