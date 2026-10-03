#!/usr/bin/env python
"""课次图片清洗：移除空白过渡帧与渐进重复帧（保留每簇最后一帧）。

设计要点：
- 原始图片一律不删除，清洗只影响「转 MD」使用哪些帧。
- 生成 <课次>.dedup.json（决策数据）与 <课次>.dedup.html（人工复核页面：
  每张被移除的帧都会展示「前一帧 / 被移除帧 / 后一帧」三联图，可勾选恢复）。
- 恢复记录写在 json 的 restore 列表，转 MD 时自动带上。

用法:
    python dedup.py "downloads/课程/课次目录"          # 分析并生成复核页面
    python dedup.py "downloads/课程/课次目录" --json   # 附带机器可读摘要
"""
import argparse
import html
import json
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
    """返回清洗决策结构（尚未应用 restore）。"""
    n = len(images)
    mats = [load_gray(p) for p in images]
    inks = [slide_ink(p) for p in images]

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
    run_keep = {}   # 被移除帧 -> 该簇保留帧下标
    run_range = {}  # 下标 -> 所属簇

    for (s, e) in runs:
        cand = [i for i in range(s, e + 1) if inks[i] >= BLANK_INK]
        k = cand[-1] if cand else e
        for i in range(s, e + 1):
            run_range[i] = (s, e)
            if i != k:
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
        'restore': [],
    }


def state_paths(lesson_dir: Path):
    lesson_dir = Path(lesson_dir)
    return (
        lesson_dir.parent / f'{lesson_dir.name}.dedup.json',
        lesson_dir.parent / f'{lesson_dir.name}.dedup.html',
    )


def load_restore(lesson_dir: Path):
    """读取人工恢复清单（不存在则为空）。"""
    json_path, _ = state_paths(lesson_dir)
    try:
        data = json.loads(json_path.read_text(encoding='utf-8'))
        return [str(x) for x in data.get('restore', [])]
    except Exception:
        return []


def apply_restore(state, restore):
    names = set(restore or [])
    for fr in state['frames']:
        fr['restored'] = bool((not fr['keep']) and fr['name'] in names)
    valid = {fr['name'] for fr in state['frames'] if not fr['keep']}
    state['restore'] = sorted(n for n in names if n in valid)
    kept = sum(1 for fr in state['frames'] if fr['keep'] or fr['restored'])
    state['keptCount'] = kept
    state['removedCount'] = state['total'] - kept
    return state


def save_state(lesson_dir: Path, state):
    json_path, _ = state_paths(lesson_dir)
    json_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')
    return json_path


