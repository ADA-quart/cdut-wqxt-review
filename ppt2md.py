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
import threading
import os
import re
import shutil
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


def _enable_ort_cuda():
    """让 ONNX Runtime 用上 GPU。

    背景：文本识别（CnOCR）与公式识别（LaTeX-OCR）走 onnxruntime，
    其 CUDA 提供者需要 cudnn64_9.dll / cublasLt64_12.dll。这两个 DLL 随 PyTorch 一起
    打包在 torch/lib 下，默认不在 DLL 搜索路径里，会导致 ORT **静默回落到 CPU**。
    这里把该目录加入搜索路径（必须在 import onnxruntime 之前执行）。

    仅 Windows 需要这段处理：
      - macOS 没有 CUDA，onnxruntime 直接走 CPU（Apple 芯片上 torch 侧的版面模型走 MPS）
      - Linux 由系统/conda 的 LD_LIBRARY_PATH 负责
    """
    if sys.platform != "win32":
        return
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

    # 版面分析（DocLayout-YOLO / ultralytics）不是线程安全的：
    # 并行转换时必须串行调用，否则同一页会被切出不同的版面（实测会把图表误当文字）
    layout_lock = threading.Lock()

    orig_init = DocYoloLayoutParser.__init__

    def patched_init(self, *args, **kwargs):
        orig_init(self, *args, **kwargs)
        try:
            predictor = getattr(self, "predictor", None)
            device = getattr(self, "device", None)
            if predictor is None:
                return
            orig_predict = predictor.predict
            use_gpu = bool(device) and str(device) != "cpu"

            def predict(*p_args, **p_kwargs):
                if use_gpu:
                    p_kwargs.setdefault("device", device)
                with layout_lock:
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
    """解析 --device auto：优先 CUDA（N 卡）→ Apple MPS（M 系芯片）→ CPU。"""
    if requested != "auto":
        return requested
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
        mps = getattr(torch.backends, "mps", None)
        if mps is not None and mps.is_available():
            return "mps"
        return "cpu"
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


def convert_one_page(p2t, img, i, page_dir, assets_name):
    """转换单页 → (页码, 文件名, markdown 文本, 耗时秒)。异常由调用方处理。"""
    ts = time.time()
    page = p2t.recognize_page(str(img), return_text=True)
    md = page.to_markdown(out_dir=str(page_dir))
    # to_markdown 生成的 figures/ 路径替换成相对 md 的 posix 路径
    import re as _re
    rel_prefix = f'{assets_name}/p{i:04d}/figures/'
    md = _re.sub(r'figures[\\/]', rel_prefix, md)
    try:
        (page_dir / 'output.md').unlink(missing_ok=True)
    except OSError:
        pass
    return i, img.name, md.strip(), time.time() - ts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="课次图片目录")
    ap.add_argument("-o", "--out", default=None, help="输出 md 路径（默认与课次目录同级）")
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "mps", "cpu"],
                    help="推理设备（auto=N 卡用 CUDA / Apple 芯片用 MPS / 否则 CPU）")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 张（0=全部）")
    ap.add_argument("--json", action="store_true", help="逐行输出 JSON 进度（供后端解析）")
    ap.add_argument("--no-pdf", action="store_true", help="不生成课件 PDF、不插入翻页链接")
    ap.add_argument("--dedup", action="store_true", help="先清洗（空白帧/渐进重复），并生成人工复核页面")
    ap.add_argument("--parallel", type=int, default=1, help="单节内并行转换的页数（1=串行；显卡没跑满时可设 2~3 提速）")
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
        remove_set = set(state.get("userRemove") or [])
        kept_names = {fr["name"] for fr in state["frames"] if fr["name"] not in remove_set}
        auto_removed = {fr["name"] for fr in state["frames"] if not fr["keep"]}
        restored = len(auto_removed - remove_set)
        removed = state["total"] - len(kept_names)
        images = [p for p in images if p.name in kept_names]
        report_path = dedup_mod.state_paths(src)[1]
        emit(
            {"type": "dedup", "total": state["total"], "kept": len(images), "removed": removed,
             "restored": restored, "report": str(report_path)},
            f"[i] 清洗：保留 {len(images)}/{state['total']} 帧（移除 {removed}，已恢复 {restored}），复核页面已生成",
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
    try:
        p2t = Pix2Text.from_config(device=device)
    except Exception as e:
        # 某些算子/旧版 torch 在 MPS 上会加载失败，直接回落 CPU 比整批失败好
        if device == "cpu":
            raise
        emit({"type": "warn", "error": f"{device} 加载失败，回落 CPU：{e}"},
             f"[!] {device} 加载失败，回落 CPU：{e}")
        device = "cpu"
        p2t = Pix2Text.from_config(device=device)
    emit(
        {"type": "ready", "secs": round(time.time() - t0, 1), "device": device},
        f"[i] 模型加载完成（{time.time()-t0:.1f}s, device={device}）",
    )

    parts = [f"# {src.name}\n"]
    t0 = time.time()
    ok = 0
    parallel = max(1, min(int(getattr(args, 'parallel', 1) or 1), 6))
    if parallel > 1:
        emit({"type": "parallel", "n": parallel}, f"[i] 单节内并行：{parallel} 页同时转换")

    results = {}   # 页码 -> (文件名, markdown)
    finished = 0
    total = len(images)

    def record(i, name, md, secs):
        nonlocal ok, finished
        results[i] = (name, md)
        ok += 1
        finished += 1
        emit(
            {"type": "progress", "i": finished, "done": finished, "total": total,
             "page": i, "name": name, "secs": round(secs, 1)},
            f"  [{finished}/{total}] {name} ({secs:.1f}s)",
        )

    if parallel <= 1:
        for i, img in enumerate(images, 1):
            try:
                page_dir = assets_dir / f"p{i:04d}"
                record(*convert_one_page(p2t, img, i, page_dir, assets_dir.name))
            except Exception as e:  # 单张失败不中断整批
                emit({"type": "skip", "i": i, "total": total, "name": img.name, "error": str(e)},
                     f"[!] {img.name} 失败: {e}")
    else:
        with ThreadPoolExecutor(max_workers=parallel) as ex:
            futures = {
                ex.submit(convert_one_page, p2t, img, i, assets_dir / f"p{i:04d}", assets_dir.name): (i, img)
                for i, img in enumerate(images, 1)
            }
            for fut in as_completed(futures):
                i, img = futures[fut]
                try:
                    record(*fut.result())
                except Exception as e:
                    emit({"type": "skip", "i": i, "total": total, "name": img.name, "error": str(e)},
                         f"[!] {img.name} 失败: {e}")

    for i in sorted(results):
        name, md = results[i]
        parts.append(f"\n<!-- page {i}: {name} -->\n")
        if pdf_path is not None:
            parts.append(f"📄 [[{pdf_path.name}#page={i}|第 {i} 页]]\n")
        parts.append(md + "\n")

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
