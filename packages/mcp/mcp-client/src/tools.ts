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

/**
 * Sync the MCP server's tool list into the harness ToolRegistry.
 *
 * - Calls `client.listTools()` (paginated: drains all pages).
 * - Registers each tool as a raw `ToolDefinition`.
 * - On name conflict: logs a warning and skips that tool.
 * - Returns a disposer map; call each value to unregister.
 *
 * @param client - Connected MCP Client instance used to list and call tools.
 * @param ctx - Cordis context providing the `tools` service for registration.
 * @param opts - Bridge options: tool name prefix and per-call timeout.
 * @param previous - Disposer map from a prior sync generation; all entries are
 *   disposed before re-registering.
 * @returns A map of registered tool names to their unregister disposers.
 */
export async function syncTools(
  client: Client,
  ctx: Context,
  opts: ToolBridgeOptions,
  previous: ToolDisposers,
): Promise<ToolDisposers> {
  for (const dispose of previous.values()) dispose()

  const disposers: ToolDisposers = new Map()

  let cursor: string | undefined
  do {
    const response = await client.listTools(cursor ? { cursor } : undefined)
    for (const tool of response.tools) {
      const registeredName = opts.toolPrefix + tool.name
      const definition: ToolDefinition = {
        name: registeredName,
        description: tool.description ?? '',
        parameters: tool.inputSchema,
        execute: createExecutor(client, tool.name, opts),
      }
      try {
        const dispose = ctx.tools.register(definition)
        disposers.set(registeredName, dispose)
      } catch {
        // Name conflict — another tool with this name is already registered.
        ctx.logger.warn(`mcp-client: skipping tool "${registeredName}" (name conflict)`)
      }
    }
    cursor = response.nextCursor
  } while (cursor)

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
    const text = extractText(content, mcpToolName)

    // MCP isError → throw so ToolRegistry produces an isError result for the model.
    if ('isError' in result && result.isError === true) {
      throw new Error(text)
    }

    return [{ type: 'text', text }]
  }
}

/**
 * Extract text from an MCP content array into a single string.
 * - text blocks: join with '\n'
 * - image/audio/resource blocks: replaced with a placeholder
 *
 * Defensive: fields that the MCP spec declares required (mimeType, text) are
 * guarded with fallbacks because this is a network trust boundary.
 */
function extractText(mcpContent: McpContentBlock[], toolName: string): string {
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

  return parts.join('\n') || `(${toolName} returned no text content)`
}
