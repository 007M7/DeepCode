/**
 * Registration: the General row and the composer seat both come from one
 * apply, and each defers until the slot it fills has been declared. A pushed
 * settings change or a reconnect re-reads the roster the row is showing.
 */

import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleService } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import { AgentPresetRow } from '../src/client/AgentPresetRow.tsx'
import type { AgentPresetRowInjected } from '../src/client/AgentPresetRow.tsx'
import { AgentPresetSeat } from '../src/client/AgentPresetSeat.tsx'
import type { AgentPresetSeatInjected } from '../src/client/AgentPresetSeat.tsx'

const ROSTER = {
  rpcId: 'r',
  result: { ok: true as const, value: { presets: [{ id: 'standard', trust: 'system', isDefault: true }] } },
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotsService).await()
  ctx.provide('locale', new LocaleService(ctx))
  const calls: string[] = []
  ctx.provide('connection', {
    api: {
      agentPresets: {
        list: () => { calls.push('list'); return Promise.resolve(ROSTER) },
        select: (payload: { agentPreset: string }) => {
          calls.push(`select:${payload.agentPreset}`)
          return Promise.resolve({ rpcId: 'r', result: { ok: true as const, value: { agentPreset: payload.agentPreset } } })
        },
      },
      settings: {
        describe: () => Promise.resolve({
          rpcId: 'r',
          result: { ok: true as const, value: { writable: true, hasDocument: true, namespaces: [] } },
        }),
        update: (payload: { patch: unknown }) => {
          calls.push(`settings:${JSON.stringify(payload.patch)}`)
          return Promise.resolve({ rpcId: 'r', result: { ok: true as const, value: {} } })
        },
      },
    },
  } as never)
  return { ctx, slots: ctx.get('slots') as SlotsService, calls }
}

function declareRoot(slots: SlotsService): () => void {
  return slots.register({
    name: 'root',
    children: {
      'settings.general.item': { kind: 'list', scope: 'root' },
      conversation: { kind: 'single', scope: 'root' },
    },
  } as never, () => null)
}

/** The conversation's own declaration, which the composer seat waits for. */
function declareConversation(slots: SlotsService): () => void {
  return slots.register({
    name: 'conversation',
    children: { 'conversation.input.agentPreset': { kind: 'single', scope: 'session' } },
  } as never, () => null)
}

/** A sessions double whose list the seat reads its summary from. */
function sessionsDouble(byId: Record<string, { id: string; blank: boolean; agentPreset?: string }>) {
  return { list: { getSnapshot: () => ({ byId }), subscribe: () => () => {} } }
}

describe('ui-agent-preset apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection'])
  })

  it('registers the General row', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    const row = slots.entries('settings.general.item')[0]!
    expect(row.component).toBe(AgentPresetRow)
    expect(row.options).toMatchObject({ id: 'agent-preset', order: -25 })
  })

  it('registers into a declaration that arrives after apply', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()

    declareRoot(slots)

    await vi.waitFor(() => { expect(slots.entries('settings.general.item')).toHaveLength(1) })
  })

  it('routes the row\'s actions to one controller', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const row = (slots.entries('settings.general.item')[0]!.inject as unknown as () => AgentPresetRowInjected)()
    await row.load()
    await row.select('standard')

    expect(row.hooks.agentPreset.getSnapshot().options).toEqual([{ id: 'standard', trust: 'system' }])
    // Already the default, so the row writes nothing — one controller behind
    // both thunks is what makes it able to know that.
    expect(calls).toEqual(['list'])
  })

  it('refreshes the row on its own namespace, and ignores others', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const row = (slots.entries('settings.general.item')[0]!.inject as unknown as () => AgentPresetRowInjected)()
    await row.load()
    const before = calls.length

    ctx.emit('settings/changed', 'agent-presets')
    await vi.waitFor(() => { expect(calls.length).toBe(before + 1) })
    const afterRelevant = calls.length

    ctx.emit('settings/changed', 'llm-deepseek')
    await Promise.resolve()

    // An unrelated namespace moves nothing, which rules out a blanket refresh
    // on every settings write.
    expect(calls.length).toBe(afterRelevant)
  })

  it('re-reads the row when the connection comes back', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const row = (slots.entries('settings.general.item')[0]!.inject as unknown as () => AgentPresetRowInjected)()
    await row.load()
    const before = calls.length

    ctx.emit('connection/reset')

    // A reconnect can land on a host whose roster changed under the browser.
    await vi.waitFor(() => { expect(calls.length).toBe(before + 1) })
  })

  it('registers the composer seat and drops it on disposal', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    declareConversation(slots)
    ctx.provide('conversation', {} as never)
    ctx.provide('sessions', sessionsDouble({}) as never)

    const fiber = await ctx.plugin({ inject: [...inject], apply }).await()
    const seat = slots.entries('conversation.input.agentPreset')[0]!
    expect(seat.component).toBe(AgentPresetSeat)

    await fiber.dispose()

    expect(slots.entries('conversation.input.agentPreset')).toHaveLength(0)
  })

  it('gives each session its own seat controller, and keeps it', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    declareConversation(slots)
    ctx.provide('conversation', {} as never)
    ctx.provide('sessions', sessionsDouble({
      s1: { id: 's1', blank: true, agentPreset: 'standard' },
      s2: { id: 's2', blank: false },
    }) as never)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const face = slots.entries('conversation.input.agentPreset')[0]!
      .inject as unknown as (id: string) => AgentPresetSeatInjected

    const first = face('s1')
    const second = face('s2')

    // The switch and the "may it still switch" bit are per-session facts, so
    // two sessions never share a store — and asking twice never rebuilds one.
    expect(first.hooks.agentPresetSeat).not.toBe(second.hooks.agentPresetSeat)
    expect(face('s1').hooks.agentPresetSeat).toBe(first.hooks.agentPresetSeat)

    await first.load()
    await second.load()

    // s1 records a preset and is blank; s2 has started, so it may not switch.
    expect(first.hooks.agentPresetSeat.getSnapshot()).toMatchObject({ current: 'standard', switchable: true })
    expect(second.hooks.agentPresetSeat.getSnapshot()).toMatchObject({ current: 'standard', switchable: false })
  })

  it('reports no session state for a seat the list has never seen', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    declareConversation(slots)
    ctx.provide('conversation', {} as never)
    ctx.provide('sessions', sessionsDouble({}) as never)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const face = (slots.entries('conversation.input.agentPreset')[0]!
      .inject as unknown as (id: string) => AgentPresetSeatInjected)('ghost')

    await face.load()
    await face.select('standard')

    // No summary means nothing is known to be blank, so the seat refuses the
    // switch rather than sending one the host would reject.
    expect(face.hooks.agentPresetSeat.getSnapshot().switchable).toBe(false)
    expect(calls).toEqual(['list'])
  })
})
