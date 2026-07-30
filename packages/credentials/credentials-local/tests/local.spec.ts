import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
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

async function boot(path: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(CredentialsLocal, { path })
  cleanups.push(async () => { await ctx.fiber.dispose() })
  return ctx
}

describe('resolveSpec', () => {
  it('defaults to .env under the harness home', () => {
    expect(resolveSpec({ dshHome: '/custom/home' }))
      .toEqual({ filename: resolve('/custom/home/.env') })
  })

  it('lets an explicit path win over the home', () => {
    expect(resolveSpec({ path: '/etc/dsh/creds.env', dshHome: '/ignored' }))
      .toEqual({ filename: resolve('/etc/dsh/creds.env') })
  })
})

describe('read-only resolution', () => {
  it('treats an absent file as unconfigured', async () => {
    const dir = await tempDir()
    const ctx = await boot(join(dir, '.env'))
    expect(await ctx.credentials.resolve(KEY)).toBeUndefined()
  })

  it('parses export-prefixed, quoted, and multiline dotenv values', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    await writeFile(path, '# notes\nexport DSH_CRED_TEST=plain\nDSH_CRED_OTHER="line one\nline two"\n')
    const ctx = await boot(path)
    expect(await ctx.credentials.resolve(KEY)).toBe('plain')
    expect(await ctx.credentials.resolve(OTHER)).toBe('line one\nline two')
  })

  it('reads the live environment first on every call', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    await writeFile(path, 'DSH_CRED_TEST=from-file\n')
    const ctx = await boot(path)
    vi.stubEnv('DSH_CRED_TEST', 'from-env')
    expect(await ctx.credentials.resolve(KEY)).toBe('from-env')
    vi.stubEnv('DSH_CRED_TEST', '')
    expect(await ctx.credentials.resolve(KEY)).toBe('from-file')
  })

  it('re-reads the file on every call and treats empty values as absent', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    await writeFile(path, 'DSH_CRED_TEST=first\n')
    const ctx = await boot(path)
    expect(await ctx.credentials.resolve(KEY)).toBe('first')
    await writeFile(path, 'DSH_CRED_TEST=second\n')
    expect(await ctx.credentials.resolve(KEY)).toBe('second')
    await writeFile(path, 'DSH_CRED_TEST=\n')
    expect(await ctx.credentials.resolve(KEY)).toBeUndefined()
  })

  it('surfaces non-absence read failures at resolution time', async () => {
    const dir = await tempDir()
    const path = join(dir, 'occupied')
    await mkdir(path)
    const ctx = await boot(path)
    await expect(ctx.credentials.resolve(KEY)).rejects.toThrow()
  })
})
