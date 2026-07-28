// @vitest-environment jsdom
// Terminal card snapshot over the BUILT client graph (the code-mode-fixture
// idiom: real bundles via AppWebEntry, keyless FixtureApiClient transport).
// Opens the fixture history session and pins the `card: 'terminal'` render
// intent at both of its conversation render sites, for both chat-row shapes:
// turn 60's `fx-bash` on the render-site fallback row (expand-gated body) and
// turn 66's `bash` on the keyed BashRow registration (resident body), plus the
// details panel's Output section. Turn 66 carries what turn 60's three plain
// lines cannot — SGR runs resolved to --dsw-* tokens, output past the chat
// cap, a nested cwd, and a non-zero exit pill.
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

/** Collapse decorative whitespace while preserving the text a user sees. */
function visibleText(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Read one terminal card's user-visible state. Output lines keep their interior
 * whitespace: holding column alignment is what this card exists for, so
 * collapsing runs of spaces would hide the behavior under test.
 */
function readCard(card: Element) {
  const status = card.querySelector('[class*="_status_"]')
  const expander = card.querySelector('button[aria-expanded]')
  return {
    prompt: `${card.querySelector('[class*="_cwd_"]')?.textContent ?? ''} ${card.querySelector('[class*="_command_"]')?.textContent ?? ''}`,
    status: status === null ? null : status.textContent,
    copy: card.querySelector('[class*="_copyButton_"]')?.textContent ?? null,
    lines: [...card.querySelectorAll('[class*="_line_"]')].map(line => line.textContent),
    expander: expander === null ? null : {
      label: expander.getAttribute('aria-label'),
      text: expander.textContent,
      expanded: expander.getAttribute('aria-expanded'),
    },
    // The run-state dot at the head of the prompt line, by its StateDot state.
    runState: card.querySelector('[class*="_runState_"][data-state]')?.getAttribute('data-state') ?? null,
    runStateLabel: card.querySelector('[class*="_runStateLabel_"]')?.textContent ?? null,
    // Every color the ANSI parser emits resolves through a --dsw-* token, so
    // the card follows the theme instead of painting literal terminal rgb.
    // Scoped to the output lines: the run-state dot is an inline-styled span
    // too, and its geometry is not an ANSI-resolved color.
    colors: [...new Set([...card.querySelectorAll('[class*="_line_"] span[style]')]
      .map(span => span.getAttribute('style')))],
  }
}

/** Open the fixture history session (the alpha log carrying both bash turns) and wait for its tail. */
async function openFixtureSession(): Promise<void> {
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  // Anchor on the expandable Workspace group row: the title and the blank
  // session row can both read "fixture".
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
  fireEvent.click(await within(tree).findByText('Fixture 历史会话'))
  await waitFor(() => {
    expect(document.querySelector('[data-sample="bash-global"]')).not.toBeNull()
  }, { timeout: 10_000 })
}

/** The keyed BashRow of fixture turn 66 (the one carrying the ANSI sample). */
function keyedBashRow(): Element {
  const row = [...document.querySelectorAll('[data-sample="bash-global"]')]
    .find(node => visibleText(node).includes('pnpm run check'))
  if (row === undefined) throw new Error('keyed bash row for turn 66 missing')
  return row
}

/** The turn-60 fallback row, which reaches the terminal card through GenericToolCard/ToolRow. */
function fallbackBashRow(): Element {
  const row = document.querySelector('[data-tool="fx-bash"]')
  if (row === null) throw new Error('fx-bash fallback row missing')
  return row
}

it('renders the keyed bash row with a resident terminal card', async () => {
  boot()
  await openFixtureSession()

  const row = keyedBashRow()
  const card = row.parentElement?.querySelector('[data-terminal]')
  if (card === null || card === undefined) throw new Error('keyed bash row has no resident terminal card')
  // The prompt shortens the nested cwd to its last segment, the exit pill
  // recovers the trailing marker's code, ANSI runs land on theme tokens, and
  // the chat cap (8) collapses the middle into a head/tail split with an
  // expander between them.
  expect(readCard(card)).toMatchInlineSnapshot(`
    {
      "colors": [
        "font-weight: 700;",
        "color: var(--dsw-alias-state-success-primary);",
        "color: var(--dsw-alias-state-error-primary);",
      ],
      "copy": "复制",
      "expander": {
        "expanded": "false",
        "label": "展开其余 14 行输出",
        "text": "… 其余 14 行",
      },
      "lines": [
        "Running 4 checks",
        "✓ typecheck                                          1.82s",
        "✓ lint                                               0.94s",
        "✓ duplication                                        2.10s",
        "markdown/Markdown.tsx       100%     100%        100%         -",
        "",
        "1 of 4 checks failed",
        "[exit code: 1]",
      ],
      "prompt": "nested pnpm run check",
      "runState": "error",
      "runStateLabel": "失败",
      "status": "退出码 1",
    }
  `)
})

it('the fallback row reaches the same card through its expand control', async () => {
  boot()
  await openFixtureSession()

  const row = fallbackBashRow()
  expect(row.querySelector('[data-terminal]')).toBeNull()
  const toggle = row.querySelector('button[aria-expanded]')
  if (toggle === null) throw new Error('fallback row expand control missing')
  fireEvent.click(toggle)
  const card = await waitFor(() => {
    const found = row.querySelector('[data-terminal]')
    if (found === null) throw new Error('terminal card missing after expanding the fallback row')
    return found
  })
  // Three plain lines under the cap: no ANSI spans, no exit pill, no expander.
  expect(readCard(card)).toMatchInlineSnapshot(`
    {
      "colors": [],
      "copy": "复制",
      "expander": null,
      "lines": [
        "total 2",
        "drwxr-xr-x fixture",
        "-rw-r--r-- demo.txt",
      ],
      "prompt": "fixture ls -la",
      "runState": "done",
      "runStateLabel": "已完成",
      "status": null,
    }
  `)
})

it('the chat card expands the collapsed middle in place, without opening the details panel', async () => {
  boot()
  await openFixtureSession()

  const card = keyedBashRow().parentElement?.querySelector('[data-terminal]')
  if (card === null || card === undefined) throw new Error('resident terminal card missing')
  const expander = card.querySelector('button[aria-expanded]')
  if (expander === null) throw new Error('height-cap expander missing')
  const capped = card.querySelectorAll('[class*="_line_"]').length

  fireEvent.click(expander)
  await waitFor(() => {
    expect(card.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true')
  })
  expect({
    cappedLines: capped,
    expandedLines: card.querySelectorAll('[class*="_line_"]').length,
    expanderLabel: card.querySelector('button[aria-expanded]')?.getAttribute('aria-label'),
    // The card sits outside the summary row's click target, so toggling it
    // left the details panel shut.
    detailsOpen: screen.queryByText('Input') !== null,
  }).toMatchInlineSnapshot(`
    {
      "cappedLines": 8,
      "detailsOpen": false,
      "expandedLines": 22,
      "expanderLabel": "收起输出",
    }
  `)
})

it('the details panel Output section renders the same call at full height', async () => {
  boot()
  await openFixtureSession()

  fireEvent.click(keyedBashRow())
  const label = await screen.findByText('Output')
  const section = label.closest('section')
  if (section === null) throw new Error('Output section missing')
  const card = section.querySelector('[data-terminal]')
  if (card === null) throw new Error('details panel Output is not a terminal card')

  const chatLines = keyedBashRow().parentElement?.querySelectorAll('[class*="_line_"]').length ?? 0
  expect({
    ...readCard(card),
    // The panel keeps the primitive's own allowance (16) against the chat
    // row's 8, so it shows strictly more of the same output.
    panelLines: card.querySelectorAll('[class*="_line_"]').length,
    chatLines,
  }).toMatchInlineSnapshot(`
    {
      "chatLines": 8,
      "colors": [
        "font-weight: 700;",
        "color: var(--dsw-alias-state-success-primary);",
        "color: var(--dsw-alias-state-error-primary);",
        "color: var(--dsw-alias-label-tertiary);",
      ],
      "copy": "复制",
      "expander": {
        "expanded": "false",
        "label": "展开其余 6 行输出",
        "text": "… 其余 6 行",
      },
      "lines": [
        "Running 4 checks",
        "✓ typecheck                                          1.82s",
        "✓ lint                                               0.94s",
        "✓ duplication                                        2.10s",
        "✗ unit                                               8.41s",
        "",
        "packages/client/ui-primitives/tests/terminal-block.spec.tsx",
        "  FAIL caps output at the configured line budget",
        "CodeBlock.tsx               98.4%    96.2%       100%         41-43",
        "highlight.ts                100%     100%        100%         -",
        "Pill.tsx                    100%     100%        100%         -",
        "StateDot.tsx                100%     100%        100%         -",
        "markdown/Markdown.tsx       100%     100%        100%         -",
        "",
        "1 of 4 checks failed",
        "[exit code: 1]",
      ],
      "panelLines": 16,
      "prompt": "nested pnpm run check",
      "runState": "error",
      "runStateLabel": "失败",
      "status": "退出码 1",
    }
  `)
})
