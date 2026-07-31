// @vitest-environment jsdom
// The built-bundle boot smoke: the ONE assembled-jsdom test that loads the
// real `packages/client/*/lib/client.js` artifacts through AppWebEntry's
// ModuleLoader path (fetchBundle/executeBundle) and proves the boot graph
// assembles — staged activation across the immediately tier and the inject
// layers, per-plugin CSS injection, and a rendered journey reaching chat
// content from the keyless FixtureApiClient transport.
//
// Behavior assertions do NOT belong here: component and wiring behavior is
// pinned by the per-package suites (SlotTestRuntime benches over src), which
// this smoke's plugin set cannot influence — bundling, module-table
// resolution, and boot layering are the only failure modes left to it.
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
  // English pinned before boot: role/text locators stay deterministic across
  // localized component migrations (the newEnglishPage e2e convention).
  localStorage.setItem('dsh.locale', 'en')
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

it('boots the built plugin graph and renders a fixture session end to end', async () => {
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

  // The sidebar renders from the boot graph: every inject layer activated.
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  await within(tree).findByText('4 sessions')

  // Opening a session reaches chat content through the fixture transport.
  fireEvent.click(await within(tree).findByText('Fixture 历史会话'))
  await waitFor(() => {
    expect(document.querySelector('[data-sample="bash-global"]')).not.toBeNull()
  }, { timeout: 10_000 })

  // Every bundle injected its plugin-owned style tag (the loader's CSS path).
  const styleOwners = [...document.head.querySelectorAll('style[data-plugin]')]
    .map(style => style.getAttribute('data-plugin'))
  for (const plugin of ['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-conversation']) {
    expect(styleOwners).toContain(plugin)
  }
})
