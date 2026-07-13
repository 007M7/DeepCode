# RFC: Agent lifecycle and ownership seams

Status: implemented

## Problem

Several ACP and tool-bash limitations were symptoms of the same missing seam: plugins could create or resume agents through `ctx.agents`, but they could not own and dispose one agent independently, and long-running bash tasks carried no stable owner in the executor itself. ACP aborted and awaited agents on disconnect but could not unregister just that session's agent; `session/cancel` could not cancel queued-but-not-yet-started work; and `tool-bash` kept task ownership in a plugin-local `Map`, so an HMR reload could make an old task look unowned.

## Decision

Three seams: the queue-aware cancel, the `AgentHandle` disposer, and the bash owner token.

### 1. Queue-aware `Agent.cancel(reason?)`

`cancel()` is the single public stop primitive. It clears queued and steering input, aborts an in-flight step, and arms a turn-scoped marker checked at each turn boundary. A queued prompt therefore cannot start after cancellation or absorb later input. `whenIdle()` waits for post-cancel quiescence, and ACP `session/cancel` maps to this method. An idle cancel does not arm the marker.

### 2. `AgentHandle` async disposer

`ctx.agents.create`/`resume` and `AgentFactory` return `AgentHandle = { agent, dispose() }`. Disposal is a consumer capability; an observer holding only `Agent` cannot tear it down. The caller fiber and factory provider also own the instance, and every path shares one memoized teardown: stop the loop, await quiescence and flushes, detach the agent and session, then unwind its scope. IDs become reusable when their registry entries detach. Config-created agents belong to the loop fiber; ACP stores and disposes each session handle.

Teardown order is load-bearing for durability. The session lifecycle and loop share one composite Cordis effect so LIFO disposal stops the loop and awaits `agent.done` before detaching the session. Sibling effects would dispose concurrently and could remove append hooks before the closing flush. Disposal notifications are contained so they cannot interrupt the chain.

### 3. Bash owner token in the seam

Background task ownership belongs to the executor. `BashExecSpec.owner` carries an optional opaque token, `ownerOf(id)` reads it, and `dsh-tool-bash` stamps the calling session token at start. `bash_output` and `bash_kill` reject mismatched callers; completion notices locate the live agent by session token through the registry. Keeping ownership on the task preserves the fence across tool-plugin reloads. The completion listener remains effect-scoped, so a notice that settles during the reload gap may still be dropped.

## Verification

- ACP disconnect or session close leaves no registered agent or session-store entry, including when `session/load` races teardown.
- Cancelling before a queued prompt starts prevents that prompt from running or absorbing the next prompt.
- Reloading `dsh-tool-bash` does not let another session read or kill an existing background task because ownership remains on the executor.
- Config-created agents remain loop-fiber-owned, so non-ACP demos need not manage handles explicitly.

## Session owner tokens are unique among live agents

The bash owner token relies on `session.header.id` being unique among live agents. Concurrent same-ID operations may prepare privately, but `SessionStore.enter()` rejects duplicate publication and the losing transaction rolls back. `tool-bash` owns the comparison policy; the bash seam stores an opaque `owner` string without interpreting it.

## Alternatives considered

- **A public `BashTask.owner` field** instead of the `BashExecutor.ownerOf(id)` seam — rejected: one read path, no redundant API.
- **Sibling cordis effects for the agent's session lifecycle** — rejected: a fiber unload disposes sibling effects concurrently (`Promise.all`), racing removal of the store-owned append publication hooks against the loop's closing `session/flush`; the single composite effect's ordered LIFO chain is what captures the closing `turn/end` on both disposal paths.
- **A separate step-only `abort()` beside `cancel()`** — shipped originally, then removed as unused; `cancel()` is the single public stop primitive ([the public-stop-surface RFC](../simplification/2026-06-20-public-agent-stop-surface.md)).

## Consequences

This touched public interfaces (`Agent`, `AgentFactory`, the bash seam) deliberately, not as a local ACP patch. The simple synchronous `Agent.send()` ergonomics were preserved; the async lifecycle path is additive, for owners that need it.
