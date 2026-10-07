# 移动端骨架选型调研（2026-10-07）

> **结论先行：选 Capacitor 8。**
> Tauri 2 备选暂缓（Android 文件系统生态未成熟）；React Native / Flutter / 原生均为重写路线，不符合本项目；PWA 能力不足。

## 一、清渠的硬需求（选型权重来源）

1. **代码复用是最大权重**：`public/` 下已有完整实现——`review.js`（85KB 渲染/交互逻辑）、`review.css`、KaTeX + marked（零依赖），三栏/三 Tab 布局也要基于它做响应式
2. **真实文件系统**：内容包解压（课件图 + 笔记，几百 MB 级）要落在 App 私有目录
3. **LLM 流式对话**：fetch/SSE 直连（本机桌面版已验证）
4. **单人维护**：拒绝第二套 UI、第二门语言
5. 主目标设备：Android 平板（小米 Pad 6 Pro，Android 15）
6. 本机现状：Android SDK 36 + Gradle + 平板/手机模拟器已就绪；ITDC 已跑通 Capacitor 8 全套构建与 CI

## 二、候选现状（2026-10）

| 方案 | 当前版本 | 路线 |
|---|---|---|
| **Capacitor** | 8.5.2 | 系统 WebView + 官方插件层 |
| Tauri | 2.11.6 / 2.12 | 系统 WebView + Rust 壳 |
| React Native (Expo) | 0.87.1 / SDK 57 | 原生组件桥 |
| Flutter | 3.47.5 | 自绘渲染 |
| PWA | — | 浏览器直接跑 |

2026 年多篇对比文章的共识：**"已有 Web 产品 + 最大复用 + 快速出包"的首选是 Capacitor**；RN 适合 React 团队要原生 UI；Flutter 适合性能/自绘 UI 场景；Tauri 主打轻量桌面壳，移动端仍在完善期（2024-10 才随 2.0 稳定）。

## 三、对清渠的逐项适配

| 维度 | Capacitor 8 | Tauri 2 | React Native | Flutter | PWA |
|---|---|---|---|---|---|
| 现有 Web 代码复用 | **~100%** | ~95%（同为 WebView） | ✗ 全部重写 | ✗ 全部重写 | 100% |
| Android 文件系统 | **官方插件，成熟** | 第三方插件，多处 open issue¹ | 成熟（需重写数据层） | 成熟（需重写） | ✗ 无真实文件系统 |
| 本机构建链 | **全部就绪**（ITDC 同款） | 需装 Rust + NDK | 需新工具链 | 需新工具链 | 无需 |
| 维护成本（单人） | 一套代码 | 一套代码 + Rust | 两套 | 两套 | 一套但能力受限 |
| 调试体验（Android） | Chrome DevTools ✓ | ✗ Android 不支持 devtools | RN DevTools | Flutter DevTools | 最佳 |
| 安装包体积 | ~5-8MB | ~3-10MB（差异不大） | ~10-20MB | ~15-25MB | — |

¹ Tauri 官方 fs 插件在 Android 上有 content:// URI 类问题（如 dialog.save 后其他应用读到 0 字节、Downloads 目录写入失败），文件管理多依赖社区插件 `tauri-plugin-android-fs`。

## 四、结论与理由

**Capacitor 8**：

1. **复用 ~100%**：现有页面直接进 WebView，加 CSS 断点从平板三栏一路适配到手机三 Tab
2. **文件系统官方插件**（@capacitor/filesystem）成熟；zip 解压用 JSZip（纯 JS，无需额外原生层）
3. **本机零准备**：Android SDK、Gradle、模拟器（qingqu_pad）、CI 出 APK 的全套经验都已在 ITDC 上跑通，配置可直接参考
4. **一套代码喂所有端**：同一份前端供桌面浏览器、Electron 壳、Android WebView 使用，行为不漂移
5. 中文资料多、生态最大（npm 生态直接可用，2026-09 统计 Capacitor 相关包 24 万+）

## 五、落地插件清单

| 能力 | 方案 |
|---|---|
| 壳 | `@capacitor/core` + `@capacitor/cli` + `@capacitor/android`（8.5.x） |
| 文件读写 | `@capacitor/filesystem`（官方插件） |
| 选 zip 包 | WebView 原生 `<input type="file">`（Android 自动拉起系统选择器） |
| 解压 | JSZip（前端纯 JS） |
| 偏好存储 | `@capacitor/preferences` |
| LLM Key（P2） | 参考 ITDC 的 Android Keystore 原生方案 |
| 明确不加 | 推送 / 相机 / 定位 / 传感器等一律不引入 |

## 六、什么情况下重新评估

- 若未来要在**手机本地**跑 OCR / 生图等重计算 → 才轮到原生 / Flutter
- 若 Tauri 官方 Android 文件系统成熟（摆脱第三方插件）且做 iOS 极简壳 → 可重新对比
- 现阶段以上条件均不成立，Capacitor 8 没有短板
