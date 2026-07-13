# Terminology

本表约定本仓库的中英术语统一译法。各列语义：

- **中文** — 正文中的固定译法；写「保留英文」表示不译。
- **首次出现** — 术语在一篇文档中第一次出现时的完整写法（含括注）；之后只写「中文」列的形式。组合词已括注过的成分，单独出现时不再括注。
- **不要译作** — 禁用译法，逐项列出；出现任何一项即评审阻断。
- **备注** — 语境区分、裁定出处等自由说明；不承载可执行规则。

| English | 中文 | 首次出现 | 不要译作 | 备注 |
|---|---|---|---|---|
| ACP | ACP | ACP（Agent Client Protocol） |  |  |
| AI | AI | 人工智能（AI） |  |  |
| API | API |  |  | real-API 作定语时可译「真实接口」（如 real-API tests → 真实接口测试） |
| CI | CI |  |  |  |
| CLI | CLI | 命令行界面（CLI） |  |  |
| Cordis | Cordis |  |  | 保留英文 |
| Function Calling | Function Calling | Function Calling（函数调用） |  |  |
| HMR | HMR | 热模块替换（HMR） |  |  |
| JSON Schema | JSON Schema |  |  |  |
| JSONL | JSONL |  |  |  |
| lint | lint |  |  |  |
| loader | loader |  |  |  |
| LLM | LLM | 大语言模型（LLM） |  |  |
| MCP | MCP |  |  |  |
| PR | PR | PR（pull request） |  |  |
| RAG | RAG | 检索增强生成（RAG） |  |  |
| SDK | SDK |  |  |  |
| SSE | SSE | SSE（Server-Sent Events） |  |  |
| agent | agent | agent（智能体） |  | 括注只落在 agent 单独首现处；组合词见下行 |
| agent harness, agent workflow, agent loop, agent skill | 保留英文 |  |  | agent 组合词整体保留英文、不括注；其中的 workflow/loop/skill 不单独拆译；未列出的 agent 组合词同此处理 |
| backlog | backlog |  |  | 双语翻译语境指待翻清单 |
| blob hash | blob 哈希 |  |  | git 对象哈希；`git hash-object` 的结果 |
| commit hash | 提交哈希 |  |  |  |
| hash | 哈希 |  |  | 代码与命令中保留英文（如 `git hash-object`、`<hash>` 占位符） |
| doc-sync | doc-sync |  |  | 仓库门禁名，保留英文 |
| e2e | e2e |  |  |  |
| fiber | fiber | fiber（插件运行时） |  |  |
| fixture | fixture |  |  | 指测试前置数据或环境 |
| fork | fork |  |  | 保留英文 |
| harness | harness |  |  | 保留英文 |
| manifest | manifest |  |  | 描述模块或工具元数据的文件 |
| monorepo | monorepo |  |  |  |
| package | package |  |  | 保留英文；指 npm 包（`@deepseek-ai/dsh-*`） |
| schema DSL | schema DSL |  |  |  |
| schema | schema |  |  | 保留英文 |
| seam | seam | seam（扩展点） |  | 同句已出现「扩展点」（extension point）时不加括注，直接写 seam，避免一词两指 |
| skill | skill | skill（技能） |  |  |
| spawn | spawn |  |  | 保留英文 |
| steering | steering | steering（中途引导） |  |  |
| subagent | subagent | subagent（子 agent） |  |  |
| transcript | transcript | transcript（文本记录） |  | 指会话渲染给用户或编辑器的完整文本，区别于事件日志（event log） |
| waterfall | waterfall | waterfall（瀑布式事件） |  |  |
| worktree | worktree |  |  | git 工作区概念，保留英文 |
| wire format | 协议格式 | 协议格式（wire format） |  |  |
| adapter contract | 适配器契约 | 适配器契约（adapter contract） |  |  |
| adapter | 适配器 |  |  |  |
| append-only | 仅追加 |  |  |  |
| artifact | 产物 |  |  |  |
| block | 块 |  |  |  |
| background task | 后台任务 |  |  |  |
| backend | 后端 |  |  |  |
| capability | 能力 |  |  |  |
| cancel | 取消 |  |  |  |
| checkpoint | 检查点 |  |  |  |
| chunk | 分片 |  |  |  |
| compaction | compaction | compaction（上下文压缩） |  | 正文优先保留英文 |
| consumer | 消费方 |  |  |  |
| counterpart | 对侧文件 |  | 对应物、配对物 | 双语配对语境；泛指“另一侧”时可写「另一侧」 |
| content block | 内容块 |  |  |  |
| config | 配置 |  |  |  |
| context | 上下文 |  |  |  |
| context compaction | 上下文压缩 | 上下文压缩（context compaction） |  |  |
| contract | 契约 |  |  | 如：配对契约（pairing contract）；另见 adapter contract |
| coverage | 覆盖率 |  |  |  |
| crash recovery | 崩溃恢复 |  |  |  |
| dispose | dispose | dispose（释放资源） |  | 正文优先保留英文 |
| durability | 持久性 |  |  |  |
| enforcement frontier | 强制边界 |  |  | i18n 机制词：manifest `required` 清单所划的门禁生效范围 |
| event log | 事件日志 |  |  |  |
| event | 事件 |  |  |  |
| event stream | 事件流 |  |  |  |
| event-sourced | 事件溯源 |  |  | DDD 社区通行译法 |
| executor | 执行器 |  |  |  |
| extension | 扩展 |  |  |  |
| fail-fast | 快速失败 |  |  |  |
| fenced code block | 围栏代码块 |  |  | MDN 中文同译 |
| finish reason | 结束原因 |  |  |  |
| fingerprint | 指纹 |  |  | i18n 机制词：`.zh.md` 首行记录英文源 blob hash 的 `i18n-source` 注释 |
| foreground run | 前台运行 |  |  |  |
| freshness | 新鲜度 |  |  | MDN HTTP 缓存中文同译（freshness lifetime → 新鲜度生命周期）；指译文相对英文源的同步状态 |
| hook | 钩子 |  |  |  |
| implementation | 实现 |  |  |  |
| inference | 推理（inference） |  |  | 每次提及时保留英文括注，避免与 reasoning 混淆 |
| info string | 信息字符串 |  |  | CommonMark 中文同译；代码围栏 ``` 之后的语言标注 |
| injection | 注入 |  |  |  |
| interface | 接口 |  |  |  |
| integration | 集成 |  |  |  |
| language switcher | 语言切换行 |  |  | i18n 机制词：双语配对文件顶部的互链行 |
| memory | memory / 记忆 / 内存 |  |  | 按上下文区分：agent memory 译为“记忆”；resource/memory usage 译为“内存” |
| message | 消息 |  |  |  |
| mock | mock |  |  | 保留英文；指测试替身 |
| mod | 模组 |  |  | 区别于 module（模块）；plugin 译作「插件」 |
| model provider | 模型提供方 |  |  |  |
| module | 模块 |  |  |  |
| orphan | 孤立 |  | 孤儿 | git 官方中文同译（如「孤立分支」）；指英文源已不存在的 `.zh.md`；进程语境按 OS 惯用语译「孤儿进程」 |
| pairing | 配对 |  |  |  |
| permission | 权限 |  |  |  |
| persistence | 持久化 |  |  |  |
| pipeline | 流水线 |  |  |  |
| plugin | 插件 |  |  | mod 对应“模组” |
| prompt | 提示词 |  |  |  |
| provider | 提供方 |  |  |  |
| provider-neutral | 提供方无关 |  |  |  |
| quality gate | 质量门禁 |  |  |  |
| registry | 注册表 |  |  |  |
| reasoning | 推理（reasoning） |  |  | 需要和 inference 区分时保留英文括注；`reasoning_content` 译为“思考内容” |
| replay | 回放 |  |  |  |
| resume | 恢复 |  |  |  |
| runtime | 运行时 |  |  |  |
| sandbox | 沙箱 |  |  |  |
| service | 服务 |  |  |  |
| session | 会话 |  |  |  |
| session event | 会话事件 |  |  |  |
| sidecar record | 伴随记录 |  | 旁挂记录 | 指 `.i18n.yaml` 这类随主文件存放的记录文件 |
| smoke test | 冒烟测试 |  |  |  |
| snapshot | 快照 |  |  |  |
| source of truth | 真源 | 真源（source of truth） |  | 评审裁定译法；如后续裁定调整，改此表即可 |
| spine | 主干 |  |  |  |
| staged | 暂存 |  |  | git 官方中文同译 |
| stale | 陈旧 |  |  | MDN HTTP 缓存中文同译，与「新鲜（fresh）」成对；门禁输出保留英文 `stale`；expired 才译「过期」 |
| step | 步骤 |  |  |  |
| stream | 流 |  |  |  |
| streaming | 流式输出 |  |  |  |
| structural signature | 结构签名 |  |  | i18n 机制词：配对门禁比对的有序结构序列 |
| system prompt | 系统提示词 |  |  |  |
| taxonomy | 分类体系 |  |  |  |
| token usage | token 用量 |  |  |  |
| thinking | thinking |  |  | API 字段保留；模型模式译为“思考” |
| tool | 工具 |  |  |  |
| tool call | 工具调用 |  |  |  |
| tool result | 工具结果 |  |  |  |
| tool schema | 工具 schema |  |  |  |
| toolkit | 工具包 |  |  |  |
| turn | 轮次 |  |  |  |
| typecheck | 类型检查 |  |  |  |
| vocabulary | 词汇 |  |  |  |
| workflow | 工作流 |  |  |  |
