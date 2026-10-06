"""PDF 讲义 → 每页 JPG（供「导入自定义课件」使用）。

用法：python tools/pdf2images.py <input.pdf> <outdir> [--dpi 160] [--quality 88]
输出：outdir/0001.jpg, 0002.jpg, ...（文件名带页码数字，ppt2md.py 会按序处理）
"""
import argparse
import pathlib

import pymupdf
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("pdf")
ap.add_argument("outdir")
ap.add_argument("--dpi", type=int, default=160)
ap.add_argument("--quality", type=int, default=88)
args = ap.parse_args()

doc = pymupdf.open(args.pdf)
out = pathlib.Path(args.outdir)
out.mkdir(parents=True, exist_ok=True)
zoom = args.dpi / 72.0
matrix = pymupdf.Matrix(zoom, zoom)
count = 0
for i, page in enumerate(doc, 1):
    pix = page.get_pixmap(matrix=matrix, alpha=False)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    img.save(out / f"{i:04d}.jpg", "JPEG", quality=args.quality)
    count += 1
print(f"OK {count} pages")
