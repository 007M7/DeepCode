// @vitest-environment jsdom
/** Section, setup-card, and hand-written editor behavior over a scripted wire face. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from 'schemastery'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type { RpcResponse, SettingsNamespaceView } from '@deepseek-ai/dsh-client-connection/client'
import { ModelsSection, needsSetup, removeProviderProfile } from '../src/client/ModelsSection.tsx'
import type { ModelsSectionInjected, ModelsSectionProps } from '../src/client/ModelsSection.tsx'
import { removedAny } from '../src/client/ProviderEditor.tsx'
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
    },
    {
      ns: 'llm-plain',
      schema: JSON.parse(JSON.stringify(Schema.object({
        profiles: Schema.dict(Schema.object({ note: Schema.string() })),
      }).toJSON())) as unknown,
      value: {},
      applies: 'live',
      secrets: [],
    },
    {
      ns: 'llm-pi-ai',
      schema: JSON.parse(JSON.stringify(PiAiConfig.toJSON())) as unknown,
      value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://proxy', headers: { 'X-Team': 'a' } }, zombie: {} } },
      user: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://proxy', headers: { 'X-Team': 'a' } }, zombie: {} } },
      applies: 'live',
      secrets: [{ path: ['token'], set: false }, { path: ['providers', 'openai', 'apiKey'], set: false }],
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
  set?: ReturnType<typeof vi.fn>
} = {}) {
  const update = overrides.update ?? vi.fn(() => Promise.resolve(ok(wireNamespaces()[2])))
  const replace = overrides.replace ?? vi.fn(() => Promise.resolve(ok(wireNamespaces()[2])))
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
  return { face, update, replace, set }
}

type WireFace = ConstructorParameters<typeof ModelsSettingsStore>[0]

async function mountSection(overrides: Parameters<typeof scriptedFace>[0] = {}) {
  const { face, update, replace, set } = scriptedFace(overrides)
  const controller = new ModelsSettingsStore(face as unknown as WireFace)
  await controller.load()
  const injected: ModelsSectionInjected = {
    controller,
    useSnapshot: bindSnapshotSelector(controller.store),
    api: face as never,
    t,
  }
  const view = render(<ModelsSection {...injected} />)
  return { view, face, update, replace, set, controller }
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
    // Configured pi-ai profiles render as rows with liveness badges only.
    expect(screen.getByText('openai')).toBeTruthy()
    expect(screen.getAllByText(en.active)).toHaveLength(1)
    expect(screen.getByText(en.dormant)).toBeTruthy()
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

  it('detects removals at any draft depth', () => {
    expect(removedAny({ a: { b: 1, c: 2 } }, { a: { b: 1 } })).toBe(true)
    expect(removedAny({ a: { b: 1 } }, { a: { b: 2 }, d: 3 })).toBe(false)
    expect(removedAny(undefined, {})).toBe(false)
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

  it('applies customized deepseek fields as a merge patch', async () => {
    const { update } = await mountSection({
      update: vi.fn(() => Promise.resolve(ok(wireNamespaces()[0]))),
    })
    fireEvent.click(screen.getByText(en.customized))
    const baseURL = screen.getByLabelText<HTMLInputElement>(en.baseUrl)
    // The deepseek placeholder is pinned to the public endpoint, not the
    // effective value (which may reflect a launch-environment override).
    expect(baseURL.placeholder).toBe('https://api.deepseek.com')
    fireEvent.change(baseURL, { target: { value: 'https://next2' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(update).toHaveBeenCalledTimes(1) })
    expect(update.mock.calls[0]?.[0]).toEqual({
      ns: 'llm-deepseek',
      patch: { reasoningEffort: 'high', baseURL: 'https://next2' },
    })
  })

  it('clears an inherited override through replace so the removal lands', async () => {
    const { replace, update } = await mountSection()
    fireEvent.click(screen.getByText(en.customized))
    const effort = screen.getByLabelText<HTMLSelectElement>(en.effort)
    expect(effort.value).toBe('high')
    fireEvent.change(effort, { target: { value: '' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(replace).toHaveBeenCalledTimes(1) })
    expect(update).not.toHaveBeenCalled()
    expect(replace.mock.calls[0]?.[0]).toEqual({ ns: 'llm-deepseek', section: {} })
  })

  it('pins the deepseek placeholder and clears typed input back to inherited', async () => {
    const { face } = scriptedFace()
    const bare: SettingsNamespaceView = {
      ns: 'llm-deepseek',
      schema: JSON.parse(JSON.stringify(DeepSeekConfig.toJSON())) as unknown,
      value: {},
      applies: 'live',
      secrets: [],
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
    const { update } = await mountSection()
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
    await waitFor(() => { expect(update).toHaveBeenCalledTimes(1) })
    expect(update.mock.calls[0]?.[0]).toEqual({
      ns: 'llm-pi-ai',
      patch: {
        providers: {
          openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://proxy', headers: { 'X-Team': 'a' }, reasoning: 'xhigh' },
        },
      },
    })
  })

  it('adds a dormant provider with a derived reference and stores its key', async () => {
    const { update, set } = await mountSection()
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
    await waitFor(() => { expect(update).toHaveBeenCalledTimes(1) })
    expect(update.mock.calls[0]?.[0]).toEqual({
      ns: 'llm-pi-ai',
      patch: { providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } } },
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
      update: vi.fn(() => Promise.resolve(fail('llm-pi-ai: unknown pi-ai provider "bogus"'))),
    })
    fireEvent.click(screen.getByText(`+ ${en.add}`))
    await screen.findByLabelText(en.provider)
    const keys = screen.getAllByLabelText<HTMLInputElement>(en.keyInput)
    fireEvent.change(keys[keys.length - 1] as HTMLInputElement, { target: { value: 'sk-x' } })
    fireEvent.click(screen.getAllByText(en.apply)[1] as HTMLElement)
    await screen.findByText(/unknown pi-ai provider/)
    expect(set).not.toHaveBeenCalled()
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

  it('removes a user-added provider through replace', async () => {
    const { replace } = await mountSection()
    fireEvent.click(screen.getAllByText(en.remove)[0] as HTMLElement)
    await waitFor(() => { expect(replace).toHaveBeenCalledTimes(1) })
    expect(replace.mock.calls[0]?.[0]).toEqual({ ns: 'llm-pi-ai', section: { providers: { zombie: {} } } })
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

  it('removes against a namespace with no user layer as an empty-section replace', async () => {
    const { face, replace, controller } = await mountSection()
    const namespace = controller.store.getSnapshot().namespaces.get('llm-plain')
    await removeProviderProfile(
      face as unknown as Parameters<typeof removeProviderProfile>[0],
      controller,
      { settingsNs: 'llm-plain', settingsPath: ['ghost-profile'] },
      namespace as NonNullable<typeof namespace>,
    )
    expect(replace.mock.calls[0]?.[0]).toEqual({ ns: 'llm-plain', section: {} })
  })

  it('keeps the snapshot untouched when a removal write is refused', async () => {
    const { face, controller } = await mountSection({
      replace: vi.fn(() => Promise.resolve(fail('read-only'))),
    })
    const namespace = controller.store.getSnapshot().namespaces.get('llm-pi-ai')
    const before = controller.store.getSnapshot().rows
    await removeProviderProfile(
      face as unknown as Parameters<typeof removeProviderProfile>[0],
      controller,
      { settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
      namespace as NonNullable<typeof namespace>,
    )
    expect(controller.store.getSnapshot().rows).toBe(before)
  })
})
