<div align="center">

<h1>成都理工大学问渠学堂 PPT 整理复习系统</h1>

<h3>课件下载 → Markdown/LaTeX → 去重清洗 → AI 纠错 · 重点总结 · 知识链 → 复习工作台</h3>

<p>把问渠学堂录播课的 PPT 抓成本地图片，转成带公式的 Markdown，<br>
在自带工作台里对着课件复习、划词提问、织知识链；同一份文件丢进 Obsidian / ima 即可用</p>

<p>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-orange.svg"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20Web-informational">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-18%2B-339933">
</p>

</div>

按「课程 → 课次」批量下载成都理工大学问渠学堂（classroom.wqxt.cdut.edu.cn）录播课件的 PPT 图片，自动归类到本地目录。

> 重复点「下载」不会重复拉取：本地已存在且体积正常的图片会跳过，任务卡片会显示「跳过 N 张（本地已有）」。
> 同一课次的「转 MD」「生成笔记」「质量审计」等任务也有幂等保护：已有排队/进行中的相同任务会直接复用，不会重复排队；
> 审计在原文没变时会复用上次的知识点清单，跳过重复的 LLM 提取。
> 对话历史按课次存到 `<课次>.chat.json`（复习页右上「历史」可回看完整记录），阅读进度存在浏览器里，刷新都不丢。

```
downloads/
└── 电法勘探原理与方法/
    ├── 2026-09-14第3-4节/
    │   ├── 0001.jpg
    │   └── ...
    └── 2026-09-18第7-8节/
        └── ...
```

## 快速开始

> **第一次用？** 打开界面后右上角有「❓ 使用说明」（首次会自动弹出），
> 顶部还有一条四步流程条，会实时告诉你现在该点哪里：
> **① 登录 → ② 选课程下载 PPT → ③ 课次旁点「转 MD」 → ④ 点「复习」看笔记并自测**。
> 复习台里另一个「❓ 指南」解释了左笔记 / 右课件 / 右下 AI 的用法和每个按钮的作用。

**Windows 一键**：双击 `start.cmd` 启动（后台运行 + 自动开浏览器），`stop.cmd` 退出，
`update.cmd` 升级，`uninstall.cmd` 卸载；也可以用 `powershell -ExecutionPolicy Bypass -File wqppt.ps1 <start|stop|restart|status|update|uninstall>`。

**macOS 一键**：双击 `wqppt.command` 启动，`wqppt-stop.command` 退出；
命令行同 `bash wqppt.sh <start|stop|restart|status|update|uninstall [--purge]>`。

**手动**：

```bash
npm install
npm start
```

浏览器打开 <http://127.0.0.1:3901> → 点右上角「登录」→ 输入统一认证学号密码 → 选择课程下载。

### 一键启动 / 退出 / 升级 / 卸载

| 操作 | Windows | macOS / Linux |
| --- | --- | --- |
| 启动 | `start.cmd`（或 `wqppt.ps1 start`） | `wqppt.command`（或 `bash wqppt.sh start`） |
| 退出 | `stop.cmd` | `wqppt-stop.command` |
| 升级 | `update.cmd`（git pull + npm install） | `bash wqppt.sh update` |
| 卸载 | `uninstall.cmd`（默认保留 `downloads/`） | `bash wqppt.sh uninstall [--purge]` |

启动是「后台 + 日志写 `run/server.log` + 自动打开浏览器」；退出会先走 `POST /api/system/shutdown` 优雅关闭，
再确保后台浏览器进程一起结束。网页里也有对应的「设置 → 退出程序 / 检查更新 / 一键升级」按钮。

### 目录位置（PPT 与笔记可以分开放）

「设置 → 目录位置」里可以改两个路径，都支持「浏览…」调出系统文件夹选择框：

- **数据目录**：PPT 原始帧图片、清洗复核页、复习卡（默认 `downloads/`）
- **笔记目录**：Markdown、合成 PDF、公式素材图（默认与数据目录相同）

把笔记目录指向 Obsidian 库（例如 `D:\Obsidian\CDUT`），转出来的 `.md` + `.pdf` + `_assets/` 就直接躺在库里，
一边复习一边双链。网页里 md 走 `/notes/`、图片走 `/files/`，两个目录相同或分离都能正常工作。

