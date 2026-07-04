# RFC: Drop `GenerateOptions.prefill` and `ToolSchema.strict` — request knobs with no working end-to-end path

Status: proposed

## Problem

Two request-contract knobs ride the whole request pipeline, yet neither can do anything today:

- **`prefill`** (`packages/llm/llm/src/types.ts`) has no production setter — the loop assembles `model`/`system`/`tools`/`messages` plus `sessionId`/`signal`, and the compaction backend adds only `maxTokens` — and BOTH adapters reject it: `packages/llm/llm-deepseek/src/serialize.ts` and `packages/llm/llm-pi-ai/src/adapter.ts` each throw `LlmError('UNSUPPORTED')` on a non-undefined `prefill`. The field's entire observable behavior is two throws, each pinned by one adapter test. DeepSeek's chat-prefix completion is a Beta feature on a base URL neither adapter targets.
- **`strict`** (`ToolSchema`, same file) is threaded through `DefineToolOptions`/`defineTool` (`packages/core/tools/src/schema.ts`), the registry's `schemas()` allowlist (`packages/core/tools/src/index.ts`), the deepseek wire mapping (`packages/llm/llm-deepseek/src/serialize.ts`, whose wire-type note records that strict mode requires the `/beta` base URL the adapter does not use), and a per-tool payload-patching pass in `packages/llm/llm-pi-ai/src/adapter.ts`. No shipped tool sets it — `rg` across every `tool-*` package src and `examples/` finds zero `strict:` producers; the only setters are dsh-tools unit tests.

Both knobs are adapter-symmetric, so removal sheds them from both twins together — the [twin-adapter design](../../implemented/architecture/2026-06-13-twin-llm-adapters.md) is untouched.

## Proposal

- Remove `prefill` from `GenerateOptions`, both adapters' UNSUPPORTED guards, the tests pinning the throws, the paste lines in [core.md](../../../core-data-structures/core.md), the adapter README rows documenting the rejection, and the cookbook line using prefill as the UNSUPPORTED example ([adding-an-llm-adapter.md](../../../cookbook/adding-an-llm-adapter.md)); amend the [content-block vocabulary RFC](../../implemented/architecture/2026-06-11-content-block-vocabulary.md)'s consequence line naming prefill as having a home, per [implemented/AGENTS.md](../../implemented/AGENTS.md).
- Remove `strict` from `ToolSchema`, `DefineToolOptions`, `defineTool`, and the `schemas()` allowlist; drop the deepseek serializer branch; simplify the pi-ai payload fixup to the unconditional scrub of pi-ai's own strict default (that half exists for wire parity with the hand-rolled twin and survives); drop the setter tests and the core.md paste line.

This RFC deliberately does NOT touch `temperature`, `stop`, or `maxTokens`: those are honored end-to-end by both adapters and are the natural first targets of a request-mutating hook plugin on `agent/request`.

## Why not keep them?

"An explicit UNSUPPORTED throw is honest contract behavior" — but a knob whose only implementation across both twins is rejection promises nothing, and deleting it upgrades the failure mode: an accidental setter becomes a compile error instead of a runtime throw. "Strict schema adherence is an officially documented provider feature with complete plumbing" — but a knob is not product surface until a shipped tool sets it AND an endpoint honors it; today neither is true. Each returns with its first real producer: `prefill` together with an adapter that implements chat-prefix completion (and a stated policy for adapters that do not), `strict` together with a tool that wants it and a beta-endpoint story.

## Acceptance criteria

- `rg prefill` and a tool-schema-scoped `rg strict` return only this RFC (and unrelated prose such as `strictEqual`).
- Both adapters compile and their contract tests pass without the guards; the pi-ai fixup still scrubs the library's strict default (wire parity pinned by its serializer tests).
- Doc pastes and the type-equiv manifest in sync; `pnpm run doc-sync` green.

## Risks

The shipped hook bridges set no request fields at all, and a request-mutating plugin (an `agent/request` waterfall listener) would reach for `temperature`/`stop` (kept, working), not a field adapters reject. If chat-prefix completion or strict mode become product features, the re-add lands with the adapter/endpoint work, where the contract can say what actually happens rather than "everyone throws".
