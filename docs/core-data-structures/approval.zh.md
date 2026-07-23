# 用户审批

[English](approval.md) | 中文

[dsh-user-approval](../../packages/ui/user-approval) 的用户审批 seam 回答一个问题：这个具体操作是否可以继续？它拥有共享的请求/结果词汇、`ctx.approval` 分发服务、`approval/request` 应答者 waterfall（瀑布式事件）、仅记录日志的审计事件对，以及按会话的 `ask`/`never` 策略。UI 通道如 [dsh-acp](../../packages/ui/acp) 提供应答者；调用方如 [dsh-tools](../../packages/core/tools) 和 [dsh-tool-bash](../../packages/bash/tool-bash) 消费闭合的结果，除非结果为 `allowed-once`，否则一律拒绝。

源码：[`packages/ui/user-approval/src/index.ts`](../../packages/ui/user-approval/src/index.ts)

## 标识与结果

每个请求都会获得一个全新的 `ApprovalRequestId`。该品牌类型将 `approval/asked` 与 `approval/decided` 审计事件配对，同时不会让审批 id 与工具调用 id 或 agent（智能体）/会话 id 互换。

```ts type-equiv
/**
 * Pairs one `approval/asked` audit event with its `approval/decided`.
 * Service-issued (one fresh id per {@link ApprovalService.request} call).
 */
type ApprovalRequestId = Branded<'ApprovalRequestId'>
```

`ApprovalOutcome` 是闭合的，且默认拒绝。`allowed-once` 仅授权所询问的那一个操作；调用方对 `rejected`、`cancelled` 和 `unavailable` 均执行拒绝。缺失、无所有权、抛异常或不合规的应答者会产生 `unavailable`，而非放行。

```ts type-equiv
/**
 * Closed approval outcomes: a one-shot grant, explicit rejection, withdrawn
 * request, or unavailable answerer. Callers fail closed on `unavailable`.
 */
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
```

## 按会话策略

`ApprovalPolicy` 决定在交互式应答者运行之前发生什么。`ask` 委托给组合的应答者链，链的无应答默认值为 `unavailable`；`never` 确定性地返回 `rejected`，不分发任何应答者。生效值为会话日志中最后一条 `approval/policy` 事件，回退到服务配置。`setApprovalPolicy(session, policy)` 是唯一的写入路径，因此回放能重建覆盖值。

```ts type-equiv
/**
 * A session's approval policy — what happens to an {@link ApprovalService}
 * ask BEFORE any interactive answerer sees it:
 *
 * - `'ask'` (the default) — delegate to the composed answerers; with none
 *   composed the chain falls through to the fail-closed `'unavailable'`
 *   (exactly today's behavior).
 * - `'never'` — never prompt anyone: every ask resolves `'rejected'`
 *   deterministically. The strict headless stance (CI, unattended runs) and
 *   the only policy value stated in the system prompt — unlike `'ask'`, its
 *   outcome is knowable without asking, so stating it cannot overclaim.
 */
type ApprovalPolicy = 'ask' | 'never'
```

提示词段落会声明 `never` 的确定性行为，并以服务自有的标记记录当前策略。重启后，步骤前叙述器从已记录的请求头中读取该标记，而非从部署 persona 行文中推断状态。ACP（Agent Client Protocol）空闲切换会在 bridge 中保持，直到下一个 `turn/start`，因为审批审计和策略事件必须保持在轮次内，以确保持久回放的正确性。

## 审批请求

`ApprovalRequest` 以足够精确的方式标识 agent 和工具操作，以便路由和审计该问题。它有意省略工具参数：应答者通过 `callId` 将提示附加到已流式输出的工具调用上，而非渲染一份可能漂移的副本。

```ts type-equiv
/**
 * Readonly same-process permission question. `callId` links to an already
 * presented tool call, so arguments are not duplicated here.
 */
interface ApprovalRequest {
  /**
   * The agent on whose behalf the question is asked. Routes the question (a
   * UI answerer only answers for agents it owns) and receives the audit
   * events on its session log.
   */
  readonly agent: Agent
  /** The tool the question is about (presentation and audit). */
  readonly toolName: string
  /**
   * The exact tool call being decided, when the asker has one — lets a UI
   * attach the prompt to the tool call it already streamed.
   */
  readonly callId?: CallId
  /** The asker's human-readable explanation of WHY it is asking. */
  readonly reason?: string
  /**
   * Aborting withdraws the question: the request settles `'cancelled'`
   * immediately and a late answer from a still-pending answerer is discarded.
   */
  readonly signal?: AbortSignal
}
```

## 分发与审计

`ctx.approval.request(req)` 要求发起请求的会话处于一个打开的轮次内。它追加 `approval/asked`，获取一个结果，追加对应的 `approval/decided`，然后以该结果 resolve。`never` 策略在服务内部、waterfall 分发之前强制执行，因此即使后来以 `prepend` 注册的应答者也无法绕过它。应答者在拥有该请求时返回结果，否则调用 `next()` 委托；第一个应答占据唯一的决策槽位。

审计事件仅写入日志，不进入模型 transcript（文本记录）。模型可见的行为是调用方派生的工具结果，而请求头记录的是模型实际看到的提示词策略。服务 dispose（资源释放）时会一并移除其提示词段落和步骤前叙述器；应答者监听器独立地通过 effect 绑定到其所属插件。
