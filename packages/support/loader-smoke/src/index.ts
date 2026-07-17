/**
 * Shared subprocess harness for keyless example smokes that boot a real
 * `cordis.yml` through the stdio-agent bin and Cordis Loader.
 *
 * It also owns the mode-aware launch resolver every example subprocess harness shares
 * ({@link resolveExampleLaunch}): booting an example bin from TypeScript source under `tsx` (the
 * zero-build dev path, resolving `@deepseek-ai/dsh-*` / `@cordisjs/*` through the tsconfig `paths`
 * map) or from built `lib/` under plain Node (resolving bare packages through real `exports`, as an
 * installed consumer does, while Node type-strips relative example-local TypeScript plugins).
 * Consolidating that spawn glue here retires the copies in the ACP snapshot harness and the example
 * e2e drivers (the `TODO(acp-test-harness)`).
 *
 * @module @deepseek-ai/dsh-loader-smoke
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_PROCESS_TIMEOUT_MS = 30_000

/** Vitest deadline that leaves room for the subprocess-owned 30-second diagnostic timeout. */
export const LOADER_SMOKE_TEST_TIMEOUT_MS = DEFAULT_PROCESS_TIMEOUT_MS + 15_000

/** Which artifact an example bin is booted from: unbuilt `src` via tsx, or built `lib` via plain Node. */
export type ExampleMode = 'src' | 'lib'

/** Environment variable selecting the mode; CI and pre-push set it to `lib`, dev leaves it unset (`src`). */
export const EXAMPLE_MODE_ENV = 'DSH_EXAMPLE_MODE'

/**
 * Parse an {@link ExampleMode} from a raw string, defaulting to `src` when absent so an unset
 * environment reproduces the dev/tsx behavior. Throws on any other value rather than silently
 * falling back, so a typo in a gate's env fails loud.
 * @param raw - the raw value; defaults to `process.env.DSH_EXAMPLE_MODE`.
 * @returns the validated mode.
 */
export function resolveExampleMode(raw: string | undefined = process.env[EXAMPLE_MODE_ENV]): ExampleMode {
  switch (raw) {
    case undefined:
    case '':
    case 'src':
      return 'src'
    case 'lib':
      return 'lib'
    default:
      throw new Error(`${EXAMPLE_MODE_ENV} must be 'src' or 'lib', got ${JSON.stringify(raw)}.`)
  }
}

/** Inputs to {@link resolveExampleLaunch}. */
export interface ExampleLaunchOptions {
  /** Absolute path to the example bin's TypeScript source entry (`<pkg>/src/bin.ts`); the `lib` bin is derived from it. */
  readonly srcBin: string
  /** Explicit plain-Node entry for `lib` mode; test fixtures may point this at Node-type-strippable TypeScript. */
  readonly libBin?: string | undefined
  /** Arguments passed after the bin — the config, positional (`[configPath]`) or flagged (`['--config', configPath]`). */
  readonly configArgs?: readonly string[]
  /** The mode to launch in; defaults to {@link resolveExampleMode} of the environment. */
  readonly mode?: ExampleMode
  /** Absolute repo tsconfig whose `paths` map resolves unbuilt workspace imports. Required in `src` mode, ignored in `lib`. */
  readonly tsconfigPath?: string
  /** Prepend `--expose-internals` (the Cordis Loader's bare-plugin resolver needs it for some bins); defaults to `false`. */
  readonly exposeInternals?: boolean
  /** Extra environment entries the mode-specific ones layer over; the caller then merges the result over `process.env`. */
  readonly env?: NodeJS.ProcessEnv
}

/** The resolved spawn: `spawn(command, args, { env: { ...process.env, ...env } })`. */
export interface ExampleLaunch {
  /** The executable to spawn — always the current Node binary. */
  readonly command: string
  /** Node flags, the resolved bin, then the caller's `configArgs`. */
  readonly args: string[]
  /** Mode-specific environment (`TSX_TSCONFIG_PATH` in `src`, nothing added in `lib`) layered over the caller's `env`. */
  readonly env: NodeJS.ProcessEnv
}

/** Derive the built-lib bin (`<pkg>/lib/<name>.js`) from a source bin (`<pkg>/src/<name>.ts`). */
function toLibBin(srcBin: string): string {
  const markerLength = '/src/'.length
  const cut = Math.max(srcBin.lastIndexOf('/src/'), srcBin.lastIndexOf('\\src\\'))
  if (cut === -1) {
    throw new Error(`resolveExampleLaunch: expected a "/src/" segment or Windows equivalent in bin path ${JSON.stringify(srcBin)}.`)
  }
  const separator = srcBin.slice(cut, cut + 1)
  const tail = srcBin.slice(cut + markerLength).replace(/\.ts$/, '.js')
  return `${srcBin.slice(0, cut)}${separator}lib${separator}${tail}`
}

/**
 * Resolve how to spawn an example bin in the selected mode.
 *
 * `src` yields `node [--expose-internals] --import <tsx> <srcBin> <configArgs>` with `TSX_TSCONFIG_PATH`
 * set so the tsconfig `paths` map resolves workspace imports to source. `lib` yields
 * `node [--expose-internals] <libBin> <configArgs>` under plain Node with no tsx and no paths map, so
 * bare package plugins resolve through real package `exports` into built `lib/`; relative example-local
 * TypeScript plugins remain source files loaded through Node's built-in type stripping. Bare resolution
 * requires the config to live below a workspace that declares its `cordis.yml` package dependencies.
 *
 * @param options - the source bin, config arguments, mode, and environment.
 * @returns the command, argument vector, and mode-specific environment to spawn with.
 */
