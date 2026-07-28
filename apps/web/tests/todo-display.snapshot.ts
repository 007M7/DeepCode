// @vitest-environment jsdom
// Todo display snapshot over the BUILT client graph (the code-mode-fixture
// idiom: real bundles via AppWebEntry, keyless FixtureApiClient transport).
// Opens the fixture history session and pins the todo_write turn's two
// surfaces: the dedicated TodoRow in the chat flow (keyed toolview, summary
// derived from the call args) and the TodoPanel plan strip riding the
// 'conversation.input.dock' slot (fed by ConversationSnapshot.todos, seeded
// by the tail history page), including the collapse interaction.
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

/** Boot the complete built client graph against the populated fixture branch. */
function boot(): void {
  history.replaceState(null, '', '/?fixture')
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

/** Open the fixture history session (the alpha log carrying the todo_write turn) and wait for its tail. */
async function openFixtureSession(): Promise<void> {
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  // Anchor on the expandable Workspace group row: the title and the blank
  // session row can both read "fixture", and the session-count meta shifts
  // when a blank session joins the group.
  const group = (await within(tree).findAllByText('fixture'))
    .map(el => el.closest<HTMLElement>('[role="treeitem"]'))
    .find(el => el?.getAttribute('aria-expanded') !== null)
  if (group === null || group === undefined) throw new Error('fixture Workspace group missing')
  if (group.getAttribute('aria-expanded') === 'false') {
    fireEvent.click(within(group).getByText('fixture'))
    await waitFor(() => {
      expect(group.getAttribute('aria-expanded')).toBe('true')
    })
  }
  const session = await within(tree).findByText('Fixture 历史会话')
  fireEvent.click(session)
  await waitFor(() => {
    expect(document.querySelector('[data-sample="todo-row"]')).not.toBeNull()
  }, { timeout: 10_000 })
}

it('renders the todo_write turn: dedicated tool row + the dock plan strip', async () => {
  boot()
  await openFixtureSession()

  const row = document.querySelector('[data-sample="todo-row"]')
  if (row === null) throw new Error('todo row missing')
  const panel = document.querySelector('[data-testid="todo-panel"]')
  if (panel === null) throw new Error('todo panel missing from the input dock')

  // Header spans are adjacent inline nodes; textContent joins "To-dos" +
  // "1/3…" with no space (visual gap is CSS gap: 10px, not a text node).
  expect({
    row: visibleText(row),
    rowState: row.getAttribute('data-state'),
    panelHeader: visibleText(panel.querySelector('button') ?? panel),
    panelItems: [...panel.querySelectorAll('li')].map(item => ({
      status: item.getAttribute('data-status'),
      text: visibleText(item),
    })),
  }).toMatchInlineSnapshot(`
    {
      "panelHeader": "To-dos1/3 tasks · 1 in progress",
      "panelItems": [
        {
          "status": "completed",
          "text": "梳理需求",
        },
        {
          "status": "in_progress",
          "text": "实现 fixture 样本",
        },
        {
          "status": "pending",
          "text": "浏览器验收",
        },
      ],
      "row": "更新任务清单1/3 已完成 · 实现 fixture 样本",
      "rowState": "ok",
    }
  `)
})

it('collapses the plan strip to the count summary and restores it', async () => {
  boot()
  await openFixtureSession()

  const panel = document.querySelector('[data-testid="todo-panel"]')
  if (panel === null) throw new Error('todo panel missing from the input dock')
  const header = panel.querySelector('button')
  if (header === null) throw new Error('todo panel header missing')

  fireEvent.click(header)
  expect({
    collapsedHeader: visibleText(header),
    listGone: panel.querySelector('ul') === null,
  }).toMatchInlineSnapshot(`
    {
      "collapsedHeader": "To-dos1/3 tasks · 1 in progress",
      "listGone": true,
    }
  `)

  fireEvent.click(header)
  expect(panel.querySelectorAll('li')).toHaveLength(3)
})
