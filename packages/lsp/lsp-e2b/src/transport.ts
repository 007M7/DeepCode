/** Byte-faithful stdio transport over an E2B subprocess and ASCII/base64 frames. */

import { Buffer } from 'node:buffer'
import { PassThrough, Writable } from 'node:stream'
import { E2BFrameDecoder, encodeE2BFrame } from '@deepseek-ai/dsh-e2b'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputRead,
  SubprocessOutputReader,
} from '@deepseek-ai/dsh-subprocess'

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

class ByteTailReader implements SubprocessOutputReader {
  private chunks: Buffer[] = []
  private totalBytes = 0
  private retainedBytes = 0
  private dropped = false

  constructor(private readonly maxBytes: number) {}

  append(data: Buffer): void {
    if (data.length === 0) return
    this.chunks.push(data)
    this.totalBytes += data.length
    this.retainedBytes += data.length
    while (this.retainedBytes > this.maxBytes && this.chunks.length > 0) {
      const first = this.chunks[0] as Buffer
      const excess = this.retainedBytes - this.maxBytes
      if (first.length <= excess) {
        this.chunks.shift()
        this.retainedBytes -= first.length
      } else {
        this.chunks[0] = first.subarray(excess)
        this.retainedBytes -= excess
      }
      this.dropped = true
    }
  }

  readFrom(fromByte: number): SubprocessOutputRead {
    if (!Number.isSafeInteger(fromByte) || fromByte < 0) {
      throw new Error('subprocess output offset must be a non-negative safe integer')
    }
    const retainedStart = this.totalBytes - this.retainedBytes
    const lossy = fromByte < retainedStart
    const start = lossy ? 0 : Math.min(this.retainedBytes, fromByte - retainedStart)
    const bytes = Buffer.concat(this.chunks).subarray(start)
    return { text: bytes.toString('utf8'), nextOffset: this.totalBytes, lossy: lossy || this.dropped && fromByte === 0 }
  }
}

class FramedInput extends Writable {
  constructor(private readonly target: Writable) {
    super()
    target.on('error', (error: Error) => { this.destroy(error) })
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.target.write(encodeE2BFrame({ type: 'stdin', data: chunk.toString('base64') }), callback)
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.target.end(callback)
  }
}

/** Subprocess handle that decodes a remote proxy's stdout/stderr byte frames. */
export class E2BLspTransport implements SubprocessHandle {
  readonly stdin: Writable
  readonly stdout = new PassThrough()
  readonly stderr = undefined
  readonly collected: SubprocessHandle['collected']
  readonly done: Promise<SubprocessOutcome>
  private readonly stderrTail: ByteTailReader
  private readonly decoder: E2BFrameDecoder
  private failed: Error | undefined

  /**
   * @param inner - E2B subprocess running the installed proxy.
   * @param maxFrameBytes - Maximum decoded proxy frame size.
   * @param maxStderrBytes - Retained raw language-server stderr tail.
   */
  constructor(
    private readonly inner: SubprocessHandle,
    maxFrameBytes: number,
    maxStderrBytes: number,
  ) {
    if (inner.stdin === undefined || inner.stdout === undefined) {
      inner.terminate()
      throw new Error('lsp-e2b: proxy subprocess dropped a piped stream')
    }
    this.stdin = new FramedInput(inner.stdin)
    this.stderrTail = new ByteTailReader(maxStderrBytes)
    this.collected = { stderr: this.stderrTail }
    this.decoder = new E2BFrameDecoder(maxFrameBytes)
    inner.stdout.on('data', (chunk: Buffer) => { this.onProxyData(chunk) })
    inner.stdout.on('error', (error: Error) => { this.fail(error) })
    this.done = inner.done.then(
      (outcome) => {
        this.finishFrames()
        this.captureProxyStderr()
        this.stdout.end()
        if (this.failed !== undefined) throw this.failed
        return outcome
      },
      (error: unknown) => {
        this.captureProxyStderr()
        this.stdout.end()
        throw error
      },
    )
    void this.done.catch(() => {})
  }

  get pid(): number {
    return this.inner.pid
  }

  terminate(): void {
    this.inner.terminate()
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    return await this.inner.waitForExit(signal)
  }

  private onProxyData(chunk: Buffer): void {
    if (this.failed !== undefined) return
    let frames: unknown[]
    try {
      frames = this.decoder.push(chunk.toString('utf8'))
    } catch (error: unknown) {
      this.fail(asError(error))
      return
    }
    for (const frame of frames) this.dispatch(frame)
  }

  private dispatch(frame: unknown): void {
    if (typeof frame !== 'object' || frame === null) {
      this.fail(new Error('lsp-e2b: proxy emitted a malformed frame'))
      return
    }
    const record = frame as Record<string, unknown>
    if (record.type === 'exit' && (record.code === null || typeof record.code === 'number') && (record.signal === null || typeof record.signal === 'string')) return
    if ((record.type !== 'stdout' && record.type !== 'stderr') || typeof record.data !== 'string') {
      this.fail(new Error('lsp-e2b: proxy emitted a malformed frame'))
      return
    }
    const data = Buffer.from(record.data, 'base64')
    if (data.toString('base64') !== record.data) {
      this.fail(new Error('lsp-e2b: proxy emitted invalid base64'))
      return
    }
    if (record.type === 'stdout') this.stdout.write(data)
    else this.stderrTail.append(data)
  }

  private finishFrames(): void {
    if (this.failed !== undefined) return
    try {
      this.decoder.finish()
    } catch (error: unknown) {
      this.fail(asError(error))
    }
  }

  private captureProxyStderr(): void {
    const diagnostic = this.inner.collected.stderr?.readFrom(0).text
    if (diagnostic !== undefined && diagnostic.length > 0) this.stderrTail.append(Buffer.from(diagnostic))
  }

  private fail(error: Error): void {
    if (this.failed !== undefined) return
    this.failed = error
    this.inner.terminate()
    this.stdout.end()
  }
}
