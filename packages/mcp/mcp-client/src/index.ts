/**
 * MCP client bridge plugin: connects to an external MCP server and registers
 * its tools on `ctx.tools`. Each plugin instance connects to one MCP server;
 * load multiple instances in `cordis.yml` for multiple servers.
 *
 * Namespace plugin (named exports, no default export). Lifecycle is
 * effect-scoped: disposal disconnects from the server and unregisters all
 * tools. HMR hot-swaps by disposing the old instance and creating a new one.
 *
 * @module @deepseek-ai/dsh-mcp-client
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { createTransport } from './transport.ts'
import { syncTools } from './tools.ts'
// Side-effect type import: declaration-merges `ctx.tools` onto Context.
import type {} from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-client'

/** Services required by this plugin. */
export const inject = ['tools']

/** Default timeout for individual MCP tool calls (ms). */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

// ---- Config ----

/** Config for connecting to an MCP server via a spawned child process over stdio. */
export interface StdioConfig {
  /** Transport type: spawn a child process and communicate over stdio. */
  transport: 'stdio'
  /** Executable to spawn. */
  command: string
  /** Arguments passed to the command. */
  args: string[]
  /** Extra env vars merged on top of scrubbed ambient env. */
  env: Record<string, string>
  /** Working directory for the child process. */
  cwd: string
  /** Prefix prepended to each tool name before registration. */
  toolPrefix: string
  /** Timeout per callTool invocation (ms). */
  toolCallTimeoutMs: number
}

/** Config for connecting to an MCP server over Streamable HTTP (SSE). */
export interface StreamableHttpConfig {
  /** Transport type: connect to an MCP server over Streamable HTTP (SSE). */
  transport: 'streamable-http'
  /** MCP server URL. */
  url: string
  /** Extra headers (e.g. auth tokens). */
  headers: Record<string, string>
  /** Prefix prepended to each tool name before registration. */
  toolPrefix: string
  /** Timeout per callTool invocation (ms). */
  toolCallTimeoutMs: number
}

/** Discriminated union of all supported MCP transport configurations. */
export type Config = StdioConfig | StreamableHttpConfig

export const Config = z.union([
  z.object({
    transport: z.const('stdio'),
    command: z.string().required(),
    args: z.array(String).default([]),
    env: z.dict(String).default({}),
    cwd: z.string().default(''),
    toolPrefix: z.string().default(''),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  }),
  z.object({
    transport: z.const('streamable-http'),
    url: z.string().required(),
    headers: z.dict(String).default({}),
    toolPrefix: z.string().default(''),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  }),
]) as unknown as z<Config>

// ---- Plugin apply ----

/** Mutable state shared between the async connect path, notification handler, and disposers. */
interface PluginState {
  /** Current generation of tool disposers (keyed by registered name). */
  disposers: Map<string, () => void>
  /** Whether a syncTools call is currently in-flight. */
  syncing: boolean
  /** Whether another tools/list_changed arrived while syncing (coalesce flag). */
  pendingResync: boolean
}

export function apply(ctx: Context, config: Config): void {
  const transport = createTransport(config)
  const client = new Client(
    { name: 'dsh-mcp-client', version: '0.0.1' },
    { capabilities: {} },
  )

  const state: PluginState = { disposers: new Map(), syncing: false, pendingResync: false }

  const opts = { toolPrefix: config.toolPrefix, toolCallTimeoutMs: config.toolCallTimeoutMs }

  /** Dispose all currently registered tools. */
  function disposeTools(): void {
    for (const dispose of state.disposers.values()) dispose()
    state.disposers = new Map()
  }

  /** Run syncTools with latest-wins coalescing. */
  async function resync(): Promise<void> {
    if (state.syncing) {
      state.pendingResync = true
      return
    }
    state.syncing = true
    try {
      state.disposers = await syncTools(client, ctx, opts, state.disposers)
    } finally {
      state.syncing = false
    }
    // If another notification arrived while we were syncing, run once more.
    if (state.pendingResync) {
      state.pendingResync = false
      await resync()
    }
  }

  // When the connection closes (server crash or intentional close), unregister
  // all tools so the model no longer sees them in the system prompt.
  client.onclose = () => {
    disposeTools()
    ctx.logger.info('mcp-client: connection closed, tools unregistered')
  }

  // Connect and set up tools. Errors during connect are logged, not thrown
  // (the plugin simply has no tools registered). The IIFE is fire-and-forget;
  // disposal closes the client directly without waiting for startup.
  void (async () => {
    await client.connect(transport)
    await resync()

    client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      async () => {
        ctx.logger.info('mcp-client: tool list changed, re-syncing')
        await resync()
      },
    )
  })().catch((error: unknown) => {
    ctx.logger.error(`mcp-client: failed to connect: ${String(error)}`)
  })

  // Fiber disposal: close the client immediately (triggers onclose → tools
  // unregistered). No `await ready` — if connect is still pending, close aborts
  // it promptly rather than blocking until the SDK request times out.
  ctx.effect(() => async () => {
    try { await client.close() } catch { /* transport already gone or never connected */ }
  }, 'mcp-client.connection')
}
