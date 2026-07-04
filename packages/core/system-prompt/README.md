# dsh-system-prompt

System prompt assembly registry. Plugins contribute ordered text sections, tool-schema providers, and named prompt variables; the agent loop calls `assemble(context)` once per step, and `renderPrompt(assembly)` is the full system prompt the model sees.

## Service: `SystemPrompt` (ctx key: `systemPrompt`)

### Public API

- `ctx.systemPrompt.section(section: PromptSection): () => void` Contribute a section. Duplicate names throw. Disposed with the calling fiber.
- `ctx.systemPrompt.tools(provider: () => ToolSchema[]): () => void` Contribute tool schemas (evaluated at each assembly). Disposed with the calling fiber.
- `ctx.systemPrompt.variable(name: string, provider: (context) => string | undefined): () => void` Contribute a prompt variable, referenced from section text as `{{name}}`. Duplicate or unreferenceable names throw; `undefined` means "no value for this assembly". Disposed with the calling fiber.
- `ctx.systemPrompt.assemble(context?: AssembleContext): Promise<PromptAssembly>` Assemble the prompt for one caller. Runs through the `system-prompt/assemble` waterfall.

### Events

| Event | Mode | Purpose |
|---|---|---|
| `system-prompt/assemble` | waterfall | Mutate/extend the assembly (with the caller's context) before it reaches the model |
| `system-prompt/change` | emit | A section, tool provider, or variable was registered or unregistered |

### Key types

- `AssembleContext` — what one `assemble()` call is FOR. Declared empty here and merge-extensible; `dsh-agent` declares `agent?: Agent`, so providers project per-agent facts. Providers must tolerate absent fields (a bare `assemble()` carries an empty context).
- `PromptSection` — `{ name, order, text: string | ((context) => string) }`. Sections are concatenated in ascending `order`. Order bands: `0` is the per-agent persona (registered by the agent loop), tool guidance uses `100–199`; negative orders render before the persona.
- `PromptAssembly` — `{ sections: AssembledSection[], tools: ToolSchema[], variables: Record<string, string | undefined> }`. Section texts arrive resolved but not yet interpolated; `variables` holds every registered variable resolved against the context. Tool schemas are part of the assembly by design: "what the model is told it can do" is one coherent thing, even though adapters transmit schemas as a separate wire field.
- `renderPrompt(assembly)` — interpolates `{{variable}}` references in each section, drops empty sections, joins with blank lines. STRICT: an unknown reference (`Object.hasOwn` lookup — prototype names like `{{constructor}}` are unknown), a registered-but-valueless reference, a malformed complete `{{…}}` group, or a `{{` that opens no complete group while a `}}` still follows (`{{{model}}}`) throws — fail loud beats shipping a malformed prompt. A lone `{{` with no `}}` anywhere after it passes through verbatim; substituted values are never re-scanned.

Merge-extensible: plugins can declare extra fields on `PromptAssembly` and `AssembleContext` via declaration merging.

### Extension points

- Section providers: tool packages own their cross-call guidance (`tool:bash`, `tool:read`, …); the agent loop owns `agent:persona`.
- Variable providers: the agent loop registers `model` and `cwd`; any plugin can register the facts it owns (a future `date`, git state, …).
- Tool schema providers: `ToolRegistry` registers itself as a tool provider automatically.
- The `system-prompt/assemble` waterfall: mutate or replace the assembly per caller (dynamic tool filtering, extra variables).

### What is NOT here

- Any hardcoded prompt text — every section comes from plugins, every deployment-authored word from config.
- Prompt compaction (belongs on the `agent/pre-step` seam in `dsh-agent`).

Design rationale: [the prompt-variables RFC](../../../docs/rfc/implemented/architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md).
