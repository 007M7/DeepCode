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

Both tables are read with `Object.hasOwn` before use so a language named `toString`/`constructor` cannot resolve an inherited `Object.prototype` member as a renderer. The two guards differ in reachability: `SDK_RENDERERS`' in-callback guard is unreachable because `requireCodeRuntime` validated the same `const` table earlier in the same callback (it carries a `/* v8 ignore */`), while `RUN_CODE_FLAVORS`' guard is the primary, publicly reachable rejection — reading `ctx.tools.schemas()` under a runtime whose language has a renderer but no flavor entry hits it, and a test covers it. Schema emission reads the runtime through `peekRuntime()` rather than `requireRuntime()`: `undefined` (no runtime mounted, the doc-catalog schema harvest that never reaches a model) degrades to the TypeScript flavor, whereas a mounted unknown language fails loud — this is NOT the silent fallback rejected below, which concerns emitting a wrong-language SDK for a real runtime. Adding a backend language is two table entries plus its renderer — no `agent-loop` or registry-structure change.

`code-mode.ts` depends only on the runtime seam (`@deepseek-ai/dsh-code-runtime`), never on a concrete backend; dispatch is by `runtime.language` at run time. The tool layer therefore lands independently of the protocol and backend PRs — it needs only the seam's `language` field, which is already on master.

### The Python SDK renderer

`py-types.ts` renders the same unified tool-schema vocabulary `jsonSchemaToTs` covers, targeting Python: `jsonSchemaToPy` emits a type expression per JSON-schema node, and `renderToolsSdkPy` assembles named `TypedDict`s for each visible tool's arguments and canonical output plus a `tools` object with usage instructions equivalent to the TypeScript flavor. Unsupported raw constructs degrade rather than throwing during assembly, matching the TypeScript renderer's contract. The output is deterministic — lexicographic tool order, byte-identical text for an unchanged tool set — so the prompt stays prefix-cache-friendly.

`renderType` validates the whole schema once (`assertSupportedJsonSchema`) and then trusts it, wrapping the walk in one `try/catch` that degrades to `Any` — the same trusted-after-validation stance the sibling `ts-types` renderer takes at this typed same-process seam ([Trust TypeScript at typed same-process seams](../../../../AGENTS.md)). It deliberately carries NO defenses against a schema whose accessors mutate between reads (post-validation cycles, TOCTOU on `const`/`enum`, self-referential functions): the input is a first-party registration (a `defineTool` literal or a raw registration) or a wire-derived plain JSON schema — the former is trusted per AGENTS.md, the latter is a `JSON.parse` product that physically cannot carry accessors, and `renderType` re-validates the whole tree on every call regardless — so such inputs are unreachable, and adding per-shape guards here would break symmetry with `ts-types` (which has none) for values the static interface forbids. `jsonSchemaToPy(schema: unknown)` accepts `unknown` and returns `Any` on a malformed schema — the Python counterpart of the TS flavor's `unknown` — but its contract is "degrade an unsupported schema", not "survive an adversarial mutating one".

## Alternatives considered

- **A `language` config field on `ToolRegistry`.** Deployment would then have two places to name the language (the loaded runtime and the tools config) that can disagree; the loaded runtime is the single source of truth, so the registry reads it rather than duplicating it.
- **Importing the Python backend into `code-mode.ts` to detect it.** That would couple the tool layer to a concrete backend and force the protocol/backend PRs to land first. Runtime dispatch on `language` keeps the layer backend-agnostic and independently shippable.
- **A default renderer for an unknown language.** A silent fallback would emit a TypeScript SDK over, e.g., a Ruby runtime — the model would see instructions in the wrong language. Failing loud at assembly is the repository's misconfiguration stance.

## Consequences

Adding a backend language is two table entries — an `SDK_RENDERERS` entry and a `RUN_CODE_FLAVORS` entry — plus the renderer function the former points at, with no change to `agent-loop` or the registry structure. The two tables (`SDK_RENDERERS`, `RUN_CODE_FLAVORS`) must stay in step: a language present in one but not the other is a latent inconsistency the `Object.hasOwn` guards turn into a loud failure rather than a wrong-language prompt. The tool layer stays free of any concrete backend dependency, so it lands and is testable on master ahead of the Python protocol and backend.

The cost is that the Python branch of both tables is unreachable on this base: `CodeRuntime.language` is set by the loaded backend, the only published backend is `dsh-code-runtime-worker` (`'typescript'`), and the registry reads the loaded runtime rather than a config field, so no assembled application can select `renderToolsSdkPy` or `PYTHON_FLAVOR`. The model-visible surface is therefore unchanged by this note's work until a backend reporting `'python'` is published, and this PR's coverage is unit-level — the renderer output plus the dispatch and rejection paths. The keyless snapshot for the Python model interface belongs to the PR that publishes that backend, because only there does a real `cordis.yml` over published plugins produce a Python assembly; a snapshot example that mounted a fixture runtime here would assert against a test double, which [docs/testing.md](../../../../docs/testing.md) rejects as a substitute for the assembled application transcript.
