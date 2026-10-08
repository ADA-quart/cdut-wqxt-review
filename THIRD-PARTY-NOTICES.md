# 第三方开源组件与协议清单

清渠（wqppt）直接使用的第三方开源组件、地址与协议如下。各组件版权归其作者所有；
清渠自身的代码以 [PolyForm Noncommercial 1.0.0](LICENSE) 发布，不改变下列组件的原有协议。

未逐一列出的传递依赖（各组件自身依赖的库），遵循其各自仓库的许可。

## 桌面端 / 服务端（Node.js）

| 组件 | 用途 | 地址 | 协议 |
| --- | --- | --- | --- |
| Express 5 | 本地 HTTP 服务 | <https://github.com/expressjs/express> | MIT |
| Electron 44 | 桌面壳（可选） | <https://github.com/electron/electron> | MIT |
| adm-zip | 导出 / 导入 zip | <https://github.com/cthackers/adm-zip> | MIT |
| Playwright（playwright-core） | 驱动 Edge 登录会话、渲染笔记 PDF | <https://github.com/microsoft/playwright> | Apache-2.0 |

## 前端内置（public/vendor，随页面分发）

| 组件 | 用途 | 地址 | 协议 |
| --- | --- | --- | --- |
| KaTeX | 公式渲染（含字体） | <https://github.com/KaTeX/KaTeX> | MIT |
| marked | Markdown 渲染 | <https://github.com/markedjs/marked> | MIT |
| JSZip | 浏览器端 zip 解析（App 导入内容包） | <https://github.com/Stuk/jszip> | MIT 或 GPL-3.0-or-later（双许可） |

## 安卓 App（Capacitor）

| 组件 | 用途 | 地址 | 协议 |
| --- | --- | --- | --- |
| Capacitor（core / android / cli） | Web 资源打包为安卓 App | <https://github.com/ionic-team/capacitor> | MIT |
| @capacitor/app | 版本信息、返回键处理 | 同上 | MIT |
| @capacitor/browser | 外部链接兜底（正常流程不触发） | 同上 | MIT |
| @capacitor/filesystem | 文件导入导出 | 同上 | MIT |

## Python 转换环境（setup-p2t 脚本安装）

| 组件 | 用途 | 地址 | 协议 |
| --- | --- | --- | --- |
| Pix2Text | PPT 图片 → Markdown（含公式） | <https://github.com/breezedeus/Pix2Text> | MIT |
| PyTorch | 深度学习运行时（Pix2Text 依赖） | <https://github.com/pytorch/pytorch> | BSD-3-Clause |
| torchvision | 视觉工具（Pix2Text 依赖） | <https://github.com/pytorch/vision> | BSD-3-Clause |
| ONNX Runtime（onnxruntime-gpu） | 文本 / 公式识别推理 | <https://github.com/microsoft/onnxruntime> | MIT |
| NumPy | 数值计算 | <https://github.com/numpy/numpy> | BSD-3-Clause |
| Pillow | 图像处理 | <https://github.com/python-pillow/Pillow> | MIT-CMU |
| **PyMuPDF** | **导入 PDF 课件 → 逐页图片（tools/pdf2images.py）** | <https://github.com/pymupdf/PyMuPDF> | **AGPL-3.0 或 Artifex 商业许可（双许可）** |

> Pix2Text 首次运行会下载其模型文件，模型的许可随对应模型仓库（HuggingFace / ModelScope）而定。

## 运行时与外部程序（不随本项目分发）

| 组件 | 用途 | 地址 | 协议 |
| --- | --- | --- | --- |
| Node.js 18+ | 服务端运行环境 | <https://github.com/nodejs/node> | MIT |
| Python 3.12 | 转换脚本运行环境 | <https://github.com/python/cpython> | PSF-2.0 |
| uv | Python 环境 / 包管理 | <https://github.com/astral-sh/uv> | Apache-2.0 / MIT |
| Microsoft Edge | 登录会话（问渠学堂动态防护）+ 笔记 PDF 渲染 | <https://www.microsoft.com/edge> | 专有（非开源） |
| Microsoft PowerPoint | 导入 PPT/PPTX 时调用本机导出每页图（可选） | — | 专有（非开源） |

## 特别说明

- **PyMuPDF（AGPL-3.0）**：仅在你使用「导入自定义课件 → PDF」时被本地调用。AGPL 要求
  分发包含它的软件时提供对应源代码；如果你计划把清渠打包分发给他人，请先评估该条义务，
  或改用宽松许可的替代库（如 pypdfium2，BSD/Apache 系）。
- **JSZip 双许可**：按 MIT 使用即可。
- 构建 / CI（GitHub Actions 及其官方 actions）仅用于出包，不随软件分发。
