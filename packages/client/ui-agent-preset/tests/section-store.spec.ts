/**
 * The agent-preset management controller: it holds one draft at a time, opens
 * a shipped preset read-only, treats "new" as a copy of an existing
 * composition, and re-reads the roster after every mutation because a save can
 * change more than the row it targeted.
 */

import { describe, expect, it } from 'vitest'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import { AgentPresetSectionController, draftBlocker } from '../src/client/section-store.ts'
import type { PresetDraft, PresetRow } from '../src/client/section-store.ts'

interface FakePreset { trust: 'system' | 'user'; content: string }
interface Recorded { method: string; payload: unknown }

interface FakeOptions {
  /** Every call the controller made, in order. */
  calls?: Recorded[]
  /** Reject `list` with this message. */
  failList?: string
  /** Reject `read` with this message. */
  failRead?: string
  /** Reject `write` with this message. */
  failWrite?: string
  /** Reject `remove` with this message. */
  failRemove?: string
  /** Reject `settings.update` with this message. */
  failSettings?: string
  /** Throw from `list` rather than answering, as a dead transport does. */
  throwList?: boolean
  /** Whether the deployment configures a writable root. */
  authorable?: boolean
  /** Hold `remove` until this resolves, to observe the in-flight state. */
  holdRemove?: Promise<void>
}

const ok = (value: unknown) => Promise.resolve({ rpcId: 'r', result: { ok: true as const, value } })
const fail = (message: string) =>
  Promise.resolve({ rpcId: 'r', result: { ok: false as const, error: { code: 'internal', message, details: {} } } })

/**
 * A wire face over an in-memory preset store: writes land, so the roster the
 * controller re-reads after a save is the one the save produced.
 * @param presets - the starting compositions by id.
 * @param defaultId - the preset a session with no choice gets.
 * @param options - failure injection and call recording.
 * @returns the fake client.
 */
function fakeApi(
  presets: Map<string, FakePreset>,
  defaultId: { id: string },
  options: FakeOptions = {},
): Pick<IApiClient, 'agentPresets' | 'settings'> {
  const record = (method: string, payload: unknown): void => { options.calls?.push({ method, payload }) }
  return {
    agentPresets: {
      list: () => {
        record('list', {})
        if (options.throwList === true) return Promise.reject(new Error('socket closed'))
        if (options.failList !== undefined) return fail(options.failList)
        return ok({
          presets: [...presets].map(([id, preset]) => ({
            id, trust: preset.trust, isDefault: id === defaultId.id,
          })),
          authorable: options.authorable ?? true,
        })
      },
      read: (payload: { agentPreset: string }) => {
        record('read', payload)
        if (options.failRead !== undefined) return fail(options.failRead)
        const preset = presets.get(payload.agentPreset)
        /* v8 ignore next -- every test reads an id the fake store holds */
        if (preset === undefined) return fail(`unknown preset ${payload.agentPreset}`)
        return ok({
          agentPreset: payload.agentPreset,
          trust: preset.trust,
          content: preset.content,
          writable: preset.trust === 'user',
        })
      },
      write: (payload: { agentPreset: string; content: string }) => {
        record('write', payload)
        if (options.failWrite !== undefined) return fail(options.failWrite)
        presets.set(payload.agentPreset, { trust: 'user', content: payload.content })
        return ok({ agentPreset: payload.agentPreset })
      },
      remove: async (payload: { agentPreset: string }) => {
        record('remove', payload)
        await options.holdRemove
        if (options.failRemove !== undefined) return await fail(options.failRemove)
        presets.delete(payload.agentPreset)
        return await ok({})
      },
    },
    settings: {
      update: (payload: { ns: string; patch: { default?: string } }) => {
        record('settings.update', payload)
        if (options.failSettings !== undefined) return fail(options.failSettings)
        /* v8 ignore next -- the controller only ever patches `default` */
        defaultId.id = payload.patch.default ?? defaultId.id
        return ok({})
      },
    },
  } as unknown as Pick<IApiClient, 'agentPresets' | 'settings'>
}

function seed(): Map<string, FakePreset> {
  return new Map<string, FakePreset>([
    ['standard', { trust: 'system', content: '- id: tool-bash\n' }],
    ['mine', { trust: 'user', content: '- id: tool-read\n' }],
  ])
}

