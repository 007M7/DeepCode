# Terminology

本表约定本仓库的中英术语统一译法。

**通用规则：**
- "中文"列为中文译文的正文默认用词。若该列为英文，则中文译文的正文中保留英文不翻译。
- 首次出现按"首次出现"列书写（带括号注释）；后续出现只写括号前的部分（可能为中文，也可能为英文），不出现括号内的注释。
- "不要译作"列为严格禁止的译法。
- 如果某术语已经作为另一个术语的组成部分被括注过（如 `agent loop（智能体循环）` 中已包含 `agent` 的括注），则该术语后续单独出现时无需再次括注。

## 缩写类（中英文文本中均使用缩写）

| English | 中文 | 首次出现 | 不要译作 | 备注 |
|---|---|---|---|---|
| ACP | ACP | ACP（Agent Client Protocol） | | |
| AI | AI | AI（人工智能） | | |
| API | API | | | |
| CI | CI | | | |
| CLI | CLI | CLI（命令行界面） | | |
| e2e | e2e | | | |
| HMR | HMR | HMR（热模块替换） | | |
| JSON Schema | JSON Schema | | | |
| JSONL | JSONL | | | |
| LLM | LLM | LLM（大语言模型） | | |
| MCP | MCP | | | |
| PR | PR | PR（Pull Request） | | |
| RAG | RAG | RAG（检索增强生成） | | |
| SDK | SDK | | | |
| SSE | SSE | SSE（Server-Sent Events） | | |

## 英文类（中英文文本中均使用英文）

| English | 中文 | 首次出现 | 不要译作 | 备注 |
|---|---|---|---|---|
| agent | agent | agent（智能体） | | |
| agent harness | agent harness | agent harness（智能体框架） | | agent 组合词（agent harness/workflow/loop/skill 等）整体保留英文；未括注过 agent 时首现按对应组合词或 agent 行处理 |
| agent loop | agent loop | agent loop（智能体循环） | | |
| backlog | backlog | backlog（待翻清单） | | 仅在双语翻译语境里括注`待翻清单` |
| blob hash | blob hash | | | `git hash-object` 的结果 |
| Cordis | Cordis | | | |
| dispose | dispose | dispose（资源释放） | | |
| doc-sync | doc-sync | doc-sync（文档同步门禁） | | |
| fiber | fiber | | | |
| fixture | fixture | fixture（测试前置数据） | | |
| fork | fork | | | |
| Function Calling | Function Calling | Function Calling（函数调用） | | |
| harness | harness | | | |
| harness engineering | harness engineering | | | |
| lint | lint | | | |
| mock | mock | | | 保留英文；指测试替身 |
| loader | loader | | | |
| manifest | manifest | manifest（元数据清单） | | |
| monorepo | monorepo | | | |
| schema | schema | | | |
| schema DSL | schema DSL | | | |
| seam | seam | | | 与 `extension point` 是不同概念；根据具体语境，可译为`服务边界`或`可替换点` |
| skill | skill | skill（技能） | | |
| spawn | spawn | | | |
| steering | steering | steering（中途引导） | | |
| task id | task id | | 任务 id | 保留英文 |
| subagent | subagent | | | |
| thinking | thinking | | | API 字段保留英文；描述模型模式时译为`思考` |
| transcript | transcript | transcript（文本记录） | | 指会话渲染给用户或编辑器的完整文本，区别于事件日志 |
| waterfall | waterfall | waterfall（瀑布式事件） | | |
| wheel | wheel 包 | | | Python 打包格式 |
| worktree | worktree | | | git 工作区概念 |

## 双语类（中英文文本各自使用中英文）

