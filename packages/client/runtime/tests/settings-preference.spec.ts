import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import type { RpcResponse, SettingsNamespaceView } from '@deepseek-ai/dsh-client-connection/client'
import {
  bindSettingsPreference, SettingsPreferenceController,
} from '../src/client/settings-preference.ts'

type Preference = 'light' | 'dark' | 'system'

let rpc = 0

function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `preference-${rpc++}` as never, result: { ok: true, value } }
}

function rejected<T>(): RpcResponse<T> {
  return {
    rpcId: `preference-${rpc++}` as never,
    result: {
      ok: false,
      error: { code: 'settings-rejected', message: 'conflict', details: { ns: 'ui-test' } },
    },
  }
}

function view(value: unknown, revision = 0): SettingsNamespaceView {
  return {
    ns: 'ui-test',
    schema: {},
    value,
    applies: 'live',
    secrets: [],
    revision,
  }
}

function described(value: unknown, revision = 0) {
  return ok({ writable: true, hasDocument: true, namespaces: [view(value, revision)] })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function spec(values: Preference[]) {
  return {
    namespace: 'ui-test',
    field: 'preference',
    decode: (value: unknown): Preference | undefined =>
      value === 'light' || value === 'dark' || value === 'system' ? value : undefined,
    sync: (value: Preference) => { values.push(value) },
  }
}

describe('SettingsPreferenceController', () => {
  it('loads only a valid owned field and contains unavailable transports', async () => {
    const values: Preference[] = []
    const describe = vi.fn()
      .mockResolvedValueOnce(described({ preference: 'dark' }, 3))
      .mockResolvedValueOnce(ok({ writable: true, hasDocument: true, namespaces: [] }))
      .mockResolvedValueOnce(described({ preference: 'sepia' }))
      .mockResolvedValueOnce(described(null))
      .mockResolvedValueOnce(rejected())
      .mockRejectedValueOnce(new Error('offline'))
    const controller = new SettingsPreferenceController({ settings: { describe } } as never, spec(values))
    for (let i = 0; i < 6; i++) await controller.load()
    expect(values).toEqual(['dark'])
  })

  it('serializes rapid writes, carries revisions, and publishes only the latest settlement', async () => {
    const first = deferred<RpcResponse<SettingsNamespaceView>>()
    const values: Preference[] = []
    const describe = vi.fn().mockResolvedValue(described({ preference: 'system' }, 4))
    const mutate = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(ok(view({ preference: 'light' }, 6)))
    const controller = new SettingsPreferenceController(
      { settings: { describe, mutate } } as never,
      spec(values),
    )
    await controller.load()
    const dark = controller.persist('dark')
    const light = controller.persist('light')
    await vi.waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    first.resolve(ok(view({ preference: 'dark' }, 5)))
    await Promise.all([dark, light])
    expect(values).toEqual(['system', 'light'])
    expect(mutate).toHaveBeenNthCalledWith(1, {
      ns: 'ui-test',
      ops: [{ op: 'set', path: ['preference'], value: 'dark' }],
      expectedRevision: 4,
    })
    expect(mutate).toHaveBeenNthCalledWith(2, {
      ns: 'ui-test',
      ops: [{ op: 'set', path: ['preference'], value: 'light' }],
      expectedRevision: 5,
    })
  })

  it('recovers the latest rejected or thrown write from Host state', async () => {
    const values: Preference[] = []
    const describe = vi.fn()
      .mockResolvedValueOnce(described({ preference: 'system' }, 2))
      .mockResolvedValueOnce(described({ preference: 'light' }, 3))
    const mutate = vi.fn()
      .mockResolvedValueOnce(rejected())
      .mockRejectedValueOnce(new Error('offline'))
    const controller = new SettingsPreferenceController(
      { settings: { describe, mutate } } as never,
      spec(values),
    )
    await controller.persist('dark')
    await controller.persist('system')
    expect(values).toEqual(['system', 'light'])
  })

  it('does not recover superseded rejected or thrown writes', async () => {
    const values: Preference[] = []
    const describe = vi.fn()
    const mutate = vi.fn()
      .mockResolvedValueOnce(rejected())
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(ok(view({ preference: 'light' }, 3)))
    const controller = new SettingsPreferenceController(
      { settings: { describe, mutate } } as never,
      spec(values),
    )
    await Promise.all([
      controller.persist('dark'),
      controller.persist('system'),
      controller.persist('light'),
    ])
    expect(describe).not.toHaveBeenCalled()
    expect(values).toEqual(['light'])
  })

  it('keeps the queue usable when a target callback throws', async () => {
    const describe = vi.fn()
      .mockResolvedValueOnce(described({ preference: 'dark' }))
      .mockResolvedValueOnce(described({ preference: 'sepia' }))
    const controller = new SettingsPreferenceController(
      { settings: { describe } } as never,
      { ...spec([]), sync: () => { throw new Error('target failed') } },
    )
    await expect(controller.load()).rejects.toThrow('target failed')
    await expect(controller.load()).resolves.toBeUndefined()
  })

  it('cancels queued and post-dispose writes while draining the in-flight mutation', async () => {
    const first = deferred<RpcResponse<SettingsNamespaceView>>()
    const mutate = vi.fn().mockReturnValue(first.promise)
    const values: Preference[] = []
    const controller = new SettingsPreferenceController(
      { settings: { mutate } } as never,
      spec(values),
    )
    const dark = controller.persist('dark')
    await vi.waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    const light = controller.persist('light')
    let stopped = false
    const stop = controller.dispose().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    first.resolve(ok(view({ preference: 'dark' }, 1)))
    await Promise.all([dark, light, stop])
    await controller.persist('system')
    await controller.load()
    expect(mutate).toHaveBeenCalledOnce()
    expect(values).toEqual([])
  })

  it('keeps remote-browser preferences in memory without Host calls', async () => {
    const describe = vi.fn()
    const mutate = vi.fn()
    const controller = new SettingsPreferenceController(
      { settings: { describe, mutate } } as never,
      spec([]),
      'memory',
    )
    await controller.load()
    await controller.persist('dark')
    await controller.dispose()
    expect(describe).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
  })
})

describe('bindSettingsPreference', () => {
  it('subscribes before the initial read and converges to the latest queued invalidation', async () => {
    const initial = deferred<ReturnType<typeof described>>()
    const describe = vi.fn()
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValueOnce(described({ preference: 'light' }, 2))
      .mockResolvedValueOnce(described({ preference: 'system' }, 3))
    const ctx = new Context()
    ctx.provide('connection', {
      api: { settings: { describe } },
      isLoopback: true,
    } as never)
    const values: Preference[] = []
    const fiber = ctx.plugin({
      inject: ['connection'],
      apply: (scope: Context) => { bindSettingsPreference(scope, spec(values)) },
    })
    await fiber.await()
    await vi.waitFor(() => { expect(describe).toHaveBeenCalledOnce() })
    ctx.emit('settings/changed', 'unrelated')
    ctx.emit('settings/changed', 'ui-test')
    ctx.emit('connection/reset')
    initial.resolve(described({ preference: 'dark' }, 1))
    await vi.waitFor(() => { expect(describe).toHaveBeenCalledTimes(3) })
    await vi.waitFor(() => { expect(values).toEqual(['system']) })
    await fiber.dispose()
    ctx.emit('settings/changed', 'ui-test')
    await Promise.resolve()
    expect(describe).toHaveBeenCalledTimes(3)
  })

  it('binds a remote browser in memory without starting a settings read', async () => {
    const describe = vi.fn()
    const ctx = new Context()
    ctx.provide('connection', {
      api: { settings: { describe } },
      isLoopback: false,
    } as never)
    const fiber = ctx.plugin({
      inject: ['connection'],
      apply: (scope: Context) => { bindSettingsPreference(scope, spec([])) },
    })
    await fiber.await()
    await fiber.dispose()
    expect(describe).not.toHaveBeenCalled()
  })
})