### 一键导出 / 导入（为手机 / 平板客户端准备）

「设置 → 导出 / 导入」：

- **一键导出**：打包 zip，含 `manifest.json` + `notes/`（md、pdf、assets）+ `cards/`（复习卡）+ `chats/`（对话历史）；
  勾选「包含 PPT 原始图片」会额外带上 `images/`（体积大）；不想带对话历史就取消「包含对话历史」勾选。
- **一键导入**：把 zip 合并进当前目录，默认跳过已存在的文件，可勾选覆盖。

`manifest.json` 就是给未来移动端的接口约定：

```json
{
  "app": "wqppt", "format": 1, "version": "0.1.0",
  "counts": { "courses": 2, "lessons": 3, "notes": 3, "pdfs": 3, "assets": 143, "cards": 6, "chats": 3, "images": 0 },
  "courses": [{ "name": "地球物理测井原理", "lessons": [{ "name": "2026-09-15第7-8节", "pages": 2, "chars": 1606, "pdf": true, "cards": 3 }] }],
  "pages": [{ "dir": "地球物理测井原理/2026-09-15第7-8节", "pages": 2,
              "md": "notes/地球物理测井原理/2026-09-15第7-8节.md",
              "pdf": "notes/地球物理测井原理/2026-09-15第7-8节.pdf" }]
}
```

移动端只需读 `manifest.json` 渲染课程树、按 `pages` 定位课件页；
复习卡在 `cards/<课程>/<课次>.json`，结构与服务端一致（`front` / `back` / `due` / `interval` / `ease`）。
对话历史在 `chats/<课程>/<课次>.json`，结构 `{ v, updatedAt, messages: [{ role, content, at, ... }] }`。

### 可选：启用「转 Markdown」（复习/喂 AI 用）

把下载的课件图片转成带 LaTeX 公式的 Markdown（Pix2Text），供 Obsidian / AI agent 使用：

```powershell
# Windows（需 uv + Python 3.12）
powershell -ExecutionPolicy Bypass -File setup-p2t.ps1

# macOS / Linux
bash setup-p2t.sh
```

装好后，界面上每个课次目录旁会出现 **「转 MD」** 按钮，点击即转换（有 N 卡自动走 CUDA，否则 CPU）。

```bash
# 也可以直接命令行用（Windows）
.venv-p2t\Scripts\python.exe ppt2md.py "downloads/电波…/2026-09-28第3-4节" --device auto
# macOS / Linux
.venv-p2t/bin/python ppt2md.py "downloads/电波…/2026-09-28第3-4节" --device auto
```

#### 换机器 / 笔记本部署

`setup-p2t.ps1`（Windows）与 `setup-p2t.sh`（macOS / Linux）是跨机器脚本，台式机与笔记本通用：

| 机器 | 说明 |
| --- | --- |
| V100 / 老卡（sm_70） | ORT 锁 1.20.2 的原因：新版 ORT（1.26+）CUDA 内核不再包含 sm_70，会报 `no kernel image`；1.30 起还要求 CUDA 13 |
| RTX 20/30/40 系、笔记本卡（sm_86 / sm_89） | 同一套即可直接跑：已确认 ORT 1.20.2 内核含 sm_89，torch cu124 原生支持 Ada |
| Apple 芯片 Mac（M1~M4） | torch 走 **MPS**（Metal），ONNX（文字/公式识别）走 CPU —— 免配置，速度介于 N 卡与纯 CPU 之间 |
| 想更快 | 「设置 → 转 MD 并行页数」保持**自动**：按空闲显存算并行页数（模型基座 ~6.2G + 每页 ~1G，留 1.5G 余量）。实测 30 页 **147s → 80s（1.8×）**，输出与逐页转换逐字一致（版面分析自动串行） |
| Intel Mac / 无 N 卡 | 自动回落 CPU，功能完整但慢 3~5 倍 |

部署步骤（新机器上）：

