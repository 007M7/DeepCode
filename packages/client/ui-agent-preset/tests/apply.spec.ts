/**
 * Registration: the General row, the settings section, and the per-session
 * composer seat all come from one apply, and each defers until the slot it
 * fills has been declared. A pushed settings change refreshes the surfaces
 * that are already showing, so a default set from one converges the other.
 */

import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleService } from '@deepseek-ai/dsh-client-locale/client'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import { AgentPresetRow } from '../src/client/AgentPresetRow.tsx'
import type { AgentPresetRowInjected } from '../src/client/AgentPresetRow.tsx'
import { AgentPresetSection } from '../src/client/AgentPresetSection.tsx'
import type { AgentPresetSectionInjected } from '../src/client/AgentPresetSection.tsx'
import { AgentPresetSeat } from '../src/client/AgentPresetSeat.tsx'
import type { AgentPresetSeatInjected } from '../src/client/AgentPresetSeat.tsx'

// The service reads its initial locale from the browser; these specs assert
// the shipped Chinese copy, so they state the browser they assume.
usePinnedBrowserLanguages('zh-CN')

const ROSTER = {
  rpcId: 'r',
  result: { ok: true as const, value: { presets: [{ id: 'standard', trust: 'system', isDefault: true }], authorable: true } },
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotsService).await()
  const locale = new LocaleService(ctx)
  ctx.provide('locale', locale)
  const calls: string[] = []
  ctx.provide('connection', {
    api: {
      agentPresets: {
        list: () => { calls.push('list'); return Promise.resolve(ROSTER) },
        read: () => Promise.resolve({
          rpcId: 'r',
          result: { ok: true as const, value: { agentPreset: 'standard', trust: 'system', content: '', writable: false } },
        }),
        write: () => Promise.resolve({ rpcId: 'r', result: { ok: true as const, value: { agentPreset: 'standard' } } }),
        remove: () => Promise.resolve({ rpcId: 'r', result: { ok: true as const, value: {} } }),
        select: () => Promise.resolve({ rpcId: 'r', result: { ok: true as const, value: { agentPreset: 'standard' } } }),
      },
      settings: {
        update: (payload: { patch: unknown }) => { calls.push(`settings:${JSON.stringify(payload.patch)}`); return Promise.resolve({ rpcId: 'r', result: { ok: true as const, value: {} } }) },
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
      'settings.section': { kind: 'list', scope: 'root' },
      conversation: { kind: 'single', scope: 'root' },
    },
  } as never, () => null)
}

/** The composer's own declaration, which the seat registration waits for. */
function declareComposer(slots: SlotsService): () => void {
  return slots.register({
    name: 'conversation',
    children: { 'conversation.input.agentPreset': { kind: 'single', scope: 'session' } },
  } as never, () => null)
}

