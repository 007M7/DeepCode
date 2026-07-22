/**
 * Pins the client-bundle purity gate (tsdown preset resolveId classifier):
 * a bare-name import of a module-table package must rewrite to its /client
 * external form (inlining it duplicates runtime identity — the P0
/* leak that is not an
 * inline-safe wire layer must fail the build loudly.
 */
import { describe, expect, it } from 'vitest'
import { CLIENT_EXTERNALS, clientBundle } from '../packages/client/tsdown.client.ts'

type ResolveId = (source: string) => null | { id: string; external: boolean }

function purityResolveId(): ResolveId {
  // libEntry is spelled at every call site (no default) so the
  // package-invariants text check can see the invariant entry per package.
  const configs = clientBundle('@deepseek-ai/dsh-client-test', ['lib/types/index.js', 'lib/types/invariant.js'])
  const plugins = (configs[1] as { plugins: { name: string; resolveId?: unknown }[] }).plugins
  const gate = plugins.find(p => p.name === 'dsh-client-bundle-purity')
  if (gate?.resolveId === undefined) throw new Error('purity plugin missing from client config')
  return gate.resolveId as ResolveId
}

describe('client bundle purity gate', () => {
  const resolveId = purityResolveId()

  it('leaves table entries and non-scoped specifiers alone', () => {
    expect(resolveId('@deepseek-ai/dsh-client-ui-slots')).toBeNull()
    expect(resolveId('@deepseek-ai/dsh-client-runtime/client')).toBeNull()
    expect(resolveId('react')).toBeNull()
    expect(resolveId('zod')).toBeNull()
  })

  it('rewrites a bare table-package name to its external /client form (duplicate-instance prevention)', () => {
    expect(resolveId('@deepseek-ai/dsh-client-connection')).toEqual({
      id: '@deepseek-ai/dsh-client-connection/client',
      external: true,
    })
    expect(resolveId('@deepseek-ai/dsh-client-ui-layout')).toEqual({
      id: '@deepseek-ai/dsh-client-ui-layout/client',
      external: true,
    })
  })

  it('lets inline-safe wire layers inline', () => {
    expect(resolveId('@deepseek-ai/dsh-host-apiproxy/api')).toBeNull()
    expect(resolveId('@deepseek-ai/dsh-session/surface')).toBeNull()
    expect(resolveId('@deepseek-ai/dsh-brand')).toBeNull()
  })

  it('throws on any other @deepseek-ai leak', () => {
    expect(() => resolveId('@deepseek-ai/dsh-agent')).toThrow(/purity/)
    expect(() => resolveId('@deepseek-ai/dsh-client-web')).toThrow(/purity/)
  })

  it('every /client external has no bare-name twin in the table (the rewrite assumption)', () => {
    for (const entry of CLIENT_EXTERNALS) {
      if (entry.endsWith('/client')) expect(CLIENT_EXTERNALS).not.toContain(entry.slice(0, -'/client'.length))
    }
  })
})
