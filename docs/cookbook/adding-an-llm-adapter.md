# Cookbook: adding an LLM adapter

How to connect a new model provider. Reference implementations:
`packages/llm-deepseek` (hand-rolled HTTP/SSE) and `packages/llm-pi-ai`
(wrapping an LLM library). Read the `StreamChunk` doc in
`packages/llm/src/types.ts` first — it records the protocol conventions both
adapters were verified against.

## The shape

```ts
class MyAdapter extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> { … }
}

export const name = 'llm-myprovider'
export const inject = ['llm']
export const Config: z<Config> = z.object({ apiKey: z.string(), … })

export function apply(ctx: Context, config: Config) {
  ctx.llm.registerAdapter(['model-a', 'model-b'], new MyAdapter(…))
}
```

Registration is effect-based (HMR-safe); one adapter per model name —
duplicates throw. Secrets are cordis-native: schemastery Config with env
fallbacks, fed from cordis.yml via `!!js process.env.MY_KEY`. Never read
ad-hoc key files in code.

## Protocol obligations (the contract two implementations verified)

- Emit `usage` BEFORE `finish`; emit NOTHING after `finish`. The robust way:
  buffer finish/usage until the provider's end-of-stream marker, then flush
  (handles providers that send trailing usage-only chunks).
- Tool-call `arguments` are RAW JSON strings end-to-end; stream fragments as
  `argumentsDelta`. If your provider hands back parsed objects, re-stringify
  at `block-end`.
- Allocate block `index`es in first-seen stream order; reuse the index for
  every delta of the same block.
- Errors have exactly two sanctioned paths: THROW from `stream()` (transport
  and protocol failures — use `LlmError` with a stable code), or end the
  stream with `finish {kind: 'error' | 'aborted'}` (provider in-band
  failures). Consumers handle both; pick per failure class and document it.
- Honor `options.signal` (pass it to fetch / your SDK).
- `prefill` and other unsupported `GenerateOptions` fields: throw
  `LlmError(..., 'UNSUPPORTED')` rather than silently dropping.

Provider-specific request knobs (thinking modes, effort levels) belong in
the ADAPTER's Config, not in `GenerateOptions` — the core vocabulary stays
provider-neutral.

## Structure that worked

Split the adapter into testable stages (llm-deepseek's layout): wire types
(`types.ts`, coverage-exempt) → request serializer → SSE/transport parser →
chunk-translation state machine → a thin adapter class wiring them. Each
stage gets its own unit suite.

## Testing

- **Unit: mock the provider, not the harness.** A scripted `node:http`
  server speaking the provider's wire format covers happy paths, every error
  status, malformed payloads, premature closes, and aborts — no network, and
  it drives the 100% per-file coverage gate. Works for SDK-backed adapters
  too (point the SDK's baseURL at the mock).
- **Hostile framing tests.** Split stream payloads at arbitrary byte
  positions (including mid-UTF-8) — real networks do.
- **E2E: `tests/*.e2e.ts`** under `yarn test:e2e`, gated with
  `describe.skipIf(!process.env.MY_KEY)` so CI (no secrets) stays green.
  Cover each model × each provider mode you map (thinking on/off, effort
  levels), a tool-call round trip INCLUDING the follow-up turn with results
  in history, and loose assertions only (substring/structure, bounded
  maxTokens — real models are nondeterministic).
- Register the e2e file pattern in `knip.json` (per-workspace `entry`
  override) or knip flags it unused.
