import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { LogBuffer, makeConsoleShim, makeNamespaces, captureStreamWrites, prepareCompletion, runWorkerMain, ToolCallError, truncateUtf8Bytes, wireReplies } from '../src/bootstrap.ts'
import type { BootstrapPort, PatchableStream, PendingCall } from '../src/bootstrap.ts'
import type { ReplyMessage, WorkerToHost } from '../src/protocol.ts'
import { decodeWorkerJson, encodeWorkerJson } from '../src/worker-json.ts'

/**
 * An in-process stand-in for the worker's parentPort: the test plays the
 * HOST side — inspect what the bootstrap posted, feed replies back — so
 * every line of worker-side logic runs under coverage without spawning an
 * isolate (real-worker behavior is pinned by runtime.spec.ts).
 */
class FakePort implements BootstrapPort {
  sent: WorkerToHost[] = []
  private readonly emitter = new EventEmitter()
  /** Host-scripted responder; return undefined to leave the call pending. */
  respond: (message: WorkerToHost) => ReplyMessage | undefined = () => undefined

  postMessage(message: WorkerToHost): void {
    this.sent.push(message)
    const reply = this.respond(message)
    if (reply) queueMicrotask(() => this.emitter.emit('message', reply))
  }

  on(event: 'message', listener: (message: ReplyMessage) => void): void {
    this.emitter.on(event, listener)
  }

  deliver(message: ReplyMessage): void {
    this.emitter.emit('message', message)
  }

  logs(): string[] {
    return this.sent.filter(message => message.type === 'log').map(message => message.text)
  }

  done(): WorkerToHost | undefined {
    return this.sent.find(message => message.type === 'done')
  }

  doneValue(): unknown {
    const done = this.done()
    return done?.type === 'done' && done.value !== undefined ? decodeWorkerJson(done.value) : undefined
  }
}

function fakeStreams(): { stdout: PatchableStream; stderr: PatchableStream } {
  return { stdout: { write: () => true }, stderr: { write: () => true } }
}

