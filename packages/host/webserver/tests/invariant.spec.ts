/**
 * Webserver invariant companion: the boot-manifest consistency audit — every
 * registry snapshot row must resolve a clientPath, checked on fiber lifecycle
 * events against the assembly-published 'webPlugins' context key.
 */
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as WebserverInvariant from '../src/invariant.ts'

interface RegistryStub {
  snapshot(): { id: string; url: string }[]
  clientPath(id: string): string | undefined
}

async function setup(registry?: RegistryStub): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(WebserverInvariant).await()
  if (registry !== undefined) ctx.reflect.provide('webPlugins', registry)
  return ctx
}

/** Fire the audit trigger directly (same technique as the scope invariant
 *  spec): a synchronous emit propagates the fail() throw to the caller. */
function trigger(ctx: Context): void {
  ;(ctx.emit as (event: string, ...args: unknown[]) => void)('internal/plugin', ctx.fiber)
}

describe('webserver manifest invariant', () => {
  it('stays silent without a registry (carrier-only deployment) and with a consistent table', async () => {
    const bare = await setup()
    expect(() => { trigger(bare) }).not.toThrow() // no 'webPlugins' key published

    const consistent = await setup({
      snapshot: () => [{ id: 'p1', url: '/plugins/p1/client.js' }],
      clientPath: () => '/tmp/p1/lib/client.js',
    })
    expect(() => { trigger(consistent) }).not.toThrow()
  })

  it('throws on a manifest row whose bundle path no longer resolves', async () => {
    const ctx = await setup({
      snapshot: () => [{ id: 'ghost', url: '/plugins/ghost/client.js' }],
      clientPath: () => undefined,
    })
    expect(() => { trigger(ctx) })
      .toThrow(/manifest row "ghost".*resolves no client bundle path/)
  })
})
