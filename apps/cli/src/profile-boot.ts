/**
 * Shared profile boot for every `dsh` surface: resolve the profile, stack its
 * patch layers (bundle layers in `dsh.plugins` order, the profile's own
 * `cordis.patch.yml`, `--patch` overlays, flag-derived patches, the telemetry
 * switch), mount the tree over the profile's empty root config, keep the
 * profile patch layer live, and wire fail-loud plus bounded shutdown.
 * @module @deepseek-ai/dsh/profile-boot
 */

import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'
import type { PatchOptions } from '@cordisjs/plugin-include'
import {
  boot,
  composeEntries,
  healProfilesModuleFallback,
  installFailLoud,
  loadOverlayPatches,
  loadProfile,
  watchPersonalPatches,
  type Profile,
} from '@deepseek-ai/dsh-app-boot'
import type { HeadlessIo } from '@deepseek-ai/dsh-headless'
import { createProcessShutdown, type ProcessShutdown } from './process-shutdown.ts'

const NAME = 'dsh'

/** Absolute path of this dsh installation's package.json (both anchors: src/ and lib/ sit one level under apps/cli). */
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** The session-telemetry row id the DSH_TELEMETRY_DISABLED switch targets. */
const TELEMETRY_ROW_ID = 'telemetry-otel'

/** The one-shot runner row a positional task requires and configures. */
const HEADLESS_ROW_ID = 'headless-runner'

/** The empty root entry list every profile tree patches over. */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.plugins, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/** Root config filename inside a profile directory. */
const PROFILE_ROOT_FILENAME = 'cordis.yml'

/**
 * Resolve the telemetry opt-out switch into its boot patch. ANY non-empty
 * value (including `'0'`/`'false'`) disables: a privacy switch prefers
 * off-by-mistake over on-by-mistake. Throws when the switch is set but the
 * row is absent — a silently no-op "disabled" privacy switch would keep
 * exporting while the user believes it is off.
 * @param disabledEnv - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param hasRow - whether the composition carries the telemetry row.
 * @returns the disable patch, or `undefined` when telemetry stays enabled.
 */
export function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '') return undefined
  if (!hasRow) {
    throw new Error(`dsh: DSH_TELEMETRY_DISABLED is set but row "${TELEMETRY_ROW_ID}" is not in this composition`)
  }
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/** Load a resolved profile for `name`, healing the shared module fallback first. */
function prepareProfile(name: string): Profile {
  healProfilesModuleFallback(INSTALL_ANCHOR)
  const profile = loadProfile(NAME, name, INSTALL_ANCHOR)
  const rootConfig = join(profile.dir, PROFILE_ROOT_FILENAME)
  // The root is always rewritten to the empty list: the whole composition is
  // patch layers, and the vendored Loader's tree write-back (a plugin
  // self-disposing persists the current tree) can bake composed rows into
  // this file — which would duplicate every bundle insert on the next boot.
  // The file stays a real on-disk include root only because the Loader needs
  // one to anchor `baseUrl` at the profile directory.
  writeFileSync(rootConfig, PROFILE_ROOT_CONFIG)
  return profile
}

/** One profile's full patch stack and the row index of its composed tree. */
interface ComposedProfile {
  profile: Profile
  /** Bundle + profile + --patch + flag layers, in application order. */
  patches: PatchOptions[]
  /** id → composed row (post-composition), for flag merges and row checks. */
  rows: Map<string, { name?: string; config?: unknown }>
}

/**
 * Load `name` and compose its effective patch stack. Flag patches derive from
 * the pre-flag composition (`deriveFlagPatches` receives the row index of
 * bundle + profile + overlay layers), then apply last, then the telemetry
 * switch.
 * @param name - the profile name.
 * @param patchFiles - `--patch` overlay paths, in argv order.
 * @param deriveFlagPatches - launcher hook turning composed rows into flag patches.
 * @returns the profile, its patch stack, and the composed row index (flags included).
 */
function composeProfile(
  name: string,
  patchFiles: readonly string[],
  deriveFlagPatches: (rows: ComposedProfile['rows']) => PatchOptions[] = () => [],
): ComposedProfile {
  const profile = prepareProfile(name)
  const overlayLayers = patchFiles.map(file => loadOverlayPatches(NAME, resolve(file)))
  const layers = [
    ...profile.layers.map(layer => layer.patches),
    profile.patches,
    ...overlayLayers,
  ]
  const indexRows = (composedEntries: { id?: string; name?: string; config?: unknown; group?: unknown }[]): ComposedProfile['rows'] => {
    const rows = new Map<string, { name?: string; config?: unknown }>()
    const walk = (entries: typeof composedEntries): void => {
      for (const row of entries) {
        if (typeof row.id === 'string') rows.set(row.id, row)
        if (row.group === true && Array.isArray(row.config)) walk(row.config as typeof composedEntries)
      }
    }
    walk(composedEntries)
    return rows
  }
  const flagPatches = deriveFlagPatches(indexRows(composeEntries(layers)))
  layers.push(flagPatches)
  const rows = indexRows(composeEntries(layers))
  const patches = layers.flat()
  const telemetryPatch = resolveTelemetryPatch(process.env.DSH_TELEMETRY_DISABLED, rows.has(TELEMETRY_ROW_ID))
  if (telemetryPatch !== undefined) patches.push(telemetryPatch)
  return { profile, patches, rows }
}

