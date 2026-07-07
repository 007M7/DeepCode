# RFC: MCP client plugin — connect to external MCP servers and bridge their tools

Status: proposed

## Problem

The harness has no way to consume tools from the MCP (Model Context Protocol) ecosystem. MCP is the emerging standard for tool servers — GitHub, filesystem, databases, code search, and hundreds of community servers expose tools via MCP. Users want to point the harness at one or more MCP servers and have their tools appear as native model-facing tools, without writing per-server glue code.

The `ToolRegistry` already accepts raw JSON Schema tool definitions (documented in `dsh-tools` README: "Raw JSON-Schema tool definitions (from MCP servers) are still accepted by `ToolRegistry.register()` directly"), and the extension cookbook sketches the intended pattern ("MCP | one plugin per server: discover tools → `ctx.tools.register()`"). The infrastructure is ready; the bridge plugin is missing.

## Proposal

### Package

A single package `@deepseek-ai/dsh-mcp-client` at `packages/mcp/mcp-client/`. No capability-seam three-package split — there is no foreseeable second MCP client implementation, and the convention is "don't split preemptively" ([capability seams RFC](../../implemented/architecture/2026-06-13-capability-seams.md)).

### SDK

Use the official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) (`Client`, `StdioClientTransport`, `StreamableHTTPClientTransport`). The harness does not implement its own JSON-RPC — consistent with how ACP delegates to `@agentclientprotocol/sdk`.

### Scope

