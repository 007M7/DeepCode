/**
 * Shared boot glue for the app bins (`dsh`, `dsh-cli-demo`, `dsh-acp-demo`): load the gitignored
 * `.env`, install the fail-loud Loader guards, resolve the config path (snapshot-aware), load the
 * optional personal overlay patches from the Harness home (`~/.dsh`), and drive the cordis Loader
 * against a leaf `cordis.yml` until the whole tree has settled.
 * @module @deepseek-ai/dsh-app-boot
 */

import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { Context, type FiberState } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Include, { type PatchOptions } from '@cordisjs/plugin-include'
import { resolveDshHome } from '@deepseek-ai/dsh-paths'
// Side-effect type import: resolves `ctx.get('systemPrompt')` to the service.
import type {} from '@deepseek-ai/dsh-system-prompt'

/**
 * Resolve the config to boot. Replay swaps a `cordis.yml` basename for
 * `cordis.snapshot.yml` in the same directory; every other mode keeps the path.
 * @param configPath - the requested config path (absolute, or relative to `cwd`).
 * @param snapshotMode - the bin's `$DSH_SNAPSHOT` value; only `'replay'` swaps the
 *   basename.
 * @param cwd - the base a relative `configPath` resolves against.
 * @returns the absolute path of the config to boot.
 */
export function resolveConfigPath(
  configPath: string, snapshotMode: string | undefined, cwd: string = process.cwd(),
): string {
  const absolute = resolve(cwd, configPath)
  if (snapshotMode !== 'replay') return absolute
  const dir = dirname(absolute)
  const replayName = basename(absolute).replace(/cordis\.ya?ml$/, 'cordis.snapshot.yml')
  return resolve(dir, replayName)
}

/**
 * Load the optional gitignored `.env` from `dir`. Missing files fall back to the
 * ambient environment; other read failures are reported through `warn`.
 * @param binName - the diagnostic prefix on the warn line.
 * @param dir - the directory whose `.env` to load.
 * @param warn - sink for the one-line misconfiguration diagnostic.
 */
export function loadEnv(
  binName: string, dir: string = process.cwd(),
  warn: (line: string) => void = line => void process.stderr.write(line),
): void {
  try {
    process.loadEnvFile(resolve(dir, '.env'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      warn(`${binName}: failed to load .env: ${String(error)}\n`)
    }
    // ENOENT (no .env) is fine — rely on the ambient environment.
  }
}

/** File inside the Harness home holding the personal loader overlay patches. */
export const PERSONAL_CONFIG_FILENAME = 'config.yaml'

// The include's YAML dialect: `!!js` scalars become expression nodes the
// Loader interpolates against each entry's context at mount time. Personal
// patches are parsed with the same schema so they may reference `process.env`.
// Load-only: this schema never dumps, so no `predicate`/`represent`.
const jsExprType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: data => typeof data === 'string',
  construct: data => ({ __jsExpr: String(data) }),
})
const personalPatchesSchema = yaml.JSON_SCHEMA.extend(jsExprType)

/**
 * Load the optional personal overlay patches (`config.yaml` under the Harness
 * home). The file is a top-level YAML array of loader patch entries
 * (`@cordisjs/plugin-include`'s `PatchOptions`): id-targeted config overrides
 * and `insert` lists, with `!!js` expressions allowed. A missing file means
 * "no personal overlay"; an unreadable, unparsable, or non-array file throws —
 * a present personal config that cannot apply is a misconfiguration and must
 * fail loud at boot, never be silently skipped.
 * @param binName - the diagnostic prefix on the thrown error.
 * @param dir - the Harness home; defaults to {@link resolveDshHome} (`$DSH_HOME` or `~/.dsh`).
 * @returns the parsed patches, or `undefined` when the file does not exist.
 */
export function loadPersonalPatches(
  binName: string, dir: string = resolveDshHome(),
): PatchOptions[] | undefined {
  const file = join(dir, PERSONAL_CONFIG_FILENAME)
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    throw new Error(`${binName}: failed to read personal patches ${file}: ${String(error)}`)
  }
  return parsePatchList(binName, file, content, 'personal patches')
}

/**
 * Load a required overlay patch list: a surface overlay (`tui.cordis.yml`) or a
 * `--config <path>` overlay applied over the shared base. Same file format as
 * {@link loadPersonalPatches}, but a missing file throws, because the caller
 * named this file — its absence is a misconfiguration, not "no overlay".
 * @param binName - the diagnostic prefix on the thrown error.
 * @param file - absolute path of the overlay file.
 * @returns the parsed patch list.
 */
export function loadOverlayPatches(binName: string, file: string): PatchOptions[] {
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`${binName}: failed to read overlay ${file}: ${String(error)}`)
  }
  return parsePatchList(binName, file, content, 'overlay')
}

