"""生成应用图标（Electron 窗口 / 任务栏）：深蓝圆角底 + 白色播放键 + 横线。

用法：python tools/make-icon.py
产物：electron/assets/icon.png、electron/assets/icon.ico
"""
from pathlib import Path

from PIL import Image, ImageDraw

out = Path(__file__).resolve().parent.parent / 'electron' / 'assets'
out.mkdir(parents=True, exist_ok=True)

S = 512
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([12, 12, S - 12, S - 12], radius=112, fill=(26, 84, 200, 255))
d.polygon([(192, 138), (192, 342), (362, 240)], fill=(255, 255, 255, 255))
d.rounded_rectangle([152, 388, 360, 416], radius=14, fill=(255, 255, 255, 215))

img.save(out / 'icon.png')
img.save(out / 'icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('icons written to', out)