export function resolveExampleLaunch(options: ExampleLaunchOptions): ExampleLaunch {
  const mode = options.mode ?? resolveExampleMode()
  const configArgs = options.configArgs ?? []
  const flags = options.exposeInternals === true ? ['--expose-internals'] : []
  const env: NodeJS.ProcessEnv = { ...options.env }

  if (mode === 'src') {
    if (options.tsconfigPath === undefined) {
      throw new Error("resolveExampleLaunch: 'src' mode needs tsconfigPath for the workspace paths map.")
    }
    const tsxLoader = import.meta.resolve('tsx')
    env.TSX_TSCONFIG_PATH = options.tsconfigPath
    return { command: process.execPath, args: [...flags, '--import', tsxLoader, options.srcBin, ...configArgs], env }
  }

  return { command: process.execPath, args: [...flags, options.libBin ?? toLibBin(options.srcBin), ...configArgs], env }
}

/** Inputs that vary between real-Loader example smokes. */
export interface LoaderSmokeOptions {
  /** Human-readable example name used in failure diagnostics. */
  readonly label: string
  /** Prefix for the isolated temporary process cwd. */
  readonly tempDirPrefix: string
  /** Absolute stdio-agent bin SOURCE path (`<pkg>/src/bin.ts`); the `lib` bin is derived from it. */
  readonly binScript: string
  /** Explicit plain-Node entry for `lib` mode; intended for test fixtures outside a package `src/` tree. */
  readonly libBinScript?: string | undefined
  /** Absolute real Loader config path. */
  readonly configPath: string
  /** Absolute repo tsconfig path used for unbuilt workspace-package resolution (required in `src` mode). */
  readonly tsconfigPath: string
  /** Boot from source via tsx (`src`) or built lib via plain Node (`lib`); defaults to the environment's mode. */
  readonly mode?: ExampleMode
  /** Environment overrides layered over the parent and isolated DSH homes. */
  readonly env?: Readonly<NodeJS.ProcessEnv>
  /** Lines written to stdin before EOF; omitted means immediate EOF. */
  readonly stdinLines?: readonly string[]
  /** Process deadline override for harness tests. */
  readonly processTimeoutMs?: number
}

/** Captured output from a Loader smoke that exited successfully. */
export interface LoaderSmokeResult {
  /** Complete stdout after clean exit. */
  readonly stdout: string
  /** Complete stderr after clean exit. */
  readonly stderr: string
}

/**
 * Boot one real Loader tree from an isolated cwd, write the requested stdin
 * script, close stdin, and await a clean exit. The helper owns process kill and
 * temp-directory cleanup on every outcome, and picks src/lib via {@link resolveExampleLaunch}.
 * @param options - example paths, mode, environment, stdin, and diagnostic identity.
 * @returns captured stdout and stderr after a zero exit.
 */
export async function runLoaderSmoke(options: LoaderSmokeOptions): Promise<LoaderSmokeResult> {
  const cwd = await mkdtemp(join(tmpdir(), options.tempDirPrefix))
  const processTimeoutMs = options.processTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS
  const launch = resolveExampleLaunch({
    srcBin: options.binScript,
    libBin: options.libBinScript,
    configArgs: [options.configPath],
    ...options.mode !== undefined ? { mode: options.mode } : {},
    tsconfigPath: options.tsconfigPath,
    exposeInternals: true,
    env: { DSH_HOME: join(cwd, '.dsh'), DSH_AGENTS_HOME: join(cwd, '.agents'), ...options.env },
  })
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(launch.command, launch.args, {
        cwd,
        env: { ...process.env, ...launch.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let deferredFailure: Error | undefined
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { stdout += chunk })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => { stderr += chunk })

      const timer = setTimeout(() => {
        deferredFailure = new Error(`${options.label} did not exit within ${processTimeoutMs / 1_000}s. stdout:\n${stdout}\nstderr:\n${stderr}`)
        child.kill('SIGKILL')
      }, processTimeoutMs)

      child.once('exit', (code) => {
        clearTimeout(timer)
        if (deferredFailure !== undefined) {
          reject(deferredFailure)
        } else if (code === 0) {
          resolve({ stdout, stderr })
        } else {
          reject(new Error(`${options.label} exited ${String(code)}. stdout:\n${stdout}\nstderr:\n${stderr}`))
        }
      })

      // process.execPath and a just-created pipe make these OS-error paths
      // impractical to induce without replacing the boundary under test.
      /* v8 ignore start */
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(new Error(`${options.label} failed to start: ${error.message}`))
      })
      child.stdin.once('error', (error) => {
        deferredFailure ??= new Error(`${options.label} stdin failed: ${error.message}`)
        child.kill('SIGKILL')
      })
      /* v8 ignore stop */

      child.stdin.end((options.stdinLines ?? []).map(line => `${line}\n`).join(''))
    })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}
