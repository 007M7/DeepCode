import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { LogBuffer, makeConsoleShim, makeNamespaces, captureStreamWrites, prepareValue, runWorkerMain, truncateUtf8Bytes, wireReplies } from '../src/bootstrap.ts'
import type { BootstrapPort, PatchableStream, PendingCall } from '../src/bootstrap.ts'
import type { ReplyMessage, WorkerToHost } from '../src/protocol.ts'

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
}

function fakeStreams(): { stdout: PatchableStream; stderr: PatchableStream } {
  return { stdout: { write: () => true }, stderr: { write: () => true } }
}

const BOOT = { maxLogBytes: 65_536, maxValueBytes: 32_768 }

describe('LogBuffer', () => {
  it('streams entries to the sink until the byte budget, then emits one marker and drops the rest', () => {
    const seen: string[] = []
    const buffer = new LogBuffer(10, text => seen.push(text))
    buffer.push('12345')
    buffer.push('123456')
    buffer.push('dropped')
    expect(seen).toEqual([
      '12345',
      '[dsh-code-runtime-worker] log capture truncated at 10 bytes',
    ])
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

describe('prepareValue', () => {
  it('omits undefined, passes small cloneable values raw', () => {
    expect(prepareValue(undefined, 100)).toEqual({})
    expect(prepareValue({ a: [1, 'two'] }, 100)).toEqual({ value: { a: [1, 'two'] } })
  })

  it('replaces a non-cloneable value with its rendering', () => {
    const { value } = prepareValue({ fn: () => 1 }, 1_000)
    expect(typeof value).toBe('string')
    expect(value).toContain('fn')
  })

  it('replaces an oversized value with a truncation-marked capped rendering', () => {
    const { value } = prepareValue('x'.repeat(50), 10)
    expect(value).toBe(`${'x'.repeat(10)}… [truncated]`)
  })

  it('measures a container by its structured-clone wire size, not its bounded rendering', () => {
    // The bounded inspect rendering of a huge array is tiny ("... N more
    // items"), but its real cross-boundary size is not — the cap must catch
    // it, replacing the value with that bounded rendering.
    const huge = new Array(50_000).fill(7)
    const { value } = prepareValue(huge, 1_000)
    expect(typeof value).toBe('string')
    expect(value).toContain('more items')
  })

  it('caps a multibyte string by UTF-8 bytes, not UTF-16 length', () => {
    // 4 code units but 12 UTF-8 bytes: a length-counting cap would pass the
    // full string through untruncated.
    expect(prepareValue('€€€€', 4)).toEqual({ value: '€… [truncated]' })
  })

  it('caps a multibyte rendering by UTF-8 bytes too', () => {
    // Wire size (24-byte string inside an array) exceeds the cap, so the
    // value crosses as its rendering — whose truncation must also be
    // byte-exact: "[ '" (3 bytes) + two € (6 bytes) = 9; a third € would
    // overflow the 10-byte budget.
    expect(prepareValue(['€€€€€€€€'], 10)).toEqual({ value: "[ '€€… [truncated]" })
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
  it('exposes prototype-colliding names as ordinary own properties', async () => {
    const port = new FakePort()
    port.respond = message => message.type === 'call' ? { type: 'reply', id: message.id, ok: true, value: `${message.name}-ok` } : undefined
    const pending = new Map<number, PendingCall>()
    wireReplies(port, pending)
    const [tools] = makeNamespaces({ namespaces: [{ global: 'tools', names: ['__proto__', 'constructor', 'toString'] }] }, port, pending, { value: 1 }) as [Record<string, (args: unknown) => Promise<unknown>>]
    expect(Object.getPrototypeOf(tools)).toBeNull()
    await expect(tools['__proto__']?.({})).resolves.toBe('__proto__-ok')
    await expect(tools['constructor']?.({})).resolves.toBe('constructor-ok')
    await expect(tools['toString']?.({})).resolves.toBe('toString-ok')
  })

  it('rejects a non-cloneable argument without leaking the pending entry', async () => {
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
    await expect(tools.x?.(() => 1)).rejects.toThrow(/structured-cloneable: DataCloneError-ish/)
    await expect(tools.x?.(() => 1)).rejects.toThrow(/structured-cloneable: raw-clone-failure/)
    expect(pending.size).toBe(0)
  })
})

describe('runWorkerMain', () => {
  it('runs a program end-to-end: bindings, console, return value', async () => {
    const port = new FakePort()
    port.respond = message => message.type === 'call' ? { type: 'reply', id: message.id, ok: true, value: (message.args as { n: number }).n * 2 } : undefined
    await runWorkerMain(port, {
      ...BOOT,
      code: 'const doubled = await tools.double({ n: 21 }); console.log("got", doubled); return { doubled };',
      namespaces: [{ global: 'tools', names: ['double'] }],
    }, fakeStreams())
    expect(port.logs()).toEqual(['got 42'])
    expect(port.done()).toEqual({ type: 'done', value: { doubled: 42 } })
  })

  it('reports a thrown program error on the done message', async () => {
    const port = new FakePort()
    await runWorkerMain(port, { ...BOOT, code: 'throw new Error("boom")', namespaces: [] }, fakeStreams())
    const done = port.done()
    expect(done?.type).toBe('done')
    expect(done?.type === 'done' ? done.error?.message : undefined).toContain('boom')
    expect(done?.type === 'done' ? done.value : undefined).toBeUndefined()
  })

  it('renders non-Error throws and stack-less Errors on the done message', async () => {
    const rawPort = new FakePort()
    await runWorkerMain(rawPort, { ...BOOT, code: 'throw "raw-throw"', namespaces: [] }, fakeStreams())
    expect(rawPort.done()).toEqual({ type: 'done', error: { message: 'raw-throw' } })

    const barePort = new FakePort()
    await runWorkerMain(barePort, { ...BOOT, code: 'const e = new Error("bare"); e.stack = undefined; throw e', namespaces: [] }, fakeStreams())
    expect(barePort.done()).toEqual({ type: 'done', error: { message: 'bare' } })
  })

  it('surfaces a host failure reply as a program-side rejection it can catch', async () => {
    const port = new FakePort()
    port.respond = message => message.type === 'call' ? { type: 'reply', id: message.id, ok: false, message: 'denied by host' } : undefined
    await runWorkerMain(port, {
      ...BOOT,
      code: 'try { await tools.x({}) } catch (error) { return `caught: ${error.message}` }',
      namespaces: [{ global: 'tools', names: ['x'] }],
    }, fakeStreams())
    expect(port.done()).toEqual({ type: 'done', value: 'caught: denied by host' })
  })

  it('ignores replies for unknown pending ids', async () => {
    const port = new FakePort()
    port.respond = (message) => {
      if (message.type !== 'call') return undefined
      // Deliver a stray reply first; the real one follows.
      port.deliver({ type: 'reply', id: 9_999, ok: true, value: 'stray' })
      return { type: 'reply', id: message.id, ok: true, value: 'real' }
    }
    await runWorkerMain(port, {
      ...BOOT,
      code: 'return await tools.x({})',
      namespaces: [{ global: 'tools', names: ['x'] }],
    }, fakeStreams())
    expect(port.done()).toEqual({ type: 'done', value: 'real' })
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
