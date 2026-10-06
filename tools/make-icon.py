"""从正式 logo 派生 Electron 图标（任务栏 / 窗口 / 安装包）。

图标源：electron/assets/icon.png（1024×1024、透明圆角方形，即正式 logo 成品）。
本脚本只从它生成多尺寸 electron/assets/icon.ico，不再绘制旧版播放键图形。

用法：python tools/make-icon.py
"""
from pathlib import Path

from PIL import Image

assets = Path(__file__).resolve().parent.parent / 'electron' / 'assets'
src = assets / 'icon.png'
if not src.exists():
    raise SystemExit(f'缺少图标源文件：{src}')

img = Image.open(src).convert('RGBA')
img.save(
    assets / 'icon.ico',
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print('icon.ico regenerated from', src)
