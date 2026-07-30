# Agent Note: The browser conversation is a log-ordered human transcript

Status: implemented

English | [中文](2026-07-30-web-transcript-log-ordered-projection.zh.md)

## Problem

The browser client built its conversation from the model-visible surface: `FoldAdapter` ran the core `SurfaceManager` over the history window and read `surface.nodes`. A successful compaction replaces a surface range with one checkpoint node, so the moment that replacement landed the web flow collapsed every message it shadowed into a single dim context row — conversation the user had already read. Nothing was lost from the log; the defect was entirely in the projection, and [the terminal and the host gateway were fixed the same way](2026-07-29-human-transcript-append-origin.md) while the browser was left for this change.

Surface order made two further problems structural. It is not seq-ascending after a replacement — `SurfaceManager` splices the high-seq checkpoint into the position of the range it shadows — so log-only nodes merged into that array by numeric seq (slash-command rows, interrupted frozen nodes) could be flushed ahead of the checkpoint and never interleave into the retained tail again. And because pagination no longer spends `maxMessages` quota on replacement copies, a page can now carry a checkpoint whose `surfaceOp.start` lies outside the window; the core fold rejects that range, so `nodes()` fell back to a lenient linear scan behind a `console.error` and published a `foldDegraded` flag describing the failure.

## Decision

`TranscriptAdapter` replaces `FoldAdapter` and never consults surface order. It projects the raw window in log order: every append-origin surface event (`isAppendSurfaceEvent`) at its own log position, plus one `CompactionSummaryNode` marker per landed compaction checkpoint. A landed compaction therefore keeps the conversation it shadowed on the model side, and the marker reports where the model stopped seeing that history instead of erasing it. Model-only replacement copies stay out of the transcript: a pruned `tool/result` and a regenerated `assistant/message` rewrite one node for the model and mark no boundary in the conversation. Everything that must send exactly what the model sees keeps reading the surface; this is the human projection, and the two are now separate on both frontends.

Node order is seq-monotonic by construction, and three things follow. The log-only `command/run` / `command/done` pair folds into `CommandNode`s that splice into an already-monotonic array by seq — no anchors, no reordering. `Session` keeps ownership of interrupted frozen nodes and merges them by their fractional seqs with a plain sort, which is now exactly flow order. And a window whose checkpoint cites a shadowed range outside it has no range to resolve, so the marker renders and nothing is logged.

`foldDegraded` is gone from `ConversationSnapshot`, and with it the padding sentinels, the `baseSeq` arithmetic they needed, and `degradedSeqs()`. They existed only to satisfy the core fold's `seq === index` assertion and to survive its throw; the fold they describe is no longer run. Deleting the flag is part of the fix, not cleanup after it — `degradedSeqs()` was already almost the log-ordered projection, reached after a thrown error instead of intended.

The marker's summary text comes from the checkpoint's own `compact/summary` provenance, never from the framed checkpoint payload, which is an instruction envelope written for the model. A window cut that left the provenance outside makes the row non-expandable rather than empty, the same soft-fall as a call-less tool result, and a later page supplying the provenance resolves the text.

No persisted event, RPC envelope, compaction transaction, or model-visible surface changed, and no migration is required.

## Recognizing a checkpoint: the local literal and its drift trap

Recognition needs all three conditions, as in the terminal: `event.type === 'user/message'`, the compaction seam's checkpoint plugin source, **and** `isReplacementSurfaceEvent(event)`. A plugin-sourced `user/message` that *appends* is injected context — a session-reference card — not a compaction.

The client restates that plugin source as a local literal, because `dsh-compact` is unreachable from `packages/client/runtime`'s program in **both** directions:

- a **value** import fails the client purity gate (`packages/client/tsdown.client.ts`), and `dsh-compact`'s root value-imports cordis, so admitting it would pull `CompactService` into the browser bundle;
- a **type-only** import fails typecheck. `dsh-compact`'s root reaches `dsh-session`'s root, whose cordis `Context` merge declares the host `sessions: SessionStore` against this program's `sessions: ISessions` — `TS2717`, the one-program-per-side rule in [development.md](../../../../docs/development.md#typescript-project-layout). This was expected to work and does not; `import type` is erased before the *bundler* runs, but not before the *compiler* does, and the collision is a compiler fact.

