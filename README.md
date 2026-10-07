<div align="center">

<img src="public/icons/icon-192.png" width="104" alt="清渠">

<h1>清渠</h1>

<h3>成都理工大学问渠学堂 · 课件整理与复习系统</h3>

<p>登录下载 → 去重清洗 → 转 MD → 校订 → AI 深度笔记 → 复习自测（审计 · 知识链 · 安卓端）</p>

<p>把问渠学堂录播课的 PPT 抓成本地图片，转成带公式的 Markdown，<br>
用 AI 整理成「有讲解、带习题答案、能自测」的深度笔记；<br>
在桌面复习台或安卓 App 里对着课件复习，笔记可导出 PDF、打包同步到手机 / 平板，<br>
或直接丢进 Obsidian / ima。</p>

<p>
  <a href="https://github.com/ADA-quart/cdut-wqxt-review/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/ADA-quart/cdut-wqxt-review"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-orange.svg"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Web%20%7C%20Android-informational">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-18%2B-339933">
</p>

<p>
  <a href="https://github.com/ADA-quart/cdut-wqxt-review/releases/latest"><b>📱 下载安卓 App（平板优先 · 横竖屏自适应）</b></a>
</p>

</div>

> 重复点「下载」不会重复拉图（已存在且正常的图片自动跳过）；同一课次的「转 MD」「生成笔记」「质量审计」也是幂等的——已有进行中的任务会直接复用，不会重复烧 GPU / token。审计在原文没变时会复用上次的知识点清单，生成笔记会复用整理稿缓存。

## 快速开始

四种打开方式，任选其一：

| 方式 | 怎么启动 |
| --- | --- |
| Windows 网页版 | 双击 `start.cmd`（后台运行 + 自动开浏览器）；`stop.cmd` 退出 |
| macOS 网页版 | 双击 `wqppt.command`；`wqppt-stop.command` 退出 |
| 桌面软件（Electron） | 双击 `启动复习软件.vbs`（Windows）/ `启动复习软件.command`（macOS）；命令行 `npm run app` |
| 手动 | `npm install && npm start` → 打开 <http://127.0.0.1:3901> |

升级 / 卸载：`update.cmd` / `uninstall.cmd`（macOS 用 `bash wqppt.sh update|uninstall`）。
网页里也有对应按钮：设置 → 检查更新 / 一键升级 / 退出程序。

### 第一次使用：五步

1. **登录**：右上角「登录」输入统一认证学号密码（可能弹浏览器过验证码，过完自动躲回屏幕外，可用 设置→显示浏览器 唤出）。
2. **下载**：勾选课程 → 「下载所选」；或点「课次」只下某一次课。已下架课程自动跳过。
3. **清洗（建议）**：课程行点「批量清洗」或课次点「清洗」——录播抓帧有大量重复/等待页，复核页里看到不该删的取消勾选即可。
4. **转 MD**：课程行「批量转 MD」（只转没转过的）或课次点「转 MD」。图片 → 带 LaTeX 公式的 Markdown + 课件 PDF。**首次需装转换环境（见下）**。
5. **生成笔记 + 复习**：进复习台点「生成笔记」（AI 三遍加工出深度笔记），然后用「复习」队列做间隔重复自测。

> 生成笔记读的是**当前磁盘上的 md**——先「校订」就用校对后的文本，质量更好；没校订也能用，整理阶段会顺手改顺明显错字。

### 安装转换环境（转 MD 用，一次性）

```powershell
# Windows（需 uv + Python 3.12；有 N 卡自动走 CUDA，否则 CPU）
powershell -ExecutionPolicy Bypass -File setup-p2t.ps1
```

```bash
# macOS / Linux
bash setup-p2t.sh
```

装好后课次旁才会出现可用的「转 MD」。也可以命令行直接转：

```bash
.venv-p2t/Scripts/python.exe ppt2md.py "downloads/课程/课次" --device auto   # Windows
.venv-p2t/bin/python ppt2md.py "downloads/课程/课次" --device auto           # macOS
```

### 换机器 / 笔记本部署

