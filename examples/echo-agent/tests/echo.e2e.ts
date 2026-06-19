import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * Keyless Loader-path smoke for examples/echo-agent: boot the REAL example
 * through its `cordis.yml` (the cordis Loader, `unwrapExports`, the whole
 * plugin tree), pipe a script of stdin lines, and assert the rendered stdout.
 *
 * This is the guard the per-file unit suite structurally cannot be: it drives
 * the extracted `@deepseek-ai/dsh-ui-stdio` plugin AND the example-local
 * `mock-llm.ts` / `echo-tool.ts` through their REAL load path, so a broken
 * plugin export shape (a stray `export default` that `unwrapExports` would
 * collapse, dropping `inject`) fails here even though hand-mounted unit tests
 * stay green (see docs/postmortem/0001). It needs no API key — the `mock-echo`
 * adapter never touches the network — so it runs in the default e2e gate.
 *
 * Both branches of mock-llm.ts are exercised: an `echo …` line (the tool
 * round-trip → `ECHO: …`) and a plain line (the direct canned reply).
 */

const startScript = fileURLToPath(new URL('../start.ts', import.meta.url))
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
// Dev/test run UNBUILT: `@deepseek-ai/dsh-*` imports resolve through the root
// tsconfig `paths` map, which tsx finds by searching UP from cwd. We spawn from
// a temp cwd OUTSIDE the repo, so point tsx at the repo tsconfig explicitly
// (repo root is four levels up from examples/echo-agent/tests).
const repoTsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

let child: ChildProcessWithoutNullStreams | undefined
let workdir: string | undefined

afterEach(async () => {
  if (child !== undefined && child.exitCode === null) child.kill('SIGKILL')
  child = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

/**
 * Boot echo-agent, write `lines` to its stdin, close stdin, and resolve with
 * the full stdout once the process exits (the stdio UI exits on EOF after the
 * agent settles). Rejects on a non-zero exit or a 10s timeout.
 */
async function runEcho(lines: string[]): Promise<{ stdout: string; code: number }> {
  workdir = await mkdtemp(join(tmpdir(), 'echo-smoke-'))
  const cwd = workdir
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      // --expose-internals: the example's cordis.yml loads the HMR plugin, which
      // requires it (mirrors the `demo:echo` script). The whole point is to boot
      // the example EXACTLY as it really runs, through the Loader.
      ['--expose-internals', '--import', tsxLoader, startScript],
      { cwd, env: { ...process.env, TSX_TSCONFIG_PATH: repoTsconfig }, stdio: ['pipe', 'pipe', 'pipe'] },
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
      reject(new Error(`echo-agent did not exit within 10s. stdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 10_000)

    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, code })
      else reject(new Error(`echo-agent exited ${code}. stderr:\n${stderr}`))
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })

    // Feed the script, then EOF so the stdio UI exits after the agent settles.
    for (const line of lines) proc.stdin.write(`${line}\n`)
    proc.stdin.end()
  })
}

describe('echo-agent keyless smoke (real cordis.yml via the Loader)', () => {
  it('boots, prints its welcome banner, and exits cleanly on stdin EOF', async () => {
    const { stdout, code } = await runEcho([])
    expect(code).toBe(0)
    expect(stdout).toContain('echo-agent ready.')
  }, 15_000)

  it('runs the echo tool round-trip for an "echo …" line', async () => {
    const { stdout } = await runEcho(['echo hello world'])
    // mock-llm.ts emits a tool-call for the echo tool; echo-tool.ts uppercases.
    expect(stdout).toContain('[tool call] echo')
    expect(stdout).toContain('[tool result] ECHO: HELLO WORLD')
  }, 15_000)

  it('streams a direct canned reply for a non-echo line', async () => {
    const { stdout } = await runEcho(['just chatting'])
    // The direct-response branch of mock-llm.ts quotes the input back.
    expect(stdout).toContain('just chatting')
    expect(stdout).not.toContain('[tool call]')
  }, 15_000)
})