describe('ui-agent-preset apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection'])
  })

  it('registers the General row and the settings section', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    const row = slots.entries('settings.general.item')[0]!
    expect(row.component).toBe(AgentPresetRow)
    expect(row.options).toMatchObject({ id: 'agent-preset', order: -25 })
    const section = slots.entries('settings.section')[0]!
    expect(section.component).toBe(AgentPresetSection)
    expect(section.options).toMatchObject({ id: 'agent-presets', order: 20 })
    // The nav label is a locale-following thunk; owners resolve it at read time.
    expect(resolveSlotLabel(section.options.label)).toBe('Agent preset')
  })

  it('registers into a declaration that arrives after apply', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()

    declareRoot(slots)

    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(1) })
  })

  it('hands each surface its own store and actions', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const row = (slots.entries('settings.general.item')[0]!.inject as unknown as () => AgentPresetRowInjected)()
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => AgentPresetSectionInjected)()

    expect(row.hooks.agentPreset).not.toBe(section.hooks.agentPresetSection)
    // Each thunk reaches its own controller: the row's load fills the row's
    // store, and the section's default write does not go through the row.
    await row.load()
    await row.select('standard')
    await section.makeDefault('standard')
    expect(row.hooks.agentPreset.getSnapshot().options).toEqual([{ id: 'standard', trust: 'system' }])
    expect(section.hooks.agentPresetSection.getSnapshot().rows)
      .toEqual([{ id: 'standard', trust: 'system', isDefault: true }])
  })

  it('routes the section actions to one controller', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => AgentPresetSectionInjected)()

    await section.load()
    section.setId('mine')
    section.setContent('- id: x\n')
    section.confirmDelete('mine')
    section.close()
    await Promise.all([section.open('standard'), section.createFrom(), section.save(), section.remove()])

    // One controller behind every action: the delete the section confirmed is
    // the one its remove() sees.
    expect(section.hooks.agentPresetSection.getSnapshot().rows).toHaveLength(1)
  })

  it('refreshes a showing surface when its namespace changes, and ignores others', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => AgentPresetSectionInjected)()
    await section.load()
    const before = calls.length

    ctx.emit('settings/changed', 'agent-presets')
    await vi.waitFor(() => { expect(calls.length).toBe(before + 2) })
    const afterRelevant = calls.length

    ctx.emit('settings/changed', 'llm-deepseek')
    await Promise.resolve()

    // Both surfaces re-read on their own namespace; an unrelated one moves
    // neither, so this rules out a blanket refresh on every settings write.
    expect(calls.length).toBe(afterRelevant)
  })

  it('re-reads both surfaces when the connection comes back', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => AgentPresetSectionInjected)()
    await section.load()
    const before = calls.length

    ctx.emit('connection/reset')

    // A reconnect can land on a host whose roster changed under the browser.
    await vi.waitFor(() => { expect(calls.length).toBe(before + 2) })
  })

  it('leaves the section alone until it has been opened once', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const before = calls.length

    ctx.emit('settings/changed', 'agent-presets')
    await vi.waitFor(() => { expect(calls.length).toBeGreaterThan(before) })

    // Only the General row reloads: a section nobody opened has nothing to
    // converge, and reading the roster for it would be a wasted round trip.
    expect(calls.length - before).toBe(1)
  })

  it('gives each session its own seat controller and drops its registrations on disposal', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    const conversation = declareComposer(slots)
    ctx.provide('conversation', {} as never)
    ctx.provide('sessions', { list: { getSnapshot: () => ({ byId: { s1: { blank: true, agentPreset: 'standard' } } }) } } as never)
    const fiber = ctx.plugin({ inject: [...inject, 'conversation', 'sessions'], apply })
    await fiber.await()

    const seat = slots.entries('conversation.input.agentPreset')[0]!
    expect(seat.component).toBe(AgentPresetSeat)
    const make = seat.inject as unknown as (id: string) => AgentPresetSeatInjected
    // Same session, same controller; a different session gets its own, because
    // "may it still switch" is a per-session fact.
    expect(make('s1').hooks.agentPresetSeat).toBe(make('s1').hooks.agentPresetSeat)
    expect(make('s2').hooks.agentPresetSeat).not.toBe(make('s1').hooks.agentPresetSeat)
    await fiber.dispose()
    expect(slots.entries('conversation.input.agentPreset')).toHaveLength(0)
    expect(slots.entries('settings.section')).toHaveLength(0)
    conversation()
  })

  it('reads a seat\'s session state through the live session list', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    declareComposer(slots)
    ctx.provide('conversation', {} as never)
    const byId: Record<string, { blank: boolean; agentPreset?: string }> = {}
    ctx.provide('sessions', { list: { getSnapshot: () => ({ byId }) } } as never)
    await ctx.plugin({ inject: [...inject, 'conversation', 'sessions'], apply }).await()
    const make = slots.entries('conversation.input.agentPreset')[0]!
      .inject as unknown as (id: string) => AgentPresetSeatInjected

    const seat = make('s1')
    await seat.load()
    const unknownSession = seat.hooks.agentPresetSeat.getSnapshot().switchable
    // A session created before presets existed records none; the seat then
    // shows the roster default rather than an empty control.
    byId['s1'] = { blank: true }
    await seat.load()
    expect(seat.hooks.agentPresetSeat.getSnapshot().current).toBe('standard')
    byId['s1'] = { blank: true, agentPreset: 'standard' }
    await seat.load()

    // A session the list has not caught up to offers no switch rather than
    // guessing that it is blank.
    expect(unknownSession).toBe(false)
    expect(seat.hooks.agentPresetSeat.getSnapshot()).toMatchObject({ switchable: true, current: 'standard' })
    await make('s1').select('standard')
  })
})
