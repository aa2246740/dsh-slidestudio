# 规格：纯原生离线 1:1 Kimi Slides

**来源：** Wayfinder 地图 OOP-18 及子决议 OOP-19…31  
**术语：** 见仓库根目录 `CONTEXT.md`  
**阶段法：** 见 `docs/wayfinder/OOP-28-parity-phases.md`  
**状态：** 决策完备，可 `/to-tickets` 后按 Phase A 开工  

**测试接缝（实现与评审须对齐；若你不认同请先改此处再拆票）：**

| 接缝 | 测什么（只测对外行为） |
|------|------------------------|
| **S1 · PPTD 工程** | 磁盘上的 YAML PPTD v2 工程：解析、校验、往返序列化、版本快照 |
| **S2 · 混合导出** | PPTD 工程 → `.pptx` + `ExportReport`；无公网；图表 Edit Data |
| **S3 · 原生画布会话** | 加载 PPTD → 渲染/交互 → 写回 PPTD（仅有 oracle 行的控件可点） |
| **S4 · Agent 运行** | brief/附件 → 工具时间线 → 产出合法 PPTD 工程 + 版本 |
| **S5 · 编辑器 oracle 目录** | `docs/editor-oracle` 行状态机与 schema 校验；capture 工具只在开发期碰 iframe |

理想上产品路径只穿过 **S1**，其余接缝围绕 S1 的文件真源旋转，避免第二套文档模型。

---

## 问题陈述

需要在一个**不依赖公网、禁止 Kimi 官方 iframe/CDN 作为运行时**的内网环境中，使用与 **Kimi Slides 能力与（复刻期内）界面观感对齐的 1:1** 幻灯片工作台：从需求/资料生成可编辑演示文稿，在画布上直接改对象，用自然语言与批注精修，版本可回退，并导出 **PowerPoint 中仍可编辑** 的 PPTX（含图表 **Edit Data**）。

现有 monorepo 曾用自有 TS IR + pptxgenjs 走出骨架，但文档模型与官方/open-kimi 表面不一致，编辑器功能残缺、空壳按钮多。open-kimi 证明了 YAML PPTD v2 与官方编辑器行为可对照，但其生产路径依赖官方浏览器写出器，**不能**直接用于离线内网。

用户需要的是：**开发期用官方 iframe 作 oracle 全面反推，生产期零 Kimi 网络的纯原生实现**，并按可验收清单宣称 1:1。

---

## 解决方案

在本 monorepo 内建设**新 native 核心**（旧 TS Deck IR 归档、不作 SSOT）：

1. **文档唯一真源**：磁盘上的 **Kimi YAML PPTD v2** 工程（`.pptd` + `pages/*.page` + `media/`）。  
2. **开发期 oracle**：通过 open-kimi 宿主打开官方编辑器，**双通道**（PPTD/导出 diff + 截图）记录交互行；禁止无记录的可点按钮。  
3. **生产期原生栈**：自研画布（Kimi 对齐 UI）+ Agent Harness/Brain（open-kimi SKILL 仅作剧本内容）+ **混合 OOXML 导出**（库写壳 + 手写 chart 包以保证 Edit Data）。  
4. **离线/内网**：不要求公网；LLM 为内网兼容端点或本地模型；字体/图标/主题打进安装包。  
5. **阶段交付**：Foundation → PPTD I/O → 导出 → Oracle 采集 → 编辑器 S1–S12 → 产品壳与 Brain → **G 阶段 1:1 宣称**；独特化 UI 等放到 1:1 之后。

---

## 用户故事