| English | 中文 | 首次出现 | 不要译作 | 备注 |
|---|---|---|---|---|
| adapter | 适配器 | | | |
| adapter contract | 适配器契约 | 适配器契约（adapter contract） | | |
| append-only | 仅追加 | | | |
| artifact | 产物 | | | |
| backend | 后端 | | | |
| background task | 后台任务 | | | |
| block | 块 | | | |
| build target | 构建目标 | | | |
| cancel | 取消 | | | |
| capability | 能力 | | | |
| checkpoint | 检查点 | | | |
| chunk | 分片 | | | |
| compaction | 压缩 | 压缩（compaction） | | |
| companion tool | 配套工具 | | | |
| config | 配置 | | | |
| consumer | 消费方 | | | |
| content block | 内容块 | | | |
| Cookbook | 实操手册 | | | 文档标题用语 |
| context | 上下文 | | | |
| counterpart | 对侧文件 | | 对应物、配对物 | 双语配对语境；泛指"另一侧"时可写「另一侧」 |
| context compaction | 上下文压缩 | 上下文压缩（context compaction） | | |
| contract | 契约 | | | 如：`pairing contract` →`配对契约` |
| coverage | 覆盖率 | | | |
| crash recovery | 崩溃恢复 | | | |
| deploy root | 部署根目录 | | | |
| durability | 持久性 | | | |
| enforcement frontier | 执行红线 | | 强制边界 | i18n 配对机制用语：manifest `required` 清单所划的门禁生效范围；与金标样例（style-samples ⑦）一致 |
| event | 事件 | | | |
| event log | 事件日志 | | | |
| event stream | 事件流 | | | |
| event-sourced | 事件溯源 | | | 沿用 DDD 社区通行译法 |
| executor | 执行器 | | | |
| extension | 扩展 | | | |
| extension point | 扩展点 | | | 注意与 `seam` 区分 |
| fail-fast | 快速失败 | | | |
| fenced code block | 围栏代码块 | | | 沿用 MDN 中文翻译 |
| fingerprint | 指纹 | | | 通用内容指纹；双语配对机制使用 sidecar record 记录两侧 blob hash |
| finish reason | 结束原因 | | | |
| foreground run | 前台运行 | | | |
| freshness | 新鲜度 | | | 沿用 MDN 中文翻译；在本项目中指译文相对源文的同步状态 |
| hook | 钩子 | | | |
| implementation | 实现 | | | |
| inference | 推理 | 推理（inference） | | 需要和 `reasoning` 区分时保留英文括注 |
| info string | 信息字符串 | | | 沿用 CommonMark 中文翻译；指代码围栏 ``` 之后的语言标注 |
| injection | 注入 | | | |
| integration | 集成 | | | |
| interface | 接口 | | | |
| language switcher | 语言切换行 | | | i18n 配对机制用语：双语配对文件顶部的互链行 |
| memory | 记忆 / 内存 | | | 与 `agent` 搭配时译为`记忆`（如 `agent memory` →`智能体记忆`）；指系统资源时译为`内存` |
| merge | 合并 | | | |
| message | 消息 | | | |
| mod | 模组 | | | |
| model provider | 模型提供方 | | | |
| module | 模块 | | | |
| orphan | 遗留 | | 孤儿、孤立 | 指英文源已不存在的 `.zh.md`（如「遗留译文」）；进程语境按 OS 惯用语译「孤儿进程」 |
| orphan branch | 孤立分支 | | 孤儿分支 | 沿用 git 官方中文翻译 |
| package | 包 | 包（package） | | 指 npm 包（`@deepseek-ai/dsh-*`）；`package.json` 等代码标识保持原样 |
| pairing | 配对 | | | |
| peer dependency | 对等依赖 | 对等依赖（peer dependency） | | |
| permission | 权限 | | | |
| persistence | 持久化 | | | |
| pipeline | 流水线 | | | |
| plugin | 插件 | | | |
| prompt | 提示词 | | | |
| provider | 提供方 | | | |
| provider-neutral | 提供方无关 | | | |
| quality gate | 质量门禁 | | | |
| reasoning | 推理 | 推理（reasoning） | | 需要和 `inference` 区分时保留英文括注 |
| reasoning_content | 思考内容 | | | |
| registry | 注册表 | | | |
| replay | 回放 | | | |
| resume | 恢复 | | | |
| runtime | 运行时 | | | |
| sandbox | 沙箱 | | | |
| service | 服务 | | | |
| serving surface | 对外服务接口 | | | |
| session | 会话 | | | |
| session event | 会话事件 | | | |
| sidecar record | 伴随记录 | | 旁挂记录 | 指与文档同目录的伴随记录文件 |
| smoke test | 冒烟测试 | | | |
| snapshot | 快照 | | | |
| source of truth | 真源 | | | |
| spine | 主干 | | | |
| staged | 暂存 | | | 沿用 git 官方中文翻译 |
| stale | 陈旧 | | 过期 | 与 `fresh`（`新鲜`）成对；门禁输出中保留英文 `stale` 不翻译；`expired` 才译为`过期` |
| step | 步骤 | | | |
| stream | 流 | | | |
| streaming | 流式输出 | | | |
| structural signature | 结构签名 | | | i18n 配对机制用语：门禁比对两侧文件时提取的有序结构序列（标题层级、代码块、列表等） |
| system prompt | 系统提示词 | | | |
| taxonomy | 分类体系 | | | |
| token usage | token 用量 | | | |
| tool | 工具 | | | |
| tool call | 工具调用 | | | |
| tool result | 工具结果 | | | |
| tool schema | 工具 schema | | | |
| toolkit | 工具包 | | | |
| turn | 轮次 | | | |
| VFS | VFS | 虚拟文件系统（VFS） | | |
| typecheck | 类型检查 | | | |
| vocabulary | 词汇 | | | |
| wire format | 协议格式 | 协议格式（wire format） | | |
| workflow | 工作流 | | | |
| wrapper | 包装层 | | | 软件层或 SDK 包装层 |
| wrapper script | 包装脚本 | | | 可执行脚本包装层 |
