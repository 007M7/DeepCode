/**
 * Pins the client-bundle purity gate (tsdown preset resolveId classifier),
 * the build-time mirror of the module-edge rules: platform module-table
 * entries stay external, inline-safe wire layers inline, and every other
 * @deepseek-ai value import — including a bare plugin-package name and a
 * cross-plugin /client subpath — must fail the build loudly (cross-plugin
 * collaboration goes through cordis services, never module imports).
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

  it('leaves platform table entries and non-scoped specifiers alone', () => {
    expect(resolveId('@deepseek-ai/dsh-client-ui-slots')).toBeNull()
    expect(resolveId('@deepseek-ai/dsh-client-web-react')).toBeNull()
    expect(resolveId('@deepseek-ai/dsh-client-ui-primitives')).toBeNull()
    expect(resolveId('react')).toBeNull()
    expect(resolveId('zod')).toBeNull()
  })

  it('rejects retired table entries (web-react/store left the 8-entry seed)', () => {
    expect(() => resolveId('@deepseek-ai/dsh-client-web-react/store')).toThrow(/purity/)
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

  it('throws on cross-plugin value imports — bare plugin names and /client subpaths alike (the rewrite arm is gone)', () => {
    expect(() => resolveId('@deepseek-ai/dsh-client-connection')).toThrow(/purity/)
    expect(() => resolveId('@deepseek-ai/dsh-client-runtime')).toThrow(/purity/)
    expect(() => resolveId('@deepseek-ai/dsh-client-ui-layout/client')).toThrow(/purity/)
  })

  it('carries exactly one documented temporary exemption: runtime/client (store engine pending rehoming)', () => {
    expect(resolveId('@deepseek-ai/dsh-client-runtime/client')).toBeNull()
    const dshClientChannels = CLIENT_EXTERNALS.filter(
      entry => entry.startsWith('@deepseek-ai/') && entry.endsWith('/client'))
    expect(dshClientChannels).toEqual(['@deepseek-ai/dsh-client-runtime/client'])
  })
})
