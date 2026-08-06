// @vitest-environment jsdom
// Assembled search-card snapshot: boots the real built `packages/client/*/lib/
// client.js` bundles through AppWebEntry's ModuleLoader path against the keyless
// FixtureApiClient transport (no API key, no model round), opens the fixture
// session, and pins the search card the `grep` turn (fixture turn 66) renders in
// the assembled application. The built-boot smoke proves the graph boots but
// carries no behavior assertions by contract; this is the assembled-output check
// that a broken SearchRow registration or a dropped card would fail — the
// per-package suites bench over src and cannot see the bundled wiring.
//
// Keyless and deterministic: the fixture is the fake server, so the grep turn's
// matches, its truncation summary, and its head/tail cap are fixed in the
// fixture, not harvested from a live model. The recovery-footer arm is a pure
// derivation over the result view, pinned at every render site by the
// ui-conversation suite; here the fixture turn exercises the assembled card
// shape and its cap.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebBootEntry } from '@deepseek-ai/dsh-client-modules/client'
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'

const EXPECTED = join(process.cwd(), 'apps/web/tests/snapshots/search-card/grep-card.expected.txt')
const refreshing = process.env.DSH_SNAPSHOT === 'record' || process.env.DSH_SNAPSHOT === 'refresh'

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

/** Normalize a rendered search card to a stable text shape: the kind, the banner
 *  summary, each file header (path + count), each visible match line, the expand
 *  control label, and the recovery footer. CSS-module class names carry a
 *  per-build hash in one of two schemes — ui-primitives emits `_<name>_<hash>`
 *  (name bounded by underscores), ui-conversation emits `<hash>_<name>` (name at
 *  the end). `hasClass` matches a module class by its logical name under either,
 *  without matching a longer name that contains it (`line` must not hit
 *  `lineNumber`). */
function hasClass(el: Element, name: string): boolean {
  return [...el.classList].some(cls => cls === name || cls.endsWith(`_${name}`) || cls.startsWith(`_${name}_`) || cls.includes(`_${name}_`))
}

function cardShape(root: Element): string {
  const card = root.querySelector('[data-search]')
  if (card === null) return '<no search card>'
  const pick = (from: Element, name: string): Element[] =>
    [...from.querySelectorAll('*')].filter(el => hasClass(el, name))
  const lines: string[] = [`kind=${card.getAttribute('data-search')}`]
  const summary = pick(card, 'summary')[0]?.textContent?.trim()
  if (summary !== undefined && summary !== '') lines.push(`summary=${summary}`)
  for (const header of pick(card, 'fileHeader')) lines.push(`file=${header.textContent?.trim() ?? ''}`)
  for (const row of pick(card, 'line')) lines.push(`line=${row.textContent?.trim() ?? ''}`)
  const expand = pick(card, 'expand')[0]?.textContent?.trim()
  if (expand !== undefined && expand !== '') lines.push(`expand=${expand}`)
  const recovery = pick(root, 'searchRecovery')[0]?.textContent?.trim()
  if (recovery !== undefined && recovery !== '') lines.push(`recovery=${recovery}`)
  return lines.join('\n')
}

beforeEach(() => {
  localStorage.clear()
  // English pinned before boot so the sidebar's role/text locators stay
  // deterministic (the built-boot smoke's convention).
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

describe('assembled search card', () => {
  it('renders the grep card, its truncation summary, and its capped head/tail slice from the built bundles', async () => {
    history.replaceState(null, '', '/?fixture')
    const root = document.createElement('div')
    root.id = 'root'
    document.body.appendChild(root)
    win.__DSH_BOOT__ = { rev: 'fx', entries: PLUGINS.map(({ dir: _dir, ...plugin }) => plugin) }
    act(() => {
      const entry = new AppWebEntry(root, {
        loadBundle: async (url) => {
          const code = bundles.get(url)
          if (code === undefined) throw new Error(`missing built bundle ${url}`)
          ;(0, eval)(code)
        },
      })
      void entry.run()
      unmount = () => { entry.dispose() }
    })

    const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
    fireEvent.click(await within(tree).findByText('Fixture 历史会话'))
    // Wait for chat content to reach the fixture's later turns (the bash sample
    // is turn 65, the grep card turn 66).
    await waitFor(() => {
      expect(document.querySelector('[data-sample="bash"]')).not.toBeNull()
    }, { timeout: 10_000 })
    // The grep turn's keyed SearchRow composes ToolRow: the card is collapsed
    // by default, so wait for the summary row, then expand it to reach the card.
    await waitFor(() => {
      const tools = [...document.querySelectorAll('[data-tool]')].map(el => el.getAttribute('data-tool'))
      expect(tools, `tools present: ${tools.join(', ')}`).toContain('grep')
    }, { timeout: 10_000 })

    // `data-tool` sits on the ToolRow root; the collapsed row is the expand
    // toggle. Click it so the card and its recovery footer mount, then shape the
    // whole row (the card lives inside ToolRow's body wrapper).
    const grepRow = document.querySelector('[data-tool="grep"]')!
    act(() => { fireEvent.click(grepRow.querySelector('[data-expandable]') ?? grepRow) })
    await waitFor(() => {
      expect(grepRow.querySelector('[data-search]')).not.toBeNull()
    }, { timeout: 10_000 })
    const shape = cardShape(grepRow)
    if (refreshing) {
      mkdirSync(dirname(EXPECTED), { recursive: true })
      writeFileSync(EXPECTED, shape)
    }
    await expect(shape).toMatchFileSnapshot(EXPECTED)
  })
})
