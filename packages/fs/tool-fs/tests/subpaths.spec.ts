/**
 * Tests for the per-tool subpath plugins (`@deepseek-ai/dsh-tool-fs/read`,
 * `/write`, `/edit`): each registers exactly one tool, injects the same
 * services (`tools`, `fileContext`, `systemPrompt`), and cleans up on disposal.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { FileSystem, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsEditOutcome,
  FsInfo,
  FsTarget,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import FileContext from '@deepseek-ai/dsh-file-context'
import * as readPlugin from '@deepseek-ai/dsh-tool-fs/read'
import * as writePlugin from '@deepseek-ai/dsh-tool-fs/write'
import * as editPlugin from '@deepseek-ai/dsh-tool-fs/edit'

class StubFs extends FileSystem {
  override async resolve(path: string): Promise<FsTarget> {
    return { inputPath: path, targetKey: FsTargetKey(path), displayPath: path }
  }
  override async stat(): Promise<FsInfo | undefined> {
    return { version: FsVersion('v'), type: 'file', size: 0 }
  }
  override async readText(): Promise<string> {
    return ''
  }
  override async streamText(): Promise<AsyncIterable<string>> {
    return (async function* () { yield '' })()
  }
  override async writeText(): Promise<FsWriteOutcome> {
    return { operation: 'create', version: FsVersion('v') }
  }
  override async editText(): Promise<FsEditOutcome> {
    return { replacements: 1, replaceAll: false, version: FsVersion('v') }
  }
}

async function base() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(StubFs)
  await ctx.plugin(FileContext)
  return ctx
}

describe('subpath plugins', () => {
  it('each registers exactly its one tool', async () => {
    const cases: Array<[unknown, string]> = [
      [readPlugin, 'read'],
      [writePlugin, 'write'],
      [editPlugin, 'edit'],
    ]
    for (const [plugin, toolName] of cases) {
      const ctx = await base()
      await ctx.plugin(plugin as Parameters<Context['plugin']>[0])
      expect(ctx.tools.schemas().map(s => s.name)).toEqual([toolName])
    }
  })

  it('cleans up on disposal (HMR safety)', async () => {
    const ctx = await base()
    const fiber = await ctx.plugin(readPlugin as Parameters<Context['plugin']>[0])
    expect(ctx.tools.schemas()).toHaveLength(1)
    await fiber.dispose()
    expect(ctx.tools.schemas()).toHaveLength(0)
  })

  it('stays pending without a ctx.fileContext provider', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(writePlugin as Parameters<Context['plugin']>[0])
    expect(ctx.tools.schemas()).toHaveLength(0)
  })
})