function harness(options: FakeOptions = {}) {
  const presets = seed()
  const defaultId = { id: 'standard' }
  const calls: Recorded[] = []
  const controller = new AgentPresetSectionController(
    fakeApi(presets, defaultId, { ...options, calls: options.calls ?? calls }),
  )
  return { controller, presets, defaultId, calls }
}

function draftOf(controller: AgentPresetSectionController): PresetDraft {
  const { draft } = controller.store.getSnapshot()
  if (draft === null) throw new Error('expected an open draft')
  return draft
}

describe('loading the roster', () => {
  it('reports the presets, their trust, the default, and whether authoring is possible', async () => {
    const { controller } = harness()

    await controller.load()

    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.authorable).toBe(true)
    expect(state.rows).toEqual([
      { id: 'standard', trust: 'system', isDefault: true },
      { id: 'mine', trust: 'user', isDefault: false },
    ])
  })

  it('treats an empty roster as a deployment that composes no presets', async () => {
    const presets = new Map<string, FakePreset>()
    const controller = new AgentPresetSectionController(fakeApi(presets, { id: '' }, { authorable: false }))

    await controller.load()

    // Not an error: every session then shares the host composition, and the
    // section renders nothing rather than an empty management page.
    expect(controller.store.getSnapshot().status).toBe('unavailable')
    expect(controller.store.getSnapshot().authorable).toBe(false)
  })

  it('surfaces a rejected roster call', async () => {
    const { controller } = harness({ failList: 'roster unavailable' })

    await controller.load()

    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', error: 'roster unavailable' })
  })

  it('surfaces a transport that rejects rather than answering', async () => {
    const { controller } = harness({ throwList: true })

    await controller.load()

    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', error: 'socket closed' })
  })

  it('ignores a load while one is already in flight', async () => {
    const { controller, calls } = harness()

    await Promise.all([controller.load(), controller.load()])

    expect(calls.filter(call => call.method === 'list')).toHaveLength(1)
  })
})

describe('opening a composition', () => {
  it('opens a locally authored preset for editing', async () => {
    const { controller } = harness()
    await controller.load()

    await controller.open('mine')

    expect(draftOf(controller)).toMatchObject({
      id: 'mine', source: 'mine', creating: false, content: '- id: tool-read\n', writable: true,
    })
  })

  it('opens a shipped preset read-only', async () => {
    const { controller } = harness()
    await controller.load()

    await controller.open('standard')

    // Readable on purpose: it is the known-good composition a local preset is
    // written against, and duplicating it is how authoring starts.
    expect(draftOf(controller)).toMatchObject({ writable: false, content: '- id: tool-bash\n' })
  })

  it('surfaces a rejected read on the page rather than opening an empty editor', async () => {
    const { controller } = harness({ failRead: 'permission denied' })
    await controller.load()

    await controller.open('mine')

    expect(controller.store.getSnapshot()).toMatchObject({ draft: null, error: 'permission denied' })
  })

  it('surfaces a transport failure on the page', async () => {
    const presets = seed()
    const api = fakeApi(presets, { id: 'standard' })
    const controller = new AgentPresetSectionController({
      ...api,
      agentPresets: { ...api.agentPresets, read: () => Promise.reject(new Error('socket closed')) },
    })
    await controller.load()

    await controller.open('mine')

    expect(controller.store.getSnapshot()).toMatchObject({ draft: null, error: 'socket closed' })
  })

  it('closes the editor without writing anything', async () => {
    const { controller, calls } = harness()
    await controller.load()
    await controller.open('mine')

    controller.setContent('- id: changed\n')
    controller.close()

    expect(controller.store.getSnapshot().draft).toBeNull()
    expect(calls.some(call => call.method === 'write')).toBe(false)
  })
})

describe('creating a preset', () => {
  it('copies the default composition when no source is named', async () => {
    const { controller } = harness()
    await controller.load()

    await controller.createFrom()

    // The default is the composition a new session gets, so it is the one
    // worth starting from — and a copy is writable wherever it came from.
    expect(draftOf(controller)).toMatchObject({ id: '', source: 'standard', creating: true, writable: true })
    expect(draftOf(controller).content).toBe('- id: tool-bash\n')
  })

  it('copies a named preset', async () => {
    const { controller } = harness()
    await controller.load()

    await controller.createFrom('mine')

    expect(draftOf(controller)).toMatchObject({ source: 'mine', creating: true, content: '- id: tool-read\n' })
  })

  it('does nothing before the roster loaded', async () => {
    const { controller, calls } = harness()

    await controller.createFrom()

    expect(controller.store.getSnapshot().draft).toBeNull()
    expect(calls).toHaveLength(0)
  })
})

