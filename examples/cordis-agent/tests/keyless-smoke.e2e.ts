import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * Keyless Loader-path smoke for examples/cordis-agent: boot the REAL example
 * through the `@deepseek-ai/dsh-stdio-agent` bin against its `cordis.yml` —
 * the cordis Loader, `unwrapExports`, the full plugin tree INCLUDING the
 * `@deepseek-ai/dsh-tool-cordis` package resolved by name (whose `inject`
 * would crash a collapsed export shape at load, see docs/postmortem/0001) —
 * then close stdin with no prompt and assert the ready banner + a clean exit.
 *
 * No prompt is ever sent, so the model is NEVER called — that is why it runs
 * without a real key: `llm-deepseek`'s apply() only requires a key to be
 * PRESENT, and the absence of any prompt guarantees no network call. The
 * with-key product proof lives in cordis-tools.e2e.ts.
 */

// The dsh-stdio-agent bin (the demo:cordis entry) and this example's cordis.yml.
// The bin resolves its config-path arg from CWD; the test spawns from a temp
// cwd, so we pass the example config's ABSOLUTE path.
const binScript = fileURLToPath(new URL('../../../packages/ui/stdio-agent/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
// Dev/test run UNBUILT: resolve `@deepseek-ai/dsh-*` through the root tsconfig
// `paths` map; tsx searches UP from cwd, and we spawn from a temp dir outside
// the repo, so point it at the repo tsconfig (root is three levels up).
const repoTsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

let child: ChildProcessWithoutNullStreams | undefined
let workdir: string | undefined

afterEach(async () => {
  if (child !== undefined && child.exitCode === null) child.kill('SIGKILL')
  child = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

async function bootAndEof(): Promise<{ stdout: string; code: number }> {
  workdir = await mkdtemp(join(tmpdir(), 'cordis-smoke-'))
  const cwd = workdir
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      // --expose-internals: cordis.yml loads the HMR plugin (mirrors demo:cordis).
      ['--expose-internals', '--import', tsxLoader, binScript, configPath],
      {
        cwd,
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: repoTsconfig,
          // A dummy key so llm-deepseek's apply() (key-PRESENT check only) boots.
          // No prompt is sent, so the adapter never streams — no network call.
          DEEPSEEK_API_KEY: 'keyless-smoke-no-call',
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
      reject(new Error(`cordis-agent did not exit within 30s. stdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 30_000)

    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, code })
      else reject(new Error(`cordis-agent exited ${code}. stderr:\n${stderr}`))
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })

    // No prompt — just EOF, so the stdio UI exits without ever running a turn.
    proc.stdin.end()
  })
}

describe('cordis-agent keyless smoke (real cordis.yml via the Loader)', () => {
  it('boots the full plugin tree incl. tool-cordis, prints its banner, and exits cleanly on EOF', async () => {
    const { stdout, code } = await bootAndEof()
    expect(code).toBe(0)
    expect(stdout).toContain('cordis-agent ready.')
  }, 45_000)
})
