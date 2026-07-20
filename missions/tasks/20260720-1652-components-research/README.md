# components-research：web-components vendoring 调研

> owner：components-research（常驻 teammate）。纯调研任务，**零 commit、零代码复制、不建包、不改现有文件**。产出本目录 survey.md 供用户圈选。

## 用户口径（全文照记）

后面要大规模借用 deepseekchat 前端库（本机路径 /weka-hg/prod/deepseek/permanent/ys/private/workspace/gitlab/deepsuite-frontend，只读参考）的组件（如 Markdown 渲染、无限滚动列表——代码量大、不方便走 npm 包形式），但出于基线考量不想完整复制粘贴整库。已复制的部分（web-ui 里样式基线等）既往不咎，后面会逐渐改掉。计划：新开 **packages/client/web-components** 专存高度封装的外来 React 组件；web-ui = 自己写的主框架，web-components = 外部来源组件。**归属标注纪律**：包内 README 标注来自上游仓库的哪个 commit（写 commit hash + 源路径）；⚠️ 对外（git commit message、代码注释等一切入库文本）**不得出现「deepseek chat / deepsuite」等上游名称**——只说「vendored from a pinned upstream commit \<hash\>」这类中性表述；为让组件正常工作做的**源码级微调**要逐条标注（如硬编码 URL/host 替换、内部服务引用摘除、i18n/埋点剥离——tsconfig 之类构建适配不用记）。

## 任务理解

产出 survey.md（中文）+ vendoring 规程草案，五个部分：

1. **上游盘点**：deepsuite-frontend 组件层组织方式（目录、构建、依赖栈——React 版本/样式方案/状态库）；重点侦察 Markdown 渲染组件（代码高亮/公式/流式渲染？remark/rehype 生态深度？）和无限滚动列表（虚拟化方案？自研还是 react-virtuoso 之类？）。每个候选组件一行卡片：路径、行数、外部 npm 依赖、上游内部模块依赖（要剥离/替换哪些）、样式方案与我们 CSS Modules+token 体系的适配成本。
2. **候选清单扩展**：其他「未来大概率要抄」的高封装组件（对话气泡/输入框增强/文件树/diff 视图/toast/modal 等），列表格不深钻。
3. **落地形态建议**：packages/client/web-components 包骨架（按 lib 构型设计，注意「不导出 src」新口径）；每组件子目录 PROVENANCE 段模板（上游 commit hash + 路径 + 微调清单）；上游 gitlab 仓库记 hash 口径（HEAD 当前 hash 写进模板示例）。
4. **依赖策略**：点名组件拖的 npm 依赖（remark 生态、虚拟化库）进 web-components deps 是否可接受（体量/许可证）；与「不加依赖」惯例的边界（用户曾否 concurrently 这类工具依赖，运行时依赖性质不同——列出供用户拍）。
5. **不做**：不复制代码、不建包、不改现有文件。

## 批次计划（小步快跑）

- 批 0：本 README 落盘 + 回执 ✅
- 批 1：上游盘点（目录结构/构建/依赖栈 + 两个点名组件深看）→ survey.md 首批落盘 + 回执
- 批 2：候选清单扩展 + 落地形态 + 依赖策略 → survey.md 补齐 + 回执
