# RFC: Expose agent session identity and JSONL location to tools and hooks

Status: implemented

## Problem

An agent can identify its workspace through `session.header.cwd`, but a model using the bash tool cannot identify the session that owns the call or the durable JSONL file that records it. The default apps happen to use `./.sessions`, yet that is deployment config rather than a contract: `persistenceRoot` can point elsewhere, the JSONL backend hashes `cwd` into a bucket, and arbitrary session ids are path-encoded. Asking the agent to run `find` therefore makes the model guess backend layout and can select the wrong log under concurrent, resumed, forked, or subagent sessions.

The same missing ownership boundary appears in the hook bridges. The Codex bridge emits `session_id` but fixes `transcript_path` to `null`; the Claude Code bridge emits `session_id` and `cwd` but no transcript path. Teaching each consumer to reconstruct the JSONL layout would duplicate backend policy and couple model tools and protocol adapters to one persistence implementation.

The feature needs two distinct facts: a stable session identity that exists even without persistence, and an optional physical location owned by the active persistence backend. They must be resolved per agent invocation rather than written to global `process.env`, because one harness process can run multiple agents and in-process subagents concurrently.

## Decision

Extend the [`SessionPersistence`](../../implemented/architecture/2026-06-14-session-persistence.md) seam with a synchronous, side-effect-free location query:

```ts
import type { SessionHeader } from '@deepseek-ai/dsh-session'

export interface SessionLocation {
  readonly kind: string
  readonly path: string
}

export abstract class SessionPersistence {
  abstract locate(meta: SessionHeader): SessionLocation | undefined
}
```

`path` is an absolute local path to the backend's dedicated log for `meta`; `kind` identifies the representation. The JSONL backend returns `{ kind: 'jsonl', path }` using its already-resolved absolute root and existing cwd-bucket/id-encoding helpers. The SQLite backend returns `undefined` because a session is rows inside a shared database, not a dedicated transcript file. A backend with no honest local per-session path also returns `undefined`.

`locate` performs no filesystem I/O, creates nothing, flushes nothing, and never searches by convention. It reports where this backend would materialize the session, so callers can receive a path before the file exists. Making the query synchronous and local-path-only keeps it usable while constructing tool and hook invocation context; a future remote/object-store locator is a separate capability rather than a blocking network call hidden inside prompt or tool assembly.

The model-facing bash consumer derives a trusted environment overlay for each `ToolExecution` with an agent:

- `DSH_SESSION_ID` is always the current `agent.session.header.id`, including when persistence is absent or non-file-backed.
- `DSH_SESSION_JSONL` is present only when the active `ctx.sessionPersistence.locate(header)` returns `kind: 'jsonl'`; its value is that location's absolute path.
- A call without an agent receives neither variable.

The overlay is passed through the existing `BashExecRequest.env` surface from the [trusted stdin/env decision](../../implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-surface.md). It applies to foreground and background starts, and `dsh-bash-local` merges it after its ambient credential scrub and terminal overrides. The model-facing tool continues to build the request from named schema fields: model-supplied `env`/`stdin` keys are ignored and cannot replace the overlay. A shell command can still overwrite its own variables (`DSH_SESSION_ID=x command`); these values are correlation metadata, never authority.

The bash tool description tells the model that the current session id is available as `$DSH_SESSION_ID` and that JSONL deployments additionally expose `$DSH_SESSION_JSONL`. This guidance belongs with the tool that provides the variables, not in a permanent system-prompt section. The schema is already recorded in the request header under the [reconstructable-request contract](../../implemented/architecture/2026-07-05-reconstructable-requests.md), and every resulting tool output is a durable `tool/result`, so no new session event is needed.

The [Claude Code and Codex hook bridges](../../implemented/feature/2026-06-30-hook-bridges.md) resolve transcript location from the same seam at payload construction time. Codex payloads use `transcript_path: string | null`; Claude Code payloads keep their string-shaped dialect field and use `transcript_path: string`, falling back to `''` when no local per-session file exists. Hook lookup is the same side-effect-free snapshot as bash lookup: it does not force materialization or make a pre-turn hook create an otherwise abandoned session artifact.

## Peer product findings

Peer products separate stable identity from physical storage rather than treating an absolute path as the only session key. Codex injects `CODEX_THREAD_ID` into each spawned shell environment after its environment policy has run, while its rollout recorder owns the exact path and exposes it separately to client events and hooks. Claude Code supplies `session_id` and `transcript_path` as structured hook/status-line input rather than a general Bash transcript environment contract. OpenCode carries session identity in structured tool execution context; Kimi Code expands a session-id placeholder in skill content; Reasonix keeps the active session path on its controller and rebinds it on branch/resume.

The reusable principles are narrower than any one product's API: inject identity at the invocation boundary, let persistence resolve storage, do not mutate process-global environment for concurrent agents, and do not promise that a precomputed path is already materialized. DeepSeek Harness adds the optional JSONL path to bash because its requested user behavior is explicitly “ask the agent for this session's log,” while retaining the stable id as the primary identity.

