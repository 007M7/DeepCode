// @vitest-environment jsdom
/**
 * bootWebShell over the REAL client loader in jsdom (runScripts:dangerously —
 * the loader's <script> execute path runs for real): fetch is stubbed to
 * serve fake bundle text, everything else is production code — seeded module
 * table, DSHClientProxy handoff, inject topology, settled flip, one-pass
 * switch to the assembled UI, and the fail-loud path — through the loader's
 * fetch/execute seams (jsdom's <script> vm context cannot reach the test
 * window, so execute is indirect eval). The fake plugins pull the REAL
 * SlotCore from the seeded ui-slots module; full-fidelity plugin content
 * belongs to the apps/web e2e.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act } from '@testing-library/react'
import { bootWebShell } from '@deepseek-ai/dsh-client-web'

interface BootWindow extends Window {
  __DSH_BOOT__?: { plugins: { id: string; url: string; inject: string[]; immediately?: boolean }[] }
  DSHClientProxy?: unknown
  __TEST_NAV__?: { sessionId?: string; viewFor: Record<string, string> }
}
const win = window as unknown as BootWindow

/** Fake runtime half: real SlotCore behind a minimal slots service + sessions stub. */
const RUNTIME_STUB = `
window.DSHClientProxy.loadPlugin({
  id: 'fake-runtime',
  factory: (require) => {
    const { SlotCore } = require('@deepseek-ai/dsh-client-ui-slots')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-web-react')
    return {
      apply: (ctx) => {
        const core = new SlotCore()
        ctx.provide('slots', { core, define: (k, s) => core.define(k, s), register: (k, c, o) => core.register(k, c, o) })
        const binding = {
          sessionId: 's1',
          session: { useSelector: (sel) => sel({}) },
          ctx,
        }
        ctx.provide('sessions', {
          list: createSnapshotStore({ ids: ['s1'], byId: { s1: { id: 's1', title: 'S1', running: false, updatedAt: 1 } } }),
          binding: (id) => (id === 's1' ? binding : undefined),
        })
      },
    }
  },
})`

/** Fake layout half: real slot specs + the export surface the shell assembly consumes. */
const LAYOUT_STUB = `
window.DSHClientProxy.loadPlugin({
  id: 'fake-layout',
  factory: (require) => {
    const React = require('react')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-web-react')
    return {
      inject: ['slots'],
      AppFrame: (props) => {
        const sw = props.useSidebar((st) => st.width)
        const dw = props.useDetails((st) => st.width)
        return React.createElement('div', {
          'data-testid': 'fake-frame',
          'data-widths': sw + 'x' + dw,
          onClick: () => { props.setSidebarWidth(311); props.setDetailsWidth(411) },
        }, props.sidebar, props.children)
      },
      CenterColumn: (props) => React.createElement('div', null, props.children),
      DetailsColumn: (props) => React.createElement('div', null, props.children),
      apply: (ctx) => {
        const sidebar = createSnapshotStore({ open: true, width: 300 })
        const details = createSnapshotStore({ open: false, width: 360 })
        ctx.reflect.provide('layout', {
          current: createSnapshotStore(window.__TEST_NAV__ ?? { sessionId: 's1', viewFor: {} }),
          sidebar, details,
          setSidebarWidth: (px) => { sidebar.update((d) => { d.width = px }) },
          setDetailsWidth: (px) => { details.update((d) => { d.width = px }) },
        })
        ctx.slots.define('sidebar', { kind: 'single', scope: 'root' })
        ctx.slots.define('conversation', { kind: 'single', scope: 'session' })
        ctx.slots.define('details', { kind: 'single', scope: 'session' })
        ctx.slots.define('conversation.empty', { kind: 'single', scope: 'root' })
        ctx.slots.core.register('conversation', () => React.createElement('div', { 'data-testid': 'conv-body' }))
      },
    }
  },
})`

// The shell assembly requires the layout surface under its production id.
const LAYOUT_ID = '@deepseek-ai/dsh-client-ui-layout'

/** Loader seams: serve fake bundle text and execute it via indirect eval (jsdom's <script> vm context cannot see the test window). */
function seams(bundles: Record<string, string>) {
  return {
    fetchBundle: (url: string): Promise<string> => {
      const hit = Object.keys(bundles).find((b) => url.endsWith(b))
      if (hit === undefined) return Promise.reject(new Error(`bundle fetch ${url} answered 404`))
      return Promise.resolve(bundles[hit]!)
    },
    executeBundle: (code: string): void => {
      (0, eval)(code)
    },
  }
}

