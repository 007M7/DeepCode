// @vitest-environment jsdom
// Multimodal image surfaces over the BUILT client graph (the code-mode-fixture
// idiom: real bundles via AppWebEntry, keyless FixtureApiClient transport).
// Opens the fixture history session whose turn 65 carries an image in BOTH a
// user message and an assistant message, and pins the product surfaces: the
// history ImageGallery loading real fixture bytes through the authorized
// sessions.attachment route, the double-click ImageLightbox, and the composer
// intake chain (paste → ordered thumbnail rail → image-only send enablement → remove).
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
  // Chinese pinned before boot so the localized role/text locators stay
  // deterministic across runner browser languages.
  localStorage.setItem('dsh.locale', 'zh')
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

/** Boot the complete built client graph against one fixture branch. */
function boot(search = '?fixture'): void {
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

/** Open the fixture history session (the alpha log carrying the turn-65 image pair) and wait for its gallery. */
async function openFixtureSession(): Promise<void> {
  const tree = await screen.findByRole('tree', { name: '会话' }, { timeout: 10_000 })
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
  // load real fixture bytes over sessions.attachment. jsdom provides
  // createObjectURL, so this environment MUST take the object-URL path — a
  // data: src here would mean the fallback ran where it should not.
  await waitFor(() => {
    if (document.querySelector('[data-align="end"] img') === null
      || document.querySelector('[data-align="start"] img') === null) {
      throw new Error('history image galleries missing')
    }
  }, { timeout: 10_000 })
  const galleryShape = (align: string) => [...document.querySelectorAll(`[data-align="${align}"] img`)]
    .map(img => ({ alt: img.getAttribute('alt'), scheme: img.getAttribute('src')?.split(':')[0] }))
  expect({ user: galleryShape('end'), assistant: galleryShape('start') }).toMatchInlineSnapshot(`
    {
      "assistant": [
        {
          "alt": "fixture-image.png",
          "scheme": "blob",
        },
      ],
      "user": [
        {
          "alt": "fixture-image.png",
          "scheme": "blob",
        },
      ],
    }
  `)
  const userImage = document.querySelector<HTMLElement>('[data-align="end"] img')!

  // Double-click opens the original-size lightbox; Escape/close dismisses it.
  const frame = userImage.closest('button')
  if (frame === null) throw new Error('image frame button missing')
  fireEvent.doubleClick(frame)
  const lightbox = await screen.findByRole('dialog')
  expect(within(lightbox).getByRole('img').getAttribute('src')?.split(':')[0]).toBe('blob')
  fireEvent.click(within(lightbox).getByRole('button', { name: /关闭/ }))
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

it('accepts pasted images into the composer rail in order and removes them', async () => {
  boot('?fixture=empty')

  await screen.findByPlaceholderText('选择一个工作区开始', {}, { timeout: 10_000 })
  fireEvent.click(screen.getAllByRole('button', { name: '选择工作区' })
    .find(el => el.getAttribute('aria-haspopup') === 'menu')!)
  fireEvent.click(await screen.findByRole('menuitem', { name: '新建工作区' }))
  const dialog = await screen.findByRole('dialog', { name: '新建工作区' })
  fireEvent.change(within(dialog).getByRole('textbox', { name: '新工作区名称' }), {
    target: { value: 'image-input' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: '创建工作区' }))

  // Image-only send arming is pinned at package level (input-bar.spec.tsx);
  // this assembled lane pins the intake chain over the built graph.
  const textarea = await screen.findByPlaceholderText('描述你想要构建的内容', {}, { timeout: 10_000 })
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
  expect([...rail.querySelectorAll('img')].map(img => ({
    alt: img.getAttribute('alt'), scheme: img.getAttribute('src')?.split(':')[0],
  }))).toMatchInlineSnapshot(`
    [
      {
        "alt": "pasted.png",
        "scheme": "blob",
      },
    ]
  `)

  const second = new File([new Uint8Array([137, 80, 78, 71])], 'second.png', { type: 'image/png' })
  fireEvent.paste(textarea, {
    clipboardData: {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => second }],
      getData: () => '',
    },
  })
  await waitFor(() => {
    expect([...rail.querySelectorAll('img')].map(img => img.getAttribute('alt')))
      .toEqual(['pasted.png', 'second.png'])
  })

  const remove = [...rail.querySelectorAll('button[aria-label^="移除图片"]')]
  if (remove.length !== 2) throw new Error('remove buttons missing')
  for (const button of remove) fireEvent.click(button)
  await waitFor(() => {
    expect(document.querySelector('[role="group"][aria-label="待发送图片"]')).toBeNull()
  })
})
