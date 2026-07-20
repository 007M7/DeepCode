import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeGoalChange } from '@deepseek-ai/dsh-goal'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const binScript = fileURLToPath(new URL('../../../examples/stdio-demo/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL(
  '../../../../examples/echo-agent/tests/fixtures/goal/tool-goal/cordis.yml',
  import.meta.url,
))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
const PROCESS_TIMEOUT_MS = 30_000
const TEST_TIMEOUT_MS = PROCESS_TIMEOUT_MS + 15_000
const PAUSED_RESULT = '"phase":"paused"'

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

async function runComposition(): Promise<{ stdout: string; stderr: string }> {
  workdir = await mkdtemp(join(tmpdir(), 'goal-tools-e2e-'))
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
    let pauseSent = false
    let inputClosed = false
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (!pauseSent && stdout.includes('GOAL CREATED') && stdout.includes('\n> ')) {
        pauseSent = true
        proc.stdin.write('pause\n')
      }
      const pausedAt = stdout.indexOf(PAUSED_RESULT)
      if (!inputClosed && pausedAt >= 0 && stdout.indexOf('\n> ', pausedAt) >= 0) {
        inputClosed = true
        proc.stdin.end()
      }
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => { stderr += chunk })

    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(
        `goal-tools e2e did not exit within ${PROCESS_TIMEOUT_MS / 1_000}s. stdout:\n${stdout}\nstderr:\n${stderr}`,
      ))
    }, PROCESS_TIMEOUT_MS)
    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`goal-tools e2e exited ${String(code)}. stdout:\n${stdout}\nstderr:\n${stderr}`))
    })
    proc.on('error', (error) => { clearTimeout(timer); reject(error) })
    proc.stdin.write('start\n')
  })
}

describe('goal tools through a real Loader, app, and stdio process', () => {
  it('creates, reads, and pauses one root goal with durable tool and state records', async () => {
    const { stdout, stderr } = await runComposition()
    expect(stderr).not.toContain('UNHANDLED')
    expect(stdout).toContain('goal-tools e2e ready.')
    expect(stdout).toContain('GOAL CREATED')
    expect(stdout).toContain(PAUSED_RESULT)
    expect(stdout).toContain('GOAL PAUSED')

    const logs = await jsonlFiles(join(workdir as string, '.sessions'))
    expect(logs).toHaveLength(1)
    const lines = (await readFile(logs[0] as string, 'utf8')).trimEnd().split('\n')
    const events = lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
    const calls = events.filter(event => event.type === 'tool/call')
    expect(calls.map(event => event.data.name)).toEqual(['create_goal', 'get_goal', 'update_goal'])
    const results = events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(3)
    expect(results.every(event => !event.data.isError)).toBe(true)

    const changes = events
      .filter(event => event.type === 'context/message' && event.data.source.kind === 'goal')
      .map(event => event.type === 'context/message' ? decodeGoalChange(event.data.meta) : undefined)
    expect(changes.map(change => change?.operation)).toEqual(['create', 'pause'])
    expect(changes[1]).toMatchObject({ goal: { phase: 'paused', revision: 2, maxGoalRounds: 7 } })
    expect(JSON.stringify(changes)).not.toContain('activation')

    const headers = events.filter(event => event.type === 'request/header')
    expect(JSON.stringify(headers)).toContain('infer goal intent')
    expect(JSON.stringify(headers)).toContain('at least 3 consecutive goal rounds')
  }, TEST_TIMEOUT_MS)
})
