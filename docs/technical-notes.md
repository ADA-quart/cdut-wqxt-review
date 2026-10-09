# 清渠 · 技术笔记

> 面向开发者与后续维护者：API 一览、架构与原理、实测数据。
> 安装与使用说明见 [README](../README.md)。

## API 一览

本地服务（默认 `http://127.0.0.1:3901`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/status` `/api/login` `/api/logout` | 登录状态 / 统一认证登录 / 退出（走统一认证登出，见下） |
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

### 退出登录（2026-10 实测）

- 站点的 `/logout` **只是前端路由**：返回 200 + 应用 HTML，不清任何会话（访问后 `infosimple` 仍返回账号）。
- 官方登出流程（从 app bundle 读出）：清 `_token` / `live_token` / `iPlanetDirectoryPro`，再跳
  `window.CONFIG.CASAPI + /index.php?r=auth/cmc-loginout&tenant_code=<租户>&forward=<完整 URL>`。
  本站实测 `CASAPI=https://yjapi.wqxt.cdut.edu.cn/casapi`、`tenant_code=21`——都从页面 `CONFIG` 读，不要写死。
- 本项目登出实现（`wqxt.mjs` 的 `logout()`）：统一认证登出 → 清 cdut 域下的鉴权 cookie
  （`JWTUser` / `_token` / `live_token` / `iPlanetDirectoryPro` / `SESSION` / `PHPSESSID`，**保留**瑞数 WAF cookie）→
  回站点复检；未清干净时返回 `ok:false`，不假装成功。
- 附带约束：登出后页面停在统一认证页，`browser.mjs` 的「工作页面」判定必须把 CAS 主机也算合法，
  否则每次状态查询都会新开一个标签页。

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

## 回放 / 音轨（2026-10 探测记录）

- **形态**：`content.playback.url` = `https://resource.wqxt.cdut.edu.cn/play/default/YYYY/MM/DD/<hash>_1920_1080.mp4`；
  实测 144 条回放全部同构直链 MP4、**无签名参数**（`file_list` 同址，另附一张封面 jpg）。
- **防护**：`resource.*` 域名与主站同为瑞数动态防护——curl / Node 直连得到 500 挑战页（含 `$_ts` 混淆脚本）；
  即便带 cookie、用 Playwright 的 `context.request`（HTTP 客户端、非浏览器栈）也会被拒。
  **正确姿势：在 resource 域名下用真实浏览器页面栈访问**（与登录、图片同一套会话机制）。
- **待复核**：抽测的一条录像（`process_type=processing`）过了挑战后源站仍返回 500，疑似尚未转码完成；
  跨课程复测需再次登录（短时间内连续脚本登录会触发 CAS 验证码，注意限频）。
- **会话不持久**：问渠的 cookie 是会话级（关浏览器即失效），「记住登录 + 自动重登」是必要能力。
