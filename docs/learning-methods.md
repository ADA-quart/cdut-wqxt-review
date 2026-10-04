# 学习方法调研：从「看得懂」到「学得会」

> 本文是 wqppt 复习功能的设计依据。所有引文经 Crossref API 实查（2026-10-04），GitHub 数据经 GitHub API 实查（star 数为当日值）。

## 一、为什么"看 PPT 补课"会觉得看不懂

| 现象 | 研究结论 | 出处（被引数 / DOI） |
| --- | --- | --- |
| 看的时候"懂了"，做题时不会 | **流畅性错觉**：重读带来熟悉感，不等于可提取 | Soderstrom & Bjork 2015, *Learning vs Performance*, 556 cites, `10.1177/1745691615569000` |
| 没人讲、纯看幻灯片费劲 | 新手在低结构材料上自主学习效率低，需要脚手架 | Kirschner, Sweller & Clark 2006, 4464 cites, `10.1207/s15326985ep4102_1` |
| 花了时间没效果 | 十种学习法评级：只有 **practice testing** 与 **distributed practice** 是高效用；重读/划重点低效用；纯总结评分不高 | Dunlosky et al. 2013, 2376 cites, `10.1177/1529100612453266` |

## 二、高效用方法（按证据强度）

1. **检索练习（Practice testing）** — 先自问自答再核对，长期保留显著高于重读。
   Roediger & Karpicke 2006 (2277 cites, `10.1111/j.1467-9280.2006.01693.x`)；Karpicke & Blunt, *Science* 2011 (771 cites, `10.1126/science.1199327`)。
2. **间隔练习（Spacing）** — 同一内容的复习间隔拉开；应考场景最优间隔约为"距考试时长的 10–20%"。
   Cepeda et al. 2008 (470 cites, `10.1111/j.1467-9280.2008.02209.x`)、2009 (225 cites, `10.1027/1618-3169.56.4.236`)。
3. **生成效应（Generation）** — 自己产出的答案比读到的答案记得牢。
   Slamecka & Graf 1978, 825 cites, `10.1037/0278-7393.4.6.592`。
4. **自解释（Self-explanation）** — 用自己的话解释"为什么"，暴露理解断层。
   Chi, *The Self-Explanation Principle*（Cambridge Handbook of Multimedia Learning, 2021）。
5. **交错练习（Interleaving）** — 混合不同题型/主题的练习优于单题刷到底。
   Rohrer & Dedrick 2015, *J Educ Psych*, 120 cites, `10.1037/edu0000001`。
6. **生成性学习八法概述**（自测、自解释、画图、教别人、做映射……）。
   Fiorella & Mayer 2015, 689 cites, `10.1007/s10648-015-9348-9`。

## 三、视频/网课场景

- MOOC 视频参与度研究：单段约 6 分钟参与度最高，教师+幻灯片优于纯幻灯片；建议分段观看后立刻自测。Guo, Kim & Rubin 2014, 1302 cites, `10.1145/2556325.2566239`。
- 手写笔记略优于打字（记忆层面），但关键是**加工深度**而非工具。Mueller & Oppenheimer 2014, 799 cites, `10.1177/0956797614524581`（2018 有更正说明，效应强度有争议）。

## 四、GitHub 参考项目（2026-10-04 实查）

| 项目 | ⭐ | 用途 |
| --- | ---: | --- |
| [ankitects/anki](https://github.com/ankitects/anki) | 31,737 | 间隔重复闪卡事实标准（四按钮评分） |
| [open-spaced-repetition/fsrs4anki](https://github.com/open-spaced-repetition/fsrs4anki) | 4,086 | FSRS 排期算法（可用复习史拟合参数，替代简化 SM-2） |
| [logancyang/obsidian-copilot](https://github.com/logancyang/obsidian-copilot) | 7,783 | Obsidian 内对笔记问答/检索 |
| [brianpetro/obsidian-smart-connections](https://github.com/brianpetro/obsidian-smart-connections) | 5,481 | 本地 embedding 语义关联（零 API key） |
| [st3v3nmw/obsidian-spaced-repetition](https://github.com/st3v3nmw/obsidian-spaced-repetition) | 2,571 | 在 md 笔记里嵌入复习卡 |
| [reorproject/reor](https://github.com/reorproject/reor) | 8,548（已归档） | 本地 AI 知识库整体架构参考 |

## 五、在 wqppt 里落地的 45 分钟补课法

1. **预考**（生成效应）：只看每页大标题，先写下"这页要解决什么"再翻内容。
2. **自解释 + 追问**：每页复述一句"为什么"，再对 AI 提问；顺序不能反。
3. **当堂自测**（检索练习）：一节结束立刻点「🧠 出题」生成 3–5 张问答卡，答错的页打 ❓。
4. **间隔 + 交错**：次日过 ❓ 队列；第四天混合两门课一起过（复习抽屉自动按到期时间排）。
5. **费曼回评**：对每张问答卡"用自己的话讲一遍"，AI 对照课件指出缺漏/不准确/追问。
6. **视频回放**：按 6 分钟一段、1.5–2 倍速看，暂停后立即自测。

> 对应功能：⭐/❓/✓ 标记（当前页入队）、🧠 出题（AI 问答卡）、复习抽屉（先问后答 + 四档评分）、费曼回评、导出 MD/CSV（Anki/Obsidian 互通）。
