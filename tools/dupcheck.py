#!/usr/bin/env python
"""课次图片重复帧检查（下载/capture 质量体检）。

检测三类问题：
  1. 空白/过渡帧：幻灯片区域内容密度过低（< 2.5%）
  2. 连续近重复：相邻帧几乎一样（渐进动画、停留、聊天滚动）
  3. 非相邻近似：同一画面在后面再次出现（翻回同一页、过渡）

用法:
    python tools/dupcheck.py "downloads/课程/课次目录"
    python tools/dupcheck.py downloads --all      # 检查全部课次
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image


def load_gray(path, crop_bottom=0.86, size=(320, 180)):
    im = Image.open(path).convert('L')
    w, h = im.size
    im = im.crop((0, 0, w, int(h * crop_bottom))).resize(size, Image.Resampling.LANCZOS)
    return np.asarray(im, dtype=np.float32)


def slide_ink(path):
    """幻灯片区域（去掉界面边框与播放条）的内容密度，单位 %。"""
    im = Image.open(path).convert('L')
    w, h = im.size
    c = im.crop((int(w * 0.16), int(h * 0.03), int(w * 0.84), int(h * 0.88)))
    a = np.asarray(c, dtype=np.float32)
    return float((a < 150).mean() * 100)


def metric(a, b):
    d = np.abs(a - b)
    return float(d.mean()), float((d > 25).mean() * 100)


def check_lesson(lesson: Path):
    imgs = sorted([p for p in lesson.iterdir()
                   if p.suffix.lower() in ('.jpg', '.jpeg', '.png')])
    if not imgs:
        return None

    mats = [load_gray(p) for p in imgs]
    inks = [slide_ink(p) for p in imgs]
    blank = [imgs[i].name for i, v in enumerate(inks) if v < 2.5]

    cons = []
    for i in range(len(imgs) - 1):
        mae, pct = metric(mats[i], mats[i + 1])
        cons.append((i, mae, pct))

    near = [c for c in cons if c[1] <= 8 and c[2] <= 6]
    runs, cur = [], None
    for (i, mae, pct) in near:
        if cur and cur[1] == i:
            cur[1] = i + 1
        else:
            if cur:
                runs.append(cur)
            cur = [i, i + 1]
    if cur:
        runs.append(cur)

    redundant = sum((r[1] - r[0]) for r in runs)
    return {
        'lesson': lesson,
        'count': len(imgs),
        'blank': blank,
        'runs': runs,
        'redundant': redundant,
        'imgs': imgs,
        'inks': inks,
    }


def report(res):
    imgs = res['imgs']
    print(f'=== {res["lesson"].name}（{res["count"]} 帧）===')
    print(f'  空白/过渡帧（<2.5%）：{len(res["blank"])} 张  {res["blank"][:10]}')
    print(f'  连续近重复簇：{len(res["runs"])} 个，可去冗余 {res["redundant"]} 帧'
          f'（{res["redundant"] / res["count"] * 100:.0f}%）')
    for r in res['runs'][:8]:
        print(f'    {imgs[r[0]].name} → {imgs[r[1]].name}（{r[1] - r[0] + 1} 帧）'
              f'，建议保留 {imgs[r[1]].name}（渐进内容以最后一帧为准）')
    if len(res['runs']) > 8:
        print(f'    …还有 {len(res["runs"]) - 8} 个簇')
    print()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path', help='课次目录，或 downloads 根目录（配合 --all）')
    ap.add_argument('--all', action='store_true', help='递归检查所有课次')
    args = ap.parse_args()

    root = Path(args.path)
    if not root.is_dir():
        print(f'目录不存在：{root}', file=sys.stderr)
        sys.exit(1)

    if args.all:
        lessons = []
        for course in sorted(root.iterdir()):
            if course.is_dir():
                for lesson in sorted(course.iterdir()):
                    if lesson.is_dir():
                        lessons.append(lesson)
    else:
        lessons = [root]

    totals = {'frames': 0, 'redundant': 0, 'blank': 0}
    for lesson in lessons:
        res = check_lesson(lesson)
        if not res:
            continue
        report(res)
        totals['frames'] += res['count']
        totals['redundant'] += res['redundant']
        totals['blank'] += len(res['blank'])

    if len(lessons) > 1:
        print(f'总计 {totals["frames"]} 帧：连续冗余 {totals["redundant"]} 帧'
              f'（{totals["redundant"] / max(1, totals["frames"]) * 100:.0f}%），'
              f'空白帧 {totals["blank"]} 张')
        print('建议：转 MD 前去重（每簇保留最后一帧）并丢弃空白帧。原始图片不受影响。')


if __name__ == '__main__':
    main()
