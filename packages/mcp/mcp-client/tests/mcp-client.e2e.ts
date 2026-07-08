/**
 * End-to-end tests for dsh-mcp-client. Exercises the REAL MCP protocol over
 * stdio transport against:
 * 1. A self-written fixture server (controlled edge cases)
 * 2. @modelcontextprotocol/server-everything (official integration test server)
 * 3. @modelcontextprotocol/server-filesystem (real filesystem operations)
 *
 * No API key needed — all servers are local/keyless.
 */

import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Config } from '@deepseek-ai/dsh-mcp-client'

const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
const fixtureServerPath = fileURLToPath(new URL('./fixture-server.ts', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

// Resolve package-local .bin for pnpm-hoisted MCP server binaries.
const packageDir = fileURLToPath(new URL('..', import.meta.url))
const localBin = join(packageDir, 'node_modules', '.bin')

// ---- Helpers ----

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  return ctx
}

/** Apply the MCP client plugin and wait for tools to be registered. */
async function applyAndWait(ctx: Context, config: Config, timeoutMs = 20_000): Promise<void> {
  const { apply } = await import('@deepseek-ai/dsh-mcp-client/src/index.ts')
  const toolsReady = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => { reject(new Error(`applyAndWait timed out after ${timeoutMs}ms — no tools/change event`)) },
      timeoutMs,
    )
    ctx.on('tools/change', () => { clearTimeout(timer); resolve() })
  })
  apply(ctx, config)
  await toolsReady
}

let callSeq = 0
function nextCallId(): CallId {
  return CallId(`e2e-${++callSeq}`)
}

// ---- Fixture server tests ----

describe('fixture server — controlled scenarios', () => {
  let ctx: Context

  const fixtureConfig: Config = {
    transport: 'stdio',
    command: process.execPath,
    args: ['--import', tsxLoader, fixtureServerPath],
    env: { TSX_TSCONFIG_PATH: repoTsconfig },
    cwd: packageDir,
    toolPrefix: '',
    toolCallTimeoutMs: 15_000,
  }

  beforeAll(async () => {
    ctx = await mountRegistry()
    await applyAndWait(ctx, fixtureConfig)
  }, 30_000)

  afterAll(async () => {
    if (ctx) await ctx.fiber.dispose()
    await new Promise(r => setTimeout(r, 200))
  })

  it('discovers all fixture tools', () => {
    const schemas = ctx.tools.schemas()
    const names = schemas.map(s => s.name)
    expect(names).toContain('add')
    expect(names).toContain('greet')
    expect(names).toContain('fail')
    expect(names).toContain('image')
  })

  it('executes add(2, 3) → "5"', async () => {
    const result = await ctx.tools.execute({
      callId: nextCallId(), name: 'add', arguments: { a: 2, b: 3 },
    })
    expect(result.isError).toBe(false)
    expect(result.content[0]).toEqual({ type: 'text', text: '5' })
  })

  it('executes greet("World") → "Hello, World!"', async () => {
    const result = await ctx.tools.execute({
      callId: nextCallId(), name: 'greet', arguments: { name: 'World' },
    })
    expect(result.isError).toBe(false)
    expect(result.content[0]).toEqual({ type: 'text', text: 'Hello, World!' })
  })

  it('executes fail() → isError result', async () => {
    const result = await ctx.tools.execute({
      callId: nextCallId(), name: 'fail', arguments: {},
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ type: 'text' })
  })

  it('executes image() → image placeholder', async () => {
    const result = await ctx.tools.execute({
      callId: nextCallId(), name: 'image', arguments: {},
    })
    expect(result.isError).toBe(false)
    const text = (result.content[0] as { type: string; text: string }).text
    expect(text).toContain('Here is an image:')
    expect(text).toContain('[image: image/png, content discarded]')
    expect(text).toContain('End of image.')
  })
})

describe('fixture server — toolPrefix', () => {
  let ctx: Context

  beforeAll(async () => {
    ctx = await mountRegistry()
    await applyAndWait(ctx, {
      transport: 'stdio',
      command: process.execPath,
      args: ['--import', tsxLoader, fixtureServerPath],
      env: { TSX_TSCONFIG_PATH: repoTsconfig },
      cwd: packageDir,
      toolPrefix: 'fx_',
      toolCallTimeoutMs: 15_000,
    })
  }, 30_000)

  afterAll(async () => {
    if (ctx) await ctx.fiber.dispose()
    await new Promise(r => setTimeout(r, 200))
  })

  it('registers tools with prefix', () => {
    expect(ctx.tools.get('fx_add')).toBeDefined()
    expect(ctx.tools.get('fx_greet')).toBeDefined()
    expect(ctx.tools.get('add')).toBeUndefined()
  })

  it('executes prefixed tool', async () => {
    const result = await ctx.tools.execute({
      callId: nextCallId(), name: 'fx_add', arguments: { a: 10, b: 20 },
    })
    expect(result.content[0]).toEqual({ type: 'text', text: '30' })
  })
})

