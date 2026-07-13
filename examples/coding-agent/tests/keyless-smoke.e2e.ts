import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * Boots the real example through the stdio bin and `cordis.yml`, covering Loader,
 * `unwrapExports`, the full plugin tree, the agent-core bundle, and the readline module.
 * A dummy key permits startup; closing stdin before a prompt prevents network calls,
 * while with-key suites cover product behavior.
 */

// TODO(loader-smoke-harness): share spawn/tempdir/timeout/EOF setup with the other keyless smoke tests.
// The temp-cwd child needs absolute bin and config paths.
const binScript = fileURLToPath(new URL('../../../packages/ui/stdio-agent/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
// The temp cwd cannot discover the root tsconfig used for unbuilt package aliases.
const repoTsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
// Allow cold Loader startup under parallel load while still detecting hangs.
const PROCESS_TIMEOUT_MS = 30_000
// Let the child timeout report captured output before Vitest aborts.
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