def build_report_html(lesson_dir: Path, state):
    lesson = state['lesson']
    removed = [f for f in state['frames'] if not f['keep']]
    kept_count = state.get('keptCount', state['total'] - len(removed))
    removed_count = state.get('removedCount', len(removed))

    def img_tag(name, cls=''):
        if not name:
            return f'<div class="ph {cls}">（无）</div>'
        return f'<figure class="{cls}"><img loading="lazy" src="{html.escape(lesson)}/{html.escape(name)}"><figcaption>{html.escape(name)}</figcaption></figure>'

    cards = []
    for f in removed:
        if f['reason'] == 'dup':
            why = f"渐进重复：{f.get('run', ['?', '?'])[0]} → {f.get('run', ['?', '?'])[1]} 共 {f.get('runSize', '?')} 帧，已保留 {f.get('keepName', '?')}"
        else:
            why = f"空白/过渡帧（内容密度 {f.get('ink', '?')}%）"
        checked = 'checked' if f.get('restored') else ''
        cards.append(f"""
    <div class="card" data-name="{html.escape(f['name'])}">
      <div class="strip">
        {img_tag(f['prev'])}
        {img_tag(f['name'], 'removed')}
        {img_tag(f['next'])}
      </div>
      <div class="meta">
        <div class="why">{html.escape(why)}</div>
        <label class="restore"><input type="checkbox" {checked}> 恢复保留此帧</label>
      </div>
    </div>""")

    body = '\n'.join(cards) if cards else '<p class="empty">没有需要清洗的帧：全部保留。</p>'
    generated = html.escape(state.get('generatedAt', ''))

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>清洗复核 · {html.escape(lesson)}</title>
<style>
  body {{ font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background:#f5f6f8; color:#1f2329; margin:0; padding:20px; }}
  h1 {{ font-size:18px; margin:0 0 6px; }}
  .summary {{ color:#646a73; font-size:13px; margin-bottom:14px; }}
  .toolbar {{ position:sticky; top:0; background:#f5f6f8; padding:10px 0; z-index:5; display:flex; gap:10px; align-items:center; }}
  button {{ border:1px solid #1a54c8; background:#1a54c8; color:#fff; border-radius:6px; padding:8px 14px; font-size:13px; cursor:pointer; }}
  button.ghost {{ background:#fff; color:#1f2329; border-color:#e5e6eb; }}
  #status {{ font-size:13px; color:#0f9d58; }}
  .card {{ background:#fff; border:1px solid #e5e6eb; border-radius:10px; padding:12px; margin-bottom:14px; }}
  .strip {{ display:flex; gap:10px; align-items:flex-start; }}
  figure {{ margin:0; flex:1; background:#fafbfc; border:1px solid #e5e6eb; border-radius:8px; overflow:hidden; }}
  figure img {{ width:100%; display:block; }}
  figure.removed {{ border:2px solid #d64541; }}
  figure figcaption {{ font-size:11px; color:#646a73; text-align:center; padding:3px 0; }}
  figure.removed figcaption {{ color:#d64541; font-weight:600; }}
  .ph {{ flex:1; height:110px; display:grid; place-items:center; color:#8f959e; background:#fafbfc; border:1px dashed #e5e6eb; border-radius:8px; font-size:12px; }}
  .meta {{ display:flex; justify-content:space-between; align-items:center; gap:12px; margin-top:10px; flex-wrap:wrap; }}
  .why {{ font-size:12px; color:#646a73; }}
  .restore {{ font-size:13px; user-select:none; cursor:pointer; }}
  .empty {{ color:#8f959e; }}
</style>
</head>
<body>
<h1>清洗复核 · {html.escape(lesson)}</h1>
<div class="summary">共 {state['total']} 帧：保留 {kept_count}，移除 {removed_count}。生成于 {generated}。
每张被移除的帧都展示「前一帧 / 被移除帧 / 后一帧」，勾选可恢复；保存后重新「转 MD」即可生效。</div>
<div class="toolbar">
  <button id="save">保存恢复选择</button>
  <button class="ghost" id="all">全部恢复</button>
  <button class="ghost" id="none">全部不恢复</button>
  <span id="status"></span>
</div>
{body}
<script>
const save = document.getElementById('save');
const status = document.getElementById('status');
function currentRestore() {{
  return [...document.querySelectorAll('.restore input:checked')]
    .map((el) => el.closest('.card').dataset.name);
}}
document.getElementById('all').onclick = () => {{
  document.querySelectorAll('.restore input').forEach((el) => el.checked = true);
}};
document.getElementById('none').onclick = () => {{
  document.querySelectorAll('.restore input').forEach((el) => el.checked = false);
}};
save.onclick = async () => {{
  const m = decodeURIComponent(location.pathname).match(/^\\/files\\/(.+)\\.dedup\\.html$/);
  if (!m) {{ status.textContent = '请通过下载器打开本页面（保存功能不可用）'; status.style.color = '#d64541'; return; }}
  status.textContent = '保存中…'; status.style.color = '#646a73';
  try {{
    const r = await fetch('/api/dedup-decisions', {{
      method: 'POST',
      headers: {{ 'Content-Type': 'application/json' }},
      body: JSON.stringify({{ dir: m[1], restore: currentRestore() }}),
    }});
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    status.textContent = '已保存：恢复 ' + (d.restoreCount || 0) + ' 帧。回到下载器重新「转 MD」生效。';
    status.style.color = '#0f9d58';
  }} catch (e) {{
    status.textContent = '保存失败：' + e.message;
    status.style.color = '#d64541';
  }}
}};
</script>
</body>
</html>
"""


def write_report(lesson_dir: Path, state):
    _, html_path = state_paths(lesson_dir)
    html_path.write_text(build_report_html(lesson_dir, state), encoding='utf-8')
    return html_path


def prepare(images, lesson_dir: Path):
    """一次完成：分析 → 应用已有恢复 → 写 json/html。返回 state。"""
    state = analyze(images)
    apply_restore(state, load_restore(lesson_dir))
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

    images = sorted([p for p in lesson_dir.iterdir()
                     if p.suffix.lower() in ('.jpg', '.jpeg', '.png')])
    if not images:
        print(f'目录中没有图片：{lesson_dir}', file=sys.stderr)
        sys.exit(1)

    state = prepare(images, lesson_dir)
    summary = {
        'lesson': state['lesson'],
        'total': state['total'],
        'kept': state.get('keptCount', 0),
        'removed': state.get('removedCount', 0),
        'restored': len(state.get('restore', [])),
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
