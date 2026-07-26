// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WebBootEntry } from '@deepseek-ai/dsh-client-modules/client'
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'

const PLUGINS: readonly (WebBootEntry & { dir: string })[] = [
  { id: '@deepseek-ai/dsh-client-connection', dir: 'connection', url: '/plugins/connection.js', rev: 'fx', inject: [], immediately: true },
  { id: '@deepseek-ai/dsh-client-runtime', dir: 'runtime', url: '/plugins/runtime.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-connection'], immediately: true },
  { id: '@deepseek-ai/dsh-client-ui-theme', dir: 'ui-theme', url: '/plugins/ui-theme.js', rev: 'fx', inject: [], immediately: true },
  { id: '@deepseek-ai/dsh-client-locale', dir: 'locale', url: '/plugins/locale.js', rev: 'fx', inject: [], immediately: true },
  { id: '@deepseek-ai/dsh-client-ui-layout', dir: 'ui-layout', url: '/plugins/ui-layout.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-runtime'] },
  { id: '@deepseek-ai/dsh-client-ui-sidebar', dir: 'ui-sidebar', url: '/plugins/ui-sidebar.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-ui-layout'] },
  { id: '@deepseek-ai/dsh-client-ui-settings', dir: 'ui-settings', url: '/plugins/ui-settings.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-ui-sidebar'] },
  { id: '@deepseek-ai/dsh-client-ui-settings-general', dir: 'ui-settings-general', url: '/plugins/ui-settings-general.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-locale'] },
  { id: '@deepseek-ai/dsh-client-ui-models', dir: 'ui-models', url: '/plugins/ui-models.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-ui-settings'] },
  { id: '@deepseek-ai/dsh-client-ui-conversation', dir: 'ui-conversation', url: '/plugins/ui-conversation.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-ui-layout'] },
  {
    id: '@deepseek-ai/dsh-client-ui-workspace',
    dir: 'ui-workspace',
    url: '/plugins/ui-workspace.js',
    rev: 'fx',
    inject: [
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-sidebar',
    ],
  },
  { id: '@deepseek-ai/dsh-client-ui-trajectory', dir: 'ui-trajectory', url: '/plugins/ui-trajectory.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-ui-conversation'] },
]

const bundles = new Map(PLUGINS.map(plugin => [
  plugin.url,
  readFileSync(join(process.cwd(), 'packages/client', plugin.dir, 'lib/client.js'), 'utf8'),
]))

interface FixtureWindow extends Window {
  __DSH_BOOT__?: { rev: string; entries: WebBootEntry[] }
  __ModuleLoader__?: unknown
}

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

const win = window as FixtureWindow
let unmount: (() => void) | undefined

beforeEach(() => {
  localStorage.clear()
  document.title = 'DeepSeek Harness'
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => { callback(0) }, 0) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { clearTimeout(id) })
})

afterEach(() => {
  act(() => { unmount?.() })
  unmount = undefined
  cleanup()
  delete win.__DSH_BOOT__
  delete win.__ModuleLoader__
  delete (globalThis as Record<string, unknown>).__fxTiming
  document.body.innerHTML = ''
  document.head.querySelectorAll('style[data-plugin]').forEach((style) => { style.remove() })
  document.title = ''
  history.replaceState(null, '', '/')
  vi.unstubAllGlobals()
})

/** Boot the complete built client graph against one keyless fixture branch. */
function boot(search: string): void {
  history.replaceState(null, '', `/${search}`)
  const root = document.createElement('div')
  root.id = 'root'
  document.body.appendChild(root)
  win.__DSH_BOOT__ = { rev: 'fx', entries: PLUGINS.map(({ dir: _dir, ...plugin }) => plugin) }
  act(() => {
    const entry = new AppWebEntry(root, {
      fetchBundle: (url) => {
        const code = bundles.get(url)
        return code === undefined ? Promise.reject(new Error(`missing built bundle ${url}`)) : Promise.resolve(code)
      },
      executeBundle: (code) => { (0, eval)(code) },
    })
    void entry.run()
    unmount = () => { entry.dispose() }
  })
}

/** Recreate the built client graph while preserving browser-persistent state. */
function refresh(search: string): void {
  act(() => { unmount?.() })
  unmount = undefined
  cleanup()
  delete win.__DSH_BOOT__
  delete win.__ModuleLoader__
  delete (globalThis as Record<string, unknown>).__fxTiming
  document.body.innerHTML = ''
  document.head.querySelectorAll('style[data-plugin]').forEach((style) => { style.remove() })
  boot(search)
}

