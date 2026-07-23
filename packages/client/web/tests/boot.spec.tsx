// @vitest-environment jsdom
/**
 * bootWebShell over the REAL client loader in jsdom (runScripts:dangerously —
 * the loader's <script> execute path runs for real): fetch is stubbed to
 * serve fake bundle text, everything else is production code — seeded module
 * table, DSHClientProxy handoff, inject topology, renderer install after
 * settled, the one-line renderSlot('root') shell, and the fail-loud paths —
 * through the loader's fetch/execute seams (jsdom's <script> vm context
 * cannot reach the test window, so execute is indirect eval). The fake
 * runtime is the REAL SlotsService mounted by the real runtime plugin shape;
 * full-fidelity plugin content belongs to the apps/web e2e.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act } from '@testing-library/react'
import { bootWebShell } from '@deepseek-ai/dsh-client-web'
import { createSnapshotStore, defineStore, SlotsService } from '@deepseek-ai/dsh-client-runtime/client'

interface BootWindow extends Window {
  __DSH_BOOT__?: { plugins: { id: string; url: string; inject: string[]; immediately?: boolean }[] }
  DSHClientProxy?: unknown
  __TEST_SLOTS_SERVICE__?: unknown
  __TEST_RUNTIME_STORE__?: { createSnapshotStore: unknown; defineStore: unknown }
}
const win = window as unknown as BootWindow

/**
 * Fake runtime half: mounts the REAL SlotsService (built-in 'root', ledger,
 * install/renderSlot) plus a minimal sessions face for the renderer host.
 * The runtime package is not a seeded library (in production it arrives as a
 * bundle), so the spec hands the real class in through a window global — the
 * plugin body and everything downstream stay production code.
 */
const RUNTIME_STUB = `
window.DSHClientProxy.loadPlugin({
  id: 'fake-runtime',
  factory: (require) => {
    const SlotsService = window.__TEST_SLOTS_SERVICE__
    const { createSnapshotStore } = window.__TEST_RUNTIME_STORE__
    return {
      apply: (ctx) => {
        ctx.plugin(SlotsService)
        const list = createSnapshotStore({ ids: ['s1'], byId: { s1: { id: 's1', title: 'S1', running: false, updatedAt: 1 } }, current: 's1' })
        ctx.provide('sessions', {
          list,
          cell: (id) => (id === 's1' ? { sessionId: 's1', session: { getSnapshot: () => ({}), subscribe: () => () => {} } } : undefined),
        })
      },
    }
  },
})`

/** Fake layout half: ONE terminal register() call — occupy 'root', declare a
 *  child, seat a store factory, expose the store round trip as a probe. */
