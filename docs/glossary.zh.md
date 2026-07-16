# 术语表

[English](glossary.md) | 中文

DeepSeek Harness SDK 的领域词汇对每个概念使用唯一的规范术语。各术语通过标准 Markdown 锚点互相链接；实现细节留在各 package README 和 RFC 中。

FIXME(glossary-completeness): Expand this glossary before the first release so it covers the SDK's other core and capability subsystems, not only agent scope.

## agent 作用域

- **scope（作用域）**：按 agent（智能体）注册的单位。一项贡献（工具、prompt 段落、变量、限制、监听器）要么是*全局*的（对所有 agent 可见），要么是*有作用域*的（归属于恰好一个 [scope key](#scope-key)）。只有两层，扁平结构：有作用域的注册不会向下继承给 subagent；子树行为通过[血统](#lineage)数据表达，从不通过作用域结构。
- **scope key（作用域键）**：作用域的不透明标识，按对象同一性比较。harness 约定：一个活跃的 agent 就是其自身作用域的 key。<a id="scope-key"></a>
- **agent context（`agent.ctx`）**：agent 的有作用域上下文；通过它进行的注册既是作用域可见的，也是作用域生命周期的（一个事实同时驱动两者），其上的监听器参与该 agent 的作用域过滤分发。注册表主体事件可以在其自身的事件契约下有意保持不过滤。
- **scope carrier（作用域载体）**：作用域过滤分发所携带的 `thisArg`（由 `scopeTarget` 构建）；其过滤器放行无标签监听器加上主体自身的监听器。*无主体*的载体（没有 key）只放行无标签监听器。
- **scoped dispatch（作用域分发）**：规则是：关于某个 agent 活动的事件以该 agent 的载体进行分发。关于注册表本身的事件（如「一个工具被添加」）属于*注册表主体*事件，保持不过滤。
- **shadowing（遮蔽）**：最具体者胜出的名称解析：一个有作用域的工具/段落/变量仅在该作用域内替代其同名的全局副本。这是按 agent 定制人设和按 agent 定制工具变体的机制。
- **restriction / scope-local registration（限制 / 作用域局部注册）**：限制（`tools.restrict`）为单个作用域过滤全局工具面（按交集组合）；作用域局部注册在过滤之后合并。被过滤掉的全局工具既不出现在 prompt 中，也拒绝执行，与不存在的工具无法区分。
- **setup window（设置窗口）**：创建者组装 agent 有作用域世界的创建时隙（`CreateAgentOptions.setup`）：在作用域和 agent 对象已存在、但 agent 或会话尚未发布、`agent/session-start` 尚未触发、首次 prompt 尚未组装之前。设置窗口只做注册，从不驱动 agent。
- **lineage（血统）**：以数据形式携带的父子关系（`parentSession`、`subagentDepth`）；从不影响可见性。<a id="lineage"></a>