describe('the save blocker', () => {
  const base: PresetDraft = {
    id: '', source: 'standard', creating: true, content: '', writable: true, saving: false, error: null,
  }
  const rows: readonly PresetRow[] = [{ id: 'mine', trust: 'user', isDefault: false }]

  it('never blocks an edit of an existing preset', () => {
    expect(draftBlocker({ ...base, id: 'mine', creating: false }, rows)).toBeUndefined()
  })

  it('requires a name', () => {
    expect(draftBlocker(base, rows)).toBe('idRequired')
  })

  it.each(['Upper', 'has space', '-leading', 'a/b', '../escape'])('rejects the unusable id %j', (id) => {
    // The id becomes a directory name, so the client mirrors the host's own
    // containment rule instead of letting the save round-trip to find out.
    expect(draftBlocker({ ...base, id }, rows)).toBe('idInvalid')
  })

  it('rejects a name already in use', () => {
    // Replacing is what Edit is for; a create landing on an existing name
    // would overwrite a preset the user never opened.
    expect(draftBlocker({ ...base, id: 'mine' }, rows)).toBe('idTaken')
  })

  it('accepts an unused, containable id', () => {
    expect(draftBlocker({ ...base, id: 'my-agent2' }, rows)).toBeUndefined()
  })
})

describe('saving', () => {
  it('creates the preset and re-reads the roster', async () => {
    const { controller, presets } = harness()
    await controller.load()
    await controller.createFrom()
    controller.setId('my-agent')
    controller.setContent('- id: tool-web-search\n')

    await controller.save()

    expect(presets.get('my-agent')).toEqual({ trust: 'user', content: '- id: tool-web-search\n' })
    expect(controller.store.getSnapshot().draft).toBeNull()
    expect(controller.store.getSnapshot().rows.map(row => row.id)).toContain('my-agent')
  })

  it('replaces an existing composition', async () => {
    const { controller, presets } = harness()
    await controller.load()
    await controller.open('mine')
    controller.setContent('- id: tool-edit\n')

    await controller.save()

    expect(presets.get('mine')?.content).toBe('- id: tool-edit\n')
  })

  it('refuses to write a blocked draft', async () => {
    const { controller, calls } = harness()
    await controller.load()
    await controller.createFrom()

    await controller.save()

    expect(calls.some(call => call.method === 'write')).toBe(false)
    expect(controller.store.getSnapshot().draft).not.toBeNull()
  })

  it('refuses to write a read-only draft', async () => {
    const { controller, calls } = harness()
    await controller.load()
    await controller.open('standard')

    await controller.save()

    expect(calls.some(call => call.method === 'write')).toBe(false)
  })

  it('does nothing without an open draft', async () => {
    const { controller, calls } = harness()
    await controller.load()

    await controller.save()

    expect(calls.some(call => call.method === 'write')).toBe(false)
  })

  it('keeps the draft open and reports a rejected save', async () => {
    const { controller } = harness({ failWrite: 'composition is not an entry list' })
    await controller.load()
    await controller.open('mine')

    await controller.save()

    // The text stays in the editor: it is the only copy, and the message says
    // what to fix.
    expect(draftOf(controller)).toMatchObject({ saving: false, error: 'composition is not an entry list' })
  })

  it('reports a transport that rejects mid-save', async () => {
    const presets = seed()
    const api = fakeApi(presets, { id: 'standard' })
    const controller = new AgentPresetSectionController({
      ...api,
      agentPresets: { ...api.agentPresets, write: () => Promise.reject(new Error('socket closed')) },
    })
    await controller.load()
    await controller.open('mine')

    await controller.save()

    expect(draftOf(controller)).toMatchObject({ saving: false, error: 'socket closed' })
  })

  it('ignores a second save while one is in flight', async () => {
    const { controller, calls } = harness()
    await controller.load()
    await controller.open('mine')

    await Promise.all([controller.save(), controller.save()])

    expect(calls.filter(call => call.method === 'write')).toHaveLength(1)
  })

  it('clears a save failure when the text changes', async () => {
    const { controller } = harness({ failWrite: 'invalid' })
    await controller.load()
    await controller.open('mine')
    await controller.save()

    controller.setContent('- id: fixed\n')

    expect(draftOf(controller).error).toBeNull()
  })

  it('ignores an edit with no draft open', () => {
    const { controller } = harness()

    controller.setId('x')
    controller.setContent('y')

    expect(controller.store.getSnapshot().draft).toBeNull()
  })
})

