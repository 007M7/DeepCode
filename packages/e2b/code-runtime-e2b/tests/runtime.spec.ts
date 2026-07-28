import { spawn } from 'node:child_process'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import type { Sandbox } from '@deepseek-ai/dsh-e2b'
import {
  E2BFrameDecoder,
  encodeE2BFrame,
} from '@deepseek-ai/dsh-e2b'
import type E2BSandboxService from '@deepseek-ai/dsh-e2b'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import E2BSubprocessService from '@deepseek-ai/dsh-subprocess-e2b'
import {
  encodeWorkerJson,
} from '@deepseek-ai/dsh-code-runtime-worker'
import E2BCodeRuntime from '@deepseek-ai/dsh-code-runtime-e2b'
import * as E2BCodeRuntimeInvariant from '../src/invariant.ts'
import { CODE_RUNNER_SOURCE } from '../src/runner-source.ts'
import InvariantService from '@deepseek-ai/dsh-invariants'

class FakeHandle implements SubprocessHandle {
  readonly pid = 123
  readonly stdin: Writable | undefined
  readonly stdout: PassThrough | undefined
  readonly stderr = undefined
  readonly collected: SubprocessHandle['collected']
  readonly done: Promise<SubprocessOutcome>
  readonly writes: unknown[] = []
  readonly result = Promise.withResolvers<SubprocessOutcome>()
  terminated = 0
  waitCalls = 0
  private readonly decoder = new E2BFrameDecoder(10_000_000)
  private readonly waitError: Error | undefined
  private readonly waitResult: Promise<boolean> | undefined
  private settled = false

  constructor(
    private readonly onMessage: (message: unknown, handle: FakeHandle) => void = () => {},
    options: {
      stdin?: boolean
      stdout?: boolean
      stderr?: string
      writeError?: Error
      waitError?: Error
      waitResult?: Promise<boolean>
    } = {},
  ) {
    this.waitError = options.waitError
    this.waitResult = options.waitResult
    this.stdin = options.stdin === false
      ? undefined
      : options.writeError === undefined
        ? new PassThrough()
        : new Writable({ write: (_chunk, _encoding, callback) => { callback(options.writeError) } })
    this.stdout = options.stdout === false ? undefined : new PassThrough()
    this.collected = options.stderr === undefined
      ? {}
      : { stderr: { readFrom: () => ({ text: options.stderr as string, nextOffset: 0, lossy: false }) } }
    this.done = this.result.promise
    this.stdin?.on('data', (chunk: Buffer) => {
      for (const message of this.decoder.push(chunk.toString('ascii'))) {
        this.writes.push(message)
        this.onMessage(message, this)
      }
    })
  }

  emit(message: unknown): void {
    this.stdout?.write(encodeE2BFrame(message))
  }

  emitRaw(text: string): void {
    this.stdout?.write(text)
  }

  exit(outcome: SubprocessOutcome = { exitCode: 0, signal: null }): void {
    if (this.settled) return
    this.settled = true
    this.stdout?.end()
    this.result.resolve(outcome)
  }

  crash(error: unknown): void {
    if (this.settled) return
    this.settled = true
    this.stdout?.end()
    this.result.reject(error)
  }

  terminate(): void {
    this.terminated += 1
    this.exit({ exitCode: null, signal: 'SIGTERM' })
  }

  async waitForExit(): Promise<boolean> {
    this.waitCalls += 1
    if (this.waitError !== undefined) throw this.waitError
    if (this.waitResult !== undefined) return await this.waitResult
    return true
  }
}

interface RuntimeFixture {
  ctx: Context
  fiber: Awaited<ReturnType<Context['plugin']>>
  runtime: E2BCodeRuntime
  sandbox: Sandbox
  spawn: ReturnType<typeof vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>>
  write: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
}

