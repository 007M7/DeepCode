import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import Lsp, { type LspQueryRequest } from '@deepseek-ai/dsh-lsp'
import * as LspLocal from '@deepseek-ai/dsh-lsp-local'

let root: string
let ws: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'lsp-prov-')))
  ws = join(root, 'ws')
  await mkdir(ws)
  await writeFile(join(ws, 'a.ts'), 'const x = 1\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function query(): LspQueryRequest {
  return { operation: 'definition', filePath: 'a.ts', position: { line: 0, character: 0 }, workspaceRoot: ws }
}

describe('lsp-local provider resolution', () => {
  it('resolves a bare command on the child PATH and registers the provider', async () => {
    // A tiny executable script placed on a custom PATH dir: the load-time resolver must find it.
    const bin = join(root, 'bin')
    await mkdir(bin)
    const exe = join(bin, 'fake-lsp')
    await writeFile(exe, '#!/bin/sh\nexit 0\n')
    await chmod(exe, 0o755)

    const ctx = new Context()
    await ctx.plugin(Lsp)
    await expect(ctx.plugin(LspLocal, {
      providerId: 'onpath',
      command: 'fake-lsp',
      args: [],
      env: { PATH: bin },
      extensionToLanguage: { '.ts': 'typescript' },
    })).resolves.toBeDefined()
    await ctx.fiber.dispose()
  })

  it('skips empty PATH segments and fails when the command is absent', async () => {
    const ctx = new Context()
    await ctx.plugin(Lsp)
    await expect(ctx.plugin(LspLocal, {
      providerId: 'nope',
      command: 'fake-lsp',
      args: [],
      env: { PATH: `::${join(root, 'empty')}` },
      extensionToLanguage: { '.ts': 'typescript' },
    })).rejects.toThrow(/was not found on PATH/)
    await ctx.fiber.dispose()
  })

  it('rejects a query after the provider is disposed', async () => {
    // Use a server that never emits results and dispose the plugin, then confirm queries are refused.
    const ctx = new Context()
    await ctx.plugin(Lsp)
    // Grab the provider instance by registering, then dispose the whole plugin fiber.
    const lsp = ctx.lsp
    const fiber = await ctx.plugin(LspLocal, {
      providerId: 'disp',
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      extensionToLanguage: { '.ts': 'typescript' },
    })
    await fiber.dispose()
    // After disposal the provider unregistered from the seam, so selection fails as unavailable.
    await expect(lsp.query(query())).rejects.toThrow(expect.objectContaining({ code: 'LSP_UNAVAILABLE' }))
    await ctx.fiber.dispose()
  })

  it('rejects a nonpositive teardown budget at load', async () => {
    const ctx = new Context()
    await ctx.plugin(Lsp)
    await expect(ctx.plugin(LspLocal, {
      providerId: 'bad-budget',
      command: process.execPath,
      args: ['-e', ''],
      extensionToLanguage: { '.ts': 'typescript' },
      killGraceMs: 0,
    })).rejects.toThrow(/killGraceMs must be a positive integer/)
    await ctx.fiber.dispose()
  })

  it('rejects an absolute command that is not executable at load', async () => {
    const notExe = join(root, 'not-exe.txt')
    await writeFile(notExe, 'plain text, not executable')
    const ctx = new Context()
    await ctx.plugin(Lsp)
    await expect(ctx.plugin(LspLocal, {
      providerId: 'abs-bad',
      command: notExe,
      args: [],
      extensionToLanguage: { '.ts': 'typescript' },
    })).rejects.toThrow(/is not an executable file/)
    await ctx.fiber.dispose()
  })

  it('rejects an executable directory as a command at load', async () => {
    const ctx = new Context()
    await ctx.plugin(Lsp)
    await expect(ctx.plugin(LspLocal, {
      providerId: 'abs-directory',
      command: ws,
      args: [],
      extensionToLanguage: { '.ts': 'typescript' },
    })).rejects.toThrow(/is not an executable file/)
    await ctx.fiber.dispose()
  })
})