```powershell
# 1. 克隆/复制项目后，装环境（一次性）
powershell -ExecutionPolicy Bypass -File setup-p2t.ps1

# 2. 自检：确认 GPU 链路真的生效（这一步很关键）
.venv-p2t\Scripts\python.exe tools\gpu-check.py --full
```

注意点：

- **只需要显卡驱动（R550+），不需要单独安装 CUDA Toolkit / cuDNN** —— torch 自带运行库，脚本会自动把它加进 DLL 搜索路径
- 混合显卡笔记本（核显 + 独显）如遇 GPU 没被使用：Windows 设置 → 显示 → 图形 → 把 python.exe 设为「高性能」
- 显存占用约 3.5GB，8GB 笔记本卡够用；与其他 GPU 程序（游戏/浏览器硬件加速）同时跑时会互抢

#### macOS 版说明

整套东西在 Mac 上是同一份代码，只有三处按平台自动切换：

| 环节 | Windows | macOS |
| --- | --- | --- |
| 浏览器 | 自动找 Edge / Chrome（`Program Files`） | 自动找 `/Applications` 与 `~/Applications` 下的 Edge / Chrome / Chromium / Brave |
| 推理设备 | torch + onnxruntime 走 CUDA | Apple 芯片 torch 走 **MPS**，onnxruntime 走 CPU；Intel Mac 全 CPU |
| 建环境 | `setup-p2t.ps1` | `bash setup-p2t.sh` |

上手步骤：

```bash
brew install node uv          # 没有 Homebrew 就先装 Homebrew；Apple 芯片务必装 arm64 版 Node
git clone https://github.com/ADA-quart/cdut-wqxt-review.git && cd cdut-wqxt-review
npm install
bash setup-p2t.sh             # 建 Pix2Text 环境（几分钟），末尾会跑自检
npm start                     # 打开 http://127.0.0.1:3901
```

Mac 上要注意的几点：

- **窗口同样是"隐藏"的**：真实 Edge/Chrome 进程照常跑（内核指纹必须是真的，否则过不了瑞数 WAF），窗口被 CDP 挪到屏幕外，
  但 **Dock 里会出现浏览器的图标**，这是正常的；点界面右上角「显示浏览器」可以随时唤出 / 隐藏。
- 想指定浏览器（比如只装了 Chrome）可以覆盖：`WQ_BROWSER="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm start`。
- 用的是独立 profile（`.edge-profile/`），**不会动你日常浏览器的书签和登录态**；Edge 和 Chrome 同时装着时优先用 Edge。
- 首次启动如果 macOS 弹「xxx 想接受传入的网络连接」，允许即可（调试端口只监听本机 127.0.0.1）。
- Apple 芯片跑「转 MD」比 V100 慢，但比纯 CPU 快；如果发现 `gpu-check.py` 报 MPS 不可用，多半是 Node/Python 装成了 Intel 版
  （用 `node -p process.arch` 和 `.venv-p2t/bin/python -c "import platform;print(platform.machine())"` 确认是 `arm64`）。

产物：

```
downloads/电法勘探原理与方法/
├── 2026-09-28第3-4节/            # 原始图片
├── 2026-09-28第3-4节.md          # 转换出的 Markdown（公式为 $...$ / $$...$$）
├── 2026-09-28第3-4节.pdf         # 课件图合成的 PDF（Obsidian 侧边翻页 / 传 ima 用）
└── 2026-09-28第3-4节_assets/     # 版面中的图形元素（按页分目录）
```

Markdown 每页顶部带有 `[[课次.pdf#page=N|第 N 页]]` 翻页链接：在 Obsidian 里分屏打开 PDF 后，
点链接即可让右侧 PDF 跳到对应页（配合 PDF++ 插件还有悬浮预览与页级反链）。

### 可选：转 MD 前去重清洗（默认开启）

问渠学堂的抓帧会有重复：同一页 PPT 内容逐条出现（渐进动画）时每变一次存一帧；
个别课次还会混入等待界面（二维码页）、桌面截图和空白过渡帧。实测 317 帧里连续冗余占 24%。

「转 MD」默认先清洗，规则：

