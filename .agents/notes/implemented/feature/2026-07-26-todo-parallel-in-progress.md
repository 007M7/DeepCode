# Agent Note: Allow several `in_progress` todos at once

Status: implemented

English | [中文](2026-07-26-todo-parallel-in-progress.zh.md)

## Problem

The [original `todo_write` design](2026-06-29-todo-write-tool.md) enforced at most one `in_progress` task per list, both in `execute` and in the durable-log invariant. That invariant assumes sequential work, but the harness runs genuinely parallel work — concurrent subagents through the delegation tool, background bash commands, workflow fan-out — and a list that can name only one active task cannot represent it. The model was forced to either mislabel parallel tasks as `pending` or merge them into one vague item, and the UI progress checklist under-reported what was actually running.

## Decision

Remove the single-`in_progress` cap everywhere it was enforced and let any number of tasks be `in_progress`:

- `execute` in `packages/todo/tool-todo/src/index.ts` no longer counts `in_progress` items; the `at most one task may be in_progress` error is gone from the tool's stable failure set.
- The durable-log invariant in `packages/todo/tool-todo/src/invariant.ts` no longer rejects snapshots with several active items, so previously-persisted logs are unaffected and parallel snapshots replay cleanly.
- The tool description now instructs the model to mark every actively-worked task `in_progress` — several during parallel work, one for sequential work — and to keep at least one while work remains.

The remaining coded invariants are unchanged: non-empty trimmed unique `content`, valid status enum. This supersedes the "at most one active" clause of the [original design's validation decision](2026-06-29-todo-write-tool.md); the rest of that Agent Note (whole-list replace, log-backed state, single owner) stands.

## Why guidance, not a parallelism-aware invariant

A coded invariant can only see the list, not the runtime: whether two `in_progress` items are legitimate depends on whether work is actually running concurrently, which the tool cannot observe. Enforcing a cap was therefore wrong in exactly the cases parallelism made it matter, and any replacement (for example, capping active items at the live subagent count) would couple the tool to runtimes it deliberately knows nothing about. The discipline of matching `in_progress` marks to genuinely concurrent work moves to the tool description, the same place ordering and list freshness already live.

## Alternatives considered

- **Keep the cap and add an explicit parallel opt-in flag** — an extra argument on every call to serve the common case; the flag would be noise for sequential work and still unverifiable.
- **Cap active items at a configured maximum** — any fixed number is arbitrary, and a deployment-varying tunable for list coherence has no principled value.

## Consequences

A todo list can now faithfully mirror parallel execution, and UIs render several active markers at once (the TUI's per-status prefix already handles this with no change). The tool no longer rejects a formerly-invalid snapshot shape, so the change is compatible with every previously valid call; only the error path was removed. The model-facing description changed, which re-recorded the tool-catalog page and the assembled snapshot transcripts that pin the schema.
