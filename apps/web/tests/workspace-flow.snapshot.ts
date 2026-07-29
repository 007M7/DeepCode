// @vitest-environment jsdom
// Assembled keyless snapshots of the New Session flow under the agent-parity
// model: startup auto-connects the recent Workspace's blank session when one
// exists; without any Workspace the composer is locked in the pure view
// state until one is chosen. Picking one materializes the full Session+Agent
// (reuse-or-create of the workspace's blank session), the first ACCEPTED
// prompt flips blank and surfaces the session in lists, and failures leave
// no client-side transaction state: a failed attach keeps the view state
// locked, a rejected prompt keeps the session blank with the draft restored.
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
  // Dual-face host package: its browser half fills the directory-flow holes
  // (the same composition row apps/cli mounts for the node-side backend).
  {
    id: '@deepseek-ai/dsh-host-directory-picker-browse',
    dir: '../host/directory-picker-browse',
    url: '/plugins/directory-picker-browse.js',
    rev: 'fx',
    inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-workspace', '@deepseek-ai/dsh-client-locale'],
  },
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

/** Drive the picker's create flow: chip → Create a new workspace → name dialog. */
async function createWorkspaceViaPicker(name: string): Promise<void> {
  fireEvent.click(workspaceChip())
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
      "chip": "Choose workspace",
      "composerDisabled": true,
      "headline": "Let's start building",
      "sendDisabled": true,
      "sidebar": "No sessions yet",
    }
  `)
})

it('adopts a directory through the composed in-app browse flow and lands in its blank session', async () => {
  boot('?fixture=empty')

  await findLockedComposer()
  fireEvent.click(workspaceChip())
  const menu = await screen.findByRole('menu')
  // The composed flow package occupies the directory-flow hole, so the
  // picking affordance is present (no advertised-kind read exists anymore).
  expect(within(menu).getAllByRole('menuitem').map(item => visibleText(item)))
    .toEqual(['Open local folder…', 'Create a new workspace'])
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Open local folder…' }))
  // The browse occupant renders the Select Workspace Directory dialog at the
  // fixture home; select Documents, advance into project, and adopt it.
  const dialog = await screen.findByRole('dialog', { name: '选择工作区目录' }, { timeout: 10_000 })
  // Row targeting goes through the visible label text: listitem accessible-name
  // computation differs across dom-accessibility-api environments, while the
  // row's name span is stable (clicks bubble to the row button).
  fireEvent.click(await within(dialog).findByText('Documents', {}, { timeout: 10_000 }))
  fireEvent.click(await within(dialog).findByText('project', {}, { timeout: 10_000 }))
  // Open disables while the selection's child listing is in flight; wait for
  // the enabled state or the click lands on a dead button on slow runners.
  await waitFor(() => {
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: '打开' }).disabled).toBe(false)
  }, { timeout: 10_000 })
  fireEvent.click(within(dialog).getByRole('button', { name: '打开' }))
  await findHeroComposer()
  await waitFor(() => {
    expect(visibleText(screen.getByRole('tree', { name: 'Sessions' }))).toContain('project')
  })
})

it('selects the recent Workspace and opens its blank Session on first load', async () => {
  boot('?fixture')

  const composer = await findHeroComposer()
  const tree = screen.getByRole('tree', { name: 'Sessions' })
  await waitFor(() => { expect(within(tree).getByText('4 sessions')).toBeDefined() }, { timeout: 10_000 })

  expect({
    chip: visibleText(workspaceChip()),
    composerDisabled: composer.disabled,
    blankRow: within(tree).getByText('New Session').textContent,
  }).toMatchInlineSnapshot(`
    {
      "blankRow": "New Session",
      "chip": "fixture",
      "composerDisabled": false,
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
  const tree = screen.getByRole('tree', { name: 'Sessions' })
  await waitFor(() => { expect(within(tree).getByText('1 session')).toBeDefined() }, { timeout: 10_000 })

  // New Session resolves through the recent Workspace and reuses its blank
  // session in place: no locked interlude, no second entity.
  const newSessionButton = screen.getAllByRole('button', { name: 'New session' })
    .find(button => visibleText(button) === 'New Session')
  if (newSessionButton === undefined) throw new Error('New Session button missing')
  fireEvent.click(newSessionButton)
  const composer = await findHeroComposer()
  await waitFor(() => { expect(within(tree).getByText('1 session')).toBeDefined() }, { timeout: 10_000 })

  setComposerText(composer, 'first light')
  fireEvent.keyDown(composer, { key: 'Enter' })

  // Conversion: the accepted prompt flips blank without adding a second row.
  await screen.findByText('first light', { exact: true }, { timeout: 10_000 })
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

it('a failed Workspace attach recovers by reusing the published blank session', async () => {
  boot('?fixture&fixtureAttach=fail')

  // The rejected startup connect surfaces the locked view state first: the
  // failure leaves no client-side transaction state to unwind.
  await findLockedComposer()

  // The host published the session before rejecting attachment (blank, with
  // the workspace cwd), so the next connect — retry or manual pick — reuses
  // it instead of minting a duplicate, and the hero opens on it.
  await pickWorkspace('fixture')
  const composer = await findHeroComposer()
  const tree = screen.getByRole('tree', { name: 'Sessions' })
  const group = within(tree).getByText('3 sessions').closest('[role="treeitem"]')
  if (group === null) throw new Error('fixture Workspace projection missing')

  expect({
    headline: visibleText(screen.getByText("Let's start building")),
    composerDisabled: composer.disabled,
    chip: visibleText(workspaceChip()),
    workspace: visibleText(group),
  }).toMatchInlineSnapshot(`
    {
      "chip": "fixture",
      "composerDisabled": false,
      "headline": "Let's start building",
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
  // draft returns to the same resident textarea one render later. The
  // attempt flips the composer out of the hero (engaging = retry chrome),
  // but acceptance never happened: the session row stays New Session.
  const retained = await screen.findByDisplayValue('do not lose this')
  const tree = screen.getByRole('tree', { name: 'Sessions' })
  const group = within(tree).getByText('1 session').closest('[role="treeitem"]')
  if (group === null) throw new Error('rejected-send Workspace projection missing')

  expect({
    error: visibleText(alert),
    prompt: (retained as HTMLTextAreaElement).value,
    blankRow: within(tree).getByText('New Session').textContent,
    workspace: visibleText(group),
  }).toMatchInlineSnapshot(`
    {
      "blankRow": "New Session",
      "error": "fixture: prompt rejected before acceptance (agent-busy)",
      "prompt": "do not lose this",
      "workspace": "nova1 session",
    }
  `)
})

it('switching Workspace before the first message carries the draft to the new blank session', async () => {
  boot('?fixture')

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
