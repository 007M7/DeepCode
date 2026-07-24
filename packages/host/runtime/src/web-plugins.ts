/**
 * Web client plugin assembly: mounts @cordisjs/plugin-loader with an in-memory
 * entry tree over the caller-supplied client plugin roster. The roster is a
 * composition decision and lives in the composing app (apps/cli); this module
 * only owns the mount/settle/fail-loud mechanics. The web plugin registry
 * discovers fetch-arrival entries among the mounted packages by their
 * package.json dshClient declarations; node halves are empty applies, so
 * mounting them here costs nothing beyond Loader governance.
 */
import { createRequire } from 'node:module'
import type { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'

/** What the shell hands the web plugin registry (loader view + module resolution seam). */
export interface MountedWebPlugins {
  /** Entry enumeration surface of the mounted Loader (registry scan source). */
  loader: { entries(): Iterable<{ options: { name: string }; fiber?: unknown; disabled: boolean }> }
  /** Resolve a plugin package's package.json absolute path. */
  resolvePkgJson: (name: string) => string
}

/**
 * Mount the Loader (when absent) and create one in-memory entry per client
 * plugin package, then wait for the tree to settle. A plugin whose import
 * fails leaves its entry fiber-less — surfaced here as a loud throw listing
 * the failures (misconfiguration must not silently drop a client plugin).
 * @param ctx - host root context (bootHost product).
 * @param plugins - client plugin package names to mount (the composition layer's roster).
 * @param anchor - module URL anchoring bare-specifier resolution (the composing
 * app's import.meta.url; the roster packages must be dependencies of that app).
 * @returns the loader view and package.json resolver the registry consumes.
 */
export async function mountWebPlugins(
  ctx: Context, plugins: readonly string[], anchor: string,
): Promise<MountedWebPlugins> {
  // The Loader resolves bare specifiers against ctx.baseUrl; without one the
  // import silently fails and every entry stays fiber-less. The composing app
  // declares the roster packages as dependencies, so its URL is the right anchor.
  ctx.baseUrl ??= anchor
  if (ctx.get('loader') === undefined) await ctx.plugin(Loader)
  const existing = new Set([...ctx.loader.entries()].map(entry => entry.options.name))
  for (const name of plugins) {
    if (!existing.has(name)) await ctx.loader.create({ name })
  }
  await ctx.loader.await()
  const dead = [...ctx.loader.entries()]
    .filter(entry => plugins.includes(entry.options.name))
    .filter(entry => entry.fiber === undefined && !entry.disabled)
  if (dead.length > 0) {
    throw new Error(`web-plugins: client plugin(s) failed to load: ${dead.map(e => e.options.name).join(', ')}`)
  }
  const require = createRequire(anchor)
  return {
    loader: ctx.loader,
    resolvePkgJson: name => require.resolve(`${name}/package.json`),
  }
}
