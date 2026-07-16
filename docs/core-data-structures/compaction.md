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

Automatic callers state why policy is running; implementations may treat confirmed overflow more aggressively than ordinary pressure.

```ts type-equiv
export type CompactionTrigger = 'pressure' | 'context-overflow'
```

`CompactService` exposes `compactIfNeeded(agent, trigger, signal)` for automatic `pressure` or `context-overflow` policy, returning `null` when no safe work exists, and `compactRegion(...)` for an explicit inclusive surface range. Implementations must forward the supplied signal to summarization. The seam owns no pricing API: the singleton [`ctx.tokenMeter`](token-meter.md) directly owns estimation and replay, while `dsh-compact-basic` owns retention, event sequencing, routed summarization calls, and their configuration.

Pressure compaction runs at serial `agent/post-step`, after successful assistant output, tool results, buffered context, and steering are durable but before `step/end`. Once pressure or canonical overflow qualifies, compact-basic invokes optional [`ctx.toolResultPrune`](../../packages/compact/tool-result-prune/README.md) before range selection, remeasures through `ctx.tokenMeter`, and can advance the surface without a summary. Failed-request recovery runs through `agent/request-error` after the failed step closes and authorizes a fresh numbered-step retry only when the surface replacement generation advances. Region boundaries preserve tool-call/result pairing but not whole turns, allowing early closed steps of one oversized turn to compact. `dsh-compact-basic` owns thresholds, retained-tail policy, overflow caps, and failure handling.

The seam exports `toolPairingBalancedBefore(session, node)` and `toolPairingBalancedAfter(session, node)` for those edge checks. Both validate current surface membership, reject stale or missing seqs and orphan results, and ignore a caller-retained `node.next`; the [package contract](../../packages/compact/compact/README.md#tool-pairing-boundaries) owns their cache semantics.