- 丢弃空白/过渡帧（幻灯片区域内容密度 < 2.5%）
- 连续近重复帧（相邻帧几乎相同）保留**最后一帧**（渐进内容以最后一帧为准），其余移出转换队列
- **原始图片不删除**，只影响转 MD/PDF 使用哪些帧

被移除的帧会**移进回收站** `<课程目录>/_回收站/<课次>/`（不是删除，随时可拉回）。
每次清洗会生成**人工复核页面** `<课次>.dedup.html`：

- 全部帧按网格平铺，每张图下面一个**「清理」复选框**：自动识别的重复 / 空白 / 二维码帧**默认勾选**，勾选 = 清理（红框标出）、取消勾选 = 保留
- 还能**手动补勾**——发现没清到的帧直接勾上，保存后一并丢进回收站；误判的取消勾选即可放回
- 点「保存选择」立即生效（移动文件），「全部清理 / 全部保留」可一键重置
- 回到下载器重新「转 MD」即用新名单；复核页使用动态图片接口，文件在回收站/目录间移动后打开页面依然正常

操作入口：文件树里每个课次有「清洗」按钮（只做预检并打开复核页，很快）；
「已下载文件」面板顶部的「去重」勾选框控制转 MD 是否先清洗（默认开，记忆设置）。

### 可选：LLM 纠错与重点总结

OCR 会有零星错字（如「也位差」→「电位差」）。界面提供两个操作（每个课次目录旁）：

- **纠错**：逐页让 LLM 修正 OCR 错字，公式/图片/链接/结构一律不动；结构校验不通过的页自动保留原文。
  首次执行会备份原始 OCR 结果到 `课次.ocr-backup.md`（可随时用「转 MD」重新生成）。
- **总结**：分块提取要点再合并，生成「重点总结」插入 md 顶部（`<!-- llm-summary:start/end -->` 区块，可反复重新生成）。

纠错有三档模式（右上角「LLM 设置」里配置，每档独立填 API Key）：

| 模式 | 说明 | token 量级（77 页/节） |
| --- | --- | --- |
| 纯文本（默认） | 只发 OCR 文字 | 约 5–8 万 |
| 图片上云 | 页面截图 + 文字发云端视觉模型，按截图校对术语/公式 | 约 15–18 万（5–10×） |
| 图片本地 | 发给本机推理服务（Ollama / vLLM），零 API 费用 | —— |

任务卡片会实时显示 token 用量（输入+输出）。配置示例：

```
纯文本    https://api.deepseek.com/v1            deepseek-chat
图片上云  https://dashscope.aliyuncs.com/compatible-mode/v1   qwen-vl-max
图片本地  http://127.0.0.1:11434/v1              qwen2.5vl:7b   （Ollama，key 随便填）
```

每档都有两个按钮：

- **测试连接**：先保存，再发一条探测请求确认能通
- **拉取模型列表**：调 `GET {接口地址}/models`（OpenAI 兼容接口都有），把可用模型填进输入框的候选列表，点输入框即可选，
  也可以继续手填。DeepSeek / OpenAI / DashScope 兼容模式 / Ollama（`/v1/models`）都支持

> 推理型模型（如 DeepSeek 的 `deepseek-v4-pro`）会把 token 先花在思考上：
> 探测请求的 `max_tokens` 给太小会返回空，程序会提示"推理型模型把 token 用在了思考上"。
> 日常的纠错/总结已经预留了足够的输出空间，直接选它用即可。

配置保存在本机 `config.json`（已 gitignore）。

### 复习工作台（左笔记 / 右课件 / 右下 AI 对话）

课次转完 MD 后，在文件树点「复习」（或任务卡片的「复习」）打开 `/review.html?dir=<课程/课次>`。

- 左侧渲染 Markdown（KaTeX 公式、`[[wiki 链接]]` 可点击、页链接联动右侧课件）
- 右上课件翻页：缩略图 / 上一页下一页 / ← → 快捷键 / 「跟随滚动」自动切页
- 右下 AI 对话：流式输出，可勾选「附带当前页」把正在读的那页内容一起发给模型；
  作用域可选 **本课 / 本课程 / 全库**——选后两者时先做知识库检索，回答带 `[n]` 引用角标与「引用来源」列表，
  点来源/角标直接跳到对应课次的对应页（ima 式全库问答）
