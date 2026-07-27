/**
 * ui-subagent browser half: source registration (duplicate-name proof) +
 * fiber-teardown removal (HMR safety) against the real SlashService, then
 * the source behavior contract driven directly on the captured source with
 * real ClientSessionContext projections — zero-RPC candidates from the root
 * session list (running children of the projected session, label-contains
 * filtering, childless session → empty), the synchronous lexicon roster,
 * pick → plain-text outcome (decision 21), and the reference codec's two
 * projections. Direct driving is deliberate: this spec owns only the
 * source's own contract.
 */
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import { SlashService } from '@deepseek-ai/dsh-client-ui-slash/client'
import type { ClientSessionContext, SlashSource } from '@deepseek-ai/dsh-client-ui-slash/client'
import { apply, inject } from '../src/client/index.ts'

function summary(partial: Partial<SessionSummary> & { id: SessionId }): SessionSummary {
  return {
    displayTitle: partial.id,
    running: false,
    updatedAt: 0,
    ...partial,
  } as SessionSummary
}

const sid = (id: string) => id as SessionId

/** Fake root sessions face: the list snapshot the source closes over. */
function sessionsWith(sessions: SessionSummary[]) {
  const byId: Record<string, SessionSummary> = {}
  for (const s of sessions) byId[s.id] = s
  const snapshot = { ids: sessions.map(s => s.id), byId, current: undefined } as unknown as SessionListState
  return { list: { getSnapshot: () => snapshot } }
}

/** Boot the plugin over fake slash/sessions faces; returns the captured source. */
async function bench(sessions: SessionSummary[]): Promise<SlashSource> {
  const ctx = new Context()
  let captured: SlashSource | undefined
  ctx.provide('slash', { registerSource: (src: SlashSource) => { captured = src; return () => {} } })
  ctx.provide('sessions', sessionsWith(sessions))
  await ctx.plugin({ inject: [...inject], apply }).await()
  return captured!
}

const FAMILY: SessionSummary[] = [
  summary({ id: sid('parent'), displayTitle: 'parent', running: true }),
  summary({ id: sid('c1'), parentId: sid('parent'), displayTitle: 'worker-1', running: true }),
  summary({ id: sid('c2'), parentId: sid('parent'), displayTitle: 'worker-2', running: true }),
  // Filtered out: not running / other parent / label miss.
  summary({ id: sid('c3'), parentId: sid('parent'), displayTitle: 'worker-3', running: false }),
  summary({ id: sid('c4'), parentId: sid('other'), displayTitle: 'worker-4', running: true }),
  summary({ id: sid('c5'), parentId: sid('parent'), displayTitle: 'scout', running: true }),
]

const proj = (id: string): ClientSessionContext => ({ sessionId: sid(id) })

const req = (query: string) =>
  ({ query, position: 'inline' as const, signal: new AbortController().signal })

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slash', 'sessions'])
  })

  it('registers the "@" subagent source; disposal frees the name (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SlashService).await()
    ctx.provide('sessions', sessionsWith(FAMILY))
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const slash = ctx.get('slash') as SlashService
    const rival = {
      trigger: '@' as const,
      name: 'subagent',
      candidates: () => Promise.resolve([]),
      onPick: () => undefined,
    }
    // Live registration holds the (trigger, name) seat…
    expect(() => slash.registerSource(rival)).toThrow(/already registered/)
    // …and fiber teardown releases it.
    await fiber.dispose()
    expect(() => slash.registerSource(rival)).not.toThrow()
  })
})

describe('candidates', () => {
  it('returns running children of the projected session, filtered by label containment', async () => {
    const source = await bench(FAMILY)
    await expect(source.candidates(proj('parent'), req('worker'))).resolves.toEqual([
      { name: 'worker-1' }, { name: 'worker-2' },
    ])
  })

  it('matches every running child on an empty query (containment, not prefix)', async () => {
    const source = await bench(FAMILY)
    await expect(source.candidates(proj('parent'), req(''))).resolves.toEqual([
      { name: 'worker-1' }, { name: 'worker-2' }, { name: 'scout' },
    ])
  })

  it('is candidate-less for a session with no children', async () => {
    const source = await bench(FAMILY)
    await expect(source.candidates(proj('childless'), req(''))).resolves.toEqual([])
  })
})

describe('lexicon', () => {
  it('synchronously serves the projected session\'s full running-children roster', async () => {
    const source = await bench(FAMILY)
    expect(source.lexicon!(proj('parent'))).toEqual(['worker-1', 'worker-2', 'scout'])
    expect(source.lexicon!(proj('childless'))).toEqual([])
  })
})

describe('pick and codec', () => {
  it('onPick returns the literal @label text with a closing space (decision 21)', async () => {
    const source = await bench(FAMILY)
    const outcome = source.onPick({
      candidate: { name: 'worker-1' },
      session: proj('parent'),
      position: 'inline',
      via: 'menu',
      span: { start: 4, end: 8, draftRev: 3 },
    })
    expect(outcome).toEqual({ text: '@worker-1 ' })
  })

  it('codec projects clipboard `@label` and serializes the same raw label this phase', async () => {
    const source = await bench(FAMILY)
    expect(source.codec!.clipboardText('worker-1')).toBe('@worker-1')
    await expect(source.codec!.serialize('worker-1', new AbortController().signal))
      .resolves.toBe('@worker-1')
  })
})

describe('adjudication', () => {
  it('never participates: no matchSpace/matchEnter hooks on the subagent source', async () => {
    const source = await bench(FAMILY)
    expect('matchSpace' in source && source.matchSpace !== undefined).toBe(false)
    expect('matchEnter' in source && source.matchEnter !== undefined).toBe(false)
  })
})
