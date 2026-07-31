// Third-review behaviors: read-modify-write under the writer lock (external
// edits survive an API write), the contained credentials/updated fan-out (a
// broken observer never fails a committed write), and the physical-line
// editor's multi-line and CRLF discipline.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { CredentialsLocal } from '../src/index.ts'

const ALPHA = credentialRef('DSH_REVIEW_ALPHA')
const BETA = credentialRef('DSH_REVIEW_BETA')
const INNER = credentialRef('DSH_REVIEW_INNER')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cred-review-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(config: ConstructorParameters<typeof CredentialsLocal>[1]): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(CredentialsLocal, config)
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

describe('read-modify-write', () => {
  it('folds an unobserved external edit into a write instead of overwriting it', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    const ctx = await boot({ path, watch: false })
    const seen: string[] = []
    ctx.on('credentials/updated', (ref) => { seen.push(ref) })
    await ctx.credentials.set(ALPHA, 'one')
    // The external edit has landed on disk but no watcher reported it (watch
    // is off — the same blind spot as a debounce window or a missed event).
    await writeFile(path, `${ALPHA}=one\n${BETA}=external\n`)
    await ctx.credentials.set(ALPHA, 'two')
    const text = await readFile(path, 'utf8')
    expect(text).toContain(`${BETA}=external`)
    expect(text).toContain(`${ALPHA}=two`)
    // The fold published the unobserved entry before the write's own commit.
    expect(seen).toEqual([ALPHA, BETA, ALPHA])
    expect(await ctx.credentials.resolve(BETA)).toEqual({ value: 'external', source: 'file' })
  })

  it('keeps both refs when two providers write the same document concurrently', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    const first = await boot({ path, watch: false })
    const second = await boot({ path, watch: false })
    await Promise.all([
      (async () => { for (const value of ['1', '2', '3'] as const) await first.credentials.set(ALPHA, value) })(),
      (async () => { for (const value of ['1', '2', '3'] as const) await second.credentials.set(BETA, value) })(),
    ])
    const third = await boot({ path, watch: false })
    expect(await third.credentials.resolve(ALPHA)).toEqual({ value: '3', source: 'file' })
    expect(await third.credentials.resolve(BETA)).toEqual({ value: '3', source: 'file' })
  })

  it('creates the credentials directory owner-only', async () => {
    const dir = await tempDir()
    const home = join(dir, 'home')
    const ctx = await boot({ path: join(home, '.env'), watch: false })
    await ctx.credentials.set(ALPHA, 'one')
    expect((await stat(home)).mode & 0o777).toBe(0o700)
  })
})

describe('contained update fan-out', () => {
  it('does not fail a committed set when a listener throws, and later listeners still run', async () => {
    const dir = await tempDir()
    const ctx = await boot({ path: join(dir, '.env'), watch: false })
    ctx.on('credentials/updated', () => {
      throw new Error('observer boom')
    })
    const second = vi.fn()
    ctx.on('credentials/updated', second)
    await expect(ctx.credentials.set(ALPHA, 'one')).resolves.toBeUndefined()
    expect(second).toHaveBeenCalledWith(ALPHA)
    expect(await ctx.credentials.resolve(ALPHA)).toEqual({ value: 'one', source: 'file' })
  })

  it('contains an async listener rejection', async () => {
    const dir = await tempDir()
    const ctx = await boot({ path: join(dir, '.env'), watch: false })
    // An unknown-returning function keeps the typed surface legal while the
    // runtime value is still the rejected promise the containment must handle.
    const boom = (): unknown => Promise.reject(new Error('async observer boom'))
    ctx.on('credentials/updated', boom)
    await expect(ctx.credentials.set(ALPHA, 'one')).resolves.toBeUndefined()
    await new Promise(resolve => setTimeout(resolve, 10))
  })

  it('rethrows an invariant-coded failure after the commit and the remaining listeners', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    const ctx = await boot({ path, watch: false })
    ctx.on('credentials/updated', () => {
      throw Object.assign(new Error('forged relation'), { code: 'INVARIANT' })
    })
    const second = vi.fn()
    ctx.on('credentials/updated', second)
    await expect(ctx.credentials.set(ALPHA, 'one')).rejects.toThrow(/forged relation/)
    // Harness-fatal by design — but the write itself committed first.
    expect(second).toHaveBeenCalledWith(ALPHA)
    expect(await readFile(path, 'utf8')).toContain(`${ALPHA}=one`)
    expect(await ctx.credentials.resolve(ALPHA)).toEqual({ value: 'one', source: 'file' })
  })
})

