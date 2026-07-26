// @vitest-environment jsdom
// Assembled keyless snapshots of the New Session flow under the agent-parity
// model: no session exists before a Workspace is chosen (the composer is
// locked in the pure view state), picking one materializes the full
// Session+Agent (reuse-or-create of the workspace's blank session), the
// first accepted prompt flips blank and surfaces the session in lists, and
// failures (attach rejection, prompt rejection) are ordinary error strips
// with no client-side transaction state.
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

/** Collapse decorative whitespace while preserving the text a user sees. */
function visibleText(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** Identify the interactive Workspace chip (view state or blank-session hero) by its menu contract. */
function workspaceChip(): HTMLElement {
  const chip = screen.getAllByRole('button', { name: 'Choose workspace' })
    .find(element => element.getAttribute('aria-haspopup') === 'menu')
  if (chip === undefined) throw new Error('Workspace chip missing')
  return chip
}

/** The locked view-state composer (no session yet). */
async function findLockedComposer(): Promise<HTMLTextAreaElement> {
  return await screen.findByPlaceholderText(
    'Choose a workspace to start', {}, { timeout: 10_000 },
  )
}

/** The live blank-session hero composer (session materialized). */
async function findHeroComposer(): Promise<HTMLTextAreaElement> {
  return await screen.findByPlaceholderText(
    'Describe what you want to build', {}, { timeout: 10_000 },
  )
}

/** Edit the machine-owned controlled input and assert the same-tick echo. */
function setComposerText(composer: HTMLElement, value: string): void {
  fireEvent.change(composer, { target: { value } })
  expect((composer as HTMLTextAreaElement).value).toBe(value)
}

/** Drive the picker's create flow: chip → Create workspace → name dialog. */
async function createWorkspaceViaPicker(name: string): Promise<void> {
  fireEvent.click(workspaceChip())
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Create workspace' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Create a new workspace' }))
  const dialog = await screen.findByRole('dialog', { name: 'Create a new workspace' })
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'New workspace name' }), {
    target: { value: name },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create workspace' }))
}

/** Pick an existing Workspace row from the chip menu. */
async function pickWorkspace(title: string): Promise<void> {
  fireEvent.click(workspaceChip())
  fireEvent.click(await screen.findByRole('menuitem', { name: title }))
}

it('locks the composer in the New Session view state until a Workspace is chosen', async () => {
  boot('?fixture=empty')

  const composer = await findLockedComposer()
  const tree = screen.getByRole('tree', { name: 'Sessions' })

  expect({
    headline: visibleText(screen.getByText("Let's start building")),
    chip: visibleText(workspaceChip()),
    composerDisabled: composer.disabled,
    sendDisabled: screen.getByRole<HTMLButtonElement>('button', { name: 'Send message' }).disabled,
    sidebar: visibleText(tree),
  }).toMatchInlineSnapshot(`
    {
      "chip": "New Workspace",
      "composerDisabled": true,
      "headline": "Let's start building",
      "sendDisabled": true,
      "sidebar": "No sessions yet",
    }
  `)
})

it('creating a Workspace materializes and lists its selected blank Session', async () => {
  boot('?fixture=empty')

  await findLockedComposer()
  await createWorkspaceViaPicker('nova')

  // The pick connected the workspace: full Session+Agent exists, composer live.
  const composer = await findHeroComposer()
  const tree = screen.getByRole('tree', { name: 'Sessions' })
  await waitFor(() => { expect(within(tree).getByText('1 session')).toBeDefined() })
  expect(within(tree).getByText('New Session')).toBeDefined()
  const group = within(tree).getByText('1 session').closest('[role="treeitem"]')
  if (group === null) throw new Error('created Workspace projection missing')

  expect({
    composerDisabled: composer.disabled,
    chip: visibleText(workspaceChip()),
    workspace: visibleText(group),
  }).toMatchInlineSnapshot(`
    {
      "chip": "nova",
      "composerDisabled": false,
      "workspace": "nova1 session",
    }
  `)
})

