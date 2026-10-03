#!/usr/bin/env python
"""批量把课次目录的 PPT 图片转成 Markdown（含 LaTeX 公式）。

用法:
    python ppt2md.py "downloads/电法勘探原理与方法/2026-09-28第3-4节"
    python ppt2md.py <dir> [-o out.md] [--device cuda] [--limit N]
    python ppt2md.py <dir> --json      # 逐行输出 JSON 进度（供后端调用）
"""
import argparse
import json
import re
import shutil
import sys
import time
from pathlib import Path


def make_emitter(json_mode: bool):
    """返回 emit(obj, human) —— JSON 模式输出 JSONL，否则输出人类可读文本。"""

    def emit(obj=None, human=None):
        if json_mode:
            if obj is not None:
                print(json.dumps(obj, ensure_ascii=False), flush=True)
        elif human is not None:
            print(human, flush=True)

    return emit


def pick_device(requested: str) -> str:
    """解析 --device auto：有可用 CUDA 就用 cuda，否则回落 cpu。"""
    if requested != "auto":
        return requested
    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def collect_images(src: Path):
    exts = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
    files = [p for p in src.iterdir() if p.suffix.lower() in exts]

    def key(p):
        m = re.search(r"(\d+)", p.stem)
        return (int(m.group(1)) if m else 10**9, p.name)

    return sorted(files, key=key)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="课次图片目录")
    ap.add_argument("-o", "--out", default=None, help="输出 md 路径（默认与课次目录同级）")
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"], help="推理设备（auto=有 CUDA 就用）")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 张（0=全部）")
    ap.add_argument("--json", action="store_true", help="逐行输出 JSON 进度（供后端解析）")
    args = ap.parse_args()

    emit = make_emitter(args.json)
    device = pick_device(args.device)

    src = Path(args.src).resolve()
    if not src.is_dir():
        emit({"type": "error", "error": f"目录不存在: {src}"}, f"[!] 目录不存在: {src}")
        sys.exit(1)

    images = collect_images(src)
    if args.limit:
        images = images[: args.limit]
    if not images:
        emit({"type": "error", "error": f"{src} 中没有图片"}, f"[!] {src} 中没有图片")
        sys.exit(1)

    out_path = Path(args.out).resolve() if args.out else src.parent / f"{src.name}.md"
    assets_dir = out_path.parent / f"{out_path.stem}_assets"
    # 重跑时清掉旧素材，避免残留错页
    if assets_dir.exists():
        shutil.rmtree(assets_dir)

    emit({"type": "start", "total": len(images), "out": str(out_path)}, f"[i] 共 {len(images)} 张图 -> {out_path}")

    from pix2text import Pix2Text

    t0 = time.time()
    p2t = Pix2Text.from_config(device=device)
    emit(
        {"type": "ready", "secs": round(time.time() - t0, 1), "device": device},
        f"[i] 模型加载完成（{time.time()-t0:.1f}s, device={device}）",
    )

    parts = [f"# {src.name}\n"]
    t0 = time.time()
    ok = 0
    for i, img in enumerate(images, 1):
        ts = time.time()
        page_dir = assets_dir / f"p{i:04d}"
        try:
            page = p2t.recognize_page(str(img), return_text=True)
            md = page.to_markdown(out_dir=str(page_dir))
        except Exception as e:  # 单张失败不中断整批
            emit({"type": "skip", "i": i, "total": len(images), "name": img.name, "error": str(e)},
                 f"[!] {img.name} 失败: {e}")
            continue
        # to_markdown 生成了 <page_dir>/figures/xxx.jpg 与 <page_dir>/output.md
        # 单次正则替换 figures/ 或 figures\ 为相对 md 文件的 posix 路径（避免重复替换）
        import re as _re
        rel_prefix = f"{assets_dir.name}/p{i:04d}/figures/"
        md = _re.sub(r"figures[\\/]", rel_prefix, md)
        try:
            (page_dir / "output.md").unlink(missing_ok=True)
        except OSError:
            pass
        parts.append(f"\n<!-- page {i}: {img.name} -->\n")
        parts.append(md.strip() + "\n")
        ok += 1
        emit(
            {"type": "progress", "i": i, "total": len(images), "name": img.name, "secs": round(time.time() - ts, 1)},
            f"  [{i}/{len(images)}] {img.name} ({time.time()-ts:.1f}s)",
        )

    out_path.write_text("\n".join(parts), encoding="utf-8")
    emit(
        {"type": "done", "ok": ok, "total": len(images), "out": str(out_path),
         "assets": str(assets_dir), "secs": round(time.time() - t0, 1)},
        f"[OK] 完成：{out_path}（{ok}/{len(images)} 页, 总耗时 {time.time()-t0:.1f}s）",
    )
    emit(None, f"[i] 图素材：{assets_dir}")


if __name__ == "__main__":
    main()
