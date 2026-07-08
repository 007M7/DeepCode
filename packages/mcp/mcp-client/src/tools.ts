/**
 * Tool bridge: discovers MCP tools, registers them on the harness ToolRegistry,
 * and handles re-sync when the server's tool list changes.
 *
 * @module
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Context } from 'cordis'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'

/** Resolved options relevant to tool bridging. */
export interface ToolBridgeOptions {
  toolPrefix: string
  toolCallTimeoutMs: number
}

/** State for one sync generation: the current set of disposers keyed by tool name. */
type ToolDisposers = Map<string, () => void>

/** A tool fetched from the MCP server, pending registration. */
interface FetchedTool {
  registeredName: string
  definition: ToolDefinition
}

/**
 * Sync the MCP server's tool list into the harness ToolRegistry.
 *
 * Two-phase approach: fetch all pages first (no side effects), then dispose old
 * tools and register new ones. If fetching fails, the previous generation stays
 * intact — no tools are lost on a transient listTools failure.
 *
 * @param client - Connected MCP Client instance used to list and call tools.
 * @param ctx - Cordis context providing the `tools` service for registration.
 * @param opts - Bridge options: tool name prefix and per-call timeout.
 * @param previous - Disposer map from a prior sync generation; disposed only
 *   after all pages are successfully fetched.
 * @returns A map of registered tool names to their unregister disposers.
 */
export async function syncTools(
  client: Client,
  ctx: Context,
  opts: ToolBridgeOptions,
  previous: ToolDisposers,
): Promise<ToolDisposers> {
  // Phase 1: fetch all tools (no mutations).
  const fetched: FetchedTool[] = []
  let cursor: string | undefined
  do {
    const response = await client.listTools(cursor ? { cursor } : undefined)
    for (const tool of response.tools) {
      const registeredName = opts.toolPrefix + tool.name
      fetched.push({
        registeredName,
        definition: {
          name: registeredName,
          description: tool.description ?? '',
          parameters: tool.inputSchema,
          execute: createExecutor(client, tool.name, opts),
        },
      })
    }
    cursor = response.nextCursor
  } while (cursor)

  // Phase 2: dispose previous generation, then register new tools.
  // If we reach here, all pages were fetched successfully.
  for (const dispose of previous.values()) dispose()

  const disposers: ToolDisposers = new Map()
  for (const { registeredName, definition } of fetched) {
    try {
      const dispose = ctx.tools.register(definition)
      disposers.set(registeredName, dispose)
    } catch {
      ctx.logger.warn(`mcp-client: skipping tool "${registeredName}" (name conflict)`)
    }
  }

  return disposers
}

/**
 * The shape we read from each MCP content block. Intentionally looser than the
 * SDK's `ContentBlock` type: we're at a network trust boundary (data arrives
 * from an external MCP server process via JSON-RPC), so fields that the SDK
 * declares required may be absent at runtime if the server is buggy.
 */
interface McpContentBlock {
  type: string
  text?: string
  mimeType?: string
}

/**
 * Create an execute function for one MCP tool. The executor calls
 * `client.callTool` with abort signal and timeout, then maps the result
 * to harness ContentBlocks.
 *
 * When the MCP server returns `isError: true`, the executor throws so that
 * the ToolRegistry's catch path produces an `isError` result for the model.
 */
function createExecutor(
  client: Client,
  mcpToolName: string,
  opts: ToolBridgeOptions,
): ToolDefinition['execute'] {
  return async (args: unknown, exec: ToolExecution) => {
    // The agent loop passes `JSON.parse(model_arguments)` which is usually an
    // object, but can be any JSON value if the model misbehaves (outputs a bare
    // string/number/null). Fallback to {} lets the MCP server produce a
    // specific "missing required param" error the model can learn from.
    const argsObj = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
    const result = await client.callTool(
      { name: mcpToolName, arguments: argsObj },
      undefined,
      {
        ...exec.signal ? { signal: exec.signal } : {},
        timeout: opts.toolCallTimeoutMs,
      },
    )

    // The SDK may return a legacy `toolResult` shape; normalize to content array.
    if (!('content' in result) || !Array.isArray(result.content)) {
      const text = 'toolResult' in result
        ? JSON.stringify(result.toolResult)
        : '(no output)'
      return [{ type: 'text' as const, text }]
    }

    // Trust boundary: the SDK's return type erases to `any[]` due to the
    // union of CallToolResult | CompatibilityCallToolResult. We process each
    // element defensively in extractText (reading only .type/.text/.mimeType
    // with optional fallbacks).
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const content: McpContentBlock[] = result.content
    let text = extractText(content, mcpToolName)

    // MCP tools with outputSchema may return structuredContent with an empty
    // content array. Surface the structured payload as JSON so the model sees
    // the actual result.
    if (!text && 'structuredContent' in result && result.structuredContent != null) {
      text = JSON.stringify(result.structuredContent)
    }

    // MCP isError → throw so ToolRegistry produces an isError result for the model.
    if ('isError' in result && result.isError === true) {
      throw new Error(text || 'MCP tool error')
    }

    return [{ type: 'text', text: text || `(${mcpToolName} returned no content)` }]
  }
}

/**
 * Extract text from an MCP content array into a single string.
 * - text blocks: join with '\n'
 * - image/audio/resource blocks: replaced with a placeholder
 *
 * Defensive: fields that the MCP spec declares required (mimeType, text) are
 * guarded with fallbacks because this is a network trust boundary.
 *
 * Returns empty string when no text parts were extracted (caller decides
 * fallback — e.g. structuredContent).
 */
function extractText(mcpContent: McpContentBlock[], _toolName: string): string {
  const parts: string[] = []

  for (const block of mcpContent) {
    switch (block.type) {
      case 'text':
        if (block.text !== undefined) parts.push(block.text)
        break
      case 'image':
        parts.push(`[image: ${block.mimeType ?? 'unknown'}, content discarded]`)
        break
      case 'audio':
        parts.push(`[audio: ${block.mimeType ?? 'unknown'}, content discarded]`)
        break
      case 'resource':
      case 'resource_link':
        parts.push('[resource: content discarded]')
        break
      default:
        parts.push(`[unsupported content type: ${block.type}]`)
    }
  }

  return parts.join('\n')
}