/**
 * Parse one loader patch list: a top-level YAML array of
 * `@cordisjs/plugin-include` `PatchOptions` (id-targeted config overrides and
 * `insert` lists, `!!js` expressions allowed). Every shape failure throws,
 * because a patch file that cannot be applied at all is a misconfiguration; a
 * single patch whose target row is absent stays a per-entry Loader warning, so
 * one overlay shared across surfaces does not have to match every tree.
 * @param binName - the diagnostic prefix on the thrown error.
 * @param file - the source path, quoted in errors.
 * @param content - the file's text.
 * @param label - what to call this list in errors (`personal patches`, `overlay`).
 * @returns the parsed patch list.
 */
function parsePatchList(
  binName: string, file: string, content: string, label: string,
): PatchOptions[] {
  let parsed: unknown
  try {
    parsed = yaml.load(content, { schema: personalPatchesSchema })
  } catch (error) {
    throw new Error(`${binName}: failed to parse ${label} ${file}: ${String(error)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${binName}: ${label} ${file} must be a top-level YAML array of loader patch entries`)
  }
  parsed.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${binName}: ${label} entry ${index + 1} in ${file} must be a mapping (a loader patch entry)`)
    }
  })
  return parsed as PatchOptions[]
}

/**
 * The slice of `process` {@link installFailLoud} needs — injectable so tests
 * exercise the handler without registering on (or exiting) the real process.
 */
export interface FailLoudProcess {
  on(event: 'unhandledRejection', handler: (err: unknown) => void): unknown
  off(event: 'unhandledRejection', handler: (err: unknown) => void): unknown
  stderr: { write(chunk: string): unknown }
  exit(code: number): void
}

// Loader rc.5 derives and drops a rejected promise after a fiber fails. Keep
// exact reasons already folded into the boot diagnostic visible through the
// next process rejection checkpoint so the process guard can coalesce them.
const assembledActivationRejections = new Map<unknown, number>()

function retainAssembledRejection(reason: unknown): void {
  assembledActivationRejections.set(reason, (assembledActivationRejections.get(reason) ?? 0) + 1)
}

function releaseAssembledRejection(reason: unknown): void {
  const count = assembledActivationRejections.get(reason)
  if (count === undefined || count === 1) {
    assembledActivationRejections.delete(reason)
  } else {
    assembledActivationRejections.set(reason, count - 1)
  }
}

async function observeLoaderRejectionCheckpoint(reasons: readonly unknown[]): Promise<void> {
  for (const reason of reasons) retainAssembledRejection(reason)
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
  } finally {
    for (const reason of reasons) releaseAssembledRejection(reason)
  }
}

/**
 * Install before boot to turn a late unhandled plugin-init rejection into one
 * labelled stderr diagnostic and `exit(1)`. A rejection already included by
 * {@link assertEntriesActivated} is ignored during its process checkpoint;
 * every other rejection remains fatal. Stdout remains untouched for ACP; the
 * returned function removes the handler.
 * @param binName - the diagnostic prefix on the fatal-failure line.
 * @param proc - the process slice to register on; tests inject a fake.
 * @returns the uninstaller that removes the rejection handler.
 */
export function installFailLoud(binName: string, proc: FailLoudProcess = process): () => void {
  const handler = (err: unknown): void => {
    if (assembledActivationRejections.has(err)) return
    proc.stderr.write(`${binName}: fatal load failure: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    proc.exit(1)
  }
  proc.on('unhandledRejection', handler)
  return () => void proc.off('unhandledRejection', handler)
}

/**
 * After the tree settles, reject entries with no fiber and name every plugin
 * whose module failed to resolve. Disabled entries are the only valid
 * fiber-less state.
 * @param ctx - the settled context whose loader entries to audit.
 * @param binName - the diagnostic prefix on the thrown error.
 */
export function assertEntriesLoaded(ctx: Context, binName: string): void {
  const failed = [...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
  if (failed.length > 0) {
    const names = failed.map(entry => entry.options.name).join(', ')
    throw new Error(`${binName}: plugin(s) failed to load: ${names}; Cordis startup failed because these plugin(s) could not be resolved (see the error(s) logged above)`)
  }
}

/**
 * Value mirrors used because Cordis's const enum has no runtime object to import.
 * Keep aligned with `packages/cordis/tool-cordis/src/fiber-state.ts` and
 * `packages/client/web/src/loader-status.ts`.
 */
const FIBER_PENDING = 0 as FiberState.PENDING
const FIBER_ACTIVE = 2 as FiberState.ACTIVE
const FIBER_FAILED = 3 as FiberState.FAILED

/** Render a thrown plugin value without discarding an Error's original stack. */
function formatActivationError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error)
}

/**
 * Reject a settled Loader tree when an enabled entry failed or remains inactive.
 * Plugin failures include the original thrown stack; pending entries name their
 * unresolved services because no plugin error exists for that state. Active
 * entries require no further wait; only failed fibers are awaited to recover
 * their private rejection reason.
 * @param ctx - the settled context whose Loader entries to audit.
 * @param binName - the diagnostic prefix on the thrown error.
 * @returns nothing when every enabled entry is active.
 * @throws after one process rejection checkpoint when an entry failed to
 * import, rejected during activation, or did not become active.
 */
