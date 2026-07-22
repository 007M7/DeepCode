import { describe, expect, it, vi } from 'vitest'
import type { FC } from 'react'
import type { RootBinding, SessionBinding, SlotOptions } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'test.single': { kind: 'single'; scope: 'root'; props: { label: string } }
    'test.list': { kind: 'list'; scope: 'root'; props: { label: string } }
    'test.keyed': { kind: 'keyed'; scope: 'session'; props: { label: string; useSession: unknown } }
  }
}

const Comp: FC<{ label: string }> = () => null
const SessionComp: FC<{ label: string; useSession: unknown }> = () => null

const flushMicrotasks = () => new Promise<void>((resolve) => { queueMicrotask(resolve) })

describe('SlotCore kind semantics', () => {
  it('throws on register before define', () => {
    const core = new SlotCore()
    expect(() => core.register('test.single', Comp)).toThrow('not defined')
  })

  it('throws on duplicate define', () => {
    const core = new SlotCore()
    core.define('test.single', { kind: 'single', scope: 'root' })
    expect(() => core.define('test.single', { kind: 'single', scope: 'root' })).toThrow('already defined')
  })

  it('single: second registration throws, disposer frees the seat', () => {
    const core = new SlotCore()
    core.define('test.single', { kind: 'single', scope: 'root' })
    const dispose = core.register('test.single', Comp)
    expect(() => core.register('test.single', Comp)).toThrow('already has a registration')
    dispose()
    expect(core.entries('test.single')).toHaveLength(0)
    expect(() => core.register('test.single', Comp)).not.toThrow()
  })

  it('keyed: duplicate key throws, missing key throws', () => {
    const core = new SlotCore()
    core.define('test.keyed', { kind: 'keyed', scope: 'session' })
    core.register('test.keyed', SessionComp, { key: 'a' })
    expect(() => core.register('test.keyed', SessionComp, { key: 'a' })).toThrow('key "a"')
    // Statically rejected since RegisterArgs made keyed options mandatory;
    // the runtime guard stays for dynamically-composed callers.
    // @ts-expect-error keyed registration requires options
    expect(() => core.register('test.keyed', SessionComp)).toThrow('requires options.key')
    expect(() => core.register('test.keyed', SessionComp, { key: 'b' })).not.toThrow()
  })

  it('list: duplicate id throws, missing id throws, entries sort by order stably', () => {
    const core = new SlotCore()
    core.define('test.list', { kind: 'list', scope: 'root' })
    core.register('test.list', Comp, { id: 'c', order: 10 })
    core.register('test.list', Comp, { id: 'a' })
    core.register('test.list', Comp, { id: 'b' })
    expect(() => core.register('test.list', Comp, { id: 'a' })).toThrow('id "a"')
    // @ts-expect-error list registration requires options (static since RegisterArgs)
    expect(() => core.register('test.list', Comp)).toThrow('requires options.id')
    const ids = core.entries('test.list').map(e => (e.options as { id: string }).id)
    expect(ids).toEqual(['a', 'b', 'c'])
  })

  it('spec() exposes the definition; define disposer clears spec and entries', () => {
    const core = new SlotCore()
    const dispose = core.define('test.single', { kind: 'single', scope: 'root' })
    core.register('test.single', Comp)
    expect(core.spec('test.single')).toEqual({ kind: 'single', scope: 'root' })
    dispose()
    expect(core.spec('test.single')).toBeUndefined()
    expect(core.entries('test.single')).toHaveLength(0)
    expect(() => core.register('test.single', Comp)).toThrow('not defined')
  })

  it('disposers are idempotent and stale disposers after redefine are no-ops', () => {
    const core = new SlotCore()
    const disposeDef = core.define('test.single', { kind: 'single', scope: 'root' })
    const disposeReg = core.register('test.single', Comp)
    disposeReg()
    disposeReg()
    disposeDef()
    disposeDef()
    core.define('test.single', { kind: 'single', scope: 'root' })
    core.register('test.single', Comp)
    disposeDef()
    disposeReg()
    expect(core.spec('test.single')).toBeDefined()
    expect(core.entries('test.single')).toHaveLength(1)
  })
})

