// @vitest-environment jsdom
/** Section, setup-card, and hand-written editor behavior over a scripted wire face. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from 'schemastery'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type { RpcResponse, SettingsNamespaceView } from '@deepseek-ai/dsh-client-connection/client'
import { ModelsSection, needsSetup, removeProviderProfile } from '../src/client/ModelsSection.tsx'
import type { ModelsSectionInjected, ModelsSectionProps } from '../src/client/ModelsSection.tsx'
import { pathOps } from '../src/client/ProviderEditor.tsx'
import { deriveKeyRef, ModelsSettingsStore } from '../src/client/store.ts'
import type { ProviderRow } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: ModelsSectionInjected['t'] = key => en[key]

const PiAiConfig = Schema.object({
  token: Schema.string().role('secret'),
  providers: Schema.dict(Schema.object({
    apiKey: Schema.string().role('secret'),
    apiKeyEnv: Schema.string().role('credential-ref'),
    baseURL: Schema.string(),
    reasoning: Schema.union(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
    headers: Schema.dict(Schema.string()),
  })),
})

const DeepSeekConfig = Schema.object({
  apiKey: Schema.string().role('secret'),
  apiKeyEnv: Schema.string().role('credential-ref'),
  baseURL: Schema.string().pattern(/^https:\/\//),
  reasoningEffort: Schema.union(['off', 'high', 'max']),
})

function wireNamespaces(): SettingsNamespaceView[] {
  return [
    {
      ns: 'llm-deepseek',
      schema: JSON.parse(JSON.stringify(DeepSeekConfig.toJSON())) as unknown,
      value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://base', reasoningEffort: 'high' },
      base: {},
      user: { reasoningEffort: 'high' },
      applies: 'live',
      secrets: [{ path: ['apiKey'], set: false }],
      revision: 0,
    },
    {
      ns: 'llm-plain',
      schema: JSON.parse(JSON.stringify(Schema.object({
        profiles: Schema.dict(Schema.object({ note: Schema.string() })),
      }).toJSON())) as unknown,
      value: {},
      applies: 'live',
      secrets: [],
      revision: 0,
    },
    {
      ns: 'llm-pi-ai',
      schema: JSON.parse(JSON.stringify(PiAiConfig.toJSON())) as unknown,
      value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://proxy', headers: { 'X-Team': 'a' } }, zombie: {} } },
      user: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://proxy', headers: { 'X-Team': 'a' } }, zombie: {} } },
      applies: 'live',
      secrets: [{ path: ['token'], set: false }, { path: ['providers', 'openai', 'apiKey'], set: false }],
      revision: 0,
    },
  ]
}

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}
function fail<T>(message: string, code = 'settings-rejected'): RpcResponse<T> {
  return {
    rpcId: `r-${nextRpc++}` as never,
    result: { ok: false, error: { code, message, details: { ns: 'x' } } as never },
  }
}

function scriptedFace(overrides: {
  update?: ReturnType<typeof vi.fn>
  replace?: ReturnType<typeof vi.fn>
  mutate?: ReturnType<typeof vi.fn>
  set?: ReturnType<typeof vi.fn>
} = {}) {
  const update = overrides.update ?? vi.fn(() => Promise.resolve(ok(wireNamespaces()[2])))
  const replace = overrides.replace ?? vi.fn(() => Promise.resolve(ok(wireNamespaces()[2])))
  const mutate = overrides.mutate ?? vi.fn(() => Promise.resolve(ok(wireNamespaces()[2])))
  const set = overrides.set ?? vi.fn(() => Promise.resolve(ok({})))
  const face = {
    llm: {
      providers: vi.fn(() => Promise.resolve(ok({
        providers: [
          { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
          { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: true },
          { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: false },
          { provider: 'zombie', displayName: 'zombie', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'zombie'], active: false },
          { provider: 'broken', displayName: 'broken', settingsNs: 'llm-pi-ai', settingsPath: ['nope', 'x'], active: false },
          { provider: 'plain', displayName: 'plain', settingsNs: 'llm-plain', settingsPath: ['profiles', 'plain'], active: false },
        ],
      }))),
      models: vi.fn(() => Promise.resolve(ok({ groups: [], failures: [] }))),
    },
    settings: {
      describe: vi.fn(() => Promise.resolve(ok({ writable: true, namespaces: wireNamespaces() }))),
      update,
      replace,
      mutate,
    },
    credentials: {
      describe: vi.fn((payload: { refs: string[] }) => Promise.resolve(ok({
        credentials: Object.fromEntries(payload.refs.map(ref => [ref, {
          configured: ref === 'OPENAI_API_KEY',
          ...ref === 'OPENAI_API_KEY' ? { source: 'file' } : {},
          writable: true,
        }])),
      }))),
      set,
      unset: vi.fn(() => Promise.resolve(ok({}))),
    },
  }
  return { face, update, replace, mutate, set }
}

type WireFace = ConstructorParameters<typeof ModelsSettingsStore>[0]

async function mountSection(overrides: Parameters<typeof scriptedFace>[0] = {}) {
  const { face, update, replace, mutate, set } = scriptedFace(overrides)
  const controller = new ModelsSettingsStore(face as unknown as WireFace)
  await controller.load()
  const injected: ModelsSectionInjected = {
    controller,
    useSnapshot: bindSnapshotSelector(controller.store),
    api: face as never,
    t,
  }
  const view = render(<ModelsSection {...injected} />)
  return { view, face, update, replace, mutate, set, controller }
}

describe('ModelsSection', () => {
  it('renders nothing before the slot injects its dependencies', () => {
    const uninjected = {} as ModelsSectionProps
    render(<ModelsSection {...uninjected} />)
    expect(document.body.textContent).toBe('')
  })

  it('renders the unkeyed whole-section provider as an open setup card beside the rows', async () => {
    await mountSection()
    // DeepSeek has no configured credential and no stored apiKey → setup card.
    expect(screen.getByText('DeepSeek')).toBeTruthy()
    expect(screen.getByLabelText(en.keyInput)).toBeTruthy()
    expect(screen.getByText('openai')).toBeTruthy()
    expect(screen.queryByText('Active')).toBeNull()
    expect(screen.queryByText('Inactive')).toBeNull()
    expect(screen.getByText(`+ ${en.add}`)).toBeTruthy()
  })

  it('turns the setup card into a row once the credential reports configured', async () => {
    const { face } = await mountSection()
    face.credentials.describe.mockImplementation((payload: { refs: string[] }) => Promise.resolve(ok({
      credentials: Object.fromEntries(payload.refs.map(ref => [ref, { configured: true, writable: true }])),
    })))
    const controller = new ModelsSettingsStore(face as unknown as WireFace)
    await controller.load()
    cleanup()
    render(<ModelsSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      api={face as never}
      t={t}
    />)
    // Now a row with an Edit button, not an open card.
    expect(screen.getAllByText(en.edit).length).toBeGreaterThan(1)
    expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  })

  it('decides setup need from the joined credential state and literal-key sidecar', () => {
    const entry = { provider: 'p', displayName: 'p', settingsNs: 'llm-deepseek', settingsPath: [], active: true }
    const row = (
      credential: ProviderRow['credential'],
      literalApiKeyConfigured = false,
    ): ProviderRow => ({
      entry,
      configured: true,
      removable: false,
      apiKeyEnv: 'X',
      credential,
      literalApiKeyConfigured,
    })
    expect(needsSetup(row(undefined))).toBe(true)
    expect(needsSetup(row({ configured: true, writable: true }))).toBe(false)
    expect(needsSetup(row(undefined, true))).toBe(false)
    const nested = { ...row(undefined), entry: { ...entry, settingsPath: ['providers', 'x'] } }
    expect(needsSetup(nested)).toBe(false)
  })

  it('derives conventional credential references from route ids', () => {
    expect(deriveKeyRef('anthropic')).toBe('ANTHROPIC_API_KEY')
    expect(deriveKeyRef('minimax-cn')).toBe('MINIMAX_CN_API_KEY')
  })

  it('names only the fields the card can see, so an unseen secret survives', () => {
    // `before` is the REDACTED subtree: a stored literal apiKey is in neither
    // side, so no op mentions it and the seam leaves it alone.
    expect(pathOps(['providers', 'openai'], { baseURL: 'https://old', reasoning: 'high' }, { reasoning: 'high' }))
      .toEqual([{ op: 'unset', path: ['providers', 'openai', 'baseURL'] }])
    expect(pathOps([], { b: 1 }, { b: 2, d: 3 }))
      .toEqual([{ op: 'set', path: ['b'], value: 2 }, { op: 'set', path: ['d'], value: 3 }])
    expect(pathOps([], undefined, {})).toEqual([])
    expect(pathOps([], { a: 1 }, { a: 1 })).toEqual([])
  })

  it('stores a typed key write-only from the setup card without touching settings', async () => {
    const { set, update, face } = await mountSection()
    const key = screen.getByLabelText<HTMLInputElement>(en.keyInput)
    fireEvent.change(key, { target: { value: 'sk-live' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(set).toHaveBeenCalledWith({ ref: 'DEEPSEEK_API_KEY', value: 'sk-live' }) })
    expect(update).not.toHaveBeenCalled()
    await waitFor(() => { expect(face.settings.describe.mock.calls.length).toBeGreaterThan(1) })
  })

  it('applies customized deepseek fields as path ops', async () => {
    const { mutate } = await mountSection({
      mutate: vi.fn(() => Promise.resolve(ok(wireNamespaces()[0]))),
    })
    fireEvent.click(screen.getByText(en.customized))
    const baseURL = screen.getByLabelText<HTMLInputElement>(en.baseUrl)
    // The deepseek placeholder is pinned to the public endpoint, not the
    // effective value (which may reflect a launch-environment override).
    expect(baseURL.placeholder).toBe('https://api.deepseek.com')
    fireEvent.change(baseURL, { target: { value: 'https://next2' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    // Only the field that actually changed: reasoningEffort was already
    // 'high' in the loaded profile, so it produces no op.
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      ns: 'llm-deepseek',
      ops: [{ op: 'set', path: ['baseURL'], value: 'https://next2' }],
      expectedRevision: 0,
    })
  })

  it('clears an inherited override with an unset op, never a whole-section replace', async () => {
    // The data-loss shape: the old path rebuilt the section from the REDACTED
    // user layer and replaced it wholesale, deleting any stored literal key.
    const { replace, update, mutate } = await mountSection()
    fireEvent.click(screen.getByText(en.customized))
    const effort = screen.getByLabelText<HTMLSelectElement>(en.effort)
    expect(effort.value).toBe('high')
    fireEvent.change(effort, { target: { value: '' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(replace).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      ns: 'llm-deepseek',
      ops: [{ op: 'unset', path: ['reasoningEffort'] }],
      expectedRevision: 0,
    })
  })

  it('pins the deepseek placeholder and clears typed input back to inherited', async () => {
    const { face } = scriptedFace()
    const bare: SettingsNamespaceView = {
      ns: 'llm-deepseek',
      schema: JSON.parse(JSON.stringify(DeepSeekConfig.toJSON())) as unknown,
      value: {},
      applies: 'live',
      secrets: [],
      revision: 0,
    }
    const { ProviderEditor } = await import('../src/client/ProviderEditor.tsx')
    render(<ProviderEditor
      provider="deepseek-official"
      displayName="DeepSeek"
      namespace={bare}
      settingsPath={[]}
      api={face as never}
      t={t}
      readOnly={false}
      onClose={() => {}}
    />)
    fireEvent.click(screen.getByText(en.customized))
    const baseURL = screen.getByLabelText<HTMLInputElement>(en.baseUrl)
    expect(baseURL.placeholder).toBe('https://api.deepseek.com')
    fireEvent.change(baseURL, { target: { value: 'https://x' } })
    expect(baseURL.value).toBe('https://x')
    fireEvent.change(baseURL, { target: { value: '' } })
    expect(baseURL.value).toBe('')
  })

  it('rejects an invalid draft before writing', async () => {
    const { update } = await mountSection()
    fireEvent.click(screen.getByText(en.customized))
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'not-a-url' } })
    fireEvent.click(screen.getByText(en.apply))
    await screen.findByText(/baseURL/)
    expect(update).not.toHaveBeenCalled()
  })

  it('edits a pi-ai profile with the curated fields only', async () => {
    const { mutate } = await mountSection()
    fireEvent.click(screen.getAllByText(en.edit)[0] as HTMLElement)
    // The configured credential shows as the stored placeholder.
    const keys = await screen.findAllByLabelText<HTMLInputElement>(en.keyInput)
    const editorKey = keys[keys.length - 1] as HTMLInputElement
    await waitFor(() => { expect(editorKey.placeholder).toBe(en.keyStored) })
    // pi-ai carries Base URL too: the stored override shows as the value and
    // the effective profile endpoint as its placeholder source.
    fireEvent.click(screen.getAllByText(en.customized)[1] as HTMLElement)
    const urls = screen.getAllByLabelText<HTMLInputElement>(en.baseUrl)
    expect(urls).toHaveLength(2)
    expect((urls[1] as HTMLInputElement).value).toBe('https://proxy')
    const effort = screen.getAllByLabelText<HTMLSelectElement>(en.effort)
    fireEvent.change(effort[effort.length - 1] as HTMLSelectElement, { target: { value: 'xhigh' } })
    fireEvent.click(screen.getAllByText(en.apply)[1] as HTMLElement)
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    // Only the edited field travels: apiKeyEnv, baseURL and headers were
    // already stored with these values, so no op restates them — and the
    // profile's stored literal apiKey, absent from the redacted view the card
    // read, is named by nothing at all.
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      ns: 'llm-pi-ai',
      ops: [{ op: 'set', path: ['providers', 'openai', 'reasoning'], value: 'xhigh' }],
      expectedRevision: 0,
    })
  })

  it('adds a dormant provider with a derived reference and stores its key', async () => {
    const { mutate, set } = await mountSection()
    fireEvent.click(screen.getByText(`+ ${en.add}`))
    const pick = await screen.findByLabelText<HTMLSelectElement>(en.provider)
    expect([...pick.options].map(option => option.value)).toEqual(['anthropic', 'broken', 'plain'])
    expect(pick.value).toBe('anthropic')
    // A dormant profile has no endpoint anywhere: the pi-ai placeholder
    // falls back to the provider-default wording.
    fireEvent.click(screen.getAllByText(en.customized)[1] as HTMLElement)
    const urls = screen.getAllByLabelText<HTMLInputElement>(en.baseUrl)
    expect((urls[1] as HTMLInputElement).placeholder).toBe(en.baseUrlDefault)
    const keys = screen.getAllByLabelText<HTMLInputElement>(en.keyInput)
    const addKey = keys[keys.length - 1] as HTMLInputElement
    fireEvent.change(addKey, { target: { value: 'sk-ant' } })
    fireEvent.click(screen.getAllByText(en.apply)[1] as HTMLElement)
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      ns: 'llm-pi-ai',
      ops: [{ op: 'set', path: ['providers', 'anthropic', 'apiKeyEnv'], value: 'ANTHROPIC_API_KEY' }],
      expectedRevision: 0,
    })
    await waitFor(() => { expect(set).toHaveBeenCalledWith({ ref: 'ANTHROPIC_API_KEY', value: 'sk-ant' }) })
  })

  it('switches the add card target and degrades unknown or broken targets loudly', async () => {
    await mountSection()
    fireEvent.click(screen.getByText(`+ ${en.add}`))
    const pick = await screen.findByLabelText<HTMLSelectElement>(en.provider)
    fireEvent.change(pick, { target: { value: 'broken' } })
    await screen.findByText(/unresolvable settings path/)
    fireEvent.change(pick, { target: { value: 'plain' } })
    await waitFor(() => {
      expect(screen.getAllByText(content => content.includes(en.advancedHint)).length).toBeGreaterThan(0)
    })
    // The hint-only card cannot apply anything.
    const applies = screen.getAllByText<HTMLButtonElement>(en.apply)
    expect((applies[applies.length - 1] as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getAllByLabelText(en.keyInput)).toHaveLength(1)
  })

  it('surfaces a rejected settings write and never stores the key after it', async () => {
    const { set } = await mountSection({
      mutate: vi.fn(() => Promise.resolve(fail('llm-pi-ai: unknown pi-ai provider "bogus"'))),
    })
    fireEvent.click(screen.getByText(`+ ${en.add}`))
    await screen.findByLabelText(en.provider)
    const keys = screen.getAllByLabelText<HTMLInputElement>(en.keyInput)
    fireEvent.change(keys[keys.length - 1] as HTMLInputElement, { target: { value: 'sk-x' } })
    fireEvent.click(screen.getAllByText(en.apply)[1] as HTMLElement)
    await screen.findByText(/unknown pi-ai provider/)
    expect(set).not.toHaveBeenCalled()
  })

  it('renders the card without the stored-key hint when the credential probe rejects', async () => {
    // The probe is a placeholder hint, not a precondition: an escaping
    // rejection would surface in the browser as an unhandled rejection.
    const { face } = scriptedFace()
    face.credentials.describe = vi.fn(() => Promise.reject(new Error('connection lost')))
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const controller = new ModelsSettingsStore(face as unknown as WireFace)
      await controller.load()
      render(<ModelsSection
        controller={controller}
        useSnapshot={bindSnapshotSelector(controller.store)}
        api={face as never}
        t={t}
      />)
      const key = await screen.findByLabelText<HTMLInputElement>(en.keyInput)
      expect(key.placeholder).toBe(en.keyPlaceholder)
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('tells the user to reopen when another writer moved the namespace first', async () => {
    // The stale-draft overwrite: two tabs open the same card, the other saves,
    // and this one must be refused rather than replay its opening snapshot.
    const { set } = await mountSection({
      mutate: vi.fn(() => Promise.resolve(fail('changed since it was read', 'settings-conflict'))),
    })
    fireEvent.click(screen.getByText(en.customized))
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en.baseUrl), { target: { value: 'https://mine' } })
    fireEvent.click(screen.getByText(en.apply))
    await screen.findByText(en.conflict)
    expect(set).not.toHaveBeenCalled()
  })

  it('keeps the card usable when the write rejects instead of answering', async () => {
    // A transport failure (disconnect, or the 403 a non-loopback browser now
    // gets on the whole configuration plane) rejects rather than returning a
    // failed envelope: without a catch the card would stay busy forever.
    await mountSection({ mutate: vi.fn(() => Promise.reject(new Error('connection lost'))) })
    fireEvent.click(screen.getByText(en.customized))
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en.baseUrl), { target: { value: 'https://next' } })
    fireEvent.click(screen.getByText(en.apply))
    await screen.findByText('connection lost')
    // Not stuck in `applying…`: the finally cleared busy, so Apply is live again.
    expect(screen.getByText(en.apply)).toBeTruthy()
  })

  it('surfaces a shadowed credential write on the card', async () => {
    await mountSection({
      set: vi.fn(() => Promise.resolve(fail('credentials: DEEPSEEK_API_KEY is shadowed by the read-only environment', 'credential-rejected'))),
    })
    const key = screen.getByLabelText<HTMLInputElement>(en.keyInput)
    fireEvent.change(key, { target: { value: 'sk-live' } })
    fireEvent.click(screen.getByText(en.apply))
    await screen.findByText(/shadowed by the read-only environment/)
  })

  it('locks the key input when the launch environment provides the credential', async () => {
    const { face } = await mountSection()
    face.credentials.describe.mockImplementation((payload: { refs: string[] }) => Promise.resolve(ok({
      credentials: Object.fromEntries(payload.refs.map(ref => [ref, {
        configured: ref === 'OPENAI_API_KEY', source: 'env', writable: false,
      }])),
    })))
    fireEvent.click(screen.getAllByText(en.edit)[0] as HTMLElement)
    const keys = await screen.findAllByLabelText<HTMLInputElement>(en.keyInput)
    const editorKey = keys[keys.length - 1] as HTMLInputElement
    await waitFor(() => { expect(editorKey.placeholder).toBe(en.keyEnvLocked) })
    expect(editorKey.disabled).toBe(true)
  })

  it('keeps a failed credential describe silent and the input usable', async () => {
    const { face, set } = await mountSection()
    face.credentials.describe.mockImplementation(() => Promise.resolve(fail('down', 'internal')) as never)
    fireEvent.click(screen.getAllByText(en.edit)[0] as HTMLElement)
    const keys = await screen.findAllByLabelText<HTMLInputElement>(en.keyInput)
    const editorKey = keys[keys.length - 1] as HTMLInputElement
    expect(editorKey.placeholder).toBe(en.keyPlaceholder)
    fireEvent.change(editorKey, { target: { value: 'sk-live' } })
    fireEvent.click(screen.getAllByText(en.apply)[1] as HTMLElement)
    await waitFor(() => { expect(set).toHaveBeenCalledTimes(1) })
  })

  it('requires confirmation before removing a user-added provider', async () => {
    const { replace, mutate } = await mountSection()
    fireEvent.click(screen.getAllByText(en.remove)[0] as HTMLElement)
    const dialog = screen.getByRole('dialog', { name: en.deleteTitle })
    expect(dialog.textContent).toContain(en.deleteDescription)
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: en.cancel }))
    expect(mutate).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }))
    expect(screen.queryByRole('dialog', { name: en.deleteTitle })).toBeNull()
    expect(mutate).not.toHaveBeenCalled()

    fireEvent.click(screen.getAllByText(en.remove)[0] as HTMLElement)
    fireEvent.click(within(screen.getByRole('dialog', { name: en.deleteTitle }))
      .getByRole('button', { name: en.close }))
    expect(screen.queryByRole('dialog', { name: en.deleteTitle })).toBeNull()
    expect(mutate).not.toHaveBeenCalled()

    fireEvent.click(screen.getAllByText(en.remove)[0] as HTMLElement)
    fireEvent.click(within(screen.getByRole('dialog', { name: en.deleteTitle }))
      .getByRole('button', { name: en.deleteConfirm }))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(screen.queryByRole('dialog', { name: en.deleteTitle })).toBeNull()
    expect(replace).not.toHaveBeenCalled()
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      ns: 'llm-pi-ai',
      ops: [{ op: 'unset', path: ['providers', 'openai'] }],
    })
  })

  it('blocks duplicate deletion while the confirmed removal is pending', async () => {
    let resolveRemoval!: (response: RpcResponse<SettingsNamespaceView>) => void
    const mutate = vi.fn(() => new Promise<RpcResponse<SettingsNamespaceView>>((resolve) => {
      resolveRemoval = resolve
    }))
    await mountSection({ mutate })
    fireEvent.click(screen.getAllByText(en.remove)[0] as HTMLElement)
    const dialog = screen.getByRole('dialog', { name: en.deleteTitle })
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: en.deleteConfirm })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(mutate).toHaveBeenCalledOnce()
    expect(confirm.disabled).toBe(true)
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: en.cancel }).disabled).toBe(true)
    expect(within(dialog).getByRole('button', { name: en.deleting })).toBe(confirm)
    fireEvent.click(within(dialog).getByRole('button', { name: en.close }))
    expect(screen.getByRole('dialog', { name: en.deleteTitle })).toBe(dialog)
    expect(mutate).toHaveBeenCalledOnce()
    await act(async () => { resolveRemoval(ok(wireNamespaces()[2]!)) })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: en.deleteTitle })).toBeNull() })
  })

  it('renders the load failure with a retry control', async () => {
    const face = scriptedFace()
    face.face.llm.providers = vi.fn(() => Promise.resolve(fail('directory down', 'internal'))) as never
    const controller = new ModelsSettingsStore(face.face as unknown as WireFace)
    await controller.load()
    render(<ModelsSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      api={face.face as never}
      t={t}
    />)
    expect(screen.getByText(/directory down/)).toBeTruthy()
    fireEvent.click(screen.getByText(en.retry))
    await waitFor(() => { expect(screen.queryByText(/directory down/)).toBeNull() })
  })

  it('shows the read-only notice and disables mutations for a read-only provider', async () => {
    const { face } = await mountSection()
    face.settings.describe.mockImplementation(() => Promise.resolve(ok({
      writable: false,
      namespaces: wireNamespaces(),
    })))
    const controller = new ModelsSettingsStore(face as unknown as WireFace)
    await controller.load()
    cleanup()
    render(<ModelsSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      api={face as never}
      t={t}
    />)
    expect(screen.getByText(en.readOnly)).toBeTruthy()
    expect(screen.getAllByText<HTMLButtonElement>(en.remove).every(button => button.disabled)).toBe(true)
    expect(screen.getByText<HTMLButtonElement>(`+ ${en.add}`).disabled).toBe(true)
  })

  it('toggles the row editor closed on a second edit click and on cancel', async () => {
    const { update } = await mountSection()
    const edit = screen.getAllByText(en.edit)[0] as HTMLElement
    fireEvent.click(edit)
    await waitFor(() => { expect(screen.getAllByLabelText(en.keyInput).length).toBe(2) })
    fireEvent.click(edit)
    expect(screen.getAllByLabelText(en.keyInput)).toHaveLength(1)
    fireEvent.click(edit)
    await waitFor(() => { expect(screen.getAllByLabelText(en.keyInput).length).toBe(2) })
    fireEvent.click(screen.getAllByText(en.cancel)[1] as HTMLElement)
    expect(screen.getAllByLabelText(en.keyInput)).toHaveLength(1)
    expect(update).not.toHaveBeenCalled()
  })

  it('cancels the add card back to the add button', async () => {
    await mountSection()
    fireEvent.click(screen.getByText(`+ ${en.add}`))
    await screen.findByLabelText(en.provider)
    fireEvent.click(screen.getAllByText(en.cancel)[1] as HTMLElement)
    await screen.findByText(`+ ${en.add}`)
    expect(screen.queryByLabelText(en.provider)).toBeNull()
  })

  it('loads on first render of an idle controller', async () => {
    const { face } = scriptedFace()
    const controller = new ModelsSettingsStore(face as unknown as WireFace)
    render(<ModelsSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      api={face as never}
      t={t}
    />)
    await screen.findByText('DeepSeek')
  })

  it('removes by unsetting the profile path, never by rebuilding the section', async () => {
    // The section rebuild is what dropped stored literal secrets: this page
    // only ever holds the redacted descriptor, so the removal names the path.
    const { face, mutate, replace, controller } = await mountSection()
    await removeProviderProfile(
      face as unknown as Parameters<typeof removeProviderProfile>[0],
      controller,
      { settingsNs: 'llm-plain', settingsPath: ['ghost-profile'] },
    )
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      ns: 'llm-plain',
      ops: [{ op: 'unset', path: ['ghost-profile'] }],
    })
    expect(replace).not.toHaveBeenCalled()
  })

  it('keeps the snapshot untouched and reports the message when a removal write is refused', async () => {
    const { face, controller } = await mountSection({
      mutate: vi.fn(() => Promise.resolve(fail('read-only'))),
    })
    const before = controller.store.getSnapshot().rows
    const failure = await removeProviderProfile(
      face as unknown as Parameters<typeof removeProviderProfile>[0],
      controller,
      { settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
    )
    expect(failure).toBe('read-only')
    expect(controller.store.getSnapshot().rows).toBe(before)
  })

  it('shows a failed removal on the page banner, including a non-Error rejection', async () => {
    // The whole click path: the row's Remove button, the transport rejecting
    // with a non-Error value, and the store surfacing it where a load failure
    // would appear — rather than the row silently staying put.
    await mountSection({ mutate: vi.fn(() => Promise.reject(new Error('the host refused'))) })
    fireEvent.click(screen.getAllByText(en.remove)[0] as HTMLElement)
    fireEvent.click(within(screen.getByRole('dialog', { name: en.deleteTitle }))
      .getByRole('button', { name: en.deleteConfirm }))
    await screen.findByText(`${en.loadFailed}: the host refused`)
  })

  it('reports a transport rejection instead of failing the removal silently', async () => {
    const { face, controller } = await mountSection({
      mutate: vi.fn(() => Promise.reject(new Error('connection lost'))),
    })
    const failure = await removeProviderProfile(
      face as unknown as Parameters<typeof removeProviderProfile>[0],
      controller,
      { settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
    )
    expect(failure).toBe('connection lost')
  })
})
