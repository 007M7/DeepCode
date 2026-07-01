# dsh-system-prompt

System prompt assembly registry. Plugins contribute ordered text sections and tool-schema providers; the agent loop calls `assemble()` once per step.

## Service: `SystemPrompt` (ctx key: `systemPrompt`)

### Public API

- `ctx.systemPrompt.section(section: PromptSection): () => void` Contribute a section. Disposed with the calling fiber.
- `ctx.systemPrompt.tools(provider: () => ToolSchema[]): () => void` Contribute tool schemas (evaluated at each assembly). Disposed with the calling fiber.
- `ctx.systemPrompt.assemble(): Promise<PromptAssembly>` Assemble the current prompt. Runs through the `system-prompt/assemble` waterfall.

### Events

| Event | Mode | Purpose |
|---|---|---|
| `system-prompt/assemble` | waterfall | Mutate/extend the assembly before it reaches the model |
| `system-prompt/change` | emit | A section or tool provider was registered or unregistered |

### Key types

- `PromptSection` — `{ name, order, text: string | (() => string) }`. Sections are concatenated in ascending `order`.
- `PromptAssembly` — `{ sections: PromptSection[], tools: ToolSchema[] }`. Tool schemas are part of the assembly by design: "what the model is told it can do" is one coherent thing, even though adapters transmit schemas as a separate wire field.
- `renderPrompt(assembly)` — joins section texts with blank lines.

Merge-extensible: plugins can declare extra fields on `PromptAssembly` via declaration merging.

### Extension points

- Section providers: AGENTS.md reader, cwd notifier, persona config, etc.
- Tool schema providers: `ToolRegistry` registers itself as a tool provider automatically.
- The `system-prompt/assemble` waterfall: mutate or replace the assembly (system-prompt configurability, dynamic tool filtering).

### What is NOT here

- Any hardcoded prompt text — every section comes from plugins.
- Prompt compaction (belongs on the `agent/pre-step` seam in `dsh-agent`).
