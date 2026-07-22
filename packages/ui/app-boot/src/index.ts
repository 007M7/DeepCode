/**
 * Shared boot glue for the app bins (`dsh-tui-demo`, `dsh-cli-demo`, `dsh-acp-demo`): load the gitignored
 * `.env`, install the fail-loud Loader guards, resolve the config path (snapshot-aware), load the
 * optional personal overlay patches from the Harness home (`~/.dsh`), and drive the cordis Loader
 * against a leaf `cordis.yml` until the whole tree has settled.
 * @module @deepseek-ai/dsh-app-boot
 */

import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { Context } from 'cordis'
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

/** CLI flag the interactive surface accepts to resume a persisted session by id. */
const RESUME_FLAG = '--resume'

/**
 * Split a leading `--resume <id>` / `--resume=<id>` flag out of a CLI argument
 * vector, returning the resumed session id (when the flag is present) and the
 * remaining arguments with the flag and its value removed — so a positional
 * config path stays readable regardless of the flag's position. A `--resume`
 * with no following id, an empty id (`--resume=`), or a repeated `--resume`
 * throws: a mistyped resume must fail loud, never silently start a fresh
 * session. The id is not validated here; an unknown id fails loud downstream
 * when the session cannot load.
 * @param argv - the CLI arguments after subcommand dispatch.
 * @returns the parsed resume id (or `undefined`) and the flag-stripped arguments.
 */
export function parseResumeArg(
  argv: readonly string[],
): { resumeSessionId: string | undefined; rest: string[] } {
  const rest: string[] = []
  let resumeSessionId: string | undefined
  let skipNext = false
  for (const [i, arg] of argv.entries()) {
    if (skipNext) {
      skipNext = false
      continue
    }
    const inlineValue = arg.startsWith(`${RESUME_FLAG}=`)
    if (arg === RESUME_FLAG || inlineValue) {
      if (resumeSessionId !== undefined) throw new Error(`${RESUME_FLAG} may be given only once`)
      const value = inlineValue ? arg.slice(RESUME_FLAG.length + 1) : argv[i + 1]
      // A following token that is itself resume syntax (`--resume --resume x`)
      // is a missing id, not a session literally named `--resume…`.
      if (value === undefined || value === '' || value === RESUME_FLAG || value.startsWith(`${RESUME_FLAG}=`)) {
        throw new Error(`${RESUME_FLAG} requires a session id (e.g. ${RESUME_FLAG} <session-id>)`)
      }
      resumeSessionId = value
      skipNext = !inlineValue // the space form consumed the following token as its value
      continue
    }
    rest.push(arg)
  }
  return { resumeSessionId, rest }
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
  let parsed: unknown
  try {
    parsed = yaml.load(content, { schema: personalPatchesSchema })
  } catch (error) {
    throw new Error(`${binName}: failed to parse personal patches ${file}: ${String(error)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${binName}: personal patches ${file} must be a top-level YAML array of loader patch entries`)
  }
  // A present personal config that cannot apply is a misconfiguration and must
  // fail loud here — the include only warns per entry at mount.
  parsed.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${binName}: personal patches entry ${index + 1} in ${file} must be a mapping (a loader patch entry)`)
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

/**
 * Install before boot to turn a late unhandled plugin-init rejection into one
 * labelled stderr diagnostic and `exit(1)`. Stdout remains untouched for ACP;
 * the returned function removes the handler.
 * @param binName - the diagnostic prefix on the fatal-failure line.
 * @param proc - the process slice to register on; tests inject a fake.
 * @returns the uninstaller that removes the rejection handler.
 */
export function installFailLoud(binName: string, proc: FailLoudProcess = process): () => void {
  const handler = (err: unknown): void => {
    proc.stderr.write(`${binName}: fatal load failure: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    proc.exit(1)
  }
  proc.on('unhandledRejection', handler)
  return () => void proc.off('unhandledRejection', handler)
}

/**
 * After the tree settles, reject entries with no fiber, which indicates a
 * swallowed module-import failure. Disabled entries are the only valid
 * fiber-less state.
 * @param ctx - the settled context whose loader entries to audit.
 * @param binName - the diagnostic prefix on the thrown error.
 */
export function assertEntriesLoaded(ctx: Context, binName: string): void {
  const failed = [...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
  if (failed.length > 0) {
    const names = failed.map(entry => entry.options.name).join(', ')
    throw new Error(`${binName}: plugin(s) failed to load: ${names} (see the error(s) logged above)`)
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
 * config-relative. A missing fiber rejects here; a later init rejection is
 * handled by {@link installFailLoud}. Built bins need `--expose-internals` or
 * the Loader's native fallback for bare plugin specifiers; relative specifiers
 * do not.
 * @param binName - the diagnostic prefix for load-failure errors.
 * @param absoluteConfigPath - the config to include; must already be absolute
 * (see {@link resolveConfigPath}).
 * @param patches - optional overlay patches applied over the included tree
 * (see {@link loadPersonalPatches}); an empty list mounts none.
 * @returns the root context once every entry has started.
 */
export async function boot(
  binName: string, absoluteConfigPath: string, patches?: PatchOptions[],
): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({
    name: 'cordis:include',
    config: {
      path: pathToFileURL(absoluteConfigPath).href,
      ...patches !== undefined && patches.length > 0 ? { patches } : {},
    },
  })
  await ctx.loader.await()
  assertEntriesLoaded(ctx, binName)
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
