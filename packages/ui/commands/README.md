# @deepseek-ai/dsh-commands

Plugin-owned human-command registry shared by the TUI and ACP adapters. The [plugin command registration RFC](../../../docs/rfc/implemented/feature/2026-07-19-plugin-command-registration.md) owns the boundary and protocol mapping.

## Service contract

`ctx.commands.register(definition)` registers one lowercase command name, description, optional ACP-compatible unstructured-input hint, optional surface list, and abortable handler. A plain-context registration is global. A command-producing plugin mounted beneath `agent.ctx` declares its own `commands` injection and creates an exact agent-scoped definition; it shadows a global definition with the same name. This child-injection shape preserves the agent scope without making the core agent loop depend on a UI service. Duplicate names within one layer fail during registration. Every disposer is the exact Cordis effect disposer, and registration or removal emits `commands/change` so live adapters can refresh discovery.

`list(agent, surface)` returns immutable, name-sorted descriptors after scoped shadowing and surface filtering. `find(agent, surface, name)` returns the corresponding definition. `execute(agent, surface, line, signal)` uses `parseCommand()` and runs only a known command, returning `undefined` for invalid syntax, unknown names, or commands hidden from that surface.

`parseCommand()` recognizes a slash at byte zero, a lowercase name containing letters, digits, `_`, or `-`, and either end-of-input or whitespace. It returns every byte after the name as `rawInput`, including separator whitespace; consumers own their command-specific grammar and may normalize only what that grammar permits.

Handlers return `success` or `error` plus optional UI text. Results are rendered directly by the adapter and never enter model history. The registry races handler completion against the supplied abort signal, but an uncooperative handler may continue its own external side effects after the caller stops awaiting it.

## Composition

The terminal and ACP app bundles mount this service with their consuming front door; the UI-less agent spine does not. Custom compositions that use `dsh-tui`, `dsh-acp`, or a command producer mount `@deepseek-ai/dsh-commands` explicitly.

## Model Experience

### Direct human commands

**What the model sees**: Nothing. Known slash commands execute in the UI command plane, and their `CommandResult` text is not submitted as a user message. Unknown slash-command input is rejected by shipped adapters instead of becoming a model prompt.

**Token effect**: Command discovery, execution, and UI output add no model tokens. A command plugin may separately mutate a model-visible domain through that domain's durable APIs.

## Known Limitations and Deferred Work

- **Only unstructured text input** — the descriptor intentionally matches ACP's current unstructured command input; forms, completion schemas, and typed arguments remain command-owned parsing concerns.
- **No persisted command output** — adapters display results live, but the generic registry does not add them to the session log or reconstruct them after reconnect.
- **Cooperative side-effect cancellation** — dispatch stops awaiting on abort; handlers must honor the signal to stop work that has already escaped into external systems.
