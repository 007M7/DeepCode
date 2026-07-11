# User Approval

The user-approval seam of [dsh-user-approval](../../packages/ui/user-approval) answers one question: may this specific action proceed? It owns the shared request/outcome vocabulary, the `ctx.approval` dispatch service, the `approval/request` answerer waterfall, the log-only audit pair, and the per-session `ask`/`never` policy. UI channels such as [dsh-acp](../../packages/ui/acp) provide answerers; callers such as [dsh-tools](../../packages/core/tools) and [dsh-tool-bash](../../packages/bash/tool-bash) consume the closed outcome and fail closed unless it is `allowed-once`.

Source: [`packages/ui/user-approval/src/index.ts`](../../packages/ui/user-approval/src/index.ts)

## Identity and outcome

Every request receives a fresh `ApprovalRequestId`. The brand pairs the `approval/asked` and `approval/decided` audit events without making approval ids interchangeable with tool-call, session, or agent ids.

```ts type-equiv
type ApprovalRequestId = Branded<'ApprovalRequestId'>
```

`ApprovalOutcome` is closed and fail-closed. `allowed-once` grants only the asked-about action; callers deny on `rejected`, `cancelled`, and `unavailable`. A missing, non-owning, throwing, or non-conforming answerer becomes `unavailable` rather than opening the gate.

```ts type-equiv
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
```

## Per-session policy

`ApprovalPolicy` determines what happens before interactive answerers run. `ask` delegates to the composed answerer chain, whose no-answer default is `unavailable`; `never` deterministically returns `rejected` without dispatching any answerer. The effective value is the last `approval/policy` event in the session log, falling back to the service config. `setApprovalPolicy(session, policy)` is the single write path, so replay reconstructs the override.

```ts type-equiv
type ApprovalPolicy = 'ask' | 'never'
```

The prompt section states the deterministic `never` behavior and records either policy with a source-owned marker. The pre-step narrator reads that marker from the logged request header after restart; it does not infer state from deployment persona prose. An idle ACP switch is held in the bridge until the next `turn/start`, because approval audit and policy events must remain turn-enclosed for durable replay.

## Approval request

`ApprovalRequest` identifies the agent and tool action closely enough to route and audit the question. It deliberately omits tool arguments: an answerer attaches the prompt to the already-streamed tool call through `callId` instead of rendering a second copy that could drift.

```ts type-equiv
interface ApprovalRequest {
  /**
   * The agent on whose behalf the question is asked. Routes the question (a
   * UI answerer only answers for agents it owns) and receives the audit
   * events on its session log.
   */
  agent: Agent
  /** The tool the question is about (presentation and audit). */
  toolName: string
  /**
   * The exact tool call being decided, when the asker has one — lets a UI
   * attach the prompt to the tool call it already streamed.
   */
  callId?: CallId
  /** The asker's human-readable explanation of WHY it is asking. */
  reason?: string
  /**
   * Aborting withdraws the question: the request settles `'cancelled'`
   * immediately and a late answer from a still-pending answerer is discarded.
   */
  signal?: AbortSignal
}
```

## Dispatch and audit

`ctx.approval.request(req)` requires the requesting session to be inside an open turn. It appends `approval/asked`, obtains one outcome, appends the matching `approval/decided`, and resolves with that outcome. The `never` policy is enforced inside the service before waterfall dispatch, so even an answerer registered later with `prepend` cannot bypass it. Answerers return an outcome when they own the request or call `next()` to delegate; the first answer occupies the single decision slot.

The audit events are log-only and do not enter the model transcript. Model-visible behavior is the caller's derived tool result, while the request header records the prompt policy that the model actually saw. Service disposal removes its prompt section and pre-step narrator together; answerer listeners are independently effect-bound to their owning plugins.