const LAYOUT_STUB = `
window.DSHClientProxy.loadPlugin({
  id: 'fake-layout',
  factory: (require) => {
    const React = require('react')
    const { defineStore } = window.__TEST_RUNTIME_STORE__
    return {
      inject: ['slots'],
      apply: (ctx) => {
        const createProbeStore = () => defineStore({
          init: () => ({ sidebar: 300, details: 360 }),
          actions: {
            setSidebar: (d, px) => { d.sidebar = px },
            setDetails: (d, px) => { d.details = px },
          },
        })
        ctx.slots.register({
          name: 'root',
          children: { 'probe.child': { kind: 'single', scope: 'root' } },
          store: createProbeStore,
        }, (props) => {
          const sw = props.useStore((st) => st.sidebar)
          const dw = props.useStore((st) => st.details)
          return React.createElement('div', {
            'data-testid': 'fake-frame',
            'data-widths': sw + 'x' + dw,
            onClick: () => { props.actions.setSidebar(311); props.actions.setDetails(411) },
          }, props.renderSlot('probe.child', {}))
        })
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

function bootPlugins(): { id: string; url: string; inject: string[]; immediately?: boolean }[] {
  return [
    { id: 'fake-runtime', url: '/plugins/fake-runtime.js', inject: [], immediately: true },
    { id: LAYOUT_ID, url: '/plugins/fake-layout.js', inject: ['fake-runtime'] },
  ]
}

function fakeBundles(): Record<string, string> {
  return {
    '/plugins/fake-runtime.js': RUNTIME_STUB,
    '/plugins/fake-layout.js': LAYOUT_STUB.replace("id: 'fake-layout'", `id: '${LAYOUT_ID}'`),
  }
}

afterEach(() => {
  delete win.__DSH_BOOT__
  delete win.DSHClientProxy
  delete win.__TEST_SLOTS_SERVICE__
  delete win.__TEST_RUNTIME_STORE__
  document.body.innerHTML = ''
  document.head.querySelectorAll('script').forEach((s) => { s.remove() })
})

/** Hand the real runtime surface to the stub bundle (runtime is not a seeded library). */
function seedSlotsService(): void {
  win.__TEST_SLOTS_SERVICE__ = SlotsService
  win.__TEST_RUNTIME_STORE__ = { createSnapshotStore, defineStore }
}

describe('bootWebShell (real loader + real script execution)', () => {
  it('loading page → settled → renderer installed → assembled UI in one pass; unmount clears the tree', async () => {
    win.__DSH_BOOT__ = { plugins: bootPlugins() }
    seedSlotsService()
    const el = mountPoint()
    let unmount: (() => void) | undefined
    act(() => { unmount = bootWebShell(el, seams(fakeBundles())) })
    expect(el.textContent).toContain('HARNESS')
    expect(el.querySelector('[data-testid="fake-frame"]')).toBeNull()

    await flushLoader()
    expect(el.querySelector('[data-testid="fake-frame"]')).not.toBeNull()
    expect(el.textContent).not.toContain('HARNESS')

    act(() => { unmount!() })
    expect(el.childElementCount).toBe(0)
  })

  it('store seat round-trips through the entry props (useStore + actions)', async () => {
    win.__DSH_BOOT__ = { plugins: bootPlugins() }
    seedSlotsService()
    const el = mountPoint()
    act(() => { bootWebShell(el, seams(fakeBundles())) })
    await flushLoader()
    const frame = el.querySelector('[data-testid="fake-frame"]')
    expect(frame).not.toBeNull()
    // Width write/read round trip through the framework-delivered store share.
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

  it("fail loud: rendering with no 'root' registration throws through the shell error surface", async () => {
    // Runtime loads (slots service present, renderer installed) but no layout
    // entry ever registers into 'root' — the ctx-level renderSlot must throw.
    win.__DSH_BOOT__ = {
      plugins: [{ id: 'fake-runtime', url: '/plugins/fake-runtime.js', inject: [], immediately: true }],
    }
    seedSlotsService()
    const el = mountPoint()
    // React logs the render error before the boundary rethrow reaches us — keep the spec output clean.
    const consoleError = console.error
    console.error = () => {}
    try {
      act(() => { bootWebShell(el, seams({ '/plugins/fake-runtime.js': RUNTIME_STUB })) })
      let thrown: unknown
      try {
        await flushLoader()
      } catch (error) {
        thrown = error
      }
      expect(String(thrown)).toMatch(/'root' has no registration/)
    } finally {
      console.error = consoleError
    }
  })
})

describe('buildRenderApp — assembly contract', () => {
  it('is exactly the ctx-level root render call (fail-loud before install)', async () => {
    const { buildRenderApp } = await import('@deepseek-ai/dsh-client-web')
    const { Context } = await import('cordis')
    const { SlotsService } = await import('@deepseek-ai/dsh-client-runtime/client')
    const ctx = new Context()
    const fiber = ctx.plugin(SlotsService)
    await fiber.await()
    const renderApp = buildRenderApp({ ctx, requireModule: () => undefined })
    expect(renderApp).toBeTypeOf('function')
    // No renderer installed: the one-line shell must surface the boot-order error.
    expect(() => renderApp()).toThrow(/renderer not installed/)
  })
})
