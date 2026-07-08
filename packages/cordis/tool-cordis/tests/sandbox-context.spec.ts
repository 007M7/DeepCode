import { describe, expect, it } from 'vitest'
import { call, setup, text } from './helpers.ts'

/**
 * The sandbox context façade is a whitelist, not a pass-through proxy: mount
 * code reaches only the registration/eventing verbs, the timer helpers, a
 * guarded `tools`, and its injected services. Every framework-plumbing member
 * that could hand back an UNGUARDED context — through which a plugin could
 * `ctx.<escape>.tools.register({…})` to bypass the marker check and host-realm
 * normalization — is denied. These are the regression guards for that escape
 * class (the review finding on the original pass-through proxy).
 */

/** Mount a plugin whose `apply` touches one framework member, and report the error text. */
async function mountTouching(ctx: Awaited<ReturnType<typeof setup>>, expr: string): Promise<string> {
  const result = await call(ctx, 'cordis_mount', {
    code: `return { name: 'probe', inject: ['tools'], apply(ctx) { ${expr} } }`,
  })
  expect(result.isError).toBe(true)
  return text(result)
}

describe('sandbox context façade — escape surface is closed', () => {
  it.each([
    ['ctx.root', 'const c = ctx.root'],
    ['ctx.parent', 'const c = ctx.parent'],
    ['ctx.scope', 'const c = ctx.scope'],
    ['ctx.fiber', 'const f = ctx.fiber'],
    ['ctx.reflect', 'const r = ctx.reflect'],
    ['ctx.registry', 'const r = ctx.registry'],
    ['ctx.events', 'const e = ctx.events'],
    ['ctx.extend()', 'ctx.extend({})'],
    ['ctx.isolate()', 'ctx.isolate("x")'],
    ['ctx.intercept()', 'ctx.intercept("x", {})'],
    ['ctx.plugin()', 'ctx.plugin({ apply() {} })'],
    ['ctx.set()', 'ctx.set("tools", 1)'],
    ['ctx.mixin()', 'ctx.mixin("x", [])'],
  ])('denies %s with a teaching error', async (_label, expr) => {
    const ctx = await setup()
    const message = await mountTouching(ctx, expr)
    expect(message).toContain('sandbox ctx does not expose')
    expect(message).toContain('withheld by design')
  })

  it('the classic ctx.root.tools.register bypass registers nothing and fails loud', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_mount', {
      code: `
        return {
          name: 'root-bypass',
          inject: ['tools'],
          apply(ctx) {
            ctx.root.tools.register({
              name: 'smuggled',
              description: 'raw, unguarded',
              parameters: { type: 'object', properties: {} },
              async execute() { return [] },
            })
          },
        }
      `,
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('sandbox ctx does not expose "root"')
    // The whole point: the bypass never reaches the registry.
    expect(ctx.tools.get('smuggled')).toBeUndefined()
  })

  it('rejects assignment to the façade rather than silently dropping it', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_mount', {
      code: 'return { name: \'writer\', apply(ctx) { ctx.stash = 1 } }',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('sandbox ctx is read-only')
  })

  it('denies a service whose method returns a Context (the .ctx escape), registering nothing', async () => {
    // A cordis Service instance carries `.ctx` (a real Context), so
    // `ctx.systemPrompt.ctx.root.tools.register(…)` would be a fresh unguarded
    // handle. The service wrapper's return-value guard rejects any Context on
    // the way back to sandbox code, so the escape never lands. (`systemPrompt`
    // is in the setup harness, so the plugin activates and its apply runs.)
    const ctx = await setup()
    const result = await call(ctx, 'cordis_mount', {
      code: `
        return {
          name: 'svc-ctx-escape',
          inject: ['systemPrompt', 'tools'],
          apply(ctx) {
            ctx.systemPrompt.ctx.root.tools.register({
              name: 'smuggled_via_service',
              description: 'raw, unguarded',
              parameters: { type: 'object', properties: {} },
              async execute() { return [] },
            })
          },
        }
      `,
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('returned a cordis Context, which the sandbox does not expose')
    expect(ctx.tools.get('smuggled_via_service')).toBeUndefined()
  })

  it('guards an async injected-service method: a host-realm Promise resolves through the guard', async () => {
    // The return guard's Promise arm only fires for a HOST-realm Promise
    // (a vm-realm one is not `instanceof` the host `Promise`). Provide a
    // host-realm service from the test, then inject + await it from a mount:
    // the resolved value is non-Context data and passes through.
    const ctx = await setup()
    ctx.plugin({
      name: 'host-async-svc',
      apply(c) { c.provide('hostAsync', { grab: async () => 'host-fetched' }) },
    })
    await call(ctx, 'cordis_mount', {
      code: `
        return {
          name: 'async-consumer',
          inject: ['hostAsync', 'tools'],
          apply(ctx) {
            harness.registerTool(ctx, harness.defineTool({
              name: 'do_fetch',
              description: 'awaits the host async service',
              parameters: {},
              async execute() {
                const value = await ctx.hostAsync.grab()
                return [{ type: 'text', text: value }]
              },
            }))
          },
        }
      `,
    })
    const result = await call(ctx, 'do_fetch', {})
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('host-fetched')
  })

  it('reads a symbol property as undefined and answers the `in` operator without throwing', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_mount', {
      code: `
        return {
          name: 'introspector',
          inject: ['tools'],
          apply(ctx) {
            const sym = ctx[Symbol.iterator]
            console.log('probe', sym === undefined, 'tools' in ctx, 'on' in ctx, 'root' in ctx)
          },
        }
      `,
    })
    expect(result.isError).toBe(false)
  })
})
