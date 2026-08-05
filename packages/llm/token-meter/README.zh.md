# @deepseek-ai/dsh-token-meter

[English](README.md) | 中文

通过单例 `ctx.tokenMeter` 服务进行具备回放感知能力的 token 测量。它从持久日志为每个会话推进一个隔离 fold，因此压缩（compaction）与其他压力敏感插件可以共享计量，无需依赖 `CompactService`。

## 配置

估算器没有配置项。它有意使用一项固定启发式规则：每个 token 按四个字符估算，再加上角色、块与请求 envelope 字段的结构开销。任何配置键都会被拒绝，包括已废弃的全局 `contextWindow`；模型容量属于拥有精确提供方／模型路由的适配器，可通过 `ctx.llm.resolveModelInfo().context` 获取。

## 测量契约

`ctx.tokenMeter` 直接公开两个操作：

- `measure(session, requestHeader?)` 在同一个已消费日志 revision 上返回请求压力与当前已计价表层。
- `estimateMessage(message)` 使用固定启发式规则为一条消息计价。

`measure()` 会同步一次，并返回一个独立且深度不可变的快照。`totalTokens` 是请求与响应压力，`surfaceTokens` 是仅表层启发式总量，等于 `nodes[].tokens` 之和。`requestHeader` 覆盖只影响压力字段；表层字段仍描述当前会话。每次调用都会克隆带位置的节点，因此测量是 O(surface)。

fold 跟踪完整请求标头快照、步骤边界、表层追加与替换、成功 assistant 消息、提供方用量和 assistant 分片溯源。只有当最新成功调用的规范请求 envelope 与已测量 envelope 匹配，且其总量不低于该调用的完整启发式锚点时，才会复用提供方用量；后续成功会替换较早锚点。否则会对当前 envelope 与表层进行完整估算。表层变更保持相对于匹配锚点的带符号值，包括缩减替换后的负 delta。

用量计量会求和不重叠的输入、cache-read、cache-write 与输出 bucket；不会再次添加推理（reasoning）。每次成功调用都会记录一个 assistant 锚点，包括无内容调用。显式空溯源列表表示已知空提供方流，而遗留溯源缺失时，fold 会保守地将持久 assistant 输出视为提供方输出。

## 会话投影

当组合提供 `ctx.sessionProjections` 时，token-meter 会通过一个可选子 fiber 注册两个单元。

`tokenUsage` 携带完整持久日志中的 `uncachedInputTokens`、`outputTokens`、`cacheReadTokens` 和 `cacheWriteTokens`。即使请求随后失败，用量分片仍会计入；同一 `(turn, step)` 的最终 assistant 消息用量会替换该样本，而不是重复计数。推理仍是输出的一个细分项。只保留单个最新样本，依赖的是会话日志的一条顺序性质：一旦某个更晚的步骤报告了用量，合法日志就绝不会再为更早的步骤报告用量。

`contextPressure` 携带可选的 `pressureTokens`（提供方报告的最新提示词规模，为未缓存输入加缓存读取与写入之和），以及来自最新一条 `request/context` 记录的可选 `contextWindow`。提供方报告用量前压力保持缺失；路由适配器未公布容量时容量也保持缺失。输出不计入其中，因此轮次流式输出期间分子保持不动，等到下一个请求报告用量时才前进。

两个单元都使用标准的投影基线、实时帧、seq 高者胜值仓和 JSON 检查点路径。卸载 token-meter 会移除这两个键。不带投影 seam 的 headless 或 TUI 组合会保留测量服务的既有行为。

### 上下文占用率是刻意为之的近似值

`pressureTokens` 与 `contextWindow` 是两个各自后者胜的独立字段，**不是**对单个请求的一次原子观测。切换模型时，新容量会与上一路由的压力配对，直到下一个请求报告用量为止；而 `pressureTokens` 描述的是最后一个请求，不是此刻的表层。

这是刻意的选择。占用率百分比是面向用户的参考数字，既不是计费记录，也不是门控输入：harness 中没有任何环节依据它做决策，压缩改为直接读取 `measure()`。TUI 状态行一直以同样的方式计算占用率，即用 `measure()` 总量除以为所选模型单独解析出的容量。

让这对值保持原子已经尝试过并被否决：它需要一个临时且不可回放的协议帧，进而需要针对跨流重排序的生命周期栅栏，还会让占用率在每次重连后变为空白。[Agent Note](../../../.agents/notes/implemented/architecture/2026-07-29-projected-token-usage-and-request-context.md)记录了这项对比。需要同一边界精确数字的消费方应在自己的请求边界调用 `measure()`，而不是读取该投影。

## 组合

```yaml
- name: '@deepseek-ai/dsh-token-meter'
- name: '@deepseek-ai/dsh-compact-basic'
```

两个插件都有可用默认值。meter 保持与模型路由和可选压缩无关。部署会在 LLM（大语言模型）适配器上配置容量，并在 `dsh-compact-basic` 上配置压缩策略。

## 模型体验

通过 `dsh-compact-basic` 等消费方间接影响；该服务自身不添加提示词、消息、schema、工具或模型调用。

#### KV Cache 影响

不会直接失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **固定启发式规则是近似值**：没有可复用提供方用量的内容按字符数加结构开销计价，而不是使用精确提供方 tokenizer 或请求 serializer。
- **每次测量都会克隆当前表层**：一致且不可变的快照使读取成为 O(surface)，包括低于阈值的压力检查。
- **提供方用量只能为完全相同的规范 envelope 复用**：提示词、前缀、工具、提供方、模型或调用配置变更都会有意回退到完整启发式估算。
- **遗留溯源采取保守策略**：没有 `sourceEventSeqs` 的 assistant 消息无法区分提供方输出与 listener 改写，因此 fold 不会声称已知空流或精确分片流。
- **TUI 与浏览器 fixture 仍保留并行 fold**：`tokenUsage` 拥有持久会话投影语义；TUI 的组合未挂载通用投影 seam，因此继续维护实时的逐步骤 map，而浏览器 fixture 会为独立 demo 数据镜像该单元。
