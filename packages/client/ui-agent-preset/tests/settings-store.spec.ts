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

interface Recorded { ns: string; patch: unknown }

/** A client whose roster and write outcome the test controls. */
function fakeApi(
  presets: { id: string; trust: 'system' | 'user'; isDefault: boolean }[],
  options: { writes?: Recorded[]; failWrite?: string; failList?: string } = {},
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
})