it('New Session reuses the Workspace blank session and converts the single visible row', async () => {
  boot('?fixture=empty')

  await findLockedComposer()
  await createWorkspaceViaPicker('nova')
  await findHeroComposer()

  // Back out to the view state and choose the same workspace again: the
  // existing blank session is reused — no second entity.
  fireEvent.click(screen.getByRole('button', { name: 'New session' }))
  await findLockedComposer()
  await pickWorkspace('nova')
  const composer = await findHeroComposer()

  setComposerText(composer, 'first light')
  fireEvent.keyDown(composer, { key: 'Enter' })

  // Conversion: the accepted prompt flips blank without adding a second row.
  await screen.findByText('first light', { exact: true }, { timeout: 10_000 })
  const tree = screen.getByRole('tree', { name: 'Sessions' })
  await waitFor(() => { expect(within(tree).getByText('1 session')).toBeDefined() }, { timeout: 10_000 })
  const group = within(tree).getByText('1 session').closest('[role="treeitem"]')
  if (group === null) throw new Error('converted Session projection missing')

  expect({
    workspace: visibleText(group),
    promptVisible: screen.getByText('first light', { exact: true }).textContent,
  }).toMatchInlineSnapshot(`
    {
      "promptVisible": "first light",
      "workspace": "nova1 session",
    }
  `)
})

it('a failed Workspace attach surfaces in the view state and keeps the composer locked', async () => {
  boot('?fixture&fixtureAttach=fail')

  await findLockedComposer()
  await pickWorkspace('fixture')

  const alert = await screen.findByRole('alert', {}, { timeout: 10_000 })
  const composer = await findLockedComposer()
  const tree = screen.getByRole('tree', { name: 'Sessions' })
  const group = within(tree).getByText('3 sessions').closest('[role="treeitem"]')
  if (group === null) throw new Error('fixture Workspace projection missing')

  expect({
    error: visibleText(alert),
    composerDisabled: composer.disabled,
    workspace: visibleText(group),
  }).toMatchInlineSnapshot(`
    {
      "composerDisabled": true,
      "error": "session create failed: workspace-attach-failed: fixture rejected Workspace attachment for fx-1",
      "workspace": "fixture3 sessions",
    }
  `)
})

it('a rejected first prompt keeps the session blank and the draft in the machine', async () => {
  boot('?fixture=empty&fixturePrompt=reject')

  await findLockedComposer()
  await createWorkspaceViaPicker('nova')
  const composer = await findHeroComposer()

  setComposerText(composer, 'do not lose this')
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

  const alert = await screen.findByRole('alert', {}, { timeout: 10_000 })
  // Failure restore rides the machine (no pendingPrompt transaction): the
  // draft returns to the same resident textarea one render later.
  const retained = await screen.findByDisplayValue('do not lose this')
  const tree = screen.getByRole('tree', { name: 'Sessions' })
  const group = within(tree).getByText('1 session').closest('[role="treeitem"]')
  if (group === null) throw new Error('rejected-send Workspace projection missing')

  expect({
    error: visibleText(alert),
    prompt: (retained as HTMLTextAreaElement).value,
    stillHero: screen.getByText("Let's start building").textContent,
    workspace: visibleText(group),
  }).toMatchInlineSnapshot(`
    {
      "error": "fixture: prompt rejected before acceptance (agent-busy)",
      "prompt": "do not lose this",
      "stillHero": "Let's start building",
      "workspace": "nova1 session",
    }
  `)
})

it('switching Workspace before the first message carries the draft to the new blank session', async () => {
  boot('?fixture')

  await findLockedComposer()
  await pickWorkspace('fixture')
  const composer = await findHeroComposer()
  setComposerText(composer, 'carry me')

  // Switch = session switch: the new workspace's blank session takes over,
  // the typed draft moves machine-to-machine, the old blank stays hidden.
  await createWorkspaceViaPicker('nova')
  await waitFor(() => { expect(visibleText(workspaceChip())).toBe('nova') }, { timeout: 10_000 })
  const carried = await screen.findByDisplayValue('carry me')
  const tree = screen.getByRole('tree', { name: 'Sessions' })
  const fixtureGroup = within(tree).getByText('3 sessions').closest('[role="treeitem"]')
  const novaGroup = within(tree).getByText('1 session').closest('[role="treeitem"]')
  if (fixtureGroup === null || novaGroup === null) throw new Error('Workspace projections missing after switch')

  expect({
    chip: visibleText(workspaceChip()),
    prompt: (carried as HTMLTextAreaElement).value,
    fixtureWorkspace: visibleText(fixtureGroup),
    novaWorkspace: visibleText(novaGroup),
  }).toMatchInlineSnapshot(`
    {
      "chip": "nova",
      "fixtureWorkspace": "fixture3 sessions",
      "novaWorkspace": "nova1 session",
      "prompt": "carry me",
    }
  `)
})