async function setup(
  handles: FakeHandle[] = [],
  config: Record<string, number> = {},
  sandboxOverrides: Partial<Sandbox> = {},
  getSandbox?: () => Promise<Sandbox>,
): Promise<RuntimeFixture> {
  const write = vi.fn().mockResolvedValue([])
  const run = vi.fn().mockImplementation(async (command: string) => ({
    exitCode: 0,
    stdout: command.startsWith('command -v') ? '/usr/bin/node\n' : '',
    stderr: '',
  }))
  const sandbox = {
    files: { write },
    commands: { run },
    ...sandboxOverrides,
  } as unknown as Sandbox
  const e2b = {
    cwd: '/workspace',
    runtimeRoot: '/workspace/.dsh-e2b',
    getSandbox: getSandbox ?? (async () => sandbox),
  } as unknown as E2BSandboxService
  const spawn = vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>(() => {
    const handle = handles.shift()
    if (handle === undefined) throw new Error('no fake handle queued')
    return handle
  })
  const subprocess = Object.create(E2BSubprocessService.prototype) as E2BSubprocessService
  Object.defineProperty(subprocess, 'spawn', { value: spawn })
  const ctx = new Context()
  ctx.provide('e2b', e2b)
  ctx.provide('subprocess', subprocess)
  const fiber = await ctx.plugin(E2BCodeRuntime, config)
  return { ctx, fiber, runtime: ctx.codeRuntime as E2BCodeRuntime, sandbox, spawn, write, run }
}

function request(program = 'return 1') {
  return { program, bindings: [] }
}

async function runInstalledRunner(
  code: string,
  maxOutputBytes = 2_000_000,
): Promise<{ messages: unknown[]; stderr: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-e2b-code-runner-'))
  const runner = join(directory, 'runner.mjs')
  await writeFile(runner, CODE_RUNNER_SOURCE)
  const child = spawn(process.execPath, [runner], { stdio: ['pipe', 'pipe', 'pipe'] })
  const decoder = new E2BFrameDecoder(4_000_000)
  const messages: unknown[] = []
  let stderr = ''
  let outputError: unknown
  child.stdout.setEncoding('ascii')
  child.stdout.on('data', (chunk: string) => {
    try {
      messages.push(...decoder.push(chunk))
    } catch (error: unknown) {
      outputError = error
      child.kill('SIGKILL')
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })

  try {
    child.stdin.write(encodeE2BFrame({
      type: 'boot',
      code,
      namespaces: [],
      computeMs: 1_000,
      maxOutputBytes,
      maxOldGenerationSizeMb: 128,
    }))
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('installed E2B code runner did not exit'))
      }, 5_000)
      child.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
    if (outputError !== undefined) throw outputError
    decoder.finish()
    return { messages, stderr }
  } finally {
    child.kill('SIGKILL')
    await rm(directory, { recursive: true, force: true })
  }
}

