# Compaction

The compaction seam — a [capability seam](../rfc/implemented/architecture/2026-06-13-capability-seams.md) split like bash: interface ([dsh-compact](../../packages/compact/compact), `ctx.compact`), implementation (a backend such as [dsh-compact-basic](../../packages/compact/compact-basic)), and consumer (a `/compact` tool, deferred). Compaction is **one optional capability**, not part of the agent-loop spine — so its vocabulary lives here, not in [core.md](core.md). A tokenizer- or template-based backend is a sibling package implementing the same interface. Unlike bash, the interface necessarily depends on `dsh-session` and `dsh-llm`: its verbs are defined over a `Session` and its output is the `ContentBlock` vocabulary (see the [compaction capability-seam RFC](../rfc/implemented/feature/2026-06-18-compaction-capability-seam.md)).

Source: [`packages/compact/compact/src/types.ts`](../../packages/compact/compact/src/types.ts)

## The `compact/*` session events

Compaction extends [`SessionEventMap`](session.md) with three event types via declaration merging. All three are **log-only** — they record the compaction lock and its provenance, and never join the surface. `SurfaceEventType` is deliberately NOT extended (only message-producing events reach the model), so the summary itself rides on a separate `user/message` with `surfaceOp: { op: 'replace', start, end }` — the only surface mutation. See the RFC for why reusing `user/message` is honest rather than a workaround.

| Event | Payload | Role |
|---|---|---|
| `compact/start` | `{ turn }` | acquires the log-recorded lock |
| `compact/summary` | `{ summary, shadowedRange, shadowedSeqs, shadowedTokenCount, model, maxTokens? }` | provenance: the summary blocks, the shadowed surface-boundary pair (`start`/`end` seqs — a position span, not a numeric interval), the shadowed seqs in surface order, the estimated token count, and the summarize call's envelope (`model`, plus its generation cap when one applied) — logged so the one-shot request is reconstructable from log + code (the reconstructability RFC) |
| `compact/end` | `{ turn, error? }` | releases the lock (`error` set when summarization threw) |

The lock brackets the **whole** operation: `compact/start` is appended first, then summarization, the `compact/summary` provenance record, and the `user/message` replacement all land, and only then `compact/end`. Releasing the lock last turns a crash mid-operation into a detectable orphaned lock (a `compact/start` with no matching `compact/end`) rather than a `compact/end` that falsely claims compaction finished.

These variants are merged inside a `declare module '@deepseek-ai/dsh-session'` block, so — unlike the top-level types on the other sub-pages — they are not pasted as a drift-checked ` ```ts type-equiv ` block (the `verify-type-equiv` extractor matches only top-level declarations by name). The payload table above is the catalog entry; follow the source link for the authoritative shapes.

## `CompactionResult`

What a successful compaction returns to its caller: the seqs of the three appended `compact/*` events, the summary blocks, and the shadowed range/seqs plus the estimated token count.

```ts type-equiv
interface CompactionResult {
  /** The seq of the appended `compact/start` event. */
  startSeq: number
  /** The seq of the appended `compact/summary` event. */
  summarySeq: number
  /** The seq of the appended `compact/end` event. */
  endSeq: number
  /** The summary content blocks produced by the backend. */
  summary: ContentBlock[]
  /**
   * The surface-boundary pair that was shadowed: the seqs of the first
   * (`start`) and last (`end`) surface nodes of the replaced range. A
   * surface-POSITION span, not a numeric seq interval — after a prior replace
   * lands a fresh high-seq summary node at an older range's position, `start`
   * can be GREATER than `end`. {@link CompactionResult.shadowedSeqs} is the
   * authoritative set of shadowed nodes, in surface order.
   */
  shadowedRange: { start: number; end: number }
  /** The seqs of all shadowed surface nodes, in surface order. */
  shadowedSeqs: number[]
  /** Estimated token count of the shadowed content. */
  shadowedTokenCount: number
}
```

## The service

`CompactService` (`ctx.compact`, abstract — defined in [`packages/compact/compact/src/index.ts`](../../packages/compact/compact/src/index.ts)) declares two abstract methods: `compactIfNeeded(agent, fullSystemPrompt, signal)` checks token pressure and compacts an older range if the history is too large (returning `null` when nothing needs it), and `compactRegion(session, start, end, agent, signal?)` forcibly summarizes surface nodes `[start, end]` into a single replacement node. `compactIfNeeded`'s parameters are all required — the loop's `agent/pre-step` checkpoint supplies the agent, the assembled `fullSystemPrompt`, and the turn `signal`. A backend summarizing via `ctx.llm.stream()` must forward `signal` into the call's `GenerateOptions.signal`, so an abort or dispose tears down the in-flight summarization. The entire strategy — token estimation, retention policy, event sequencing, summarization — is a HOW decision owned by the implementation.

Auto-compaction runs on the serial `agent/pre-step` loop seam (fired once per step, after `turn/start` and BEFORE the step opens and its request history is derived), not the `agent/request` waterfall: compaction mutates the session surface in place — with its log-only `compact/*` records landing cleanly outside any step — and the loop derives the request from the already-compacted surface. Retention is turn-agnostic — the only structural guard is tool-pairing balance (a compacted region's edges are balanced cuts on the surface, so it never splits a step's tool-calls from their results), so a single runaway turn that alone exceeds the window compacts its own early closed steps rather than being retained verbatim. The backend that ships this (`dsh-compact-basic`) documents the retention walk, summary shrink validation, bounded re-compaction, and the crash/recoverable failure taxonomy.
