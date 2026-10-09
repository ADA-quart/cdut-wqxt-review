#!/usr/bin/env python
"""把课次音频转写成带时间戳的讲稿（faster-whisper）。

用法:
    python transcribe.py "downloads/弹性波动力学/2026-03-09第1-2节.m4a" -o "notes/弹性波动力学/2026-03-09第1-2节.trans.json"
    python transcribe.py <音频> [--model small|medium|large-v3] [--model-dir run/asr] [--device auto]
    python transcribe.py <音频> --json        # 逐行输出 JSON 进度（供后端调用）

为什么不用平台自带的语音识别：
  问渠学堂的「语音识别」只覆盖部分课次——2026-10-09 抽样 144 个课次，
  当学期新录的课次仅 14% 有结果（上学期 89%），正是需要笔记的时候没有。
  所以讲稿一律本地生成。

模型从 HF 镜像下载（huggingface_hub 在本机 Python 3.14 下不可用，改用 urllib 直取）。
"""
import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

MIRRORS = [
    os.environ.get("HF_MIRROR", "https://hf-mirror.com"),
    "https://huggingface.co",
]
# 只要权重和分词器，README/.gitattributes 不下载
SKIP_FILES = {".gitattributes", "README.md"}

# large-v3-turbo：809M 参数，速度接近 small、质量接近 large-v3，中文长音频首选
MODEL_REPOS = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "large-v2": "Systran/faster-whisper-large-v2",
    "large-v3": "Systran/faster-whisper-large-v3",
    "large-v3-turbo": "deepdml/faster-whisper-large-v3-turbo-ct2",
}


def log(msg, **extra):
    print(json.dumps({"type": "log", "msg": msg, **extra}, ensure_ascii=False), flush=True)


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def _http_get(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "qingqu/1.0"})
    return urllib.request.urlopen(req, timeout=timeout)


def repo_files(repo, mirror):
    with _http_get(f"{mirror}/api/models/{repo}", timeout=30) as r:
        data = json.load(r)
    return [s["rfilename"] for s in data.get("siblings", [])]


def download_file(url, dst, expect=None):
    """流式下载，返回字节数；下载中每 5% 报一次进度"""
    tmp = str(dst) + ".part"
    got = 0
    t0 = time.time()
    with _http_get(url, timeout=120) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0) or expect or 0
        last_pct = -1
        while True:
            chunk = r.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
            got += len(chunk)
            if total:
                pct = int(got * 100 / total)
                if pct >= last_pct + 5:
                    last_pct = pct
                    emit({"type": "download", "file": dst.name, "done": got, "total": total,
                          "speed": round(got / max(time.time() - t0, 0.1) / 1048576, 1)})
    os.replace(tmp, dst)
    return got


def ensure_model(model, model_dir, json_mode):
    """把模型文件下到本地目录（已存在则跳过），返回目录路径"""
    dest = Path(model_dir) / model
    dest.mkdir(parents=True, exist_ok=True)
    repo = MODEL_REPOS.get(model) or f"Systran/faster-whisper-{model}"

    missing = None
    for mirror in MIRRORS:
        try:
            files = [f for f in repo_files(repo, mirror) if f not in SKIP_FILES]
            missing = [f for f in files if not (dest / f).exists() or (dest / f).stat().st_size == 0]
            if not missing:
                return str(dest)
            log(f"模型文件缺 {len(missing)} 个，从 {mirror} 下载")
            for name in missing:
                download_file(f"{mirror}/{repo}/resolve/main/{name}", dest / name)
            return str(dest)
        except Exception as e:
            log(f"{mirror} 不可用：{type(e).__name__}: {str(e)[:120]}")
            continue
    raise RuntimeError(f"模型下载失败（{repo}），请检查网络或手动放入 {dest}")


def pick_device(requested):
    """auto：优先 CUDA（CTranslate2 自带依赖），失败回落 CPU int8"""
    if requested == "cpu":
        return [("cpu", "int8")]
    if requested == "cuda":
        return [("cuda", "float16")]
    return [("cuda", "float16"), ("cpu", "int8")]