1. 克隆或复制项目，跑 `npm install`；
2. 装转换环境（上面两条命令之一）；
3. 拷贝 `config.json`（LLM / 目录配置）与 `downloads/`（已有数据）；
4. `start.cmd` 或 `npm start`。同一局域网内手机/平板可访问 `http://电脑IP:3901`。

### macOS 说明

- 双击 `wqppt.command` 启动；转换环境用 `setup-p2t.sh`（Apple 芯片自动走 MPS）。
- 浏览器定位：macOS 用系统 Chrome/Edge 的真实内核做登录（自动查找常见路径，可用环境变量 `WQ_BROWSER` 手动指定）。

## 📱 安卓 App（平板优先）

桌面端负责「重活」（下载、OCR、清洗、生成笔记），App 负责「随身复习」——把电脑整理好的内容带在身上，离线看。

**安装**：[Releases](https://github.com/ADA-quart/cdut-wqxt-review/releases/latest) 下载 `qingqu-x.y.z.apk`（CI 自动构建、固定签名，新版本可直接覆盖安装升级）。

**使用流程**

1. 电脑端「设置 → 导出」导出「**内容包**」（笔记 + 课件图；首次全量、日常按课程 / 单课增量导出）；
2. 可选：再导一个「**学习记录包**」（进度 + ⭐❓✓ 标记 + 对话，体积几 KB）；
3. 把 zip 传到平板 / 手机，App 内点「**＋ 导入内容包**」；
4. 之后完全离线使用，打开课次即复习。

**App 里能做什么**

- 笔记阅读（公式渲染、目录、页码角标、知识链）、课件翻页
- 阅读进度自动记录、⭐ 重点 / ❓ 错题 / ✓ 掌握、复习队列（间隔重复）
- 历史对话查看；三主题（跟随系统 / 浅色 / 深色 / 护眼暖纸）、正文字号四档、20-20-20 护眼提醒

**设计与边界**

- 手机 / 平板的**横屏竖屏均可**：手机竖屏为单列（笔记 → 课件 → 对话）、宽屏为两栏、平板横屏信息密度最佳；
- 电脑端专属功能（下载、转 MD、生成笔记、校订）在 App 内**自动隐藏**；
- 内容存 App 私有存储（IndexedDB），相册 / 文件管理器都看不到；导入后**原压缩包可删**，学习记录存在本机；
- 多次导入同一门课 = 增量合并（按课次版本比对，新增 / 更新 / 跳过）。

## 功能地图

### 下载器（管理端）

- **登录**：统一认证；后台浏览器平时在屏幕外，需要时在 设置 → 显示浏览器 唤出。
- **课程**：学期筛选、全选、勾选批量下载、单课次弹窗（预览图片 / 下载此课次 / **强制重新下载**）、整课下载。
- **强制重新下载**（课次弹窗里勾选）：目录里已有的图**覆盖更新**；已被清洗移入回收站的帧**不会拉回**；服务器已没有的多余旧帧移入 `_回收站/_旧帧备份/`（不会被清洗自动归位）。
- **文件树**：课次级按钮「清洗 / 转 MD / 复习 / 校订 / 复核 / 删除」（行首复选框可**多选批量删除**）；**课程级批量按钮**「批量清洗 / 批量转 MD / 批量生成笔记」（自动跳过已完成项，任务串行排队）。
- **任务卡片**：SSE 实时进度、跳过/失败统计、取消。

### 导入自定义课件

老师发的、自己找的课件也能进同一套流水线（转 MD → 清洗 → 生成笔记 → 复习）：

- 支持 **PPT / PPTX**（调用本机 PowerPoint 静默导出每页图）、**PDF**（逐页渲染，可选 160 / 220 dpi——扫描件、图片拼合的 PDF 选高清）、**图片**（多选按文件名顺序合成一节课）；
- 入口：已下载文件面板右上「＋ 导入课件」，填课程名（选已有或新建）+ 课次名，导入后即是普通课次。

### 删除与回收站

- 课次「删除」或勾选多个「删除所选」：**移入回收站**（`downloads/_回收站/`），不是真删；
- 弹窗里两档勾选：课件与转换文件 / 学习记录（整理稿、对话、复习卡**默认保留**）；
- 设置 →「回收站」：可**恢复**（原路返回）或**彻底删除**，也能一键清空。

### 清洗（去重）

- 规则：空白帧丢弃、连续重复簇保留末帧（渐进动画）、等待页/二维码整段移除。
- **复核页**：全部帧网格平铺——**勾选 = 清理（红框标出）、取消 = 保留**；发现没清到的直接补勾，「全部清理 / 全部保留」一键重置，保存即生效。
- 被清理的帧进 `_回收站/<课次>/`，随时取消勾选拉回；你的勾选名单会跨次沿用。

### 转 MD（课件数字化）

- Pix2Text 把图片 OCR 成 Markdown（公式保留 LaTeX），图形抽屉到 `<课次>_assets/`；
- 同时把课件图合成为 `<课次>.pdf`（图片合订本，供 Obsidian / ima 侧边翻页），md 每页顶部带 `[[课次.pdf#page=N]]` 翻页链接；
- 单任务内按显存自动并行（设置里可调）。

### 校订（纠错 + 修公式）

- 一次跑完两步：① 逐页修正 OCR 错字（图片/链接/结构不动，校验不过的页保留原文）→ ② 修复 KaTeX 解析不了的公式（修完再验一遍才写回）；
- 首次备份 `.ocr-backup.md`，公式修复备份 `.math-backup.md`；
- 支持三档模式（纯文本 / 图片上云 / 图片本地）——图片档会把页面截图一起发给视觉模型校对术语与公式。

### 深度笔记（核心功能）

三遍加工，产出 `<课次>.note.md`：

1. **整理稿**：逐块消化 OCR 原文（落盘 `.note.work.md`，按 mtime 缓存——原文没变时重跑直接复用，省 token）；
2. **成稿**：按知识逻辑重组小节（SOAR 框架：筛选 / 组织 / 关联 / 标注难点），每条要点带页码角标，重点配 `💭 讲解`（不带角标、不参与审计），习题给「参考答案（AI 推断）」并用 `<details>` 折叠（先自己想再点开）；
3. **课末必记**：提炼「本课脉络 + 课末必记」放在笔记最前，并**自动同步到原文 md 顶部的 `llm-summary` 块**（导出给 Obsidian / ima 时原文自带重点）。

覆盖保证：整理与成稿都要求「每一页至少被引用一次」，生成后还有一道自检修补（未覆盖页自动补写）。

**笔记 PDF**：复习页「⋯ 更多 → 笔记 PDF」把笔记渲染成 A4 PDF（公式渲染、习题全部展开、页码角标转上标）；首次生成几秒、之后缓存秒开，笔记变了自动重生成。

### 质量审计

三层检查，产出 `.audit.json/.audit.md/.points.md`：

1. **覆盖检查**（本地，不花钱）：哪些页有内容但没进笔记；
2. **忠实度核对**（LLM）：逐条比对笔记与课件原文（一致 / 部分 / 不支持 / 需看图）；
3. **知识点清单**（LLM）：提取全课可自测知识点，统计笔记覆盖情况。

审计发现的「与原文不符」会**自动改对**（错字/公式/数字/术语），AI 自己的补充内容保留不动；改前备份 `.note-backup.md`，面板里可对照修正前后。

### 复习台（左笔记 / 右课件 / 右下 AI）

- **顶栏**：课程 / 课次下拉 + 上一节 / 下一节；全库搜索（Ctrl+K）；校订 md、生成笔记、质量审计、复习队列、知识链、❓指南；「⋯ 更多」里收着笔记 PDF / 复制 / 下载 Markdown / 标签 / 图谱。
- **左栏**：笔记（默认）/ 原文 md 切换；目录 + 小节折叠；**四色荧光笔**（红=核心考点、黄=要背/公式、绿=已掌握、蓝=存疑待问）悬停条目即可上色。
- **右栏**：课件翻页（跟随滚动 / 缩略图 / 键盘 ←→ / 点击放大），⭐重点 ❓错题 ✓掌握 一键入复习队列，🧠出题生成问答卡。
- **右下 AI 对话**：范围可选 本课 / 本课程 / 全库（检索后回答并给来源角标），可附当前页 OCR；划词可「引用到提问 / 解释这段」；对话历史按课次保存。
- **复习队列**（间隔重复）：到期卡片自测，四档评分（再来一次 / 有点难 / 记住了 / 太简单）；支持费曼复述（AI 找缺漏）、导出 Markdown / CSV。
- **知识链**：AI 生成本课程索引与「相关课次」、课程间关联与总览；反链、标签、图谱可视化。
- **记忆**：面板布局、笔记/原文选择、阅读页码、对话历史都跟着课次记住。
- **阅读舒适**：三主题（跟随系统 / 浅色 / 深色 / 护眼暖纸，顶栏一键切换）；正文字号四档（笔记与对话联动，界面按钮不随动）；阅读进度随课次存盘并打进导出包；可选 20-20-20 护眼提醒（美国眼科学会推荐）。
- **公式排版**：支持 `$...$`、`$$...$$`、`\(...\)`、`\[...\]` 四种分隔符；窄屏长公式自动横向滚动不撑破版面；公式内中文与正文同字体。

### 导出 / 导入（手机 / 平板同步）

导出分三种包（设置 → 导出 / 导入）：

| 包类型 | 内容 | 用途 |
| --- | --- | --- |
| **内容包** | 笔记 + 原文 + 课件图（图片可关） | 给手机 / 平板；范围可选 **全部 / 指定课程 / 指定单课** |
| **学习记录包** | 阅读进度 + 复习卡 + 对话历史（几百 KB） | 双端来回合并（手机复习完导回电脑） |
| **全量备份** | 全部内容 + 记录 | 备份 / 换机 |

- 包结构：`manifest.json` + `notes/` + `images/` + `cards/` + `chats/` + `progress/`，带每课次**内容指纹**（手机端增量合并的依据）；
- **导入合并**：学习记录永远按时间合并（进度取新、卡片按 id、对话并集去重，重复导入幂等）；内容文件默认跳过、可勾选覆盖；
- 日常增量：电脑端补一节课 → 导出「单课内容包」→ App 导入即替换该课次，其余不受影响。

## 目录与文件

```
downloads/                          ← 数据目录（可在设置里改）
└── 地球物理测井原理/
    ├── 2026-09-04第3-4节/          ← PPT 图片（0001.jpg…）
    ├── 2026-09-04第3-4节.md        ← 原文（OCR）
    ├── 2026-09-04第3-4节.note.md   ← AI 深度笔记
    ├── 2026-09-04第3-4节.note.pdf  ← 笔记 PDF（按需生成）
    ├── 2026-09-04第3-4节.pdf       ← 课件 PDF（图片合订）
    └── …（辅助文件见下表）
```

| 派生文件 | 内容 |
| --- | --- |
| `<课次>.note.work.md` | 笔记的「知识整理稿」中间产物（缓存复用） |
| `<课次>.note-backup.md` | 改笔记前的自动备份 |
| `<课次>.ocr-backup.md` / `.math-backup.md` | 校订前的备份 |
| `<课次>.audit.json` / `.audit.md` | 审计结果（前端读 / 人读） |
| `<课次>.points.md` / `.points.json` | 知识点清单（含覆盖状态） |
| `<课次>.dedup.json` / `.dedup.html` | 清洗决策 + 人工复核页 |
| `<课次>.chat.json` | 对话历史 |
| `_回收站/`、`_assets/` | 被清理的帧 / 公式素材图（都不上文件树） |

## API 一览

本地服务（默认 `http://127.0.0.1:3901`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/status` `/api/login` `/api/logout` | 登录状态 / 统一认证登录 / 退出 |
| GET | `/api/terms` `/api/courses` `/api/courses/:id/subs` `/api/subs/:courseId/:subId/ppt` | 学期 / 课程 / 课次 / 课次图片清单 |
| POST/GET | `/api/jobs`（创建/列表）、`/api/jobs/:id`、`/api/jobs/:id/cancel` | 下载任务 |
| POST/GET | `/api/md-jobs`（创建/列表）、`/api/md-jobs/:id`、`/api/md-jobs/:id/cancel`、`/api/md-tools`、`/api/md-config` | 转 MD 任务与配置 |
| POST/GET | `/api/dedup-scan`、`/api/dedup-decisions`、`/api/dedup-state`、`/api/dedup-image` | 清洗预检 / 保存勾选 / 复核页数据 / 复核页图片 |
| POST/GET | `/api/llm-jobs`（note / audit / polish / proofread / fixmath / summarize / weave）及取消 | LLM 任务 |
| GET/PUT/POST | `/api/llm-config`、`/api/llm-limits`、`/api/llm-test`、`/api/llm-models` | LLM 配置 / 能力探测 / 连通测试 / 模型列表 |
| GET | `/api/note-pdf?dir=`（`&download=1` 直接下载） | 生成 / 缓存笔记 PDF |
| GET/POST/DELETE | `/api/chat-history?dir=` | 对话历史读写清空 |
| POST | `/api/chat` | 流式对话（SSE 文本流） |
| POST | `/api/note-marks` | 保存四色笔记标记 |
| GET | `/api/courses-tree` | 复习页课程 / 课次导航树 |
| POST/GET | `/api/kb/search`、`/api/backlinks`、`/api/graph`、`/api/tags`、`/api/preview` | 检索 / 反链 / 图谱 / 标签 / 悬浮预览 |
| GET/POST/DELETE | `/api/cards`（列表/新增）、`/api/cards/:id/grade`（评分）、`/api/cards/:id`（DELETE 删除）、`/api/cards/gen-qa`、`/api/cards/feynman`、`/api/cards/export` | 复习卡 |
| POST | `/api/index-note` | 规则版课程索引（知识链使用） |
| GET/PUT/POST | `/api/paths`、`/api/pick-folder` | 目录设置 / 系统文件夹选择 |
| GET/POST | `/api/export`（`?onlyNotes=1` 只导笔记）、`/api/import?overwrite=1` | 导出 / 导入 zip |
| GET/POST | `/api/system/update-check`、`/api/system/update`、`/api/system/shutdown` | 升级 / 退出 |
| GET | `/api/events` | SSE：下载 / 转 MD / LLM 任务进度 |
| POST/GET | `/api/browser/show` `/api/browser/hide` `/api/browser/window` | 后台浏览器窗口 |
| 静态 | `/files/*`（数据目录）、`/notes/*`（笔记目录）、`/vendor/*`（marked / KaTeX） | 文件访问 |

## 架构与原理

### 为什么必须用真实浏览器

问渠学堂有动态防护（瑞数），纯 HTTP 请求会被拒；本工具用本机已安装的 Edge/Chrome 真实内核完成登录与接口初始化，窗口默认藏在屏幕外。

### 数据流

```
登录 ─→ 课程/课次 ─→ 下载图片 ─→ 清洗(去重) ─→ 转 MD(OCR) ─→ 校订(纠错+公式)
                                                              │
                                      ┌───────────────────────┘
                                      ▼
                          生成深度笔记(note.md + note.pdf)
                                      │
                    ┌─────────────────┼──────────────────┐
                    ▼                 ▼                  ▼
                复习台(标记/卡片/AI)  审计(质量核对)   导出 zip(手机/Obsidian)
```

### 模块一览（server/）

| 模块 | 职责 |
| --- | --- |
| `index.mjs` | Express 路由与静态服务（全部 API） |
| `wqxt.mjs` / `browser.mjs` | 问渠学堂业务 / 真实浏览器会话 |
| `downloader.mjs` | 图片下载任务（跳过已存在、组内并发） |
| `mdconvert.mjs` | 转 MD 调度（Python 子进程、页级并行） |
| `llm.mjs` | 全部 LLM 任务（笔记 / 审计 / 校订 / 知识链…） |
| `chat.mjs` | 流式对话代理 |
| `notepdf.mjs` | 笔记 PDF（无头 Edge 打印，mtime 缓存） |
| `kb.mjs` / `cards.mjs` | BM25 知识库检索 / 复习卡（间隔重复） |
| `config.mjs` / `paths.mjs` / `net.mjs` / `gpu.mjs` | 配置 / 目录 / 网络错误翻译 / 显存探测 |

前端：下载器 `public/index.html + app.js`；复习台 `review.html + review.js`；打印页 `print.html`；桌面壳 `electron/main.cjs`。
Python：`ppt2md.py`（Pix2Text 转换）、`dedup.py`（帧去重）、`tools/`（显卡检测、图标生成）。

### 任务模型与省 token 设计

- 三类任务统一走 SSE 推送：下载 / 转 MD / LLM；**同目标同操作幂等**（重复提交直接复用进行中的任务）。
- 生成笔记三遍加工 + 整理稿缓存：原文没变重跑只花「成稿 + 必记」的钱。
- DeepSeek 推理模型自动管理思考预算；批量环节（整理 / 必记 / 判定）关闭思考，实测 40 页课次输出 tokens 从 5 万降到 1.4 万、耗时 300s → 90s、页覆盖 15/40 → 40/40。

## 已验证结果（节选）

- **下载**：单课次 120 张图 / 整课 4 课次 197 张图，0 失败；图片 1280×720 JPEG。
- **转 MD**：77 页课次全量转换 9.6 分钟（V100），48 块公式 + 53 行内公式，公式识别准确率高（正文零星 OCR 笔误，交给「校订」修）。
- **清洗**：317 帧样本中连续冗余 24%；空白过渡帧与等待页二维码自动识别。
- **深度笔记**（40 页测井课）：22 小节 + 22 条讲解 + 2 道习题折叠答案 + 112 个页码角标；**40/40 页全部被引用**；输出 ~1.6 万 tokens / 95 秒。
- **审计**：61 个知识点提取，52 覆盖 / 8 不完整 / 1 缺失；忠实度 48 通过 / 3 部分（真实抓到过 OCR 传导错误，如 K₄ → K_d、R_xo/R_t → R_xo/R_m，已自动修正）。
- **安卓端**：内容包（44 文件）导入 → 笔记 1.1 万字符 / 39 张课件图离线显示 / 对话与公式全渲染，零报错；平板模拟器（2880×1800）横竖屏实机验收；CI 自动构建 + 固定签名发布。

## 常见问题

- **转 MD 按钮点不动？** 没装转换环境——跑一次 `setup-p2t.ps1` / `setup-p2t.sh`。
- **为什么要弹浏览器？** 登录有动态防护，必须真实浏览器内核；窗口平时在屏幕外。
- **LLM key 存哪？** 本机 `config.json`（已 gitignore），三档独立配置。
- **端口冲突？** 默认 3901，可用 `PORT=xxxx npm start` 换。
- **课程更新了怎么办？**
  - 新录播：重新下载 → 课程行「批量转 MD」→「批量生成笔记」；
  - 同课次换了课件：课次弹窗勾选「**强制重新下载**」再点「下载此课次」——已有图覆盖更新、已清洗的帧不拉回、多余旧帧移入备份；然后单课次「重新转 MD」→ 生成笔记（缓存自动失效）；
  - 给手机/平板更新：重新导出 → 导入时勾选「覆盖同名文件」。
- **数据会不会被改乱？** 原始 md 只在「校订 / 摘要块」两处被写，且都有备份；笔记、审计、卡片、对话全部另存。
- **App 怎么更新？** 下载新 APK 直接覆盖安装（固定签名）；本地图书馆数据保留。
- **电脑课件更新了，手机怎么更新？** 电脑端重新导出（全部或单课）→ App 导入；同一课次自动替换，其余不受影响。
- **导入的 zip 能删吗？** 能。导入完成即入库，压缩包不再需要。

## 开发与构建

```bash
npm test            # 全部 JS 语法自检（tools/check-syntax.mjs）
npm start           # 启动服务（等价 node server/index.mjs）
npm run app         # Electron 桌面壳（自动拉起服务、关窗退出）
npm run mobile:sync # 同步 vendor 资源 + Capacitor 同步（public/ → android/）
npm run mobile:apk  # 构建安卓 APK（需 JDK 21 + Android SDK 36）
```

安卓端 CI（`.github/workflows/android-apk.yml`）：推 `main` 构建 APK 产物；打 tag（如 `v0.1.0`）自动校验版本一致性并发布 Release。

## 注意事项

- 需要本机安装 Microsoft Edge（脚本自动定位常见路径）；
- 仅用于下载你本人账号有权访问的课件，请遵守学校相关规定；
- 非官方工具，与成都理工大学无关。

## 许可证

[PolyForm Noncommercial License 1.0.0](LICENSE) © 2026 ADA-quart

**个人使用与非商业用途免费**；商业用途需另行授权。
