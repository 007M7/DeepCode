/**
 * Web shell boot — the library face consumed by the apps/web entry (api
 * contracts v3 §0.3/§9.3): root ctx → hold the loader machinery (statically
 * imported; the loader cannot load itself) → seed the module table → render
 * the AppRoot loading page → loader.start() → await settled() → flip the
 * settled signal so AppRoot switches to the real UI in one pass. Load
 * failures reject settled(); AppRoot stays on the loading page listing them
 * (fail loud).
 */
import { Context } from 'cordis'
import { createRoot } from 'react-dom/client'
import type { ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { createSlotRenderer } from '@deepseek-ai/dsh-client-web-react'
import { createClientLoader, type ClientLoaderOptions } from '@deepseek-ai/dsh-client-runtime/loader'
import { AppRoot } from './AppRoot.tsx'
import { buildRenderApp } from './app.tsx'
import { seedModules } from './seed.ts'
import './base.css'

/** Manually flipped settled signal (AppRoot's gate; see AppRootProps.settled). */
function settledSignal(): ObservableSnapshot<boolean> & { flip: () => void } {
  let value = false
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    flip: () => {
      value = true
      for (const fn of [...listeners]) fn()
    },
  }
}

/** Loader transport seams the shell passes through (jsdom tests replace the <script> path). */
export type BootSeams = Pick<ClientLoaderOptions, 'fetchBundle' | 'executeBundle'>

/**
 * Mount the web shell into a DOM element and start the plugin load chain.
 * @param el - mount point (the app's #root).
 * @param seams - optional loader transport overrides (test environments).
 * @returns unmount disposer.
 */
export function bootWebShell(el: HTMLElement, seams?: BootSeams): () => void {
  const ctx = new Context()
  const loader = createClientLoader({ ctx, modules: seedModules(), ...seams })
  ctx.reflect.provide('loader', loader)

  const settled = settledSignal()
  // Assemble once on first post-settled render: SessionProvider and the slot
  // closures must be identity-stable across re-renders.
  let renderApp: (() => ReactNode) | undefined
  const renderAppOnce = (): ReactNode => {
    renderApp ??= buildRenderApp({ ctx, requireModule: (spec) => loader.requireModule(spec) })
    return renderApp()
  }

  const root = createRoot(el)
  root.render(<AppRoot settled={settled} status={loader.status} renderApp={renderAppOnce} />)

  loader.start()
  loader.settled().then(
    () => {
      // The renderer install is a shell-boot act, but ctx.slots exists only
      // once the runtime plugin loaded — so it lands here, after settled and
      // before the flip that lets renderApp call renderSlot('root').
      ctx.slots.install(createSlotRenderer())
      settled.flip()
    },
    () => { /* stay on the loading page; failures render from loader.status */ },
  )
  return () => { root.unmount() }
}