def format_ts(sec):
    m, s = divmod(int(sec), 60)
    h, m = divmod(m, 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def main():
    ap = argparse.ArgumentParser(description="课次音频转写（faster-whisper）")
    ap.add_argument("audio", help="音频文件（m4a/wav/mp3）")
    ap.add_argument("-o", "--out", help="输出 JSON 路径（同目录同名 .trans.md 一并生成）")
    ap.add_argument("--model", default="large-v3-turbo", choices=list(MODEL_REPOS))
    ap.add_argument("--model-dir", default="run/asr", help="模型存放目录")
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--language", default="zh")
    ap.add_argument("--prompt", default="", help="初始提示词（课程名、专业术语，提升识别准确率）")
    ap.add_argument("--title", default="", help="讲稿标题（默认取音频文件名）")
    ap.add_argument("--json", action="store_true", help="逐行输出 JSON 进度")
    args = ap.parse_args()

    audio = Path(args.audio)
    if not audio.exists():
        raise SystemExit(f"音频不存在：{audio}")

    if args.json:
        sys.stdout.reconfigure(encoding="utf-8")

    t0 = time.time()
    model_dir = ensure_model(args.model, args.model_dir, args.json)
    emit({"type": "model-ready", "dir": model_dir, "secs": round(time.time() - t0, 1)})

    from faster_whisper import WhisperModel

    last_err = None
    for device, compute in pick_device(args.device):
        try:
            t_load = time.time()
            model = WhisperModel(model_dir, device=device, compute_type=compute)
            emit({"type": "ready", "device": f"{device}/{compute}", "secs": round(time.time() - t_load, 1)})
            break
        except Exception as e:
            last_err = e
            emit({"type": "log", "msg": f"{device}/{compute} 不可用：{str(e)[:120]}"})
    else:
        raise SystemExit(f"没有可用的推理设备：{last_err}")

    t_run = time.time()
    segments, info = model.transcribe(
        str(audio),
        language=args.language or None,
        vad_filter=True,                    # 跳过长静音，避免幻觉
        beam_size=5,
        condition_on_previous_text=False,   # 防止错误跨段累积
        initial_prompt=args.prompt or None,
    )
    total = float(getattr(info, "duration", 0) or 0)
    emit({"type": "start", "duration": total, "language": info.language})

    out_segments = []
    for seg in segments:
        out_segments.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": seg.text.strip()})
        if len(out_segments) % 5 == 0:
            emit({"type": "progress", "done": round(seg.end, 1), "total": round(total, 1),
                  "segments": len(out_segments)})
    elapsed = time.time() - t_run

    emit({"type": "progress", "done": round(total, 1), "total": round(total, 1), "segments": len(out_segments)})
    result = {
        "audio": str(audio),
        "model": args.model,
        "device": f"{device}/{compute}",
        "language": info.language,
        "duration": round(total, 1),
        "elapsed": round(elapsed, 1),
        "segments": out_segments,
    }

    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
        title = args.title or audio.stem
        lines = [
            f"# {title} 讲稿",
            "",
            f"> 本地转写 faster-whisper {args.model}（{device}/{compute}）｜时长 {format_ts(total)}"
            f"｜{len(out_segments)} 段｜耗时 {elapsed / 60:.1f} 分钟",
            "",
        ]
        for seg in out_segments:
            if seg["text"]:
                lines.append(f"**[{format_ts(seg['start'])}]** {seg['text']}")
        md_path = out_path.with_suffix(".md") if out_path.suffix == ".json" else out_path.with_name(out_path.name + ".md")
        md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        result["json"] = str(out_path)
        result["md"] = str(md_path)

    emit({"type": "done", **{k: result[k] for k in ("duration", "elapsed", "json", "md")},
          "segments": len(out_segments), "device": f"{device}/{compute}"})


if __name__ == "__main__":
    main()
