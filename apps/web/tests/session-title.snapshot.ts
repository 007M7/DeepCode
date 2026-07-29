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
  { id: '@deepseek-ai/dsh-client-ui-slash', dir: 'ui-slash', url: '/plugins/ui-slash.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-conversation'] },
  { id: '@deepseek-ai/dsh-client-ui-command', dir: 'ui-command', url: '/plugins/ui-command.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-ui-slash', '@deepseek-ai/dsh-client-ui-conversation'] },
  { id: '@deepseek-ai/dsh-client-ui-model', dir: 'ui-model', url: '/plugins/ui-model.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-command'] },
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

it('projects titles and routes the next turn through the selected model in the built fixture app', async () => {
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
  // The fixture Intent selects the workspace, so the current-group effect
  // already expanded it; clicking the header would now collapse (the twist
  // stays live since intent stopped forcing expansion).
  await within(tree).findByText('4 sessions')

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

  // fx-alpha carries the fixture's resident answerable approval, so the
  // approval panel has taken over the composer (the real takeover behavior);
  // answer it to restore the composer chrome before asserting the model seat.
  fireEvent.click(await screen.findByRole('button', { name: '允许一次' }))
  const modelTrigger = await screen.findByRole('button', {
    name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
  })
  fireEvent.click(modelTrigger)
  fireEvent.click(screen.getByRole('menuitem', { name: /Model/ }))
  fireEvent.click(screen.getByRole('menuitemradio', { name: /GPT-5/ }))
  await waitFor(() => {
    expect(modelTrigger.getAttribute('aria-label')).toBe('选择模型，当前 GPT-5，推理等级 Medium')
  })
  fireEvent.click(modelTrigger)
  fireEvent.click(screen.getByRole('menuitem', { name: /Effort/ }))
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Max' }))
  await waitFor(() => {
    expect(modelTrigger.getAttribute('aria-label')).toBe('选择模型，当前 GPT-5，推理等级 Max')
  })

  // fx-alpha starts in the running state. Selecting above is intentionally
  // allowed for the next turn; stop the fixture's resident run before sending
  // the route-report prompt.
  fireEvent.click(screen.getByRole('button', { name: 'Stop generating' }))
  const composer = await screen.findByPlaceholderText('Message the agent')
  fireEvent.change(composer, { target: { value: 'report model' } })
  fireEvent.keyDown(composer, { key: 'Enter' })
  await screen.findByText('当前模型：openai/gpt-5 · 推理等级：max', {}, { timeout: 10_000 })

  await expect(`${JSON.stringify({ initial, revised }, null, 2)}\n`)
    .toMatchFileSnapshot('./snapshots/session-title.json')
})
