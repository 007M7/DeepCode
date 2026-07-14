import { describe, expect, it } from 'vitest'
import Loader from '@cordisjs/plugin-loader'
import * as jsonrpc from '../src/index.ts'

/**
 * REAL-export-path guard for the @deepseek-ai/dsh-jsonrpc namespace plugin
 * (the packages/AGENTS.md red line: a plugin shipped via `cordis.yml` needs a
 * test through the real Loader/export path). A hand-built `ctx.plugin({...})`
 * mount bypasses `unwrapExports` — the exact path that once collapsed a
 * namespace plugin with a stray `export default` and silently dropped its
 * `inject` (docs/postmortem/0001) — so this spec drives the REAL
 * `Loader.unwrapExports` over the module namespace and asserts the
 * `name`/`inject`/`Config`/`apply` shape survives it intact.
 */
describe('dsh-jsonrpc plugin export shape', () => {
  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/Config/apply', () => {
    // A stray `export default` would make `unwrapExports` (`exports.default ??
    // exports`) collapse the module to the bare default, dropping `inject` —
    // the plugin would then throw "cannot get property … without inject" at
    // its first `ctx.agents` read. Adding `export default` fails this test.
    expect('default' in jsonrpc).toBe(false)
    expect(typeof jsonrpc.apply).toBe('function')

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(jsonrpc) as Record<string, unknown>
    expect(unwrapped).toBe(jsonrpc)
    expect(unwrapped.name).toBe('jsonrpc')
    expect(unwrapped.inject).toEqual(['agents'])
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')
  })
})
