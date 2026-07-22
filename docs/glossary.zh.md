# 术语表

[English](glossary.md) | 中文

DeepSeek Harness SDK 的领域词汇对每个概念使用唯一的规范术语。各术语通过标准 Markdown 锚点互相链接；实现细节留在各 package README 与 RFC 中。

FIXME(glossary-completeness): Expand this glossary before the first release so it covers the SDK's other core and capability subsystems, not only agent scope.

## agent-scope

- **scope**：按 agent（智能体）划分的注册单位。一项贡献（工具、提示词片段、变量、限制、监听器）要么是*全局的*（对所有 agent 可见），要么是*有范围的*（归属于恰好一个 [scope key](#scope-key)）。只有两层，扁平结构：有范围的注册不会向下继承给 subagent；子树行为通过 [lineage](#lineage) 数据表达，从不通过 scope 结构。
- **scope key**：scope 的不透明标识，按对象同一性比较。harness 约定：一个活跃的 agent 就是其自身 scope 的 key。<a id="scope-key"></a>
- **agent 上下文（`agent.ctx`）**：agent 的有范围上下文；通过它进行的注册既是 scope 可见的，也是 scope 生命周期的（同一事实决定两者），其上的监听器参与该 agent 的 scope 过滤分发。注册表主体事件可以在各自的事件契约下保持故意不过滤。
- **scope carrier**：scope 过滤分发所携带的 `thisArg`（由 `scopeTarget` 构建）；其过滤器放行无标签监听器加上主体自身的监听器。*无主体*的 carrier（没有 key）只放行无标签监听器。
- **scoped dispatch**：规则是：关于某个 agent 活动的事件以该 agent 的 carrier 进行分发。关于注册表本身的事件（如「一个工具被添加了」）属于*注册表主体*事件，保持不过滤。
- **shadowing**：最具体者胜出的名称解析：一个有范围的工具/片段/变量仅在该 scope 内替换同名的全局对应项。这是按 agent 定制 persona 和按 agent 定制工具变体的机制。
- **restriction / scope-local 注册**：restriction（`tools.restrict`）为单个 scope 过滤全局工具表面（多个 restriction 取交集组合）；scope-local 注册在过滤之后合并。被过滤掉的全局工具既不出现在提示词中，也拒绝执行，与不存在的工具无法区分。
- **setup window**：创建者组装 agent 有范围世界的创建时隙（`CreateAgentOptions.setup`）：在 scope 和 agent 对象已存在、但 agent 或会话尚未发布、`agent/session-start` 尚未触发、首次提示词尚未组装之前。setup 只做注册，从不驱动 agent。
- **lineage**：以数据形式携带的父子关系事实（`parentSession`、`subagentDepth`）；从不影响可见性。<a id="lineage"></a>