/** Capture one promise rejection without Vitest's intentionally `any` matcher channel. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return undefined
  } catch (error: unknown) {
    return error
  }
}

const BOOT = { maxOutputBytes: 65_536 }

describe('LogBuffer', () => {
  it('streams entries to the sink until the byte budget, then emits one fitting prefix and reports the limit once', () => {
    const seen: string[] = []
    let limits = 0
    const buffer = new LogBuffer(10, text => seen.push(text), () => { limits += 1 })
    buffer.push('12345')
    buffer.push('123456')
    buffer.push('dropped')
    expect(seen).toEqual(['12345', '12345'])
    expect(limits).toBe(1)

    const exactlyFull: string[] = []
    const fullBuffer = new LogBuffer(4, text => exactlyFull.push(text))
    fullBuffer.push('1234')
    fullBuffer.push('no-prefix-fits')
    expect(exactlyFull).toEqual(['1234'])
  })
})

describe('makeConsoleShim', () => {
  it('captures the five methods and renders non-strings inspect-style', () => {
    const seen: string[] = []
    const shim = makeConsoleShim(new LogBuffer(1_000, text => seen.push(text)))
    shim.log('plain', { a: 1 })
    shim.info('i')
    shim.warn('w')
    shim.error('e')
    shim.debug('d')
    expect(seen).toEqual(['plain { a: 1 }', 'i', 'w', 'e', 'd'])
  })
})

describe('captureStreamWrites', () => {
  it('redirects writes into the buffer and restores on request', () => {
    const seen: string[] = []
    const buffer = new LogBuffer(1_000, text => seen.push(text))
    let underlying = ''
    const stream: PatchableStream = { write: (chunk: unknown) => { underlying += String(chunk); return true } }
    const restore = captureStreamWrites(buffer, stream)
    stream.write('captured', 'utf8')
    stream.write(Buffer.from('bytes'))
    restore()
    stream.write('after')
    expect(seen).toEqual(['captured', 'bytes'])
    expect(underlying).toBe('after')
  })

  it('invokes the write callback asynchronously, in both optional-encoding shapes', async () => {
    const buffer = new LogBuffer(1_000, () => {})
    const stream: PatchableStream = { write: () => true }
    captureStreamWrites(buffer, stream)
    const calls: (Error | null | undefined)[] = []
    stream.write('two-arg', (error?: Error | null) => calls.push(error))
    stream.write('three-arg', 'utf8', (error?: Error | null) => calls.push(error))
    // Node's contract: the callback fires after the write call returns.
    expect(calls).toEqual([])
    await new Promise<void>(resolve => stream.write('awaited flush', resolve))
    expect(calls).toEqual([null, null])
  })

  it('still fires the callback for a write the exhausted budget drops', async () => {
    const buffer = new LogBuffer(4, () => {})
    const stream: PatchableStream = { write: () => true }
    captureStreamWrites(buffer, stream)
    stream.write('this write overflows the budget and is dropped')
    await new Promise<void>(resolve => stream.write('also dropped', resolve))
  })
})

describe('prepareCompletion', () => {
  it('omits undefined and passes lossless JSON values exactly', () => {
    expect(prepareCompletion(undefined, 100)).toEqual({})
    expect(prepareCompletion({ a: [1, 'two'] }, 100)).toEqual({ value: encodeWorkerJson({ a: [1, 'two'] }) })
  })

  it('turns every lossy completion shape into invalid-output', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const sparse = Array(2)
    class Exotic { readonly marker = true }
    for (const value of [{ fn: () => 1 }, -0, Number.POSITIVE_INFINITY, sparse, cyclic, new Exotic()]) {
      expect(prepareCompletion(value, 1_000)).toEqual({
        error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' },
      })
    }
  })

  it('reports an oversized value instead of substituting rendered text', () => {
    expect(prepareCompletion('x'.repeat(50), 10)).toEqual({
      error: { kind: 'output-limit', message: 'outer output exceeded 10 bytes' },
    })
  })

  it('measures the exact JSON serialization at and over the boundary', () => {
    expect(prepareCompletion('€', 5)).toEqual({ value: encodeWorkerJson('€') })
    expect(prepareCompletion('€', 4)).toEqual({
      error: { kind: 'output-limit', message: 'outer output exceeded 4 bytes' },
    })
  })

  it('contains a getter failure as invalid-output', () => {
    const value = Object.defineProperty({}, 'x', { enumerable: true, get() { throw new Error('getter exploded') } })
    expect(prepareCompletion(value, 1_000)).toEqual({
      error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' },
    })
  })
})

describe('truncateUtf8Bytes', () => {
  it('returns a fitting string whole', () => {
    expect(truncateUtf8Bytes('fits', 4)).toBe('fits')
  })

  it('cuts at a code-point boundary, never mid-surrogate-pair', () => {
    // Each 😀 is one code point, two code units, four UTF-8 bytes: a 5-byte
    // budget fits exactly one — and never leaves a lone surrogate behind.
    const cut = truncateUtf8Bytes('😀😀', 5)
    expect(cut).toBe('😀')
    expect(Buffer.byteLength(truncateUtf8Bytes('😀😀', 3), 'utf8')).toBe(0)
  })
})

describe('makeNamespaces', () => {
  it('rejects a malformed success reply instead of resolving a lossy binding value', async () => {
    const port = new FakePort()
    const pending = new Map<number, PendingCall>()
    wireReplies(port, pending)
    const result = new Promise<unknown>((resolve, reject) => { pending.set(1, { resolve, reject }) })
    port.deliver({ type: 'reply', id: 1, ok: true, value: [undefined] as never })
    await expect(result).rejects.toThrow('binding resolution must be lossless JSON')
  })

  it('exposes prototype-colliding names as ordinary own properties', async () => {
    const port = new FakePort()
    port.respond = message => message.type === 'call'
      ? { type: 'reply', id: message.id, ok: true, value: encodeWorkerJson(`${message.name}-ok`) }
      : undefined
    const pending = new Map<number, PendingCall>()
    wireReplies(port, pending)
    const [tools] = makeNamespaces({ namespaces: [{ global: 'tools', names: ['__proto__', 'constructor', 'toString'] }] }, port, pending, { value: 1 }) as [Record<string, (args: unknown) => Promise<unknown>>]
    expect(Object.getPrototypeOf(tools)).toBeNull()
    await expect(tools['__proto__']?.({})).resolves.toBe('__proto__-ok')
    await expect(tools['constructor']?.({})).resolves.toBe('constructor-ok')
    await expect(tools['toString']?.({})).resolves.toBe('toString-ok')
  })

  it('rejects a postMessage clone failure without leaking the pending entry', async () => {
    let firstCall = true
    const throwingPort: BootstrapPort = {
      // First call throws an Error (the real DataCloneError shape), the
      // second a bare string — the rejection renders both.
      postMessage: () => {
        if (firstCall) { firstCall = false; throw new Error('DataCloneError-ish') }
        throw 'raw-clone-failure'
      },
      on: () => {},
    }
    const pending = new Map<number, PendingCall>()
    const [tools] = makeNamespaces({ namespaces: [{ global: 'tools', names: ['x'] }] }, throwingPort, pending, { value: 1 }) as [Record<string, (args: unknown) => Promise<unknown>>]
    const first = await rejectionOf(tools.x?.({ first: true }) ?? Promise.resolve())
    const second = await rejectionOf(tools.x?.({ second: true }) ?? Promise.resolve())
    expect(first).toMatchObject({ name: 'ToolCallError', toolName: 'x' })
    expect(second).toMatchObject({ name: 'ToolCallError', toolName: 'x' })
    expect(first).toBeInstanceOf(ToolCallError)
    expect(second).toBeInstanceOf(ToolCallError)
    expect((first as Error).message).toMatch(/DataCloneError-ish/)
    expect((second as Error).message).toMatch(/raw-clone-failure/)
    expect(pending.size).toBe(0)
  })

  it('rejects lossy arguments before posting or allocating a call id', async () => {
    let posts = 0
    const port: BootstrapPort = { postMessage: () => { posts += 1 }, on: () => {} }
    const pending = new Map<number, PendingCall>()
    const nextId = { value: 1 }
    const [tools] = makeNamespaces(
      { namespaces: [{ global: 'tools', names: ['x'] }] }, port, pending, nextId,
    ) as [Record<string, (args: unknown) => Promise<unknown>>]
    const decorated = [1]
    Object.defineProperty(decorated, 'extra', { value: true })
    const throwing = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => { throw new Error('getter exploded') },
    })

    for (const value of [() => 1, new Date(), decorated, throwing]) {
      const failure = await rejectionOf(tools.x?.(value) ?? Promise.resolve())
      expect(failure).toMatchObject({
        name: 'ToolCallError', toolName: 'x', message: 'binding arguments must be lossless JSON',
      })
    }
    expect(posts).toBe(0)
    expect(pending.size).toBe(0)
    expect(nextId.value).toBe(1)
  })

  it('uses ordinary Error for non-tools namespace failures', async () => {
    const deniedPort = new FakePort()
    deniedPort.respond = message => message.type === 'call'
      ? { type: 'reply', id: message.id, ok: false, message: 'helper denied' }
      : undefined
    const deniedPending = new Map<number, PendingCall>()
    wireReplies(deniedPort, deniedPending)
    const [helpers] = makeNamespaces({ namespaces: [{ global: 'helpers', names: ['x'] }] }, deniedPort, deniedPending, { value: 1 }) as [Record<string, (args: unknown) => Promise<unknown>>]
    const denied = await rejectionOf(helpers.x?.({}) ?? Promise.resolve())
    expect(denied).toBeInstanceOf(Error)
    expect(denied).not.toBeInstanceOf(ToolCallError)

    const invalid = await rejectionOf(helpers.x?.(() => 1) ?? Promise.resolve())
    expect(invalid).toBeInstanceOf(Error)
    expect(invalid).not.toBeInstanceOf(ToolCallError)
    expect((invalid as Error).message).toBe('binding arguments must be lossless JSON')

    const clonePort: BootstrapPort = { postMessage: () => { throw new Error('clone failed') }, on: () => {} }
    const [cloneHelpers] = makeNamespaces({ namespaces: [{ global: 'helpers', names: ['x'] }] }, clonePort, new Map(), { value: 1 }) as [Record<string, (args: unknown) => Promise<unknown>>]
    const cloneFailure = await rejectionOf(cloneHelpers.x?.({}) ?? Promise.resolve())
    expect(cloneFailure).toBeInstanceOf(Error)
    expect(cloneFailure).not.toBeInstanceOf(ToolCallError)
  })
})

describe('runWorkerMain', () => {
  it('runs a program end-to-end: bindings, console, return value', async () => {
    const port = new FakePort()
    port.respond = (message) => {
      if (message.type !== 'call') return undefined
      const args = decodeWorkerJson(message.args) as { n: number }
      return { type: 'reply', id: message.id, ok: true, value: encodeWorkerJson(args.n * 2) }
    }
    await runWorkerMain(port, {
      ...BOOT,
      code: 'const doubled = await tools.double({ n: 21 }); console.log("got", doubled); return { doubled };',
      namespaces: [{ global: 'tools', names: ['double'] }],
    }, fakeStreams())
    expect(port.logs()).toEqual(['got 42'])
    expect(port.doneValue()).toEqual({ doubled: 42 })
  })

  it('reports worker-side log capture overflow before completing', async () => {
    const port = new FakePort()
    await runWorkerMain(port, {
      maxOutputBytes: 4,
      code: 'console.log("12345"); return null',
      namespaces: [],
    }, fakeStreams())
    expect(port.sent).toContainEqual({ type: 'log', text: '1234' })
    expect(port.sent).toContainEqual({ type: 'output-limit' })
    expect(port.doneValue()).toBeNull()
  })

  it('reports a thrown program error on the done message', async () => {
    const port = new FakePort()
    await runWorkerMain(port, { ...BOOT, code: 'throw new Error("boom")', namespaces: [] }, fakeStreams())
    const done = port.done()
    expect(done?.type).toBe('done')
    expect(done?.type === 'done' ? done.error?.kind : undefined).toBe('exception')
    expect(done?.type === 'done' ? done.error?.message : undefined).toContain('boom')
    expect(done?.type === 'done' ? done.value : undefined).toBeUndefined()
  })

  it('renders non-Error throws and stack-less Errors on the done message', async () => {
    const rawPort = new FakePort()
    await runWorkerMain(rawPort, { ...BOOT, code: 'throw "raw-throw"', namespaces: [] }, fakeStreams())
    expect(rawPort.done()).toEqual({ type: 'done', error: { kind: 'exception', message: 'raw-throw' } })

    const barePort = new FakePort()
    await runWorkerMain(barePort, { ...BOOT, code: 'const e = new Error("bare"); e.stack = undefined; throw e', namespaces: [] }, fakeStreams())
    expect(barePort.done()).toEqual({ type: 'done', error: { kind: 'exception', message: 'bare' } })
  })

  it('surfaces a host failure reply as a program-side rejection it can catch', async () => {
    const port = new FakePort()
    port.respond = message => message.type === 'call' ? { type: 'reply', id: message.id, ok: false, message: 'denied by host' } : undefined
    await runWorkerMain(port, {
      ...BOOT,
      code: 'try { await tools.x({}) } catch (error) { return { caught: error instanceof ToolCallError, name: error.name, toolName: error.toolName, message: error.message } }',
      namespaces: [{ global: 'tools', names: ['x'] }],
    }, fakeStreams())
    expect(port.doneValue()).toEqual({ caught: true, name: 'ToolCallError', toolName: 'x', message: 'denied by host' })
    expect(new ToolCallError('x', 'nope')).toMatchObject({ name: 'ToolCallError', toolName: 'x', message: 'nope' })
  })

  it('ignores replies for unknown pending ids', async () => {
    const port = new FakePort()
    port.respond = (message) => {
      if (message.type !== 'call') return undefined
      // Deliver a stray reply first; the real one follows.
      port.deliver({ type: 'reply', id: 9_999, ok: true, value: encodeWorkerJson('stray') })
      return { type: 'reply', id: message.id, ok: true, value: encodeWorkerJson('real') }
    }
    await runWorkerMain(port, {
      ...BOOT,
      code: 'return await tools.x({})',
      namespaces: [{ global: 'tools', names: ['x'] }],
    }, fakeStreams())
    expect(port.doneValue()).toBe('real')
  })

  it('captures raw stream writes through the patched process streams', async () => {
    const port = new FakePort()
    const streams = fakeStreams()
    await runWorkerMain(port, { ...BOOT, code: 'return 1', namespaces: [] }, streams)
    streams.stdout.write('never seen — already restored? no: patch persists in worker')
    // The patch stays installed for the worker's lifetime; writes during the
    // program landed in order. Here the program wrote nothing via streams, so
    // only the post-run write above went through the patched slot.
    expect(port.logs().at(-1)).toBe('never seen — already restored? no: patch persists in worker')
  })
})
