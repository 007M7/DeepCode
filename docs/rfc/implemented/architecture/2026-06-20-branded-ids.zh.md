# RFC：在所有应当使用品牌类型的位置推行 Branded ID

Status: implemented

[English](2026-06-20-branded-ids.md) | 中文

## 问题

harness 已经为三个标识符打上了品牌类型：`CallId`（`packages/llm/llm/src/brand.ts`）、`SessionId`（`packages/core/session/src/types.ts`）和 `AgentId`（`packages/core/agent/src/types.ts`），使用 `Branded<B> = string & { readonly [BRAND]: B }` 机制（由纯类型包 `@deepseek-ai/dsh-brand` 拥有，位于 `packages/util/brand/`，见其 [README](../../../../packages/util/brand/README.md)），并为每个类型提供零成本的 cast 工厂函数。`dsh-brand` 还声明了治理策略：*"品牌类型用于跨包边界且可能被混淆的 id；并非每个 string 都需要品牌类型。"* 这条策略是正确的；问题在于它只落实了一半。两个缺口使得「结构相同但语义不同」的 string 今天仍能通过类型检查。

**缺口 1：bash seam 中未打品牌的 ID。** `BashTask.id` 以及所有 executor/tool 边界使用裸 `string`，尽管生成的值与默认 session id 具有相同的 `name-N` 形状。模型也通过 `task_id` 返回该值，因此混淆 task id 和 session id 既是类型正确的，也是可达的。

bash **owner token** 是相关的子情形：`BashExecRequest.owner?: string` 和 `BashExecSpec.owner: string | undefined`（`packages/bash/bash/src/types.ts`）被文档描述为刻意*不透明*的隔离键，但在所有实际调用方中，该值就是拥有者 agent 的 `session.header.id`（`callerToken = (exec) => exec.agent?.session.header.id`，见 `packages/bash/tool-bash/src/index.ts`）——即一个穿着 `string` 外衣的 `SessionId`。它被用于访问控制比较（`owner !== callerToken(exec)`），因此一个「不匹配但类型正确」的 string 在此处就是一个跨会话隔离 bug，而当前类型系统无法捕获。这正是 [unify-the-agent-id-and-the-session-id](../../proposed/simplification/2026-06-20-unify-agent-and-session-id.md) 提案所称的「bash owner-token 别名漏洞」。

**缺口 2：既有品牌类型的侵蚀。** `CallId`、`SessionId` 和 `AgentId` 在注册表 map、公开查找参数、ACP 会话追踪和持久化协调器中退化为裸 string。在查找边界丢弃品牌类型，等于废掉了它的核心保护。

## 决策

纯类型变更。品牌类型是零成本 cast；运行时行为、序列化、比较和协议格式（wire format）均不变。工作分三部分，全部遵守既有的「并非每个 string 都需要」策略。

- **为 bash task id 打品牌。** 在 `packages/bash/bash/src/types.ts`（*拥有*该 id 的包）中添加 `BashTaskId = Branded<'BashTaskId'>` 及其同名工厂函数，从 `@deepseek-ai/dsh-brand` 导入 `Branded`，方式与 `SessionId`/`AgentId` 完全一致。品牌原语放在无依赖的 `dsh-brand` 工具包中，正是为了让 `dsh-bash` 只依赖它就能为自己的 id 打品牌——永远不需要为了获取 `Branded` 而引入 `dsh-llm`（或 `dsh-session`）。将品牌贯穿 `BashTask.id`、`BashExecutor` seam 方法（`get`/`ownerOf`/`readOutput`/`kill`）、`dsh-bash-local` 中的生成点（在创建时一次性为计数器输出打品牌），以及 `dsh-tool-bash` 的校验/访问控制面（`validateTaskId` 返回 `BashTaskId`；`task_id` 在模型 string 到达的 tool 边界处打品牌）。

- **铸造独立的 `OwnerToken` 品牌。** 在 `packages/bash/bash/src/types.ts` 中添加 `OwnerToken = Branded<'OwnerToken'>`；将 `BashExecRequest.owner` / `BashExecSpec.owner` / `BashExecutor.ownerOf` 的类型标注为 `OwnerToken | undefined`。`dsh-tool-bash` 消费方在边界处将 agent 的 `session.header.id`（一个 `SessionId`）cast 为 `OwnerToken`——这是两套词汇交汇的唯一位置。bash seam 永远不导入 `dsh-session`。（理由见下一节。）

- **阻止品牌侵蚀。** 将既有品牌传播到缺口 2 列出的 `Map` 键类型和公开方法参数：`Map<SessionId, Session>`、`get(id: SessionId)`、`Map<AgentId, Agent>`、`Map<CallId, …>`、ACP 的 `SessionRecord.sessionId: SessionId` 接口、协调器的 `Map<SessionId, …>`。这是 diff 中机械性最大的部分，也是让*既有*品牌在查找处真正发挥作用（而非仅在结构体字段上标注）的关键。

