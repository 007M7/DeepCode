# @deepseek-ai/dsh-compact-basic

[English](README.md) | 中文

**基础压缩（compaction）后端**：`BasicCompactService` 实现 `@deepseek-ai/dsh-compact` seam，使用可复用的 `ctx.tokenMeter` 压力、token 预算保留与摘要。摘要是直接的一次性 `ctx.llm.stream()` 调用，它会回放会话前缀以复用提供方的 KV cache（可在 `llm/stream` 处拦截）。

这是压缩能力的实现层。seam 见 [接口包](../compact/README.md)，设计见 [能力 seam Agent Note](../../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md)。

## 拥有的职责

该后端拥有压缩策略：

- **测量**：单例 `ctx.tokenMeter` 会在同一个已消费日志 revision 上为最新规范已记录 envelope 与当前表层计价。因此，步骤边界压力会包含实际系统提示词、工具、路由、assistant 完成、工具结果、缓冲上下文与 steering。
- **路由策略**：主动压力从拥有最新持久提供方／模型路由的适配器解析容量，再将默认策略与可选的精确目标覆盖缩放为具体 token 预算。模型发现仍只提供建议，不会被咨询。
- **不依赖模型的剪枝**：在压力或规范溢出符合条件后，可选的 [`ctx.toolResultPrune`](../compact-tool-result-prune/README.md) 服务会在选择范围之前改写超大工具结果。Compact-basic 通过 `ctx.tokenMeter` 重新测量；如果压力已回到安全范围，就跳过摘要，否则摘要已剪枝表层。低于压力的步骤检查绝不剪枝。
- **保留**：压缩最旧的完整表层单元，同时保留近期尾部，并通过 [`dsh-compact` 边界 helper](../compact/README.md#tool-pairing-boundaries) 保持工具调用／结果 cut 平衡。轮次边界不会保护失控轮次内的旧步骤。开启且不可分的尾部在关闭前会拒绝压缩。当闭合的超大工具单元以文本型结果为可移除主体时，可选 pruner 可以修复它；不可分的非工具单元与不可剪枝的工具剩余部分不在范围内。
- **收敛**：最多按 `compactionRetries` 重试头部检查点压缩；拒绝不能缩小源内容的摘要，如果重试仍无法回到阈值以下，则抛出异常。
- **摘要**：直接 `llm/stream` 调用使用已配置的提供方／模型对与上限，回退到最新已记录请求目标，然后再回退到 agent（智能体）目标，而不运行仅用于 loop 的 `agent/request` seam。该调用会逐字回放会话自身的系统提示词、工具与已遮蔽区域消息，并将压缩指令作为最后一条 user 消息追加，从而复用提供方的热前缀 cache，而非使它失效。它将 `GenerateOptions.purpose` 设为 `compaction`，适配器可将其作为请求归因转发（DeepSeek 适配器发送 `x-deepseek-harness-compact: 1`），但不会触碰模型可见主体。只有返回文本会进入检查点；会排除可能泄露私有推理或产生遗留调用的 reasoning 与工具调用。
- **框定**：替换 user 消息使用 `<compacted-summary>` 标签标记已建立的检查点上下文。原始摘要保留在溯源事件上，后续自动周期会合并之前的检查点。
- **生命周期**：`compactRegion()` 会更改 `agent.session`，并记录开始、摘要、替换与结束。异步摘要后，它会拒绝已改变的表层节点快照，而不相关的仅日志事件可以追加，不会使已选 span 失效。串行 `agent/step` listener 会在派生请求之前检查压力。规范提供方溢出会在失败步骤之后经由 `agent/request-error` 交给本插件；插件在此执行压缩，并且只在表层取得持久进展后才返回重试动作。
- **溢出恢复**：提供方已确认的溢出不需容量元数据。它会绕过常规压力与保留，执行剪枝，再尝试一次最大平衡头部缩减，并留下最新不可分单元。只要 `surface.replaceGeneration` 前进，就允许重试，包括剪枝在后续摘要工作抛出异常前已落地的情况。如果没有替换、精确目标上限已耗尽、已取消，或遇到未知／非规范错误，则保留原始提供方失败。
- **失败处理**：不匹配的 `compact/start` 是惰性崩溃标记，因为没有摘要替换落地。区域失败会记录错误结束；除非剪枝已落地，否则表层保持不变。操作性压力失败会发出警告并继续；只当之前没有替换使表层前进时，溢出恢复失败才保留原始提供方错误。取消在任何进展后仍具有最高权威。

受保护的 `summarize()` 方法是唯一的子类 hook。基于模板或远程摘要器的子类可以覆盖该方法，同时压力、保留、溯源、缩减验证与已遮蔽 token 计量仍位于 `ctx.tokenMeter`。hook 会将摘要块与它使用的调用 envelope 一并返回（`{ summary, provider, model, maxTokens? }`），并记录在 `compact/summary` 上。

## 配置（`BasicCompactConfig`）

所有设置都可选。顶层策略字段是每个已路由模型的默认值；`modelPolicies` 对精确提供方／模型对应用部分覆盖。出现压力时，compact-basic 会请求所属 LLM 适配器提供该路由的上下文容量，并解析绝对预算。无法识别的 key、重复目标、互斥保留形式，以及合并后的 `retainRatio` 不低于 `thresholdRatio`，都会使插件加载失败。不低于缩放后阈值的绝对 `retainTokens` 预算会在第一个可解析目标上失败，因为该比较需要模型容量。

| Key | 必填 | 含义 |
|---|---|---|
| `thresholdRatio` | 否（默认 `0.8`） | 在 `floor(routedContextWindow × ratio)` 处压缩。 |
| `retainRatio` | 否（默认 `0.16`） | 以已路由上下文窗口的一部分表示逐字保留的近期表层预算；与 `retainTokens` 互斥。 |
| `retainTokens` | 否 | 逐字保留的近期表层绝对预算；与 `retainRatio` 互斥，并且必须低于已解析阈值。 |
| `summarizationProvider` | 否（默认 `''`） | 与 `summarizationModel` 一起设置；空对会解析为最新已记录请求目标，再回退到 `AgentOptions` 对。 |
| `summarizationModel` | 否（默认 `''`） | 与 `summarizationProvider` 一起设置；空对会解析为最新已记录请求目标，再回退到 `AgentOptions` 对。 |
| `maxTokens` | 否（默认 `8192`） | 摘要调用的提供方生成上限；可包含 reasoning token。 |
| `compactionRetries` | 否（默认 `1`） | 压力仍高于阈值时，在首次尝试后进行的额外尝试次数。 |
| `maxOverflowRetries` | 否（默认 `1`） | 规范上下文窗口溢出后的最大重试次数；`0` 只禁用恢复。 |
| `modelPolicies` | 否（默认 `[]`） | 精确的 `{ provider, model, ...partialPolicy }` 覆盖；匹配使用两个字段，不依赖 `listModels()`。 |
| `auto` | 否（默认 `true`） | 注册步骤边界压力与溢出恢复 listener。设为 `false` 则仅手动执行。 |

每个 `modelPolicies` 配置项都接受上述策略字段，但不接受 `auto` 和 `modelPolicies` 自身。如果配置项提供任意一个保留字段，就替换默认策略的保留选择；否则继承保留设置。摘要提供方／模型在每个配置项内仍然成对。

适配器可能无法为有效动态路由返回容量，已解析容量也可能暴露无效的绝对保留预算。此时手动压力检查会抛出目标特定配置错误；自动 listener 会对该精确目标警告一次，并携带完整历史继续。不相关的操作性失败仍会独立可见。规范提供方溢出仍会尝试恢复，因为提供方已确立压缩的必要性。

## 用法

```ts
import type { Context } from 'cordis'
import { BasicCompactService } from '@deepseek-ai/dsh-compact-basic'
import TokenMeterService from '@deepseek-ai/dsh-token-meter'

export const name = 'compact-basic'
export const inject = ['llm', 'tokenMeter']

export function apply(ctx: Context): void {
  ctx.plugin(TokenMeterService)
  ctx.plugin(BasicCompactService)
}
```

加载插件会注册 `ctx.compact`。在该插件之前添加同级 [`dsh-compact-tool-result-prune`](../compact-tool-result-prune/README.md) 以启用可选的不依赖模型 pass。当 `auto: true`（默认）时，它会在 token 压力下自动压缩；消费方（未来的 `/compact` 工具）也可直接调用 `ctx.compact.compactIfNeeded(...)` 或 `ctx.compact.compactRegion(...)`。

例如，同一个 compact 插件可以安全服务于容量不同的模型，并应用一项目标特定策略：

```yaml
- name: '@deepseek-ai/dsh-compact-basic'
  config:
    thresholdRatio: 0.8
    retainRatio: 0.16
    modelPolicies:
      - provider: local
        model: small-context
        thresholdRatio: 0.7
        retainTokens: 2048
```

## 模型体验

### 会话历史

#### 模型看到的内容

成功步骤越过阈值后，如果已加载可选 pruner，超大工具结果会先被改写。如果仍需摘要，下一个请求会收到下方检查点前导、一个空行、`<compacted-summary>`、取决于数据的摘要以及 `</compacted-summary>`。溢出恢复会根据使表层前进的任何替换重建立即重试。检查点会替换已选较早范围，后面跟随已保留的近期单元。

##### 会话检查点前导

```markdown
This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.
```

#### Token 影响

不依赖模型的剪枝可以完全避免辅助调用；否则它会在摘要替换较早范围之前缩减该调用的 transcript。替换会缩减未来输入历史，而非追加第二份副本。摘要会保留到后续压缩将其替换，但不可分的非工具单元仍可能超出预算。

#### KV Cache 影响

它是替换，而非仅追加。每个检查点都会使从第一个已替换历史 token 起的复用失效；该范围之前未更改的请求前缀仍可复用。

### 辅助摘要器请求

#### 模型看到的内容

摘要模型会接收逐字回放的会话：与上次已路由请求为已遮蔽区域发送的相同系统提示词、工具 schema 与消息，后面跟随一条最终 user 消息，即下方压缩指令。会话模型绝不会看到该私有请求或其推理；只有返回文本会被存储。

##### 压缩指令（最终 user 消息）

```markdown
You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.

Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.

## Primary Request and Intent
- [the user's original and evolving goals; quote verbatim where the exact wording matters]

## Key Technical Concepts
- [technologies, frameworks, patterns, and conventions in play]

## Files and Code
- [exact path: why it matters, key changes or snippets]

## Errors and Fixes
- [error: how it was resolved, plus any related user feedback]

## Pending Tasks
- [explicitly requested work not yet completed]

## Current Work
- [precisely what was in progress at this checkpoint]

## Next Step
- [the single next action, directly in line with the most recent request, or "(none)"]

## Critical Context
- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]

Rules:
- Preserve exact file paths, commands, error strings, identifiers, and function signatures.
- Capture user feedback and explicit instructions faithfully, especially corrections.
- Do NOT mention this summarization request or that the context was compacted.
- Output only the checkpoint text: do not call any tool or take any other action.
- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.
```

#### Token 影响

这是一次独立模型调用：输入是已回放会话前缀加固定指令，输出受 `maxTokens` 限制。收敛重试可能多次支付这项成本。

#### KV Cache 影响

已回放系统提示词、工具与已遮蔽区域消息与会话最后一个已路由请求逐字匹配，因此提供方的热前缀 cache 可复用至尾随指令之前；只有该指令与摘要输出未缓存。将摘要器路由到不同提供方／模型，或压缩非头部范围，都会放弃该复用。

## 已知限制与暂缓事项

- **Meter 准确度遵循固定启发式规则**：可复用提供方用量缺失时，会回退到字符数加结构开销，而非精确 tokenization。
- **溢出分类由适配器维护**：提供方措辞可能改变；两个 DeepSeek 适配器将当前可识别的上下文限制失败规范化为 `CONTEXT_WINDOW_EXCEEDED`。
- **部分不可分单元与仅 envelope 溢出仍不在表层压缩范围内**：恢复无法缩减系统／工具／前缀、拆分不可分的非工具节点，或修复不可剪枝剩余部分仍超出窗口的工具单元。可选 pruner 可以缩减原本不可分工具对内的文本型工具结果主体。
- **`compactRegion` 要求开启轮次**：在完全关闭的会话上手动调用会抛出异常（「no open turn」），而不是执行压缩。
- **摘要失败会保留最新持久表层**：任何替换前，自动路径会记录警告，并携带完整超预算历史继续。如果剪枝已落地，后续摘要失败会从该持久剪枝表层继续。在 `maxTokens` 处的摘要截断（可能由隐藏 reasoning token 耗尽）遵循同一规则。
- **摘要调用没有 transcript 快照覆盖**：`dsh-llm-replay` 从 `assistant/chunk` 事件派生调用，因此这次不含 chunk 的直接 `ctx.llm.stream()` 调用无法回放（[seam Agent Note](../../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md) 中明确的暂缓回放基础设施）。
