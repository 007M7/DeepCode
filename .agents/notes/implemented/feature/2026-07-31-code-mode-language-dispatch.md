# Agent Note: Code Mode language dispatch and the Python SDK renderer

Status: implemented

English | [中文](2026-07-31-code-mode-language-dispatch.zh.md)

## Problem

Code Mode generated one SDK flavor: TypeScript. `ToolRegistry` hard-coded `renderToolsSdk` for the `tools:sdk` section and `requireCodeRuntime` rejected any `ctx.codeRuntime.language !== 'typescript'`. Adding a CPython backend means a program's source language is no longer fixed: the same visible tool registry must project a Python SDK when a Python runtime is loaded, and the model-facing `run_code` schema strings ("Execute a Python program …") must match the SDK section's language so the model never sees a TypeScript instruction over a Python runtime.

This is the tool-facing half of the multi-language Code Mode split; the [code-runtime seam](../../../../packages/code-runtime/code-runtime/README.md) already carries `CodeRuntime.language`. This note owns only how `dsh-tools` dispatches on that field. The backend that implements `language: 'python'` is owned by its own note, delivered separately.

## Decision

Language selection is a lookup on `ctx.codeRuntime.language`, resolved lazily at prompt assembly, against two parallel tables in `dsh-tools`:

- `SDK_RENDERERS` (index.ts) maps a language to its `tools:sdk` renderer — `typescript → renderToolsSdk`, `python → renderToolsSdkPy`. The `tools:sdk` section reads the loaded runtime's language and picks the renderer; `requireCodeRuntime` rejects a `mode: code`/`both` runtime whose language is absent from the table, naming the known languages.
- `RUN_CODE_FLAVORS` (code-mode.ts) maps a language to its two model-facing `run_code` strings (tool `description` and the `code` parameter description), so a language's SDK section and its transport schema always agree.

Both tables are read with `Object.hasOwn` before use so a language named `toString`/`constructor` cannot resolve an inherited `Object.prototype` member as a renderer; a language present on neither table but reaching the read fails loud (defense-in-depth against a caller bypassing the guard). Adding a backend language is two table entries plus its renderer — no `agent-loop` or registry-structure change.

`code-mode.ts` depends only on the runtime seam (`@deepseek-ai/dsh-code-runtime`), never on a concrete backend; dispatch is by `runtime.language` at run time. The tool layer therefore lands independently of the protocol and backend PRs — it needs only the seam's `language` field, which is already on master.

### The Python SDK renderer

`py-types.ts` renders the same unified tool-schema vocabulary `jsonSchemaToTs` covers, targeting Python: `jsonSchemaToPy` emits a type expression per JSON-schema node, and `renderToolsSdkPy` assembles named `TypedDict`s for each visible tool's arguments and canonical output plus a `tools` object with usage instructions equivalent to the TypeScript flavor. Unsupported raw constructs degrade rather than throwing during assembly, matching the TypeScript renderer's contract. The output is deterministic — lexicographic tool order, byte-identical text for an unchanged tool set — so the prompt stays prefix-cache-friendly.

## Rejected alternatives

- **A `language` config field on `ToolRegistry`.** Deployment would then have two places to name the language (the loaded runtime and the tools config) that can disagree; the loaded runtime is the single source of truth, so the registry reads it rather than duplicating it.
- **Importing the Python backend into `code-mode.ts` to detect it.** That would couple the tool layer to a concrete backend and force the protocol/backend PRs to land first. Runtime dispatch on `language` keeps the layer backend-agnostic and independently shippable.
- **A default renderer for an unknown language.** A silent fallback would emit a TypeScript SDK over, e.g., a Ruby runtime — the model would see instructions in the wrong language. Failing loud at assembly is the repository's misconfiguration stance.