describe('deleting', () => {
  it('deletes the confirmed preset and re-reads the roster', async () => {
    const { controller, presets } = harness()
    await controller.load()

    controller.confirmDelete('mine')
    await controller.remove()

    expect(presets.has('mine')).toBe(false)
    expect(controller.store.getSnapshot()).toMatchObject({ pendingDelete: null, deleting: false })
    expect(controller.store.getSnapshot().rows.map(row => row.id)).toEqual(['standard'])
  })

  it('closes an editor open on the deleted preset', async () => {
    const { controller } = harness()
    await controller.load()
    await controller.open('mine')

    controller.confirmDelete('mine')
    await controller.remove()

    // The file is gone; leaving its text in an editor whose Save would
    // resurrect it is worse than closing.
    expect(controller.store.getSnapshot().draft).toBeNull()
  })

  it('leaves a copy-in-progress open when its source is deleted', async () => {
    const { controller } = harness()
    await controller.load()
    await controller.createFrom('mine')
    controller.setId('mine')

    controller.confirmDelete('mine')
    await controller.remove()

    // The draft is a new preset that happens to be named after the one just
    // deleted; its text is unsaved work.
    expect(draftOf(controller)).toMatchObject({ id: 'mine', creating: true })
  })

  it('dismisses the confirmation without deleting', async () => {
    const { controller, calls, presets } = harness()
    await controller.load()

    controller.confirmDelete('mine')
    controller.confirmDelete(null)
    await controller.remove()

    expect(calls.some(call => call.method === 'remove')).toBe(false)
    expect(presets.has('mine')).toBe(true)
  })

  it('reports a refused delete on the page', async () => {
    const { controller } = harness({ failRemove: 'it ships with the deployment' })
    await controller.load()

    controller.confirmDelete('standard')
    await controller.remove()

    expect(controller.store.getSnapshot()).toMatchObject({
      pendingDelete: null, deleting: false, error: 'it ships with the deployment',
    })
  })

  it('reports a transport that rejects mid-delete', async () => {
    const presets = seed()
    const api = fakeApi(presets, { id: 'standard' })
    const controller = new AgentPresetSectionController({
      ...api,
      agentPresets: { ...api.agentPresets, remove: () => Promise.reject(new Error('socket closed')) },
    })
    await controller.load()

    controller.confirmDelete('mine')
    await controller.remove()

    expect(controller.store.getSnapshot()).toMatchObject({ deleting: false, error: 'socket closed' })
  })

  it('ignores a second delete while one is in flight', async () => {
    const { controller, calls } = harness()
    await controller.load()
    controller.confirmDelete('mine')

    await Promise.all([controller.remove(), controller.remove()])

    expect(calls.filter(call => call.method === 'remove')).toHaveLength(1)
  })

  it('ignores a confirmation change while a delete is in flight', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const presets = seed()
    const controller = new AgentPresetSectionController(
      fakeApi(presets, { id: 'standard' }, { holdRemove: held }),
    )
    await controller.load()
    controller.confirmDelete('mine')

    const pending = controller.remove()
    // Dismissing mid-flight cannot un-delete the file, so the confirmation
    // stays put rather than the page claiming nothing is happening.
    controller.confirmDelete(null)
    expect(controller.store.getSnapshot().pendingDelete).toBe('mine')
    release()
    await pending

    expect(presets.has('mine')).toBe(false)
  })
})

describe('the default preset', () => {
  it('writes the settings field and re-reads the roster', async () => {
    const { controller, calls, defaultId } = harness()
    await controller.load()

    await controller.makeDefault('mine')

    expect(calls.find(call => call.method === 'settings.update')?.payload)
      .toEqual({ ns: 'agent-presets', patch: { default: 'mine' } })
    expect(defaultId.id).toBe('mine')
    expect(controller.store.getSnapshot().rows.find(row => row.isDefault)?.id).toBe('mine')
  })

  it('reports a refused write and leaves the roster alone', async () => {
    const { controller, defaultId } = harness({ failSettings: 'settings are read-only' })
    await controller.load()

    await controller.makeDefault('mine')

    expect(controller.store.getSnapshot().error).toBe('settings are read-only')
    expect(defaultId.id).toBe('standard')
  })
})