## Lifecycle and persistence semantics

A fresh session receives its id before any turn. Its bash environment can therefore carry both values during the first turn, but JSONL lazy materialization remains unchanged: before the first successful turn-end `session/flush`, `$DSH_SESSION_JSONL` can name a file that does not yet exist. During an open later turn, the file contains only the last durably flushed prefix, not the current buffered events. Consumers that need a readable up-to-date transcript require a separate explicit checkpoint/materialization API; this decision deliberately does not add one.

Resume reuses the loaded session header, so it exposes the same id and backend location. Fork and in-process spawn create a new session id; the JSONL backend derives a new file while preserving the existing `parentSession` lineage and inherited cwd rules. Concurrent parent/child agents compute overlays from their own `ToolExecution.agent`, so neither can inherit or overwrite the other's identity.

Consumers resolve the active service through the Cordis context at invocation time and do not cache a concrete JSONL backend instance. This keeps HMR/reload behavior aligned with the service store: a replacement backend controls subsequent locations, and an absent/inactive backend removes only `DSH_SESSION_JSONL`, never the session id.

## Testing

Unit coverage pins each boundary. The persistence seam contract asserts JSONL returns an absolute encoded path under a custom root while SQLite returns `undefined`; JSONL tests cover cwd/no-cwd buckets and ids requiring escaping. Tool-bash request-recording tests cover foreground/background overlays, no-agent calls, absent/SQLite persistence, ignored model `env` keys, and separate parent/child identities. Both hook bridge suites assert their exact available/unavailable `transcript_path` dialect shapes.

A keyless full-loop integration uses the real agent loop, JSONL persistence, `dsh-tool-bash`, and `dsh-bash-local` with only the model scripted. On the first turn the model runs a command that prints both variables and reports whether the path exists; the test verifies the values against the live session header and locator, verifies the file can be absent inside the tool call, then waits for idle and confirms the materialized file's header carries the same session id. Request-recording tests prove parent/child calls receive different overlays, while locator tests prove resume keeps the path and fork changes it.

Snapshot coverage updates the existing request-header pin for the bash description and the hook payload scenarios affected by `transcript_path`. No with-key e2e is required: model choice is not the contract, and the deterministic behavior is exercised through the real local executor, persistence backend, loader composition, and snapshot replay without depending on a provider credential.

## Alternatives considered

**Expose only `DSH_SESSION_ID` and make the agent search.** This copies Codex's shell surface but not its separate persistence resolver. A recursive `find` knows neither a custom root nor a non-JSONL backend, duplicates layout rules, and can race or mis-select under multiple sessions. Stable id remains necessary, but it is insufficient for the requested direct-path behavior.

**Expose only the absolute path.** A path can be unavailable for non-file persistence and can name a not-yet-created lazy artifact; it is not the stable identity other APIs use for resume, lineage, or ownership. Keeping id and optional location separate makes those semantics explicit.

**Write the current session into global `process.env`.** One process can drive multiple ACP sessions and in-process subagents concurrently, so a global assignment is last-writer-wins shared mutable state. Per-`ToolExecution` request env gives every child process an immutable snapshot of the correct agent instead.

**Add a model-facing `session_info` tool.** A dedicated tool would add schema and another call when bash already supplies the requested query surface. It would also need the same persistence resolver, so it does not remove the seam work; the environment variables are smaller and compose with ordinary shell scripts.

**Make tool-bash depend directly on the JSONL backend.** Reading backend config or importing `logPath` from the implementation would violate the interface/implementation/consumer split and leave hooks to invent another route. The persistence service is the only layer that can state whether a physical per-session path exists.

## Consequences

Foreground and background bash calls now expose the current agent's stable session id, while only JSONL-backed sessions expose a file path. No-agent calls receive neither variable; absent and SQLite persistence still leave `DSH_SESSION_ID` available. Resume retains identity and location, while forks, spawns, and concurrent child agents derive new values from their own immutable headers. Model-supplied `env`/`stdin` fields remain ignored, and both hook bridges consume the same locator with their dialect-specific unavailable value.

The path reveals the configured persistence root to the model and hooks. The bash tool already runs with the executor's filesystem authority, so this adds discoverability rather than permission; deployments needing isolation use a sandboxing executor or omit local-file persistence. A valid location can be absent or stale relative to an open turn because durability checkpoints happen at turn end.

Commands can overwrite either variable inside their own shell syntax. The values are debugging/correlation facts rather than credentials, so external consumers still verify the file header before attributing a transcript. `DSH_SESSION_JSONL` remains representation-specific, and backends without a dedicated per-session file return `undefined` instead of squeezing database coordinates into a path contract. The pre-release seam extension intentionally requires every persistence backend to make that supported/unsupported choice without a compatibility shim.
