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
  it('rejects primitive keys but accepts callable objects (matching ScopeKey)', async () => {
    const ctx = new Context()
    // Typed through `unknown` so the ScopeKey type cannot argue the assertion
    // away: this test exercises exactly the callers the typechecker misses.
    const badKeys: unknown[] = ['k', null]
    for (const bad of badKeys) {
      expect(() => createScope(ctx, bad as ScopeKey)).toThrow(/must be a non-null object or function/)
    }

    const callable = Object.assign(() => {}, { nameForTest: 'callable-key' })
    const scope = await mintScope(ctx, callable)
    expect(scopeOf(scope.ctx)).toBe(callable)
    await scope.dispose()
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

  it('dispose() follows a rawDispose-first race through async quiescence', async () => {
    const ctx = new Context()
    const scope = await mintScope(ctx, { name: 'raw-first' })
    const gate = Promise.withResolvers<undefined>()
    let cleanupFinished = false
    scope.ctx.effect(() => async () => {
      await gate.promise
      cleanupFinished = true
    })

    const raw = Promise.resolve(scope.rawDispose())
    let publicSettled = false
    const publicDispose = scope.dispose().then(() => { publicSettled = true })
    await Promise.resolve()
    expect(publicSettled).toBe(false)
    expect(cleanupFinished).toBe(false)

    gate.resolve(undefined)
    await Promise.all([raw, publicDispose])
    expect(cleanupFinished).toBe(true)
    await expect(scope.dispose()).resolves.toBeUndefined()
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

  it('is transparent for subjects with native #private fields: methods and getters through the carrier reach the real object', () => {
    // The ds-review-bot regression: cordis hands the carrier to listeners as
    // `this` (typed Scoped<Agent>), so subject method calls through it are a
    // supported shape. A proxy that delegates with the PROXY as receiver
    // (cordis withProps) throws TypeError on any native #private the method
    // or getter touches; the carrier must delegate with the BASE as receiver
    // and bind retrieved methods to it.
    class Subject {
      #count = 0
      bump(): number { return ++this.#count }
      get count(): number { return this.#count }
    }
    const subject = new Subject()
    const carrier = scopeTarget(subject, subject)
    expect(carrier.bump()).toBe(1) // method call: bound to the base
    expect(subject.count).toBe(1) // ...and it mutated the REAL object
    expect(carrier.count).toBe(1) // getter: runs with the base as receiver
    // The get trap returns the method already bound to the base;
    // detachability IS the assertion.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const detached = carrier.bump
    expect(detached()).toBe(2)
  })

  it('delegates the ordinary reflective surface while keeping overlays immutable', () => {
    const frozenFn = (): string => 'frozen'
    const base: { mutable: number; pinned: () => string; toString: () => string } = {
      mutable: 0,
      pinned: frozenFn,
      toString: () => 'base-str',
    }
    Object.defineProperty(base, 'pinned', { value: frozenFn, writable: false, configurable: false })
    const carrier = scopeTarget(base, undefined)
    carrier.mutable = 7
    expect(base.mutable).toBe(7) // sets land on the base, not a detached overlay
    // The surrogate target frees reads from the base property's proxy
    // invariant, so even a frozen own method can be safely bound to the base.
    expect(carrier.pinned).not.toBe(frozenFn)
    expect(carrier.pinned()).toBe('frozen')
    // The overlay literal inherits Object.prototype; hasOwn (not `in`) keeps
    // it from shadowing the subject's own prototype-surface members.
    expect(String(carrier)).toBe('base-str')
    expect('mutable' in carrier).toBe(true)
    expect(Object.hasOwn(carrier, 'mutable')).toBe(true)
    expect(Object.keys(carrier)).toEqual(['mutable', 'pinned', 'toString'])
    Object.defineProperty(carrier, 'extra', { value: 1, configurable: true })
    expect((base as typeof base & { extra?: number }).extra).toBe(1)
    expect(delete (carrier as typeof carrier & { extra?: number }).extra).toBe(true)
    expect(Reflect.preventExtensions(carrier)).toBe(false)
    expect(Reflect.setPrototypeOf(carrier, null)).toBe(false)
  })

  it('keeps isolation when the base filter is pinned before, during, or after construction', async () => {
    const ctx = new Context()
    const keyA = { name: 'A' }
    const keyB = { name: 'B' }
    const scopeA = await mintScope(ctx, keyA)
    const scopeB = await mintScope(ctx, keyB)
    const heard: string[] = []
    ctx.on('scope-test/ping', value => void heard.push(`global:${value}`))
    scopeA.ctx.on('scope-test/ping', value => void heard.push(`A:${value}`))
    scopeB.ctx.on('scope-test/ping', value => void heard.push(`B:${value}`))
    const pinnedFilter = (): boolean => true

    const pinnedData = {}
    Object.defineProperty(pinnedData, Context.filter, {
      value: pinnedFilter,
      writable: false,
      configurable: false,
    })
    const pinnedCarrier = scopeTarget(pinnedData, keyA)
    ctx.emit(pinnedCarrier, 'scope-test/ping', 'before')

    const duringRead = {}
    Object.defineProperty(duringRead, Context.filter, {
      configurable: true,
      get() {
        Object.defineProperty(duringRead, Context.filter, {
          value: pinnedFilter,
          writable: false,
          configurable: false,
        })
        return pinnedFilter
      },
    })
    ctx.emit(scopeTarget(duringRead, keyA), 'scope-test/ping', 'during')

    const pinnedAfter = { [Context.filter]: pinnedFilter }
    const afterCarrier = scopeTarget(pinnedAfter, keyA)
    Object.defineProperty(pinnedAfter, Context.filter, {
      value: pinnedFilter,
      writable: false,
      configurable: false,
    })
    ctx.emit(afterCarrier, 'scope-test/ping', 'after')

    const pinnedGetterless = {}
    Object.defineProperty(pinnedGetterless, Context.filter, { set(_value: unknown) {}, configurable: false })
    ctx.emit(scopeTarget(pinnedGetterless, keyA), 'scope-test/ping', 'getterless')

    expect(heard).toEqual([
      'global:before', 'A:before',
      'global:during', 'A:during',
      'global:after', 'A:after',
      'global:getterless', 'A:getterless',
    ])
    expect((pinnedCarrier as Record<symbol, unknown>)[Context.filter]).not.toBe(pinnedFilter)
    expect(Reflect.set(pinnedCarrier, Context.filter, pinnedFilter)).toBe(false)
    expect(Reflect.defineProperty(pinnedCarrier, Context.filter, { value: pinnedFilter })).toBe(false)
    expect(Reflect.deleteProperty(pinnedCarrier, Context.filter)).toBe(false)

    expect(() => scopeTarget({ [Context.filter]: 1 }, { name: 'A' })).toThrow(
      /Context\.filter must be a function/,
    )
  })

  it('preserves callable and constructable bases', () => {
    function Subject(this: { value?: number }, value: number): number {
      if (new.target) {
        this.value = value
        return value
      }
      return value * 2
    }
    const carrier = scopeTarget(Subject as typeof Subject & (new (value: number) => { value: number }), {
      name: 'callable',
    })

    const called: unknown = Reflect.apply(carrier, { value: 0 }, [3])
    expect(called).toBe(6)
    const instance = new carrier(4)
    expect(instance).toBeInstanceOf(Subject)
    expect(instance.value).toBe(4)
    const prototypeDescriptor = Object.getOwnPropertyDescriptor(carrier, 'prototype')
    const subjectPrototype: unknown = Reflect.get(Subject, 'prototype')
    expect(prototypeDescriptor?.configurable).toBe(true)
    expect(prototypeDescriptor?.value).toBe(subjectPrototype)
    class Derived extends carrier {}
    const derived = new Derived(5)
    expect(derived).toBeInstanceOf(Derived)
    expect(derived).toBeInstanceOf(Subject)
    expect(derived.value).toBe(5)
    expect(isScopeCarrier(carrier)).toBe(true)
  })

  it('matches non-constructable and bound-constructor function shapes', () => {
    const arrow = (value: number): number => value + 1
    const arrowCarrier = scopeTarget(arrow, { name: 'arrow' })
    const arrowResult: unknown = Reflect.apply(arrowCarrier, undefined, [2])
    expect(arrowResult).toBe(3)
    expect('prototype' in arrowCarrier).toBe(false)
    expect(Object.getOwnPropertyDescriptor(arrowCarrier, 'prototype')).toBeUndefined()
    expect(() => { Reflect.construct(arrowCarrier, []) }).toThrow(TypeError)

    class Subject {
      constructor(readonly value: number) {}
    }
    const bound = Subject.bind(undefined, 7)
    const boundCarrier = scopeTarget(bound, { name: 'bound-constructor' })
    expect('prototype' in boundCarrier).toBe(false)
    expect(Object.getOwnPropertyDescriptor(boundCarrier, 'prototype')).toBeUndefined()
    const instance = new boundCarrier()
    expect(instance).toBeInstanceOf(Subject)
    expect(instance.value).toBe(7)
  })

  it('detects construction without reading a hostile base prototype', () => {
    class Subject {
      constructor(readonly value: number) {}
    }
    let prototypeReads = 0
    const hostile = new Proxy(Subject, {
      get(target, prop, receiver) {
        if (prop === 'prototype') {
          prototypeReads += 1
          throw new Error('hostile prototype getter')
        }
        return Reflect.get(target, prop, receiver) as unknown
      },
    })

    const carrier = scopeTarget(hostile, { name: 'hostile-constructor' })
    expect(prototypeReads).toBe(0)
    const instance: unknown = Reflect.construct(carrier, [9], Subject)
    expect(instance).toBeInstanceOf(Subject)
    expect(instance).toMatchObject({ value: 9 })
    expect(prototypeReads).toBe(0)
  })

  it('keeps the real constructor: class identity survives the carrier', () => {
    class Subject { work(): string { return 'w' } }
    const subject = new Subject()
    const carrier = scopeTarget(subject, subject)
    // `constructor` is looked up, never invoked as a subject method — binding
    // it would break `carrier.constructor === Subject` for no benefit.
    expect(carrier.constructor).toBe(Subject)
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

  it('dispose waits for a child whose raw disposer won the race', async () => {
    const ctx = new Context()
    ctx.provide('answers', { value: 42 })
    const host = await scopeHost(ctx, ['answers'])
    const scope = host.mint({ name: 'raw-first-child' })
    const gate = Promise.withResolvers<undefined>()
    let cleanupFinished = false
    scope.ctx.effect(() => async () => {
      await gate.promise
      cleanupFinished = true
    })

    const raw = Promise.resolve(scope.rawDispose())
    let hostSettled = false
    const hostDispose = host.dispose().then(() => { hostSettled = true })
    await Promise.resolve()
    expect(hostSettled).toBe(false)

    gate.resolve(undefined)
    await Promise.all([raw, hostDispose])
    expect(cleanupFinished).toBe(true)
    await expect(host.dispose()).resolves.toBeUndefined()
  })

  it('reaches every child before surfacing one or multiple disposal failures', async () => {
    const oneCtx = new Context()
    oneCtx.provide('answers', { value: 42 })
    const oneHost = await scopeHost(oneCtx, ['answers'])
    const one = oneHost.mint({ name: 'one' })
    one.dispose = () => Promise.reject(new Error('one failed'))
    await expect(oneHost.dispose()).rejects.toThrow('one failed')

    const manyCtx = new Context()
    manyCtx.provide('answers', { value: 42 })
    const manyHost = await scopeHost(manyCtx, ['answers'])
    const a = manyHost.mint({ name: 'a' })
    const b = manyHost.mint({ name: 'b' })
    a.dispose = () => Promise.reject(new Error('a failed'))
    b.dispose = () => Promise.reject(new Error('b failed'))
    await expect(manyHost.dispose()).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'scopeHost: disposal failed',
      errors: [expect.objectContaining({ message: 'a failed' }), expect.objectContaining({ message: 'b failed' })],
    })
  })

  it('fails LOUD naming absent services instead of resolving as a silent no-op host', async () => {
    const ctx = new Context()
    await expect(scopeHost(ctx, ['tools', 'systemPrompt']))
      .rejects.toThrow('scopeHost: services "tools", "systemPrompt" not available')
  })

  it('snapshots missing-service diagnostics across the host activation await', async () => {
    const ctx = new Context()
    const services = ['tools', 'systemPrompt']
    const pending = scopeHost(ctx, services)
    services.splice(0)

    await expect(pending)
      .rejects.toThrow('scopeHost: services "tools", "systemPrompt" not available')
  })

  it('names a single absent service in the singular', async () => {
    const ctx = new Context()
    await expect(scopeHost(ctx, ['tools'])).rejects.toThrow('scopeHost: service "tools" not available')
  })
})
