#!/usr/bin/env bash
# 创建 PPT → Markdown 转换环境（Pix2Text）——macOS / Linux 版。
#
# 平台差异：
#   - Apple 芯片（M 系）：torch 走 MPS（Metal），onnxruntime 走 CPU —— 无需额外配置
#   - Intel Mac：全部走 CPU，可用但慢
#   - Linux + N 卡：torch/onnxruntime 走 CUDA（与 Windows 脚本一致，锁 ORT 1.20.2）
#
# 依赖：
#   - uv（macOS: brew install uv ／ 其它: https://docs.astral.sh/uv/）
#   - N 卡（仅 Linux）需要 R550+ 驱动；不需要单独装 CUDA Toolkit
#
# 用法：
#   bash setup-p2t.sh
#
# CUDA 版 torch 从 PyTorch 官方索引下载；国内网络连不上 download.pytorch.org 时，
# 可先用镜像（南京大学 / 上海交大）再执行：
#   PYTORCH_INDEX=https://mirror.nju.edu.cn/pytorch/whl/cu124 bash setup-p2t.sh
#   PYTORCH_INDEX=https://mirror.sjtu.edu.cn/pytorch-wheels/cu124 bash setup-p2t.sh

set -euo pipefail
cd "$(dirname "$0")"

OS="$(uname -s)"

if ! command -v uv >/dev/null 2>&1; then
  echo "找不到 uv。请先安装：macOS 用 'brew install uv'，其它平台见 https://docs.astral.sh/uv/" >&2
  exit 1
fi

echo "[1/5] 创建虚拟环境 .venv-p2t (Python 3.12)..."
uv venv .venv-p2t --python 3.12
PY=".venv-p2t/bin/python"

echo "[2/5] 安装 pix2text（版面 / 表格 / 公式识别）..."
uv pip install --python "$PY" pix2text

if [ "$OS" = "Darwin" ]; then
  echo "[3/5] 安装 PyTorch（macOS 默认包，Apple 芯片自带 MPS 支持）..."
  uv pip install --python "$PY" torch torchvision

  echo "[4/5] 安装 ONNX Runtime（CPU；macOS 没有 CUDA 版）..."
  uv pip install --python "$PY" --reinstall-package onnxruntime onnxruntime "numpy<2.3"
else
  TORCH_INDEX="${PYTORCH_INDEX:-https://download.pytorch.org/whl/cu124}"
  echo "[3/5] 安装 CUDA 12.4 版 PyTorch（含 cuDNN 9 运行库；索引：$TORCH_INDEX）..."
  # 注意：uv 的 --index-url 只是「追加」索引，默认索引（PyPI）仍优先，会把 torch 装成 CPU 版；
  #       必须用 --default-index 整体替换默认索引（issue #1）。
  uv pip install --python "$PY" --reinstall-package torch --reinstall-package torchvision \
    torch torchvision --default-index "$TORCH_INDEX"

  # ORT 版本说明（2026-10 实测）：
  #   - 1.30 / 1.29：要求 CUDA 13，CUDA 12 环境会静默回落 CPU
  #   - 1.26 及以上：不再包含 V100(sm_70) 的 CUDA 内核，实际推理会报 "no kernel image"
  #   - 1.20.2：CUDA 12 系、含 sm_70 与 sm_89 内核，V100 与 RTX 40 系均可正常使用
  echo "[4/5] 安装 GPU 版 ONNX Runtime（文本 / 公式识别用，锁 1.20.2）..."
  uv pip install --python "$PY" --reinstall-package onnxruntime-gpu \
    "onnxruntime-gpu==1.20.2" "numpy<2.3"
fi

echo "[5/5] 环境自检（确认加速器真的被使用）..."
"$PY" tools/gpu-check.py

echo
echo "完成。之后可随时运行：$PY tools/gpu-check.py --full"
