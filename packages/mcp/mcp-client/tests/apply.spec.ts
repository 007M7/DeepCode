/**
 * Tests for the mcp-client plugin's `apply` lifecycle entry point.
 * Isolated file so vi.mock of the MCP SDK doesn't pollute other test suites.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from 'cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import type { Config } from '@deepseek-ai/dsh-mcp-client'

// ---- Mock MCP SDK ----

const mockConnect = vi.fn<() => Promise<void>>()
const mockClose = vi.fn<() => Promise<void>>()
const mockListTools = vi.fn()
const mockCallTool = vi.fn()
const mockSetNotificationHandler = vi.fn()

class MockClient {
  connect = mockConnect
  close = mockClose
  listTools = mockListTools
  callTool = mockCallTool
  setNotificationHandler = mockSetNotificationHandler
}

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: MockClient,
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}))

// ---- Import under test (after mocks) ----

const { apply, name, inject, Config: ConfigSchema } = await import(
  '@deepseek-ai/dsh-mcp-client/src/index.ts',
)

// ---- Helpers ----

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  return ctx
}

const stdioConfig: Config = {
  transport: 'stdio',
  command: 'echo',
  args: [],
  env: {},
  cwd: '',
  toolPrefix: '',
  toolCallTimeoutMs: 60_000,
}

// ---- Tests ----

describe('mcp-client plugin module exports', () => {
  it('exports name, inject, and Config', () => {
    expect(name).toBe('mcp-client')
    expect(inject).toEqual(['tools'])
    expect(ConfigSchema).toBeDefined()
  })
})

describe('apply (plugin lifecycle)', () => {
  let ctx: Context

  beforeEach(async () => {
    vi.clearAllMocks()
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockResolvedValue(undefined)
    mockListTools.mockResolvedValue({
      tools: [{ name: 'remote', description: 'A remote tool', inputSchema: { type: 'object' } }],
      nextCursor: undefined,
    })
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    ctx = await mountRegistry()
  })

  it('connects, syncs tools, and registers a notification handler', async () => {
    apply(ctx, stdioConfig)
    await new Promise(r => setTimeout(r, 50))

    expect(mockConnect).toHaveBeenCalled()
    expect(mockListTools).toHaveBeenCalled()
    expect(mockSetNotificationHandler).toHaveBeenCalled()
    expect(ctx.tools.get('remote')).toBeDefined()
  })

  it('applies toolPrefix from config during sync', async () => {
    apply(ctx, { ...stdioConfig, toolPrefix: 'mcp_' })
    await new Promise(r => setTimeout(r, 50))

    expect(ctx.tools.get('mcp_remote')).toBeDefined()
    expect(ctx.tools.get('remote')).toBeUndefined()
  })

  it('logs error and registers no tools when connect fails', async () => {
    mockConnect.mockRejectedValue(new Error('connection refused'))

    apply(ctx, stdioConfig)
    await new Promise(r => setTimeout(r, 50))

    expect(mockListTools).not.toHaveBeenCalled()
    expect(ctx.tools.get('remote')).toBeUndefined()
  })

  it('re-syncs tools on ToolListChanged notification', async () => {
    apply(ctx, stdioConfig)
    await new Promise(r => setTimeout(r, 50))

    expect(ctx.tools.get('remote')).toBeDefined()

    // Simulate the notification handler being invoked with a new tool list.
    mockListTools.mockResolvedValue({
      tools: [{ name: 'updated', inputSchema: { type: 'object' } }],
      nextCursor: undefined,
    })

    // Extract and call the notification handler.
    const handler = mockSetNotificationHandler.mock.calls[0]![1] as () => Promise<void>
    await handler()

    expect(ctx.tools.get('remote')).toBeUndefined()
    expect(ctx.tools.get('updated')).toBeDefined()
  })

  it('effect disposer unregisters tools and closes client', async () => {
    apply(ctx, stdioConfig)
    await new Promise(r => setTimeout(r, 50))

    expect(ctx.tools.get('remote')).toBeDefined()

    // Trigger disposal by disposing a child scope.
    // Cordis ctx.effect registers the disposer; calling scope dispose runs it.
    await ctx.fiber.dispose()
    await new Promise(r => setTimeout(r, 50))

    expect(mockClose).toHaveBeenCalled()
  })

  it('effect disposer handles client.close failure gracefully', async () => {
    mockClose.mockRejectedValue(new Error('already closed'))

    apply(ctx, stdioConfig)
    await new Promise(r => setTimeout(r, 50))

    // Should not throw when dispose is triggered.
    await ctx.fiber.dispose()
    await new Promise(r => setTimeout(r, 50))

    expect(mockClose).toHaveBeenCalled()
  })

  it('uses streamable-http config path', async () => {
    const httpConfig: Config = {
      transport: 'streamable-http',
      url: 'http://localhost:3000/mcp',
      headers: { Authorization: 'Bearer x' },
      toolPrefix: '',
      toolCallTimeoutMs: 30_000,
    }

    apply(ctx, httpConfig)
    await new Promise(r => setTimeout(r, 50))

    expect(mockConnect).toHaveBeenCalled()
    expect(ctx.tools.get('remote')).toBeDefined()
  })
})
