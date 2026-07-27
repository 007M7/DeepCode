// @vitest-environment jsdom
// Code Mode fixture snapshot over the BUILT client graph (the workspace-flow
// idiom: real bundles via AppWebEntry, keyless FixtureApiClient transport).
// Opens the fixture history session and pins the run_code turn's rendering:
// the code-variant parent row titled by the model-authored description, its
// three always-visible nested sub-rows (bash through the sample registration,
// read through GenericToolCard, the failing read wearing the error state),
// the expanded program body, details-panel resolution of a sub-callId, and
// the trajectory/waterfall tabs' sub-call cells and timing lanes.
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

/** Open the fixture history session (the alpha log carrying the run_code turn) and scroll to its tail. */
async function openFixtureSession(): Promise<void> {
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  const group = within(tree).getByText('4 sessions').closest<HTMLElement>('[role="treeitem"]')
  if (group === null) throw new Error('fixture Workspace group missing')
  if (group.getAttribute('aria-expanded') === 'false') {
    fireEvent.click(within(group).getByText('fixture'))
    await waitFor(() => {
      expect(within(tree).getByText('4 sessions').closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('true')
    })
  }
  const session = await within(tree).findByText('Fixture 历史会话')
  fireEvent.click(session)
  await waitFor(() => {
    expect(document.querySelector('[data-variant="code"]')).not.toBeNull()
  }, { timeout: 10_000 })
}

it('renders the fixture run_code turn: code parent row, nested sub-rows, error state', async () => {
  boot()
  await openFixtureSession()

  const codeRoot = document.querySelector('[data-variant="code"]')
  if (codeRoot === null) throw new Error('code-variant row missing')
  const nest = codeRoot.closest('[class*="callRow"]')?.querySelector('[data-subcalls]')
  if (nest === undefined || nest === null) throw new Error('sub-call nest missing under the code row')

  expect({
    parentRow: visibleText(codeRoot),
    // The three sub-rows in dispatch order: bash rides the sample plugin's
    // keyed registration (the same one a native top-level bash row uses),
    // both reads ride GenericToolCard.
    bashSample: nest.querySelector('[data-sample="bash-global"]') !== null,
    subRows: [...nest.querySelectorAll(':scope > *')].map(visibleText),
    errorSubRow: nest.querySelector('[data-state="error"]') !== null,
  }).toMatchInlineSnapshot(`
    {
      "bashSample": true,
      "errorSubRow": true,
      "parentRow": "CodeRead the notes files and summarize",
      "subRows": [
        "$List notes",
        "Readnotes/demo.txt",
        "Readnotes/missing.txt",
      ],
    }
  `)
})

it('expands the code row into the program body and resolves a sub-row through the details panel', async () => {
  boot()
  await openFixtureSession()

  // Expand: the leading control reveals the program (shiki-tokenized: the
  // text splits into styled spans inside one <pre class="shiki"> tree).
  const codeRoot = document.querySelector('[data-variant="code"]')
  if (codeRoot === null) throw new Error('code-variant row missing')
  const toggle = codeRoot.querySelector('button[aria-expanded]')
  if (toggle === null) throw new Error('code row expand control missing')
  fireEvent.click(toggle)
  await waitFor(() => {
    // Scope to THIS row: the markdown fixture turn also renders shiki pres.
    const pre = codeRoot.querySelector('pre.shiki')
    if (pre === null || !(pre.textContent ?? '').includes('const listing = await tools.bash')) {
      throw new Error('highlighted program body missing under the code row')
    }
  })

  // Sub-row click → details panel resolves the sub-callId with FULL output.
  const nest = document.querySelector('[data-subcalls]')
  if (nest === null) throw new Error('sub-call nest missing')
  const bashRow = nest.querySelector('[data-sample="bash-global"]')
  if (bashRow === null) throw new Error('bash sample sub-row missing')
  fireEvent.click(bashRow)
  const details = await screen.findByText('Input')
  const panel = details.closest('[class*="root"]')
  if (panel === null) throw new Error('details panel missing')
  expect({
    title: visibleText(within(panel as HTMLElement).getByText('bash')),
    inputEchoesArgs: visibleText(panel).includes('ls notes'),
    outputComplete: visibleText(panel).includes('demo.txt new-demo.txt')
      || visibleText(panel).includes('demo.txt\nnew-demo.txt')
      || (panel.textContent ?? '').includes('demo.txt\nnew-demo.txt'),
  }).toMatchInlineSnapshot(`
    {
      "inputEchoesArgs": true,
      "outputComplete": true,
      "title": "bash",
    }
  `)
})

it('trajectory and waterfall surface the run_code sub-calls with real timing', async () => {
  boot()
  await openFixtureSession()

  // Switch to the trajectory tab (same slot ring the chat view registers in).
  fireEvent.click(await screen.findByRole('tab', { name: 'Trajectory' }))
  await waitFor(() => {
    expect(document.querySelector('[data-kind="subtool"]')).not.toBeNull()
  }, { timeout: 10_000 })
  const subCells = [...document.querySelectorAll('[data-kind="subtool"]')]
  expect({
    // Three Sub cells nested under the run_code Tool cell, in dispatch order,
    // each with a real +N.Ns own-duration off the start/settle pair (the
    // fixture spaces every event 800ms apart — never the em dash).
    subCells: subCells.map(cell => visibleText(cell)),
  }).toMatchInlineSnapshot(`
    {
      "subCells": [
        "#51Subbash · {"command":"ls notes","description":"List notes"}+0.8s",
        "#52Subread · {"path":"notes/demo.txt"}+0.8s",
        "#53Subread · {"path":"notes/missing.txt"}+0.8s",
      ],
    }
  `)

  // Waterfall: each sub-call draws a measured lane scaled into the parent
  // turn's dispatch window.
  fireEvent.click(screen.getByRole('tab', { name: 'Waterfall' }))
  await waitFor(() => {
    expect(document.querySelector('[data-subspan]')).not.toBeNull()
  }, { timeout: 10_000 })
  const lanes = [...document.querySelectorAll('[data-subspan]')]
  expect({
    lanes: lanes.map(lane => ({
      label: visibleText(lane.querySelector('[class*="subTag"]') ?? lane),
      title: lane.querySelector('[data-timing]')?.getAttribute('title'),
      timing: lane.querySelector('[data-timing]')?.getAttribute('data-timing'),
    })),
  }).toMatchInlineSnapshot(`
    {
      "lanes": [
        {
          "label": "bash",
          "timing": "measured",
          "title": "bash · 0.80s",
        },
        {
          "label": "read",
          "timing": "measured",
          "title": "read · 0.80s",
        },
        {
          "label": "read",
          "timing": "measured",
          "title": "read · 0.80s",
        },
      ],
    }
  `)
})
