# RFC: Per-session snapshot replay for nested agents

Status: implemented

## Problem

The snapshot tier (`pnpm run test:snapshot`) boots the real `acp-agent` subprocess, replays a recorded session through [`dsh-llm-replay`](../../../../packages/support/llm-replay), and diffs the normalized stdout transcript + re-persisted session log against committed goldens. It is the only tier that exercises the full editor-facing transcript end to end.

It was built for ONE session per process, and that assumption is wired into two places:

- **`dsh-llm-replay` keyed nothing.** It served the Nth `llm/stream` call the Nth recorded entry from a single global cursor. With a parent agent AND an in-process subagent both streaming on one context, the calls interleave and the single cursor hands the child the parent's script (and vice versa).
- **The harness harvested one log.** `findSessionLog` walked the sessions root and returned the FIRST `.jsonl` it found. A subagent runs as a second `Session` with its own log in the same cwd bucket, so the child's transcript was silently dropped.

This was the `TODO(subagent-snapshots)` deferral recorded in the [subagent seam RFC](../../implemented/feature/2026-06-21-subagent-capability-seam.md): the in-process backends (PR2) shipped with unit + e2e coverage, but the full-transcript snapshot tier could not express a nested-agent shape until this infrastructure landed. This RFC is that stacked follow-up.

## Decision

Replay is keyed **per calling session**, and the harness harvests **every** session log.

### 1. The calling session id rides on the model request

`GenerateOptions` gains an optional `sessionId`, stamped by the agent loop from `agent.session.id` at request-assembly time (where the session is already in scope). Adapters ignore it; it exists so an `llm/stream` listener can route a call by WHICH session issued it. It is typed `Branded<'SessionId'>` (from `dsh-brand`) rather than importing `SessionId` from `dsh-session` — that package imports `Message` from `dsh-llm`, so importing its id back would cycle. `SessionId` IS `Branded<'SessionId'>`, so a real id assigns with no cast. (A future dedicated ids package could own the brand and dissolve the note; tracked separately — it touches every id import and does not belong in this testing PR.)

### 2. Replay binds live sessions to recorded scripts by first-call order

A nested scenario records more than one log: the parent (`session.jsonl`) plus one per subagent child (`session.1.jsonl`, …). `dsh-llm-replay` loads them all, derives one script per recorded session, and orders the scripts by header `createdAt` (the parent is created before its children).

Live session ids are freshly random every run and never equal the recorded ones, so a live session cannot bind to a script by id equality. Instead it binds by **first-call order**: the first live session to make any model call claims the first ordered script (the parent — earliest `createdAt`, and necessarily the first to stream, because it must run a turn before it can delegate), the next new live session claims the next script, and so on. Each session then advances its own cursor independently.

This keys by WHO calls, not by global call order — so it stays correct even if subagents ever run concurrently or in the background (a global cursor would interleave them). A call carrying no `sessionId` (a direct unit-test `stream()`) is treated as one anonymous session bound to the primary script, so the single-session path is byte-for-byte the old behavior. More distinct live sessions than recorded scripts is a fail-loud error (an unrecorded subagent appeared), never a silent mis-route.

The ordering key is the session header `createdAt`. In the current synchronous cut this is sound because sibling children are created **strictly sequentially** — the subagent tool awaits one child's result and disposes it before the parent's next tool call starts the next child — so their `createdAt` values are strictly ordered and match first-call order exactly. A same-millisecond sibling tie is therefore unreachable; the `recordedId` tiebreak only keeps such a degenerate collision deterministic, it does not recover first-call order. A future cut that runs siblings concurrently/backgrounded WOULD be able to create two children in the same millisecond, and must then thread a real first-call ordinal (the order live sessions first stream) rather than leaning on `createdAt` — flagged with `XXX(concurrent-subagents)` at the sort site.

The alternative considered and rejected was a **call-ordered merge of the parent and child logs** into one global script (sound only because in-process subagent execution is strictly nested — the parent blocks on the child). It is simpler for today's synchronous cut but bakes in the parent-blocks-on-child invariant that a future backgrounded/concurrent subagent would break; per-session keying does not.

### 3. The harness harvests every log, primary-first

`harvestSessionLogs` collects every `.jsonl` across every cwd bucket under the sessions root (the JSONL backend puts a parent and its same-cwd child in the same bucket), parses each header, and orders them primary-first: the top-level session (no `parentSession`) leads, then each child by ascending `createdAt`. `RunResult.sessionLogs` is the plural result; the spec writes each back to its fixture on record (`session.jsonl` + `session.<n>.jsonl`) and diffs each harvested log against its fixture on replay. The normalizer already accepted plural session ids and collapses any stray UUID, so no normalizer change was needed.

### 4. Scenarios

Two nested scenarios were added and recorded against the real API:

- **`subagent-spawn`** — the parent delegates one subtask via the `subagent` tool to a fresh spawn child (2 sessions).
- **`subagent-multi`** — the parent delegates two subtasks, each to its own spawn child (3 sessions), stressing the per-session keying with three concurrent scripts and the `createdAt` ordering of two children under one parent.

Both replay keyless in the default gate.

## Consequences

- The `TODO(subagent-snapshots)` deferral is resolved: nested-agent transcripts are now a first-class snapshot shape.
- `GenerateOptions.sessionId` is a small, honest core-seam addition useful beyond replay (telemetry, request routing).
- The `subagent` tool is bound to a single provider, so both children in `subagent-multi` are spawn (fresh). The keying routes by session, not by backend, so it is already correct for fork. The script *derivation* was not: a fork child's log begins with the seeded parent prefix (the parent's `assistant/chunk` events), so deriving its script from the whole log would replay the parent's responses as the child's. That correctness gap is closed by persisting a seed boundary — see [Persist the seed boundary so fork-child replay routes correctly](2026-06-22-fork-child-replay-seed-boundary.md). A recorded mixed spawn+fork *scenario* (a second tool instance bound to `fork`, pure config) remains a future addition, but a fork child now derives correctly.
- Out-of-process (ACP) subagents are a different replay shape entirely (each child is its own PROCESS with its own replay), tracked as `TODO(acp-subagent-replay)` in the PR3 plan.
