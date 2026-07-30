/**
 * Integration tests: the REAL local bash executor (`dsh-bash-local`) plus a
 * REAL ripgrep binary, exercised through `ctx.tools.execute()`. These verify
 * the WORLD — actual files on disk are discovered and grepped, hostile
 * patterns stay inert in a real shell, and real `rg` stderr classifies into
 * the `SEARCH_*` vocabulary. The whole suite self-skips when `rg` is not on
 * PATH (a CI accommodation mirroring the keyless e2e skip); the fake-executor
 * suite (tools.spec.ts) carries the coverage gate.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessService from '@deepseek-ai/dsh-subprocess-local'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'

const testToolSignal = new AbortController().signal

const hasRg = spawnSync('rg', ['--version'], { encoding: 'utf8' }).status === 0

let dir: string
let ctx: Context

let callCounter = 0
function call(name: string, args: unknown, agentObj?: object) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`it-${++callCounter}`),
    name,
    arguments: args,
    ...agentObj ? { agent: agentObj as never } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe.skipIf(!hasRg)('search tools over the real bash executor + real rg', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-search-int-'))
    await mkdir(join(dir, 'src'), { recursive: true })
    await mkdir(join(dir, '.git'), { recursive: true })
    await mkdir(join(dir, 'spaced dir'), { recursive: true })
    await writeFile(join(dir, 'src', 'alpha.ts'), 'export const alpha = 1\n// TODO: refit alpha\n')
    await writeFile(join(dir, 'src', 'beta.ts'), 'export const beta = 2\n')
    await writeFile(join(dir, 'notes.md'), 'alpha appears here too\n')
    await writeFile(join(dir, '.hidden.ts'), 'export const hidden = 3\n')
    await writeFile(join(dir, '.git', 'config.ts'), 'never listed\n')
    await writeFile(join(dir, 'spaced dir', "wei'rd \"name\".ts"), 'const inside = true\n')
    // Deterministic --sort=modified order: alpha oldest, beta newest.
    await utimes(join(dir, 'src', 'alpha.ts'), new Date(2000, 0, 1), new Date(2000, 0, 1))
    await utimes(join(dir, 'src', 'beta.ts'), new Date(2020, 0, 1), new Date(2020, 0, 1))

    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(LocalSubprocessService)
    await ctx.plugin(LocalBashExecutor, { cwd: dir, timeoutMs: 20_000 })
    await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  describe('glob', () => {
    it('discovers files by pattern, sorted by modification time, hidden included, .git excluded', async () => {
      const result = await call('glob', { pattern: '**/*.ts' })
      expect(result.isError).toBe(false)
      const paths = text(result).split('\n')
      expect(paths.indexOf('src/alpha.ts')).toBeLessThan(paths.indexOf('src/beta.ts'))
      expect(paths).toContain('.hidden.ts')
      expect(paths).toContain("spaced dir/wei'rd \"name\".ts")
      expect(paths).not.toContain('.git/config.ts')
      expect(paths).not.toContain('notes.md')
    })

    it('scopes to a directory search root (path arg)', async () => {
      const result = await call('glob', { pattern: '*.ts', path: 'src' })
      expect(text(result).split('\n').sort()).toEqual(['src/alpha.ts', 'src/beta.ts'])
    })

    it('reports zero discoveries as No files found', async () => {
      expect(text(await call('glob', { pattern: '*.nomatch' }))).toBe('No files found')
    })

    it('excludes VCS internals even when the search root IS the VCS directory', async () => {
      // The prune glob alone never matches root-prefixed paths when rg is
      // rooted at .git; the paired contents glob keeps the exclusion airtight.
      expect(text(await call('glob', { pattern: '*', path: '.git' }))).toBe('No files found')
    })

    it('classifies an invalid glob as SEARCH_INVALID_PATTERN', async () => {
      const result = await call('glob', { pattern: '[' })
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { name: 'SearchError', code: 'SEARCH_INVALID_PATTERN' } })
    })
  })

  describe('grep', () => {
    it('greps a directory tree with grouped, line-numbered output', async () => {
      const result = await call('grep', { pattern: 'alpha' })
      expect(result.isError).toBe(false)
      const output = text(result)
      expect(output).toContain('Found 3 matches')
      expect(output).toContain('src/alpha.ts\nLine 1: export const alpha = 1\nLine 2: // TODO: refit alpha')
      expect(output).toContain('notes.md\nLine 1: alpha appears here too')
    })

    it('greps a single FILE target', async () => {
      const result = await call('grep', { pattern: 'alpha', path: 'notes.md' })
      expect(text(result)).toBe('Found 1 match\n\nnotes.md\nLine 1: alpha appears here too')
    })

    it('greps a directory target with an include filter', async () => {
      const result = await call('grep', { pattern: 'alpha', path: '.', include: '*.ts' })
      const output = text(result)
      expect(output).toContain('alpha.ts')
      expect(output).not.toContain('notes.md')
    })

    it('a hostile pattern stays inert (no command substitution, the world untouched)', async () => {
      const canary = join(dir, 'pwned')
      const result = await call('grep', { pattern: `$(touch ${canary})` })
      expect(result.isError).toBe(false) // exit 1: found nothing, executed nothing
      expect(text(result)).toBe('No matches found')
      expect(spawnSync('test', ['-e', canary]).status).not.toBe(0)
    })

    it('a leading-dash pattern is a pattern, not a flag', async () => {
      await writeFile(join(dir, 'dashes.txt'), 'value --flag value\n')
      const result = await call('grep', { pattern: '--flag', path: 'dashes.txt' })
      expect(text(result)).toBe('Found 1 match\n\ndashes.txt\nLine 1: value --flag value')
    })

    it('classifies a real rg regex error as SEARCH_INVALID_PATTERN', async () => {
      const result = await call('grep', { pattern: '(unclosed' })
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { code: 'SEARCH_INVALID_PATTERN' } })
    })

    it('classifies a missing target as SEARCH_FAILED', async () => {
      const result = await call('grep', { pattern: 'x', path: 'no-such-dir' })
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { code: 'SEARCH_FAILED' } })
    })
  })

  describe('per-session cwd', () => {
    it('resolves the search in the SESSION workspace, not the executor config cwd', async () => {
      const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-search-session-'))
      try {
        await writeFile(join(sessionDir, 'only-here.ts'), 'const sessionFile = true\n')
        const agentObj = { session: { header: { id: 'session-int', cwd: sessionDir } } }
        const globbed = await call('glob', { pattern: '*.ts' }, agentObj)
        expect(text(globbed)).toBe('only-here.ts')
        const grepped = await call('grep', { pattern: 'sessionFile' }, agentObj)
        expect(text(grepped)).toContain('only-here.ts\nLine 1: const sessionFile = true')
      } finally {
        await rm(sessionDir, { recursive: true, force: true })
      }
    })
  })

  describe('pre-dispatch cancellation and bash-start failures', () => {
    it('a pre-aborted registry call is ABORTED_BEFORE_DISPATCH', async () => {
      const controller = new AbortController()
      controller.abort()
      const result = await ctx.tools.execute({
        callId: CallId(`it-${++callCounter}`),
        name: 'grep',
        arguments: { pattern: 'x' },
        signal: controller.signal,
      })
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH } })
    })

    it('an unusable session cwd (spawn failure) is SEARCH_FAILED', async () => {
      const gone = join(dir, 'deleted-session-dir')
      const result = await call('glob', { pattern: '*' }, { session: { header: { id: 'session-int', cwd: gone } } })
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { name: 'SearchError', code: 'SEARCH_FAILED' } })
      expect(text(result)).toContain('could not start')
    })
  })
})
