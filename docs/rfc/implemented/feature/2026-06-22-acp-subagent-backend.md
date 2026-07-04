# RFC: ACP subagent backend (out-of-process delegation)

Status: implemented

## Problem

The subagent seam ([the seam RFC](2026-06-21-subagent-capability-seam.md)) was built so multiple backends coexist by name on `ctx.subagents`. The in-process backends (`-spawn`/`-fork`) run a child as a second `Agent` on the SAME cordis context — cheap, but the child shares the parent's process, model client, and tools. The seam's whole point was to also support an OUT-OF-PROCESS child reached over a protocol, proving the abstraction generalizes across a process boundary. This RFC adds the first such backend: an Agent Client Protocol (ACP) client.

## Decision

`@deepseek-ai/dsh-subagent-acp` registers a `SubagentProvider` that runs each child agent in a SPAWNED SUBPROCESS, driven over ACP as the *client*. It is the direction-inverted twin of the existing server-side bridge `@deepseek-ai/dsh-acp` (the ACP *agent*): the bridge ANSWERS `initialize`/`newSession`/`prompt`; this backend CALLS them and IMPLEMENTS the `Client` callbacks (`sessionUpdate`, `requestPermission`). Pointing the configured spawn command at the `acp-agent` example makes the harness talk to its own process.

### Fresh process per run

Each `start` spawns a new child, runs exactly one ACP session (`initialize` → `newSession` → `prompt`), and `dispose` kills the subprocess and awaits its exit. This is the simplest lifecycle and mirrors the in-process one-child-per-run shape. Persistent-process pooling (reuse a warm child across runs) is a performance optimization deferred to future work — it adds session-lifecycle and crash-recovery complexity the first cut does not need.

### Minimal client stub

The client advertises NO optional capabilities (no `fs`, no `terminal`): the child self-serves file/terminal access in its own process. `session/update` notifications are consumed — the backend accumulates `agent_message_chunk` text as the result output and ignores the rest (thoughts, tool-call cards) in this cut, which surfaces only the child's final answer. `session/request_permission` is auto-answered by a configured policy (`reject` declines every prompt, `allow` approves via the first allow-shaped option) — the first cut surfaces no prompt to a human. Proxying `fs`/`terminal` back to the parent (a shared-workspace mode) remains future work, as the seam RFC noted.

### No start-time capabilities

The provider's `capabilities` are all `false`. An out-of-process child cannot honor the parent's `maxDepth` (it has no access to `parent.options.subagentDepth`) or `toolFilter` (it owns its own tool registry), and the first cut does not implement `outputSchema`. The service rejects a request needing any of them before `start` runs. The backend injects only `subagents` (not `ctx.agents`) and ignores `request.parent`.

### StopReason mapping

ACP `StopReason` → harness `SubagentStopReason`: `end_turn`→`completed`, `max_tokens`→`max-tokens`, `refusal`→`refusal`, `cancelled`→`aborted`, `max_turn_requests`→`error` (no clean equivalent — the task did not finish), unknown→`error`. A spawn/transport/RPC failure resolves `error` (or `aborted` if a cancel was requested); `result` never rejects on a child-level failure, per the seam contract.

### SDK version: stayed on 0.25.1

The plan proposed bumping `@agentclientprotocol/sdk` 0.25.1 → 0.28.x for the new fluent `acp.client()` / `ActiveSession.nextUpdate()` API. Validating that against the code (the AGENTS.md "RFC is a proposal, not golden truth" discipline) reversed the decision: the backend only needs `ClientSideConnection` + `ndJsonStream` + `PROTOCOL_VERSION` + the `Client`/`Agent`/`StopReason` types, **all present and non-deprecated in 0.25.1**. The fluent API and `unstable_forkSession` that motivated the bump are never used here, so the "cleaner client code" benefit did not materialize. Worse, 0.28.x **deprecates both** `ClientSideConnection` AND `AgentSideConnection` (it wants all callers on the fluent builders), which turns the `no-deprecated` lint red across the entire existing ACP layer — 33 usages including the server bridge this PR has no business rewriting. That cross-cutting connection-API migration is its own PR, not baggage for "add an ACP subagent backend". So the bump was reverted and the backend is written against 0.25.1 (the plan's own fallback clause: "if the bump proves disruptive, fall back to `ClientSideConnection` (0.25.1), which is sufficient"). Migrating the whole ACP layer to the fluent API on a later 0.28.x bump is a worthwhile standalone follow-up.

### Security: scrubbed child environment

The child is a separate process, so it inherits an environment. Credential-shaped ambient vars (`/KEY|SECRET|TOKEN/i`) are NOT forwarded by default — the parent harness's own secrets must not leak into a spawned process implicitly (the same policy the bash executor applies). The child's OWN credentials (it needs a model key) are supplied EXPLICITLY via `config.env`, layered AFTER the scrub, so an intended `DEEPSEEK_API_KEY` survives while an incidental `AWS_SECRET_ACCESS_KEY` does not. Child stderr is inherited to the parent's stderr (diagnostics surface naturally); a spawn-level `error` event (e.g. ENOENT for a bad command) is captured and raced against the ACP drive, so a bad command settles `error` instead of crashing the parent with an unhandled error.

## Testing

Designed at every tier the backend touches, per the root AGENTS.md rule that a new capability shape names its coverage at every tier at plan time:

- **Keyless unit/integration** (`subagent-acp.spec.ts`): spawns a scripted mock ACP server subprocess (`tests/mock-acp-server.ts`) and drives it through the real backend over real ACP stdio. Covers: the prompt round-trip + output accumulation; every StopReason mapping; cancellation via `run.cancel()` and via the request signal; the already-aborted-before-start case; the cancel-races-ahead-of-newSession case; a torn-pipe-after-cancel (child crashes on cancel) settling `aborted`; permission auto-answer under both policies (including the allow-policy-no-allow-option fallback); a non-message update consumed but not accumulated; a nonexistent-command spawn failure settling `error`; HMR provider cleanup; and the namespace export shape. 100% per-file coverage.
- **With-key e2e** (`subagent-acp.e2e.ts`): the harness drives ITSELF — the backend spawns the real `acp-agent` example process and a real model in that child answers a prompt (PONG) and does real file work (writes `proof.txt`, verified on disk). Self-skips without `DEEPSEEK_API_KEY`. This is the "talk to our own process" smoke and the out-of-process analogue of the in-process spawn e2e.
- **Snapshot**: deferred as `TODO(acp-subagent-replay)`. An ACP child is a distinct replay shape — each child is its own PROCESS with its own single-agent replay (booted under `DSH_SNAPSHOT=replay` with its own sessions-root + fixture), unlike the in-process per-session keying that [PR2.5](../testing/2026-06-22-subagent-snapshot-replay.md) added. The keyless mock-server tests give deterministic coverage of the backend in the meantime; the snapshot follow-up would record the parent driving a real-but-replayed ACP child.

## Future providers

The same out-of-process spawn/prompt/stream/cancel shape generalizes to other transports named in the seam RFC — A2A, the Codex app-server, and the Claude Code Agent SDK — each a sibling provider registered by name. The ACP backend is the proof that the seam supports the boundary; those are mechanically similar.
