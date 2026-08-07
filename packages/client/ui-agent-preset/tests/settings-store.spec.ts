/**
 * The agent-preset settings controller: it derives both the options and the
 * current default from one roster call, writes only the `default` field, and
 * treats an empty roster as "this deployment composes no presets" rather than
 * as a failure.
 */

import { describe, expect, it } from 'vitest'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import {
  AGENT_PRESET_SETTINGS_NS, AgentPresetSettingsController,
} from '../src/client/settings-store.ts'
import { AgentPresetSeatController } from '../src/client/seat-store.ts'

interface Recorded { ns: string; patch: unknown }

/** A client whose roster and write outcome the test controls. */
function fakeApi(
  presets: { id: string; trust: 'system' | 'user'; isDefault: boolean }[],
  options: { writes?: Recorded[]; failWrite?: string; failList?: string; readOnly?: boolean } = {},
): IApiClient {
  return {
    agentPresets: {
      list: () => Promise.resolve(options.failList === undefined
        ? { rpcId: 'r', result: { ok: true as const, value: { presets } } }
        : { rpcId: 'r', result: { ok: false as const, error: { code: 'internal', message: options.failList, details: {} } } }),
    },
    settings: {
      // Loopback-only in production; a read-only provider answers writable:false
      // and the row disables its control instead of offering a refused write.
      describe: () => Promise.resolve({
        rpcId: 'r',
        result: {
          ok: true as const,
          value: { writable: options.readOnly !== true, hasDocument: true, namespaces: [] },
        },
      }),
      update: (payload: { ns: string; patch: unknown }) => {
        options.writes?.push({ ns: payload.ns, patch: payload.patch })
        if (options.failWrite !== undefined) {
          return Promise.resolve({ rpcId: 'r', result: { ok: false as const, error: { code: 'internal', message: options.failWrite, details: {} } } })
        }
        // A committed write moves the roster's default, exactly as the host does.
        for (const preset of presets) {
          preset.isDefault = preset.id === (payload.patch as { default?: string }).default
        }
        return Promise.resolve({ rpcId: 'r', result: { ok: true as const, value: {} } })
      },
    },
  } as unknown as IApiClient
}