describe('fixture server — disposal', () => {
  it('disposes cleanly without error', async () => {
    const ctx = await mountRegistry()
    await applyAndWait(ctx, {
      transport: 'stdio',
      command: process.execPath,
      args: ['--import', tsxLoader, fixtureServerPath],
      env: { TSX_TSCONFIG_PATH: repoTsconfig },
      cwd: packageDir,
      toolPrefix: '',
      toolCallTimeoutMs: 15_000,
    })

    // Tools are registered before dispose.
    expect(ctx.tools.get('add')).toBeDefined()
    expect(ctx.tools.schemas().length).toBeGreaterThanOrEqual(4)

    // Dispose should complete without throwing.
    await ctx.fiber.dispose()
    await new Promise(r => setTimeout(r, 200))
  }, 30_000)
})

// ---- @modelcontextprotocol/server-everything ----

describe('server-everything — official test server', () => {
  let ctx: Context

  const config: Config = {
    transport: 'stdio',
    command: join(localBin, 'mcp-server-everything'),
    args: ['stdio'],
    env: {},
    cwd: '',
    toolPrefix: '',
    toolCallTimeoutMs: 30_000,
  }

  beforeAll(async () => {
    ctx = await mountRegistry()
    await applyAndWait(ctx, config)
  }, 60_000)

  afterAll(async () => {
    if (ctx) await ctx.fiber.dispose()
    await new Promise(r => setTimeout(r, 500))
  })

  it('discovers tools from server-everything', () => {
    const schemas = ctx.tools.schemas()
    const names = schemas.map(s => s.name)
    expect(names).toContain('echo')
    expect(names).toContain('get-sum')
    expect(names).toContain('get-tiny-image')
    expect(names.length).toBeGreaterThanOrEqual(8)
  })

  it('executes echo({ message: "hello" }) → "Echo: hello"', async () => {
    const result = await ctx.tools.execute({
      callId: nextCallId(), name: 'echo', arguments: { message: 'hello' },
    })
    expect(result.isError).toBe(false)
    const text = (result.content[0] as { type: string; text: string }).text
    expect(text).toBe('Echo: hello')
  })

  it('executes get-sum({ a: 3, b: 7 }) → contains "10"', async () => {
    const result = await ctx.tools.execute({
      callId: nextCallId(), name: 'get-sum', arguments: { a: 3, b: 7 },
    })
    expect(result.isError).toBe(false)
    const text = (result.content[0] as { type: string; text: string }).text
    expect(text).toContain('10')
  })

  it('executes get-tiny-image → image placeholder', async () => {
    const result = await ctx.tools.execute({
      callId: nextCallId(), name: 'get-tiny-image', arguments: {},
    })
    expect(result.isError).toBe(false)
    const text = (result.content[0] as { type: string; text: string }).text
    expect(text).toContain('[image: image/png, content discarded]')
  })
})

// ---- @modelcontextprotocol/server-filesystem ----

describe('server-filesystem — real filesystem operations', () => {
  let ctx: Context
  let tempDir: string

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mcp-fs-e2e-'))

    ctx = await mountRegistry()
    const config: Config = {
      transport: 'stdio',
      command: join(localBin, 'mcp-server-filesystem'),
      args: [tempDir],
      env: {},
      cwd: '',
      toolPrefix: '',
      toolCallTimeoutMs: 30_000,
    }
    await applyAndWait(ctx, config)
  }, 60_000)

  afterAll(async () => {
    if (ctx) await ctx.fiber.dispose()
    await new Promise(r => setTimeout(r, 500))
    await rm(tempDir, { recursive: true, force: true })
  })

  it('discovers filesystem tools', () => {
    const schemas = ctx.tools.schemas()
    const names = schemas.map(s => s.name)
    expect(names).toContain('read_file')
    expect(names).toContain('write_file')
    expect(names).toContain('list_directory')
  })

  it('write_file + read_file round-trip', async () => {
    const filePath = join(tempDir, 'test.txt')
    const content = 'Hello from MCP e2e test!'

    // Write via MCP tool
    const writeResult = await ctx.tools.execute({
      callId: nextCallId(), name: 'write_file', arguments: { path: filePath, content },
    })
    expect(writeResult.isError).toBe(false)

    // Verify file was actually written (world verification)
    const onDisk = await readFile(filePath, 'utf8')
    expect(onDisk).toBe(content)

    // Read back via MCP tool
    const readResult = await ctx.tools.execute({
      callId: nextCallId(), name: 'read_file', arguments: { path: filePath },
    })
    expect(readResult.isError).toBe(false)
    const text = (readResult.content[0] as { type: string; text: string }).text
    expect(text).toContain(content)
  })

  it('list_directory shows written file', async () => {
    // Ensure a file exists
    await writeFile(join(tempDir, 'listed.txt'), 'listed')

    const result = await ctx.tools.execute({
      callId: nextCallId(), name: 'list_directory', arguments: { path: tempDir },
    })
    expect(result.isError).toBe(false)
    const text = (result.content[0] as { type: string; text: string }).text
    expect(text).toContain('listed.txt')
  })
})
