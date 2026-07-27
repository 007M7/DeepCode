# `@deepseek-ai/dsh-llm-retry`

[English](README.md) | 中文

一个函数插件，通过 `agent/request-error` waterfall 重试特定的短暂模型请求失败。它不包装 `ctx.llm.stream()`：每次适配器调用仍是一次提供方尝试，每次重试都会开启新的编号轮次。

默认策略允许为 `EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT` 和 `TRANSPORT` 重试两次，使用从 500 ms 到 10 秒的有界指数退避与 10% jitter。`EMPTY_RESPONSE` 是适配器对退化提供方完成的分类（携带零个内容块的终止 stop）；该尝试未产生持久内容，因此可安全重复。延迟边界必须适合 Node 支持的定时器范围。有效 `providerRetryAfterMs` 在已配置上限内时替换本地退避；超出上限的指令会委托给下一项恢复策略。

恢复 listener 会在失败步骤之后追加一个非表层 `llm/retry` 事件，在失败轮次的信号仍存活期间等待退避，然后返回 `{ kind: 'retry' }`。循环会关闭该失败轮次，并在同一持久历史上开启重试轮次。策略在这条不间断的恢复链中维护自己的重试计数，并在终态 `agent/settled` 时清零。轮次取消与插件 dispose 会中止等待。

单独发布的 `./invariant` 配套模块会检查每个重试记录是否出现在开启轮次内的失败步骤之后，是否与其在当前重试链中的位置匹配，以及是否携带正数有界重试预算和非负有界定时器延迟。完整 jitter 可以在下界调度为零毫秒。

```yaml
- name: '@deepseek-ai/dsh-llm-retry'
  config:
    maxTransientRetries: 2
    initialDelayMs: 500
    maxDelayMs: 10000
    jitterRatio: 0.1
    retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]
```

## 模型体验

### 短暂请求恢复

#### 模型看到的内容

模型不会看到重试事件、延迟或失败文本。重试轮次会从持久会话历史中重建相同的显式提供方／模型请求；失败 chunk 绝不会进入派生消息。

#### Token 影响

每次重试都是新的提供方请求，可能重复计费输入 token。有限预算会限制尝试次数；`llm/retry` 自身不产生 token。

#### KV Cache 影响

重建请求保留之前的前缀，并可根据该提供方的规则复用 cache。非表层状态事件不会改变 cache 身份。

## 已知限制与暂缓事项

- **Agent 轮次是唯一重试边界**：直接 `ctx.llm.stream()` 消费方仍只尝试一次，因为原始流无法将已发出 chunk 持久分隔为不同尝试。
- **有限插件预算可叠加**：该策略只统计已配置短暂 code；上下文溢出压缩只统计自身 code。未来如有 code 重叠的策略，必须记录并测试注册顺序行为。
- **`llm/retry` 记录已完成的退避，不是请求完成**：后续步骤与轮次事件用于确立成功、耗尽或取消。
