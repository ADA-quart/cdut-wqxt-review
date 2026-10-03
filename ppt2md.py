#!/usr/bin/env python
"""批量把课次目录的 PPT 图片转成 Markdown（含 LaTeX 公式）。

用法:
    python ppt2md.py "downloads/电法勘探原理与方法/2026-09-28第3-4节"
    python ppt2md.py <dir> [-o out.md] [--device cuda] [--limit N]
    python ppt2md.py <dir> --json      # 逐行输出 JSON 进度（供后端调用）

默认同时把课件图合成同名 PDF，并在 Markdown 每页顶部插入
`[[课次.pdf#page=N|第 N 页]]` 翻页链接（Obsidian + PDF++ 使用）。
"""
import argparse
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path


def _enable_ort_cuda():
    """让 ONNX Runtime 用上 GPU。

    背景：文本识别（CnOCR）与公式识别（LaTeX-OCR）走 onnxruntime，
    其 CUDA 提供者需要 cudnn64_9.dll / cublasLt64_12.dll。这两个 DLL 随 PyTorch 一起
    打包在 torch/lib 下，默认不在 DLL 搜索路径里，会导致 ORT **静默回落到 CPU**。
    这里把该目录加入搜索路径（必须在 import onnxruntime 之前执行）。
    """
    try:
        import torch

        lib = os.path.join(os.path.dirname(torch.__file__), "lib")
        if os.path.isdir(lib):
            os.environ["PATH"] = lib + os.pathsep + os.environ.get("PATH", "")
            if hasattr(os, "add_dll_directory"):
                os.add_dll_directory(lib)
    except Exception:
        pass  # 没装 torch 或没有 lib 目录时静默跳过，让 ORT 自行处理


_enable_ort_cuda()


def _patch_layout_device():
    """让版面分析（DocLayout-YOLO）真正跑在 GPU 上。

    背景：Pix2Text 的 DocYoloLayoutParser 存了 self.device，
    但调用 self.predictor.predict(...) 时没把 device 传下去，
    于是 YOLO 默认在 CPU 上推理（日志里能看到 100ms+ 的 CPU 速度）。
    这里给 parser 的 __init__ 打个补丁：拿到 predictor 后，
    把 device 注入后续每一次 predict 调用。
    """
    try:
        from pix2text.doc_yolo_layout_parser import DocYoloLayoutParser
    except Exception:
        return
    if getattr(DocYoloLayoutParser, "_device_patched", False):
        return

    orig_init = DocYoloLayoutParser.__init__

    def patched_init(self, *args, **kwargs):
        orig_init(self, *args, **kwargs)
        try:
            predictor = getattr(self, "predictor", None)
            device = getattr(self, "device", None)
            if predictor is None or not device or str(device) == "cpu":
                return
            orig_predict = predictor.predict

            def predict(*p_args, **p_kwargs):
                p_kwargs.setdefault("device", device)
                return orig_predict(*p_args, **p_kwargs)

            predictor.predict = predict
        except Exception:
            pass

    DocYoloLayoutParser.__init__ = patched_init
    DocYoloLayoutParser._device_patched = True


_patch_layout_device()


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


def build_pdf(images, pdf_path: Path):
    """把课次图片按序合成一个 PDF（供 Obsidian / ima 侧边展示）。返回页数。"""
    import pymupdf

    doc = pymupdf.open()
    try:
        for f in images:
            with pymupdf.open(str(f)) as img:
                rect = img[0].rect
                page = doc.new_page(width=rect.width, height=rect.height)
                page.insert_image(rect, filename=str(f))
        doc.save(str(pdf_path))
        return doc.page_count
    finally:
        doc.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="课次图片目录")
    ap.add_argument("-o", "--out", default=None, help="输出 md 路径（默认与课次目录同级）")
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"], help="推理设备（auto=有 CUDA 就用）")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 张（0=全部）")
    ap.add_argument("--json", action="store_true", help="逐行输出 JSON 进度（供后端解析）")
    ap.add_argument("--no-pdf", action="store_true", help="不生成课件 PDF、不插入翻页链接")
    ap.add_argument("--dedup", action="store_true", help="先清洗（空白帧/渐进重复），并生成人工复核页面")
    args = ap.parse_args()

    emit = make_emitter(args.json)
    device = pick_device(args.device)

    src = Path(args.src).resolve()
    if not src.is_dir():
        emit({"type": "error", "error": f"目录不存在: {src}"}, f"[!] 目录不存在: {src}")
        sys.exit(1)

    images = collect_images(src)
    report_path = None
    if args.dedup:
        import dedup as dedup_mod

        state = dedup_mod.prepare(images, src)
        kept_names = {fr["name"] for fr in state["frames"] if fr["keep"] or fr.get("restored")}
        removed = state["total"] - len(kept_names)
        images = [p for p in images if p.name in kept_names]
        report_path = dedup_mod.state_paths(src)[1]
        emit(
            {"type": "dedup", "total": state["total"], "kept": len(images), "removed": removed,
             "restored": len(state.get("restore", [])), "report": str(report_path)},
            f"[i] 清洗：保留 {len(images)}/{state['total']} 帧（移除 {removed}，已恢复 {len(state.get('restore', []))}），复核页面已生成",
        )
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

    # 先合成课件 PDF（百页约 0.5s），供 Obsidian 侧边预览与翻页链接使用
    pdf_path = None
    if not args.no_pdf:
        pdf_path = out_path.parent / f"{out_path.stem}.pdf"
        t_pdf = time.time()
        try:
            n_pages = build_pdf(images, pdf_path)
            emit({"type": "pdf", "pages": n_pages, "secs": round(time.time() - t_pdf, 2), "path": str(pdf_path)},
                 f"[i] 课件 PDF 已生成：{pdf_path.name}（{n_pages} 页, {time.time()-t_pdf:.2f}s）")
        except Exception as e:
            pdf_path = None
            emit({"type": "warn", "error": f"PDF 生成失败：{e}"}, f"[!] PDF 生成失败：{e}")

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
        if pdf_path is not None:
            parts.append(f"📄 [[{pdf_path.name}#page={i}|第 {i} 页]]\n")
        parts.append(md.strip() + "\n")
        ok += 1
        emit(
            {"type": "progress", "i": i, "total": len(images), "name": img.name, "secs": round(time.time() - ts, 1)},
            f"  [{i}/{len(images)}] {img.name} ({time.time()-ts:.1f}s)",
        )

    out_path.write_text("\n".join(parts), encoding="utf-8")
    emit(
        {"type": "done", "ok": ok, "total": len(images), "out": str(out_path),
         "assets": str(assets_dir), "pdf": str(pdf_path) if pdf_path else None,
         "report": str(report_path) if report_path else None,
         "secs": round(time.time() - t0, 1)},
        f"[OK] 完成：{out_path}（{ok}/{len(images)} 页, 总耗时 {time.time()-t0:.1f}s）",
    )
    emit(None, f"[i] 图素材：{assets_dir}")


if __name__ == "__main__":
    main()
