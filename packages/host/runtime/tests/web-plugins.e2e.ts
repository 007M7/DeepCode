/**
 * Web UI plugin assembly: the in-memory Loader tree mounts all nine UI
 * packages (node halves), and the webserver registry built over it yields the
 * full __DSH_BOOT__ manifest — the P-I config-source bar end to end.
 *
 * The Loader imports plugin packages through their exports maps (lib/), so
 * this is a built-artifact e2e: it skips until the workspace build has run
 * (`pnpm run build`), like the other built-* e2e suites.
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Context } from 'cordis'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import { afterEach, describe, expect, it } from 'vitest'
import { createHostWebPluginRegistry } from '@deepseek-ai/dsh-host-webserver'
import { WEB_UI_PLUGINS, mountWebPlugins } from '../src/web-plugins.ts'

const nodeRequire = createRequire(import.meta.url)
const built = WEB_UI_PLUGINS.every((name) => {
  try {
    return existsSync(nodeRequire.resolve(name))
  } catch {
    return false
  }
})

let root: Context | undefined

afterEach(async () => {
  await root?.fiber.dispose()
  root = undefined
})

describe.skipIf(!built)('mountWebPlugins + registry', () => {
  async function rootWithHostServices(): Promise<Context> {
    root = new Context()
    await root.plugin(SystemPrompt)
    await root.plugin(ToolRegistry)
    await root.plugin(UserInteractionService)
    return root
  }

  it('mounts the nine-package in-memory Loader tree and projects the boot manifest', async () => {
    root = await rootWithHostServices()
    const mounted = await mountWebPlugins(root)
    const registry = createHostWebPluginRegistry({
      ctx: root,
      loader: mounted.loader,
      resolvePkgJson: mounted.resolvePkgJson,
      onError: (err) => { throw err },
    })
    const rows = registry.snapshot()
    expect(rows.map(r => r.id)).toEqual([...WEB_UI_PLUGINS])
    // The infra four are the early-load group; the UI four are not.
    const immediate = rows.filter(r => r.immediately === true).map(r => r.id)
    expect(immediate).toEqual([
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-theme',
      '@deepseek-ai/dsh-client-i18n',
    ])
    // Every row resolves a client path under its own package lib/.
    for (const row of rows) {
      expect(registry.clientPath(row.id)).toMatch(/lib[/\\]client\.js$/)
      expect(row.url).toBe(`/plugins/${row.id}/client.js`)
    }
    registry.dispose()
  })

  it('is idempotent: a second mount reuses the loader and creates no duplicate entries', async () => {
    root = await rootWithHostServices()
    await mountWebPlugins(root)
    const second = await mountWebPlugins(root)
    // ctx.loader hands out a fresh traced proxy per access, so loader identity
    // is not assertable; the observable contract is a single entry per package.
    const names = [...second.loader.entries()].map(e => e.options.name)
      .filter(n => (WEB_UI_PLUGINS as readonly string[]).includes(n))
    expect(names.length).toBe(WEB_UI_PLUGINS.length)
  })
})
