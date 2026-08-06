import { describe, expect, it, vi } from 'vitest'
import type { RpcResponse, SettingsNamespaceView } from '@deepseek-ai/dsh-client-connection/client'
import {
  THEME_PREFERENCE_FIELD, THEME_SETTINGS_NAMESPACE, ThemeSettingsController,
  type ThemePreference,
} from '@deepseek-ai/dsh-client-ui-theme/client'

let rpc = 0

function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `theme-${rpc++}` as never, result: { ok: true, value } }
}

function view(preference: unknown = 'system'): SettingsNamespaceView {
  return {
    ns: THEME_SETTINGS_NAMESPACE,
    schema: {},
    value: { [THEME_PREFERENCE_FIELD]: preference },
    applies: 'live',
    secrets: [],
    revision: 0,
  }
}

function described(preference: unknown = 'system') {
  return ok({ writable: true, hasDocument: true, namespaces: [view(preference)] })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function target() {
  const values: ThemePreference[] = []
  return { values, syncPreference: (preference: ThemePreference) => { values.push(preference) } }
}

describe('ThemeSettingsController', () => {
  it('loads a valid Host value and ignores unavailable or malformed namespaces', async () => {
    const receiver = target()
    const describe = vi.fn()
      .mockResolvedValueOnce(described('dark'))
      .mockResolvedValueOnce(ok({ writable: true, hasDocument: true, namespaces: [] }))
      .mockResolvedValueOnce(described('sepia'))
      .mockResolvedValueOnce(ok({ writable: true, hasDocument: true, namespaces: [{ ...view(), value: null }] }))
      .mockResolvedValueOnce({
        rpcId: 'failed' as never,
        result: { ok: false as const, error: { code: 'internal' as const, message: 'offline', details: {} } },
      })
      .mockRejectedValueOnce(new Error('transport offline'))
    const controller = new ThemeSettingsController({ settings: { describe } } as never, receiver)
    for (let i = 0; i < 6; i++) await controller.load()
    expect(receiver.values).toEqual(['dark'])
  })

  it('persists ordered rapid selections and publishes only the latest settlement', async () => {
    const first = deferred<ReturnType<typeof ok<SettingsNamespaceView>>>()
    const calls: string[] = []
    const mutate = vi.fn(async (request: { ops: { value: string }[] }) => {
      const preference = request.ops[0]!.value
      calls.push(preference)
      if (preference === 'dark') return first.promise
      return ok(view(preference))
    })
    const receiver = target()
    const controller = new ThemeSettingsController({ settings: { mutate } } as never, receiver)
    const dark = controller.persist('dark')
    const light = controller.persist('light')
    await Promise.resolve()
    expect(calls).toEqual(['dark'])
    first.resolve(ok(view('dark')))
    await Promise.all([dark, light])
    expect(calls).toEqual(['dark', 'light'])
    expect(receiver.values).toEqual(['light'])
    expect(mutate).toHaveBeenNthCalledWith(1, {
      ns: THEME_SETTINGS_NAMESPACE,
      ops: [{ op: 'set', path: [THEME_PREFERENCE_FIELD], value: 'dark' }],
    })
  })

  it('reloads after a rejected latest write and contains stale reads and disposal', async () => {
    const stale = deferred<ReturnType<typeof described>>()
    const describe = vi.fn()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce(described('system'))
    const mutate = vi.fn().mockResolvedValue({
      rpcId: 'rejected' as never,
      result: { ok: false as const, error: { code: 'settings-rejected' as const, message: 'disk full', details: {} } },
    })
    const receiver = target()
    const controller = new ThemeSettingsController({ settings: { describe, mutate } } as never, receiver)
    const oldLoad = controller.load()
    await vi.waitFor(() => { expect(describe).toHaveBeenCalledOnce() })
    await controller.persist('dark')
    stale.resolve(described('light'))
    await oldLoad
    expect(receiver.values).toEqual(['system'])

    const disposedRead = deferred<ReturnType<typeof described>>()
    describe.mockImplementationOnce(() => disposedRead.promise)
    const pending = controller.load()
    controller.dispose()
    disposedRead.resolve(described('dark'))
    await pending
    expect(receiver.values).toEqual(['system'])
  })

  it('keeps remote-browser persistence in memory without calling Host settings', async () => {
    const describe = vi.fn()
    const mutate = vi.fn()
    const receiver = target()
    const controller = new ThemeSettingsController({ settings: { describe, mutate } } as never, receiver, 'memory')
    await controller.load()
    await controller.persist('dark')
    expect(describe).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
    expect(receiver.values).toEqual([])
  })

  it('reloads after a thrown write and ignores a malformed success response', async () => {
    const receiver = target()
    const describe = vi.fn().mockResolvedValue(described('light'))
    const mutate = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(ok(view('sepia')))
    const controller = new ThemeSettingsController({ settings: { describe, mutate } } as never, receiver)
    await controller.persist('dark')
    await controller.persist('system')
    expect(receiver.values).toEqual(['light'])
  })

  it('lets an explicit refresh supersede a stale rejected write', async () => {
    const rejected = deferred<never>()
    const receiver = target()
    const describe = vi.fn().mockResolvedValue(described('system'))
    const mutate = vi.fn().mockReturnValue(rejected.promise)
    const controller = new ThemeSettingsController({ settings: { describe, mutate } } as never, receiver)
    const write = controller.persist('dark')
    await vi.waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    const refresh = controller.load()
    rejected.reject(new Error('stale rejection'))
    await Promise.all([write, refresh])
    expect(receiver.values).toEqual(['system'])
    expect(describe).toHaveBeenCalledOnce()
  })
})
