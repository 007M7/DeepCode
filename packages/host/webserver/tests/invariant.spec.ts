/**
 * Webserver invariant companion: the boot-graph consistency audit — every
 * fetch-arrival graph row must resolve a clientPath, checked on fiber
 * lifecycle events against the assembly-published 'webPlugins' context key.
 */
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as WebserverInvariant from '../src/invariant.ts'

interface RegistryStub {
  graph(): { entries: { id: string; url: string }[] }
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
      graph: () => ({ entries: [{ id: 'p1', url: '/plugins/p1/client.js?rev=abc' }] }),
      clientPath: id => id === 'p1' ? '/tmp/p1/lib/client.js' : undefined,
    })
    expect(() => { trigger(consistent) }).not.toThrow()
  })

  it('throws on a graph row whose bundle path no longer resolves', async () => {
    const ctx = await setup({
      graph: () => ({ entries: [{ id: 'ghost', url: '/plugins/ghost/client.js?rev=abc' }] }),
      clientPath: () => undefined,
    })
    expect(() => { trigger(ctx) })
      .toThrow(/graph row "ghost".*resolves no client bundle path/)
  })
})
