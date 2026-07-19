# Compaction

The compaction seam — a [capability seam](../rfc/implemented/architecture/2026-06-13-capability-seams.md) split like bash: interface ([dsh-compact](../../packages/compact/compact), `ctx.compact`), implementation (a backend such as [dsh-compact-basic](../../packages/compact/compact-basic)), and consumer (a `/compact` tool, deferred). Compaction is **one optional capability**, not part of the agent-loop spine — so its vocabulary lives here, not in [core.md](core.md). A tokenizer- or template-based backend is a sibling package implementing the same interface. Unlike bash, the interface necessarily depends on `dsh-session` and `dsh-llm`: its verbs act on an agent-owned `Session`, and its durable summary event uses the `ContentBlock` vocabulary (see the [compaction capability-seam RFC](../rfc/implemented/feature/2026-06-18-compaction-capability-seam.md)).

Source: [`packages/compact/compact/src/types.ts`](../../packages/compact/compact/src/types.ts)

## The `compact/*` session events

Compaction extends [`SessionEventMap`](session.md) with three event types via declaration merging. All three are **log-only** — they record the compaction lock and its provenance, and never join the surface. `SurfaceEventType` is deliberately NOT extended (only message-producing events reach the model), so the summary itself rides on a separate `user/message` with `surfaceOp: { op: 'replace', start, end }` — the only surface mutation. See the RFC for why reusing `user/message` is honest rather than a workaround.

| Event | Payload | Role |
|---|---|---|
| `compact/start` | `{ turn }` | acquires the log-recorded lock |
| `compact/summary` | `{ summary, shadowedRange, shadowedSeqs, shadowedTokenCount, provider, model, maxTokens? }` | provenance: the summary blocks, the shadowed surface-boundary pair (`start`/`end` seqs — a position span, not a numeric interval), the shadowed seqs in surface order, the estimated token count, and the summarize call's envelope (`provider`, `model`, plus its generation cap when one applied) — logged so the one-shot request is reconstructable from log + code (the reconstructability RFC) |
| `compact/end` | `{ turn, error? }` | releases the lock (`error` set when summarization threw) |

The lock brackets the **whole** operation: `compact/start` is appended first, then summarization, the `compact/summary` provenance record, and the `user/message` replacement all land, and only then `compact/end`. Releasing the lock last turns a crash mid-operation into a detectable orphaned lock (a `compact/start` with no matching `compact/end`) rather than a `compact/end` that falsely claims compaction finished.

These variants are merged inside a `declare module '@deepseek-ai/dsh-session'` block, so — unlike the top-level types on the other sub-pages — they are not pasted as a drift-checked ` ```ts type-equiv ` block (the `verify-type-equiv` extractor matches only top-level declarations by name). The payload table above is the catalog entry; follow the source link for the authoritative shapes.

## `CompactionResult`

What a successful compaction returns to its caller: the bookkeeping-event seqs, raw summary, shadowed range and seqs, and estimated token count.

```ts type-equiv
/** Result of a successful compaction operation. */
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

`CompactService` exposes `compactIfNeeded(...)` for pressure-triggered compaction, returning `null` when no compaction is needed, and `compactRegion(...)` for an explicit inclusive surface range. The pre-step caller supplies the agent, full prompt, session prefix, and abort signal; implementations must forward that signal to summarization. The seam owns no pricing API: [`ctx.tokenMeter`](token-meter.md) directly owns estimation and replay, while `dsh-compact-basic` owns retention, event sequencing, routed summarization calls, and their configuration.

Auto-compaction runs at serial `agent/pre-step`, before the step and request derivation, so it can replace surface nodes while keeping trace events outside the step. Region boundaries preserve tool-call/result pairing but do not preserve whole turns, allowing early closed steps of one oversized turn to compact. `dsh-compact-basic` owns the retention and failure details.

The seam exports `toolPairingBalancedBefore(session, seq)` and `toolPairingBalancedAfter(session, seq)` for those edge checks. Both validate current surface membership and reject missing seqs and orphan results; the [package contract](../../packages/compact/compact/README.md#tool-pairing-boundaries) owns their cache semantics.