The drift protection therefore lives in a test, not in a type: `packages/client/runtime/tests/compact-checkpoint-pin.spec.ts` runs in the client **test** program, which carries no such collision, and drives the adapter with a checkpoint built from the canonical `COMPACT_CHECKPOINT_SOURCE` itself. Renaming the seam's plugin fails there instead of silently deleting every compaction marker from the web transcript. `dsh-compact` is a `devDependency` of `dsh-client-runtime` and a reference of `tsconfig.client.json` only — never of a `packages/client/*` package project.

That is a deliberate divergence from the terminal, which value-imports `isCompactCheckpointSource` directly because no gate applies host-side.

## What #835's positional anchors were for, and why they are dissolved rather than lost

The unmerged manual-compaction-queueing branch fixes the same interleaving bug by recording a per-event anchor — the surface tail at append time — and retargeting shadowed anchors onto the checkpoint. That mechanism exists to make positional anchors survive surface **reordering**. The human transcript is never re-ordered, so anchors have nothing to retarget: the precondition is removed, not the fix discarded. The mechanism is absent from this base and is not authored here.

## Alternatives considered

**Add `dsh-compact` to the client `INLINE_SAFE` allowlist** and move the predicate to a cordis-free subpath. Rejected: `INLINE_SAFE` matches on specifier *prefix*, so admitting the package admits its cordis-importing root too; the allowlist is a reviewer promise about client-facing subpaths, not a purity proof. It also needs a new export and a `files` fix, and it would not have helped — the blocking collision turned out to be in the compiler, which an allowlist does not touch.

**A bare shape rule** — any replacement `user/message` is a compaction. Rejected: correct today only because compaction is the sole producer of replacement `user/message`s, with nothing to catch it if that changes. The pinning spec costs one file and removes exactly that risk.

**Tag the checkpoint host-side** through the projection or wire contract. Rejected: most aligned with the "collaborate through cordis services" rule, but the client folds raw `SessionEvent`s today, so it means a wire contract change out of proportion to one pure predicate.

**Move frozen-node ownership into the adapter** (`nodes(extraNodes)`), as the unmerged branch does. Rejected: the interrupted nodes come from the `turn/end` sweep `Session` already runs over the window, and with a seq-monotonic transcript the simple shape is correct — the adapter returns nodes, the session merges frozen ones by seq. Widening the adapter's signature would buy nothing and split the sweep from its product.

**Keep `foldDegraded` as a defensive flag.** Rejected: it described a specific failure of a fold that no longer runs. A flag no consumer can act on, reachable only through a `console.error`, is a false contract.

## Consequences

Compaction no longer erases web history; a session compacted several times shows one marker per landed compaction, in log order, and the same window renders identically live and after a cold resume. The pagination hole is closed by construction rather than defended against, and `ConversationSnapshot` loses a published field, which touched thirteen files.

`ConversationNode` gains an eighth arm, so every exhaustive consumer grew one case: `MessageItem` renders the marker through the new `CompactionItem`, and the trajectory layout widens its no-cell arm so a marker contributes no cell but still advances the duration cursor.

The performance contract is unchanged and now simpler to state: one append materializes one node, an event that changes no node keeps the previous array reference — so a chunk storm costs nothing and `nodes()` is not even recomputed — and unchanged nodes keep their object identity. The window still grows with session length rather than with the surface, which is the trade the fix exists to make; a compaction used to bound the projection for exactly the long sessions compaction serves.

The web e2e scenario now seeds a real compaction transaction over its recorded turn, so the aria golden pins both halves of the fix through the real host and a real browser: the recorded prompt and full tool output are still on screen, and one marker sits after them. The seed recording itself is untouched and stays model-authentic — replay derives the compacted turn from the recording's own surface.

## Deferred

Compaction **progress** — an indicator while a compaction runs — needs the bracket-first ordering the queued manual-compaction work introduces, and stays out of scope here as it did in the terminal. The marker also carries no **scale**: the checkpoint's `sourceEventSeqs` already hold the shadowed count, so a count or range would tell a reader how much each row folded. Both belong together, where the reader meets the two halves of the same information.