1. 作为演示文稿作者，我希望输入一句话需求就生成多页中文演示文稿，以便跳过空白页启动困难。  
2. 作为作者，我希望生成结果是**可编辑对象**而非整页图片，以便同事在 PowerPoint/WPS 中继续改。  
3. 作为内网用户，我希望在**断公网**时仍能打开、编辑、导出，以便合规部署。  
4. 作为作者，我希望文档格式与 Kimi/open-kimi 的 **PPTD v2** 一致，以便对照样例与技能剧本。  
5. 作为作者，我希望可点名设计主题（如咨询/财务预设），以便视觉稳定。  
6. 作为作者，我希望系统默认避免明显 AI 套话与空结论页，以便材料可上会。  
7. 作为作者，我希望看到 Agent 工具步骤时间线，以便长任务可信任。  
8. 作为作者，我希望生成失败时可重试且不留下脏版本，以便实验安全。  
9. 作为作者，我希望附件（PDF/Word/图等）能被读入生成上下文，以便基于我的材料写稿。  
10. 作为作者，我希望分栏工作区左侧对话、右侧画布，以便边改边聊。  
11. 作为作者，我希望缩略图切换页面，以便浏览长稿。  
12. 作为作者，我希望选中文本并直接改字，以便快速修文案。  
13. 作为作者，我希望调整形状/图片位置与样式，以便排版。  
14. 作为作者，我希望编辑表格单元格，以便改数不重导。  
15. 作为作者，我希望打开图表数据并改值后图立即更新，以便数据可信。  
16. 作为作者，我希望导出后图表在 PowerPoint 中可 **Edit Data**，以便交付可继续生产。  
17. 作为作者，我希望插入文本/形状/线/图/图标/表/图，以便手工扩展稿件。  
18. 作为作者，我希望流程/结构类页面可用对象编辑（节点与连线语义），以便结构页可改。  
19. 作为作者，我希望自然语言精修当前页或选中对象，以便不用重头生成。  
20. 作为作者，我希望版本列表与恢复，以便试错可回退。  
21. 作为作者，我希望在画布钉批注并批量让 Agent 处理，以便评审改稿。  
22. 作为作者，我希望播放模式全屏翻页，以便彩排。  
23. 作为作者，我希望导出 PPTX 时看到可编辑性报告，以便知道降级项。  
24. 作为作者，我希望可选导出预览图/PDF 作分享，以便非 Office 场景。  
25. 作为作者，我希望图片信息图可重建为可编辑对象，以便不再贴死图。  
26. 作为开发者，我希望每个编辑器按钮都有 oracle 行（截图+文档证据），以便不做错交互。  
27. 作为开发者，我希望未规格化控件不可点或禁用，以便消灭空壳按钮。  
28. 作为开发者，我希望可在开发机随时用官方 iframe 采集，以便达到 100% 编辑器表面覆盖。  
29. 作为开发者，我希望采集产物可离线回归，以便内网 CI 不访问 Kimi。  
30. 作为运维，我希望 LLM 基址可配置为内网网关，以便不绑公有云。  
31. 作为运维，我希望字体与主题打进包，以便断网仍显示正确。  
32. 作为干系人，我希望 1:1 宣称有书面检查清单，以便验收不靠感觉。  
33. 作为干系人，我希望 1:1 完成前 UI 向 Kimi 看齐，以便对照 oracle。  
34. 作为干系人，我希望 1:1 完成后再谈品牌独特化，以便先保真。  
35. 作为作者，我希望页背景与主题 token 行为符合 PPTD 规格，以便跨页一致。  
36. 作为作者，我希望撤销/重做与版本语义清晰，以便误操作可恢复。  
37. 作为作者，我希望导出不含对 Kimi 的网络依赖，以便内网交付。  
38. 作为 Agent，我希望只读写 PPTD 工程目录，以便无双 IR。  
39. 作为 Agent，我希望结构校验失败不能标 ready，以便坏稿不混充成功。  
40. 作为测试，我希望按 S0–S12 分段验收编辑器，以便进度可度量。  
41. 作为测试，我希望每个交互行有 `EO-*` 测试 ID，以便自测可勾选。  
42. 作为架构师，我希望旧 TS Deck 包不再扩展写路径，以便迁移清晰。  
43. 作为架构师，我希望混合导出对未声称类型显式失败或 wont-port，以便不静默糊图。  
44. 作为作者，我希望备注（notes）在需要时可用，以便讲稿。  
45. 作为作者，我希望动画能力在官方编辑器可见范围内被覆盖或书面排除，以便预期透明。  

