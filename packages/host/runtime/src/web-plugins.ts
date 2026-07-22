/**
 * Web UI plugin assembly: mounts @cordisjs/plugin-loader with an in-memory
 * entry tree listing the eight UI plugin packages (the P-I config-source bar —
 * a cordis.yml file form comes later; install/remove currently means editing
 * this list and restarting). The web plugin registry discovers the entries by
 * their package.json dshClient declarations; node halves are empty applies,
 * so mounting them here costs nothing beyond Loader governance.
 */
import { createRequire } from 'node:module'
import type { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'

/** The eight UI plugin packages served to the browser (order = manifest order). */
export const WEB_UI_PLUGINS = [
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-theme',
  '@deepseek-ai/dsh-client-i18n',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-trajectory',
] as const

/** What the shell hands the web plugin registry (loader view + module resolution seam). */
export interface MountedWebPlugins {
  /** Entry enumeration surface of the mounted Loader (registry scan source). */
  loader: { entries(): Iterable<{ options: { name: string }; fiber?: unknown; disabled: boolean }> }
  /** Resolve a plugin package's package.json absolute path. */
  resolvePkgJson: (name: string) => string
}

/**
 * Mount the Loader (when absent) and create one in-memory entry per UI
 * plugin, then wait for the tree to settle. A plugin whose import fails
 * leaves its entry fiber-less — surfaced here as a loud throw listing the
 * failures (misconfiguration must not silently drop a UI plugin).
 * @param ctx - host root context (bootHost product).
 * @returns the loader view and package.json resolver the registry consumes.
 */
export async function mountWebPlugins(ctx: Context): Promise<MountedWebPlugins> {
  // The Loader resolves bare specifiers against ctx.baseUrl; without one the
  // import silently fails and every entry stays fiber-less. This package
  // depends on all eight UI plugins, so its own URL is the right anchor.
  ctx.baseUrl ??= import.meta.url
  if (ctx.get('loader') === undefined) await ctx.plugin(Loader)
  const existing = new Set([...ctx.loader.entries()].map(entry => entry.options.name))
  for (const name of WEB_UI_PLUGINS) {
    if (!existing.has(name)) await ctx.loader.create({ name })
  }
  await ctx.loader.await()
  const dead = [...ctx.loader.entries()]
    .filter(entry => (WEB_UI_PLUGINS as readonly string[]).includes(entry.options.name))
    .filter(entry => entry.fiber === undefined && !entry.disabled)
  if (dead.length > 0) {
    throw new Error(`web-plugins: UI plugin(s) failed to load: ${dead.map(e => e.options.name).join(', ')}`)
  }
  const require = createRequire(import.meta.url)
  return {
    loader: ctx.loader,
    resolvePkgJson: name => require.resolve(`${name}/package.json`),
  }
}