describe('physical-line editor', () => {
  it('never mistakes a quoted multi-line continuation for an assignment', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    const wrapped = `DSH_REVIEW_WRAPPED="line1\n${INNER}=looks-like-one\nline3"\n${ALPHA}=a\n`
    await writeFile(path, wrapped)
    const ctx = await boot({ path, watch: false })
    await ctx.credentials.set(ALPHA, 'b')
    // The wrapped value survives byte-for-byte; only ALPHA's line changed.
    const afterAlpha = await readFile(path, 'utf8')
    expect(afterAlpha).toBe(`DSH_REVIEW_WRAPPED="line1\n${INNER}=looks-like-one\nline3"\n${ALPHA}=b\n`)
    // Setting the inner-looking ref appends a real assignment; the
    // continuation line inside the quoted value stays untouched.
    await ctx.credentials.set(INNER, 'real')
    const afterInner = await readFile(path, 'utf8')
    expect(afterInner).toBe(`DSH_REVIEW_WRAPPED="line1\n${INNER}=looks-like-one\nline3"\n${ALPHA}=b\n${INNER}=real\n`)
    expect(await ctx.credentials.resolve(INNER)).toEqual({ value: 'real', source: 'file' })
  })

  it('preserves CRLF line endings on untouched and edited lines', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    await writeFile(path, `# note\r\n${ALPHA}=a\r\n${BETA}=keep\r\n`)
    const ctx = await boot({ path, watch: false })
    await ctx.credentials.set(ALPHA, 'b')
    expect(await readFile(path, 'utf8')).toBe(`# note\r\n${ALPHA}=b\r\n${BETA}=keep\r\n`)
    await ctx.credentials.set(INNER, 'new')
    expect(await readFile(path, 'utf8')).toBe(`# note\r\n${ALPHA}=b\r\n${BETA}=keep\r\n${INNER}=new\r\n`)
  })

  it('terminates a final unterminated line before appending', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    await writeFile(path, `${ALPHA}=a`)
    const ctx = await boot({ path, watch: false })
    await ctx.credentials.set(BETA, 'b')
    expect(await readFile(path, 'utf8')).toBe(`${ALPHA}=a\n${BETA}=b\n`)
  })

  it('rewrites a final unterminated assignment in the dominant ending style', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    await writeFile(path, `${ALPHA}=a`)
    const ctx = await boot({ path, watch: false })
    await ctx.credentials.set(ALPHA, 'b')
    expect(await readFile(path, 'utf8')).toBe(`${ALPHA}=b\n`)
  })

  it('tracks a single-quoted multi-line value through its continuation', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    await writeFile(path, `DSH_REVIEW_SQ='line1\n${INNER}=shadow\nline3'\n`)
    const ctx = await boot({ path, watch: false })
    await ctx.credentials.set(ALPHA, 'x')
    expect(await readFile(path, 'utf8'))
      .toBe(`DSH_REVIEW_SQ='line1\n${INNER}=shadow\nline3'\n${ALPHA}=x\n`)
  })

  it('reports a multi-line entry as unwritable and refuses to edit it', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    await writeFile(path, `${ALPHA}="line1\nline2"\n`)
    const ctx = await boot({ path, watch: false })
    expect(await ctx.credentials.describe(ALPHA)).toEqual({ configured: true, source: 'file', writable: false })
    await expect(ctx.credentials.set(ALPHA, 'flat')).rejects.toThrow(/multi-line entry/)
    await expect(ctx.credentials.unset(ALPHA)).rejects.toThrow(/multi-line entry/)
    // Resolution still serves the multi-line value.
    expect(await ctx.credentials.resolve(ALPHA)).toEqual({ value: 'line1\nline2', source: 'file' })
  })
})