function mountPoint(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

async function flushLoader(): Promise<void> {
  // fetch + per-plugin apply chain across macrotask turns; a few settle it.
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

afterEach(() => {
  delete win.__DSH_BOOT__
  delete win.DSHClientProxy
  delete win.__TEST_NAV__
  document.body.innerHTML = ''
  document.head.querySelectorAll('script').forEach((s) => { s.remove() })
})

describe('bootWebShell (real loader + real script execution)', () => {
  it('loading page → settled → assembled UI in one pass; unmount clears the tree', async () => {
    win.__DSH_BOOT__ = {
      plugins: [
        { id: 'fake-runtime', url: '/plugins/fake-runtime.js', inject: [], immediately: true },
        { id: LAYOUT_ID, url: '/plugins/fake-layout.js', inject: ['fake-runtime'] },
      ],
    }
    const el = mountPoint()
    let unmount: (() => void) | undefined
    const s = seams({
      '/plugins/fake-runtime.js': RUNTIME_STUB,
      '/plugins/fake-layout.js': LAYOUT_STUB.replace("id: 'fake-layout'", `id: '${LAYOUT_ID}'`),
    })
    act(() => { unmount = bootWebShell(el, s) })
    expect(el.textContent).toContain('HARNESS')
    expect(el.querySelector('[data-testid="fake-frame"]')).toBeNull()

    await flushLoader()
    expect(el.querySelector('[data-testid="fake-frame"]')).not.toBeNull()
    expect(el.textContent).not.toContain('HARNESS')
    // Selected session: SessionProvider resolved the binding and renderBody
    // mounted the conversation slot content into the center column.
    expect(el.querySelector('[data-testid="conv-body"]')).not.toBeNull()

    act(() => { unmount!() })
    expect(el.childElementCount).toBe(0)
  })

  it('no selected session: renderEmpty keeps the grid and forwards width setters', async () => {
    win.__TEST_NAV__ = { viewFor: {} }
    win.__DSH_BOOT__ = {
      plugins: [
        { id: 'fake-runtime', url: '/plugins/fake-runtime.js', inject: [], immediately: true },
        { id: LAYOUT_ID, url: '/plugins/fake-layout.js', inject: ['fake-runtime'] },
      ],
    }
    const el = mountPoint()
    const s = seams({
      '/plugins/fake-runtime.js': RUNTIME_STUB,
      '/plugins/fake-layout.js': LAYOUT_STUB.replace("id: 'fake-layout'", `id: '${LAYOUT_ID}'`),
    })
    act(() => { bootWebShell(el, s) })
    await flushLoader()
    const frame = el.querySelector('[data-testid="fake-frame"]')
    expect(frame).not.toBeNull()
    // Empty path: no conversation body (nothing registered into conversation.empty → fallback null).
    expect(el.querySelector('[data-testid="conv-body"]')).toBeNull()
    // Width setter/selector pass-through (assembly closures over ctx.layout).
    expect((frame as HTMLElement).dataset['widths']).toBe('300x360')
    act(() => { (frame as HTMLElement).click() })
    expect((frame as HTMLElement).dataset['widths']).toBe('311x411')
  })

  it('fail loud: a 404 bundle keeps the loading page and lists the plugin id', async () => {
    win.__DSH_BOOT__ = { plugins: [{ id: 'absent-plugin', url: '/plugins/absent.js', inject: [] }] }
    const el = mountPoint()
    act(() => { bootWebShell(el, seams({})) })
    await flushLoader()
    expect(el.textContent).toContain('Failed to load plugins')
    expect(el.textContent).toContain('absent-plugin')
    expect(el.querySelector('[data-testid="fake-frame"]')).toBeNull()
  })
})

describe('buildRenderApp — assembly guards', () => {
  it('throws loud when the sessions service is absent', async () => {
    const { buildRenderApp } = await import('@deepseek-ai/dsh-client-web')
    const { Context } = await import('cordis')
    const ctx = new Context()
    ctx.reflect.provide('layout', {})
    expect(() => buildRenderApp({
      ctx,
      requireModule: () => ({ AppFrame: () => null, CenterColumn: () => null, DetailsColumn: () => null }),
    })).toThrow(/sessions service unavailable/)
  })
})
