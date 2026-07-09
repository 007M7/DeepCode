# Subagent (dsh-subagent)

子代理委派接口。

**接口包:** `@deepseek-ai/dsh-subagent`
**实现:** `@deepseek-ai/dsh-subagent-spawn` / `@deepseek-ai/dsh-subagent-fork`
**消费者:** `@deepseek-ai/dsh-tool-subagent`

## Subagent Service

### ctx.subagent.run(request)

- **request:** `SubagentRequest`
- **返回值:** `Promise<SubagentResult>`

委派一个任务给子代理执行。

## SubagentRequest

```typescript
interface SubagentRequest {
  /** 使用的 provider 名称 */
  provider: string
  /** 委派给子代理的提示 */
  prompt: string
  /** 子代理使用的模型（可选，默认继承父） */
  model?: string
}
```

## SubagentResult

```typescript
interface SubagentResult {
  /** 子代理的最终回复 */
  response: string
}
```

## Provider 模式

Subagent 支持多种"后端"（provider），通过配置选择：

### spawn

创建一个全新的子代理实例，没有父级的对话历史：

```yaml
- name: '@deepseek-ai/dsh-subagent-spawn'
  config:
    providerName: spawn
```

### fork

创建一个携带父级已完成 turn 前缀的子代理，子代理"知道"父级的对话上下文：

```yaml
- name: '@deepseek-ai/dsh-subagent-fork'
  config:
    providerName: fork
```

## 模型可用的 Tools

通过 `dsh-tool-subagent` 暴露。可以加载多次，每次绑定不同 provider：

```yaml
# 暴露为 "subagent" tool，使用 spawn 后端
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent

# 暴露为 "subagent_fork" tool，使用 fork 后端
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: fork
    toolName: subagent_fork
```

## 使用场景

- **spawn** — 独立子任务（如"搜索这个问题"），子代理不需要知道父级上下文
- **fork** — 需要上下文的子任务（如"基于我们刚才讨论的，去实现这个"），子代理继承父级的对话前缀
