import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

/**
 * Keyless REAL-composition coverage for parent-session cwd inheritance: a
 * test-only cordis.yml boots the stdio app through the Loader with the ACP
 * backend's `cwd` omitted, a scripted model delegates once, and the scripted
 * mock ACP child echoes where it actually ran plus the workspace it was
 * announced — both must be the parent session's cwd. Mock-only composition, so
 * only this keyless tier applies (the with-key tier lives in subagent-acp.e2e.ts).
 */

const binScript = fileURLToPath(new URL('../../../examples/stdio-demo/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL(
  '../../../../examples/acp-agent/tests/fixtures/subagent/subagent-acp/cordis.yml',
  import.meta.url,
))
const mockServer = fileURLToPath(new URL('./mock-acp-server.ts', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
const PROCESS_TIMEOUT_MS = 30_000
const TEST_TIMEOUT_MS = PROCESS_TIMEOUT_MS + 15_000

let child: ChildProcessWithoutNullStreams | undefined
let workdir: string | undefined

afterEach(async () => {
  if (child !== undefined && child.exitCode === null) child.kill('SIGKILL')
  child = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

async function runDelegation(): Promise<{ stdout: string; stderr: string; cwd: string }> {
  workdir = await mkdtemp(join(tmpdir(), 'acp-subagent-composition-'))
  const cwd = workdir
  return new Promise((resolve, reject) => {
    const launch = resolveExampleLaunch({
      srcBin: binScript,
      configArgs: [configPath],
      tsconfigPath: repoTsconfig,
      exposeInternals: true,
      env: {
        DSH_TEST_MOCK_ACP_SERVER: mockServer,
        DSH_HOME: join(cwd, '.dsh'),
        DSH_AGENTS_HOME: join(cwd, '.agents'),
      },
    })
    const proc = spawn(launch.command, launch.args, {
      cwd,
      env: { ...process.env, ...launch.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child = proc
    let stdout = ''
    let stderr = ''
    let closedStdin = false
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk
      // One full turn: delegation + the follow-up reply quoting the child.
      if (!closedStdin && stdout.includes('child reported:')) {
        closedStdin = true
        proc.stdin.end()
      }
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => { stderr += chunk })

    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`acp-subagent composition e2e did not exit within ${PROCESS_TIMEOUT_MS / 1_000}s. stdout:\n${stdout}\nstderr:\n${stderr}`))
    }, PROCESS_TIMEOUT_MS)

    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr, cwd })
      else reject(new Error(`acp-subagent composition e2e exited ${code}. stdout:\n${stdout}\nstderr:\n${stderr}`))
    })
    proc.on('error', (error) => { clearTimeout(timer); reject(error) })
    proc.stdin.write('delegate\n')
  })
}

describe('ACP subagent cwd inheritance through a real cordis.yml and stdio process', () => {
  it('runs the child in the parent session workspace and announces it as the ACP session cwd', async () => {
    const { stdout, stderr, cwd } = await runDelegation()
    expect(stderr).not.toContain('UNHANDLED')
    expect(stdout).toContain('acp subagent cwd e2e ready.')
    // The child streams two lines: its real process.cwd() and the cwd the
    // backend announced in `session/new`. The parent session's workspace is the
    // app's launch directory (canonical form — the child reports realpaths).
    const workspace = realpathSync(cwd)
    expect(stdout).toContain(`child reported:\n${workspace}\n${workspace}`)
  }, TEST_TIMEOUT_MS)
})
