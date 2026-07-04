# RFC: Remove defaults from the tool-schema DSL

Status: proposed

## Problem

`SchemaProp.default?: unknown` exists in the first-party tool-schema DSL ([packages/core/tools/src/schema.ts](../../../../packages/core/tools/src/schema.ts)). The converter copies it into the JSON Schema sent to the model, but the runtime validator does not apply defaults: an omitted optional argument remains omitted, and a missing required argument still fails. The code already marks this with `XXX(unused-default)`.

No first-party tool definition in the repo sets `default`. Grepping `SchemaProp` defaults finds only the DSL itself, [docs/core-data-structures/tools.md](../../../core-data-structures/tools.md), and tests that assert the converter preserves a synthetic default. The behavior those tests pin is therefore model-visible metadata that no shipped tool emits and no runtime behavior honors.

This is exactly the kind of small speculative knob that makes a custom DSL harder to explain. The [custom schema DSL RFC](../../implemented/architecture/2026-06-11-custom-schema-dsl.md) accepted a deliberately small subset until real tools demanded more; `default` was included in that early subset, but the real tools have not demanded it.

## Proposal

Remove `default` from the first-party `SchemaProp` DSL.

- Delete `default?: unknown` from `SchemaProp`.
- Delete the `prop.default` to JSON Schema conversion line.
- Delete tests that assert synthetic defaults round-trip through `schemaSpecToJsonSchema`.
- Update `validateArgs` docs so they no longer describe default non-application as part of the DSL semantics.
- Update [docs/core-data-structures/tools.md](../../../core-data-structures/tools.md), the type-equivalence manifest output if needed, and any generated docs affected by the public type change.

This does not ban defaults from every possible tool schema. `ToolRegistry.register()` still accepts raw model-facing `ToolSchema` objects, so a future MCP or raw-JSON-Schema producer can pass through provider-specific JSON Schema fields if needed. The simplification is only for the first-party typed DSL that `defineTool()` owns.

## Why not apply defaults instead?

Applying defaults would be a behavior change at the model boundary: `defineTool()` would need to synthesize missing arguments before the typed `execute` body runs, decide whether defaults apply recursively, and document how defaulted values interact with required fields and `InferArgs`. That is a real feature, not a cleanup, and no current tool needs it.

Keeping metadata-only defaults is worse than doing nothing because it suggests the tool runtime has a defaulting story when it does not. Removing the field leaves one clear rule: optional arguments may be absent, required arguments must be present, and tools that want defaults put them in their own execution code.

## Acceptance criteria

- `SchemaProp` no longer has a `default` field, and `schemaSpecToJsonSchema()` no longer emits defaults from first-party DSL specs.
- `rg "unused-default|default\\?: unknown|prop\\.default|default:" packages/core/tools docs/core-data-structures/tools.md --glob '!docs/rfc/**'` finds no remaining DSL-default surface except unrelated JavaScript `default` syntax.
- Tool schema conversion, validation, type inference, and `defineTool()` tests still cover requiredness, enums, nested objects, arrays, invalid args, and presentation metadata.
- `pnpm run doc-sync`, including `doc-typecheck` and type-equivalence verification, passes after implementation.
- `pnpm run test:coverage` and `pnpm run hygiene` pass after implementation.

## Risks

- A future tool may want to tell the model a default value. That tool can either default inside `execute` and describe the behavior in prose, or a later RFC can reintroduce DSL defaults with real runtime semantics and at least one first-party consumer.
- Removing a type field breaks any external first-party DSL consumer. The repo is unreleased, so tightening the public type now is preferable to shipping a field whose semantics are "emitted but ignored."
