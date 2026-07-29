// @vitest-environment jsdom
// Session row actions in the assembled fixture app: Rename opens the
// browser-owned dialog and settles the title from the unary response.
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
  { id: '@deepseek-ai/dsh-client-ui-conversation', dir: 'ui-conversation', url: '/plugins/ui-conversation.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-ui-layout'] },
  { id: '@deepseek-ai/dsh-client-ui-slash', dir: 'ui-slash', url: '/plugins/ui-slash.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-conversation'] },
  { id: '@deepseek-ai/dsh-client-ui-command', dir: 'ui-command', url: '/plugins/ui-command.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-ui-slash', '@deepseek-ai/dsh-client-ui-conversation'] },
  { id: '@deepseek-ai/dsh-client-ui-workspace', dir: 'ui-workspace', url: '/plugins/ui-workspace.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-sidebar'] },
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
  history.replaceState(null, '', '/?fixture')
  document.title = 'DeepSeek Harness'
  const root = document.createElement('div')
  root.id = 'root'
  document.body.appendChild(root)
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => { callback(0) }, 0) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { clearTimeout(id) })
  win.__DSH_BOOT__ = { rev: 'fx', entries: PLUGINS.map(({ dir: _dir, ...plugin }) => plugin) }
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

async function bootApp(): Promise<void> {
  const root = document.querySelector<HTMLElement>('#root')
  if (root === null) throw new Error('snapshot root missing')
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
  await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
}

/** The session row element carrying the given visible label. */
function rowOf(label: string): HTMLElement {
  const tree = screen.getByRole('tree', { name: 'Sessions' })
  const row = within(tree).getByText(label).closest<HTMLElement>('[role="treeitem"]')
  if (row === null) throw new Error(`session row "${label}" missing`)
  return row
}

/** Open the row's ... menu and click one action. The anchor button is
 *  CSS-hover-revealed (real stylesheets are injected in this assembled run,
 *  so role queries filter it as hidden); target it directly. */
function pickRowAction(label: string, action: string): void {
  const anchor = rowOf(label).querySelector<HTMLElement>(`button[aria-label="Session actions for ${label}"]`)
  if (anchor === null) throw new Error(`row menu anchor for "${label}" missing`)
  fireEvent.click(anchor)
  fireEvent.click(screen.getByRole('menuitem', { name: action, hidden: true }))
}

it('renames a session through the row-menu dialog; the row settles from the unary response', async () => {
  await bootApp()
  const sourceLabel = 'Fixture 历史会话'
  await screen.findByText(sourceLabel)

  pickRowAction(sourceLabel, 'Rename')
  const input = await screen.findByLabelText('Session name')
  expect((input as HTMLInputElement).value).toBe(sourceLabel)
  fireEvent.change(input, { target: { value: '  分叉  实验记录  ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }))

  // Host-side normalization collapses whitespace; the dialog closes on
  // acceptance and the row re-labels without any push-frame wait.
  const renamed = '分叉 实验记录'
  await waitFor(() => { expect(screen.queryByLabelText('Session name')).toBeNull() })
  await screen.findByText(renamed)
  const tree = screen.getByRole('tree', { name: 'Sessions' })
  expect(within(tree).queryByText(sourceLabel)).toBeNull()

  const rows = [...tree.querySelectorAll('[role="treeitem"]')].map(row => ({
    label: row.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  }))
  await expect(`${JSON.stringify(rows, null, 2)}\n`)
    .toMatchFileSnapshot('./snapshots/session-actions/rename-rows.json')
})
