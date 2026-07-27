import { describe, expect, it } from 'vitest'
import { presentInspectCall, presentTryCall, presentStopCall } from '../src/present.ts'
import { setup } from './helpers.ts'

/**
 * Render-intent presenters: pure functions of the call args (no I/O, no
 * session state — they run on replay too), wired onto the registered tools.
 */

describe('presenters', () => {
  it('cordis_inspect renders a generic read card titled with the section', () => {
    expect(presentInspectCall({})).toEqual({ card: 'generic', kind: 'read', title: 'Inspect cordis runtime' })
    expect(presentInspectCall({ what: 'api' })).toEqual({ card: 'generic', kind: 'read', title: 'Inspect cordis runtime: api' })
    expect(presentInspectCall({ what: 'events', name: 'tools/change' })).toEqual({
      card: 'generic',
      kind: 'read',
      title: 'Inspect cordis runtime: events: tools/change',
    })
  })

  it('cordis_try renders a generic execute card carrying the code as raw input', () => {
    expect(presentTryCall({ code: 'return (ctx) => {}' })).toEqual({
      card: 'generic',
      kind: 'execute',
      title: 'Try temporary Cordis Plugin',
      rawInput: { code: 'return (ctx) => {}' },
    })
  })

  it('cordis_stop renders a generic delete card titled with the id', () => {
    expect(presentStopCall({ id: 'dyn-1' })).toEqual({ card: 'generic', kind: 'delete', title: 'Stop temporary Cordis Plugin dyn-1' })
  })

  it('is wired onto the registered definitions through the defineTool soft-validation path', async () => {
    const ctx = await setup()
    expect(ctx.tools.get('cordis_inspect')!.presentCall!({ what: 'tools' })).toEqual({
      card: 'generic',
      kind: 'read',
      title: 'Inspect cordis runtime: tools',
    })
    expect(ctx.tools.get('cordis_inspect')!.presentCall!({ what: 'api', name: 'tools' })).toMatchObject({
      title: 'Inspect cordis runtime: api: tools',
    })
    expect(ctx.tools.get('cordis_try')!.presentCall!({ code: 'return 1' })).toMatchObject({ kind: 'execute' })
    expect(ctx.tools.get('cordis_stop')!.presentCall!({ id: 'dyn-2' })).toMatchObject({ title: 'Stop temporary Cordis Plugin dyn-2' })
    // Soft validation: presenter args that fail the schema render as no card, never a throw.
    expect(ctx.tools.get('cordis_stop')!.presentCall!({ id: 42 })).toBeUndefined()
  })
})
