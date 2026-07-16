# Token Meter

`@deepseek-ai/dsh-token-meter` exposes detached replay measurements for request pressure and positional surface pricing. Scalar and surface snapshots carry the number of durable events consumed as `logRevision`; consumers compare revisions before making a joint decision.

Source: [`packages/llm/token-meter/src/types.ts`](../../packages/llm/token-meter/src/types.ts)

## `TokenMeasurement`

```ts type-equiv
interface TokenMeasurement {
  /** Number of durable events consumed; equal to the next unread event seq. */
  readonly logRevision: number
  /** Provider or heuristic anchor used for this measurement. */
  readonly baseline: TokenMeasurementBaseline
  /** Signed repricing of current surface content relative to the baseline anchor. */
  readonly surfaceDeltaTokens: number
  /** Non-negative current request-and-response pressure. */
  readonly totalTokens: number
}
```

`baseline.kind === 'usage'` means the latest successful provider call has the same canonical request envelope. `estimated` means the service priced the complete envelope and surface with its fixed heuristic. A later successful request replaces the earlier anchor; signed `surfaceDeltaTokens` preserves growth and shrinkage relative to a matching anchor.

## `TokenSurfaceNode`

```ts type-equiv
interface TokenSurfaceNode {
  /** Durable sequence number of the surface event. */
  readonly seq: number
  /** Heuristic tokens for the exact message projected by this node. */
  readonly tokens: number
}
```

## `TokenSurfaceMeasurement`

```ts type-equiv
interface TokenSurfaceMeasurement {
  /** Number of durable events consumed; equal to the next unread event seq. */
  readonly logRevision: number
  /** Total heuristic tokens across the current surface. */
  readonly totalTokens: number
  /** Current surface nodes in positional head-to-tail order. */
  readonly nodes: readonly TokenSurfaceNode[]
}
```

Surface order is authoritative; replacement nodes can have higher durable seqs than later positional nodes. The snapshot is immutable and does not grow when the underlying replay fold advances.