/** Collapse decorative whitespace while preserving the text a user sees. */
function visibleText(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** Identify the interactive Workspace chip by its menu contract. */
function workspaceChip(): HTMLElement {
  const chip = screen.getAllByRole('button', { name: 'Choose workspace' })
    .find(element => element.getAttribute('aria-haspopup') === 'menu')
  if (chip === undefined) throw new Error('Workspace chip missing')
  return chip
}

/** Edit the runtime-owned controlled input and assert the same-tick echo:
 *  a deferred echo makes React roll the textarea back mid-IME-composition,
 *  committing partial keystrokes (e.g. Pinyin "nihao" leaking as "nnini h…"). */
function setComposerText(composer: HTMLElement, value: string): void {
  fireEvent.change(composer, { target: { value } })
  expect((composer as HTMLTextAreaElement).value).toBe(value)
}

it('starts a writable page-local draft without inventing a sidebar Workspace', async () => {
  boot('?fixture=empty')

  const composer = await screen.findByPlaceholderText('Describe what you want to build', {}, { timeout: 10_000 })
  const tree = screen.getByRole('tree', { name: 'Sessions' })
  setComposerText(composer, 'keep this local')

  expect({
    headline: visibleText(screen.getByText("Let's start building")),
    workspaceDraft: visibleText(workspaceChip()),
    sidebar: visibleText(tree),
    composerDisabled: (composer as HTMLTextAreaElement).disabled,
    prompt: (composer as HTMLTextAreaElement).value,
  }).toMatchInlineSnapshot(`
    {
      "composerDisabled": false,
      "headline": "Let's start building",
      "prompt": "keep this local",
      "sidebar": "No sessions yet",
      "workspaceDraft": "workspace",
    }
  `)
})

it('creates a real empty Workspace immediately and focuses its Session draft', async () => {
  boot('?fixture=empty')

  await screen.findByPlaceholderText('Describe what you want to build', {}, { timeout: 10_000 })
  const workspaceSection = screen.getByText('Workspaces').parentElement
  if (workspaceSection === null) throw new Error('Workspace section missing')
  fireEvent.click(within(workspaceSection).getByRole('button', { name: 'Create workspace' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Create workspace' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Create a new workspace' }))

  const dialog = await screen.findByRole('dialog', { name: 'Create a new workspace' })
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'New workspace name' }), {
    target: { value: 'nova' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create workspace' }))

  const tree = await screen.findByRole('tree', { name: 'Sessions' })
  await waitFor(() => { expect(within(tree).getByText('1 session')).toBeDefined() })
  const group = within(tree).getByText('1 session').closest('[role="treeitem"]')
  const draft = within(tree).getByText('New session').closest('[role="treeitem"]')
  if (group === null || draft === null) throw new Error('created Workspace projection missing')

  expect({
    workspace: visibleText(group),
    draft: visibleText(draft),
    draftSelected: draft.getAttribute('aria-selected'),
    composerWorkspace: visibleText(workspaceChip()),
  }).toMatchInlineSnapshot(`
    {
      "composerWorkspace": "nova",
      "draft": "New session",
      "draftSelected": "true",
      "workspace": "nova1 session",
    }
  `)
})

it('drops the page-local draft on refresh while retaining real Workspaces and Sessions', async () => {
  boot('?fixture')

  const composer = await screen.findByPlaceholderText('Describe what you want to build', {}, { timeout: 10_000 })
  const tree = screen.getByRole('tree', { name: 'Sessions' })
  setComposerText(composer, 'discard this page-local draft')
  const beforeGroup = within(tree).getByText('4 sessions').closest('[role="treeitem"]')
  if (beforeGroup === null) throw new Error('fixture Workspace projection missing before refresh')

  const before = {
    workspace: visibleText(beforeGroup),
    draft: visibleText(within(tree).getByText('New session')),
    prompt: (composer as HTMLTextAreaElement).value,
  }

  refresh('?fixture')

  const refreshedComposer = await screen.findByPlaceholderText('Describe what you want to build', {}, { timeout: 10_000 })
  const refreshedTree = screen.getByRole('tree', { name: 'Sessions' })
  const afterGroup = within(refreshedTree).getByText('4 sessions').closest('[role="treeitem"]')
  if (afterGroup === null) throw new Error('fixture Workspace projection missing after refresh')

  expect({
    before,
    after: {
      workspace: visibleText(afterGroup),
      replacementDraft: visibleText(within(refreshedTree).getByText('New session')),
      prompt: (refreshedComposer as HTMLTextAreaElement).value,
    },
  }).toMatchInlineSnapshot(`
    {
      "after": {
        "prompt": "",
        "replacementDraft": "New session",
        "workspace": "fixture4 sessions",
      },
      "before": {
        "draft": "New session",
        "prompt": "discard this page-local draft",
        "workspace": "fixture4 sessions",
      },
    }
  `)
})

it('keeps a published Session with only cwd membership evidence in Ungrouped', async () => {
  boot('?fixture&fixtureAttach=fail')

  const composer = await screen.findByPlaceholderText('Describe what you want to build', {}, { timeout: 10_000 })
  setComposerText(composer, 'keep this cwd-only session')
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

  const tree = screen.getByRole('tree', { name: 'Sessions' })
  await waitFor(() => { expect(within(tree).getByText('Ungrouped')).toBeDefined() }, { timeout: 10_000 })
  const workspaceGroup = within(tree).getByText('3 sessions').closest('[role="treeitem"]')
  const ungroupedGroup = within(tree).getByText('1 session').closest('[role="treeitem"]')
  const ungroupedSection = ungroupedGroup?.parentElement
  if (workspaceGroup === null || ungroupedGroup === null || ungroupedSection === null || ungroupedSection === undefined) {
    throw new Error('Workspace or Ungrouped projection missing')
  }
  const session = within(ungroupedSection).getByRole('treeitem', { selected: true })
  const retained = screen.getByDisplayValue('keep this cwd-only session')

  expect({
    workspace: visibleText(workspaceGroup),
    ungrouped: visibleText(ungroupedGroup),
    session: within(session).getByText('fixture', { exact: true }).textContent,
    sessionSelected: session.getAttribute('aria-selected'),
    prompt: (retained as HTMLTextAreaElement).value,
  }).toMatchInlineSnapshot(`
    {
      "prompt": "keep this cwd-only session",
      "session": "fixture",
      "sessionSelected": "true",
      "ungrouped": "Ungrouped1 session",
      "workspace": "fixture3 sessions",
    }
  `)
})

it('materializes the automatic Workspace and Session on the first successful send', async () => {
  boot('?fixture=empty')

  const composer = await screen.findByPlaceholderText('Describe what you want to build', {}, { timeout: 10_000 })
  setComposerText(composer, 'build a lighthouse')
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

  const tree = screen.getByRole('tree', { name: 'Sessions' })
  await waitFor(() => { expect(within(tree).getByText('1 session')).toBeDefined() }, { timeout: 10_000 })
  await screen.findByText('build a lighthouse', { exact: true }, { timeout: 10_000 })
  const group = within(tree).getByText('1 session').closest('[role="treeitem"]')
  const session = within(tree).getByRole('treeitem', { selected: true })
  if (group === null) throw new Error('materialized Workspace projection missing')

  expect({
    workspace: visibleText(group),
    session: within(session).getByText('workspace', { exact: true }).textContent,
    sessionSelected: session.getAttribute('aria-selected'),
    promptVisible: screen.getByText('build a lighthouse', { exact: true }).textContent,
  }).toMatchInlineSnapshot(`
    {
      "promptVisible": "build a lighthouse",
      "session": "workspace",
      "sessionSelected": "true",
      "workspace": "workspace1 session",
    }
  `)
})

it('keeps the published Workspace, Session, and unsent prompt after rejection', async () => {
  boot('?fixture=empty&fixturePrompt=reject')

  const composer = await screen.findByPlaceholderText('Describe what you want to build', {}, { timeout: 10_000 })
  setComposerText(composer, 'do not lose this')
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

  const alert = await screen.findByRole('alert', {}, { timeout: 10_000 })
  const retained = screen.getByDisplayValue('do not lose this')
  const tree = screen.getByRole('tree', { name: 'Sessions' })
  await waitFor(() => { expect(within(tree).getByText('1 session')).toBeDefined() })
  const group = within(tree).getByText('1 session').closest('[role="treeitem"]')
  const session = within(tree).getByRole('treeitem', { selected: true })
  if (group === null) throw new Error('rejected-send Workspace projection missing')

  expect({
    workspace: visibleText(group),
    session: within(session).getByText('workspace', { exact: true }).textContent,
    error: visibleText(alert),
    prompt: (retained as HTMLTextAreaElement).value,
  }).toMatchInlineSnapshot(`
    {
      "error": "Message send failed: agent-busy: fixture: prompt rejected before acceptance",
      "prompt": "do not lose this",
      "session": "workspace",
      "workspace": "workspace1 session",
    }
  `)
})
