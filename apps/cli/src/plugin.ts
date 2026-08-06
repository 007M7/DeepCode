/**
 * `dsh plugin --profile <name> <args...>` — profile plugin management as a
 * thin pnpm forwarder: initialize the profile on first use, run
 * `pnpm <args...>` in the profile directory, then reconcile the `dsh.plugins`
 * bundle-layer list from the manifest's dependency diff (a package exporting
 * a `dsh.patch` joins the layer stack; one without only warns — it is a plain
 * library dependency; a removed dependency leaves the stack).
 * @module @deepseek-ai/dsh/plugin
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_PROFILE_PLUGINS,
  initProfile,
  PROFILE_TEMPLATES,
  readProfileManifest,
  resolveBundleDir,
  resolveProfileDir,
  writeProfileManifest,
  type ProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import { INSTALL_ANCHOR } from './profile-boot.ts'

const NAME = 'dsh'

/**
 * Whether a resolved dependency exports a profile patch, i.e. is a bundle.
 * @param packageName - the dependency's package name.
 * @param profileDir - the profile directory (resolution anchor).
 * @returns true when the package manifest declares `dsh.patch`.
 */
function exportsPatch(packageName: string, profileDir: string): boolean {
  let dir: string
  try {
    dir = resolveBundleDir(NAME, packageName, INSTALL_ANCHOR, profileDir)
  } catch {
    return false // pnpm reported success yet the package is unresolvable — treat as plain
  }
  const manifest = readProfileManifest(NAME, dir)
  return manifest.dsh?.patch !== undefined
}

/**
 * Reconcile `dsh.plugins` against the manifest's dependency diff: pnpm has
 * already written the real installed names, so a git/path/tarball/alias spec
 * on the command line reconciles by its true package name. Added bundle
 * dependencies append (in dependency order); removed dependencies drop.
 */
function reconcilePlugins(before: ProfileManifest, profileDir: string): void {
  const after = readProfileManifest(NAME, profileDir)
  const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
  const afterDeps = Object.keys(after.dependencies ?? {})
  const plugins = after.dsh?.plugins ?? []
  let changed = false
  for (const packageName of afterDeps) {
    if (beforeDeps.has(packageName) || plugins.includes(packageName)) continue
    if (!exportsPatch(packageName, profileDir)) {
      process.stderr.write(
        `${NAME}: warning: ${packageName} declares no dsh.patch — installed as a plain dependency, not a profile layer `
        + '(if it gains one later, add it to dsh.plugins in the profile\'s package.json)\n',
      )
      continue
    }
    plugins.push(packageName)
    changed = true
  }
  const afterSet = new Set(afterDeps)
  for (const packageName of beforeDeps) {
    if (afterSet.has(packageName) || !plugins.includes(packageName)) continue
    plugins.splice(plugins.indexOf(packageName), 1)
    changed = true
  }
  if (!changed) return
  after.dsh = { ...after.dsh, plugins }
  writeProfileManifest(profileDir, after)
}

/**
 * Run one `dsh plugin` invocation: init if needed, forward to pnpm, reconcile.
 * @param profile - the profile name.
 * @param args - pnpm arguments, verbatim.
 * @returns the pnpm exit code.
 */
export function runPlugin(profile: string, args: readonly string[]): number {
  const dir = resolveProfileDir(profile)
  if (!existsSync(join(dir, 'package.json'))) {
    initProfile(dir, PROFILE_TEMPLATES[profile] ?? DEFAULT_PROFILE_PLUGINS)
    process.stderr.write(`${NAME}: initialized profile ${profile} at ${dir}\n`)
  }
  const before = readProfileManifest(NAME, dir)
  // Windows resolves pnpm through its .cmd shim, which spawn() refuses
  // without a shell since the CVE-2024-27980 hardening.
  const result = spawnSync('pnpm', [...args], {
    cwd: dir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      process.stderr.write(`${NAME}: pnpm not found on PATH — install pnpm to manage profile plugins\n`)
      return 127
    }
    throw result.error
  }
  const exitCode = result.status ?? 1
  if (exitCode === 0) reconcilePlugins(before, dir)
  return exitCode
}
