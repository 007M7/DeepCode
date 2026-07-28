import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { encodeE2BFrame } from '@deepseek-ai/dsh-e2b'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { E2BLspTransport } from '@deepseek-ai/dsh-lsp-e2b'

class FakeHandle implements SubprocessHandle {
  readonly pid = 321
  readonly stdin: PassThrough | undefined
  readonly stdout: PassThrough | undefined
  readonly stderr = undefined
  readonly collected: SubprocessHandle['collected']
  readonly result = Promise.withResolvers<SubprocessOutcome>()
  readonly done = this.result.promise
  terminated = 0
  waitResult = true

  constructor(options: { stdin?: boolean; stdout?: boolean; diagnostic?: string } = {}) {
    this.stdin = options.stdin === false ? undefined : new PassThrough()
    this.stdout = options.stdout === false ? undefined : new PassThrough()
    this.collected = options.diagnostic === undefined
      ? {}
      : { stderr: { readFrom: () => ({ text: options.diagnostic as string, nextOffset: 0, lossy: false }) } }
  }

  terminate(): void {
    this.terminated += 1
  }

  async waitForExit(): Promise<boolean> {
    return this.waitResult
  }

  resolve(outcome: SubprocessOutcome = { exitCode: 0, signal: null }): void {
    this.stdout?.end()
    this.result.resolve(outcome)
  }

  reject(error: unknown): void {
    this.stdout?.end()
    this.result.reject(error)
  }
}

function proxyFrame(type: 'stdout' | 'stderr', data: string | Buffer): string {
  return encodeE2BFrame({ type, data: Buffer.from(data).toString('base64') })
}

