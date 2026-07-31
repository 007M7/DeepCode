import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { CredentialsLocal, resolveSpec } from '../src/index.ts'

const KEY = credentialRef('DSH_CRED_TEST')
const OTHER = credentialRef('DSH_CRED_OTHER')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-credentials-local-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(config: ConstructorParameters<typeof CredentialsLocal>[1]): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(CredentialsLocal, config)
  cleanups.push(async () => {
    await fiber.dispose()
  })
  await fiber
  return ctx
}

function updates(ctx: Context): CredentialRef[] {
  const seen: CredentialRef[] = []
  ctx.on('credentials/updated', (ref) => {
    seen.push(ref)
  })
  return seen
}

describe('resolveSpec', () => {
  it('defaults to .env under the harness home with watching on', () => {
    const spec = resolveSpec({ dshHome: '/custom/home' })
    expect(spec).toEqual({ filename: resolve('/custom/home/.env'), watch: true, debounceMs: 100 })
  })

  it('lets an explicit path win over the home', () => {
    const spec = resolveSpec({ path: '/etc/dsh/creds.env', dshHome: '/ignored', watch: false, debounceMs: 5 })
    expect(spec).toEqual({ filename: resolve('/etc/dsh/creds.env'), watch: false, debounceMs: 5 })
  })
})

describe('layering and reads', () => {
  it('treats an absent file as an empty writable store', async () => {
    const dir = await tempDir()
    const ctx = await boot({ path: join(dir, '.env'), watch: false })
    expect(await ctx.credentials.resolve(KEY)).toBeUndefined()
    expect(await ctx.credentials.describe(KEY)).toEqual({ configured: false, writable: true })
  })

  it('serves file entries, including export-prefixed and quoted values', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    await writeFile(path, '# notes\nexport DSH_CRED_TEST=plain\nDSH_CRED_OTHER="with space"\n')
    const ctx = await boot({ path, watch: false })
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'plain', source: 'file' })
    expect(await ctx.credentials.resolve(OTHER)).toEqual({ value: 'with space', source: 'file' })
    expect(await ctx.credentials.describe(KEY)).toEqual({ configured: true, source: 'file', writable: true })
  })

  it('lets a non-empty process environment win read-only over the file', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    await writeFile(path, 'DSH_CRED_TEST=from-file\n')
    const ctx = await boot({ path, watch: false })
    vi.stubEnv('DSH_CRED_TEST', 'from-env')
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'from-env', source: 'env' })
    expect(await ctx.credentials.describe(KEY)).toEqual({ configured: true, source: 'env', writable: false })
  })

  it('treats empty values as absent in both layers', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    await writeFile(path, 'DSH_CRED_TEST=\n')
    const ctx = await boot({ path, watch: false })
    vi.stubEnv('DSH_CRED_TEST', '')
    expect(await ctx.credentials.resolve(KEY)).toBeUndefined()
    expect(await ctx.credentials.describe(KEY)).toEqual({ configured: false, writable: true })
  })

  it('fails boot loud when the document exists but cannot be read', async () => {
    const dir = await tempDir()
    const path = join(dir, 'occupied')
    await mkdir(path)
    const ctx = new Context()
    await expect(ctx.plugin(CredentialsLocal, { path, watch: false })).rejects.toThrow()
  })
})

