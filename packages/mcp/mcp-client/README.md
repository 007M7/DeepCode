# @deepseek-ai/dsh-mcp-client

MCP client bridge plugin: connects to external [Model Context Protocol](https://modelcontextprotocol.io/) servers and registers their tools on `ctx.tools`, making them available to the model as native tools.

## Usage

One plugin instance per MCP server in `cordis.yml`:

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
      Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'
```

HMR hot-swaps: editing the entry triggers disconnect + reconnect without process restart.

## Config

| Field | Transport | Required | Description |
|---|---|---|---|
| `transport` | both | yes | `"stdio"` or `"streamable-http"` |
| `command` | stdio | yes | Executable to spawn |
| `args` | stdio | no | Arguments passed to the command |
| `env` | stdio | no | Extra env vars merged on top of scrubbed ambient env |
| `cwd` | stdio | no | Working directory for the child process |
| `url` | http | yes | MCP server URL |
| `headers` | http | no | Extra headers (e.g. auth tokens) |
| `toolPrefix` | both | no | Prefix prepended to each tool name before registration |
| `toolCallTimeoutMs` | both | no | Timeout per `callTool` invocation (default 60000) |

## Behavior

- On connect: `listTools()` → registers each tool via `ctx.tools.register()`.
- Listens for `notifications/tools/list_changed` → re-syncs tool registrations.
- Tool execute: `client.callTool({ name, arguments }, { signal })` with timeout + abort support.
- Image content in results is discarded with a warning (the harness has no image block type).
- On disconnect/crash: all tools are unregistered; no auto-reconnect.
- Name conflicts: if a tool name collides, it is skipped with a warning. Use `toolPrefix` to disambiguate.

## Services consumed

| Service | Usage |
|---|---|
| `ctx.tools` | Register/unregister MCP tools |
