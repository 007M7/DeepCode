# RFC: Result-time applied-hunk diffs for file mutations

Status: implemented

## Problem

The [tagged render-intent union](2026-07-02-tool-render-intent-union.md) gave `dsh-tool-fs` write/edit a `card:'diff'` at CALL time, derived purely from the tool's args: write ⇒ `{oldText:null, newText:content}` (the whole new file), edit ⇒ `{oldText:old_string, newText:new_string}` (the bare replaced snippet). An editor renders that as an inline diff, but it is a **context-free** diff — the bare `old_string`→`new_string` with no surrounding lines, and a `replace_all` that touched five scattered sites still renders as one snippet pair.

Driving `claude-agent-acp`'s own ACP bridge shows what a full editor diff looks like: after the mutation applies, it emits a SECOND `tool_call_update` whose diff is the **applied hunk with ±3 context lines** (and one hunk per changed site for `replace_all`), reconstructed from the tool's `structuredPatch`. That result-time hunk is what makes Zed show the change *in place* in the file rather than as a floating snippet. Our tools stopped at the call-time snippet; the completed result carried only the plain "updated successfully" text, no diff.

The obstacle is a seam boundary: `presentResult(args, result)` is a **pure function of `args` + the model-facing `result` (`{content, isError}`)** — it runs on live streaming AND on session-log replay, so it must be replay-deterministic and cannot do I/O. It never sees the file's before/after content, and `FsEditOutcome`/`FsWriteOutcome` carried only a replacement count + version, not the text. So there was no way to compute — or even carry — an applied hunk to the presenter.

## Decision

Add a **persisted, tool-private presentation channel** so a tool's `execute` can attach a result-time render payload that survives replay, and use it to carry the applied-hunk diff.

### 1. A `meta` channel on the tool result (core)

`ToolDefinition.execute` may now return either its model-facing `ContentBlock[]` (unchanged, the common case) OR `{ content: ContentBlock[]; meta?: unknown }`:

```ts ignore-check
type ToolExecuteReturn = ContentBlock[] | { content: ContentBlock[]; meta?: unknown }
```

`meta` is an opaque payload the core never interprets — typed `unknown` at every seam (the tool that produced it owns and narrows its shape). It MUST be JSON-serializable: the registry threads it onto the `tool/result` **session event**, and `Session.append` runtime-validates all event data with the existing `isJsonValue` predicate, so a non-serializable `meta` is rejected at the source. On replay the same `meta` is read back and handed to `presentResult` via a widened `ToolResult` (`{ content, isError, meta? }`). Because the payload lives in the event log, the diff reproduces on session reload / snapshot replay **for free** — the event-sourcing guarantee, not a re-computation. Typing `meta` as `unknown` (rather than a shared serializable-value type) keeps the tools core free of a dependency it would otherwise take just to name the type, and the runtime `isJsonValue` gate — not the static type — is what actually enforces serializability.

This is the general shape ("a tool attaches durable result presentation"), not an fs-specific one — any tool can use it.

### 2. The tool computes the hunk; the backend returns before/after (fs)

Per the [capability-seam split](2026-06-13-capability-seams.md), the storage backend returns only **storage facts** and the model-facing tool owns **presentation**:

- `dsh-fs` widens `FsEditOutcome` with `{ before: string; after: string }` and `FsWriteOutcome` with `{ before: string | null; after: string }` (`before: null` ⇒ a create, or an existing-but-undiffable binary/non-UTF-8 file). The local backend already holds both texts at write time; it returns them as raw LF-normalized text, with **no diff/UI concept** entering the seam.
- `dsh-tool-fs` computes the contextual hunk from before/after and attaches it as `meta: { diffs: FileDiff[] }`. A contextual hunk is computed only when a before-version exists — edit always; write on overwrite; a create has no before, matching `claude-agent-acp`'s empty `structuredPatch` on create. But the completed `tool_call_update` is ALWAYS a `diff` card for a successful mutation: an ACP `tool_call_update.content` REPLACES the call's content, so rendering the model-facing result text would clobber the pending diff. So `write`'s result falls back to an args-derived whole-file diff (`oldText: null`) when it has no contextual hunk (a create, or an overwrite whose content is unchanged), and `edit` — which always changes content — always has a hunk. A failed/aborted/policy-rejected mutation applied nothing, so it carries no `meta` and falls through to the generic error rendering (its message must show).

### 3. The bridge renders a `diff` result card

`ToolResultView` gains a `DiffResultView { card:'diff'; title?; diffs: FileDiff[] }`; the bridge's result-side `switch (view.card)` gets a `diff` arm emitting the `{type:'diff'}` `ToolCallContent` blocks (mirroring the call-side arm). An ACP `tool_call_update.content` REPLACES the call's content in an editor, so the result diff **supersedes** the call-time snippet (and keeps the model-facing result text from clobbering it) — the two-update sequence (call snippet, then result diff) matches `claude-agent-acp` exactly.

### The diff algorithm — a third-party runtime dependency over vendoring

Computing hunks-with-context is a solved problem with sharp edge cases (grouping, context coalescing, the trailing-newline marker). Rather than hand-roll it, `dsh-tool-fs` takes a runtime dependency on the npm [`diff`](https://www.npmjs.com/package/diff) package (a `^9.0.0` range, exact-pinned by the lockfile; it ships its own types) and uses its `structuredPatch`. The repo's default is to vendor Cordis-framework source, but that policy is about the *framework*; a leaf tool package taking a small, well-known, self-typed utility dependency is the same shape as `dsh-acp` depending on `@agentclientprotocol/sdk`. Vendoring a diff algorithm would be re-implementing a battle-tested one for no benefit — the [pre-release "foundation over blast radius"](../../../../AGENTS.md) reasoning does not argue for re-deriving standard algorithms. The dependency's output is normalized in one small module (`packages/fs/tool-fs/src/diff.ts`).

## Non-goals

- **Live incremental diff streaming.** The hunk is computed once, after the mutation completes; there is no per-keystroke diff.
- **Diffing a binary/non-UTF-8 overwrite.** `before` is `null` for such a file (it has no text diff basis); the write still succeeds and the result renders a whole-file diff (`oldText: null`) rather than a contextual hunk.
- **Rename/move diffs.** Only content diffs of a single resolved path.
- **Bounding the overwrite diff basis.** An overwrite reads the whole prior file into memory to compute the contextual hunk (on top of the new content already held), so a very large text overwrite allocates both texts for a UI-only diff. A future refinement can bound the pre-read and fall back to a whole-file / no contextual diff above a size threshold; tracked as `TODO(overwrite-diff-bound)` at the read site.

## Related

- Completes the one remaining representation difference named as a non-goal in [Tagged render-intent union](2026-07-02-tool-render-intent-union.md) — that RFC's Non-goals section is updated to record that applied-hunk diffs shipped here.
- Builds on the [filesystem capability seam](2026-06-17-filesystem-capability-seam.md) (the before/after are storage facts the backend returns) and [event-sourced sessions](2026-06-11-event-sourced-sessions.md) (the `meta` payload persists on the `tool/result` event, so replay reproduces the card).
- The `meta` channel is deliberately generic: a future tool (a structured search, a data-table result) can attach its own durable result presentation without another core change.
