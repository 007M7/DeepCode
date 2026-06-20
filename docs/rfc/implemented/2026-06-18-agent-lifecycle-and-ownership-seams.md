# RFC: Agent lifecycle and ownership seams

Status: implemented

## Problem

Several ACP and tool-bash limitations were symptoms of the same missing seam: plugins could create or resume agents through `ctx.agents`, but they could not own and dispose one agent independently, and long-running bash tasks carried no stable owner in the executor itself. ACP aborted and awaited agents on disconnect but could not unregister just that session's agent; `session/cancel` could not cancel queued-but-not-yet-started work; and `tool-bash` kept task ownership in a plugin-local `Map`, so an HMR reload could make an old task look unowned.

## What was implemented

The three seams shipped across a stacked chain of PRs (the queue-aware cancel, the `AgentHandle` disposer, and the bash owner token), each converged independently.

### 1. Queue-aware `Agent.cancel(reason?)`

A new `cancel()` verb on the `Agent` interface (distinct from the narrower step-only `abort()`). It clears the inbox's queued + steering FIFOs, aborts the in-flight step if any, and drives a **turn-scoped cancellation marker** the driver loop checks at every turn-decision point — so a prompt that is queued-but-not-yet-started never runs, a cancel landing in the pre-step / continuation window drops the about-to-run turn (ending it `aborted`), and a later prompt cannot be batched into the cancelled turn. `whenIdle()` reaches post-cancel quiescence. ACP `session/cancel` maps to `cancel()`. The marker is armed ONLY when there is something to cancel, so an idle no-op cancel cannot strand the next prompt.

### 2. `AgentHandle` async disposer

`ctx.agents.create`/`resume` (and the `AgentFactory` interface) return `AgentHandle = { agent: Agent; dispose(): Promise<void> }`. The disposer is a **capability** — only the holder can tear down exactly this agent: stop its loop, `await` the loop's exit (true quiescence, not just the `disposed` status flip), unregister it, and remove its session from the store. `ctx.agents.get(id)` still returns a bare `Agent`. Config-created agents stay owned by the `AgentLoop` fiber (the handle is discarded). ACP holds each session's disposer in its `SessionRecord` and runs it on disconnect/teardown, so a bare client disconnect leaves no registered agent and no session-store entry — even when `session/load` races teardown (the just-resumed handle is disposed before the closed-guard throw).

**Teardown ORDER is load-bearing for durability**, and the implementation folds the session lifecycle into the agent's SINGLE composite cordis effect (`SessionStore.prepare`/`enter`/`announce`, replacing a sibling-effect split). A fiber unload disposes sibling effects concurrently (`Promise.all`), which would race the session's `onAppend` detach against the loop's closing `session/flush` and drop the closing `turn/end`; inside one effect the disposers run as an ordered LIFO chain (loop stopped + `await agent.done` BEFORE the session detaches), so the loop's final flush is captured on BOTH the handle's `dispose()` and a fiber unload. The register disposer's `agent/disposed` emit is contained (a throwing listener must not reject the chain and skip the later session detach).

### 3. Bash owner token in the seam

Background-task ownership moved from a `tool-bash` plugin-local `Map<string, Agent>` into the executor. `BashExecRequest` gains an optional `owner?: string`; the resolved `BashExecSpec` carries it as required-but-nullable `owner: string | undefined` (a forgotten owner is a visible `undefined`, never a silently-absent property). The executor stores the token on its task and exposes it via a new `BashExecutor.ownerOf(id): string | undefined` seam (NOT on the public `BashTask` — one read path, no redundant API). `tool-bash` deletes its `Map` entirely: it stamps `exec.agent?.session.header.id` as the owner at `start`, and `bash_output`/`bash_kill` compare `ctx.bash.ownerOf(id)` to the caller's token with `!== undefined` semantics (an empty-string token is still a real owner). The completion notice finds the live agent by scanning `ctx.get('agents')?.list()` for `agent.session.header.id === ownerToken` (read via `ctx.get` — `onTaskDone` runs on the bash fiber, a foreign fiber, where the `ctx.agents` proxy would throw). Because ownership now lives on the task in the executor (disposed with the `dsh-bash` fiber), it SURVIVES a `tool-bash` HMR reload — closing the old `XXX(tool-bash-owner-hmr)` gap. (The `onTaskDone` listener is still effect-scoped to `tool-bash`'s `apply`, so a completion landing during the reload gap still drops its one notice — the pre-existing reload-gap drop — but the ownership fence itself is HMR-proof.)

## Acceptance Criteria (met)

- ACP disconnect/session close leaves no registered agent AND no session-store entry for that session, even when `session/load` races teardown.
- `session/cancel` before a queued prompt starts prevents that prompt from running and cannot batch the next prompt into the cancelled turn.
- A `tool-bash` HMR reload does NOT make an existing background task readable or killable by a different session (ownership survives on the executor).
- Existing non-ACP demos still work without managing handles explicitly; config-created agents remain owned by the `AgentLoop` plugin fiber.

## Seam precondition (recorded)

The bash owner-token comparison relies on `session.header.id` being unique among live agents. The agent registry does NOT enforce this — it rejects a duplicate *agentId*, not a duplicate session id, and `createAgent` accepts an arbitrary `sessionId`. This is NOT reachable via ACP (UUID sessionId, `agentId === sessionId`, duplicate-load rejected), so it is not a live product hole, but a programmatic caller that registers two agents with the same session id would break bash isolation and mis-route the completion notice. The access *policy* (token comparison) stays in `tool-bash` (the consumer); the bash seam stores only an opaque `owner` string and never interprets it — the correct interface/impl/consumer split.

The planned resolution is to remove the precondition by construction — see [unify the agent id and the session id](../proposed/2026-06-20-unify-agent-and-session-id.md): once an agent IS its session (one id), the registry's existing unique-`agentId` check is a unique-session-id guarantee and no two live agents can share a session token.

## Notes

This touched public interfaces (`Agent`, `AgentFactory`, the bash seam) deliberately, not as a local ACP patch. The simple synchronous `Agent.send()` ergonomics were preserved; the async lifecycle path is additive, for owners that need it.
