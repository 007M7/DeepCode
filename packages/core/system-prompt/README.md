# dsh-system-prompt

System prompt assembly registry. Plugins contribute ordered text sections, tool-schema providers, named prompt variables, and authoritative named protections; the agent loop calls `assemble(context)` once per step, and `renderPrompt(assembly)` is the full system prompt the model sees. The plugin registers the harness-owned openers itself — the static `harness:identity` section and the deployment's `deployment:persona` section — so they exist for every agent regardless of which loop plugin drives it.

## Model Experience

| Context surface | What the model sees | Token effect |
|---|---|---|
| System prompt | Every assembly starts with `You are an AI agent powered by the DeepSeek Harness SDK.`, then the configured persona and ordered plugin sections after strict variable interpolation. Empty sections disappear; scoped sections and variables can shadow globals for one agent. | Identity is a fixed per-request cost. Persona and plugin text are repeated per request and scale with their rendered content. |
| Tool schemas | The model receives the collected, per-agent-visible tool names, descriptions, and JSON schemas in configured or lexicographic order after restrictions and assembly interception. | Schema tokens repeat on every request. Restricting a tool removes its entire schema cost for that agent; reordering changes cache shape but not semantic content. |

## Config

| Key | Default | Meaning |
|---|---|---|
| `persona` | `''` | The deployment persona: the ONE deployment-authored prompt fragment, rendered as the order-0 `deployment:persona` section and shared by every agent in the context (subagents included). A template — complete `{{…}}` groups are interpreted strictly against the registered variables (the shipped loop registers `{{model}}`/`{{cwd}}`), with no escape syntax for literal braces yet. Empty ⇒ the section is dropped at render. |
| `toolOrder` | — | Explicit model-facing tool order, as a list of `ToolSchema.name`s with one `'<unlisted-tools>'` rest entry (`TOOL_ORDER_REST`): listed tools take their listed position, unlisted tools land at the rest entry in lexicographic name order. Absent ⇒ plain lexicographic name order. Applied to the collected tools BEFORE the `system-prompt/assemble` waterfall — like the sections' `order` sort, it canonicalizes what the registry contributed (registration order is a plugin-load artifact), and a waterfall listener that mutates the list owns the determinism of what it emits. Misconfiguration fails loud: a list without exactly one rest entry, or with duplicates, throws at load; a listed name with no registered tool rejects every `assemble()`; a tool provider returning the reserved rest-entry name also rejects. Under the shipped loop the turn fails before any model request. Why a central list and not per-plugin weights: [Explicit model-facing tool order](../../../docs/rfc/implemented/feature/2026-07-06-explicit-tool-order.md). |

## Service: `SystemPrompt` (ctx key: `systemPrompt`)

### Public API

- `ctx.systemPrompt.section(section: PromptSection): () => Promise<void> | void` Contribute a section. The registry snapshots `name`, `order`, and the text value/callback, so later caller-object mutation cannot rename a stored section. The layer is the CALLING context's scope: `agent.ctx` contributes to that agent alone, SHADOWING a same-named global section there (the per-agent persona mechanism — a scoped `deployment:persona`). Duplicate names within one layer throw, and a globally protected section name cannot be shadowed. Disposed with the calling fiber.
- `ctx.systemPrompt.tools(provider: (context: AssembleContext) => ToolProviderResult): () => Promise<void> | void` Contribute tool schemas, evaluated at each assembly with that assembly's context. `ToolProviderResult` = `{ schemas, knownNames? }`: `schemas` is the post-restriction visible set for `context.scope`; `knownNames` (defaulting to the schemas' names) is the pre-restriction universe `toolOrder` validates against. A provider must not return a schema named `TOOL_ORDER_REST`. Scoped providers are consulted only for their scope's assemblies. Disposed with the calling fiber.
- `ctx.systemPrompt.variable(name: string, provider: (context) => string | undefined): () => Promise<void> | void` Contribute a prompt variable, referenced from section text as `{{name}}`. Scoped variables (via `agent.ctx`) shadow a same-named global for that agent. Duplicate-in-layer or unreferenceable names throw; `undefined` means "no value for this assembly". Disposed with the calling fiber.
- `ctx.systemPrompt.protect(protection: PromptProtection): () => Promise<void> | void` Make named section/tool contributions authoritative after the assembly waterfall. Protection restores canonical registry/provider presence and definition; restored entries keep canonical order with one another and anchor before their first surviving later unprotected canonical neighbor (or at the end), without undoing listener reordering of unprotected entries. Canonical absence is authoritative too, so a mode-hidden tool cannot be fabricated by a listener. Calling through `agent.ctx` protects only that agent's assemblies. A global section protection additionally reserves its name against scoped shadows; registering either side of that conflict fails loudly instead of treating the shadow as canonical. Inputs are snapshotted, empty protections throw, and disposal removes the protection.
- `ctx.systemPrompt.assemble(context?: AssembleContext): Promise<PromptAssembly>` Assemble the prompt for one caller: the global layer merged with `context.scope`'s layer (scoped shadows global). Runs through the scope-filtered `system-prompt/assemble` waterfall, then restores protected contributions from the pre-waterfall canonical assembly. Rejects when a configured `toolOrder` names a tool outside the providers' `knownNames` universe (a restricted-away KNOWN tool is a normal absence), or when a provider returns the reserved rest-entry name.

