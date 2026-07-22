// @vitest-environment jsdom
/**
 * Real tsdown artifact shape: lib/client.js hands off through
 * window.DSHClientProxy.loadPlugin, resolves externals through the injected
 * require, returns the export surface (apply + inject), and a mounted apply
 * registers both views into a real ConversationService. Skips when dist/ is
 * not built (`pnpm --filter @deepseek-ai/dsh-client-ui-trajectory bundle`).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationService } from '@deepseek-ai/dsh-client-ui-conversation/client'

const PLUGIN_ID = '@deepseek-ai/dsh-client-ui-trajectory'

interface Handoff { id: string; factory: (require: (spec: string) => unknown) => Record<string, unknown> }
type Win = { DSHClientProxy?: { loadPlugin(h: Handoff): void } }

function readBundle(): string | undefined {
  try {
    // import.meta.url is http-scheme in the jsdom pool; vitest runs from the
    // repo root, so resolve the artifact repo-relatively instead.
    return readFileSync(resolve('packages/client/ui-trajectory/lib/client.js'), 'utf8')
  } catch {
    return undefined
  }
}

afterEach(() => {
  delete (window as Win).DSHClientProxy
  for (const el of document.querySelectorAll('style')) el.remove()
})

describe('tsdown client artifact', () => {
  const code = readBundle()

  async function loadArtifact() {
    let handoff: Handoff | undefined
    ;(window as Win).DSHClientProxy = { loadPlugin: (h) => { handoff = h } }
    // Same execution form the loader uses (inline script eval, window scope) —
    // the implied-eval ban targets accidental string execution, not this
    // deliberate bundle-execution fixture.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
    new Function(code!)()
    expect(handoff).toBeDefined()
    const modules = new Map<string, unknown>([
      ['react', await import('react')],
      ['react/jsx-runtime', await import('react/jsx-runtime')],
    ])
    const surface = handoff!.factory((spec) => {
      if (!modules.has(spec)) throw new Error(`unexpected require: ${spec}`)
      return modules.get(spec)
    })
    return { handoff: handoff!, surface }
  }

  it.skipIf(code === undefined)('hands off with the manifest id and a DI-require factory', async () => {
    const { handoff, surface } = await loadArtifact()
    expect(handoff.id).toBe(PLUGIN_ID)
    expect(surface.apply).toBeTypeOf('function')
    expect(surface.inject).toEqual(['conversation'])
  })

  it.skipIf(code === undefined)('mounted as an object plugin, apply registers both views on the real service', async () => {
    const { surface } = await loadArtifact()
    const ctx = new Context()
    const svc = new ConversationService(ctx)
    const fiber = ctx.plugin(surface as { apply: (ctx: Context) => void })
    await fiber.await()
    expect(svc.views().map(v => v.id)).toEqual(['trajectory', 'waterfall'])
    await fiber.dispose()
    expect(svc.views()).toHaveLength(0)
  })

  it.skipIf(code === undefined)('injects plugin-tagged module CSS during factory execution', async () => {
    await loadArtifact()
    const tags = document.querySelectorAll(`style[data-plugin=${JSON.stringify(PLUGIN_ID)}]`)
    expect(tags.length).toBeGreaterThan(0)
  })
})
