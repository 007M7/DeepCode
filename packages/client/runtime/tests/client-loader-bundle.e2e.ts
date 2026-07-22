/**
 * Real-bundle smoke: the actual tsdown client bundle of ui-layout runs
 * through the loader chain (execute → handoff → factory(require) → apply →
 * export re-registration). Skips when the bundle is not built (lib/client.js is a
 * build product; `pnpm --filter @deepseek-ai/dsh-client-ui-layout build`).
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Context } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import * as uiSlots from '@deepseek-ai/dsh-client-ui-slots'
import * as webReact from '@deepseek-ai/dsh-client-web-react'
import { createClientLoader } from '../src/client/loader/index.ts'
import type { ClientPluginHandoff } from '../src/client/loader/index.ts'
import { SessionsService } from '../src/client/sessions/service.ts'
import { SlotsService } from '../src/client/slots.ts'
import { FakeApiClient } from './fake-api.ts'

const LAYOUT_ID = '@deepseek-ai/dsh-client-ui-layout'

type Win = { DSHClientProxy?: { loadPlugin(h: ClientPluginHandoff): void }; window?: unknown }

afterEach(() => {
  delete (globalThis as Win).DSHClientProxy
  delete (globalThis as Win).window
})

function readLayoutBundle(): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    return readFileSync(require.resolve(`${LAYOUT_ID}/client`), 'utf8')
  } catch {
    return undefined
  }
}

describe('real tsdown bundle through the loader', () => {
  const code = readLayoutBundle()

  it.skipIf(code === undefined)('loads ui-layout lib/client.js: handoff, DI require, apply, export surface', async () => {
    // The bundle banner addresses window.DSHClientProxy; node has no window —
    // alias it to globalThis so the loader-installed proxy is reachable.
    ;(globalThis as Win).window = globalThis
    const ctx = new Context()
    // The layout apply consumes the slots + sessions services; the real chain
    // loads the runtime bundle first — stand both up directly here.
    ctx.plugin(SlotsService)
    await ctx.fiber.await()
    new SessionsService(ctx, new FakeApiClient())
    const loader = createClientLoader({
      ctx,
      // The real bundle externals resolved from the seeded table. React is a
      // type-only import in the layout bundle today, but jsx-runtime is real.
      modules: {
        'react': await import('react'),
        'react/jsx-runtime': await import('react/jsx-runtime'),
        '@deepseek-ai/dsh-client-ui-slots': uiSlots,
        '@deepseek-ai/dsh-client-web-react': webReact,
      },
      boot: { plugins: [{ id: LAYOUT_ID, url: `/plugins/${LAYOUT_ID}/client.js`, inject: [] }] },
      fetchBundle: () => Promise.resolve(code as string),
      // node has no DOM: evaluate the bundle body directly (same synchronous
      // handoff contract as the <script> path).
      executeBundle: (bundleCode) => {
        // Node has no <script>: Function-evaluating the built bundle IS the
        // system under test (same synchronous handoff as the browser path).
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
        new Function(bundleCode)()
      },
    })
    loader.start()
    await loader.settled()
    expect(loader.status.getSnapshot()[LAYOUT_ID]).toBe('active')
    const surface = loader.requireModule(LAYOUT_ID) as Record<string, unknown>
    expect(typeof surface.apply).toBe('function')
  })
})