- 顶栏「图谱」：全库力导向知识图谱（课程 / 课次 / `[[双链]]` / 课程关联），点节点进入对应笔记
- 顶栏「搜索」（Ctrl+K）：全库检索（LLM 语义扩展 + 页级片段），点结果直达那一页
- 顶栏「标签」：全库 `#标签` 汇总（标题行里的标签也算），点标签列出课次
- 笔记里的 `[[链接]]` 悬停 0.3 秒 → 弹出目标课次的摘要 + 首图预览
- 支持 Obsidian 块引用：行尾写 `^块名` 即为锚点，`[[课次#^块名]]` 跳转高亮，`![[课次#^块名]]` 直接嵌入内容
- 选中笔记或对话中的文字 → 浮出「引用到提问 / 解释这段」
- 分隔条可拖拽，布局比例记忆在本机

#### 复习队列（间隔重复）

课件区右上角给当前页打标：**⭐ 重点 / ❓ 错题 / ✓ 已掌握**，页面左上会出现对应角标。
顶栏「复习」按钮上的红色数字 = 今天到期待复习的卡片数；抽屉里逐张过：

| 按钮 | 排期（简化版 SM-2） |
| --- | --- |
| 再来一次 | 10 分钟后再来，熟练度 -0.2 |
| 有点难 | 间隔 ×1.2，熟练度 -0.15 |
| 记住了 | 间隔 ×熟练度（默认 2.5） |
| 太简单 | 间隔 ×熟练度 ×1.4，熟练度 +0.15 |

课件区还有 **🧠 出题**：AI 按当前页生成「先问后答」问答卡（检索练习），自动入队。
问答卡在复习抽屉里默认只显示问题，点「显示答案」再核对；还可点「我来复述（费曼）」——用自己的话讲一遍，AI 对照课件指出**缺漏 / 不准确 / 追问**。

卡片数据存在 `downloads/.review/<课程>/<课次>.json`（不进文件树、不参与检索）。
「导出 MD」得到可贴进 Obsidian / ima 的复习清单，「复制 CSV」可直接导入 Anki 或 Excel。

复习页里的 AI 功能（使用 LLM 设置的**纯文本档**）：

| 按钮 | 作用 |
| --- | --- |
| 整理重点 | 整节课交给 LLM，生成「重点总结」写回笔记顶部（核心概念 / 关键公式 / 易错点） |
| 修公式 | 用 KaTeX 逐条体检笔记里的公式，把解析不了（OCR 识别坏）的交给 LLM 重写，改完再验一遍才写回（原文件备份为 `.math-backup.md`） |
| 生成笔记 | 把原文按「每段最多 10 页 / 约 5200 字」分段，每段生成 1-3 个小节（带页码角标），拼成 `<课次>.note.md`；左栏「笔记 / 原文 md」可切换，点角标跳右侧课件对应页 |
| 知识链 → 本课程知识链 | AI 读全部课次摘要 → 生成按主题分组的课程索引，并给每节课补双向「相关课次」 |
| 知识链 → 课程间知识链 | AI 找课程间关联（同一方向 / 先修后继）→ 各课程索引互加「相关课程」，根目录生成「知识链.md」总览 |

知识链抽屉同时显示**出链**（本课引用了谁）与**反链**（谁引用了本课，全库扫描 wiki 链接）。
所有链接都是标准 `[[...]]`，同一份文件放进 Obsidian 即获得双链与图谱。

> 知识链由纯 LLM 生成：先把课次压缩成摘要，再让模型在单次调用里做全局关系推理（当前规模几千 token，成本极低）。
> 当课程/课次数百上千、摘要放不进上下文时，再引入 embedding 召回候选对 + LLM 复核（尚不需要）。

## 架构

