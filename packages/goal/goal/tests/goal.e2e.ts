import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { decodeGoalChange, renderGoalChange } from '@deepseek-ai/dsh-goal'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const binScript = fileURLToPath(new URL('../../../examples/stdio-demo/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL(
  '../../../../examples/echo-agent/tests/fixtures/goal/goal/cordis.yml',
  import.meta.url,
))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
const PROCESS_TIMEOUT_MS = 30_000
const TEST_TIMEOUT_MS = PROCESS_TIMEOUT_MS + 15_000
const REPLY = 'You said: "hello". Try "echo <something>" to see a tool call.'

let child: ChildProcessWithoutNullStreams | undefined
let workdir: string | undefined

afterEach(async () => {
  if (child !== undefined && child.exitCode === null) child.kill('SIGKILL')
  child = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return jsonlFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  }))
  return paths.flat()
}

async function runOneTurn(): Promise<{ stdout: string; stderr: string }> {
  workdir = await mkdtemp(join(tmpdir(), 'goal-domain-e2e-'))
  const cwd = workdir
  return new Promise((resolve, reject) => {
    const launch = resolveExampleLaunch({
      srcBin: binScript,
      configArgs: [configPath],
      tsconfigPath: repoTsconfig,
      exposeInternals: true,
      env: {
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
    let inputClosed = false
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (!inputClosed && stdout.includes(REPLY)) {
        inputClosed = true
        proc.stdin.end()
      }
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => { stderr += chunk })

    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`goal-domain e2e did not exit within ${PROCESS_TIMEOUT_MS / 1_000}s. stdout:\n${stdout}\nstderr:\n${stderr}`))
    }, PROCESS_TIMEOUT_MS)

    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`goal-domain e2e exited ${String(code)}. stdout:\n${stdout}\nstderr:\n${stderr}`))
    })
    proc.on('error', (error) => { clearTimeout(timer); reject(error) })
    proc.stdin.write('hello\n')
  })
}

describe('goal domain through a real cordis.yml and stdio process', () => {
  it('persists the Loader-created snapshot without starting a goal round', async () => {
    const { stdout, stderr } = await runOneTurn()
    expect(stderr).not.toContain('UNHANDLED')
    expect(stdout).toContain('goal-domain e2e ready.')
    expect(stdout).toContain(REPLY)

    const logs = await jsonlFiles(join(workdir as string, '.sessions'))
    expect(logs).toHaveLength(1)
    const lines = (await readFile(logs[0] as string, 'utf8')).trimEnd().split('\n')
    const events = lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
    expect(events.filter(event => event.type === 'turn/end')).toHaveLength(2)

    const contexts = events.filter(event => event.type === 'context/message'
      && event.data.source.kind === 'goal')
    expect(contexts).toHaveLength(1)
    const context = contexts[0]
    if (context?.type !== 'context/message') throw new Error('expected goal context event')
    const change = decodeGoalChange(context.data.meta)
    if (change === undefined) throw new Error('expected durable goal change')
    expect(change).toMatchObject({
      operation: 'create',
      roundsStarted: 0,
      goal: {
        revision: 1,
        objective: 'Prove the composed goal survives in the session log',
        phase: 'active',
        maxGoalRounds: 7,
      },
    })
    expect(context.data.content).toEqual(renderGoalChange(change))
    expect(JSON.stringify(context)).not.toContain('activation')
    expect(events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'goal')).toHaveLength(0)
  }, TEST_TIMEOUT_MS)
})
