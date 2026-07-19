# @deepseek-ai/dsh-mcp-client

MCP client bridge plugin: connects to external [Model Context Protocol](https://modelcontextprotocol.io/) servers and registers their tools on `ctx.tools`, making them available to the model as native tools under server-qualified names (`mcp__<serverName>__<rawName>`).

## Usage

One plugin instance per MCP server in `cordis.yml`:

```yaml
- id: mcp-github
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: github
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN

- id: mcp-web
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: web
    transport: streamable-http
    url: http://localhost:3000/mcp
    headers:
      Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'
```

The model sees `mcp__github__create_issue`, `mcp__web__search`, … — the same server-qualified shape Claude Code and Codex use. HMR hot-swaps: editing the entry triggers disconnect + reconnect without process restart; an unchanged `serverName` reproduces identical tool names.

## Config

| Field | Transport | Required | Description |
|---|---|---|---|
| `transport` | both | yes | `"stdio"` or `"streamable-http"` |
| `serverName` | both | yes | Namespace for this server's model-facing tool names; `[A-Za-z0-9_-]{1,32}`, unique across live instances |
| `command` | stdio | yes | Executable to spawn |
| `args` | stdio | no | Arguments passed to the command |
| `env` | stdio | no | Extra env vars merged on top of scrubbed ambient env |
| `cwd` | stdio | no | Working directory for the child process |
| `url` | http | yes | MCP server URL |
| `headers` | http | no | Extra headers (e.g. auth tokens) |
| `toolCallTimeoutMs` | both | no | Timeout per `callTool` invocation (default 60000) |

## Tool naming

Every MCP tool has two names: the raw MCP name (sent on the wire in `tools/call`) and the public name `mcp__<serverName>__<rawName>` registered on `ctx.tools`. Public names are normalized to the DeepSeek function-name contract (64 chars, `[A-Za-z0-9_-]`); when replacement or truncation changes the name, a deterministic 12-hex-char hash of `(serverName, rawName)` is appended so distinct tools never collapse into one name. Names are pure functions of `(serverName, rawName)` — connection order, re-syncs, and other servers never rename a tool.

- Two servers publishing the same raw name (e.g. `search`) coexist under their namespaces.
- A duplicate `serverName` across live instances fails the later plugin instance at load.
- A server listing the same tool name twice is rejected as an invalid tool list.
- A foreign registration squatting on this server's namespace rolls back the whole generation (never a partial set), with a loud error.

## Behavior

- On connect: `listTools()` → registers each tool via `ctx.tools.register()` under its public name.
- Listens for `notifications/tools/list_changed` → re-syncs; a failed re-sync keeps the previous generation registered.
- Tool execute: `client.callTool({ name: rawName, arguments }, { signal })` with timeout + abort support — the public name is never sent to the server.
- Image content in results is discarded with a placeholder (the harness has no image block type).
- On disconnect/crash: all tools are unregistered; no auto-reconnect.

## Services consumed

| Service | Usage |
|---|---|
| `ctx.tools` | Register/unregister MCP tools |

## Model Experience

### Discovered MCP tools

#### What the model sees

After initial discovery succeeds, each advertised MCP tool appears as a native tool named `mcp__<serverName>__<rawName>` (or its deterministic normalized form), with the server-provided description and input schema. A successful re-sync replaces the generation; plugin disposal removes it.

#### Token effect

Data-dependent schema cost is paid on every request while the tools are registered. Re-sync replaces rather than accumulates schemas, and the server-qualified name adds tokens to every tool definition and call.

#### KV Cache effect

Prefix-stable while the discovered tool set and schemas are unchanged. A re-sync that adds, removes, renames, or changes a tool replaces definitions and may invalidate reuse from the first changed schema token.

### Tool-call history and results

#### What the model sees

The public tool name and JSON arguments remain in assistant history. Text result blocks are joined with newlines into one retained text result; image, audio, resource, and unsupported blocks become short placeholders, and MCP `isError` results follow the registry's model-visible error path.

#### Token effect

Arguments and mapped text are retained until compaction. Binary and resource payloads are discarded rather than added to context.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Initial discovery is asynchronous** — plugin load does not wait for connection and `listTools()`, so a turn started immediately after boot or HMR can assemble before the MCP tools are registered.
- **Tools are the only bridged MCP capability** — Resources and Prompts have no harness consumption surface and are deferred.
- **Crash recovery is manual** — transport closure unregisters the server's tools, but reconnect requires an HMR reload or harness restart.
- **Non-text results are lossy** — image, audio, and resource payloads are replaced with placeholders, and a structured-only result has no model-visible structured representation.
