/**
 * Real-load-path guard for @deepseek-ai/dsh-tool-web. `tool-web` is a NAMESPACE
 * plugin with `inject` — so a stray `export default apply` would make the cordis
 * Loader's `unwrapExports` (`exports.default ?? exports`) collapse the module to
 * the bare `apply` function, DROPPING `inject`. The plugin would then read
 * `ctx.web` without having injected it and throw `cannot get property … without
 * inject` the moment it loads (postmortem 0001).
 *
 * A hand-built `ctx.plugin({ apply, inject })` mount CANNOT catch that — it
 * bypasses `unwrapExports`. So this test unwraps the module through the REAL
 * `Loader.prototype.unwrapExports` and mounts the result over `ctx.web`,
 * exercising the exact path the Loader uses. Prove the guard bites: add
 * `export default apply` to `src/index.ts`, watch this go red, revert.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import WebService from '@deepseek-ai/dsh-web'
import * as toolWeb from '@deepseek-ai/dsh-tool-web'

describe('dsh-tool-web real-load-path guard', () => {
  it('has no default export and keeps name/inject/Config through unwrapExports', () => {
    expect('default' in toolWeb).toBe(false)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolWeb) as Record<string, unknown>
    expect(unwrapped).toBe(toolWeb)
    expect(unwrapped.name).toBe('tool-web')
    expect(unwrapped.inject).toEqual(['tools', 'web', 'systemPrompt'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('boots over ctx.web through the unwrapped module without an inject error', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(WebService, {})

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolWeb) as Parameters<Context['plugin']>[0]
    // A collapsed export shape (dropped inject) would throw "without inject" here.
    const fiber = await ctx.plugin(unwrapped)
    expect(ctx.tools.schemas().map(s => s.name)).toEqual(expect.arrayContaining(['web_search', 'web_fetch']))
    await fiber.dispose()
  })
})
