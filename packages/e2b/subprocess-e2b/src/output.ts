/** Bounded host-side projection of a complete output file retained in E2B. */

import { Buffer } from 'node:buffer'
import type { SubprocessOutputRead, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'

/** Offset reader used for one collect-mode E2B stream. */
export class E2BOutputReader implements SubprocessOutputReader {
  private chunks: Buffer[] = []
  private retainedBytes = 0
  private totalBytes = 0

  /**
   * Create a bounded reader over one remote spill path.
   * @param maxBytes - In-memory tail cap.
   * @param maxSpillBytes - Maximum complete remote file size the caller accepts.
   * @param spillPath - Remote full-output path.
   */
  constructor(
    private readonly maxBytes: number,
    private readonly maxSpillBytes: number | undefined,
    private readonly spillPath: string,
  ) {}

  /** Total bytes observed from the SDK stream. */
  get size(): number {
    return this.totalBytes
  }

  /**
   * Append one decoded SDK output event.
   * @param text - Event text delivered by E2B.
   */
  push(text: string): void {
    if (text.length === 0) return
    const chunk = Buffer.from(text)
    this.totalBytes += chunk.length
    this.chunks.push(chunk)
    this.retainedBytes += chunk.length
    while (this.retainedBytes > this.maxBytes) {
      const head = this.chunks[0] as Buffer
      const excess = this.retainedBytes - this.maxBytes
      if (head.length <= excess) {
        this.chunks.shift()
        this.retainedBytes -= head.length
      } else {
        this.chunks[0] = head.subarray(excess)
        this.retainedBytes -= excess
      }
    }
  }

  /** @inheritdoc */
  readFrom(fromByte: number): SubprocessOutputRead {
    if (!Number.isSafeInteger(fromByte) || fromByte < 0) {
      throw new Error('subprocess output offset must be a non-negative safe integer')
    }
    const retained = Buffer.concat(this.chunks, this.retainedBytes)
    const firstRetained = this.totalBytes - this.retainedBytes
    const lossy = fromByte < firstRetained
    const start = lossy ? 0 : Math.min(retained.length, Math.max(0, fromByte - firstRetained))
    return {
      text: retained.subarray(start).toString('utf8'),
      nextOffset: this.totalBytes,
      lossy,
      ...(lossy && this.maxSpillBytes !== undefined && this.totalBytes <= this.maxSpillBytes
        ? { spillPath: this.spillPath }
        : {}),
    }
  }
}
