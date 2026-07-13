# dsh-system-prompt

System prompt assembly registry. Plugins contribute ordered text sections, tool-schema providers, and named prompt variables. The agent loop calls `assemble(context)` once per step, and `renderPrompt(assembly)` is the full system prompt the model sees. The plugin registers the harness-owned openers itself — the static `harness:identity` section and the global default `deployment:persona` section — so they remain available regardless of which loop plugin drives an agent. An agent-scoped contribution with the same persona name shadows that default for its agent.

## Config

| Key | Default | Meaning |
|---|---|---|
| `persona` | `''` | The global deployment-persona default: the ONE config-authored prompt fragment, rendered as the order-0 `deployment:persona` section unless an agent-scoped contribution shadows it. A template — complete `{{…}}` groups are interpreted strictly against the registered variables (the shipped loop registers `{{model}}`/`{{cwd}}`), with no escape syntax for literal braces yet. Empty ⇒ the section is dropped at render. |
| `toolOrder` | — | Explicit model-facing tool order, as a list of `ToolSchema.name`s with one `'<unlisted-tools>'` rest entry (`TOOL_ORDER_REST`): listed tools take their listed position, unlisted tools land at the rest entry in lexicographic name order. Absent ⇒ plain lexicographic name order. Applied to the collected tools BEFORE the `system-prompt/assemble` waterfall — like the sections' `order` sort, it canonicalizes what the registry contributed (registration order is a plugin-load artifact), and a waterfall listener that mutates the list owns the determinism of what it emits. Misconfiguration fails loud: a list without exactly one rest entry, or with duplicates, throws at load; a listed name with no registered tool rejects every `assemble()`; a tool provider returning the reserved rest-entry name also rejects. Under the shipped loop the turn fails before any model request. Why a central list and not per-plugin weights: [Explicit model-facing tool order](../../../docs/rfc/implemented/feature/2026-07-06-explicit-tool-order.md). |

## Service: `SystemPrompt` (ctx key: `systemPrompt`)

### Public API

- `ctx.systemPrompt.section(section: PromptSection): () => void` Contribute a section. The layer is the calling context's scope: `agent.ctx` contributes to that agent alone, shadowing a same-named global section there. Duplicate names within one layer and non-finite orders throw. Disposed with the calling fiber.
- `ctx.systemPrompt.tools(provider: (context: AssembleContext) => ToolProviderResult): () => void` Contribute tool schemas, evaluated at each assembly with that assembly's context. `ToolProviderResult` = `{ schemas, knownNames? }`: `schemas` is the post-restriction visible set; `knownNames` is the pre-restriction universe used by `toolOrder`. A provider must not return a schema named `TOOL_ORDER_REST`. Scoped providers are consulted only for their scope's assemblies. Disposed with the calling fiber.
- `ctx.systemPrompt.variable(name: string, provider: (context) => string | undefined): () => void` Contribute a prompt variable, referenced from section text as `{{name}}`. Scoped variables shadow a same-named global for that agent. Duplicate-in-layer or unreferenceable names throw; `undefined` means "no value for this assembly". Disposed with the calling fiber.
- `ctx.systemPrompt.assemble(context?: AssembleContext): Promise<PromptAssembly>` Assemble the prompt for one caller: the global layer merged with `context.scope`'s layer, with tool schemas detached before the transform seam. Runs through the scope-filtered `system-prompt/assemble` waterfall and returns its authoritative result. Rejects when a configured `toolOrder` names a tool outside the providers' `knownNames` universe, or when a provider returns the reserved rest-entry name.

### Live events

`system-prompt/assemble` is an expert cooperative seam: its returned assembly is authoritative, and a listener that replaces or removes entries owns preserving any active Code Mode or structured-output protocol. Prefer [`ToolRegistry.restrict()`](../tools/README.md) when tool filtering must stay aligned across model presentation, lookup, and execution. Registry change is the deliberately unfiltered notification that an assembly input changed, possibly for one scope; exact signatures, dispatch modes, and filtering contracts live in the generated [Cordis event catalog](../../../docs/cordis-catalog/events.md).

### Key types

- `AssembleContext` — what one `assemble()` call is FOR. Merge-extensible; declares `scope?: ScopeKey` (the layer selector) here, and `dsh-agent` declares `agent?: Agent` (the typed DX field — never set without `scope`; use `assembleContextFor(agent)`). Providers must tolerate absent fields (a bare `assemble()` carries an empty, scope-less context).
- `PromptSection` — `{ name, order, text }`. Sections are concatenated in ascending `order`. Order bands: `-100` is the harness identity, `0` the deployment persona, tool guidance uses `100–199`.
- `PromptAssembly` — `{ sections: AssembledSection[], tools: ToolSchema[], variables: Record<string, string | undefined> }`. Section texts arrive resolved but not yet interpolated; `variables` holds every registered variable resolved against the context. Tool schemas are part of the assembly by design: "what the model is told it can do" is one coherent thing, even though adapters transmit schemas as a separate wire field.
- `renderPrompt(assembly)` — interpolates `{{variable}}` references in each section, drops empty sections, joins with blank lines. STRICT: an unknown reference (`Object.hasOwn` lookup — prototype names like `{{constructor}}` are unknown), a registered-but-valueless reference, a malformed complete `{{…}}` group, or a `{{` that opens no complete group while a `}}` still follows (`{{{model}}}`) throws — fail loud beats shipping a malformed prompt. A lone `{{` with no `}}` anywhere after it passes through verbatim; substituted values are never re-scanned.

Merge-extensible: plugins can declare extra fields on `PromptAssembly` and `AssembleContext` via declaration merging.

### Extension points

- Section providers: tool packages own their cross-call guidance (`tool:bash`, `tool:read`, …); this plugin owns `harness:identity` and `deployment:persona`.
- Variable providers: the agent loop registers `model` and `cwd`; any plugin can register the facts it owns (a future `date`, git state, …).
- Tool schema providers: `ToolRegistry` registers itself as a tool provider automatically.
- The [`system-prompt/assemble` waterfall](#live-events): cooperatively mutate or replace the assembly per caller.

### What is NOT here

- Any end-user prompt-editing API — this plugin owns the config-authored global persona default, creator plugins may register agent-scoped shadows during setup, and every other section comes from the plugin that owns the fact. (The `harness:identity` line is deliberately a code literal: a harness fact, not a deployment choice; the `system-prompt/assemble` waterfall is the escape valve for a deployment that must drop it.)
- Prompt compaction (belongs on the `agent/pre-step` seam in `dsh-agent`).

Design rationale: [the prompt-variables RFC](../../../docs/rfc/implemented/architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md).
