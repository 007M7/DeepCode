# @deepseek-ai/dsh-client-ui-tool

English | [中文](README.zh.md)

Client Tool presentation plugin. `ui-conversation` supplies one ordered root call through `conversation.chat.tool`; this package renders that root and its Code Dispatch children, then dispatches every atomic call through the keyed `tool.call.toolview` slot. Unregistered Tool names use the generic card.

Business UI packages register only their wire Tool names and atomic views. They do not pair Session events, rebuild the transcript, or own root/subcall topology. The Runtime remains authoritative for call/result pairing, lifecycle, and `codeDispatches`; the conversation view remains authoritative for ChatFlow placement.

## Rendering contract

`ToolCallTree` receives one root `ToolCallBlock`, selection state, the session `cwd`, and Host callbacks for opening files and inspecting calls. Through its standard session slot props it selects the Runtime-projected `codeDispatches[rootCallId]` array, then sends the root and every child through the same atomic dispatch path. The Runtime currently exposes only one Code Dispatch child level, so the renderer preserves that shape instead of inventing recursive data.

Each root and child wrapper preserves the `conversation.chat.tool` call-anchor DOM contract used for paging and selection.

The package also fills `conversation.details.tool` with `ToolDetails`. The row and details renderers share the same pure card models for `terminal`, `read`, `diff`, `search`, and `web` render intents. Unknown intent tags and malformed wire card data fall back to flattened Tool result text.

Generic rows classify known Tool names into search, read, shell, write, edit, code, or generic variants. Running, successful, failed, and interrupted lifecycle states come only from the frozen call/result slice. File paths resolve against the session `cwd` only when the user invokes the Host open-file callback; presentation code does not read Session services.

## Atomic Tool views

An owning business package registers its wire Tool name into `tool.call.toolview`:

```ts ignore-check
ctx.slots.inject('tool.call.toolview', () =>
  ctx.slots.register({
    name: 'tool.call.toolview',
    key: '<wire tool name>',
  }, BusinessToolRow))
```

The owner payload is `ToolCallOwnerProps`: `callId`, `toolName`, the frozen `block`, optional `cwd`, and plain `openFile`/`inspect` callbacks. The registration receives the normal session slot runtime share. It does not receive React nodes, Runtime services, or root/subcall knowledge.

This package currently owns the generic fallback and the built-in bash/pwsh, read, write/edit, grep/glob, web, todo, question, and Code Dispatch presentations. `ui-skill` demonstrates a business-owned registration for `skill`.

Card-specific limits and fallback rules remain in the owning [terminal](../../../.agents/notes/implemented/feature/2026-07-28-web-terminal-card.md), [diff](../../../.agents/notes/implemented/feature/2026-07-30-web-diff-card.md), [read](../../../.agents/notes/implemented/feature/2026-07-30-web-read-card-frontend.md), [search](../../../.agents/notes/implemented/feature/2026-07-30-web-search-card.md), and [web](../../../.agents/notes/implemented/feature/2026-07-30-web-result-card-frontend.md) notes.

## Model Experience

None, as this package renders already logged Tool calls and results without altering model requests, Tool execution, or session events.

#### KV Cache effect

None. The package is client-only presentation.

## Known Limitations and Deferred Work

- The Runtime currently exposes one level of Code Dispatch children. The renderer sends roots and children through the same atomic path, but it does not claim an arbitrary recursive wire topology.
- Existing first-party Tool views are initially colocated here and can move to their owning business packages independently through the keyed slot.
- Tool copy temporarily reuses the `ui-conversation` locale namespace.
