# Agent Note: Web 对话中安全的 assistant Markdown

Status: implemented

[English](2026-07-23-web-assistant-markdown.md) | 中文

## 问题

Web 对话通过会话事件、历史回放与流式累积保留 assistant Markdown 源文本，但其最末端的文本原语会按字面渲染源文本。若修改共享原语，用户消息与 steering（中途引导）消息也会被格式化；若在运行时中解析，则会把呈现状态混入不依赖 React 的会话投影。

## 决策

`@deepseek-ai/dsh-client-ui-primitives` 导出 `MarkdownText`，用作不受信任的 assistant 文本渲染器；`ui-conversation` 仅为 assistant `text` 块选择该渲染器。已完成的历史消息、流式输出尾部与被中断的部分输出已经共用 `AssistantMarkdown`，因此无需更改事件或快照，它们便会采用同一渲染器。用户消息与 steering 消息继续使用 `MessageText`，并保持按字面渲染。

`MarkdownText` 使用 `react-markdown` 与 `remark-gfm`，从 AST 构建 React 元素。它支持 CommonMark 块，以及 GFM 表格、任务列表、删除线与自动链接，但不使用 `dangerouslySetInnerHTML`，不解析原始 HTML，也不进行语法高亮。`ui-primitives` 显式声明该依赖；由于这一纯库由 Web shell 预置，解析器会成为初始浏览器 bundle 的一部分。

## 不受信任输出策略

assistant 生成的目标地址仅限绝对 HTTP、HTTPS 与 mailto URL。HTTP(S) 链接会在新标签页中打开，并带有 `rel="noopener noreferrer"`；相对目标地址与其他协议会渲染为不可导航的文本。Markdown 图片仅渲染替代文本，因此模型输出无法发起远程图片请求。由于管线中未引入 HTML 解析器，原始 HTML 仍是不会生效的源文本。

渲染器使用现有的 `--dsw-*` 排版与颜色 token。围栏代码块与 GFM 表格各自处理横向溢出，因此较长内容无法撑宽对话栏。

## 考虑过的替代方案

**将现有的 mdast 与 micromark 开发依赖提升为正式依赖，并维护自定义 React walker。**此方案避免引入新的解析器体系，但产品需要自行负责每种节点映射、GFM 扩展和安全敏感的渲染分支。专用 React 渲染器将这套遍历交由上游维护，同时保留 AST 到 React 的处理路径。

**将 `MessageText` 替换为 Markdown 渲染。**这会产生格式化用户提示词与 steering 的副作用。在产品明确选择此行为之前，这两类输入内容仍按字面渲染。

**将 Markdown 解析为会话快照。**这会让 React 节点或呈现层 AST 成为持久的运行时状态，并重新引入最终输出与流式输出之间的模式边界。解析仍留在呈现层的叶节点中。

**通过净化启用原始 HTML 或远程图片。**当前产品并不需要这两项功能，但二者都会扩大可执行行为或网络隐私边界。因此它们保持禁用，无需增加净化器与图片策略依赖。

## 后果

assistant 回复在流式输出与回放期间都会一致地渲染为语义化 Markdown，而工具卡片、推理行、交互、用户气泡和宿主协议保持不变。每次累积更新后，流式输出都会重新解析当前文本；未完成的 Markdown 可能暂时改变结构，但独立的尾部会限定 React 失效范围，最终事件也不会切换渲染器。初始 Web shell 的体积会因加入 Markdown 解析器与 GFM 运行时而增大；语法高亮或远程媒体等后续扩展需要另行作出 bundle 与安全决策。
