# @deepseek-ai/dsh-session-title-llm

[English](README.md) | 中文

模型后端会话标题提供方的共享实现策略。它解析辅助路由，将精确选中的用户消息封装为 JSON，记录可分发的确切请求，应用语言感知的标题指令，强制执行输入和输出预算，组合超时与调用方取消，组装流，并返回带有确切来源 seq 和模型 provenance 的规范化文本。

此包是普通库，不是 Cordis 插件。提供方插件调用 `registerSessionTitleLlmProvider()`，传入各自节奏与消息选择器；该函数验证共享配置，并将每个 revision 委派给 `generateSessionTitleWithLlm()`，使两者的注册、路由、提示词、取消与验证行为不会漂移。

## 路由与失败契约

`provider` 和 `model` 覆盖项都是可选的，但必须同时作为非空字符串提供。如果没有这一对取值，辅助模块会使用当前会话已记录 `request/header` 中捕获的确切提供方／模型路由；因此，在任何路由出现前显式刷新时必须提供覆盖项。辅助模块在记录或分发前，以 `maxInputBytes` 测量最终 JSON 封装的用户提示词，包括 seq 字段、包装层与 JSON 转义，而不是将其截断。消费流期间和流完成后都会重新检查超时与调用方取消，因此即使 interceptor 或适配器忽略 abort，也不能接受迟到的成功结果。格式错误或空输出、工具调用和非 stop 结束原因同样会 reject；会话标题服务决定该 reject 属于自动警告还是显式调用方失败。

路由与输入验证完成后，辅助模块会在模型分发前直接通过 `Session` 追加仅写入日志的 `session/title-llm-request` 事件。它包含标题提供方 id、确切来源 seq、路由、系统提示词、消息列表，以及该调用使用的输出 token 上限。持久化会尽快观察该记录；追加不需要标题专属标记、类型断言、结算队列或 flush。分发的 envelope 会深度冻结，携带 `purpose: 'session-title'`，且有意不包含 dsh-agent-loop 的进程本地请求身份。Interceptor 会与记录保持一致，而循环专用重建观察者不会把它与对话 header 比较。DeepSeek 适配器会将该 purpose 映射为关闭 thinking，使少量输出预算全部用于可见标题文本；其他适配器负责自身 purpose 专用行为。后续模型失败会保留请求记录；从未成为可分发请求的验证失败不会创建记录。该事件始终位于派生模型历史之外。

## 配置

除成对的路由覆盖项外，每个字段都必填；库不提供默认值。

| 键 | 契约 |
|---|---|
| `targetWords` | 非 CJK 标题的正整数目标词数。 |
| `targetCjkCharacters` | 中文、日文或韩文标题的正整数目标字符数。 |
| `maxInputBytes` | 最终 JSON 封装用户提示词的正整数 UTF-8 字节上限。 |
| `maxOutputTokens` | 辅助生成的正整数 token 上限。 |
| `timeoutMs` | 运行时定时器限制内的端到端正数 deadline。 |
| `provider`, `model` | 可选显式路由；二者同时提供或同时省略。 |

## 模型体验

### 辅助标题请求

#### 模型看到的内容

标题模型会收到固定系统指令，要求以输入语言返回一个简洁且无装饰的标题，其中包含所配置的词数与 CJK 字符数目标。它唯一的用户消息包含一个 JSON 数组，其中是精确选中的用户消息及其 seq。

#### Token 影响

辅助请求根据所选输入大小和 `maxOutputTokens` 消耗 token。它与主 agent 请求相互独立，不会向 agent 历史增加标题文本或封装内容。DeepSeek 标题调用会关闭 thinking；主对话保留自身配置的 thinking 模式。

#### KV Cache 影响

不会使主请求失效。辅助缓存复用由提供方决定；固定指令可复用，而 JSON 消息数组会随每个 revision 变化。

## 已知限制与暂缓工作

- 辅助模块只接受文本输出，并拒绝工具调用；不公开结构化输出适配器或提供方专用提示词变体。
- 它对整个封装用户提示词强制执行字节上限，不会剪裁单条消息或应用保留策略。