describe('the agent-preset settings controller', () => {
  it('disables the control when this browser may not write settings', async () => {
    const controller = new AgentPresetSettingsController(fakeApi([
      { id: 'standard', trust: 'system', isDefault: true },
    ], { readOnly: true }))

    await controller.load()

    // `settings.describe` is loopback-only and reports a read-only provider;
    // offering a control whose write answers `settings-not-exposed` would
    // promise a switch the host refuses.
    expect(controller.store.getSnapshot().writable).toBe(false)
    expect(controller.store.getSnapshot().currentValue).toBe('standard')
  })

  it('derives options and the current default from one roster call', async () => {
    const controller = new AgentPresetSettingsController(fakeApi([
      { id: 'standard', trust: 'system', isDefault: true },
      { id: 'mine', trust: 'user', isDefault: false },
    ]))

    await controller.load()

    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.currentValue).toBe('standard')
    expect(state.options).toEqual([
      { id: 'standard', trust: 'system' },
      { id: 'mine', trust: 'user' },
    ])
  })

  it('reports an empty roster as unavailable, not as an error', async () => {
    const controller = new AgentPresetSettingsController(fakeApi([]))

    await controller.load()

    // A deployment composing no presets is valid: every session shares the
    // host composition and the row renders nothing.
    expect(controller.store.getSnapshot().status).toBe('unavailable')
    expect(controller.store.getSnapshot().error).toBeNull()
  })

  it('writes only the default field, into the agent-presets namespace', async () => {
    const writes: Recorded[] = []
    const controller = new AgentPresetSettingsController(fakeApi([
      { id: 'standard', trust: 'system', isDefault: true },
      { id: 'core-web', trust: 'system', isDefault: false },
    ], { writes }))
    await controller.load()

    await controller.select('core-web')

    expect(writes).toEqual([{ ns: AGENT_PRESET_SETTINGS_NS, patch: { default: 'core-web' } }])
    expect(controller.store.getSnapshot().currentValue).toBe('core-web')
  })

  it('restores the previous value and surfaces the message when the write fails', async () => {
    const controller = new AgentPresetSettingsController(fakeApi([
      { id: 'standard', trust: 'system', isDefault: true },
      { id: 'core-web', trust: 'system', isDefault: false },
    ], { failWrite: 'read-only settings' }))
    await controller.load()

    await controller.select('core-web')

    const state = controller.store.getSnapshot()
    expect(state.currentValue).toBe('standard')
    expect(state.error).toBe('read-only settings')
    expect(state.status).toBe('ready')
  })

  it('ignores a pick that is already the default', async () => {
    const writes: Recorded[] = []
    const controller = new AgentPresetSettingsController(fakeApi([
      { id: 'standard', trust: 'system', isDefault: true },
    ], { writes }))
    await controller.load()

    await controller.select('standard')

    expect(writes).toEqual([])
  })

  it('surfaces a roster failure without claiming the deployment has no presets', async () => {
    const controller = new AgentPresetSettingsController(fakeApi([], { failList: 'host down' }))

    await controller.load()

    const state = controller.store.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.error).toBe('host down')
  })

  it('falls back to the first preset when the roster names no default', async () => {
    const controller = new AgentPresetSettingsController(fakeApi([
      { id: 'standard', trust: 'system', isDefault: false },
      { id: 'core-web', trust: 'system', isDefault: false },
    ]))

    await controller.load()

    // The row has to show something the menu can select; the first row of the
    // roster is the deployment's own order.
    expect(controller.store.getSnapshot().currentValue).toBe('standard')
  })

  it('reads a rejection that is not an Error', async () => {
    const rejecting = (value: unknown): IApiClient => ({
      agentPresets: {
        list: () => Promise.resolve({
          rpcId: 'r',
          result: { ok: true as const, value: { presets: [{ id: 'standard', trust: 'system', isDefault: true }] } },
        }),
      },
      settings: {
        describe: () => Promise.resolve({
          rpcId: 'r', result: { ok: true as const, value: { writable: true, hasDocument: true, namespaces: [] } },
        }),
        update: () => Promise.reject(value),
      },
    } as unknown as IApiClient)
    const controller = new AgentPresetSettingsController(rejecting('socket closed'))
    await controller.load()

    await controller.select('core-web')

    // A transport may reject with anything; the row still has to say something.
    expect(controller.store.getSnapshot().error).toBe('socket closed')

    const failing = new AgentPresetSettingsController({
      agentPresets: { list: () => Promise.reject('offline') },
      settings: {
        describe: () => Promise.resolve({
          rpcId: 'r', result: { ok: true as const, value: { writable: true, hasDocument: true, namespaces: [] } },
        }),
      },
    } as unknown as IApiClient)

    await failing.load()

    expect(failing.store.getSnapshot().error).toBe('offline')
  })

  it('lets one roster call in flight answer for every caller', async () => {
    let answer = (): void => {}
    const pending = new Promise<void>((resolve) => { answer = resolve })
    let calls = 0
    const api = {
      agentPresets: {
        list: async () => {
          calls += 1
          await pending
          return { rpcId: 'r', result: { ok: true as const, value: { presets: [] } } }
        },
      },
      settings: {
        describe: () => Promise.resolve({
          rpcId: 'r', result: { ok: true as const, value: { writable: true, hasDocument: true, namespaces: [] } },
        }),
      },
    } as unknown as IApiClient
    const controller = new AgentPresetSettingsController(api)

    // Both the settings surface and a reconnect can ask at once; a second
    // request must not race a roster the first is already reading.
    const first = controller.load()
    await controller.load()
    answer()
    await first

    expect(calls).toBe(1)
  })

  it('reports a transport failure rather than throwing at the row', async () => {
    const api = {
      agentPresets: { list: () => Promise.reject(new Error('offline')) },
      settings: {
        describe: () => Promise.resolve({
          rpcId: 'r', result: { ok: true as const, value: { writable: true, hasDocument: true, namespaces: [] } },
        }),
        update: () => Promise.reject(new Error('socket closed')),
      },
    } as unknown as IApiClient
    const controller = new AgentPresetSettingsController(api)

    await controller.load()

    expect(controller.store.getSnapshot().status).toBe('error')
    expect(controller.store.getSnapshot().error).toBe('offline')
  })

  it('restores the previous default when the write never reached the host', async () => {
    const presets = [
      { id: 'standard', trust: 'system' as const, isDefault: true },
      { id: 'core-web', trust: 'system' as const, isDefault: false },
    ]
    const api = {
      agentPresets: {
        list: () => Promise.resolve({ rpcId: 'r', result: { ok: true as const, value: { presets } } }),
      },
      settings: {
        describe: () => Promise.resolve({
          rpcId: 'r', result: { ok: true as const, value: { writable: true, hasDocument: true, namespaces: [] } },
        }),
        update: () => Promise.reject(new Error('socket closed')),
      },
    } as unknown as IApiClient
    const controller = new AgentPresetSettingsController(api)
    await controller.load()

    await controller.select('core-web')

    expect(controller.store.getSnapshot().currentValue).toBe('standard')
    expect(controller.store.getSnapshot().status).toBe('ready')
    expect(controller.store.getSnapshot().error).toBe('socket closed')
  })
})

