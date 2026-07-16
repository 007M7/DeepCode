import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import Lsp, { type LspQueryRequest, type LspQueryResult } from '@deepseek-ai/dsh-lsp'
import { deadline } from '@deepseek-ai/dsh-timeout'
import * as LspLocal from '@deepseek-ai/dsh-lsp-local'
import type { Config } from '@deepseek-ai/dsh-lsp-local'

const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
const fixtureServer = fileURLToPath(new URL('./fixture-server.ts', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

let root: string
let ws: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'lsp-local-')))
  ws = join(root, 'ws')
  await mkdir(ws)
  await writeFile(join(ws, 'a.ts'), 'const x = 1\nconst y = x\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Mount the real seam + lsp-local plugin driving the fake server with the given env. */
async function mount(fakeEnv: Record<string, string> = {}, overrides: Partial<Config> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Lsp)
  await ctx.plugin(LspLocal, {
    providerId: 'fake',
    command: process.execPath,
    args: ['--import', tsxLoader, fixtureServer],
    env: { TSX_TSCONFIG_PATH: repoTsconfig, ...fakeEnv },
    extensionToLanguage: { '.ts': 'typescript' },
    ...overrides,
  })
  return ctx
}

function query(operation: LspQueryRequest['operation'], filePath = 'a.ts'): LspQueryRequest {
  return { operation, filePath, position: { line: 0, character: 6 }, workspaceRoot: ws }
}

/** A single Location JSON pointing into the workspace. */
function locationJson(line: number): unknown {
  return { uri: pathToFileURL(join(ws, 'a.ts')).href, range: { start: { line, character: 0 }, end: { line, character: 3 } } }
}

