import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { credentialRef } from '../src/index.ts'
import { MemoryCredentials } from './memory.ts'

const REF = credentialRef('DEEPSEEK_API_KEY')

describe('credentialRef', () => {
  it('brands POSIX shell identifiers', () => {
    expect(credentialRef('DEEPSEEK_API_KEY')).toBe('DEEPSEEK_API_KEY')
    expect(credentialRef('_private')).toBe('_private')
    expect(credentialRef('lower_case9')).toBe('lower_case9')
  })

  it('rejects every other shape', () => {
    for (const invalid of ['', '9LEADING', 'WITH-DASH', 'WITH SPACE', 'ns:key']) {
      expect(() => credentialRef(invalid)).toThrow(TypeError)
    }
  })
})

describe('the credentials seam', () => {
  it('mounts as ctx.credentials and resolves non-empty values', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials, { DEEPSEEK_API_KEY: 'sk-seeded' })
    expect(await ctx.credentials.resolve(REF)).toBe('sk-seeded')
  })

  it('treats an empty provider value as absent', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials, { DEEPSEEK_API_KEY: '' })
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
  })

  it('removes the service with its fiber', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(MemoryCredentials)
    expect(ctx.get('credentials')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('credentials')).toBeUndefined()
  })
})
