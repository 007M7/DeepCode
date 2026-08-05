/**
 * The agent-preset settings controller: it derives both the options and the
 * current default from one roster call, writes only the `default` field, and
 * treats an empty roster as "this deployment composes no presets" rather than
 * as a failure.
 */

import { describe, expect, it } from 'vitest'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import {
  AGENT_PRESET_SETTINGS_NS, AgentPresetSettingsController, messageOf,
} from '../src/client/settings-store.ts'
import { AgentPresetSeatController } from '../src/client/seat-store.ts'

interface Recorded { ns: string; patch: unknown }

/** A client whose roster and write outcome the test controls. */
function fakeApi(
  presets: { id: string; trust: 'system' | 'user'; isDefault: boolean }[],
  options: { writes?: Recorded[]; failWrite?: string; failList?: string; failWriteWith?: Error } = {},
): IApiClient {
  return {
    agentPresets: {
      list: () => Promise.resolve(options.failList === undefined
        ? { rpcId: 'r', result: { ok: true as const, value: { presets } } }
        : { rpcId: 'r', result: { ok: false as const, error: { code: 'internal', message: options.failList, details: {} } } }),
    },
    settings: {
      update: (payload: { ns: string; patch: unknown }) => {
        options.writes?.push({ ns: payload.ns, patch: payload.patch })
        if (options.failWriteWith !== undefined) return Promise.reject(options.failWriteWith)
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
      { id: 'minimal', trust: 'system', isDefault: false },
    ], { writes }))
    await controller.load()

    await controller.select('minimal')

    expect(writes).toEqual([{ ns: AGENT_PRESET_SETTINGS_NS, patch: { default: 'minimal' } }])
    expect(controller.store.getSnapshot().currentValue).toBe('minimal')
  })

  it('restores the previous value and surfaces the message when the write fails', async () => {
    const controller = new AgentPresetSettingsController(fakeApi([
      { id: 'standard', trust: 'system', isDefault: true },
      { id: 'minimal', trust: 'system', isDefault: false },
    ], { failWrite: 'read-only settings' }))
    await controller.load()

    await controller.select('minimal')

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
})

