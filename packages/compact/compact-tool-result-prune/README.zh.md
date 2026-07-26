# @deepseek-ai/dsh-compact-tool-result-prune

[English](README.md) | 中文

可安全回放、不依赖模型的剪枝服务（`ctx.toolResultPrune`）。它会将超出预算的 `tool/result` 表层节点改写为有界头部、固定省略标记和有界尾部，同时在仅追加会话日志中保留完整原始事件。

这是 [`dsh-compact-basic`](../compact-basic/README.md) 的具体配套服务，不是压缩后端或面向模型的工具。Compact-basic 通过可选的 `ctx.get('toolResultPrune')` 读取它，因此两个包都保持可独立组合。

## 服务 API

`pruneSession(session)` 会扫描当前表层的一个稳定快照。每个超出预算的工具结果都会被一个新追加的 `tool/result` 替换，其携带 `{ surfaceOp: { op: 'replace', start: originalSeq, end: originalSeq }, sourceEventSeqs: [originalSeq] }`。替换会展开完整原始数据，只更改 `content`，保留 `turn`、`step`、`callId`、错误字段、`meta` 以及后续添加的数据。原始事件仍可用于持久化、回放和精确日志检查。

当会话拒绝替换时，该方法会同步抛出异常。本次 pass 中较早提交的替换仍然持久。

`measureContent(blocks)` 会统计 `text` 块中的 Unicode 码点。`pruneContent(blocks)` 会返回有界替换；如果内容已在阈值内，则返回 `null`。非文本块保持原始相对位置；文本切片绝不会拆分 UTF-16 surrogate pair，但可能拆分由多个码点组成的 grapheme cluster。

每个发出的结果在文本码点上都精确包含已配置的头部预算、固定标记和尾部预算，不大于 `thresholdChars`，且严格小于触发输入。因此第二次 pass 不会发出替换。

## 配置

无法识别的 key 会使插件在构造时失败。已解析配置与输入脱离，并且深度不可变。

| Key | 必填 | 含义 |
|---|---|---|
| `thresholdChars` | 否（默认 `8192`） | 合并文本超过此 Unicode 码点数时剪枝。 |
| `headChars` | 否（默认 `4096`） | 保留的开头 Unicode 码点数。 |
| `tailChars` | 否（默认 `1024`） | 保留的末尾 Unicode 码点数。 |

所有值都必须是整数；阈值必须为正数，头部／尾部必须为非负数。`headChars + marker + tailChars` 必须能容纳在 `thresholdChars` 内，因此有效配置可以剪枝每个超出预算的结果，不会增长或重复改写。

## 用法

```ts
import type { Context } from 'cordis'
import ToolResultPruneService from '@deepseek-ai/dsh-compact-tool-result-prune'

export function apply(ctx: Context): void {
  ctx.plugin(ToolResultPruneService)
}
```

## 模型体验

### 已剪枝的工具结果

#### 模型看到的内容

一旦压缩触发器成立，后续请求会看到保留的头部、`\n\n[... tool result middle pruned ...]\n\n` 和保留的尾部，用它们替换已移除文本。富内容块保持顺序。模型不会看到原文的第二份副本。

#### Token 影响

每个已改写工具结果最多包含 `thresholdChars` 个文本码点。剪枝本身不会发起模型调用；重新测量的请求低于压力阈值时，compact-basic 会跳过摘要，否则摘要器会读取已剪枝的表层。

#### KV Cache 影响

替换较早的结果会使从第一个改变的 token 起的复用失效。当其路由、envelope 与之前的历史保持一致时，已剪枝前缀可以复用。

## 已知限制与暂缓事项

- **字符预算不是 token 预算**：不同提供方的 token 密度各异，因此 `ctx.tokenMeter` 仍负责判定剪枝是否缓解了请求压力。
- **剪枝只基于语法**：它保留开头与结尾，不解释中间哪些行在语义上重要。
- **Grapheme cluster 可能被拆分**：按码点切片可保护 surrogate pair，但不会执行感知 locale 的 grapheme 分割。
