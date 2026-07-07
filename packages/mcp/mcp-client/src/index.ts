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

export function apply(ctx: Context, config: Config): void {
  const transport = createTransport(config)
  const client = new Client(
    { name: 'dsh-mcp-client', version: '0.0.1' },
    { capabilities: {} },
  )

  // Connect and set up tools. Errors during connect are logged, not thrown
  // (the plugin simply has no tools registered).
  const ready = (async () => {
    await client.connect(transport)

    let disposers = await syncTools(client, ctx, {
      toolPrefix: config.toolPrefix,
      toolCallTimeoutMs: config.toolCallTimeoutMs,
    }, new Map())

    client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      async () => {
        ctx.logger.info('mcp-client: tool list changed, re-syncing')
        disposers = await syncTools(client, ctx, {
          toolPrefix: config.toolPrefix,
          toolCallTimeoutMs: config.toolCallTimeoutMs,
        }, disposers)
      },
    )

    return disposers
  })().catch((error: unknown) => {
    ctx.logger.error(`mcp-client: failed to connect: ${String(error)}`)
    return new Map<string, () => void>()
  })

  ctx.effect(() => async () => {
    const disposers = await ready
    for (const dispose of disposers.values()) dispose()
    try { await client.close() } catch { /* transport already gone */ }
  }, 'mcp-client.connection')
}
