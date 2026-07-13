import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * Keyless Loader-path smoke for examples/coding-agent: boot the REAL example
 * through the `@deepseek-ai/dsh-stdio-agent` bin against its `cordis.yml` (the
 * cordis Loader, `unwrapExports`, the full plugin tree incl. the
 * `@deepseek-ai/dsh-agent-core` bundle and the app's in-package readline UI
 * module), then close stdin with no prompt and assert the
 * ready banner + a clean exit.
 *
 * No prompt is ever sent, so the model is NEVER called — this is why it runs
 * without a real key. coding-agent's `cordis.yml` loads `llm-deepseek`, whose
 * `apply()` only requires a key to be PRESENT (it does not validate it and only
 * uses it when a stream actually starts), so a dummy key lets the tree boot
 * while the absence of any prompt guarantees no network call. The value is the
 * real-Loader-path guard that the composed tree boots (see postmortem 0001;
 * the app carries no `inject`, so its export SHAPE is pinned by the stdio-agent
 * unit suite's unwrap assertion, not by a crash here),
 * complementing coding-agent's with-key e2e suites which prove the real
 * product.
 */

// TODO(loader-smoke-harness): extract the shared spawn/tempdir/timeout/EOF
// harness used here, code-mode-keyless-smoke, and cordis-agent's keyless smoke.
// The dsh-stdio-agent bin (the demo:repl entry) and this example's cordis.yml.
// The bin resolves its config-path arg from CWD; the test spawns from a temp
// cwd, so we pass the example config's ABSOLUTE path.
const binScript = fileURLToPath(new URL('../../../packages/ui/stdio-agent/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
// Dev/test run UNBUILT: resolve `@deepseek-ai/dsh-*` through the root tsconfig
// `paths` map; tsx searches UP from cwd, and we spawn from a temp dir outside
// the repo, so point it at the repo tsconfig (root is four levels up).
const repoTsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
// The real-API workflow runs up to 14 e2e files at once. Cold tsx/Loader
// startup can therefore outlive a tight smoke-test deadline before the child
// emits any output; 30s still detects a wedged process without confusing
// bounded CI contention with a lifecycle failure.
const PROCESS_TIMEOUT_MS = 30_000
// Leave enough room for the process-owned timeout to report captured output
// before Vitest aborts the test itself.
const TEST_TIMEOUT_MS = PROCESS_TIMEOUT_MS + 15_000

let child: ChildProcessWithoutNullStreams | undefined
let workdir: string | undefined

afterEach(async () => {
  if (child !== undefined && child.exitCode === null) child.kill('SIGKILL')
  child = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

async function bootAndEof(): Promise<{ stdout: string; code: number }> {
  workdir = await mkdtemp(join(tmpdir(), 'coding-smoke-'))
  const cwd = workdir
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      // --expose-internals: cordis.yml loads the HMR plugin (mirrors demo:repl).
      ['--expose-internals', '--import', tsxLoader, binScript, configPath],
      {
        cwd,
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: repoTsconfig,
          // A dummy key so llm-deepseek's apply() (key-PRESENT check only) boots.
          // No prompt is sent, so the adapter never streams — no network call.
          DEEPSEEK_API_KEY: 'keyless-smoke-no-call',
          DSH_HOME: join(cwd, '.dsh'),
          DSH_AGENTS_HOME: join(cwd, '.agents'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    child = proc
    let stdout = ''
    let stderr = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => { stdout += chunk })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => { stderr += chunk })

    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`coding-agent did not exit within ${PROCESS_TIMEOUT_MS / 1_000}s. stdout:\n${stdout}\nstderr:\n${stderr}`))
    }, PROCESS_TIMEOUT_MS)

    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, code })
      else reject(new Error(`coding-agent exited ${code}. stderr:\n${stderr}`))
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })

    // No prompt — just EOF, so the stdio UI exits without ever running a turn.
    proc.stdin.end()
  })
}

describe('coding-agent keyless smoke (real cordis.yml via the Loader)', () => {
  it('boots the full plugin tree, prints its banner, and exits cleanly on EOF', async () => {
    const { stdout, code } = await bootAndEof()
    expect(code).toBe(0)
    expect(stdout).toContain('agent REPL ready.')
  }, TEST_TIMEOUT_MS)
})
