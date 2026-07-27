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

## The display surfaces are part of the change

Lifting the cap makes a list shape reachable that no renderer had ever received, so this branch stacks on the [web todo display](2026-07-23-web-todo-display.md) rather than landing beside it: both change `tool-todo`, and the GUI is where a parallel plan becomes visible. Two web sites derived their one-line summary with `todos.find(t => t.status === 'in_progress')` — the collapsed plan-strip header and the `todo_write` row — and under the old cap that `find` was total, since at most one item could match. With several active it silently dropped every active item but the first: a four-item plan with three running tasks collapsed to the name of one, and the row read `0/8 已完成 · <one task>` while seven others were in flight. The expanded list was always correct (it maps every item), which is why neither PR's tests caught it — only the collapsed header and the row lost information. The panel redesign in [#740](https://github.com/deepseek-harness/deepseek-harness/pull/740) has since replaced the collapsed header's named hint with a `<done>/<total> tasks · <n> in progress` count, which reports parallel work correctly and needs no name to truncate; the row is the one site this branch still had to fix.

The row takes `planSummary` in `toolviews/plan-summary.ts`. It names the first active item and counts the rest, so the row reports how many tasks are running instead of implying one. Naming every active item was rejected: the row is a single line, and an unbounded join would overflow it — the count degrades predictably where a list does not. The derivation sits inside the toolviews domain rather than in `contract/`, the inter-domain face: the panel computes its own counts inline and shares nothing with the row, so a contract module would declare a sharing relationship that no longer exists.

`planSummary` returns the name and the count as separate fields rather than one joined string, because the row truncates its summary with `overflow: hidden` / `text-overflow: ellipsis`. A count appended to the task name sits at the far end of the truncatable text, so exactly the narrow viewports and long task names that make the count informative are the ones that clip it away, leaving a parallel plan indistinguishable from a sequential one. The row therefore renders the count in its own `flex: none` span beside the ellipsized text; a pre-joined string could not express that split, and pushing the count in front of the name was rejected because the task name is what the reader is looking for first.

## Consequences

A todo list can now faithfully mirror parallel execution, and every UI renders several active markers at once: the TUI's per-status prefix needed no change, the plan strip's header counts the active items, and the row needed the derivation above. The tool no longer rejects a formerly-invalid snapshot shape, so the change is compatible with every previously valid call; only the error path was removed. The model-facing description changed, which re-recorded the tool-catalog page and the assembled snapshot transcripts that pin the schema. The web fixture's todo sample now runs two items `in_progress`, so the assembled web transcript replays a parallel plan and would fail again if either surface returned to single-active derivation.
