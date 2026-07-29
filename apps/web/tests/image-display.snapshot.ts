// @vitest-environment jsdom
// Multimodal image surfaces over the BUILT client graph (the code-mode-fixture
// idiom: real bundles via AppWebEntry, keyless FixtureApiClient transport).
// Opens the fixture history session whose turn 65 carries an image in BOTH a
// user message and an assistant message, and pins the product surfaces: the
// history ImageGallery loading real fixture bytes through the authorized
// sessions.attachment route, the double-click ImageLightbox, and the composer
// intake chain (paste → thumbnail rail → image-only send enablement → remove).
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

/** Open the fixture history session (the alpha log carrying the turn-65 image pair) and wait for its gallery. */
async function openFixtureSession(): Promise<void> {
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
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
    expect(document.querySelectorAll('[data-align] img').length).toBeGreaterThan(0)
  }, { timeout: 10_000 })
}

it('renders the history image pair through the authorized attachment route and opens the lightbox', async () => {
  boot()
  await openFixtureSession()

  // Both the user-side (align=end) and assistant-side (align=start) galleries
  // load real fixture bytes over sessions.attachment (data: fallback in jsdom).
  await waitFor(() => {
    const user = document.querySelector('[data-align="end"] img')
    const assistant = document.querySelector('[data-align="start"] img')
    if (user === null || assistant === null) throw new Error('history image galleries missing')
    // jsdom serves object URLs; environments without createObjectURL fall back to data:.
    expect(user.getAttribute('src')).toMatch(/^(blob:|data:image\/png;base64,)/)
    expect(assistant.getAttribute('src')).toMatch(/^(blob:|data:image\/png;base64,)/)
  }, { timeout: 10_000 })
  const userImage = document.querySelector<HTMLElement>('[data-align="end"] img')!
  expect(userImage.getAttribute('alt')).toBe('fixture-image.png')

  // Double-click opens the original-size lightbox; Escape/close dismisses it.
  const frame = userImage.closest('button')
  if (frame === null) throw new Error('image frame button missing')
  fireEvent.doubleClick(frame)
  const lightbox = await screen.findByRole('dialog')
  expect(within(lightbox).getByRole('img').getAttribute('src')).toMatch(/^(blob:|data:image\/png;base64,)/)
  fireEvent.click(within(lightbox).getByRole('button', { name: /关闭/ }))
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

it('accepts a pasted image into the composer rail and removes it', async () => {
  boot()
  await openFixtureSession()

  // Image-only send arming is pinned at package level (input-bar.spec.tsx);
  // this assembled lane pins the intake chain over the built graph.
  const textarea = await screen.findByPlaceholderText('Message the agent', {}, { timeout: 10_000 })
  const image = new File([new Uint8Array([137, 80, 78, 71])], 'pasted.png', { type: 'image/png' })
  fireEvent.paste(textarea, {
    clipboardData: {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
      getData: () => '',
    },
  })

  // The rail is an accessible group holding the draft thumbnail (queried via
  // DOM: jsdom's a11y-visibility computation hides the composer subtree).
  const rail = await waitFor(() => {
    const el = document.querySelector('[role="group"][aria-label="待发送图片"]')
    if (el === null) throw new Error('attachment rail missing')
    return el
  }, { timeout: 5_000 })
  expect(rail.querySelector('img')?.getAttribute('src')).toMatch(/^(blob:|data:)/)

  const remove = rail.querySelector('button[aria-label^="移除图片"]')
  if (remove === null) throw new Error('remove button missing')
  fireEvent.click(remove)
  await waitFor(() => {
    expect(document.querySelector('[role="group"][aria-label="待发送图片"]')).toBeNull()
  })
})
