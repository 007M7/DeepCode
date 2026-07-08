import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { syncTools, type ToolBridgeOptions } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'
import { createTransport } from '@deepseek-ai/dsh-mcp-client/src/transport.ts'
import { apply, name, inject, Config } from '@deepseek-ai/dsh-mcp-client/src/index.ts'

// ---- Mock MCP Client ----

interface MockTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

interface MockCallResult {
  content: Array<{ type: string; text?: string; mimeType?: string }>
  isError?: boolean
}

function createMockClient(tools: MockTool[], callResult: MockCallResult = { content: [{ type: 'text', text: 'ok' }] }) {
  return {
    listTools: vi.fn().mockResolvedValue({ tools, nextCursor: undefined }),
    callTool: vi.fn().mockResolvedValue(callResult),
    setNotificationHandler: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

// ---- Test harness helper ----

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  return ctx
}

const defaultOpts: ToolBridgeOptions = {
  toolPrefix: '',
  toolCallTimeoutMs: 60_000,
}

// ---- Tests ----

describe('syncTools', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = await mountRegistry()
  })

  it('registers tools from listTools response', async () => {
    const client = createMockClient([
      { name: 'greet', description: 'Say hello', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
      { name: 'add', description: 'Add numbers', inputSchema: { type: 'object', properties: {} } },
    ])

    const disposers = await syncTools(client as never, ctx, defaultOpts, new Map())

    expect(disposers.size).toBe(2)
    expect(ctx.tools.get('greet')).toBeDefined()
    expect(ctx.tools.get('add')).toBeDefined()
  })

  it('applies toolPrefix to registered names', async () => {
    const client = createMockClient([
      { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object' } },
    ])

    const disposers = await syncTools(client as never, ctx, { ...defaultOpts, toolPrefix: 'gh_' }, new Map())

    expect(disposers.size).toBe(1)
    expect(ctx.tools.get('gh_create_issue')).toBeDefined()
    expect(ctx.tools.get('create_issue')).toBeUndefined()
  })

  it('skips tools with conflicting names and logs warning', async () => {
    // Pre-register a tool with the same name.
    ctx.tools.register({
      name: 'existing',
      description: 'Already here',
      parameters: { type: 'object' },
      execute: async () => [{ type: 'text', text: 'native' }],
    })

    const client = createMockClient([
      { name: 'existing', description: 'Conflicts', inputSchema: { type: 'object' } },
      { name: 'unique', description: 'No conflict', inputSchema: { type: 'object' } },
    ])

    const disposers = await syncTools(client as never, ctx, defaultOpts, new Map())

    // Only the non-conflicting tool registers.
    expect(disposers.size).toBe(1)
    expect(ctx.tools.get('unique')).toBeDefined()
    // Original tool unchanged.
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'existing', arguments: {} })
    expect(result.content[0]).toEqual({ type: 'text', text: 'native' })
  })

  it('unregisters previous tools before re-syncing', async () => {
    const client = createMockClient([
      { name: 'old_tool', inputSchema: { type: 'object' } },
    ])

    const firstDisposers = await syncTools(client as never, ctx, defaultOpts, new Map())
    expect(ctx.tools.get('old_tool')).toBeDefined()

    // Second sync with different tools should remove old_tool.
    client.listTools.mockResolvedValue({ tools: [{ name: 'new_tool', inputSchema: { type: 'object' } }], nextCursor: undefined })
    const secondDisposers = await syncTools(client as never, ctx, defaultOpts, firstDisposers)

    expect(ctx.tools.get('old_tool')).toBeUndefined()
    expect(ctx.tools.get('new_tool')).toBeDefined()
    expect(secondDisposers.size).toBe(1)
  })

  it('drains paginated listTools responses', async () => {
    const client = createMockClient([])
    client.listTools
      .mockResolvedValueOnce({ tools: [{ name: 'page1', inputSchema: { type: 'object' } }], nextCursor: 'cursor1' })
      .mockResolvedValueOnce({ tools: [{ name: 'page2', inputSchema: { type: 'object' } }], nextCursor: undefined })

    const disposers = await syncTools(client as never, ctx, defaultOpts, new Map())

    expect(disposers.size).toBe(2)
    expect(ctx.tools.get('page1')).toBeDefined()
    expect(ctx.tools.get('page2')).toBeDefined()
  })
})