export async function assertEntriesActivated(ctx: Context, binName: string): Promise<void> {
  assertEntriesLoaded(ctx, binName)
  const failures: string[] = []
  const rejectionReasons: unknown[] = []
  for (const entry of ctx.loader.entries()) {
    const fiber = entry.fiber
    if (fiber === undefined || entry.disabled) continue
    const state = fiber.state
    if (state === FIBER_ACTIVE) continue
    if (state === FIBER_FAILED) {
      try {
        await fiber.await()
      } catch (error) {
        rejectionReasons.push(error)
        failures.push(`${entry.options.name}: ${formatActivationError(error)}`)
      }
      continue
    }
    if (state === FIBER_PENDING) {
      const missing = Object.keys(fiber.inject).filter(service => fiber.ctx.get(service) === undefined)
      const subject = missing.length === 1 ? 'service' : 'services'
      failures.push(`${entry.options.name}: pending (waiting for ${subject}: ${missing.join(', ') || 'unknown'})`)
    } else {
      failures.push(`${entry.options.name}: fiber state ${String(state)}`)
    }
  }
  if (failures.length > 0) {
    if (rejectionReasons.length > 0) {
      await observeLoaderRejectionCheckpoint(rejectionReasons)
    }
    const noun = failures.length === 1 ? 'entry' : 'entries'
    throw new Error(`${binName}: ${String(failures.length)} ${noun} did not activate\n${failures.join('\n')}`)
  }
}

/**
 * Boot the Loader against `absoluteConfigPath` and return only after the whole
 * tree settles. Entry names load through the Loader's internal module loader
 * against `baseUrl` (the config directory), which may live outside
 * `node_modules` reach and, unbuilt, cannot load vendored source; the
 * bootstrap include is therefore statically imported and mounted as the
 * `cordis:include` builtin, loading through the ambient module pipeline
 * (vite/tsx/plain ESM) while the included tree's own specifiers stay
 * config-relative. The package build embeds Include while leaving Loader
 * external, so the built include tree and host share one Loader peer. A
 * missing fiber rejects here; a later init rejection is rethrown with its
 * original stack by {@link assertEntriesActivated}; later unhandled
 * rejections remain covered by {@link installFailLoud}. Built bins need the
 * Loader's native helper for bare plugin specifiers; relative specifiers do
 * not.
 * @param binName - the diagnostic prefix for load-failure errors.
 * @param absoluteConfigPath - the config to include; must already be absolute
 * (see {@link resolveConfigPath}).
 * @param patches - optional overlay patches applied over the included tree
 * (see {@link loadPersonalPatches}); an empty list mounts none.
 * @param prepare - optional host setup run after Loader installation and before any config-tree entry mounts.
 * @returns the root context once every entry has started, or as soon as a
 * surface disposed the tree while startup was still in flight.
 */
export async function boot(
  binName: string,
  absoluteConfigPath: string,
  patches?: PatchOptions[],
  prepare?: (ctx: Context) => Promise<void> | void,
): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await prepare?.(ctx)
  await ctx.loader.create({
    name: 'cordis:include',
    config: {
      path: pathToFileURL(absoluteConfigPath).href,
      ...patches !== undefined && patches.length > 0 ? { patches } : {},
    },
  })
  await ctx.loader.await()
  // A surface can finish and dispose the whole tree while that await is still
  // pending: the TUI renders as soon as its own fiber starts, so an `/exit`
  // typed before the last entry settles tears the context down under us. The
  // Loader service goes with it, and the activation audit describes a live
  // tree — reading `ctx.loader` here would throw a TypeError over an app that
  // exited exactly as asked.
  if (ctx.get('loader') === undefined) return ctx
  await assertEntriesActivated(ctx, binName)
  return ctx
}

/** Prompt-section name for the harness-source location line an app bin adds after boot. */
export const HARNESS_SOURCE_SECTION = 'harness:source'

/**
 * Add a global prompt section naming the on-disk path to the harness source
 * checkout the running bin was launched from, so the agent knows where its own
 * source lives (the self-referential `dsh-tool-cordis` toolset reads and edits
 * it). Call once on the settled boot context ({@link boot}); the section orders
 * just after the harness identity opener (`-100`) and before the deployment
 * persona (`0`). A booted tree with no `systemPrompt` service has no prompt to
 * augment, so this is then a no-op that returns `undefined`. The section is
 * registered against the `systemPrompt` service's fiber, so a dev HMR reload of
 * that plugin drops it until the next boot.
 * @param ctx - the settled boot context whose global system prompt to augment.
 * @param sourceRoot - the absolute path to the harness checkout root.
 * @returns the section disposer, or `undefined` when no `systemPrompt` service is mounted.
 */
export function addHarnessSourceSection(ctx: Context, sourceRoot: string): (() => void) | undefined {
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt === undefined) return undefined
  return systemPrompt.section({
    name: HARNESS_SOURCE_SECTION,
    order: -99,
    text: `Your own source code is the checkout at ${sourceRoot}; you can read it there to learn how dsh works and how to extend it.`,
  })
}