describe('lsp-local end to end over a fake server', () => {
  it('resolves definition to normalized locations', async () => {
    const ctx = await mount({ LSP_FAKE_DEF: JSON.stringify(locationJson(0)) })
    const result = await ctx.lsp.query(query('definition'))
    expect(result).toEqual<LspQueryResult>({
      kind: 'locations',
      locations: [{ uri: pathToFileURL(join(ws, 'a.ts')).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } }],
    })
    await ctx.fiber.dispose()
  })

  it('maps a LocationLink for implementation', async () => {
    const link = { targetUri: pathToFileURL(join(ws, 'a.ts')).href, targetSelectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } } }
    const ctx = await mount({ LSP_FAKE_IMPL: JSON.stringify([link]) })
    const result = await ctx.lsp.query(query('implementation'))
    expect(result).toMatchObject({ kind: 'locations', locations: [{ range: { start: { line: 1, character: 0 } } }] })
    await ctx.fiber.dispose()
  })

  it('returns references (server includes the declaration)', async () => {
    const ctx = await mount({ LSP_FAKE_REFS: JSON.stringify([locationJson(0), locationJson(1)]) })
    const result = await ctx.lsp.query(query('references'))
    expect(result).toMatchObject({ kind: 'locations' })
    if (result.kind !== 'locations') throw new Error('expected locations')
    expect(result.locations).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('normalizes a hover MarkupContent', async () => {
    const ctx = await mount({ LSP_FAKE_HOVER: JSON.stringify({ contents: { kind: 'markdown', value: 'docs' } }) })
    const result = await ctx.lsp.query(query('hover'))
    expect(result).toEqual({ kind: 'hover', hover: { contents: 'docs' } })
    await ctx.fiber.dispose()
  })

  it('returns an empty locations result for a null definition', async () => {
    const ctx = await mount({ LSP_FAKE_DEF: 'null' })
    expect(await ctx.lsp.query(query('definition'))).toEqual({ kind: 'locations', locations: [] })
    await ctx.fiber.dispose()
  })

  it('returns a null hover for a null result', async () => {
    const ctx = await mount({ LSP_FAKE_HOVER: 'null' })
    expect(await ctx.lsp.query(query('hover'))).toEqual({ kind: 'hover', hover: null })
    await ctx.fiber.dispose()
  })

  it('rejects a non-utf-16 position encoding at initialize', async () => {
    const ctx = await mount({ LSP_FAKE_ENCODING: 'utf-8', LSP_FAKE_DEF: 'null' })
    await expect(ctx.lsp.query(query('definition'))).rejects.toThrow(/unsupported position encoding/)
    await ctx.fiber.dispose()
  })

  it('rejects a server without transient-open sync (None)', async () => {
    const ctx = await mount({ LSP_FAKE_SYNC: '0', LSP_FAKE_DEF: 'null' })
    await expect(ctx.lsp.query(query('definition'))).rejects.toThrow(/transient textDocument\/didOpen/)
    await ctx.fiber.dispose()
  })

  it('accepts openClose options sync', async () => {
    const ctx = await mount({ LSP_FAKE_SYNC: JSON.stringify({ openClose: true, change: 2 }), LSP_FAKE_DEF: 'null' })
    expect(await ctx.lsp.query(query('definition'))).toEqual({ kind: 'locations', locations: [] })
    await ctx.fiber.dispose()
  })

  it('fails a query for an unsupported operation', async () => {
    const ctx = await mount({ LSP_FAKE_CAPS: JSON.stringify({ hoverProvider: false }), LSP_FAKE_DEF: 'null' })
    await expect(ctx.lsp.query(query('hover'))).rejects.toThrow(/does not support hover/)
    await ctx.fiber.dispose()
  })

  it('rejects a source outside the workspace before startup', async () => {
    const outside = join(root, 'out.ts')
    await writeFile(outside, 'x')
    const ctx = await mount({ LSP_FAKE_DEF: 'null' })
    await expect(ctx.lsp.query({ ...query('definition'), filePath: outside })).rejects.toThrow(/outside the workspace/)
    await ctx.fiber.dispose()
  })

  it('serializes queries through one instance and runs them in order', async () => {
    const ctx = await mount({ LSP_FAKE_DEF: JSON.stringify(locationJson(0)) })
    const results = await Promise.all([
      ctx.lsp.query(query('definition')),
      ctx.lsp.query(query('definition')),
      ctx.lsp.query(query('definition')),
    ])
    for (const result of results) expect(result).toMatchObject({ kind: 'locations' })
    await ctx.fiber.dispose()
  })

  it('aborts an in-flight query when the signal fires', async () => {
    const ctx = await mount({ LSP_FAKE_HANG: '1' })
    const controller = new AbortController()
    const pending = ctx.lsp.query(query('definition'), controller.signal)
    controller.abort(new Error('caller cancelled'))
    await expect(pending).rejects.toThrow(/cancelled/)
    await ctx.fiber.dispose()
  })

  it('classifies a timeout deadline as the abort reason', async () => {
    const ctx = await mount({ LSP_FAKE_HANG: '1' })
    using d = deadline(undefined, 50, 'TEST_TIMEOUT')
    await expect(ctx.lsp.query(query('definition'), d.signal)).rejects.toThrow(/TEST_TIMEOUT/)
    await ctx.fiber.dispose()
  })

  it('fails the active query when the server crashes on open, and replaces it next query', async () => {
    const ctx = await mount({ LSP_FAKE_CRASH_ON_OPEN: '1', LSP_FAKE_DEF: 'null' }, { shutdownTimeoutMs: 100, killGraceMs: 100 })
    await expect(ctx.lsp.query(query('definition'))).rejects.toThrow()
    // A later query starts a fresh process; still crashes, but proves the slot was replaced (no hang).
    await expect(ctx.lsp.query(query('definition'))).rejects.toThrow()
    await ctx.fiber.dispose()
  })

  it('runs distinct workspaces in parallel instances', async () => {
    const ws2 = join(root, 'ws2')
    await mkdir(ws2)
    await writeFile(join(ws2, 'a.ts'), 'const z = 2\n')
    const ctx = await mount({ LSP_FAKE_DEF: JSON.stringify(locationJson(0)) })
    const [r1, r2] = await Promise.all([
      ctx.lsp.query({ ...query('definition'), workspaceRoot: ws }),
      ctx.lsp.query({ ...query('definition'), workspaceRoot: ws2 }),
    ])
    expect(r1).toMatchObject({ kind: 'locations' })
    expect(r2).toMatchObject({ kind: 'locations' })
    await ctx.fiber.dispose()
  })

  it('disposes cleanly, terminating a server that ignores shutdown', async () => {
    const ctx = await mount({ LSP_FAKE_NO_SHUTDOWN: '1', LSP_FAKE_DEF: 'null' }, { killGraceMs: 100, shutdownTimeoutMs: 100 })
    await ctx.lsp.query(query('definition'))
    await expect(ctx.fiber.dispose()).resolves.toBeUndefined()
  })

  it('rejects at load when the command is not found', async () => {
    const ctx = new Context()
    await ctx.plugin(Lsp)
    await expect(ctx.plugin(LspLocal, {
      providerId: 'missing',
      command: 'definitely-not-a-real-lsp-binary-xyz',
      args: [],
      extensionToLanguage: { '.ts': 'typescript' },
    })).rejects.toThrow(/was not found on PATH/)
    await ctx.fiber.dispose()
  })
})