示意形状（工厂模式与现有三个品牌完全一致）：

```ts ignore-check
import type { Branded } from '@deepseek-ai/dsh-brand'

/** A background bash task handle (generated `bash-N` by the local executor). */
export type BashTaskId = Branded<'BashTaskId'>
export function BashTaskId(id: string): BashTaskId {
  return id as BashTaskId
}

/** A bash task's opaque isolation key — the consumer's owner identity, NOT the bash seam's. */
export type OwnerToken = Branded<'OwnerToken'>
export function OwnerToken(id: string): OwnerToken {
  return id as OwnerToken
}
```

## 曾考虑的替代方案

### 为什么不把 `owner` 类型标注为 `SessionId`？

executor 将 ownership 视为不透明的，不应依赖 session 模型。独立的 `OwnerToken` 保持了这一边界，同时防止裸 string 或 task id 被当作 owner 传入。`dsh-tool-bash` 拥有访问策略，由它执行从 `SessionId` 到 `OwnerToken` 的唯一转换。

## 不在范围内 / 可能的扩展

遵循「并非每个 string 都需要品牌类型」策略，刻意保持窄范围。以下每项都是合理的未来品牌候选，附有推迟理由而非承诺：

- **`ModelId`**（`GenerateOptions.model`，`LlmService` 适配器注册表键）——一个真正的跨包查找键（config → agent → llm → adapter）；合理的下一个品牌，仅为控制本 RFC 的影响范围而暂不纳入。
- **`ToolName`**（`ToolRegistry` 键）——由作者定义、人类可读，且很少与其他 id 混淆；候选强度最弱，可能不值得打品牌。
- **`ErrorCode`**（`HarnessError.code`）——封闭词汇（`ABORTED`、`NO_ADAPTER`……），不是逐实例的 id；如果要加强类型，用 string 字面量联合类型比品牌更合适。
- **数值序号**——轮次号、步骤号和事件 `seq` 是 `number` 而非 `string`，`Branded<string>` 不适用；可以用并行的 `number & { readonly [BRAND]: B }` 变体为它们打品牌，但它们是位置序号、很少跨边界传递，收益低。
- **带校验的构造**——品牌工厂是纯 cast，无运行时检查，且每个边界（ACP `sessionId`、提供方发放的 `call.id`、`dsh-llm-deepseek` 中的空字符串回退）今天都信任裸 string。一个在边界对畸形输入抛异常的 `SessionId.parse()` / `isValid()` 伴生函数确实是缺口，但它是一项*运行时行为*变更，有自己的设计问题（什么算「畸形」？失败时怎么办？），应在独立 RFC 中处理，不应捆绑进这次纯类型改动。

## 验证

`BashTaskId` 和 `OwnerToken` 定义在 `dsh-bash` 中，贯穿 executor、本地实现和面向模型的 tool，且未引入 `dsh-session` 依赖。集合、公开参数和导出签名对 `CallId`、`SessionId`、`AgentId` 或 `BashTaskId` 使用对应的品牌类型而非裸 `string`；来自提供方、ACP 和模型的原始输入通过品牌工厂进入，而非散落的 cast。

## 后果

- **两个面上的机械性改动。** 传播品牌类型涉及 bash seam（接口 + 实现 + 消费方）以及 ACP session-id 接口和持久化协调器。改动面广但严重度低：遗漏的位置是编译错误，而非静默 bug。变更可观测地是纯类型的——无快照或 e2e 行为差异。它与 [unify-the-agent-id-and-the-session-id](../../proposed/simplification/2026-06-20-unify-agent-and-session-id.md) 提案相邻（两者都触及 session-id / owner-token 边界）；即使该提案落地，`OwnerToken` 出于上述解耦理由仍与统一后的 id 保持独立。
- **品牌类型不做校验。** 品牌类型是混淆防护，不是正确性证明：一个*错误的* session id 只要仍是格式良好的 string，就和以前一样能通过类型检查。本 RFC 不关闭这个缺口（见「不在范围内」）——它只阻止传入错误*类别*的 id 这一类错误。
- **「在哪里停下」仍是判断题。** 为 `BashTaskId` 打品牌而不为 `ToolName`，为 `OwnerToken` 打品牌而不为 `ModelId`，是对哪些 string「可能被混淆」的品味判断。合理的评审者可能想要更多或更少；`brand.ts` 中的策略是裁决依据，本 RFC 倾向于面向模型或用于访问控制的 id。