describe('SlotCore subscription surface', () => {
  it('entries() returns a stable cached reference between mutations', () => {
    const core = new SlotCore()
    core.define('test.list', { kind: 'list', scope: 'root' })
    core.register('test.list', Comp, { id: 'a' })
    const first = core.entries('test.list')
    expect(core.entries('test.list')).toBe(first)
    core.register('test.list', Comp, { id: 'b' })
    expect(core.entries('test.list')).not.toBe(first)
  })

  it('bumps version synchronously but batches notifications per microtask', async () => {
    const core = new SlotCore()
    const fn = vi.fn()
    core.subscribe('test.list', fn)
    core.define('test.list', { kind: 'list', scope: 'root' })
    core.register('test.list', Comp, { id: 'a' })
    core.register('test.list', Comp, { id: 'b' })
    expect(core.getVersion('test.list')).toBe(3)
    expect(fn).not.toHaveBeenCalled()
    await flushMicrotasks()
    expect(fn).toHaveBeenCalledTimes(1)
    core.register('test.list', Comp, { id: 'c' })
    await flushMicrotasks()
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('notifies only subscribers of the touched key; unsubscribe stops delivery', async () => {
    const core = new SlotCore()
    const single = vi.fn()
    const list = vi.fn()
    core.subscribe('test.single', single)
    const unsubscribe = core.subscribe('test.list', list)
    core.define('test.single', { kind: 'single', scope: 'root' })
    await flushMicrotasks()
    expect(single).toHaveBeenCalledTimes(1)
    expect(list).not.toHaveBeenCalled()
    unsubscribe()
    core.define('test.list', { kind: 'list', scope: 'root' })
    await flushMicrotasks()
    expect(list).not.toHaveBeenCalled()
  })

  it('a mutation from inside a flush re-schedules instead of being lost', async () => {
    const core = new SlotCore()
    core.define('test.list', { kind: 'list', scope: 'root' })
    const seen: number[] = []
    let reentered = false
    core.subscribe('test.list', () => {
      seen.push(core.getVersion('test.list'))
      if (!reentered) {
        reentered = true
        core.register('test.list', Comp, { id: 'reentrant' })
      }
    })
    core.register('test.list', Comp, { id: 'a' })
    await flushMicrotasks()
    await flushMicrotasks()
    expect(seen).toHaveLength(2)
    expect(core.entries('test.list')).toHaveLength(2)
  })

  it('getVersion is 0 for untouched keys and monotonic across redefine', () => {
    const core = new SlotCore()
    expect(core.getVersion('test.single')).toBe(0)
    const dispose = core.define('test.single', { kind: 'single', scope: 'root' })
    dispose()
    const after = core.getVersion('test.single')
    core.define('test.single', { kind: 'single', scope: 'root' })
    expect(core.getVersion('test.single')).toBeGreaterThan(after)
  })

  it('onMutate fires synchronously per mutation with the touched key', () => {
    const core = new SlotCore()
    const keys: string[] = []
    const off = core.onMutate(key => keys.push(key))
    core.define('test.single', { kind: 'single', scope: 'root' })
    core.define('test.list', { kind: 'list', scope: 'root' })
    core.register('test.list', Comp, { id: 'a' })
    expect(keys).toEqual(['test.single', 'test.list', 'test.list'])
    off()
    core.register('test.list', Comp, { id: 'b' })
    expect(keys).toHaveLength(3)
  })
})

describe('SlotOptions typing', () => {
  it('rejects kind-mismatched options and scope-mismatched inject bindings', () => {
    // Compile-time negatives only: the body never runs (some rejected shapes
    // would be legal at runtime, which validates kinds, not props).
    const typeNegatives = (core: SlotCore) => {
      // @ts-expect-error single options take no key
      core.register('test.single', Comp, { key: 'x' })
      // @ts-expect-error list options require id
      core.register('test.list', Comp, { order: 1 })
      // @ts-expect-error keyed options require key
      core.register('test.keyed', SessionComp, { inject: () => ({}) })
      // @ts-expect-error component props must match the SlotMap contract
      core.register('test.single', SessionComp)
      // @ts-expect-error kind must match the SlotMap declaration
      core.define('test.single', { kind: 'list', scope: 'root' })
      const rootInject: SlotOptions<{ kind: 'single'; scope: 'root'; props: { label: string } }> = {
        // @ts-expect-error root slots bind RootBinding, which has no sessionId
        inject: (b: RootBinding) => ({ sessionId: b.sessionId }),
      }
      return rootInject
    }
    expect(typeNegatives).toBeTypeOf('function')

    const sessionInject: SlotOptions<{ kind: 'keyed'; scope: 'session'; props: { label: string } }> = {
      key: 'k',
      inject: (b: SessionBinding) => ({ sessionId: b.sessionId }),
    }
    expect(sessionInject.key).toBe('k')
  })
})