```
public/            单页前端（原生 JS，零依赖）
server/
  index.mjs        Express 服务：REST API + SSE 进度推送 + 文件浏览
  browser.mjs      Edge 会话管理（见下方「为什么要用真实浏览器」）
  wqxt.mjs         业务层：登录 / 课程 / 课次 / PPT 清单
  downloader.mjs   下载任务管理：目录归类、并发下载、进度事件
  kb.mjs           知识库：按页切片的 BM25 风格检索 + 双链知识图谱
  paths.mjs        路径与文件名校验（防目录穿越）
.edge-profile/     独立 Edge 配置目录（登录态持久化，已 gitignore）
downloads/         下载产物（已 gitignore）
```

## 工作原理

### 1. 为什么必须用真实浏览器

问渠学堂全站启用瑞数式动态防护（WAF）：

| 方式 | 结果 |
| --- | --- |
| 直接 HTTP 请求（curl / Node fetch） | `412 Precondition Failed` 挑战页 |
| Playwright 默认启动 | 挑战 JS 执行后仍 `400` |
| 无头模式（`--headless=new`） | 同上，被识别 |
| **手动拉起真实 Edge + CDP 连接** | 正常访问 ✅ |

因此 `browser.mjs` 采用「以独立 profile 拉起用户本机真实 Edge，通过调试端口连接」的方式。登录态保存在 `.edge-profile/`，后续重启免登录。

**窗口不会打扰你**：Edge 进程照常运行（内核与指纹和普通 Edge 一致，这样才能过 WAF），
但窗口被 CDP 挪到屏幕外（约 `-21000, -21000`），平时完全看不见，也不会抢焦点。
需要手动操作时：

- 点右上角「**显示浏览器**」把它唤到屏幕中央，用完点「隐藏浏览器」挪回去；
- 点「登录」时会**自动唤出**（可能要输验证码），登录成功后自动隐藏。

对应 API：`POST /api/browser/show`、`POST /api/browser/hide`、`GET /api/browser/window`。

> 试过但行不通的路子：`--headless=new` 无头模式会被瑞数 WAF 识别（挑战 JS 执行后仍返回 400）；
> Playwright 自带 Chromium / Electron 之类"简化浏览器"指纹不同，同样被拦。
> 所以这里保留真实 Edge 内核，只把窗口挪出可视区域——既过检测，也不弹窗。

### 2. 数据流

```
CAS 统一认证登录（cas.paas.cdut.edu.cn）
  ↓
我的课程  /courseapi/v2/course-live/get-my-course-month?month=YYYY-MM
  ↓
课次目录  /courseapi/v2/course/catalogue?course_id=X
  ↓
PPT 清单  /pptnote/v1/schedule/search-ppt?course_id=X&sub_id=Y&page=1&per_page=200
  ↓
图片下载  video.wqxt.cdut.edu.cn/ai3/ppt/.../*.jpg（该域无 WAF，Node 并发直下）
```

业务接口全部在浏览器页面上下文内 `fetch`（同源、自动带 cookie，实测无需前端签名参数）；PPT 图片托管在独立域名，可直接 HTTP 并发下载。

### 2.1 PPT 图片 → Markdown（Pix2Text）

