# RFC: Prune the bash task roster from the public seam

Status: proposed

## Problem

The bash executor seam exposes four public background-task operations: direct task lookup via `get(id)`, full roster listing via `list()`, ownership lookup via `ownerOf(id)`, and id-targeted operations `readOutput(id)` / `kill(id)` ([packages/bash/bash/src/index.ts](../../../../packages/bash/bash/src/index.ts)). The model-facing `dsh-tool-bash` consumer uses `start`, `ownerOf`, `readOutput`, `kill`, `onTaskDone`, `run`, and `resolve`, but it never calls `get` or `list` in production.

The consumer's access policy is deliberately id based. A background task id is returned in the `bash` tool result, then later supplied to `bash_output` or `bash_kill`; those tools compare `ctx.bash.ownerOf(id)` with the calling session token before calling `readOutput(id)` or `kill(id)`. Completion notices also work from a single completed `BashTask` passed through `onTaskDone`, then scan live agents by session owner. None of those flows need a public "show me every task" API.

Searches for `ctx.bash.get(`, `ctx.bash.list(`, and bash `list(): BashTask[]` call sites outside tests and RFCs find only implementation, docs, generated catalogs, and tests. The local executor still needs its private `tasks` map, but exposing that map as a seam method makes every future bash backend promise roster semantics no current product code consumes.

## Proposal

Remove `BashExecutor.get(id)` and `BashExecutor.list()` from the abstract service and first implementation.

- Delete the abstract methods from `@deepseek-ai/dsh-bash`.
- Delete the public methods from `@deepseek-ai/dsh-bash-local`; keep its private task map for `ownerOf`, `readOutput`, `kill`, completion, and disposal.
- Update [docs/core-data-structures/bash.md](../../../core-data-structures/bash.md), package READMEs, and the generated Cordis catalog.
- Rewrite tests that inspect the roster to assert behavior through returned task handles, `ownerOf`, `readOutput`, `kill`, `onTaskDone`, and disposal.

The remaining public background contract is direct and smaller: `start()` returns the task handle, `ownerOf(id)` answers the access-policy token, `readOutput(id)` streams incremental output, `kill(id)` stops a known task, and `onTaskDone()` reports completed tasks to interested plugins.

## Why not keep a roster for UI?

A UI might eventually show live background tasks. The current seam does not have that UI, and a raw executor-level roster is probably the wrong final surface anyway: a product UI would need task ownership, session routing, presentation state, and maybe persistence or replay. The existing `onTaskDone` callback and tool-result task ids are enough for today's behavior; a future task monitor can introduce an explicit product-facing task inventory if it actually lands.

## Acceptance criteria

- `BashExecutor` no longer declares `get` or `list`; `LocalBashExecutor` no longer exposes them publicly.
- `rg "ctx\\.bash\\.(get|list)\\(|\\.list\\(\\)[^\\n]*BashTask|\\.get\\([^\\n]*BashTask" packages examples docs --glob '!docs/rfc/**'` finds no public seam surface or production caller.
- `bash_output`, `bash_kill`, and completion notices still use `ownerOf`, `readOutput`, `kill`, and `onTaskDone` exactly as before.
- The Cordis catalog, core data-structure docs, package READMEs, and tests are updated.
- `pnpm run test:coverage`, `pnpm run test:snapshot`, `pnpm run doc-sync`, and `pnpm run hygiene` pass after implementation.

## Risks

- Programmatic consumers lose an easy way to inspect all tasks. In the unreleased repo, the consumer audit says none exist outside tests.
- Tests may become slightly less direct because they cannot assert the private map contents through `list()`. That is a useful pressure: public tests should prove observable behavior rather than pin the executor's storage shape.
- A future task dashboard would need a new inventory surface. That should be designed with ownership and UI semantics, not inherited accidentally from an executor map.