describe('the composer seat controller', () => {
  /** A seat over a fixed session summary. */
  function seat(
    presets: { id: string; trust: 'system' | 'user'; isDefault: boolean }[],
    summary: { blank: boolean; agentPreset?: string } | undefined,
    options: { writes?: Recorded[]; failSelect?: string; failList?: string; throwOn?: 'list' | 'select' } = {},
  ): AgentPresetSeatController {
    const api = {
      agentPresets: {
        list: () => {
          if (options.throwOn === 'list') return Promise.reject(new Error('socket closed'))
          return Promise.resolve(options.failList === undefined
            ? { rpcId: 'r', result: { ok: true as const, value: { presets } } }
            : { rpcId: 'r', result: { ok: false as const, error: { code: 'internal', message: options.failList, details: {} } } })
        },
        select: (payload: { agentPreset: string }) => {
          if (options.throwOn === 'select') return Promise.reject(new Error('socket closed'))
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
    { id: 'minimal', trust: 'system', isDefault: false },
  ]

  it('shows what the session runs, not the deployment default', async () => {
    const controller = seat(ROSTER, { blank: true, agentPreset: 'minimal' })

    await controller.load()

    // A resumed session runs what it was created with; showing `standard`
    // because it is the current default would be a lie about this session.
    expect(controller.store.getSnapshot().current).toBe('minimal')
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

    await controller.select('minimal')

    // The host enforces the same rule; the seat simply never asks.
    expect(writes).toEqual([])
    expect(controller.store.getSnapshot().current).toBe('standard')
  })

  it('switches a blank session and keeps the host\'s answer', async () => {
    const writes: Recorded[] = []
    const controller = seat(ROSTER, { blank: true, agentPreset: 'standard' }, { writes })
    await controller.load()

    await controller.select('minimal')

    expect(writes).toEqual([{ ns: 'select', patch: 'minimal' }])
    expect(controller.store.getSnapshot().current).toBe('minimal')
  })

  it('restores the previous value when the host rejects the switch', async () => {
    const controller = seat(ROSTER, { blank: true, agentPreset: 'standard' }, { failSelect: 'already started' })
    await controller.load()

    await controller.select('minimal')

    const state = controller.store.getSnapshot()
    expect(state.current).toBe('standard')
    expect(state.error).toBe('already started')
  })

  it('shows the first preset when the roster marks none default', async () => {
    // Settings can name a preset that was since deleted; the picker still has
    // to show something rather than an empty control.
    const controller = new AgentPresetSettingsController(fakeApi([
      { id: 'standard', trust: 'system', isDefault: false },
      { id: 'mine', trust: 'user', isDefault: false },
    ]))

    await controller.load()

    expect(controller.store.getSnapshot().currentValue).toBe('standard')
  })

  it('ignores a load while one is already in flight', async () => {
    const writes: Recorded[] = []
    const controller = new AgentPresetSettingsController(fakeApi(
      [{ id: 'standard', trust: 'system', isDefault: true }], { writes }))

    await Promise.all([controller.load(), controller.load()])

    expect(controller.store.getSnapshot().status).toBe('ready')
  })

  it('reads an Error\'s message and stringifies anything else', () => {
    // A transport rejects with an Error, but a host or a runtime can reject
    // with anything and the surface still has to say something.
    expect(messageOf(new Error('boom'))).toBe('boom')
    expect(messageOf({ code: 7 })).toBe('[object Object]')
  })

  it('reports a transport that rejects rather than answering', async () => {
    const controller = new AgentPresetSettingsController({
      agentPresets: { list: () => Promise.reject(new Error('socket closed')) },
    } as unknown as IApiClient)

    await controller.load()

    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', error: 'socket closed' })
  })

  it('reports a transport that rejects mid-write and keeps the old default showing', async () => {
    const controller = new AgentPresetSettingsController(fakeApi([
      { id: 'standard', trust: 'system', isDefault: true },
      { id: 'mine', trust: 'user', isDefault: false },
    ], { failWriteWith: new Error('socket closed') }))
    await controller.load()

    await controller.select('mine')

    // The value snaps back because the host never took it; a picker still
    // showing "mine" would be claiming a default that does not exist.
    expect(controller.store.getSnapshot()).toMatchObject({ currentValue: 'standard', error: 'socket closed' })
  })

  it('reports a refused roster read without emptying the seat', async () => {
    const controller = seat(ROSTER, { blank: true }, { failList: 'host down' })

    await controller.load()

    // The seat keeps whatever it last showed rather than claiming this session
    // has no preset; the message says why it could not refresh.
    expect(controller.store.getSnapshot()).toMatchObject({ error: 'host down', options: [] })
  })

  it('reports a transport that rejects the roster read', async () => {
    const controller = seat(ROSTER, { blank: true }, { throwOn: 'list' })

    await controller.load()

    expect(controller.store.getSnapshot().error).toBe('socket closed')
  })

  it('restores the previous preset when the switch never reaches the host', async () => {
    const controller = seat(ROSTER, { blank: true, agentPreset: 'standard' }, { throwOn: 'select' })
    await controller.load()

    await controller.select('minimal')

    // Showing `minimal` after a failed switch would claim a composition the
    // session never got.
    expect(controller.store.getSnapshot()).toMatchObject({ current: 'standard', busy: false, error: 'socket closed' })
  })

  it('reports no options when the session is unknown to the list yet', async () => {
    const controller = seat([], undefined)

    await controller.load()

    expect(controller.store.getSnapshot().options).toEqual([])
    expect(controller.store.getSnapshot().switchable).toBe(false)
  })
})
