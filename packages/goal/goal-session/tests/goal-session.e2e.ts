import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { foldGoal } from '@deepseek-ai/dsh-goal'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const binScript = fileURLToPath(new URL('../../../examples/stdio-demo/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL(
  '../../../../examples/echo-agent/tests/fixtures/goal/goal-session/cordis.yml',
  import.meta.url,
))
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

/** Recursively locate persistence JSONL files in one temporary root. */
async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return jsonlFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  }))
  return paths.flat()
}

/** Run the complete deterministic human-turn plus two-round composition. */
async function runComposition(): Promise<{ stdout: string; stderr: string }> {
  workdir = await mkdtemp(join(tmpdir(), 'goal-session-e2e-'))
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
      if (!inputClosed && stdout.includes('ROUND TWO COMPLETE') && stdout.includes('\n> ')) {
        inputClosed = true
        proc.stdin.end()
      }
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => { stderr += chunk })

    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(
        `goal-session e2e did not exit within ${PROCESS_TIMEOUT_MS / 1_000}s. stdout:\n${stdout}\nstderr:\n${stderr}`,
      ))
    }, PROCESS_TIMEOUT_MS)
    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`goal-session e2e exited ${String(code)}. stdout:\n${stdout}\nstderr:\n${stderr}`))
    })
    proc.on('error', (error) => { clearTimeout(timer); reject(error) })
    proc.stdin.write('start\n')
  })
}

describe('same-session goal rounds through a real Loader, app, and stdio process', () => {
  it('persists two exact rounds and stops the completion turn without another request', async () => {
    const { stdout, stderr } = await runComposition()
    expect(stderr).not.toContain('UNHANDLED')
    expect(stdout).toContain('goal-session e2e ready.')
    expect(stdout).toContain('GOAL CREATED')
    expect(stdout).toContain('ROUND ONE')
    expect(stdout).toContain('ROUND TWO COMPLETE')

    const logs = await jsonlFiles(join(workdir as string, '.sessions'))
    expect(logs).toHaveLength(1)
    const lines = (await readFile(logs[0] as string, 'utf8')).trimEnd().split('\n')
    const events = lines.slice(1).map(line => JSON.parse(line) as SessionEvent)

    const calls = events.filter(event => event.type === 'tool/call')
    expect(calls.map(event => event.data.name)).toEqual(['create_goal', 'get_goal', 'update_goal'])
    expect(events.filter(event => event.type === 'step/start')).toHaveLength(5)
    expect(events.filter(event => event.type === 'tool/result').every(event => !event.data.isError)).toBe(true)

    const rounds = events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'goal')
    expect(rounds).toHaveLength(2)
    const roundNumbers: number[] = []
    const revisions: number[] = []
    const prompts: string[] = []
    for (const event of events) {
      if (event.type !== 'user/message' || event.data.source.kind !== 'goal') continue
      roundNumbers.push(event.data.source.round)
      revisions.push(event.data.source.revision)
      prompts.push(event.data.content.find(block => block.type === 'text')?.text ?? '')
    }
    expect(roundNumbers).toEqual([1, 2])
    expect(revisions).toEqual([1, 1])
    expect(prompts[0]).toContain('Round: 1/2')
    expect(prompts[1]).toContain('Round: 2/2')

    expect(foldGoal(events)).toMatchObject({
      goal: {
        objective: 'Complete two deterministic same-session rounds',
        phase: 'complete',
        revision: 2,
        maxGoalRounds: 2,
      },
      roundsStarted: 2,
    })
  }, TEST_TIMEOUT_MS)
})
