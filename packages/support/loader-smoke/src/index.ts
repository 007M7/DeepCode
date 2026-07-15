/**
 * Shared subprocess harness for keyless example smokes that boot a real
 * `cordis.yml` through the stdio-agent bin and Cordis Loader.
 *
 * @module @deepseek-ai/dsh-loader-smoke
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_PROCESS_TIMEOUT_MS = 30_000
const TSX_LOADER = fileURLToPath(import.meta.resolve('tsx'))

/** Vitest deadline that leaves room for the subprocess-owned 30-second diagnostic timeout. */
export const LOADER_SMOKE_TEST_TIMEOUT_MS = DEFAULT_PROCESS_TIMEOUT_MS + 15_000

/** Inputs that vary between real-Loader example smokes. */
export interface LoaderSmokeOptions {
  /** Human-readable example name used in failure diagnostics. */
  readonly label: string
  /** Prefix for the isolated temporary process cwd. */
  readonly tempDirPrefix: string
  /** Absolute stdio-agent bin path. */
  readonly binScript: string
  /** Absolute real Loader config path. */
  readonly configPath: string
  /** Absolute repo tsconfig path used for unbuilt workspace-package resolution. */
  readonly tsconfigPath: string
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
 * temp-directory cleanup on every outcome.
 * @param options - example paths, environment, stdin, and diagnostic identity.
 * @returns captured stdout and stderr after a zero exit.
 */
export async function runLoaderSmoke(options: LoaderSmokeOptions): Promise<LoaderSmokeResult> {
  const cwd = await mkdtemp(join(tmpdir(), options.tempDirPrefix))
  const processTimeoutMs = options.processTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--expose-internals', '--import', TSX_LOADER, options.binScript, options.configPath],
        {
          cwd,
          env: {
            ...process.env,
            DSH_HOME: join(cwd, '.dsh'),
            DSH_AGENTS_HOME: join(cwd, '.agents'),
            ...options.env,
            TSX_TSCONFIG_PATH: options.tsconfigPath,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
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