describe('line-editing writes', () => {
  it('appends a missing key to a fresh 0600 document and emits the commit', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    const ctx = await boot({ path, watch: false })
    const seen = updates(ctx)
    await ctx.credentials.set(KEY, 'sk-fresh')
    expect(await readFile(path, 'utf8')).toBe('DSH_CRED_TEST=sk-fresh\n')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'sk-fresh', source: 'file' })
    expect(seen).toEqual([KEY])
  })

  it('rewrites one line in place, preserving every other byte and dropping duplicates', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    await writeFile(path, '# deployment notes\nFIRST=one\n\nDSH_CRED_TEST=old\nTRAILING=x\nDSH_CRED_TEST=older')
    const ctx = await boot({ path, watch: false })
    await ctx.credentials.set(KEY, 'new value!')
    expect(await readFile(path, 'utf8')).toBe('# deployment notes\nFIRST=one\n\nDSH_CRED_TEST=\'new value!\'\nTRAILING=x\n')
  })

  it('quotes hostile values so they round-trip through a fresh provider', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    const ctx = await boot({ path, watch: false })
    const singleQuoted = 'with "quote", back\\slash and space'
    const doubleQuoted = "it's got an apostrophe"
    await ctx.credentials.set(KEY, singleQuoted)
    await ctx.credentials.set(OTHER, doubleQuoted)
    const reread = await boot({ path, watch: false })
    expect(await reread.credentials.resolve(KEY)).toEqual({ value: singleQuoted, source: 'file' })
    expect(await reread.credentials.resolve(OTHER)).toEqual({ value: doubleQuoted, source: 'file' })
  })

  it('fails loud on values no .env quoting style reads back verbatim', async () => {
    const dir = await tempDir()
    const ctx = await boot({ path: join(dir, '.env'), watch: false })
    await expect(ctx.credentials.set(KEY, 'line one\nline two')).rejects.toThrow(/control characters/)
    await expect(ctx.credentials.set(KEY, 'both \' and "')).rejects.toThrow(/mixes quoting/)
  })

  it('unsets only the owning line and keeps an absent unset silent', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    await writeFile(path, '# keep\nDSH_CRED_TEST=gone\nDSH_CRED_OTHER=stays\n')
    const ctx = await boot({ path, watch: false })
    const seen = updates(ctx)
    await ctx.credentials.unset(KEY)
    expect(await readFile(path, 'utf8')).toBe('# keep\nDSH_CRED_OTHER=stays\n')
    await ctx.credentials.unset(KEY)
    expect(seen).toEqual([KEY])
  })

  it('rejects empty values, shadowed writes, and multi-line entries', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    await writeFile(path, 'DSH_CRED_TEST="line one\nline two"\n')
    const ctx = await boot({ path, watch: false })

    await expect(ctx.credentials.set(KEY, '')).rejects.toThrow(/empty value/)
    await expect(ctx.credentials.set(KEY, 'next')).rejects.toThrow(/multi-line/)
    await expect(ctx.credentials.unset(KEY)).rejects.toThrow(/multi-line/)

    vi.stubEnv('DSH_CRED_TEST', 'shadowing')
    await expect(ctx.credentials.set(KEY, 'next')).rejects.toThrow(/shadowed/)
    await expect(ctx.credentials.unset(KEY)).rejects.toThrow(/shadowed/)
  })

  it('leaves an empty document after unsetting the only entry', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    await writeFile(path, 'DSH_CRED_TEST=only\n')
    const ctx = await boot({ path, watch: false })
    await ctx.credentials.unset(KEY)
    expect(await readFile(path, 'utf8')).toBe('')
  })

  it('chains past a rejected write so one bad value cannot poison the queue', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    const ctx = await boot({ path, watch: false })
    const bad = expect(ctx.credentials.set(KEY, 'both \' and "')).rejects.toThrow(/mixes quoting/)
    const good = ctx.credentials.set(OTHER, 'lands')
    await bad
    await good
    expect(await readFile(path, 'utf8')).toBe('DSH_CRED_OTHER=lands\n')
  })

  it('serializes concurrent writes so both land in the one document', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    const ctx = await boot({ path, watch: false })
    await Promise.all([
      ctx.credentials.set(KEY, 'one'),
      ctx.credentials.set(OTHER, 'two'),
    ])
    expect(await readFile(path, 'utf8')).toBe('DSH_CRED_TEST=one\nDSH_CRED_OTHER=two\n')
  })

  it('refuses writes after disposal', async () => {
    const dir = await tempDir()
    const ctx = new Context()
    const fiber = ctx.plugin(CredentialsLocal, { path: join(dir, '.env'), watch: false })
    await fiber
    // Capture the handle first: disposal also removes the ctx.credentials service.
    const service = ctx.credentials
    await fiber.dispose()
    await expect(service.set(KEY, 'late')).rejects.toThrow(/disposed/)
  })
})

describe('real hot reload', () => {
  it('publishes external edits, replaces the snapshot wholesale, and suppresses self-writes', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    // Watching starts on an existing document: creation racing watcher setup
    // is a chokidar readiness gap, not the reload contract under test.
    await writeFile(path, 'DSH_CRED_TEST=boot\n')
    const ctx = await boot({ path, debounceMs: 10 })
    const seen = updates(ctx)

    await writeFile(path, 'DSH_CRED_TEST=live\nDSH_CRED_OTHER=extra\n')
    await vi.waitFor(async () => {
      expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'live', source: 'file' })
    })

    // Wholesale replacement: an entry deleted on disk never lingers in memory.
    await writeFile(path, 'DSH_CRED_TEST=live\n')
    await vi.waitFor(async () => {
      expect(await ctx.credentials.resolve(OTHER)).toBeUndefined()
    })

    const before = seen.length
    await ctx.credentials.set(KEY, 'self-written')
    await new Promise(resolvePause => setTimeout(resolvePause, 200))
    // Exactly the committed write's own event: the watcher echo of our own
    // content is recognized by the text cache and publishes nothing extra.
    expect(seen.length).toBe(before + 1)
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'self-written', source: 'file' })
  })
})
