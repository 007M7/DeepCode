# RFC: Cooperative tool cancellation at the registry boundary

Status: implemented

English | [中文](2026-07-19-cooperative-tool-cancellation.zh.md)

## Problem

Every registered tool receives an optional `AbortSignal`, but a signal alone does not define a reliable cancellation boundary. Cancellation can arrive while pre-execution policy or approval is waiting, while an around-dispatch wrapper is waiting before or after delegation, or after the tool body has started. If each tool and wrapper interprets those races independently, a body can start after its caller has cancelled or a late success can escape after cancellation.

Around-dispatch plugins also need to replace `exec.signal` to add deadlines or other operational cancellation. Treating that mutable slot as the only caller signal lets a wrapper accidentally detach caller cancellation. Forbidding replacement would remove the lexical composition used by the [tool-call timeout policy](2026-07-07-tool-call-timeout-policy.md).

Returning `ABORTED` by racing the tool promise is not a safe fallback. Same-process JavaScript keeps running after the losing promise is abandoned, so subprocesses, network activity, nested dispatches, and deferred context production can outlive the reported result. The registry cannot generically hard-kill that work because termination belongs to the capability that owns it, as established by the [timeout/deadline decision](2026-07-06-timeout-deadline-library.md).

## Decision

`ToolRegistry` owns a cooperative, quiescent cancellation boundary for every call through `ctx.tools.execute()`. It preserves caller cancellation independently of around-dispatch mutation, prevents a body from starting after live cancellation, awaits every body that did start, and lets cancellation that wins before final result materialization supersede every successful pipeline outcome.

This is a control-plane guarantee, not universal hard termination. Every asynchronous `ToolDefinition.execute()` observes or forwards `exec.signal` and settles only after its owned work stops. The registry does not claim bounded-time settlement for same-process code that violates that contract.

### Caller cancellation survives the pipeline

The registry captures the caller's signal and whether it was already aborted when it materializes the execution. That state is kept outside the wrapper-mutable `ToolRunContext`.

A signal that was live on entry is rechecked after `tools/pre-execute`, approval, and immediately before the tool body. Cancellation during any of those waits yields structured `ABORTED` without starting the body. Immediately before dispatch, the registry fuses the original caller signal with the current wrapper-supplied `exec.signal`, so adding, replacing, or removing the public slot cannot detach the caller from a running body. Dispatch-scoped listeners are removed when the body settles.

The registry also rechecks the original caller after the around-dispatch waterfall and post-result policy settle. A wrapper or post-policy listener cannot return a late successful result after caller cancellation merely because the body completed earlier. A wrapper- or policy-owned failure remains a failure; the timeout-policy wrapper may therefore classify its own winning deadline as `TOOL_TIMEOUT` instead of losing that information to generic cancellation.

### Started work reaches quiescence

Once `ToolDefinition.execute()` starts, the registry awaits it. Cancellation that arrives after the body starts notifies it through the fused signal but does not race or abandon its promise. If the body settles successfully after that cancellation, the registry replaces success with `{ name: 'AbortError', code: 'ABORTED' }`; a structured tool failure remains the more specific result. Context deferred by a composite tool is retained when generic cancellation replaces success.

This applies even to an uncooperative body: the registry remains pending until the body settles. That cost is deliberate because returning early would make the call appear complete while its side effects remain live. Process, worker, network, and provider implementations supply their own termination mechanism and use the signal to reach quiescence; the registry only owns dispatch and result integrity.

A cancellation result produced before `tools/post-execute` continues through that policy; cancellation while an asynchronous post listener is waiting replaces only its successful outcome. The frozen `tools/result` notification is the completion boundary, and the agent loop records the resulting model-visible `tool/result`, preserving reconstructability.

### Pre-aborted entry is a distinct direct-call contract

A signal already aborted when registry entry begins still reaches the tool body. Direct service callers use that state for capability-specific cleanup or error translation, and the more specific result remains observable. The agent-loop scheduler does not start a new model-driven body under an already-aborted turn signal, so this exception does not reopen late model dispatch.

## Verification

[`tools.spec.ts`](../../../../packages/core/tools/tests/tools.spec.ts) pins cancellation during pre-policy and around/post waits, signal replacement and removal, no-late-success behavior, context retention, started-body drainage, and pre-aborted direct entry. [`tool-calls.spec.ts`](../../../../packages/core/agent-loop/tests/tool-calls.spec.ts) and [`contract-regressions.spec.ts`](../../../../packages/core/agent-loop/tests/contract-regressions.spec.ts) pin the no-late-start rule and balanced session-log results for undispatched sibling calls. [`timeout-policy.spec.ts`](../../../../packages/timeout/timeout-policy/tests/timeout-policy.spec.ts) pins caller-cancel-first and timeout-owned classification.

No registry test can prove that arbitrary third-party same-process code stops in bounded time. Capability tests remain responsible for proving their subprocess, worker, socket, or provider cancellation reaches quiescence.

## Alternatives considered

**Race the tool promise against cancellation.** Rejected because it reports completion while the losing promise and its side effects remain live. This violates the [quiescent-disposal rule](../../../defensive-patterns.md#dispose-must-reach-quiescence-not-just-request-it) and can let work mutate state after the session records `ABORTED`.

**Make the registry hard-kill every tool.** Rejected because same-process JavaScript has no safe generic preemption mechanism, while real termination differs by capability: process groups need signals and escalation, workers need termination, and network clients need protocol-aware abort. Moving those mechanisms into `ToolRegistry` would couple the core registry to every implementation.

**Trust each tool and around wrapper to preserve caller cancellation.** Rejected because the mutable signal slot and asynchronous pre/around waits form one shared scheduling boundary. Central capture and rechecks give every registered tool the same no-late-start and no-late-success rules without duplicating race handling.

**Forbid around wrappers from replacing `exec.signal`.** Rejected because deadlines and nested operational scopes need to derive a signal for one lexical dispatch. Re-fusing the caller immediately before the body preserves both composition and cancellation.

**Skip every call whose signal is aborted at entry.** Rejected because direct callers may need the tool body to perform cleanup or translate cancellation into a capability-specific result. The registry distinguishes that explicit entry state from a live signal that aborts during scheduling, while the agent loop independently prevents new model-driven dispatch after turn cancellation.

## Consequences

- Every registry invocation has one service-layer cancellation contract, including tools supplied by plugins or MCP bridges, but only cooperative implementations are guaranteed to stop promptly.
- Caller cancellation is monotonic across pre-policy, around-dispatch, and post-policy success: once a live caller signal aborts before final materialization, a body does not start late and a normal success does not become authoritative.
- Started work can delay cancellation indefinitely when an implementation ignores its signal. The registry deliberately exposes that defect as a non-quiescent call instead of hiding it behind an early result.
- Capability-specific failures and timeout ownership remain intact. Generic `ABORTED` replaces success, not a more informative error result.
- Around wrappers retain signal replacement as their composition mechanism, while the original caller signal remains non-detachable at dispatch.
