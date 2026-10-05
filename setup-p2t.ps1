# 创建 PPT → Markdown 转换环境（Pix2Text）。
#
# 适用机器：任意 NVIDIA 显卡（V100 / RTX 20~40 系 / 笔记本卡均可）；
#          无 N 卡时自动回落 CPU（可用，但慢很多）。
#
# 依赖：
#   - uv（https://docs.astral.sh/uv/）
#   - NVIDIA 驱动：CUDA 12.4 需要 R550 及以上（2024 年后的驱动基本都满足）
#   - 不需要单独安装 CUDA Toolkit / cuDNN —— torch 自带的运行库会被自动使用
#
# 用法：powershell -ExecutionPolicy Bypass -File setup-p2t.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host '[1/5] 创建虚拟环境 .venv-p2t (Python 3.12)...'
uv venv .venv-p2t --python 3.12

$py = Join-Path $root '.venv-p2t\Scripts\python.exe'

Write-Host '[2/5] 安装 pix2text（版面 / 表格 / 公式识别）...'
uv pip install --python $py pix2text

Write-Host '[3/5] 安装 CUDA 12.4 版 PyTorch（含 cuDNN 9 运行库）...'
uv pip install --python $py --reinstall-package torch --reinstall-package torchvision `
  torch torchvision --index-url https://download.pytorch.org/whl/cu124

# ORT 版本说明（2026-10 实测）：
#   - 1.30 / 1.29：要求 CUDA 13，CUDA 12 环境会静默回落 CPU
#   - 1.26 及以上：不再包含 V100(sm_70) 的 CUDA 内核，实际推理会报 "no kernel image"
#   - 1.20.2：CUDA 12 系、含 sm_70 与 sm_89 内核，V100 与 RTX 40 系均可正常使用
Write-Host '[4/5] 安装 GPU 版 ONNX Runtime（文本 / 公式识别用，锁 1.20.2）...'
uv pip install --python $py --reinstall-package onnxruntime-gpu `
  "onnxruntime-gpu==1.20.2" "numpy<2.3"

Write-Host '[5/5] 环境自检（确认 GPU 真的被使用）...'
& $py (Join-Path $root 'tools\gpu-check.py')

Write-Host ''
Write-Host '完成。之后可随时运行：.venv-p2t\Scripts\python.exe tools\gpu-check.py --full'
