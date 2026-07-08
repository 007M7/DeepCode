import { describe, expect, expectTypeOf, it } from 'vitest'
import { Context } from 'cordis'
import { carrierKeyOf, createScope, isScopeCarrier, scopeHost, scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scope, ScopeKey, Scoped } from '@deepseek-ai/dsh-scope'

declare module 'cordis' {
  interface Events {
    /**
     * Test-only event for exercising scope-filtered dispatch.
     * @param value - opaque payload recorded by listeners.
     * @mode emit
     */
    'scope-test/ping'(value: string): void
    /**
     * Test-only waterfall for exercising carrier `this` shape.
     * @param value - seed value listeners may wrap.
     * @mode waterfall
     */
    'scope-test/echo'(value: string, next: () => string): string
  }
}

/** Mount a host plugin and mint a scope inside it, returning both. */
async function mintScope(ctx: Context, key: object): Promise<Scope> {
  let scope!: Scope
  await ctx.plugin((inner: Context) => {
    scope = createScope(inner, key)
  })
  return scope
}

describe('createScope', () => {
  it('rejects a primitive key at runtime (identity-compared keys must be objects)', () => {
    const ctx = new Context()
    // Typed through `unknown` so the ScopeKey type cannot argue the assertion
    // away: this test exercises exactly the callers the typechecker misses.
    const badKeys: unknown[] = ['k', null]
    for (const bad of badKeys) {
      expect(() => createScope(ctx, bad as ScopeKey)).toThrow(/must be an object/)
    }
  })

  it('tags the scoped context, readable through derivations (nearest tag wins)', async () => {
    const ctx = new Context()
    const key = { name: 'a' }
    const inner = { name: 'a.inner' }
    const scope = await mintScope(ctx, key)

    expect(scopeOf(scope.ctx)).toBe(key)
    // An extend of the scoped context inherits the tag through the prototype chain.
    expect(scopeOf(scope.ctx.extend({}))).toBe(key)
    // A plain context carries no tag.
    expect(scopeOf(ctx)).toBeUndefined()
    // A fiber mounted UNDER the scoped context reads as that scope…
    let mountedCtx!: Context
    await scope.ctx.plugin((c: Context) => { mountedCtx = c })
    expect(scopeOf(mountedCtx)).toBe(key)
    // …and a nested scope shadows the outer tag (nearest wins).
    const nested = createScope(scope.ctx, inner)
    expect(scopeOf(nested.ctx)).toBe(inner)
  })

  it('is usable synchronously: registrations land before the fiber activates', async () => {
    const ctx = new Context()
    const events: string[] = []
    await ctx.plugin((inner: Context) => {
      const scope = createScope(inner, { name: 'sync' })
      // Same tick as createScope — no await between mint and use.
      scope.ctx.effect(() => () => void events.push('effect-disposed'))
      scope.ctx.on('scope-test/ping', value => void events.push(`heard:${value}`))
      events.push('registered')
    })
    ctx.emit(scopeTarget(ctx, undefined), 'scope-test/ping', 'nobody')
    expect(events).toEqual(['registered'])
  })

  it('dispose() unwinds registrations, is idempotent, and inerts the context', async () => {
    const ctx = new Context()
    const scope = await mintScope(ctx, { name: 'd' })
    const order: string[] = []
    scope.ctx.effect(() => () => void order.push('a'))
    scope.ctx.effect(() => () => void order.push('b'))

    await scope.dispose()
    expect(order).toEqual(['b', 'a']) // LIFO within the scope fiber

    // Repeat dispose: the underlying cordis disposer returns undefined; the
    // wrapper still resolves.
    await expect(scope.dispose()).resolves.toBeUndefined()
    // Registration through a disposed scope throws INACTIVE_EFFECT.
    expect(() => scope.ctx.effect(() => () => {})).toThrow(/inactive context/)
  })

  it('rawDispose is the exact cordis disposer: yielding it nests the scope at its position', async () => {
    const ctx = new Context()
    const order: string[] = []
    let composite!: () => Promise<void> | void
    await ctx.plugin((inner: Context) => {
      composite = inner.effect(function* () {
        yield () => void order.push('outermost') // disposed LAST
        const scope = createScope(inner, { name: 'nested' })
        scope.ctx.effect(() => () => void order.push('scope-registration'))
        yield scope.rawDispose // disposed SECOND — nested by identity
        yield () => void order.push('innermost') // disposed FIRST
      })
    })
    await composite()
    // The scope disposed exactly at its yield position (between the two
    // neighbours), not as a concurrent sibling of the composite.
    expect(order).toEqual(['innermost', 'scope-registration', 'outermost'])
  })
})

