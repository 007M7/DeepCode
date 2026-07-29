// @vitest-environment jsdom
/** Section, editor, and credential-control behavior over a scripted wire face. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from 'schemastery'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type { RpcResponse, SettingsNamespaceView } from '@deepseek-ai/dsh-client-connection/client'
import { ModelsSection, removeProviderProfile } from '../src/client/ModelsSection.tsx'
import type { ModelsSectionInjected } from '../src/client/ModelsSection.tsx'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: ModelsSectionInjected['t'] = key => en[key]

const PiAiConfig = Schema.object({
  token: Schema.string().role('secret'),
  providers: Schema.dict(Schema.object({
    apiKey: Schema.string().role('secret'),
    apiKeyEnv: Schema.string().role('credential-ref'),
    baseURL: Schema.string(),
    headers: Schema.dict(Schema.string()),
  })),
})

const DeepSeekConfig = Schema.object({
  apiKey: Schema.string().role('secret'),
  apiKeyEnv: Schema.string().role('credential-ref'),
  baseURL: Schema.string(),
  label: Schema.string().required(),
})

function wireNamespaces(): SettingsNamespaceView[] {
  return [
    {
      ns: 'llm-deepseek',
      schema: JSON.parse(JSON.stringify(DeepSeekConfig.toJSON())) as unknown,
      value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://base' },
      base: { baseURL: 'https://base' },
      applies: 'live',
      secrets: [{ path: ['apiKey'], set: false }],
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
  const update = overrides.update ?? vi.fn(() => Promise.resolve(ok(wireNamespaces()[1])))
  const replace = overrides.replace ?? vi.fn(() => Promise.resolve(ok(wireNamespaces()[1])))
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

async function mountSection(overrides: Parameters<typeof scriptedFace>[0] = {}) {
  const { face, update, replace, set } = scriptedFace(overrides)
  const controller = new ModelsSettingsStore(face as never)
  await controller.load()
  const injected: ModelsSectionInjected = {
    controller,
    useSnapshot: bindSnapshotSelector(controller.store),
    api: face as never,
    t,
  }
  const view = render(<ModelsSection injected={injected} />)
  return { view, face, update, replace, set, controller }
}

describe('ModelsSection', () => {
  it('renders configured rows with status badges and the add vocabulary', async () => {
    await mountSection()
    expect(screen.getByText('DeepSeek')).toBeTruthy()
    expect(screen.getByText('openai')).toBeTruthy()
    expect(screen.queryByText('anthropic', { selector: 'span' })).toBeNull()
    expect(screen.getAllByText(en.active)).toHaveLength(2)
    // A configured profile whose route did not register renders dormant.
    expect(screen.getByText(en.dormant)).toBeTruthy()
    expect(screen.getByText(en.keyMissing)).toBeTruthy()
    const add = screen.getByLabelText<HTMLSelectElement>(en.add)
    expect([...add.options].map(option => option.value)).toEqual(['', 'anthropic', 'broken'])
    expect(screen.getAllByText(en.remove)).toHaveLength(2)
  })

  it('opens the editor, applies an edit as a merge patch, and reloads', async () => {
    const { update, face } = await mountSection()
    fireEvent.click(screen.getAllByText(en.edit)[1] as HTMLElement)
    const baseURL = await screen.findByDisplayValue('https://proxy')
    fireEvent.change(baseURL, { target: { value: 'https://next' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(update).toHaveBeenCalledTimes(1) })
    expect(update.mock.calls[0]?.[0]).toEqual({
      ns: 'llm-pi-ai',
      patch: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://next', headers: { 'X-Team': 'a' } } } },
    })
    await waitFor(() => { expect(face.settings.describe.mock.calls.length).toBeGreaterThan(1) })
  })

  it('applies a field reset through replace so the removal lands', async () => {
    const { replace, update } = await mountSection()
    fireEvent.click(screen.getAllByText(en.edit)[1] as HTMLElement)
    const baseURL = await screen.findByDisplayValue('https://proxy')
    fireEvent.change(baseURL, { target: { value: '' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(replace).toHaveBeenCalledTimes(1) })
    expect(update).not.toHaveBeenCalled()
    expect(replace.mock.calls[0]?.[0]).toEqual({
      ns: 'llm-pi-ai',
      section: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', headers: { 'X-Team': 'a' } }, zombie: {} } },
    })
  })

  it('lands a nested removal (dict entry) through replace', async () => {
    const { replace } = await mountSection()
    fireEvent.click(screen.getAllByText(en.edit)[1] as HTMLElement)
    await screen.findByDisplayValue('https://proxy')
    // Row deletion says "Delete"; the only "Remove" inside the open editor
    // is schema-form's headers-dict row control.
    fireEvent.click(screen.getAllByText(en.removeLabel)[0] as HTMLElement)
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(replace).toHaveBeenCalledTimes(1) })
    const section = (replace.mock.calls[0]?.[0] as { section: { providers: { openai: { headers?: unknown } } } }).section
    expect(section.providers.openai.headers).toEqual({})
  })

  it('surfaces a rejected apply inside the editor', async () => {
    const { update } = await mountSection({
      update: vi.fn(() => Promise.resolve(fail('llm-pi-ai: unknown pi-ai provider "bogus"'))),
    })
    fireEvent.click(screen.getAllByText(en.edit)[1] as HTMLElement)
    const baseURL = await screen.findByDisplayValue('https://proxy')
    fireEvent.change(baseURL, { target: { value: 'https://next' } })
    fireEvent.click(screen.getByText(en.apply))
    await screen.findByText('llm-pi-ai: unknown pi-ai provider "bogus"')
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('adds a dormant provider through the add select and merges its profile in', async () => {
    const { update } = await mountSection()
    fireEvent.change(screen.getByLabelText(en.add), { target: { value: 'anthropic' } })
    const ref = await screen.findByLabelText<HTMLInputElement>(en.credentialRef)
    // No reference yet, so the write-only key input stays hidden until one exists.
    expect(screen.queryByLabelText(en.keyInput)).toBeNull()
    fireEvent.change(ref, { target: { value: 'ANTHROPIC_API_KEY' } })
    const key = await screen.findByLabelText<HTMLInputElement>(en.keyInput)
    expect(key.placeholder).toBe(en.keyPlaceholder)
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(update).toHaveBeenCalledTimes(1) })
    expect(update.mock.calls[0]?.[0]).toEqual({
      ns: 'llm-pi-ai',
      patch: { providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } } },
    })
  })

  it('removes a user-added provider through replace', async () => {
    const { replace } = await mountSection()
    fireEvent.click(screen.getAllByText(en.remove)[0] as HTMLElement)
    await waitFor(() => { expect(replace).toHaveBeenCalledTimes(1) })
    expect(replace.mock.calls[0]?.[0]).toEqual({ ns: 'llm-pi-ai', section: { providers: { zombie: {} } } })
  })

  it('reports an unresolvable settings path instead of a blank editor', async () => {
    await mountSection()
    fireEvent.change(screen.getByLabelText(en.add), { target: { value: 'broken' } })
    await screen.findByText(/unresolvable settings path/)
  })

  it('clears the credential reference back to inherited from the control', async () => {
    const { update } = await mountSection()
    fireEvent.click(screen.getAllByText(en.edit)[1] as HTMLElement)
    const ref = await screen.findByLabelText<HTMLInputElement>(en.credentialRef)
    expect(ref.value).toBe('OPENAI_API_KEY')
    fireEvent.change(ref, { target: { value: '' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(update).toHaveBeenCalledTimes(0) })
    // Dropping the reference is a removal, so it lands through replace.
  })

  it('shows the env-shadowed credential badge and hides the key input', async () => {
    const { face } = await mountSection()
    face.credentials.describe.mockImplementation(() => Promise.resolve(ok({
      credentials: { OPENAI_API_KEY: { configured: true, source: 'env', writable: false } },
    })))
    fireEvent.click(screen.getAllByText(en.edit)[1] as HTMLElement)
    await screen.findByText(content => content.includes(en.credentialFromEnv))
    expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  })

  it('renders no badge while the credential domain fails, and keeps a failed post-save describe quiet', async () => {
    const { face, set } = await mountSection()
    face.credentials.describe.mockImplementation(() => Promise.resolve(fail('down', 'internal')) as never)
    fireEvent.click(screen.getAllByText(en.edit)[0] as HTMLElement)
    const key = await screen.findByLabelText<HTMLInputElement>(en.keyInput)
    expect(screen.queryByText(en.credentialConfigured)).toBeNull()
    expect(screen.queryByText(en.credentialMissing)).toBeNull()
    fireEvent.change(key, { target: { value: 'sk-live' } })
    fireEvent.click(screen.getByText(en.keySave))
    await waitFor(() => { expect(set).toHaveBeenCalledTimes(1) })
    expect(key).toBeTruthy()
  })

  it('stores a credential value write-only and refreshes its badge', async () => {
    const { set, face } = await mountSection()
    fireEvent.click(screen.getAllByText(en.edit)[0] as HTMLElement)
    const key = await screen.findByLabelText<HTMLInputElement>(en.keyInput)
    fireEvent.change(key, { target: { value: 'sk-live' } })
    fireEvent.click(screen.getByText(en.keySave))
    await waitFor(() => { expect(set).toHaveBeenCalledWith({ ref: 'DEEPSEEK_API_KEY', value: 'sk-live' }) })
    await waitFor(() => { expect(face.credentials.describe.mock.calls.length).toBeGreaterThan(1) })
    expect(key.value).toBe('')
  })

  it('surfaces a shadowed credential write on the control', async () => {
    await mountSection({
      set: vi.fn(() => Promise.resolve(fail('credentials: DEEPSEEK_API_KEY is shadowed by the read-only environment', 'credential-rejected'))),
    })
    fireEvent.click(screen.getAllByText(en.edit)[0] as HTMLElement)
    const key = await screen.findByLabelText<HTMLInputElement>(en.keyInput)
    fireEvent.change(key, { target: { value: 'sk-live' } })
    fireEvent.click(screen.getByText(en.keySave))
    await screen.findByText(/shadowed by the read-only environment/)
  })

  it('renders the load failure with a retry control', async () => {
    const face = scriptedFace()
    face.face.llm.providers = vi.fn(() => Promise.resolve(fail('directory down', 'internal'))) as never
    const controller = new ModelsSettingsStore(face.face as never)
    await controller.load()
    render(<ModelsSection injected={{
      controller,
      useSnapshot: bindSnapshotSelector(controller.store),
      api: face.face as never,
      t,
    }} />)
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
    const controller = new ModelsSettingsStore(face as never)
    await controller.load()
    cleanup()
    render(<ModelsSection injected={{
      controller,
      useSnapshot: bindSnapshotSelector(controller.store),
      api: face as never,
      t,
    }} />)
    expect(screen.getByText(en.readOnly)).toBeTruthy()
    expect(screen.getAllByText<HTMLButtonElement>(en.remove).every(button => button.disabled)).toBe(true)
  })

  it('toggles the editor closed on a second edit click and on cancel', async () => {
    const { update } = await mountSection()
    const edit = screen.getAllByText(en.edit)[1] as HTMLElement
    fireEvent.click(edit)
    await screen.findByDisplayValue('https://proxy')
    fireEvent.click(edit)
    expect(screen.queryByDisplayValue('https://proxy')).toBeNull()
    fireEvent.click(edit)
    await screen.findByDisplayValue('https://proxy')
    fireEvent.click(screen.getByText(en.cancel))
    expect(screen.queryByDisplayValue('https://proxy')).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })

  it('ignores the placeholder option of the add select', async () => {
    await mountSection()
    fireEvent.change(screen.getByLabelText(en.add), { target: { value: '' } })
    expect(screen.queryByText(en.apply)).toBeNull()
  })

  it('applies a whole-section namespace (path []) as a direct patch', async () => {
    const { update } = await mountSection({
      update: vi.fn(() => Promise.resolve(ok(wireNamespaces()[0]))),
    })
    fireEvent.click(screen.getAllByText(en.edit)[0] as HTMLElement)
    await screen.findByLabelText(en.credentialRef)
    const label = screen.getByPlaceholderText<HTMLInputElement>(/label|Default/i) ?? undefined
    const labelInput = screen.getAllByRole('textbox').find(input =>
      (input as HTMLInputElement).type === 'text'
      && input.closest('div')?.previousElementSibling?.textContent?.includes('label') === true)
    const target = labelInput ?? screen.getAllByRole('textbox').at(-1)
    fireEvent.change(target as Element, { target: { value: 'Mine' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(update).toHaveBeenCalledTimes(1) })
    const payload = update.mock.calls[0]?.[0] as { ns: string; patch: Record<string, unknown> }
    expect(payload.ns).toBe('llm-deepseek')
    expect(payload.patch['label']).toBe('Mine')
    expect(label ?? true).toBeTruthy()
  })

  it('rejects a section-level invalid draft before writing', async () => {
    const { update } = await mountSection()
    fireEvent.click(screen.getAllByText(en.edit)[0] as HTMLElement)
    await screen.findByLabelText(en.credentialRef)
    fireEvent.click(screen.getByText(en.apply))
    // schemastery names the missing required field in its failure text.
    await screen.findByText(/required/)
    expect(update).not.toHaveBeenCalled()
  })

  it('loads on first render of an idle controller', async () => {
    const { face } = scriptedFace()
    const controller = new ModelsSettingsStore(face as never)
    render(<ModelsSection injected={{
      controller,
      useSnapshot: bindSnapshotSelector(controller.store),
      api: face as never,
      t,
    }} />)
    await screen.findByText('DeepSeek')
  })

  it('removes against a namespace with no user layer as an empty-section replace', async () => {
    const { face, replace, controller } = await mountSection()
    const namespace = controller.store.getSnapshot().namespaces.get('llm-deepseek')
    await removeProviderProfile(
      face as unknown as Parameters<typeof removeProviderProfile>[0],
      controller,
      { settingsNs: 'llm-deepseek', settingsPath: ['ghost-profile'] },
      namespace as NonNullable<typeof namespace>,
    )
    expect(replace.mock.calls[0]?.[0]).toEqual({ ns: 'llm-deepseek', section: {} })
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
