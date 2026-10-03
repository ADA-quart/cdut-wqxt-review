# 创建 PPT → Markdown 转换环境（Pix2Text）。
# 需要先安装 uv（https://docs.astral.sh/uv/）与 Python 3.12。
#
# 用法：powershell -ExecutionPolicy Bypass -File setup-p2t.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host '[1/4] 创建虚拟环境 .venv-p2t (Python 3.12)...'
uv venv .venv-p2t --python 3.12

$py = Join-Path $root '.venv-p2t\Scripts\python.exe'

Write-Host '[2/4] 安装 pix2text（含版面/表格/公式识别）...'
uv pip install --python $py pix2text

Write-Host '[3/4] 安装 CUDA 版 PyTorch（V100 等 N 卡；无 N 卡可跳过此步，脚本会自动回落 CPU）...'
uv pip install --python $py --reinstall-package torch --reinstall-package torchvision `
  torch torchvision --index-url https://download.pytorch.org/whl/cu124

Write-Host '[4/4] 安装 GPU 版 ONNX Runtime（公式识别用）...'
uv pip install --python $py --reinstall-package onnxruntime-gpu onnxruntime-gpu "numpy<2.3"

Write-Host ''
Write-Host '完成。验证：'
& $py -c "import torch, onnxruntime as ort; print('torch cuda:', torch.cuda.is_available()); print('ort providers:', ort.get_available_providers())"