### Live events

Prompt assembly is the scope-filtered transformable seam; registry change is the deliberately unfiltered notification that an assembly input changed, possibly for one scope. Exact signatures, dispatch modes, and filtering contracts live in the generated [Cordis event catalog](../../../docs/cordis-catalog/events.md). Named protections apply only after a successful assembly waterfall returns and are owned by the service rather than represented as another event listener.

### Key types

- `AssembleContext` — what one `assemble()` call is FOR. Merge-extensible; declares `scope?: ScopeKey` (the layer selector) here, and `dsh-agent` declares `agent?: Agent` (the typed DX field — never set without `scope`; use `assembleContextFor(agent)`). Providers must tolerate absent fields (a bare `assemble()` carries an empty, scope-less context).
- `PromptSection` — `{ name, order, text: string | ((context) => string) }`. Sections are concatenated in ascending `order`. Order bands: `-100` is the harness identity, `0` the deployment persona (both registered by this plugin), tool guidance uses `100–199`; other negative orders also render before the persona.
- `PromptAssembly` — `{ sections: AssembledSection[], tools: ToolSchema[], variables: Record<string, string | undefined> }`. Section texts arrive resolved but not yet interpolated; `variables` holds every registered variable resolved against the context. Tool schemas are part of the assembly by design: "what the model is told it can do" is one coherent thing, even though adapters transmit schemas as a separate wire field.
- `PromptProtection` — `{ sections?: readonly string[], tools?: readonly string[] }`. Named contributions whose canonical pre-waterfall state is restored after all listeners; protections compose by set union rather than callback order, and global section names are reserved against scoped shadows.
- `renderPrompt(assembly)` — interpolates `{{variable}}` references in each section, drops empty sections, joins with blank lines. STRICT: an unknown reference (`Object.hasOwn` lookup — prototype names like `{{constructor}}` are unknown), a registered-but-valueless reference, a malformed complete `{{…}}` group, or a `{{` that opens no complete group while a `}}` still follows (`{{{model}}}`) throws — fail loud beats shipping a malformed prompt. A lone `{{` with no `}}` anywhere after it passes through verbatim; substituted values are never re-scanned.

Merge-extensible: plugins can declare extra fields on `PromptAssembly` and `AssembleContext` via declaration merging.

### Extension points

- Section providers: tool packages own their cross-call guidance (`tool:bash`, `tool:read`, …); this plugin owns `harness:identity` and `deployment:persona`.
- Variable providers: the agent loop registers `model` and `cwd`; any plugin can register the facts it owns (a future `date`, git state, …).
- Tool schema providers: `ToolRegistry` registers itself as a tool provider automatically.
- The `system-prompt/assemble` waterfall: mutate or replace the assembly per caller (dynamic tool filtering, extra variables).
- `systemPrompt.protect()`: reserve canonical section/tool contributions for invariants that ordinary waterfall listeners must not be able to remove or replace.

### What is NOT here

- Any deployment-authored prompt text outside config — the persona is this plugin's `persona` config, and every other section comes from the plugin that owns the fact. (The `harness:identity` line is deliberately a code literal: a harness fact, not a deployment choice; the `system-prompt/assemble` waterfall is the escape valve for a deployment that must drop it.)
- Prompt compaction (belongs on the `agent/pre-step` seam in `dsh-agent`).

Design rationale: [the prompt-variables RFC](../../../docs/rfc/implemented/architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md).
