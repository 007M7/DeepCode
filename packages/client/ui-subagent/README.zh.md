# @deepseek-ai/dsh-client-ui-subagent

[English](README.md) | 中文

subagent 引用 source 的浏览器半侧：把 `@` 触发的 `subagent` source 注册进 `ctx.slash`。候选零 RPC——从注册时捕获的根 `ctx.sessions.list` 快照过滤（每次调用的投影所指会话的子会话：`parentId` 匹配、`running`、`displayTitle` 包含 query）；pick 一个候选会把字面文本 `@label ` 经 slash 管线落进草稿（决策 21 的纯文本引用），source 的 `codec` 把两种投影都产出为 `@label`——在 `@` 消费功能定义模型表示之前，模型序列化保持原始 label。source 不实现 `matchSpace`／`matchEnter` 钩子——subagent 引用永不进入命令裁决，随普通提示词落入 default sink。

没有运行中子会话的会话就是没有候选。本阶段只交付「菜单 + 引用文本」；消费一个 `@label` 意味着什么（对子会话做 steering（中途引导）、恢复已 dispose 的子会话）是未来的业务工作。

`/client` 导出表层只有插件主体（`apply`／`inject`）；source 对象是注册 effect 的内部实现。

## 模型体验

### 用户提示词中的 subagent label 文本

#### 模型所见

被 pick 的候选会把字面文本 `@label`（子会话的显示标题）落进草稿；该文本原样进入普通用户消息（`session.prompt`）到达模型，没有专用内容块、提示词 section 或 host 侧解析。目前不存在任何消费语义：模型看到的是纯文本，只能自行解读。

#### Token 影响

有条件且极小：只有 pick（或手动键入相同文本）会把 label 的字符加进那一条用户消息。浏览菜单增加零模型 token（候选永不离开浏览器）。

#### KV Cache 影响

仅追加：引用是追加在可复用历史前缀之后的新用户消息的一部分。该包绝不改写较早的请求 token。

## 已知限制与暂缓事项

- **`@` 消费语义尚未构建**：引用只是惰性文本；把它接到对指名子会话的 steering／发消息（以及是否允许恢复已 dispose 的子会话），等待台账中它自己的设计决策。
- **候选只有运行中的子会话**：已完成或已 dispose 的 subagent 永不出现，roster 只含 scope 所指会话的直接子会话（不含孙辈，不含跨会话 agent）。
- **label 是显示标题，不是稳定 id**：两个子会话共用一个显示标题时，产生的引用无法区分；标题变更会使先前插入的文本失去指向。引用还是惰性文本时可以接受；消费功能必须绑定到会话 id。
