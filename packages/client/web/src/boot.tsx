/**
 * Web shell boot — the kernel face consumed by the apps/web entry. Everything
 * here is machinery that cannot itself be an entry, and none of it
 * value-imports a plugin package (web2 shell self-sufficiency rule: the
 * loading page must work while — especially when — plugins fail).
 *
 * Two-stage boot (web2 §0):
 *   Stage one (module face): build the module system over the host graph
 *   (`window.__DSH_BOOT__`) and prefetch every `immediately` row in parallel
 *   — fetch + execute registers factories only; module side effects wait for
 *   materialization. Prefetch failures are non-fatal here: stage two's
 *   import path retries the fetch and owns the loud failure.
 *   Stage two (plugin face): mount the vendored cordis Loader, inject the
 *   module system as its internal seam (BEFORE any entry exists — the
 *   bare-import fallback in tree.import must never run in a browser), create
 *   one loader entry per graph row (tree.import materializes each module),
 *   let fibers activate on service availability, then loader.await() + a
 *   full fiber sweep (all ACTIVE, else reject listing who/what/which
 *   service) → flip the settled signal so AppRoot switches to the real UI in
 *   one pass.
 *
 * Composition lives in the host graph; the shell makes zero composition
 * decisions (the app-shell assembly is itself a graph entry, the only
 * shell-own module registered with the module system).
 */
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { createRoot } from 'react-dom/client'
import {
  createClientModuleLoader,
  type ClientModuleLoader, type ClientModuleLoaderOptions, type DshWindow, type WebBootGraph,
} from '@deepseek-ai/dsh-client-modules'
import * as AppShell from './app-shell.ts'
import { APP_SHELL_ID } from './app-shell.ts'
import { AppRoot } from './AppRoot.tsx'
import { getStaticModules } from './seed.ts'
import {
  STATE_LABELS, createLoaderStatusStore, createSignal, type LoaderStatusStore,
} from './loader-status.ts'
import './base.css'

/** Module transport seams the shell passes through (jsdom tests replace the <script> path). */
export type BootSeams = Pick<ClientModuleLoaderOptions, 'fetchBundle' | 'executeBundle'>

/**
 * Sweep every loader entry after the tree quiesced: an entry without a fiber
 * failed its import; a fiber not ACTIVE is FAILED (apply threw) or PENDING
 * (a required service never arrived — cordis inject waiting has no timeout,
 * so this sweep is the fail-loud compensation).
 */
function assertEntriesActive(ctx: Context): void {
  const failures: string[] = []
  for (const entry of ctx.loader.entries()) {
    const name = entry.options.name
    if (entry.fiber === undefined) {
      failures.push(`${name}: import failed (see console for the import error)`)
      continue
    }
    const state = STATE_LABELS[entry.fiber.state]
    if (state === 'active') continue
    if (state === 'pending') {
      const missing = Object.keys(entry.fiber.inject).filter((service) => ctx.get(service) === undefined)
      failures.push(`${name}: pending (waiting for service${missing.length === 1 ? '' : 's'}: ${missing.join(', ') || 'unknown'})`)
    } else {
      failures.push(`${name}: ${state}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(`web boot: ${String(failures.length)} entr${failures.length === 1 ? 'y' : 'ies'} did not activate\n${failures.join('\n')}`)
  }
}

/** Stage one: prefetch the immediately tier (factory registration only; failures defer to stage two's import). */
async function prefetchImmediateTier(modules: ClientModuleLoader, graph: WebBootGraph): Promise<void> {
  await Promise.all(graph.entries
    .filter((row) => row.immediately === true)
    .map((row) => modules.prefetch(row.id).catch(() => {
      // Import (stage two) refetches and reports this loudly per entry;
      // swallowing here keeps one failing prefetch from masking the others.
    })))
}

/** Stage two: mount the Loader, inject the internal seam, create the graph entries, settle, sweep. */
async function runPluginBoot(
  ctx: Context, modules: ClientModuleLoader, graph: WebBootGraph, status: LoaderStatusStore,
): Promise<void> {
  await ctx.plugin(Loader)
  const loader = ctx.loader
  // Inject the module system BEFORE any entry exists: tree.import falls back
  // to a bare dynamic import when internal is undefined, which in a browser
  // is a guaranteed loud failure — correct as a tripwire, never as a path.
  loader.internal = modules as never

  // Status projection: AppRoot displays fiber truth. Every internal/status
  // transition under an entry re-projects that entry's row from its ROOT
  // fiber (child plugin fibers share the same entry).
  ctx.on('internal/status', (fiber) => {
    const entry = fiber.entry
    if (entry === undefined || entry.fiber === undefined) return
    status.set(entry.options.name, STATE_LABELS[entry.fiber.state])
  })

  // Entry creation order carries no semantics (fiber inject waiting owns
  // activation order); creating concurrently lets non-prefetched bundle
  // fetches parallelize. The app-shell assembly entry is appended by the
  // kernel: it is shell-own code (host graph rows are all plugin bundles),
  // and mounting the assembly is not a composition decision — it rides the
  // same entry lifecycle so the sweep and status cover it uniformly.
  const rows = [...graph.entries.map((row) => row.id), APP_SHELL_ID]
  await Promise.all(rows.map(async (name) => {
    status.set(name, 'loading')
    const id = await loader.create({ name })
    // A failed import leaves the entry fiberless (Entry._init logs and
    // returns); project it as failed — no fiber means no status event.
    if (loader.resolve(id).fiber === undefined) {
      status.set(name, 'failed')
    }
  }))

  await loader.await()
  assertEntriesActive(ctx)
}

/**
 * Mount the web shell into a DOM element and start the two-stage boot chain.
 * @param el - mount point (the app's #root).
 * @param seams - optional module transport overrides (test environments).
 * @returns unmount disposer.
 */
export function bootWebShell(el: HTMLElement, seams?: BootSeams): () => void {
  const graph = (globalThis as DshWindow).__DSH_BOOT__
  if (graph === undefined) throw new Error('web boot: no entry graph (window.__DSH_BOOT__ missing)')

  const ctx = new Context()
  const modules = createClientModuleLoader({ graph, staticModules: getStaticModules(), ...seams })
  // The app-shell assembly is the only shell-own module: every other graph
  // row is a plugin bundle arriving through fetch (web2 single package form).
  modules.registerStatic(APP_SHELL_ID, AppShell)
  // Contract C5: the module system is a boot-owned kernel service (ctx.modules).
  ctx.reflect.provide('modules', modules)

  const status = createLoaderStatusStore()
  const settled = createSignal(false)
  const error = createSignal<string | undefined>(undefined)

  const root = createRoot(el)
  root.render(
    <AppRoot
      settled={settled}
      status={status}
      error={error}
      renderApp={() => {
        const shell = ctx.get('appShell')
        // Unreachable after a clean settle (the app-shell entry is in every graph).
        if (shell === undefined) throw new Error('web boot: appShell service missing after settled')
        return shell.renderApp()
      }}
    />,
  )

  prefetchImmediateTier(modules, graph)
    .then(() => runPluginBoot(ctx, modules, graph, status))
    .then(
      () => { settled.set(true) },
      (reason: unknown) => {
        // Stay on the loading page; surface the sweep report (fail loud).
        console.error(reason)
        error.set(reason instanceof Error ? reason.message : String(reason))
      },
    )
  return () => { root.unmount() }
}
