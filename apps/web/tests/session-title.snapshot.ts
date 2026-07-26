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
  { id: '@deepseek-ai/dsh-client-i18n', dir: 'i18n', url: '/plugins/i18n.js', rev: 'fx', inject: [], immediately: true },
  { id: '@deepseek-ai/dsh-client-ui-layout', dir: 'ui-layout', url: '/plugins/ui-layout.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-runtime'] },
  { id: '@deepseek-ai/dsh-client-ui-sidebar', dir: 'ui-sidebar', url: '/plugins/ui-sidebar.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-ui-layout'] },
  { id: '@deepseek-ai/dsh-client-ui-conversation', dir: 'ui-conversation', url: '/plugins/ui-conversation.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-ui-layout'] },
  { id: '@deepseek-ai/dsh-client-ui-workspace', dir: 'ui-workspace', url: '/plugins/ui-workspace.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-sidebar'] },
  { id: '@deepseek-ai/dsh-client-ui-trajectory', dir: 'ui-trajectory', url: '/plugins/ui-trajectory.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-ui-conversation'] },
]

const bundles = new Map(PLUGINS.map(plugin => [
  plugin.url,
  readFileSync(join(process.cwd(), 'packages/client', plugin.dir, 'lib/client.js'), 'utf8'),
]))

interface FixtureTiming {
  appendTitle(id: string, title: string): void
}

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

/** Read only the stable, user-facing title surfaces from the assembled app. */
function titleSurfaces(label: string): { sidebar: string; breadcrumb: string; documentTitle: string } {
  const tree = screen.getByRole('tree', { name: 'Sessions' })
  const sidebar = within(tree).getByText(label).textContent ?? ''
  const breadcrumb = within(screen.getByRole('navigation', { name: 'Session hierarchy' }))
    .getByRole('button', { name: label }).textContent ?? ''
  return { sidebar, breadcrumb, documentTitle: document.title }
}

it('projects initial and revised durable titles through the built nine-plugin fixture app', async () => {
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

  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  const projectCount = await within(tree).findByText('4 sessions')
  const projectRow = projectCount.closest<HTMLElement>('[role="treeitem"]')
  if (projectRow === null) throw new Error('fixture project row missing')
  fireEvent.click(projectRow)

  const initialLabel = 'Fixture 历史会话'
  const initialRowLabel = await screen.findByText(initialLabel)
  const initialRow = initialRowLabel.closest<HTMLElement>('[role="treeitem"]')
  if (initialRow === null) throw new Error('fixture session row missing')
  fireEvent.click(initialRow)
  await waitFor(() => { expect(document.title).toBe(`${initialLabel} — DeepSeek Harness`) })
  const initial = titleSurfaces(initialLabel)

  const revisedLabel = 'Fixture 修订标题'
  const timing = (globalThis as Record<string, unknown>).__fxTiming as FixtureTiming
  act(() => { timing.appendTitle('fx-alpha', revisedLabel) })
  await waitFor(() => { expect(document.title).toBe(`${revisedLabel} — DeepSeek Harness`) })
  const revised = titleSurfaces(revisedLabel)

  await expect(`${JSON.stringify({ initial, revised }, null, 2)}\n`)
    .toMatchFileSnapshot('./snapshots/session-title.json')
})