describe('E2BLspTransport', () => {
  it('frames stdin, decodes split byte output, and exposes handle lifecycle', async () => {
    const inner = new FakeHandle({ diagnostic: 'proxy diagnostic' })
    const transport = new E2BLspTransport(inner, 1_024, 64)
    let stdin = ''
    inner.stdin?.on('data', (chunk) => { stdin += String(chunk) })
    let stdout = Buffer.alloc(0)
    transport.stdout.on('data', (chunk) => { stdout = Buffer.concat([stdout, chunk]) })

    transport.stdin.write(Buffer.from([0, 0xff]))
    await new Promise(resolve => setImmediate(resolve))
    const encodedInput = stdin.trim()
    const input = JSON.parse(Buffer.from(encodedInput, 'base64').toString('utf8')) as Record<string, string>
    expect(input).toEqual({ type: 'stdin', data: 'AP8=' })

    const frames = proxyFrame('stdout', Buffer.from([0, 0xff]))
      + proxyFrame('stderr', 'server diagnostic')
      + encodeE2BFrame({ type: 'exit', code: 0, signal: null })
    inner.stdout?.write(frames.slice(0, 7))
    inner.stdout?.write(frames.slice(7))
    inner.stdout?.write(proxyFrame('stderr', ''))
    inner.stdout?.write(encodeE2BFrame({ type: 'exit', code: null, signal: 'SIGTERM' }))
    inner.resolve()

    await expect(transport.done).resolves.toEqual({ exitCode: 0, signal: null })
    expect(stdout).toEqual(Buffer.from([0, 0xff]))
    expect(transport.collected.stderr?.readFrom(0).text).toBe('server diagnosticproxy diagnostic')
    expect(transport.pid).toBe(321)
    inner.waitResult = false
    await expect(transport.waitForExit()).resolves.toBe(false)
    transport.terminate()
    expect(inner.terminated).toBe(1)
  })

  it('ends the inner stdin and retains a bounded byte tail with independent offsets', async () => {
    const inner = new FakeHandle()
    const transport = new E2BLspTransport(inner, 1_024, 4)
    const finished = once(inner.stdin!, 'finish')
    transport.stdin.end()
    await finished

    inner.stdout?.write(proxyFrame('stderr', 'ab'))
    inner.stdout?.write(proxyFrame('stderr', 'cdef'))
    const reader = transport.collected.stderr!
    expect(reader.readFrom(0)).toEqual({ text: 'cdef', nextOffset: 6, lossy: true })
    expect(reader.readFrom(2)).toEqual({ text: 'cdef', nextOffset: 6, lossy: false })
    expect(reader.readFrom(5)).toEqual({ text: 'f', nextOffset: 6, lossy: false })
    expect(reader.readFrom(99)).toEqual({ text: '', nextOffset: 6, lossy: false })
    expect(() => reader.readFrom(-1)).toThrow('non-negative safe integer')
    expect(() => reader.readFrom(1.5)).toThrow('non-negative safe integer')
    inner.resolve()
    await transport.done

    const partialInner = new FakeHandle()
    const partial = new E2BLspTransport(partialInner, 1_024, 4)
    partialInner.stdout?.write(proxyFrame('stderr', 'abcdef'))
    expect(partial.collected.stderr?.readFrom(0)).toEqual({ text: 'cdef', nextOffset: 6, lossy: true })
    partialInner.resolve()
    await partial.done
  })

  it.each([
    ['non-object', encodeE2BFrame(null), 'malformed frame'],
    ['wrong type', encodeE2BFrame({ type: 'other', data: '' }), 'malformed frame'],
    ['invalid exit', encodeE2BFrame({ type: 'exit', code: 'zero', signal: null }), 'malformed frame'],
    ['missing data', encodeE2BFrame({ type: 'stdout' }), 'malformed frame'],
    ['invalid base64', encodeE2BFrame({ type: 'stdout', data: 'abc' }), 'invalid base64'],
    ['invalid outer frame', 'not-base64\n', 'invalid base64'],
    ['non-ASCII outer frame', 'é', 'non-ASCII'],
  ])('fails %s proxy traffic and terminates the group', async (_name, frame, message) => {
    const inner = new FakeHandle()
    const transport = new E2BLspTransport(inner, 1_024, 32)
    inner.stdout?.write(frame)
    inner.stdout?.write(proxyFrame('stdout', 'ignored'))
    inner.stdout?.emit('error', new Error('second failure'))
    inner.resolve()
    await expect(transport.done).rejects.toThrow(message)
    expect(inner.terminated).toBe(1)
  })

  it('fails truncated frames and preserves inner spawn rejection', async () => {
    const truncatedInner = new FakeHandle()
    const truncated = new E2BLspTransport(truncatedInner, 1_024, 32)
    truncatedInner.stdout?.write('YQ==')
    truncatedInner.resolve()
    await expect(truncated.done).rejects.toThrow('mid-frame')

    const rejectedInner = new FakeHandle({ diagnostic: 'tail' })
    const rejected = new E2BLspTransport(rejectedInner, 1_024, 32)
    rejectedInner.reject(new Error('spawn failed'))
    await expect(rejected.done).rejects.toThrow('spawn failed')
    expect(rejected.collected.stderr?.readFrom(0).text).toBe('tail')
  })

  it('forwards output and input stream errors without an unhandled inner error', async () => {
    const outputInner = new FakeHandle()
    const output = new E2BLspTransport(outputInner, 1_024, 32)
    outputInner.stdout?.emit('error', new Error('proxy stdout failed'))
    outputInner.resolve()
    await expect(output.done).rejects.toThrow('proxy stdout failed')

    const inputInner = new FakeHandle()
    const input = new E2BLspTransport(inputInner, 1_024, 32)
    const outerError = once(input.stdin, 'error')
    inputInner.stdin?.emit('error', new Error('proxy stdin failed'))
    await expect(outerError).resolves.toMatchObject([{ message: 'proxy stdin failed' }])
    inputInner.resolve()
    await input.done
  })

  it('normalizes a non-Error decoder throw', async () => {
    const inner = new FakeHandle()
    const transport = new E2BLspTransport(inner, 1_024, 32)
    const internal = transport as unknown as {
      decoder: { push(chunk: string): unknown[] }
      onProxyData(chunk: Buffer): void
    }
    internal.decoder = { push: () => { throw 'raw decoder failure' } }
    internal.onProxyData(Buffer.from('x'))
    inner.resolve()
    await expect(transport.done).rejects.toThrow('raw decoder failure')
  })

  it('rejects a subprocess that drops either required pipe', () => {
    const missingStdin = new FakeHandle({ stdin: false })
    const missingStdout = new FakeHandle({ stdout: false })
    expect(() => new E2BLspTransport(missingStdin, 10, 10)).toThrow('dropped a piped stream')
    expect(() => new E2BLspTransport(missingStdout, 10, 10)).toThrow('dropped a piped stream')
    expect(missingStdin.terminated).toBe(1)
    expect(missingStdout.terminated).toBe(1)
  })
})