---

## 实现决策

### 总原则

1. **磁盘 SSOT = Kimi YAML PPTD v2** 工程树；禁止第二套并行 Deck 写路径。  
2. **生产运行时**禁止 Kimi/Moonshot 主机与官方 iframe；开发期 oracle 例外至编辑器 100%。  
3. **同仓迁移 B**：新 native 包 + legacy 归档；不另起仓库。  
4. **open-kimi**：格式/剧本/样例/开发采集；非生产导出引擎。  
5. 词汇与门禁以 `CONTEXT.md` 与 `docs/wayfinder/*` 为准。

### 模块划分（逻辑模块，名称可微调）

| 模块 | 职责 |
|------|------|
| **pptd-v2** | 解析、校验、序列化 PPTD v2；往返保真 |
| **project-store** | 工程目录 CRUD、版本快照与恢复 |
| **exporter-pptx-native**（或重写现有导出包） | 混合导出：库写壳 + 手写 chart OOXML + ExportReport |
| **canvas-editor** | 自研渲染与交互；仅 oracle 允许的控件；Kimi 对齐壳 |
| **agent-harness** | 运行状态机、工具总线、pin/refine、门禁 |
| **agent-brain** | Planner / DesignAuthority / Composer / Critic；剧本=钉扎的 SKILL+reference |
| **oracle-tools**（仅开发） | iframe 采集辅助；不进生产包 |
| **apps/web** | 产品壳（Create Hub、工作区、时间线）；文档后端换为 PPTD 会话 |
| **apps/server** | 可配置内网/本地 LLM 代理；禁止默认公有 SaaS 硬编码 |
| **vendor/open-kimi-ppt@x.y.z** | 钉版本的规格与剧本 |
| **legacy/** | 旧 TS IR 等只读归档 |

内存中可有类型化投影，但必须能无损写回 YAML PPTD。

### 导出（OOP-24）

- 输入：PPTD 工程。  
- 壳：PptxGenJS 或等价 MIT 库。  
- 图表：手写/注入 DrawingML + 嵌入 xlsx + 关系，保证 **Edit Data**。  
- 禁止默认整页栅格化；降级必须进 ExportReport。  
- python-pptx 仅作次要逃生舱。  
- 成功门禁：声称类型上无硬降级，图表 Edit Data 抽检通过。

### 画布（OOP-25）

- 自研 Web 画布（DOM/SVG 优先，便于命中测试）；拒 OnlyOffice 作主编辑器。  
- 同一渲染器服务：编辑、缩略图、播放、视觉 QA 截图。  
- UI 在 1:1 期内与 Kimi 对齐（位置/标签以 oracle `kimiUi` 为准）。  
- 空壳可点按钮禁止。

### Agent（OOP-26）

- Harness 与 Brain 分离。  
- 工具名对齐产品可见时间线（think/plan、read_file、compose_deck、edit_slide、vision_qa、export_pptx 等）。  
- 视觉 QA：**结构校验必选**；可选本地/内网 VLM 看原生截图。  
- 设计系统离线打包（自 open-kimi design_system 改编合约，不宣称官方商标）。

### 编辑器 oracle（OOP-29/30/31）

- 目录与 schema：`docs/editor-oracle/`。  
- 行状态：discovered → capturing → specified → implemented → verified。  
- 清点顺序 S0…S12 强制；S13 按 iframe 是否核心决定是否进宣称。  
- 双通道：截图 before/after + PPTD 证据（或明确无文档变更说明）。

### 离线（OOP-20）

- 生产不要求公网。  
- LLM：内网 OpenAI 兼容或本地。  
- 资源：打包或客户内网镜像。  
- 主形态：本机/局域网 Web。

### 1:1 宣称（OOP-19）

完整产品路径 + 编辑器 S0–S12 verified + PPTD v2 + Edit Data + 零 Kimi 网 + 自测矩阵全绿。

### 阶段（OOP-28）

A 地基 → B PPTD I/O → C 混合导出 → D Oracle+S0 → E 编辑器分节 → F 壳+Harness+Brain → G 宣称 → H 宣称后（独特 UI 等）。

---

## 测试决策

### 好测试的标准

- 只断言**对外行为**（文件内容、导出可打开性、API 结果、可见状态），不绑内部私有函数结构。  
- 优先走 **S1 PPTD 工程** 与 **S2 导出** 高接缝；UI 测通过会话命令后的 PPTD diff 与关键截图比对。  
- 离线 CI **禁止**依赖实时 Kimi iframe；仅用仓库 golden。  
- 每个 `verified` 交互行对应可勾选的 `EO-*` 自测项。

### 覆盖范围

| 模块 | 测试重点 |
|------|----------|
| pptd-v2 | open-kimi 样例往返；非法 YAML 拒绝 |
| project-store | 版本快照恢复 |
| exporter | 无网导出；文本/形状可编辑；图表 Edit Data 烟测；ExportReport |
| canvas-editor | 加载样例；改字写回；无 oracle 行的控件不可点 |
| agent-harness | 状态机与版本；失败不脏写 latest |
| agent-brain | 产出合法 PPTD（可用 mock LLM） |
| editor-oracle schema | row.json 校验；index 与目录一致 |

### 仓库内既有先例

- `packages/*/src/*.test.ts` + `node --test`  
- `scripts/gate1-acceptance.mjs` 类端到端门禁（应改为 PPTD 路径后的新门禁）  
- `docs/editor-oracle/schema/interaction-row.schema.json` 作为契约测试源  

---

## 范围外

- 生产使用 Kimi 官方 iframe / CDN 导出或渲染  
- 1:1 宣称前的品牌独特化 UI 重构  
- 实时多人协作 ACL  
- 完整 PowerPoint 宏/OLE/未在 iframe 观测到的动画宇宙  
- 以 OnlyOffice/Collabora 作为主编辑器  
- 强制安装包内置大模型权重（可选后置）  
- 独立新仓库重写（已否决）  
- 维护 TS Deck 与 YAML PPTD 双写  

---

## 补充说明

1. 法务：design_system 以**风格合约**复刻期使用，不宣称 Moonshot/Kimi 官方产品。  
2. 字节级 PPTX 与官方 writer 一致**不是**目标；**可编辑行为 + Edit Data** 才是。  
3. 实现顺序以 OOP-28 为准；演示竖切**不能**替代 S0–S12 编辑器覆盖。  
4. 决策原文：`docs/wayfinder/OOP-*.md`、`docs/editor-oracle/**`；本规格与之冲突时以更新后的 wayfinder 决议为准并修订本文件。  
5. 下一技能步骤：`/to-tickets` 按 Phase A–G 拆 tracer 票并挂阻塞边。  

---

## 决议索引（只读）

| 主题 | 文档 |
|------|------|
| 验收条 | `docs/wayfinder/OOP-19-acceptance-bar.md` |
| 离线约束 | `docs/wayfinder/OOP-20-offline-constraints.md` |
| 文档 SSOT | `docs/wayfinder/OOP-21-document-ssot.md` |
| 导出架构 | `docs/wayfinder/OOP-24-export-architecture.md` |
| 画布架构 | `docs/wayfinder/OOP-25-canvas-architecture.md` |
| Harness/Brain | `docs/wayfinder/OOP-26-agent-harness-brain.md` |
| 迁移 | `docs/wayfinder/OOP-27-monorepo-migration.md` |
| 阶段 | `docs/wayfinder/OOP-28-parity-phases.md` |
| Oracle 方法/格式/顺序 | OOP-29 决议 + `docs/editor-oracle/` |