[Pix2Text](https://github.com/breezedeus/Pix2Text) 做版面分析 + 公式识别（MFD/MFR）+ 中文 OCR，
把整页课件图转成 Markdown，公式保留为 LaTeX。后端 `server/mdconvert.mjs` 以子进程方式调度
`ppt2md.py`，串行执行、逐行解析 JSONL 进度并通过 SSE 透传到前端。

### 3. 任务模型

- 粒度：一个「课程 × 课次」= 一个下载分组，一次批量提交为一个 Job
- 模式：`course`（整门课）/ `sub`（单课次）/ `all`（全部课程）
- 目录：`downloads/<课程名>/<课次标题>/0001.jpg`，按时间轴编号
- 进度：SSE 实时推送（`/api/events`），前端进度条 + 分组明细
- 并发：分组串行、组内 5 并发（对端限速且量小，降低风控触发概率）

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 浏览器与登录状态 |
| POST | `/api/browser/show` | 把 Edge 窗口唤到屏幕上（登录 / 验证码） |
| POST | `/api/browser/hide` | 把 Edge 窗口挪回屏幕外 |
| GET | `/api/browser/window` | 当前窗口是否在可见区域 |
| POST | `/api/login` | 触发登录 `{username, password}` |
| POST | `/api/logout` | 退出登录 |
| GET | `/api/terms` | 学期列表 |
| GET | `/api/courses?months=12` | 我的课程（按回溯月数） |
| GET | `/api/courses/:id/subs` | 课程课次列表 |
| GET | `/api/subs/:courseId/:subId/ppt` | 课次 PPT 图片清单 |
| POST | `/api/jobs` | 创建下载任务 `{mode, courseId?, subId?}` |
| GET | `/api/jobs` / `/api/jobs/:id` | 任务列表 / 详情 |
| POST | `/api/jobs/:id/cancel` | 取消任务 |
| GET | `/api/events` | SSE 进度推送 |
| GET | `/api/files` | 已下载文件树（`/files/*` 直接预览图片） |
| GET | `/api/md-tools` | 转换环境可用性（python / 脚本路径） |
| POST | `/api/md-jobs` | 创建转换任务 `{dir}`（downloads 下相对目录） |
| GET | `/api/md-jobs` / `/api/md-jobs/:id` | 转换任务列表 / 详情 |
| POST | `/api/md-jobs/:id/cancel` | 取消转换 |
| POST | `/api/dedup-scan` | 清洗预检 `{dir}` → 生成复核页并返回统计 |
| GET | `/api/dedup-state?dir=` | 复核页数据（帧列表 + 当前清理名单） |
| POST | `/api/dedup-decisions` | 保存清理名单 `{dir, remove:[...]}`（勾选 = 清理） |
| GET | `/api/dedup-image?dir=&name=` | 复核页图片（自动在课次目录 / 回收站查找） |
| GET/PUT | `/api/llm-config` | LLM 三档配置（不回传明文密钥） |
| POST | `/api/llm-test` | 测试某档连通性 `{profile}` |
| POST | `/api/llm-models` | 拉取模型列表 `{profile, baseUrl?, apiKey?}` → `GET {baseUrl}/models` |
| POST | `/api/llm-jobs` | LLM 任务 `{op:'proofread'|'summarize'|'weave', dir?, mode?, scope?}`（weave 织知识链） |
| GET | `/api/llm-jobs` / `/api/llm-jobs/:id` | LLM 任务列表 / 详情（含 token 用量） |
| POST | `/api/llm-jobs/:id/cancel` | 取消 LLM 任务 |
| POST | `/api/chat` | 复习页对话（流式透传，`{messages, profile}`） |
| POST | `/api/kb/search` | 知识库检索 `{q, scope:'lesson'\|'course'\|'all', dir, topK, smart}` → 带页码的片段与得分（`smart` 默认开：LLM 语义扩展） |
| GET | `/api/graph` | 知识图谱数据：课程 / 课次节点 + 包含 / 双链 / 课程关联边 |
| GET | `/api/tags` | 全库 `#标签` 汇总（含每个标签下的课次） |
| GET | `/api/preview?dir=` | 课次预览：摘要 + 首图（悬浮预览用） |
| GET | `/api/cards?dir=&due=1` | 复习卡列表 / 今日到期卡与数量 |
| POST | `/api/cards` | 新建卡片 `{dir, page, kind:'star'\|'wrong'\|'ok', text}` |
| POST | `/api/cards/gen-qa` | AI 出题：`{dir, page?, count?}` → 生成问答卡入库 |
| POST | `/api/cards/feynman` | 费曼回评：`{cardId|dir, page, answer}` → 缺漏/纠错/追问 |
| POST | `/api/cards/:id/grade` | 评分排期 `{grade:'again'\|'hard'\|'good'\|'easy'}` |
| DELETE | `/api/cards/:id` | 删除卡片 |
| GET | `/api/cards/export?format=md\|csv` | 导出复习清单（Markdown / CSV） |
| GET | `/api/paths` | 当前数据目录 / 笔记目录 |
| PUT | `/api/paths` | 修改目录 `{dataDir, notesDir}`（空字符串=回到默认） |
| POST | `/api/pick-folder` | 弹系统「选择文件夹」对话框 `{initial}` |
| GET | `/api/system/update-check` | 检查更新（git fetch + 比较落后提交数） |
| POST | `/api/system/update` | 一键升级（git pull --ff-only，必要时 npm install） |
| GET | `/api/export` | 一键导出 zip（`?images=1` 含原始图片，`?pdf=0&assets=0&cards=0&chats=0` 可裁剪） |
| POST | `/api/import` | 一键导入 zip（`?overwrite=1` 覆盖，`?force=1` 跳过 manifest 校验） |
| POST | `/api/system/shutdown` | 优雅退出（关闭服务 + 后台浏览器） |
| GET | `/api/backlinks?dir=` | 反链：全库扫描引用某课次的 wiki 链接 |
| POST | `/api/index-note` | 快速生成课程索引 `{dir}`（规则版，不含 AI；课程/课次目录均可，自动保留「相关课程」关联块） |

## 已验证结果

真实账号端到端测试（2026-10-03）：

- 登录：统一认证通过，返回学号与姓名
- 课程列表：12 个月回溯，返回 25 门课程
- 课次目录：单门课 24 个课次，回放状态区分正确
- 单课次下载：`地球物理测井原理 / 2026-09-01第7-8节` → 120 张图，0 失败
- 整课下载：`电法勘探原理与方法` → 4 个课次共 197 张图，0 失败
- 图片规格：1280×720 JPEG，单张约 60–140 KB
- 前端：课程列表、课次弹窗、任务进度、文件缩略图均正常渲染
- Markdown 转换：`2026-09-28第3-4节` 全量 77 页转换成功（V100 CUDA，约 9.6 分钟，平均 7.5s/页），
  产出 44 KB Markdown：48 个块公式 + 53 个行内公式（LaTeX）、97 处图形引用；公式识别准确率高，
  正文存在零星 OCR 笔误（如「电位差」→「也位差」），复习场景可读

去重清洗（2026-10-04 全量统计，317 帧）：

- 连续冗余帧 77/317（24%）：`地球物理测井原理` 34%、`电法勘探`三节 14~24%（多为渐进动画，末帧内容最全）
- 空白过渡帧 3 张；测井课另有 47 帧等待界面 + 5 帧云桌面截图混入
- 规则：空白帧丢弃、连续重复簇保留末帧；复核页全部帧网格平铺，勾选 = 清理（可手动补勾），保存即生效

LLM 功能（2026-10-04，真实 DeepSeek `deepseek-chat`）：

- 连通：432ms
- 整理重点（77 页课次）：输入 13,336 / 输出 943 tokens（约 ¥0.03），产出按主题分组、
  含 LaTeX 公式与「易错点提醒」的重点总结，公式与结论正确
- 本课程知识链（2 课次样本）：198 / 65 tokens；生成主题分组索引 + 双向「相关课次」
  （理由如「装置公式基于视电阻率基础」）
- 课程间知识链（3 课程样本）：257 / 103 tokens；生成「知识链.md」总览 + 各课程互链「相关课程」
- 复习工作台：77 个页节、121 处 KaTeX 渲染、77 张缩略图；划词菜单、反链、出链均正常

> 知识链采用纯 LLM 方案（摘要进上下文一次推理），当前规模不需要 embedding。

## 注意事项

- 需要本机安装 Microsoft Edge（脚本自动定位常见安装路径）
- 端口默认 `3901`，可用环境变量覆盖：`PORT=xxxx npm start`
- 下载目录可用软链接或直接拷贝 `downloads/`
- 仅用于下载本人账号有权访问的课件，请遵守学校相关使用规定
- 非官方工具，与成都理工大学无关

## 许可证

[PolyForm Noncommercial License 1.0.0](LICENSE) © 2026 ADA-quart

**个人使用与非商业用途免费**：个人学习、研究、实验、业余项目，以及学校、慈善机构、
公共研究机构等非营利组织，都可以自由使用、修改和分发。

**商业用途需另行授权**：包括但不限于在公司内部部署、作为付费产品或服务的一部分、
以及其他以商业获利为目的的使用。有商业授权需求请联系维护者。