describe('the composer seat controller', () => {
  /** A seat over a fixed session summary. */
  function seat(
    presets: { id: string; trust: 'system' | 'user'; isDefault: boolean }[],
    summary: { blank: boolean; agentPreset?: string } | undefined,
    options: { writes?: Recorded[]; failSelect?: string } = {},
  ): AgentPresetSeatController {
    const api = {
      agentPresets: {
        list: () => Promise.resolve({ rpcId: 'r', result: { ok: true as const, value: { presets } } }),
        select: (payload: { agentPreset: string }) => {
          options.writes?.push({ ns: 'select', patch: payload.agentPreset })
          return Promise.resolve(options.failSelect === undefined
            ? { rpcId: 'r', result: { ok: true as const, value: { agentPreset: payload.agentPreset } } }
            : { rpcId: 'r', result: { ok: false as const, error: { code: 'agent-preset-locked', message: options.failSelect, details: {} } } })
        },
      },
    } as unknown as IApiClient
    return new AgentPresetSeatController(api, 's1' as never, () => summary)
  }

  const ROSTER: { id: string; trust: 'system' | 'user'; isDefault: boolean }[] = [
    { id: 'standard', trust: 'system', isDefault: true },
    { id: 'core-web', trust: 'system', isDefault: false },
  ]

  it('shows what the session runs, not the deployment default', async () => {
    const controller = seat(ROSTER, { blank: true, agentPreset: 'core-web' })

    await controller.load()

    // A resumed session runs what it was created with; showing `standard`
    // because it is the current default would be a lie about this session.
    expect(controller.store.getSnapshot().current).toBe('core-web')
    expect(controller.store.getSnapshot().switchable).toBe(true)
  })

  it('falls back to the roster default when the session records none', async () => {
    const controller = seat(ROSTER, { blank: true })

    await controller.load()

    expect(controller.store.getSnapshot().current).toBe('standard')
  })

  it('is not switchable once the conversation has started', async () => {
    const controller = seat(ROSTER, { blank: false, agentPreset: 'standard' })

    await controller.load()

    expect(controller.store.getSnapshot().switchable).toBe(false)
  })

  it('refuses to switch a session that already started', async () => {
    const writes: Recorded[] = []
    const controller = seat(ROSTER, { blank: false, agentPreset: 'standard' }, { writes })
    await controller.load()

    await controller.select('core-web')

    // The host enforces the same rule; the seat simply never asks.
    expect(writes).toEqual([])
    expect(controller.store.getSnapshot().current).toBe('standard')
  })

  it('switches a blank session and keeps the host\'s answer', async () => {
    const writes: Recorded[] = []
    const controller = seat(ROSTER, { blank: true, agentPreset: 'standard' }, { writes })
    await controller.load()

    await controller.select('core-web')

    expect(writes).toEqual([{ ns: 'select', patch: 'core-web' }])
    expect(controller.store.getSnapshot().current).toBe('core-web')
  })

  it('restores the previous value when the host rejects the switch', async () => {
    const controller = seat(ROSTER, { blank: true, agentPreset: 'standard' }, { failSelect: 'already started' })
    await controller.load()

    await controller.select('core-web')

    const state = controller.store.getSnapshot()
    expect(state.current).toBe('standard')
    expect(state.error).toBe('already started')
  })

  it('reports no options when the session is unknown to the list yet', async () => {
    const controller = seat([], undefined)

    await controller.load()

    expect(controller.store.getSnapshot().options).toEqual([])
    expect(controller.store.getSnapshot().switchable).toBe(false)
  })

  it('reads a rejection that is not an Error', async () => {
    const api = {
      agentPresets: {
        list: () => Promise.reject('offline'),
        select: () => Promise.reject('socket closed'),
      },
    } as unknown as IApiClient
    const controller = new AgentPresetSeatController(api, 's1' as never, () => ({ blank: true }))

    await controller.load()
    expect(controller.store.getSnapshot().error).toBe('offline')

    controller.store.set({ ...controller.store.getSnapshot(), current: 'standard', switchable: true })
    await controller.select('core-web')

    // A transport may reject with anything; the seat still has to say something.
    expect(controller.store.getSnapshot().error).toBe('socket closed')
  })

  it('surfaces a roster failure and keeps the seat unswitchable', async () => {
    const api = {
      agentPresets: {
        list: () => Promise.resolve({
          rpcId: 'r',
          result: { ok: false as const, error: { code: 'internal', message: 'roster down', details: {} } },
        }),
      },
    } as unknown as IApiClient
    const controller = new AgentPresetSeatController(api, 's1' as never, () => ({ blank: true }))

    await controller.load()

    expect(controller.store.getSnapshot().error).toBe('roster down')
    expect(controller.store.getSnapshot().switchable).toBe(false)
  })

  it('reports a transport failure on either call rather than throwing at the seat', async () => {
    const api = {
      agentPresets: {
        list: () => Promise.reject(new Error('offline')),
        select: () => Promise.reject(new Error('socket closed')),
      },
    } as unknown as IApiClient
    const controller = new AgentPresetSeatController(api, 's1' as never, () => ({ blank: true }))

    await controller.load()
    expect(controller.store.getSnapshot().error).toBe('offline')

    // A switch that never reached the host leaves the session on what it ran.
    controller.store.set({ ...controller.store.getSnapshot(), current: 'standard', switchable: true })
    await controller.select('core-web')

    expect(controller.store.getSnapshot().current).toBe('standard')
    expect(controller.store.getSnapshot().busy).toBe(false)
    expect(controller.store.getSnapshot().error).toBe('socket closed')
  })
})
