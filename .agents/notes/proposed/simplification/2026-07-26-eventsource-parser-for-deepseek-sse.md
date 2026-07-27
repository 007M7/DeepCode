# Agent Note: Replace the hand-rolled SSE parser in llm-deepseek with eventsource-parser

Status: proposed

English | [中文](2026-07-26-eventsource-parser-for-deepseek-sse.zh.md)

## Problem

`packages/llm/llm-deepseek/src/sse.ts` hand-implements Server-Sent Events parsing: a streaming `TextDecoder`, event-block splitting on `\r?\n\r?\n`, `data:` payload extraction and joining, comment/field skipping, the `[DONE]` sentinel, a `STREAM_CLOSED` error on EOF without it, and a flush of a final unterminated event block. The file is ~67 lines with ~108 lines of dedicated tests (`tests/sse.spec.ts`) re-proving SSE spec behavior — UTF-8 split across chunks, CRLF handling, multi-`data:` joining, no-space-after-colon — that a maintained parser already guarantees. Its only consumer is `adapter.ts` (`yield* translate(parseSse(response.body))`).

This is exactly the surface `eventsource-parser` owns: the de-facto standard SSE parser (it underlies the Vercel AI SDK and the MCP SDK), zero-dependency, actively maintained, and already present in this repo's lockfile transitively via `@modelcontextprotocol/sdk` — so adopting it directly adds no new supply-chain surface in practice.

## Proposal

Replace `sse.ts` with `EventSourceParserStream` from `eventsource-parser/stream`: `response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream())`, keeping only the DeepSeek protocol shim (~10–25 lines): yield each event's `data`, terminate on `[DONE]`, and throw `LlmError('STREAM_CLOSED')` when the stream ends without the sentinel. All required builtins (`TextDecoderStream`, `pipeThrough`, async-iterable `ReadableStream`) exist at the Node ^22.19 engine floor. Delete the spec-conformance tests; keep the `[DONE]`/`STREAM_CLOSED`/EOF contract tests. Add `eventsource-parser` to `llm-deepseek`'s dependencies (its second runtime dep after schemastery). Update the [twin-adapters note](../../implemented/architecture/2026-06-13-twin-llm-adapters.md) and the `dsh-llm` JSDoc that brand this adapter "hand-rolled fetch + SSE parsing" in the same PR.

The library also strips a leading BOM (the hand-rolled parser would fail to match `data:` after one) and offers `maxBufferSize` hardening the current parser lacks.

## Alternatives considered

- **Keep the hand-rolled parser.** Defensible under the [twin-adapters decision](../../implemented/architecture/2026-06-13-twin-llm-adapters.md): the adapter is deliberately the hand-rolled design-verification twin of the pi-ai adapter. But the note's load-bearing distinction is owning the fetch/translate internals versus delegating to a full provider SDK; a ~700-byte SSE micro-parser is transport plumbing, not the design under verification. Whether that reading stands is the twin-note owner's call — this proposal explicitly needs their sign-off.
- **`createParser({onEvent})` callback API instead of the stream.** Works fed by a manual `TextDecoder` loop, but the `pipeThrough` composition deletes more of the hand-rolled code.

## Acceptance criteria

- `sse.ts`'s parsing internals are gone; the remaining shim only encodes the DeepSeek `[DONE]`/`STREAM_CLOSED` protocol.
- `llm-deepseek` unit tests and the real-API e2e suite pass; keyless snapshots are unchanged (parsing is transport-internal and payload extraction is equivalent).
- The twin-adapters note and `dsh-llm` JSDoc no longer claim hand-rolled SSE parsing.

## Risks

- One deliberate robustness deviation is lost: the hand-rolled parser flushes a final event block that lacks its terminating blank line, and `tests/sse.spec.ts` pins that a trailing `data: [DONE]` without `\n\n` still yields DONE. eventsource-parser is spec-strict and only dispatches on the blank line, so that shape becomes `STREAM_CLOSED`. Real providers and `dsh-llm-mock-server` always terminate events properly, so the pinned behavior is a robustness nicety, not an observed provider shape — drop the test, or keep a tiny buffer-tail check if the deviation is judged load-bearing.
- Dilutes the documented "hand-rolled" identity of the twin adapter; mitigated by updating the note in the same change rather than leaving the claim stale.
