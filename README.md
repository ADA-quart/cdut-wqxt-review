# 问渠学堂 PPT 下载器

按「课程 → 课次」批量下载成都理工大学问渠学堂（classroom.wqxt.cdut.edu.cn）录播课件的 PPT 图片，自动归类到本地目录。

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

```bash
npm install
npm start
```

浏览器打开 <http://127.0.0.1:3901> → 点右上角「登录」→ 输入统一认证学号密码 → 选择课程下载。

## 架构

```
public/            单页前端（原生 JS，零依赖）
server/
  index.mjs        Express 服务：REST API + SSE 进度推送 + 文件浏览
  browser.mjs      Edge 会话管理（见下方「为什么要用真实浏览器」）
  wqxt.mjs         业务层：登录 / 课程 / 课次 / PPT 清单
  downloader.mjs   下载任务管理：目录归类、并发下载、进度事件
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

因此 `browser.mjs` 采用「以独立 profile 拉起用户本机真实 Edge，通过调试端口连接」的方式：首访会弹出一个 Edge 窗口（如遇验证码请在该窗口完成），登录态保存在 `.edge-profile/`，后续重启免登录。

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

## 已验证结果

真实账号端到端测试（2026-10-03）：

- 登录：统一认证通过，返回学号与姓名
- 课程列表：12 个月回溯，返回 25 门课程
- 课次目录：单门课 24 个课次，回放状态区分正确
- 单课次下载：`地球物理测井原理 / 2026-09-01第7-8节` → 120 张图，0 失败
- 整课下载：`电法勘探原理与方法` → 4 个课次共 197 张图，0 失败
- 图片规格：1280×720 JPEG，单张约 60–140 KB
- 前端：课程列表、课次弹窗、任务进度、文件缩略图均正常渲染

## 注意事项

- 需要本机安装 Microsoft Edge（脚本自动定位常见安装路径）
- 端口默认 `3901`，可用环境变量覆盖：`PORT=xxxx npm start`
- 下载目录可用软链接或直接拷贝 `downloads/`
- 仅用于下载本人账号有权访问的课件，请遵守学校相关使用规定