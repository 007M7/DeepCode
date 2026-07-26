/**
 * SDK client against a real scripted runtime subprocess
 * (`tests/fake-runtime.ts`, protocol-only — the only faked boundary is the
 * model-owning runtime itself). Covers the turn loop, notification routing
 * and session-tree scoping, error surfaces, timeouts, and the dispose ladder.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DeepSeekHarness,
  finalResponse,
  HarnessClient,
  normalizeInput,
  RequestTimeoutError,
  SdkProtocolError,
  TransportClosedError,
  type HarnessNotification,
} from '../src/index.ts'
import { JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-protocol'

const fakeRuntime = fileURLToPath(new URL('./fake-runtime.ts', import.meta.url))

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

type LaunchOverrides = Partial<ConstructorParameters<typeof HarnessClient>[0]>

/** Launch options running the fake runtime on the current node (type stripping). */
function fakeLaunch(env: Record<string, string> = {}, extra: LaunchOverrides = {}) {
  return {
    command: process.execPath,
    args: [fakeRuntime],
    env: { ...process.env as Record<string, string>, ...env },
    ...extra,
  }
}

function harnessWith(env: Record<string, string> = {}, extra: LaunchOverrides = {}): DeepSeekHarness {
  const harness = new DeepSeekHarness({ launch: fakeLaunch(env, extra) })
  cleanups.push(() => harness.close())
  return harness
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

describe('DeepSeekHarness', () => {
  it('runs a turn end to end and reuses the runtime across sessions', async () => {
    const harness = harnessWith({ FAKE_TEXT: 'turn answer' })
    const first = await harness.run('say hi')
    expect(first.status).toBe('ok')
    expect(first.reason).toEqual({ kind: 'completed' })
    expect(first.finalResponse).toBe('turn answer')
    expect(first.events.map(event => event.type)).toEqual(['turn/start', 'assistant/chunk', 'assistant/message', 'turn/end'])

    // Same subprocess, second session: ids differ, protocol state is reusable.
    const second = await harness.run([{ type: 'text', text: 'again' }])
    expect(second.status).toBe('ok')
    expect(second.sessionId).not.toBe(first.sessionId)
    await harness.close()
  })

  it('streams notifications to the observer and scopes them to the session tree', async () => {
    const harness = harnessWith({ FAKE_SUBAGENT: '1' })
    const seen: HarnessNotification[] = []
    const result = await harness.run('delegate', {
      sessionId: 'parent-1',
      onNotification: (n) => { seen.push(n) },
    })

    expect(result.status).toBe('ok')
    // The child session's events arrive through subagent.started lineage.
    expect(seen.map(n => n.method)).toContain('subagent.started')
    expect(seen.map(n => n.method)).toContain('subagent.finished')
    const childEvents = seen.filter(n => n.method === 'session.event' && n.params.sessionId === 'parent-1-child')
    expect(childEvents.length).toBeGreaterThan(0)
    // Child events do not count as the parent's own turn events.
    expect(result.events.every(event => event.type !== 'assistant/message'
      || (event.data as { content: { type: string; text?: string }[] }).content[0]?.text !== 'child says hi')).toBe(true)
    await harness.close()
  })

  it('reports an error status with the turn-end reason', async () => {
    const harness = harnessWith({ FAKE_STATUS: 'error', FAKE_REASON_KIND: 'max-tokens' })
    const result = await harness.run('overflow')
    expect(result.status).toBe('error')
    expect(result.reason).toEqual({ kind: 'max-tokens' })
    await harness.close()
  })

  it('omits the reason when the runtime settled without one', async () => {
    const harness = harnessWith({ FAKE_STATUS: 'error', FAKE_REASON_KIND: 'none' })
    const result = await harness.run('no turn')
    expect(result.status).toBe('error')
    expect(result.reason).toBeUndefined()
    await harness.close()
  })

  it('sends the configured cwd/provider/model in the handshake exactly once', async () => {
    const dir = await tempDir('sdk-client-init-')
    const recordFile = join(dir, 'init.jsonl')
    const harness = new DeepSeekHarness({
      launch: fakeLaunch({ FAKE_RECORD_INIT: recordFile }),
      cwd: dir,
      provider: 'custom-provider',
      model: 'custom-model',
    })
    cleanups.push(() => harness.close())
    await harness.run('one')
    await harness.run('two')
    await harness.close()
    const records = (await readFile(recordFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as object)
    expect(records).toEqual([{ cwd: dir, provider: 'custom-provider', model: 'custom-model' }])
  })

  it('propagates a JSON-RPC error response from initialize and closes the runtime', async () => {
    const harness = harnessWith({ FAKE_INIT_ERROR: '1' })
    const failure = await harness.run('boom').then(
      () => { throw new Error('run unexpectedly succeeded') },
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(JsonRpcResponseError)
    expect(failure).toMatchObject({ code: 7, message: 'scripted init failure', data: { hint: 'fake' } })
    // The failed handshake reset lets a later start retry instead of wedging.
    await expect(harness.run('later')).rejects.toThrow()
  })

  it('rejects a malformed initialize result as a protocol error', async () => {
    const harness = harnessWith({ FAKE_MALFORMED: '1' })
    await expect(harness.run('bad')).rejects.toThrow(SdkProtocolError)
  })

  it('supports await using disposal', async () => {
    let captured: DeepSeekHarness
    {
      await using harness = new DeepSeekHarness({ launch: fakeLaunch() })
      captured = harness
      const result = await harness.run('scoped')
      expect(result.status).toBe('ok')
    }
    // After scope exit the runtime is closed: reuse fails loudly.
    await expect(captured.run('after')).rejects.toThrow(TransportClosedError)
  })
})

describe('HarnessClient', () => {
  it('times out a hung request at the per-call bound', async () => {
    const client = new HarnessClient(fakeLaunch({ FAKE_HANG_PROMPT: '1' }))
    cleanups.push(() => client.close())
    await client.initialize({ cwd: process.cwd(), provider: 'p', model: 'm' })
    await expect(client.request('session/prompt', { sessionId: 's', contentBlocks: normalizeInput('hi') }, 200))
      .rejects.toThrow(RequestTimeoutError)
    await client.close()
  })

  it('applies the client-wide request timeout when no per-call bound is given', async () => {
    const client = new HarnessClient(fakeLaunch({ FAKE_HANG_PROMPT: '1' }, { requestTimeoutMs: 400 }))
    cleanups.push(() => client.close())
    // The bound applies from send, so it holds regardless of runtime boot time.
    await expect(client.prompt('s', normalizeInput('hi'))).rejects.toThrow(RequestTimeoutError)
    await client.close()
  })

  it('rejects a malformed prompt acceptance as a protocol error', async () => {
    const client = new HarnessClient(fakeLaunch({ FAKE_MALFORMED: '1' }))
    cleanups.push(() => client.close())
    await expect(client.prompt('s', normalizeInput('hi'))).rejects.toThrow(SdkProtocolError)
    await client.close()
  })

  it('fails pending requests with exit code and stderr tail when the runtime dies', async () => {
    const client = new HarnessClient(fakeLaunch({ FAKE_EXIT_BEFORE_INIT: '1', FAKE_STDERR: 'fatal: scripted death' }))
    cleanups.push(() => client.close())
    const failure = await client.initialize({ cwd: process.cwd(), provider: 'p', model: 'm' }).then(
      () => { throw new Error('initialize unexpectedly succeeded') },
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(TransportClosedError)
    expect(String(failure)).toContain('exit code: 3')
    expect(String(failure)).toContain('fatal: scripted death')
    // Requests after death fail immediately with the same context.
    await expect(client.request('initialize', {})).rejects.toThrow('exit code: 3')
  })

  it('flushes an unterminated stderr line into the tail at close', async () => {
    const client = new HarnessClient(fakeLaunch({ FAKE_STDERR_NO_NEWLINE: 'no trailing newline', FAKE_EXIT_BEFORE_INIT: '1' }))
    cleanups.push(() => client.close())
    const failure = await client.initialize({ cwd: process.cwd(), provider: 'p', model: 'm' }).then(
      () => { throw new Error('initialize unexpectedly succeeded') },
      (error: unknown) => error,
    )
    expect(String(failure)).toContain('no trailing newline')
  })

  it('fails fast when the command does not exist', async () => {
    const client = new HarnessClient({ command: join(tmpdir(), 'dsh-no-such-runtime-bin') })
    cleanups.push(() => client.close())
    await expect(client.request('initialize', {}, 1_000)).rejects.toThrow(TransportClosedError)
  })

  it('close() is idempotent, reaps the child, and fails later use', async () => {
    const client = new HarnessClient(fakeLaunch())
    await client.initialize({ cwd: process.cwd(), provider: 'p', model: 'm' })
    await Promise.all([client.close(), client.close()])
    expect(() => { client.start() }).toThrow(TransportClosedError)
    await expect(client.request('anything')).rejects.toThrow(TransportClosedError)
    // Close with no child ever spawned is a no-op.
    const untouched = new HarnessClient(fakeLaunch())
    await untouched.close()
  })

  it('escalates through SIGTERM when the runtime ignores EOF', async () => {
    const dir = await tempDir('sdk-client-ladder-')
    const sigtermFile = join(dir, 'sigterm.txt')
    const client = new HarnessClient(fakeLaunch(
      { FAKE_IGNORE_EOF: '1', FAKE_SIGTERM_FILE: sigtermFile },
      { shutdownTimeoutMs: 100, disposeEofGraceMs: 100, disposeGraceMs: 1_000 },
    ))
    await client.initialize({ cwd: process.cwd(), provider: 'p', model: 'm' })
    await client.close()
    expect((await stat(sigtermFile)).isFile()).toBe(true)
  })

  it('escalates to SIGKILL when the runtime traps SIGTERM too', async () => {
    const client = new HarnessClient(fakeLaunch(
      { FAKE_IGNORE_EOF: '1', FAKE_TRAP_SIGTERM: '1' },
      { shutdownTimeoutMs: 100, disposeEofGraceMs: 100, disposeGraceMs: 300 },
    ))
    await client.initialize({ cwd: process.cwd(), provider: 'p', model: 'm' })
    // Resolves (does not hang or reject): the SIGKILL rung reaped the child.
    await client.close()
  })

  it('delivers notifications to unfiltered and filtered subscriptions in wire order', async () => {
    const client = new HarnessClient(fakeLaunch())
    cleanups.push(() => client.close())
    await client.initialize({ cwd: process.cwd(), provider: 'p', model: 'm' })

    const all = client.subscribe()
    const finishedOnly = client.subscribe(n => n.method === 'session.finished')
    await client.prompt('sub-test', normalizeInput('go'))

    const first = await all.next()
    expect(first.method).toBe('session.event')
    const finished = await finishedOnly.next()
    expect(finished.method).toBe('session.finished')
    expect(finishedOnly.tryNext()).toBeUndefined()

    // Async iteration consumes queued items and then parks.
    const collected: string[] = []
    for await (const notification of all) {
      collected.push(notification.method)
      if (notification.method === 'session.finished') break
    }
    expect(collected.at(-1)).toBe('session.finished')

    all.close()
    finishedOnly.close()
    await expect(all.next()).rejects.toThrow('notification subscription closed')
    await client.close()
  })

  it('closes subscriptions with the runtime and rejects parked waiters', async () => {
    const client = new HarnessClient(fakeLaunch())
    await client.initialize({ cwd: process.cwd(), provider: 'p', model: 'm' })
    const subscription = client.subscribe()
    const parked = subscription.next()
    await client.close()
    await expect(parked).rejects.toThrow(TransportClosedError)
  })

  it('scopes the session tree across multi-hop lineage and ignores foreign sessions', async () => {
    const client = new HarnessClient(fakeLaunch())
    cleanups.push(() => client.close())
    await client.initialize({ cwd: process.cwd(), provider: 'p', model: 'm' })

    const tree = client.subscribeSessionTree('root')
    // Lineage edges arrive as subagent.started notifications.
    const inject = (method: string, params: Record<string, unknown>): void => {
      (client as unknown as { dispatchNotification(n: HarnessNotification): void }).dispatchNotification({ method, params })
    }
    inject('subagent.started', { parentSessionId: 'root', childSessionId: 'child' })
    inject('subagent.started', { parentSessionId: 'child', childSessionId: 'grandchild' })
    inject('session.event', { sessionId: 'grandchild', event: { type: 'noop' } })
    inject('session.event', { sessionId: 'stranger', event: { type: 'noop' } })
    inject('subagent.started', { parentSessionId: 'other-root', childSessionId: 'other-child' })
    inject('subagent.finished', { parentSessionId: 'child', childSessionId: 'grandchild' })
    // Self-loop and empty edges must not corrupt the lineage map.
    inject('subagent.started', { parentSessionId: 'loop', childSessionId: 'loop' })
    inject('subagent.started', { parentSessionId: '', childSessionId: 'x' })
    inject('subagent.finished', { childSessionId: 'root' })

    expect((await tree.next()).method).toBe('subagent.started')
    expect((await tree.next()).method).toBe('subagent.started')
    expect((await tree.next()).params.sessionId).toBe('grandchild')
    expect((await tree.next()).method).toBe('subagent.finished')
    // The foreign-root edge and stranger event were filtered; next is the root-child edge.
    expect((await tree.next()).params.childSessionId).toBe('root')
    tree.close()
    await client.close()
  })
})

describe('stderr tail bound', () => {
  it('keeps only the newest lines up to the limit', async () => {
    const manyLines = Array.from({ length: 450 }, (_, i) => `line-${i}`).join('\n')
    const client = new HarnessClient(fakeLaunch({ FAKE_STDERR: manyLines, FAKE_EXIT_BEFORE_INIT: '1' }))
    cleanups.push(() => client.close())
    const failure = await client.initialize({ cwd: process.cwd(), provider: 'p', model: 'm' }).then(
      () => { throw new Error('initialize unexpectedly succeeded') },
      (error: unknown) => error,
    )
    const text = String(failure)
    // The tail is bounded to the newest 400 lines: the oldest are dropped.
    expect(text).toContain('line-449')
    expect(text).not.toContain('line-0\n')
  })
})

describe('pure helpers', () => {
  it('normalizeInput wraps strings and passes blocks through', () => {
    expect(normalizeInput('x')).toEqual([{ type: 'text', text: 'x' }])
    const blocks = [{ type: 'text' as const, text: 'y' }]
    expect(normalizeInput(blocks)).toBe(blocks)
  })

  it('finalResponse reads the last assistant message and tolerates absence', () => {
    expect(finalResponse([])).toBe('')
    expect(finalResponse([{ type: 'turn/start', seq: 0, time: 0, data: { turn: 0 } } as never])).toBe('')
    expect(finalResponse([
      { type: 'assistant/message', seq: 0, time: 0, data: { content: [{ type: 'text', text: 'first' }] } } as never,
      { type: 'assistant/message', seq: 1, time: 0, data: { content: [{ type: 'text', text: 'a' }, { type: 'tool-call' }, { type: 'text', text: 'b' }] } } as never,
    ])).toBe('ab')
  })
})