describe('scopeTarget dispatch filtering', () => {
  it('scoped listeners hear only their key; untagged listeners hear everything', async () => {
    const ctx = new Context()
    const keyA = { name: 'A' }
    const keyB = { name: 'B' }
    const scopeA = await mintScope(ctx, keyA)
    const scopeB = await mintScope(ctx, keyB)

    const heard: string[] = []
    ctx.on('scope-test/ping', value => void heard.push(`global:${value}`))
    scopeA.ctx.on('scope-test/ping', value => void heard.push(`A:${value}`))
    scopeB.ctx.on('scope-test/ping', value => void heard.push(`B:${value}`))

    ctx.emit(scopeTarget(ctx, keyA), 'scope-test/ping', 'to-A')
    ctx.emit(scopeTarget(ctx, keyB), 'scope-test/ping', 'to-B')
    ctx.emit(scopeTarget(ctx, undefined), 'scope-test/ping', 'to-nobody')

    expect(heard).toEqual([
      'global:to-A', 'A:to-A',
      'global:to-B', 'B:to-B',
      'global:to-nobody',
    ])
  })

  it('{ global: true } listeners bypass scope filtering entirely', async () => {
    const ctx = new Context()
    const keyA = { name: 'A' }
    const scopeA = await mintScope(ctx, keyA)
    const heard: string[] = []
    scopeA.ctx.on('scope-test/ping', value => void heard.push(`escape:${value}`), { global: true })

    ctx.emit(scopeTarget(ctx, { name: 'other' }), 'scope-test/ping', 'foreign')
    ctx.emit(scopeTarget(ctx, undefined), 'scope-test/ping', 'nobody')
    expect(heard).toEqual(['escape:foreign', 'escape:nobody'])
  })

  it("composes the base's own Context.filter (a rejecting base filter wins)", async () => {
    const ctx = new Context()
    const keyA = { name: 'A' }
    const scopeA = await mintScope(ctx, keyA)
    const heard: string[] = []
    ctx.on('scope-test/ping', value => void heard.push(`global:${value}`))
    scopeA.ctx.on('scope-test/ping', value => void heard.push(`A:${value}`))

    // A base whose own filter rejects every listener context: nothing fires,
    // scoped or not — the scope predicate never overrides the base's veto.
    const vetoBase = { [Context.filter]: () => false }
    ctx.emit(scopeTarget(vetoBase, keyA), 'scope-test/ping', 'vetoed')
    expect(heard).toEqual([])

    // A base whose filter accepts delegates to the scope predicate.
    const openBase = { [Context.filter]: () => true }
    ctx.emit(scopeTarget(openBase, keyA), 'scope-test/ping', 'open')
    expect(heard).toEqual(['global:open', 'A:open'])
  })

  it('keeps listener `this` base-shaped through the carrier (waterfall)', async () => {
    const ctx = new Context()
    const base = { label: 'the-base' }
    let seenLabel: string | undefined
    ctx.on('scope-test/echo', function (this: { label: string }, value, next) {
      seenLabel = this.label
      return `${next()}+${value}`
    })
    const result = ctx.waterfall(scopeTarget(base, undefined), 'scope-test/echo', 'v', () => 'seed')
    expect(result).toBe('seed+v')
    expect(seenLabel).toBe('the-base')
  })
})

describe('carrier marks', () => {
  it('isScopeCarrier / carrierKeyOf distinguish carriers, keys, and bare subjects', () => {
    const base = { name: 'base' }
    const key = { name: 'key' }
    const keyed = scopeTarget(base, key)
    const subjectless = scopeTarget(base, undefined)

    expect(isScopeCarrier(keyed)).toBe(true)
    expect(carrierKeyOf(keyed)).toBe(key)
    expect(isScopeCarrier(subjectless)).toBe(true)
    expect(carrierKeyOf(subjectless)).toBeUndefined()

    expect(isScopeCarrier(base)).toBe(false)
    expect(carrierKeyOf(base)).toBeUndefined()
    expect(isScopeCarrier(null)).toBe(false)
    expect(isScopeCarrier('x')).toBe(false)
  })

  it('brands the carrier type (compile-time)', () => {
    const base = { name: 'base' }
    const carrier = scopeTarget(base, undefined)
    expectTypeOf(carrier).toExtend<Scoped<{ name: string }>>()
    // A bare subject is NOT assignable where a carrier is demanded.
    expectTypeOf(base).not.toExtend<Scoped<{ name: string }>>()
  })
})

describe('scopeHost', () => {
  it('mints scopes that reach the injected services; dispose unwinds them all', async () => {
    const ctx = new Context()
    ctx.provide('answers', { value: 42 })
    const host = await scopeHost(ctx, ['answers'])
    const scope = host.mint({ name: 'a' })
    expect((scope.ctx as Context & { answers: { value: number } }).answers.value).toBe(42)
    const order: string[] = []
    scope.ctx.effect(() => () => void order.push('scoped-disposed'))
    await host.dispose()
    expect(order).toEqual(['scoped-disposed'])
    expect(() => scope.ctx.effect(() => () => {})).toThrow(/inactive context/)
  })

  it('fails LOUD naming absent services instead of resolving as a silent no-op host', async () => {
    const ctx = new Context()
    await expect(scopeHost(ctx, ['tools', 'systemPrompt']))
      .rejects.toThrow('scopeHost: services "tools", "systemPrompt" not available')
  })

  it('names a single absent service in the singular', async () => {
    const ctx = new Context()
    await expect(scopeHost(ctx, ['tools'])).rejects.toThrow('scopeHost: service "tools" not available')
  })
})
