/**
 * Card controllers: how a scope snapshot becomes card state, and which wire
 * call each action reaches.
 */

import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { AgentLoopCardController, type AgentLoopSettings } from '../src/client/agent-loop-store.ts'
import { BashCardController, type BashSettings } from '../src/client/bash-store.ts'
import { WebSearchCardController, type WebSearchSettings } from '../src/client/web-search-store.ts'

function credentialsApi(configured: boolean) {
  const describe = vi.fn(() => Promise.resolve({
    rpcId: 'c-1' as never,
    result: { ok: true as const, value: { credentials: { DEEPSEEK_API_KEY: { configured, writable: true } } } },
  }))
  const set = vi.fn(() => Promise.resolve({ rpcId: 'c-2' as never, result: { ok: true as const, value: {} } }))
  return { api: { credentials: { describe, set } } as never, describe, set }
}

describe('BashCardController', () => {
  it('publishes the effective value and marks only user-layer fields overridden', () => {
    const host = stubSettingsScope<BashSettings>()
    const controller = new BashCardController(host.scope)

    host.publish({
      status: 'ready',
      writable: true,
      revision: 3,
      value: { timeoutMs: 5_000, maxOutputBytes: 64_000 },
      base: { timeoutMs: 60_000, maxOutputBytes: 64_000 },
      user: { timeoutMs: 5_000 },
    })

    expect(controller.store.getSnapshot()).toMatchObject({
      available: true,
      writable: true,
      timeoutMs: { value: 5_000, overridden: true },
      maxOutputBytes: { value: 64_000, overridden: false },
    })
  })

  it('treats an override equal to the composition default as an override', () => {
    const host = stubSettingsScope<BashSettings>()
    const controller = new BashCardController(host.scope)

    host.publish({
      status: 'ready',
      writable: true,
      value: { timeoutMs: 60_000 },
      base: { timeoutMs: 60_000 },
      user: { timeoutMs: 60_000 },
    })

    expect(controller.store.getSnapshot().timeoutMs).toEqual({ value: 60_000, overridden: true })
  })

  it('routes each action to its field write', async () => {
    const host = stubSettingsScope<BashSettings>()
    const controller = new BashCardController(host.scope)
    host.publish({ status: 'ready', writable: true, value: { timeoutMs: 5_000 } })
    const actions = controller.inject()

    actions.setTimeoutMs(9_000)
    actions.resetTimeoutMs()
    actions.setMaxOutputBytes(1_024)
    actions.resetMaxOutputBytes()
    await Promise.resolve()

    expect(host.set.mock.calls).toEqual([['timeoutMs', 9_000], ['maxOutputBytes', 1_024]])
    expect(host.unset.mock.calls).toEqual([['timeoutMs'], ['maxOutputBytes']])
  })

  it('stays unavailable while the namespace is not served', () => {
    const host = stubSettingsScope<BashSettings>()
    const controller = new BashCardController(host.scope)

    host.publish({ status: 'unavailable' })

    expect(controller.store.getSnapshot().available).toBe(false)
  })
})

describe('AgentLoopCardController', () => {
  it('publishes the cap and routes its two actions', async () => {
    const host = stubSettingsScope<AgentLoopSettings>()
    const controller = new AgentLoopCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: { maxParallelToolCalls: 2 },
      base: { maxParallelToolCalls: 10 },
      user: { maxParallelToolCalls: 2 },
    })
    expect(controller.store.getSnapshot().maxParallelToolCalls).toEqual({ value: 2, overridden: true })

    const actions = controller.inject()
    actions.setMaxParallelToolCalls(4)
    actions.resetMaxParallelToolCalls()
    await Promise.resolve()

    expect(host.set).toHaveBeenCalledWith('maxParallelToolCalls', 4)
    expect(host.unset).toHaveBeenCalledWith('maxParallelToolCalls')
  })

  it('reports a read-only document so the card can disable its controls', () => {
    const host = stubSettingsScope<AgentLoopSettings>()
    const controller = new AgentLoopCardController(host.scope)

    host.publish({ status: 'ready', writable: false, value: { maxParallelToolCalls: 10 } })

    expect(controller.store.getSnapshot().writable).toBe(false)
  })
})

describe('WebSearchCardController', () => {
  it('reads the credential state for the reference the section names', async () => {
    const host = stubSettingsScope<WebSearchSettings>()
    const credentials = credentialsApi(true)
    const controller = new WebSearchCardController(host.scope, credentials.api)
    await vi.waitFor(() => { expect(credentials.describe).toHaveBeenCalled() })

    host.publish({ status: 'ready', writable: true, value: { baseURL: 'https://search.test/v1' } })
    await vi.waitFor(() => {
      expect(controller.store.getSnapshot().apiKeyConfigured).toBe(true)
    })

    expect(controller.store.getSnapshot()).toMatchObject({
      baseURL: { value: 'https://search.test/v1', overridden: false },
      apiKeyRef: 'DEEPSEEK_API_KEY',
    })
  })

  it('writes the key through the credentials domain, never the settings section', async () => {
    const host = stubSettingsScope<WebSearchSettings>()
    const credentials = credentialsApi(false)
    const controller = new WebSearchCardController(host.scope, credentials.api)
    host.publish({ status: 'ready', writable: true, value: {} })

    controller.inject().setApiKey('ds-secret')
    await vi.waitFor(() => { expect(credentials.set).toHaveBeenCalled() })

    expect(credentials.set).toHaveBeenCalledWith({ ref: 'DEEPSEEK_API_KEY', value: 'ds-secret' })
    expect(host.set).not.toHaveBeenCalledWith('apiKey', expect.anything())
  })

  it('addresses the reference the section declares rather than the default', async () => {
    const host = stubSettingsScope<WebSearchSettings>()
    const credentials = credentialsApi(false)
    const controller = new WebSearchCardController(host.scope, credentials.api)
    host.publish({ status: 'ready', writable: true, value: { apiKeyEnv: 'SEARCH_KEY' } })

    controller.inject().setApiKey('ds-secret')
    await vi.waitFor(() => { expect(credentials.set).toHaveBeenCalled() })

    expect(credentials.set).toHaveBeenCalledWith({ ref: 'SEARCH_KEY', value: 'ds-secret' })
  })

  it('keeps the card usable when the credential read fails', async () => {
    const host = stubSettingsScope<WebSearchSettings>()
    const describe = vi.fn(() => Promise.reject(new Error('offline')))
    const controller = new WebSearchCardController(
      host.scope,
      { credentials: { describe, set: vi.fn() } } as never,
    )
    await vi.waitFor(() => { expect(describe).toHaveBeenCalled() })

    host.publish({ status: 'ready', writable: true, value: { baseURL: 'https://search.test/v1' } })

    expect(controller.store.getSnapshot()).toMatchObject({
      available: true,
      apiKeyConfigured: false,
      baseURL: { value: 'https://search.test/v1' },
    })
  })

  it('routes the endpoint and budget actions to their field writes', async () => {
    const host = stubSettingsScope<WebSearchSettings>()
    const credentials = credentialsApi(true)
    const controller = new WebSearchCardController(host.scope, credentials.api)
    host.publish({ status: 'ready', writable: true, value: {} })
    const actions = controller.inject()

    actions.setBaseUrl('https://other.test')
    actions.resetBaseUrl()
    actions.setMaxUses(3)
    actions.resetMaxUses()
    await Promise.resolve()

    expect(host.set.mock.calls).toEqual([['baseURL', 'https://other.test'], ['maxUses', 3]])
    expect(host.unset.mock.calls).toEqual([['baseURL'], ['maxUses']])
  })
})
