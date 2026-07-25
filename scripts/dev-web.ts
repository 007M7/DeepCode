/**
 * Watch-build for client-plugin HMR: runs every dshClient plugin package
 * through the tsdown JS API in watch mode. Reload signaling is not this
 * script's business — the host webserver stat-polls the bundles it serves and
 * broadcasts `rebuilt` frames itself (`dsh web --dev`), so any process that
 * rewrites `lib/client.js` files triggers reloads; this script is merely the
 * convenient way to keep them all rebuilt on source change.
 *
 * Usage: `pnpm exec tsx scripts/dev-web.ts [--poll[=ms]]`. Requires the
 * packages' node halves built once (`tsc -b tsconfig.build.json`): the lib
 * config's entries are tsc output. `--poll` switches the source-file watcher
 * to polling (default 500ms): network mounts (weka) deliver no inotify
 * events, so native watching sees the initial build only and never a source
 * change.
 *
 * Each package keeps its own tsdown.config.ts untouched: this script layers
 * `watch` through API-level inline config (tsdown workspace mode fills inline
 * keys under each package's file config, and no package config defines it).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'tsdown'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * Discover the watch workspace by declaration: every packages/<group>/<name>
 * whose package.json carries `dshClient` with platform "web" is a client
 * plugin bundle emitter. Scanned once at startup — a package added while
 * watching means restarting this script.
 * @returns workspace-relative plugin package directories.
 */
function discoverPluginDirs(): string[] {
  const dirs: string[] = []
  for (const group of readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const pkg of readdirSync(join(repoRoot, 'packages', group.name), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      let manifest: { dshClient?: { platform?: unknown } }
      try {
        manifest = JSON.parse(
          readFileSync(join(repoRoot, 'packages', group.name, pkg.name, 'package.json'), 'utf8'),
        ) as { dshClient?: { platform?: unknown } }
      } catch {
        continue // no package.json (support dirs, scratch): not a workspace package
      }
      if (manifest.dshClient?.platform === 'web') dirs.push(`packages/${group.name}/${pkg.name}`)
    }
  }
  return dirs
}

const PLUGIN_DIRS = discoverPluginDirs()
if (PLUGIN_DIRS.length === 0) {
  console.error('dev-web: no dshClient (platform "web") packages found under packages/')
  process.exit(1)
}

const args = process.argv.slice(2)
const pollArg = args.find(a => a === '--poll' || a.startsWith('--poll='))
if (args.some(a => a !== pollArg)) {
  console.error('dev-web: usage: tsx scripts/dev-web.ts [--poll[=ms]]')
  process.exit(1)
}
const pollInterval = pollArg === undefined ? undefined : Number(pollArg.split('=')[1] ?? '500')
if (pollInterval !== undefined && (!Number.isInteger(pollInterval) || pollInterval <= 0)) {
  console.error(`dev-web: invalid --poll interval "${pollArg ?? ''}"`)
  process.exit(1)
}

await build({
  cwd: repoRoot,
  workspace: PLUGIN_DIRS,
  watch: true,
  // Rolldown watch options ride through inputOptions (tsdown has no watcher
  // tuning of its own); polling is opt-in for network mounts without inotify.
  ...pollInterval !== undefined
    ? { inputOptions: { watch: { watcher: { usePolling: true, pollInterval } } } }
    : {},
})
console.log(
  `dev-web: watching ${String(PLUGIN_DIRS.length)} dshClient plugin packages`
  + `${pollInterval !== undefined ? ` (polling ${String(pollInterval)}ms)` : ''}:\n  ${PLUGIN_DIRS.join('\n  ')}`,
)
