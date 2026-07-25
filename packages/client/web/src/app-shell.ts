/**
 * App-shell assembly plugin (design §3.4): the shell's ONLY composition
 * responsibility, packaged as a normal static-arrival entry so the host graph
 * stays the single composition authority. It rides the same entry lifecycle
 * as every other plugin — the fiber waits on slots/sessions/layout, so by the
 * time apply runs the layout entry is mounted and its export surface is
 * readable from the governance side (module loadCache, design §2.6).
 *
 * The pseudo package id exists only in the host graph and the shell's static
 * registry; there is no npm package behind it.
 */
import type { ReactNode } from 'react'
import type { Context } from 'cordis'
import { createSlotRenderer } from '@deepseek-ai/dsh-client-web-react'
import { buildRenderApp } from './app.tsx'

/** Shell-owned pseudo entry id under which the host graph mounts this plugin. */
export const APP_SHELL_ID = '@deepseek-ai/dsh-client-app-shell'

/** The assembled-UI face AppRoot renders once the boot settles. */
export interface AppShellService {
  /** Build (once) and render the real UI tree. */
  renderApp: () => ReactNode
}

declare module 'cordis' {
  interface Context {
    /** The shell assembly face, provided by the app-shell entry once its inject set is active. */
    appShell: AppShellService
  }
}

/** Cordis plugin name. */
export const name = 'app-shell'

/** Required services: the product services the assembly closes over (layout registers the 'root' slot entry). */
export const inject = ['slots', 'sessions', 'layout']

/**
 * Plugin body: install the React renderer into the slot system and provide
 * the renderApp face (one ctx-level renderSlot('root') call).
 * @param ctx - plugin context (inject set active).
 */
export function apply(ctx: Context): void {
  // The renderer install is shell territory (web-react is shell-bundled),
  // but ctx.slots exists only once the runtime entry is active — so it lands
  // here, on the entry whose inject set guarantees that ordering.
  ctx.slots.install(createSlotRenderer())

  // Assemble once on first render: the closure must be identity-stable
  // across AppRoot re-renders.
  let renderApp: (() => ReactNode) | undefined
  ctx.reflect.provide('appShell', {
    renderApp: (): ReactNode => {
      renderApp ??= buildRenderApp({ ctx })
      return renderApp()
    },
  })
}
