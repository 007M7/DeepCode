# RFC: Subagent capability seam

Status: implemented

> **Implementation status:** shipped across four PRs. PR1 landed this proposal + the `dsh-subagent` interface, the `dsh-subagent-mock` test backend, and the `dsh-tool-subagent` consumer; PR2 the two in-process backends (`dsh-subagent-spawn`, `dsh-subagent-fork`); PR2.5 the nested-agent snapshot infrastructure (see [Per-session snapshot replay for nested agents](../testing/2026-06-22-subagent-snapshot-replay.md)); PR3 the out-of-process `dsh-subagent-acp` backend (see [ACP subagent backend](2026-06-22-acp-subagent-backend.md)). The design below is amended to describe what actually landed.

## Problem

The harness has a long-deferred seam for **subagents** — an agent delegating work to another agent. The intent was sketched in the `Agent`/`AgentLoop` interfaces ([packages/core/agent/src/types.ts](../../../../packages/core/agent/src/types.ts), [packages/core/agent-loop/src/index.ts](../../../../packages/core/agent-loop/src/index.ts)): a creation option referencing a parent agent (fork = seed the child session with the parent's event log; spawn = fresh session), with the child returned as an `Agent` handle so steering and event subscription work uniformly. This RFC realizes that seam (see the implementation-status banner above for what has landed); the design below is the proposal it was argued from, when no service, vocabulary, or implementation yet existed.

The distinctive requirement — the one that shapes the whole design — is that **multiple subagent implementations must coexist at runtime**. A parent may want a cheap in-process child for a scoped subtask AND an isolated out-of-process child (over ACP) in the same session. The transports we foresee:

- **in-process** — a child `ReactLoopAgent` on the same `Context` (the cheapest, and nearly free given the existing agent factory);
- **ACP** — act as an ACP *client* driving another agent process (which can be another instance of ourselves);
- later: **A2A**, the **Codex app-server**, and the **Claude Code Agent SDK** — each the same out-of-process "start a child, prompt it, stream updates, cancel" shape as the ACP backend.

## Why not the bash seam shape

The bash seam ([capability seams](../../implemented/architecture/2026-06-13-capability-seams.md)) registers exactly one `BashExecutor` per context; loading a second throws. That is correct for bash (one machine, one way to run a command) but wrong here: coexistence is the requirement. So the subagent service is a **named-provider registry** — each implementation registers under a unique name and a caller picks one by name — mirroring the **LLM adapter registry** (`LlmService.registerAdapter`), not the single-service bash executor. The seam is still three-package (interface / implementation / consumer); only the "one vs. many implementations" axis differs.

## Proposal

### The three-package seam

A new package group `packages/subagent/`:

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-subagent` | interface: `SubagentService` (`ctx.subagents`), `SubagentProvider`, `SubagentRun`, the request/result/capability vocabulary, the `subagent/*` events |
| `@deepseek-ai/dsh-subagent-spawn` | implementation: a fresh in-process child via `ctx.agents.create` (PR2) |
| `@deepseek-ai/dsh-subagent-fork` | implementation: an in-process child seeded with a snapshot of the parent's log (PR2) |
| `@deepseek-ai/dsh-subagent-acp` | implementation: an ACP client driving a configured child process (PR3) |
| `@deepseek-ai/dsh-subagent-mock` | support: a scripted provider for testing the seam through the real load path (PR1) |
| `@deepseek-ai/dsh-tool-subagent` | consumer: the model-facing `subagent` tool over `ctx.subagents` (PR1) |

### The primitive: `start → SubagentRun`

A provider exposes `start(request) → SubagentRun`. The run carries a `result` promise (the terminal `SubagentResult`), `cancel()`, and `dispose()`. The transport-neutral verb is **`start`**; "spawn" is reserved for the in-process `dsh-subagent-spawn` backend's identity, not the service verb. The service's `start(name, request)` resolves the named provider, validates capabilities, delegates, and emits `subagent/start` / `subagent/end` around the run.

### Two kinds of optional capability, discovered two ways

- **Start-time features** (`outputSchema`, `depthLimit`, `toolFilter`) ride on a static `provider.capabilities` descriptor. The service checks every requested one BEFORE delegating and **rejects loud** (`SubagentError('UNSUPPORTED_CAPABILITY')`) if the provider lacks it — never accepted-then-ignored. They must be checked before a run exists, which is why they cannot be runtime methods.
- **Runtime features** (steering via `sendMessage`, follow-up via `resume`) are **optional methods** on `SubagentRun`. The method's presence IS the capability, and TypeScript narrowing is the discovery mechanism: a consumer cannot call an absent method without narrowing first, so there is no silent-degradation path and no separate flags object to keep in sync.

### Fork vs. fresh are separate backends, not a flag

Rather than a `context: 'fresh' | 'fork'` request field, the distinction is the provider's identity: `dsh-subagent-spawn` (fresh, isolated, own system prompt) and `dsh-subagent-fork` (seeded from the parent's log) are two registered providers. You pick behavior by picking a provider — consistent with the registry being the selection mechanism.

### Child isolation and the parent log

Each subagent runs in its **own `Session`** (own id, `parentSession` lineage), persisted independently. The parent's log records only the spawn `tool/call` and its `tool/result` (the child's final output) — the child's internal steps and tool calls stay in the child's own session, never injected into the parent log. This is the only design that is identical across transports: an ACP child's internal events physically cannot be injected into our parent log, so making in-process behave the same keeps the seam transport-agnostic.

### Synchronous collect (first cut)

The `dsh-tool-subagent` consumer awaits `run.result` and returns the child's final output as the tool result, blocking the parent's turn until the child finishes. It does so inside a `try/finally` that always `dispose()`s the run (no leaked idle child/session on any path), bridges `exec.signal` to `run.cancel()`, and maps a non-`completed` stop reason to an `isError` result rather than returning partial output as success. Steering (`sendMessage`) is part of the contract but **intentionally unused** this cut.

### Provider selection is config, not model-facing

`dsh-tool-subagent` binds to exactly one provider name (`Config.provider`); the model sees only `{ description, prompt }`. To expose more than one transport, load the tool plugin more than once, each bound to a different provider and a distinct `toolName` (the tool registry rejects a duplicate name). The *service* holds the multi-provider registry; the *tool* picks one — no provider/type parameter in the schema this cut.

## Plan (three PRs, each converged with Codex separately)

1. **PR1 — interface + tool + mock.** This RFC, `dsh-subagent` (service, registry, vocabulary, `subagent/*` events), `dsh-subagent-mock` (scripted provider), `dsh-tool-subagent`. Wire the new `packages/subagent/` group into the tsconfigs, the build references, the package hierarchy docs, and the module graph. Tests: registry HMR-safety, duplicate-name rejection, start-time capability rejection, and at least one test driving the tool through the **real cordis Loader / export path** (a hand-built `ctx.plugin` mount bypasses `unwrapExports` and cannot catch a broken export shape — see [postmortem 0001](../../../postmortem/0001-acp-default-export-drops-inject.md)).
2. **PR2 — in-process backends.** `dsh-subagent-spawn` and `dsh-subagent-fork` over `ctx.agents.create` + `AgentHandle.dispose`. The fork backend must seed only a **balanced, completed-turn prefix** of the parent log: at tool-execute time the parent's turn is open (it holds the `assistant/message` and the dangling spawn `tool/call` with no `tool/result`), and seeding that raw prefix gives the child an unbalanced turn the [invariants](../../../../packages/support/invariants/src/index.ts) freeze-check rejects. Depth tracking (parent depth + 1, refused past `maxDepth`) and its exact storage are settled in PR2.
3. **PR3 — ACP backend.** `dsh-subagent-acp` as an ACP client over a configured spawn command (stdio); point it at our own `acp-agent` example to "talk to our own process". Minimal client stub: advertise no optional client capabilities, auto-resolve `session/request_permission` via a configured default, consume `session/update` without surfacing it this cut. Decide the `@agentclientprotocol/sdk` version (recommended: bump to 0.28.x for the fluent client API; the bump is shared with the existing `dsh-acp` bridge, so re-run its snapshot + e2e).

## Risks and deferrals

- **Recursion.** Without a guard, an in-process child inherits the spawn tool and can spawn unboundedly. Depth-limit is an optional capability (the in-process backends enforce it; ACP advertises it off and rejects a `maxDepth` request); tool-filtering is likewise optional. Tool-filtering, when implemented, needs a `tools/pre-execute` deny in the child context — schema filtering alone is insufficient because a model can hallucinate a denied tool name.
- **Blocking the parent turn.** Synchronous collect holds the parent's `runStep` open for the child's full duration. This is acceptable for the first cut; **background / poll / spill semantics are deferred to a future redesign that unifies long-running-tool handling across subagents AND bash** (a sub-agent and a long `bash` background task pose the same "the model started something slow, how does it collect later" problem, and should share one mechanism rather than each inventing its own).
- **Live progress.** This cut surfaces only lifecycle + final result; a per-chunk child→parent update stream is deferred with the background redesign.
- **ACP client surface.** Proxying `fs`/`terminal` from the ACP child back to the parent (a shared-workspace mode) is future work; the first cut advertises neither, so the child self-serves in its own process.
- **Snapshot coverage of nested agents.** The snapshot tier (`pnpm run test:snapshot`) replays a recorded session through `dsh-llm-replay`. It was built single-session: a single GLOBAL positional cursor (the Nth `llm/stream` call serves the Nth recorded entry) and a harness that harvested a single session log file. A subagent runs as a *second* agent with its own session log, so a parent→child scenario needed per-session-keyed replay plus harvest-all-logs and plural-session-id plumbing — self-contained infrastructure orthogonal to the backends, scheduled as a dedicated stacked follow-up rather than folded into the in-process-backends PR. That follow-up has **landed**: see [Per-session snapshot replay for nested agents](../../implemented/testing/2026-06-22-subagent-snapshot-replay.md). Replay now keys each call by its calling session (`GenerateOptions.sessionId`) and binds live sessions to recorded scripts by first-call order; the harness harvests every log; and two nested scenarios (`subagent-spawn`, `subagent-multi`) replay keyless in the default gate. In-process subagents remain covered by real-loop unit tests and a with-key e2e in addition to the snapshot tier.
