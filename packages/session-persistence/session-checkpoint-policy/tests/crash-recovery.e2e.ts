import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import SessionStore, {
  SessionId, TOOL_OUTCOME_UNKNOWN,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const childScript = fileURLToPath(new URL('./fixtures/crash-child.ts', import.meta.url))
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
const sessionId = SessionId('semantic-checkpoint-crash')
const roots: string[] = []
const CHILD_FAILPOINT_TIMEOUT_MS = 30_000

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + CHILD_FAILPOINT_TIMEOUT_MS
  for (;;) {
    try {
      await access(path)
      return
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (Date.now() >= deadline) throw new Error(`crash child did not reach failpoint ${path}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function crashAt(mode: 'request' | 'tool'): Promise<{ root: string; markerText: string }> {
  const root = await mkdtemp(join(tmpdir(), `dsh-semantic-${mode}-`))
  roots.push(root)
  const marker = join(root, 'failpoint')
  const child = spawn(process.execPath, ['--import', tsxLoader, childScript, mode, root, marker], {
    cwd: repoRoot,
    env: { ...process.env, TSX_TSCONFIG_PATH: join(repoRoot, 'tsconfig.json') },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  try {
    await waitForFile(marker)
    const markerText = await readFile(marker, 'utf8')
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('close', (code, signal) => { resolve({ code, signal }) })
    })
    child.kill('SIGKILL')
    const exit = await closed
    expect(exit).toEqual({ code: null, signal: 'SIGKILL' })
    return { root, markerText }
  } catch (error: unknown) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    throw new Error(`crash child failed: ${stderr}`, { cause: error })
  }
}

async function load(root: string): Promise<SessionEvent[]> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionPersistenceJsonl, { root, compression: 'none' })
  try {
    return (await ctx.sessionPersistence.load(sessionId)).events
  } finally {
    await ctx.fiber.dispose()
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe.skipIf(process.platform === 'win32')('semantic checkpoint hard-crash recovery', () => {
  it('persists the complete request before model dispatch', async () => {
    const crashed = await crashAt('request')
    expect(crashed.markerText).toBe('request-dispatched')
    const events = await load(crashed.root)
    expect(events.map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'step/start', 'request/header', 'step/end', 'turn/end',
    ])
    expect(events.at(-1)).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'interrupted' } },
    })
  })

  it('persists tool intent before a side effect and repairs its missing result as unknown', async () => {
    const crashed = await crashAt('tool')
    expect(crashed.markerText).toBe('tool-side-effect')
    const events = await load(crashed.root)
    expect(events.some(event => event.type === 'assistant/message')).toBe(true)
    expect(events.some(event => event.type === 'tool/call')).toBe(true)
    const result = events.find(event => event.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.error).toEqual({
      name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN,
    })
    if (result?.type !== 'tool/result' || result.data.content[0]?.type !== 'text') {
      throw new Error('expected a text tool result')
    }
    expect(result.data.content[0].text).toContain('Do not retry blindly.')
  })
})
