# dsh-system-prompt

System prompt assembly registry. Plugins contribute ordered text sections, tool-schema providers, and named prompt variables; the agent loop calls `assemble(context)` once per step, and `renderPrompt(assembly)` is the full system prompt the model sees. The plugin registers the harness-owned openers itself — the static `harness:identity` section and the deployment's `deployment:persona` section — so they exist for every agent regardless of which loop plugin drives it.

## Config

| Key | Default | Meaning |
|---|---|---|
| `persona` | `''` | The deployment persona: the ONE deployment-authored prompt fragment, rendered as the order-0 `deployment:persona` section and shared by every agent in the context (subagents included). A template — complete `{{…}}` groups are interpreted strictly against the registered variables (the shipped loop registers `{{model}}`/`{{cwd}}`), with no escape syntax for literal braces yet. Empty ⇒ the section is dropped at render. |
| `toolOrder` | — | Explicit model-facing tool order, as a list of `ToolSchema.name`s with one `'<unlisted-tools>'` rest entry (`TOOL_ORDER_REST`): listed tools take their listed position, unlisted tools land at the rest entry in lexicographic name order. Absent ⇒ plain lexicographic name order. Applied to the collected tools BEFORE the `system-prompt/assemble` waterfall — like the sections' `order` sort, it canonicalizes what the registry contributed (registration order is a plugin-load artifact), and a waterfall listener that mutates the list owns the determinism of what it emits. Misconfiguration fails loud: a list without exactly one rest entry, or with duplicates, throws at load; a listed name with no registered tool rejects every `assemble()`; a tool provider returning the reserved rest-entry name also rejects. Under the shipped loop the turn fails before any model request. Why a central list and not per-plugin weights: [Explicit model-facing tool order](../../../docs/rfc/implemented/feature/2026-07-06-explicit-tool-order.md). |

## Service: `SystemPrompt` (ctx key: `systemPrompt`)

### Public API

- `ctx.systemPrompt.section(section: PromptSection): () => void` Contribute a section. Duplicate names throw. Disposed with the calling fiber.
- `ctx.systemPrompt.tools(provider: () => ToolSchema[]): () => void` Contribute tool schemas (evaluated at each assembly). A provider must not return a schema named `TOOL_ORDER_REST`; that name is reserved for `toolOrder`'s rest entry. Disposed with the calling fiber.
- `ctx.systemPrompt.variable(name: string, provider: (context) => string | undefined): () => void` Contribute a prompt variable, referenced from section text as `{{name}}`. Duplicate or unreferenceable names throw; `undefined` means "no value for this assembly". Disposed with the calling fiber.
- `ctx.systemPrompt.assemble(context?: AssembleContext): Promise<PromptAssembly>` Assemble the prompt for one caller. Runs through the `system-prompt/assemble` waterfall. Rejects when a configured `toolOrder` names a tool no provider contributed, or when a provider returns the reserved rest-entry name.

### Events

| Event | Mode | Purpose |
|---|---|---|
| `system-prompt/assemble` | waterfall | Mutate/extend the assembly (with the caller's context) before it reaches the model |
| `system-prompt/change` | emit | A section, tool provider, or variable was registered or unregistered |

### Key types

- `AssembleContext` — what one `assemble()` call is FOR. Declared empty here and merge-extensible; `dsh-agent` declares `agent?: Agent`, so providers project per-agent facts. Providers must tolerate absent fields (a bare `assemble()` carries an empty context).
- `PromptSection` — `{ name, order, text: string | ((context) => string) }`. Sections are concatenated in ascending `order`. Order bands: `-100` is the harness identity, `0` the deployment persona (both registered by this plugin), tool guidance uses `100–199`; other negative orders also render before the persona.
- `PromptAssembly` — `{ sections: AssembledSection[], tools: ToolSchema[], variables: Record<string, string | undefined> }`. Section texts arrive resolved but not yet interpolated; `variables` holds every registered variable resolved against the context. Tool schemas are part of the assembly by design: "what the model is told it can do" is one coherent thing, even though adapters transmit schemas as a separate wire field.
- `renderPrompt(assembly)` — interpolates `{{variable}}` references in each section, drops empty sections, joins with blank lines. STRICT: an unknown reference (`Object.hasOwn` lookup — prototype names like `{{constructor}}` are unknown), a registered-but-valueless reference, a malformed complete `{{…}}` group, or a `{{` that opens no complete group while a `}}` still follows (`{{{model}}}`) throws — fail loud beats shipping a malformed prompt. A lone `{{` with no `}}` anywhere after it passes through verbatim; substituted values are never re-scanned.

Merge-extensible: plugins can declare extra fields on `PromptAssembly` and `AssembleContext` via declaration merging.

### Extension points

- Section providers: tool packages own their cross-call guidance (`tool:bash`, `tool:read`, …); this plugin owns `harness:identity` and `deployment:persona`.
- Variable providers: the agent loop registers `model` and `cwd`; any plugin can register the facts it owns (a future `date`, git state, …).
- Tool schema providers: `ToolRegistry` registers itself as a tool provider automatically.
- The `system-prompt/assemble` waterfall: mutate or replace the assembly per caller (dynamic tool filtering, extra variables).

### What is NOT here

- Any deployment-authored prompt text outside config — the persona is this plugin's `persona` config, and every other section comes from the plugin that owns the fact. (The `harness:identity` line is deliberately a code literal: a harness fact, not a deployment choice; the `system-prompt/assemble` waterfall is the escape valve for a deployment that must drop it.)
- Prompt compaction (belongs on the `agent/pre-step` seam in `dsh-agent`).

Design rationale: [the prompt-variables RFC](../../../docs/rfc/implemented/architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md).
