import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const binScript = fileURLToPath(new URL('../../../examples/stdio-demo/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
const PROCESS_TIMEOUT_MS = 30_000
const TEST_TIMEOUT_MS = PROCESS_TIMEOUT_MS + 15_000
const FIRST_REPLY = '[main turn 1] You said: "Time sampled while preparing turn 1, step 1:'
const SECOND_REPLY = '[main turn 2] You said: "Time sampled while preparing turn 2, step 1:'

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

async function runTwoTurns(): Promise<{ stdout: string; stderr: string }> {
  workdir = await mkdtemp(join(tmpdir(), 'time-context-e2e-'))
  const cwd = workdir
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      ['--expose-internals', '--import', tsxLoader, binScript, configPath],
      {
        cwd,
        env: {
          ...process.env,
          TZ: 'Asia/Shanghai',
          TSX_TSCONFIG_PATH: repoTsconfig,
          DSH_HOME: join(cwd, '.dsh'),
          DSH_AGENTS_HOME: join(cwd, '.agents'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    child = proc
    let stdout = ''
    let stderr = ''
    let sentSecond = false
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (!sentSecond && stdout.includes(FIRST_REPLY) && stdout.includes('Try "echo <something>" to see a tool call.\n> ')) {
        sentSecond = true
        proc.stdin.end('second\n')
      }
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => { stderr += chunk })

    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`time-context e2e did not exit within ${PROCESS_TIMEOUT_MS / 1_000}s. stdout:\n${stdout}\nstderr:\n${stderr}`))
    }, PROCESS_TIMEOUT_MS)

    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`time-context e2e exited ${code}. stdout:\n${stdout}\nstderr:\n${stderr}`))
    })
    proc.on('error', (error) => { clearTimeout(timer); reject(error) })
    proc.stdin.write('first\n')
  })
}

describe('time-context through a real cordis.yml and stdio process', () => {
  it('uses the process zone and persists one ordered context event per request', async () => {
    const { stdout, stderr } = await runTwoTurns()
    expect(stderr).not.toContain('UNHANDLED')
    expect(stdout).toContain('time-context e2e ready.')
    expect(stdout).toContain(FIRST_REPLY)
    expect(stdout).toContain(SECOND_REPLY)

    const logs = await jsonlFiles(join(workdir as string, '.sessions'))
    expect(logs).toHaveLength(1)
    const lines = (await readFile(logs[0] as string, 'utf8')).trimEnd().split('\n')
    const events = lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
    expect(events.filter(event => event.type === 'turn/end')).toHaveLength(2)

    const contexts = events.filter(event => event.type === 'context/message')
    const starts = events.filter(event => event.type === 'step/start')
    expect(contexts).toHaveLength(2)
    expect(starts).toHaveLength(2)
    for (let index = 0; index < contexts.length; index += 1) {
      expect(contexts[index]!.seq).toBeLessThan(starts[index]!.seq)
      expect(contexts[index]!.surfaceOp).toBe('append')
      expect(contexts[index]!.data.source).toEqual({ kind: 'plugin', plugin: 'time-context' })
    }
    const contextText = contexts.map(event => event.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n'))
    expect(contextText[0]).toMatch(
      /Time sampled while preparing turn 1, step 1: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00\[Asia\/Shanghai\]/,
    )
    expect(contextText[0]).toMatch(
      /Elapsed since the preceding model-visible message: (?:\d+d )?(?:\d+h )?(?:\d+m )?\d+s\./,
    )
    expect(contextText[1]).toMatch(/Time sampled while preparing turn 2, step 1:/)

    const headers = events.filter(event => event.type === 'request/header'
      || event.type === 'request/header-delta')
    expect(JSON.stringify(headers)).not.toContain('Time sampled while preparing')
  }, TEST_TIMEOUT_MS)
})