MCP Client only (no server side — ACP already covers the "expose harness as an agent" role). Bridge **Tools** only — Resources and Prompts are deferred (they require harness-side consumption mechanisms that don't exist yet, and design space is large).

### Plugin shape

Namespace plugin (named exports `name`/`inject`/`Config`/`apply`, no `export default`). `inject: ['tools']`. Each MCP server is one plugin instance in `cordis.yml` — the same package loaded N times with different configs, like `dsh-tool-subagent`.

### Configuration

Flat discriminated union on the `transport` field:

```typescript
interface StdioConfig {
  transport: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  toolPrefix?: string
  toolCallTimeoutMs?: number  // default 60_000
}

interface StreamableHttpConfig {
  transport: 'streamable-http'
  url: string
  headers?: Record<string, string>
  toolPrefix?: string
  toolCallTimeoutMs?: number  // default 60_000
}

type Config = StdioConfig | StreamableHttpConfig
```

Example `cordis.yml` usage:

```yaml
- id: mcp-github
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN

- id: mcp-web
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    transport: streamable-http
    url: http://localhost:3000/mcp
    headers:
      Authorization: !!js `Bearer ${process.env.MCP_TOKEN}`
```

### Lifecycle

Boot-time from `cordis.yml`. HMR (`@cordisjs/plugin-hmr`) provides hot-swap: editing the yml entry triggers dispose of the old instance (disconnects, unregisters tools) and creation of a new one (connects, discovers, registers). No runtime-dynamic API for now.

### Tool discovery and registration

1. On connect: `client.listTools()` → register each tool as a raw `ToolDefinition` via `ctx.tools.register()`.
2. Listen for `notifications/tools/list_changed` → re-run `listTools()`, diff, unregister removed, register added.
3. Registration uses the raw JSON Schema from MCP (no `defineTool` DSL conversion).
4. No `presentCall`/`presentResult` — the ACP bridge's generic-card fallback handles rendering.
5. Tools are transparent in the system prompt — no "[via MCP]" annotation.

### Name conflict handling

If `config.toolPrefix` is set (e.g. `"gh_"`), it is prepended to each MCP tool name before registration. If a name collides with an already-registered tool, log a warning and skip that tool (do not crash the entire server connection).

### Tool execution

A unified `execute` handler for all tools from one MCP server:

1. Call `client.callTool({ name, arguments }, { signal: exec.signal })` with the configured timeout.
2. Map the result:
   - Multiple `text` content blocks → join with `'\n'` into a single `TextBlock` (required: `flattenText` uses `join('')` without separator, so multiple blocks would lose inter-block boundaries).
   - `image` content blocks → discard with a `ctx.logger.warn` (the harness has no image content block type; [drop-image RFC](../../implemented/simplification/2026-07-04-drop-image-content-block.md)).
   - `isError: true` → map to the harness `isError` result path (`{ content: [...], isError: true }`).
3. Cancellation: `exec.signal` (from the agent loop's cancel) is passed through to the MCP SDK's `callTool`, which sends `$/cancelRequest` to the server.

### Subprocess environment (stdio transport)

Replicate the `buildChildEnv` + `SENSITIVE_ENV_PATTERN` scrub from `dsh-subagent-acp`: filter ambient env (strip credential-shaped vars matching `/KEY|SECRET|TOKEN/i`), then merge `config.env` on top. Explicit env overrides survive the scrub.

### Disconnection / crash

No auto-reconnect. If the MCP server process exits or the transport closes:

1. The effect disposes → all registered tools are unregistered (fiber-scoped disposers).
2. Subsequent model calls to those tools → `ToolNotFoundError` → `isError: true`.
3. Recovery: user edits `cordis.yml` (triggers HMR reload) or restarts the harness.

This matches the ACP subagent pattern: "crash = terminal, report error, clean up, don't retry."

## Alternatives considered

### MCP Server side (expose harness tools to external MCP clients)

Deferred. The ACP bridge already exposes the harness as an agent server. Adding an MCP server layer would duplicate that with a different protocol, and the primary user need is consuming external tools, not exposing them.

### Capability-seam three-package split (interface / impl / consumer)

Rejected. There is no foreseeable alternative MCP client implementation — MCP has one protocol, one SDK. The convention is "don't split preemptively" until a second implementation appears.

### Auto-reconnect with exponential backoff

Rejected for v1. Adds complexity (partial-availability state where tools are registered but temporarily non-functional), and stdio process crashes usually indicate a configuration problem that retrying won't fix. HMR already provides the manual recovery path. Can be added as a future `reconnect: boolean` config if needed.

### Bridge Resources and Prompts

Deferred. Resources need a harness-side mechanism to decide WHEN to inject content (system prompt? on demand? model-triggered?). Prompts need a "prompt template" concept the harness lacks. Both require their own design; Tools are the high-value, low-risk starting point.

### Always-on namespace prefix (e.g. `mcp_github__create_issue`)

Rejected. Most MCP servers already use semantic prefixes in their tool names (e.g. `github_create_issue`). A forced prefix would break model familiarity with well-known MCP tool names and waste context tokens. Optional `toolPrefix` handles the rare collision case.

### Preserve multiple TextBlocks in tool result

Rejected. `flattenText()` in the DeepSeek serializer uses `join('')` (no separator) when flattening `ContentBlock[]` to wire format. Multiple text blocks would silently lose inter-block boundaries — a correctness bug. All existing tools return a single TextBlock; the MCP bridge follows suit.

## Acceptance criteria

- A `cordis.yml` entry connecting to an MCP stdio server (e.g. `@modelcontextprotocol/server-filesystem`) results in that server's tools appearing in the model's tool list and being callable.
- A `cordis.yml` entry connecting via Streamable HTTP works equivalently.
- Adding/removing an MCP entry in `cordis.yml` while HMR is active hot-swaps the tools without restart.
- `toolPrefix` config correctly prefixes tool names; a name collision logs a warning and skips.
- Agent cancel propagates to in-flight `callTool` (abort signal).
- Timeout fires and produces an `isError` result when an MCP server hangs.
- Server crash cleanly unregisters tools (no orphaned tool definitions).
- `notifications/tools/list_changed` triggers a re-sync of tool registrations.
- 100% test coverage on the new package (unit tests with mocked MCP SDK).

## Risks

- **MCP SDK stability**: the `@modelcontextprotocol/sdk` is still evolving. Breaking changes in the SDK require updating the bridge. Mitigation: pin a specific version; the SDK is widely adopted (Claude Desktop, Cursor, VS Code) so breaking changes are unlikely to be silent.
- **Tool schema quality**: MCP servers may expose poorly-described tools (vague descriptions, incomplete JSON schemas). The harness passes them through as-is — garbage-in-garbage-out. Mitigation: this is the server author's responsibility, not the bridge's.
- **Stdio process management**: a misbehaving MCP server that ignores signals could wedge dispose. Mitigation: the Cordis fiber disposal has bounded quiescence; a stuck transport eventually times out at the framework level.
- **Token budget pressure**: connecting many MCP servers with many tools inflates the system prompt. Mitigation: no different from registering many native tools; the compaction layer handles context pressure.