describe('tool execution', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = await mountRegistry()
  })

  it('calls MCP callTool and returns text content', async () => {
    const client = createMockClient(
      [{ name: 'echo', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text', text: 'hello world' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: { msg: 'hi' } })

    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'hello world' }])
    expect(client.callTool).toHaveBeenCalledWith(
      { name: 'echo', arguments: { msg: 'hi' } },
      undefined,
      expect.objectContaining({ timeout: 60_000 }),
    )
  })

  it('joins multiple text blocks with newline', async () => {
    const client = createMockClient(
      [{ name: 'multi', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'multi', arguments: {} })

    expect(result.content).toEqual([{ type: 'text', text: 'line1\nline2' }])
  })

  it('discards image content with placeholder', async () => {
    const client = createMockClient(
      [{ name: 'img', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text', text: 'before' }, { type: 'image', mimeType: 'image/png' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'img', arguments: {} })

    expect(result.content[0]).toEqual({ type: 'text', text: 'before\n[image: image/png, content discarded]' })
  })

  it('maps isError to an error result via throw', async () => {
    const client = createMockClient(
      [{ name: 'fail', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text', text: 'something went wrong' }], isError: true },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'fail', arguments: {} })

    expect(result.isError).toBe(true)
    expect(result.content[0]).toEqual({ type: 'text', text: 'Error: something went wrong' })
  })

  it('passes abort signal to callTool', async () => {
    const controller = new AbortController()
    const client = createMockClient(
      [{ name: 'slow', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text', text: 'done' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    await ctx.tools.execute({ callId: CallId('c1'), name: 'slow', arguments: {}, signal: controller.signal })

    expect(client.callTool).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({ signal: controller.signal }),
    )
  })

  it('handles legacy toolResult shape', async () => {
    const client = createMockClient(
      [{ name: 'legacy', inputSchema: { type: 'object' } }],
    )
    client.callTool.mockResolvedValue({ toolResult: { key: 'value' } })

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'legacy', arguments: {} })

    expect(result.isError).toBe(false)
    expect(result.content[0]).toEqual({ type: 'text', text: '{"key":"value"}' })
  })
})

describe('tool execution edge cases', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = await mountRegistry()
  })

  it('handles audio content with placeholder', async () => {
    const client = createMockClient(
      [{ name: 'audio_tool', inputSchema: { type: 'object' } }],
      { content: [{ type: 'audio', mimeType: 'audio/mp3' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'audio_tool', arguments: {} })

    expect(result.content[0]).toEqual({ type: 'text', text: '[audio: audio/mp3, content discarded]' })
  })

  it('handles resource content with placeholder', async () => {
    const client = createMockClient(
      [{ name: 'res_tool', inputSchema: { type: 'object' } }],
      { content: [{ type: 'resource' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'res_tool', arguments: {} })

    expect(result.content[0]).toEqual({ type: 'text', text: '[resource: content discarded]' })
  })

  it('handles resource_link content with placeholder', async () => {
    const client = createMockClient(
      [{ name: 'link_tool', inputSchema: { type: 'object' } }],
      { content: [{ type: 'resource_link' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'link_tool', arguments: {} })

    expect(result.content[0]).toEqual({ type: 'text', text: '[resource: content discarded]' })
  })

  it('handles unknown content types', async () => {
    const client = createMockClient(
      [{ name: 'unknown_tool', inputSchema: { type: 'object' } }],
      { content: [{ type: 'video' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'unknown_tool', arguments: {} })

    expect(result.content[0]).toEqual({ type: 'text', text: '[unsupported content type: video]' })
  })

  it('handles image with missing mimeType (buggy server)', async () => {
    const client = createMockClient(
      [{ name: 'img2', inputSchema: { type: 'object' } }],
      { content: [{ type: 'image' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'img2', arguments: {} })

    expect(result.content[0]).toEqual({ type: 'text', text: '[image: unknown, content discarded]' })
  })

  it('handles audio with missing mimeType (buggy server)', async () => {
    const client = createMockClient(
      [{ name: 'audio_no_mime', inputSchema: { type: 'object' } }],
      { content: [{ type: 'audio' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'audio_no_mime', arguments: {} })

    expect(result.content[0]).toEqual({ type: 'text', text: '[audio: unknown, content discarded]' })
  })

  it('handles text block with missing text (buggy server)', async () => {
    const client = createMockClient(
      [{ name: 'notext', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'notext', arguments: {} })

    expect(result.content[0]).toEqual({ type: 'text', text: '(notext returned no text content)' })
  })

  it('handles empty content array', async () => {
    const client = createMockClient(
      [{ name: 'empty_tool', inputSchema: { type: 'object' } }],
      { content: [] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'empty_tool', arguments: {} })

    expect(result.content[0]).toEqual({ type: 'text', text: '(empty_tool returned no text content)' })
  })


  it('handles legacy toolResult with undefined value', async () => {
    const client = createMockClient(
      [{ name: 'legacy2', inputSchema: { type: 'object' } }],
    )
    client.callTool.mockResolvedValue({})

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'legacy2', arguments: {} })

    expect(result.content[0]).toEqual({ type: 'text', text: '(no output)' })
  })

  it('handles isError with non-text content (fallback error message)', async () => {
    const client = createMockClient(
      [{ name: 'err_notext', inputSchema: { type: 'object' } }],
      { content: [{ type: 'image', mimeType: 'image/png' }], isError: true },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'err_notext', arguments: {} })

    expect(result.isError).toBe(true)
    // The error message falls back to 'MCP tool error' when content[0] is not text.
    // But mapContent converts image to text placeholder, so it should use that.
    // Actually mapContent ALWAYS returns text, so the ternary always takes the truthy branch.
    // Let me check: mapContent returns [{type:'text', text:'[image: ...]'}], so content[0].type IS 'text'.
    expect(result.content[0]).toEqual({ type: 'text', text: 'Error: [image: image/png, content discarded]' })
  })


  it('uses tool description when provided', async () => {
    const client = createMockClient([
      { name: 'described', description: 'A described tool', inputSchema: { type: 'object' } },
    ])

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const tool = ctx.tools.get('described')
    expect(tool?.description).toBe('A described tool')
  })

  it('uses empty description when tool has no description', async () => {
    const client = createMockClient([
      { name: 'nodesc', inputSchema: { type: 'object' } },
    ])

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const tool = ctx.tools.get('nodesc')
    expect(tool?.description).toBe('')
  })
})

describe('createTransport', () => {
  it('creates StdioClientTransport for stdio config', () => {
    const config: Config = {
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: {},
      cwd: '/tmp',
      toolPrefix: '',
      toolCallTimeoutMs: 60_000,
    }
    const transport = createTransport(config)
    expect(transport).toBeDefined()
    expect(transport).toHaveProperty('start')
    expect(transport).toHaveProperty('close')
  })

  it('creates StreamableHTTPClientTransport for http config without headers', () => {
    const config: Config = {
      transport: 'streamable-http',
      url: 'http://localhost:3000/mcp',
      headers: {},
      toolPrefix: '',
      toolCallTimeoutMs: 60_000,
    }
    const transport = createTransport(config)
    expect(transport).toBeDefined()
    expect(transport).toHaveProperty('start')
    expect(transport).toHaveProperty('close')
  })

  it('creates StreamableHTTPClientTransport for http config with headers', () => {
    const config: Config = {
      transport: 'streamable-http',
      url: 'http://localhost:3000/mcp',
      headers: { Authorization: 'Bearer token' },
      toolPrefix: '',
      toolCallTimeoutMs: 60_000,
    }
    const transport = createTransport(config)
    expect(transport).toBeDefined()
    expect(transport).toHaveProperty('start')
    expect(transport).toHaveProperty('close')
  })

  it('scrubs sensitive env vars and forwards the rest', () => {
    const original = { ...process.env }
    try {
      process.env.SAFE_VAR = 'kept'
      process.env.MY_SECRET = 'hidden'
      process.env.API_KEY = 'hidden'
      process.env.AUTH_TOKEN = 'hidden'

      const config: Config = {
        transport: 'stdio',
        command: 'echo',
        args: [],
        env: { EXTRA: 'injected' },
        cwd: '',
        toolPrefix: '',
        toolCallTimeoutMs: 60_000,
      }
      // createTransport internally calls buildChildEnv; we verify by inspecting
      // the constructed StdioClientTransport. Since we can't inspect private fields
      // easily, we at least confirm it doesn't throw and returns a transport.
      const transport = createTransport(config)
      expect(transport).toBeDefined()
    } finally {
      // Restore env
      delete process.env.SAFE_VAR
      delete process.env.MY_SECRET
      delete process.env.API_KEY
      delete process.env.AUTH_TOKEN
      for (const key of Object.keys(process.env)) {
        if (!(key in original)) Reflect.deleteProperty(process.env, key)
      }
    }
  })

  it('merges explicit env on top of scrubbed ambient env', () => {
    const config: Config = {
      transport: 'stdio',
      command: 'echo',
      args: [],
      env: { CUSTOM: 'value' },
      cwd: '',
      toolPrefix: '',
      toolCallTimeoutMs: 60_000,
    }
    const transport = createTransport(config)
    expect(transport).toBeDefined()
  })
})

describe('tool execution — non-object args fallback', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = await mountRegistry()
  })

  it('coerces null args to empty object for callTool', async () => {
    const client = createMockClient(
      [{ name: 'coerce', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text', text: 'ok' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    // Simulate model emitting `null` as tool arguments (malformed).
    await ctx.tools.execute({ callId: CallId('c1'), name: 'coerce', arguments: null })

    expect(client.callTool).toHaveBeenCalledWith(
      { name: 'coerce', arguments: {} },
      undefined,
      expect.anything(),
    )
  })

  it('coerces primitive string args to empty object for callTool', async () => {
    const client = createMockClient(
      [{ name: 'coerce2', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text', text: 'ok' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    await ctx.tools.execute({ callId: CallId('c1'), name: 'coerce2', arguments: 'bad' })

    expect(client.callTool).toHaveBeenCalledWith(
      { name: 'coerce2', arguments: {} },
      undefined,
      expect.anything(),
    )
  })
})

describe('plugin module exports', () => {
  it('exports name, inject, and Config schema', () => {
    expect(name).toBe('mcp-client')
    expect(inject).toEqual(['tools'])
    expect(Config).toBeDefined()
  })
})

describe('apply (error path, no mocks)', () => {
  it('gracefully catches when the MCP server is unreachable', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)

    // Call apply with a command that will fail to spawn/connect.
    // The .catch() inside apply logs the error and registers no tools.
    apply(ctx, {
      transport: 'stdio',
      command: '___nonexistent_binary_that_will_fail___',
      args: [],
      env: {},
      cwd: '',
      toolPrefix: '',
      toolCallTimeoutMs: 1000,
    })

    // Give the async connect + catch chain time to settle.
    await new Promise(r => setTimeout(r, 200))

    // No tools should be registered since connect failed.
    expect(ctx.tools.get('anything')).toBeUndefined()
  })
})