/** Options for {@link runProfile}. */
export interface RunProfileOptions {
  /** The profile name to boot. */
  profile: string
  /** `--patch` overlay paths, in argv order. */
  patchFiles: readonly string[]
  /** Launcher hook turning the pre-flag composed rows into flag patches (the web alias's flag family). */
  deriveFlagPatches?: (rows: ComposedProfile['rows']) => PatchOptions[]
  /** One-shot task text; requires the composition to mount the headless runner row. */
  task?: string
  /** Surface setup registered after Loader installation and before any config-tree entry mounts. */
  prepare?: (ctx: Context) => Promise<void> | void
}

/**
 * Boot one profile invocation end to end and leave process lifetime to the
 * mounted plugins (or to the one-shot runner when `task` is present).
 * @param options - profile name, overlays, flag patches, and the optional task.
 * @returns the settled root context and the shutdown controller.
 */
export async function runProfile(options: RunProfileOptions): Promise<{ ctx: Context; shutdown: ProcessShutdown }> {
  const composed = composeProfile(options.profile, options.patchFiles, options.deriveFlagPatches)
  if (options.task !== undefined) {
    if (!composed.rows.has(HEADLESS_ROW_ID)) {
      throw new Error(
        `dsh: profile ${JSON.stringify(options.profile)} takes no task — its composition mounts no "${HEADLESS_ROW_ID}" row `
        + '(the headless profile does)',
      )
    }
    composed.patches.push({ id: HEADLESS_ROW_ID, config: { task: options.task } })
  } else if (composed.rows.has(HEADLESS_ROW_ID)) {
    // The inverse misuse: a one-shot composition booted without its task
    // would otherwise die in the runner row's schema with a raw "required"
    // error naming no fix.
    throw new Error(
      `dsh: profile ${JSON.stringify(options.profile)} mounts the one-shot runner and needs a task: `
      + `dsh --profile ${options.profile} "<task>"`,
    )
  }

  const app: { current?: Context } = {}
  const shutdown = createProcessShutdown(async () => { await app.current?.fiber.dispose() })
  // Signals own teardown throughout the startup window, not only after boot()
  // settles: an inserted front door can publish readiness before sibling rows
  // finish mounting.
  process.on('SIGTERM', () => { shutdown.interrupt(options.task === undefined ? 0 : 143) })
  process.on('SIGINT', () => { shutdown.interrupt(130) })
  installFailLoud(NAME, process, async () => {
    await app.current?.fiber.dispose()
  })

  const rootConfig = join(composed.profile.dir, PROFILE_ROOT_FILENAME)
  // Recomposition for the live profile layer: bundle layers below, overlays
  // and flag patches above, so a profile edit can never displace them.
  const overlayAndFlags = composed.patches.slice(
    composed.profile.layers.reduce((n, layer) => n + layer.patches.length, 0)
    + composed.profile.patches.length,
  )
  const composeLive = (profilePatches: PatchOptions[]): PatchOptions[] => [
    ...composed.profile.layers.flatMap(layer => layer.patches),
    ...profilePatches,
    ...overlayAndFlags,
  ]
  // One-shot runs exit through the runner; watching would only hold the
  // process open after its exit request.
  const watchProfilePatch = options.task === undefined
  const ctx = await boot(NAME, rootConfig, composed.patches, async (hostCtx) => {
    app.current = hostCtx
    if (options.task !== undefined) {
      const io: HeadlessIo = {
        stdout: process.stdout,
        stderr: process.stderr,
        exit: (code) => { void shutdown.shutdown(code) },
      }
      hostCtx.provide('headlessIo', io)
    }
    await options.prepare?.(hostCtx)
  })
  app.current = ctx
  // A surface can dispose the whole tree while startup was still in flight
  // (early SIGTERM); the Loader service goes with it and there is nothing to
  // keep live.
  if (watchProfilePatch && ctx.get('loader') !== undefined) {
    // Config-only HMR for the live profile patch layer: the web bundle
    // disables the shared module-reload `hmr` row (its reload lifecycle is
    // untested), so when the composition leaves no HMR service, mount a
    // watch-only instance with no module roots — cordis.patch.yml edits stay
    // live on every long-lived surface. A silent skip would break the
    // documented hot-reload contract. HMR injects the timer service, which a
    // bare custom profile may not mount either.
    if (ctx.get('hmr') === undefined) {
      if (ctx.get('timer') === undefined) {
        await ctx.loader.create({ name: '@cordisjs/plugin-timer' })
      }
      await ctx.loader.create({ name: '@cordisjs/plugin-hmr', config: { root: [] } })
    }
    await watchPersonalPatches(ctx, {
      binName: NAME,
      filename: composed.profile.patchPath,
      compose: composeLive,
    })
  }
  return { ctx, shutdown }
}