describe('E2BCodeRuntime', () => {
  it('keeps model-owned descriptors outside the host framing process', async () => {
    const forged = Buffer.from(JSON.stringify({ type: 'done' })).toString('base64') + '\\n'
    const { messages, stderr } = await runInstalledRunner(
      `
        const fs = await import('node:fs')
        const childProcess = await import('node:child_process')
        fs.writeSync(1, ${JSON.stringify(forged)})
        childProcess.spawnSync(process.execPath, ['-e', 'process.stdout.write("child-native")'], { stdio: 'inherit' })
        return true
      `,
    )
    const records = messages as Array<{ type?: string; text?: string; value?: unknown }>
    const terminal = records.filter(message => message.type === 'done')

    expect(stderr).toBe('')
    expect(terminal).toEqual([{ type: 'done', value: [true] }])
    expect(records.at(-1)).toEqual(terminal[0])
    expect(records.filter(message => message.type === 'log').map(message => message.text).join(''))
      .toContain(forged + 'child-native')
  })

  it('bounds native descriptor output before it reaches the host protocol', async () => {
    const { messages, stderr } = await runInstalledRunner(
      "(await import('node:fs')).writeSync(1, 'x'.repeat(4096)); return true",
      64,
    )
    const records = messages as Array<{ type?: string; text?: string }>

    expect(stderr).toBe('')
    expect(records.at(-1)).toEqual({ type: 'output-limit' })
    expect(Buffer.byteLength(records.filter(message => message.type === 'log').map(message => message.text).join('')))
      .toBeLessThanOrEqual(62)
  })

  it('drains native worker pipes before emitting the terminal frame', async () => {
    const expectedBytes = 1_048_576
    const { messages, stderr } = await runInstalledRunner(
      `
        let stdoutPrototype = Object.getPrototypeOf(process.stdout)
        while (stdoutPrototype && !Object.hasOwn(stdoutPrototype, 'write')) stdoutPrototype = Object.getPrototypeOf(stdoutPrototype)
        Reflect.apply(stdoutPrototype.write, process.stdout, ['x'.repeat(${expectedBytes})])
        return true
      `,
    )
    const records = messages as Array<{ type?: string; text?: string }>
    const terminalIndex = records.findIndex(message => message.type === 'done')
    const nativeOutput = records
      .slice(0, terminalIndex)
      .filter(message => message.type === 'log')
      .map(message => message.text ?? '')
      .join('')

    expect(stderr).toBe('')
    expect(terminalIndex).toBe(records.length - 1)
    expect(Buffer.byteLength(nativeOutput)).toBe(expectedBytes)
  })

  it.skipIf(process.platform === 'win32')('reaps descendant-held controller pipes before completion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-e2b-code-descendant-'))
    const marker = join(directory, 'started')
    const release = join(directory, 'release')
    const childSource = `
      const fs = require('node:fs')
      fs.writeFileSync(${JSON.stringify(marker)}, 'started')
      const timer = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(release)})) clearInterval(timer)
      }, 10)
    `
    let running: ReturnType<typeof runInstalledRunner> | undefined
    try {
      running = runInstalledRunner(`
        const fs = await import('node:fs')
        const childProcess = await import('node:child_process')
        childProcess.spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], {
          stdio: ['ignore', 'inherit', 'inherit'],
        })
        while (!fs.existsSync(${JSON.stringify(marker)})) await new Promise(resolve => setTimeout(resolve, 5))
        return true
      `)
      const deadline = Date.now() + 2_000
      for (;;) {
        try {
          await access(marker)
          break
        } catch (error: unknown) {
          if (Date.now() >= deadline) throw error
          await delay(10)
        }
      }
      const completed = await Promise.race([
        running.then(() => true),
        delay(500).then(() => false),
      ])
      await writeFile(release, '')
      const { messages, stderr } = await running

      expect(completed).toBe(true)
      expect(stderr).toBe('')
      expect(messages.at(-1)).toEqual({ type: 'done', value: [true] })
    } finally {
      await writeFile(release, '').catch(() => undefined)
      await running?.catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('prepares the remote runner and returns logs and a lossless completion', async () => {
    const handle = new FakeHandle((message, current) => {
      if ((message as { type?: string }).type !== 'boot') return
      current.emit({ type: 'log', text: 'remote 你好' })
      current.emitRaw(
        encodeE2BFrame({ type: 'done', value: encodeWorkerJson({ answer: 42 }) })
        + encodeE2BFrame({ type: 'log', text: 'ignored after done' }),
      )
      current.emit({ type: 'log', text: 'also ignored after done' })
    })
    const fixture = await setup([handle])

    await expect(fixture.runtime.run(request('const answer: number = 42; return { answer }')))
      .resolves.toEqual({ logs: ['remote 你好'], value: { answer: 42 } })
    expect(fixture.runtime.language).toBe('typescript')
    expect(fixture.runtime.isolation).toBe('container')
    expect(fixture.write).toHaveBeenCalledWith([{ path: '/workspace/.dsh-e2b/code-runtime-runner.mjs', data: CODE_RUNNER_SOURCE }])
    expect(fixture.run).toHaveBeenCalledWith("chmod 600 -- '/workspace/.dsh-e2b/code-runtime-runner.mjs'")
    expect(fixture.spawn).toHaveBeenCalledWith(expect.objectContaining({
      argv: ['/usr/bin/node', '/workspace/.dsh-e2b/code-runtime-runner.mjs'],
      cwd: '/workspace',
      env: {},
    }))
    expect(handle.terminated).toBe(1)
    expect(handle.waitCalls).toBe(1)
    await fixture.fiber.dispose()
  })

  it('bridges binding success, host rejection, unknown members, and invalid values', async () => {
    const replies: unknown[] = []
    const handle = new FakeHandle((message, current) => {
      const record = message as { type?: string; id?: number; ok?: boolean }
      if (record.type === 'boot') {
        current.emit({ type: 'call', id: 1, global: 'bridge', name: 'double', args: encodeWorkerJson({ value: 4 }) })
        current.emit({ type: 'call', id: 2, global: 'bridge', name: 'fail', args: encodeWorkerJson(null) })
        current.emit({ type: 'call', id: 3, global: 'bridge', name: 'missing', args: encodeWorkerJson(null) })
        current.emit({ type: 'call', id: 4, global: 'bridge', name: 'double', args: [] })
        current.emit({ type: 'call', id: 5, global: 'bridge', name: 'invalid', args: encodeWorkerJson(null) })
        current.emit({ type: 'call', id: 6, global: 'bridge', name: 'throwing', args: encodeWorkerJson(null) })
        current.emit({ type: 'call', id: 1, global: 'bridge', name: 'double', args: encodeWorkerJson({ value: 99 }) })
        return
      }
      if (record.type === 'reply') {
        replies.push(message)
        if (replies.length === 6) current.emit({ type: 'done', value: encodeWorkerJson('done') })
      }
    })
    const fixture = await setup([handle])
    const result = await fixture.runtime.run({
      program: 'return await bridge.double({ value: 4 })',
      bindings: [
        {
          global: 'bridge',
          errorClass: { name: 'BridgeError', memberNameProperty: 'member' },
          functions: {
            double: async args => (args as { value: number }).value * 2,
            fail: async () => { throw 'nope' },
            invalid: (async () => undefined) as never,
            throwing: async () => Object.defineProperty({}, 'value', {
              enumerable: true,
              get: () => { throw new Error('getter failed') },
            }),
          },
        },
        { global: 'plain', functions: {} },
      ],
    })

    expect(result).toEqual({ logs: [], value: 'done' })
    expect(replies.sort((left, right) => (left as { id: number }).id - (right as { id: number }).id)).toEqual([
      { type: 'reply', id: 1, ok: true, value: encodeWorkerJson(8) },
      { type: 'reply', id: 2, ok: false, message: 'nope' },
      { type: 'reply', id: 3, ok: false, message: 'unknown binding "bridge.missing"' },
      { type: 'reply', id: 4, ok: false, message: 'binding arguments must be lossless JSON' },
      { type: 'reply', id: 5, ok: false, message: 'binding resolution must be lossless JSON' },
      { type: 'reply', id: 6, ok: false, message: 'binding resolution must be lossless JSON' },
    ])
    await fixture.fiber.dispose()
  })

  it('ignores malformed runner traffic and classifies terminal runner messages', async () => {
    const ignored = [
      null, 1, {}, { type: 'log' }, { type: 'call' },
      { type: 'call', id: 0, global: 'x', name: 'y', args: [] },
      { type: 'call', id: 1, global: 1, name: 'y', args: [] },
      { type: 'call', id: 1, global: 'x', name: 1, args: [] },
      { type: 'call', id: 1, global: 'x', name: 'y', args: {} },
      { type: 'done', error: null },
      { type: 'done', error: { kind: 'invented', message: 'x' } },
      { type: 'done', error: { kind: 'exception', message: 1 } },
    ]
    const handles = [
      new FakeHandle((message, current) => {
        if ((message as { type?: string }).type !== 'boot') return
        for (const item of ignored) current.emit(item)
        current.emit({ type: 'done' })
      }),
      new FakeHandle((message, current) => {
        if ((message as { type?: string }).type === 'boot') current.emit({ type: 'done', error: { kind: 'exception', message: 'boom' } })
      }),
      new FakeHandle((message, current) => {
        if ((message as { type?: string }).type === 'boot') current.emit({ type: 'done', value: [] })
      }),
      new FakeHandle((message, current) => {
        if ((message as { type?: string }).type === 'boot') current.emit({ type: 'output-limit' })
      }),
    ]
    const fixture = await setup(handles, { maxOutputBytes: 64, maxFrameBytes: 128 })

    await expect(fixture.runtime.run(request())).resolves.toEqual({ logs: [] })
    await expect(fixture.runtime.run(request())).resolves.toEqual({ logs: [], error: { kind: 'exception', message: 'boom' } })
    await expect(fixture.runtime.run(request())).resolves.toEqual({ logs: [], error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' } })
    await expect(fixture.runtime.run(request())).resolves.toEqual({ logs: [], error: { kind: 'output-limit', message: 'outer output exceeded 64 bytes' } })
    await fixture.fiber.dispose()
  })

  it('enforces the host output ledger and catches malformed bridge output', async () => {
    const handles = [
      new FakeHandle((message, current) => {
        if ((message as { type?: string }).type === 'boot') current.emit({ type: 'log', text: 'x'.repeat(1_000) })
      }),
      new FakeHandle((message, current) => {
        if ((message as { type?: string }).type === 'boot') current.emitRaw('not-base64\n')
      }),
      new FakeHandle((message, current) => {
        if ((message as { type?: string }).type === 'boot') current.emitRaw('é')
      }),
      new FakeHandle((message, current) => {
        if ((message as { type?: string }).type === 'boot') current.stdout?.emit('error', new Error('stdout broke'))
      }),
    ]
    const fixture = await setup(handles, { maxOutputBytes: 128, maxFrameBytes: 4_096 })

    expect((await fixture.runtime.run(request())).error?.kind).toBe('output-limit')
    const malformed = (await fixture.runtime.run(request())).error
    expect(malformed?.kind).toBe('worker-exit')
    expect(malformed?.message).toContain('bridge failed')
    expect((await fixture.runtime.run(request())).error?.message).toContain('non-ASCII')
    expect((await fixture.runtime.run(request())).error).toEqual({ kind: 'worker-exit', message: 'E2B runtime stdout failed: stdout broke' })
    await fixture.fiber.dispose()
  })

  it('enforces the outbound frame bound on boot and binding replies', async () => {
    const oversizedBoot = new FakeHandle()
    const oversizedReply = new FakeHandle((message, current) => {
      if ((message as { type?: string }).type === 'boot') {
        current.emit({ type: 'call', id: 1, global: 'bridge', name: 'large', args: encodeWorkerJson(null) })
      }
    })
    const fixture = await setup([oversizedBoot, oversizedReply], { maxOutputBytes: 128, maxFrameBytes: 512 })

    const bootResult = await fixture.runtime.run(request(`return ${JSON.stringify('x'.repeat(1_000))}`))
    expect(bootResult.error).toMatchObject({ kind: 'worker-exit' })
    expect(bootResult.error?.message).toContain('frame exceeded its byte limit')
    expect(oversizedBoot.writes).toHaveLength(0)

    const replyResult = await fixture.runtime.run({
      program: 'return await bridge.large(null)',
      bindings: [{ global: 'bridge', functions: { large: async () => 'x'.repeat(1_000) } }],
    })
    expect(replyResult.error).toMatchObject({ kind: 'worker-exit' })
    expect(replyResult.error?.message).toContain('frame exceeded its byte limit')
    expect(oversizedReply.writes).toHaveLength(1)
    await fixture.fiber.dispose()
  })

  it('contains stdin errors, process exits, spawn failures, and missing pipes', async () => {
    const writeError = new FakeHandle(() => {}, { writeError: new Error('write callback broke') })
    const stdinError = new FakeHandle((message, current) => {
      if ((message as { type?: string }).type === 'boot') current.stdin?.emit('error', new Error('stdin broke'))
    })
    const earlyExit = new FakeHandle(() => {}, { stderr: 'remote diagnostic' })
    const quietExit = new FakeHandle()
    const emptyStderrExit = new FakeHandle(() => {}, { stderr: '' })
    const spawnFailure = new FakeHandle()
    const missingStdin = new FakeHandle(() => {}, { stdin: false })
    const missingStdout = new FakeHandle(() => {}, { stdout: false, waitError: new Error('missing-stream process query failed') })
    const truncated = new FakeHandle((message, current) => {
      if ((message as { type?: string }).type === 'boot') {
        current.emitRaw('YQ==')
        setImmediate(() => { current.exit() })
      }
    })
    const cleanupFailure = new FakeHandle((message, current) => {
      if ((message as { type?: string }).type === 'boot') current.emit({ type: 'done' })
    }, { waitError: new Error('process query failed') })
    const fixture = await setup([
      writeError, stdinError, earlyExit, quietExit, emptyStderrExit,
      spawnFailure, missingStdin, missingStdout, truncated, cleanupFailure,
    ])

    expect((await fixture.runtime.run(request())).error).toEqual({ kind: 'worker-exit', message: 'E2B runtime bridge write failed: write callback broke' })
    expect((await fixture.runtime.run(request())).error).toEqual({ kind: 'worker-exit', message: 'E2B runtime stdin failed: stdin broke' })
    setImmediate(() => { earlyExit.exit() })
    expect((await fixture.runtime.run(request())).error).toEqual({ kind: 'worker-exit', message: 'E2B runtime exited before completing: remote diagnostic' })
    setImmediate(() => { quietExit.exit() })
    expect((await fixture.runtime.run(request())).error).toEqual({ kind: 'worker-exit', message: 'E2B runtime exited before completing' })
    setImmediate(() => { emptyStderrExit.exit() })
    expect((await fixture.runtime.run(request())).error).toEqual({ kind: 'worker-exit', message: 'E2B runtime exited before completing' })
    setImmediate(() => { spawnFailure.crash('spawn rejected') })
    expect((await fixture.runtime.run(request())).error).toEqual({ kind: 'worker-exit', message: 'E2B runtime spawn failed: spawn rejected' })
    expect((await fixture.runtime.run(request())).error?.message).toContain('dropped a piped runtime stream')
    expect((await fixture.runtime.run(request())).error).toEqual({ kind: 'worker-exit', message: 'E2B runtime cleanup failed: missing-stream process query failed' })
    expect(missingStdin.terminated).toBe(1)
    expect(missingStdin.waitCalls).toBe(1)
    expect(missingStdout.terminated).toBe(1)
    expect(missingStdout.waitCalls).toBe(1)
    expect((await fixture.runtime.run(request())).error).toEqual({ kind: 'worker-exit', message: 'E2B frame stream ended mid-frame' })
    expect((await fixture.runtime.run(request())).error).toEqual({ kind: 'worker-exit', message: 'E2B runtime cleanup failed: process query failed' })
    await fixture.fiber.dispose()
  })

  it('reports wall timeout, abort, pre-abort, type-strip failure, and disposal', async () => {
    const timeout = new FakeHandle()
    const abort = new FakeHandle()
    const disposing = new FakeHandle()
    const fixture = await setup([timeout, abort, disposing], { maxWallMs: 20 })

    expect((await fixture.runtime.run(request())).error).toEqual({ kind: 'timeout', message: 'wall-clock ceiling reached (20ms)' })
    const controller = new AbortController()
    const aborting = fixture.runtime.run({ ...request(), signal: controller.signal })
    controller.abort('stop')
    expect((await aborting).error).toEqual({ kind: 'abort', message: 'stop' })
    expect((await fixture.runtime.run({ ...request(), signal: AbortSignal.abort('already') })).error)
      .toEqual({ kind: 'abort', message: 'already' })
    expect((await fixture.runtime.run(request('enum E { A }'))).error?.kind).toBe('exception')

    const live = fixture.runtime.run(request())
    await new Promise(resolve => setImmediate(resolve))
    await fixture.fiber.dispose()
    expect((await live).error).toEqual({ kind: 'abort', message: 'runtime disposed' })
    await expect(fixture.runtime.run(request())).rejects.toThrow('after disposal')
  })

  it('drops binding replies that settle after abort', async () => {
    const controller = new AbortController()
    const resolution = Promise.withResolvers<string>()
    const invoked = Promise.withResolvers<undefined>()
    const handle = new FakeHandle((message, current) => {
      if ((message as { type?: string }).type === 'boot') {
        current.emit({ type: 'call', id: 1, global: 'bridge', name: 'late', args: encodeWorkerJson(null) })
      }
    })
    const fixture = await setup([handle])
    const running = fixture.runtime.run({
      program: 'return await bridge.late(null)',
      bindings: [{
        global: 'bridge',
        functions: {
          late: async () => {
            invoked.resolve(undefined)
            return await resolution.promise
          },
        },
      }],
      signal: controller.signal,
    })
    await invoked.promise
    controller.abort('stop')
    expect((await running).error).toEqual({ kind: 'abort', message: 'stop' })
    resolution.resolve('late')
    await new Promise(resolve => setImmediate(resolve))
    expect(handle.writes).toHaveLength(1)
    await fixture.fiber.dispose()
  })

  it('validates binding and runtime configuration before remote execution', async () => {
    const fixture = await setup([])
    const invalidRequests = [
      { global: 'not-valid!', functions: {} },
      { global: 'await', functions: {} },
      { global: 'console', functions: {} },
      { global: 'same', functions: {} },
      { global: 'same', functions: {} },
      { global: 'ok', functions: {}, errorClass: { name: 'not-valid!', memberNameProperty: 'member' } },
      { global: 'ok', functions: {}, errorClass: { name: 'await', memberNameProperty: 'member' } },
      { global: 'Clash', functions: {}, errorClass: { name: 'Clash', memberNameProperty: 'member' } },
      { global: 'one', functions: {}, errorClass: { name: 'Err', memberNameProperty: 'member' } },
      { global: 'two', functions: {}, errorClass: { name: 'Err', memberNameProperty: 'member' } },
      { global: 'ok', functions: {}, errorClass: { name: 'Err', memberNameProperty: '' } },
      { global: 'ok', functions: {}, errorClass: { name: 'Err', memberNameProperty: 'message' } },
    ]
    for (const bindings of [
      [invalidRequests[0]], [invalidRequests[1]], [invalidRequests[2]],
      invalidRequests.slice(3, 5), [invalidRequests[5]], [invalidRequests[6]],
      [invalidRequests[7]], invalidRequests.slice(8, 10), [invalidRequests[10]], [invalidRequests[11]],
    ]) {
      await expect(fixture.runtime.run({ program: 'return 1', bindings: bindings as never })).rejects.toThrow()
    }
    await fixture.fiber.dispose()

    for (const config of [
      { computeMs: 0 }, { computeMs: 1.5 }, { maxOutputBytes: 3 },
      { maxWallMs: 2_147_483_648 }, { maxFrameBytes: 10, maxOutputBytes: 20 },
    ]) {
      const ctx = new Context()
      const subprocess = Object.create(E2BSubprocessService.prototype) as E2BSubprocessService
      ctx.provide('e2b', { getSandbox: async () => ({}) } as never)
      ctx.provide('subprocess', subprocess)
      await expect(ctx.plugin(E2BCodeRuntime, config)).rejects.toThrow()
    }

    const wrong = new Context()
    wrong.provide('e2b', { getSandbox: async () => ({}) } as never)
    wrong.provide('subprocess', {} as never)
    await expect(wrong.plugin(E2BCodeRuntime, {})).rejects.toThrow('dsh-subprocess-e2b')
  })

  it('turns asynchronous runtime preparation failure into a run result', async () => {
    const sandbox = {
      files: { write: vi.fn().mockRejectedValue(new Error('upload failed')) },
      commands: { run: vi.fn() },
    } as unknown as Sandbox
    const fixture = await setup([], {}, sandbox)
    expect((await fixture.runtime.run(request())).error).toEqual({
      kind: 'worker-exit',
      message: 'E2B runtime setup failed: upload failed',
    })
    await fixture.fiber.dispose()
  })

  it('returns disposal when remote preparation completes after teardown', async () => {
    const gate = Promise.withResolvers<Sandbox>()
    const fixture = await setup([], {}, {}, () => gate.promise)
    const running = fixture.runtime.run(request())
    const disposing = fixture.fiber.dispose()
    let disposed = false
    void disposing.then(() => { disposed = true })
    await new Promise(resolve => setImmediate(resolve))
    const disposedBeforeSetup = disposed
    gate.resolve(fixture.sandbox)
    await disposing
    expect(disposedBeforeSetup).toBe(false)
    expect((await running).error).toEqual({ kind: 'abort', message: 'runtime disposed' })
    expect(fixture.write).not.toHaveBeenCalled()
  })

  it('observes abort while runtime preparation is pending', async () => {
    const gate = Promise.withResolvers<Sandbox>()
    const fixture = await setup([], {}, {}, () => gate.promise)
    const controller = new AbortController()
    const running = fixture.runtime.run({ ...request(), signal: controller.signal })

    controller.abort('stop during setup')
    const early = await Promise.race([
      running.then(result => ({ kind: 'result' as const, result })),
      new Promise<{ kind: 'pending' }>((resolve) => { setImmediate(() => { resolve({ kind: 'pending' }) }) }),
    ])
    expect(fixture.spawn).not.toHaveBeenCalled()

    gate.resolve(fixture.sandbox)
    expect(early).toMatchObject({ kind: 'result', result: { error: { kind: 'abort', message: 'stop during setup' } } })
    await running
    await fixture.fiber.dispose()
  })

  it('classifies an abort that races synchronous subprocess spawn', async () => {
    const fixture = await setup()
    const controller = new AbortController()
    fixture.spawn.mockImplementationOnce(() => {
      controller.abort('stop at spawn')
      throw new Error('aborted before spawn')
    })

    expect((await fixture.runtime.run({ ...request(), signal: controller.signal })).error)
      .toEqual({ kind: 'abort', message: 'stop at spawn' })

    fixture.spawn.mockImplementationOnce(() => { throw new Error('synchronous spawn failure') })
    expect((await fixture.runtime.run(request())).error).toEqual({
      kind: 'worker-exit',
      message: 'E2B runtime spawn failed: synchronous spawn failure',
    })
    await fixture.fiber.dispose()

    const disposingFixture = await setup()
    disposingFixture.spawn.mockImplementationOnce(() => {
      void (disposingFixture.runtime as unknown as { teardown(): Promise<void> }).teardown()
      throw new Error('spawn raced disposal')
    })
    expect((await disposingFixture.runtime.run(request())).error)
      .toEqual({ kind: 'abort', message: 'runtime disposed' })
    await disposingFixture.fiber.dispose()
  })

  it('closes both abort races around runtime readiness and live-run publication', async () => {
    let preparationAborted = false
    const preparationSignal = {
      get aborted() { return preparationAborted },
      reason: 'preparation race',
      addEventListener() { preparationAborted = true },
      removeEventListener() {},
    } as unknown as AbortSignal
    const liveHandle = new FakeHandle()
    const fixture = await setup([liveHandle])
    expect((await fixture.runtime.run({ ...request(), signal: preparationSignal })).error)
      .toEqual({ kind: 'abort', message: 'preparation race' })
    expect(fixture.spawn).not.toHaveBeenCalled()

    let liveAborted = false
    let registrations = 0
    const liveSignal = {
      get aborted() { return liveAborted },
      reason: 'live publication race',
      addEventListener() {
        registrations += 1
        if (registrations === 2) liveAborted = true
      },
      removeEventListener() {},
    } as unknown as AbortSignal
    expect((await fixture.runtime.run({ ...request(), signal: liveSignal })).error)
      .toEqual({ kind: 'abort', message: 'live publication race' })
    await fixture.fiber.dispose()
  })

  it('retains a live run until remote cleanup reaches quiescence', async () => {
    const cleanup = Promise.withResolvers<boolean>()
    const handle = new FakeHandle((message, current) => {
      if ((message as { type?: string }).type === 'boot') current.emit({ type: 'done' })
    }, { waitResult: cleanup.promise })
    const fixture = await setup([handle])
    const running = fixture.runtime.run(request())
    await vi.waitFor(() => { expect(handle.waitCalls).toBe(1) })

    const disposing = fixture.fiber.dispose()
    let disposed = false
    void disposing.then(() => { disposed = true })
    await new Promise(resolve => setImmediate(resolve))
    const disposedBeforeCleanup = disposed

    cleanup.resolve(true)
    await expect(running).resolves.toEqual({ logs: [] })
    await expect(disposing).resolves.toBeUndefined()
    expect(disposedBeforeCleanup).toBe(false)
  })

  it('registers the package-owned invariant companion', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantService, { enabled: true })
    const fiber = await ctx.plugin(E2BCodeRuntimeInvariant).await()
    await fiber.dispose()
  })
})
