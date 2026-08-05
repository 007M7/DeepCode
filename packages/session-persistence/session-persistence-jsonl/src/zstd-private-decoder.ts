/**
 * Node-private synchronous Zstandard frame decoder optimization.
 * @module dsh-session-persistence-jsonl/zstd-private-decoder
 */

import { constants as bufferConstants } from 'node:buffer'
import { createZstdDecompress } from 'node:zlib'
import type { ZstdFrameDecoder, ZstdFrameRange } from './zstd.ts'

const DECODE_CHUNK_SIZE = 1024 * 1024

interface NodeZstdPrivateHandle {
  writeSync(
    flushFlag: number,
    input: Buffer,
    inputOffset: number,
    inputLength: number,
    output: Buffer,
    outputOffset: number,
    outputLength: number,
  ): void
}

type NodeZstdPrivateWriteState = Uint32Array & { 0: number; 1: number }

interface NodeZstdPrivateState {
  _handle: NodeZstdPrivateHandle | null
  _writeState: NodeZstdPrivateWriteState
  _defaultFlushFlag: number
}

type NodeZstdPrivateStream = ReturnType<typeof createZstdDecompress> & NodeZstdPrivateState

/** Return the stream with its observed private Node contract, or reject that optimization. */
function privateZstdStream(stream: ReturnType<typeof createZstdDecompress>): NodeZstdPrivateStream | undefined {
  const candidate = stream as unknown as Partial<NodeZstdPrivateState>
  const handle = candidate._handle
  if (
    typeof handle !== 'object' || handle === null
    || typeof (handle as { writeSync?: unknown }).writeSync !== 'function'
    || !(candidate._writeState instanceof Uint32Array)
    || candidate._writeState.length < 2
    || typeof candidate._defaultFlushFlag !== 'number'
  ) return undefined
  return stream as NodeZstdPrivateStream
}

/**
 * Synchronous multi-frame decoder backed by one Node Zstd stream handle. Node
 * exposes synchronous decoding only as a one-shot API, so this adapter uses
 * the stream's private handle contract to reuse its native context and output
 * chunks across frames.
 */
export class NodePrivateZstdFrameDecoder implements ZstdFrameDecoder {
  private readonly output = Buffer.allocUnsafe(DECODE_CHUNK_SIZE)
  private decoderError?: Error
  private started = false
  private closed = false

  private constructor(private readonly stream: NodeZstdPrivateStream) {
    this.stream.on('error', (error: Error) => {
      this.decoderError ??= error
    })
  }

  /**
   * Create the optimized decoder when this Node release exposes the expected
   * private stream shape.
   * @returns a shared decoder, or `undefined` when callers must use the public fallback.
   */
  static create(): NodePrivateZstdFrameDecoder | undefined {
    const stream = createZstdDecompress({ chunkSize: DECODE_CHUNK_SIZE })
    const privateStream = privateZstdStream(stream)
    if (privateStream !== undefined) return new NodePrivateZstdFrameDecoder(privateStream)
    stream.close()
    return undefined
  }

  /** @inheritdoc */
  public *decode(source: Buffer, frames: readonly ZstdFrameRange[]): Generator<Buffer, void, void> {
    if (this.started) throw new Error('Zstandard frame decoder was already started')
    if (this.closed) throw new Error('cannot start a closed Zstandard frame decoder')
    this.started = true
    try {
      for (const frame of frames) {
        try {
          yield this.decodeFrame(source.subarray(frame.start, frame.end))
        } catch (error) {
          throw new Error(`corrupt Zstandard session log: frame at byte ${frame.start} failed validation`, {
            cause: error,
          })
        }
      }
    } finally {
      this.close()
    }
  }

  /** Decode one frame; its returned scratch view remains valid until the next call. */
  private decodeFrame(input: Buffer): Buffer {
    const handle = this.stream._handle
    if (this.closed || handle === null) throw new Error('cannot decode with a closed Zstandard frame decoder')

    let inputOffset = 0
    let inputRemaining = input.length
    let outputBytes = 0
    const fullChunks: Buffer[] = []
    for (;;) {
      handle.writeSync(
        this.stream._defaultFlushFlag,
        input,
        inputOffset,
        inputRemaining,
        this.output,
        0,
        DECODE_CHUNK_SIZE,
      )
      if (this.decoderError !== undefined) throw this.decoderError

      const outputAfter = this.stream._writeState[0]
      const inputAfter = this.stream._writeState[1]
      const consumed = inputRemaining - inputAfter
      const produced = DECODE_CHUNK_SIZE - outputAfter
      if (produced > 0) {
        outputBytes += produced
        if (outputBytes > bufferConstants.MAX_LENGTH) {
          throw new Error(`Zstandard frame output exceeds ${bufferConstants.MAX_LENGTH} bytes`)
        }
      }

      if (outputAfter !== 0) {
        if (inputAfter !== 0) throw new Error('Zstandard frame decoder left trailing input')
        const finalChunk = this.output.subarray(0, produced)
        if (fullChunks.length === 0) return finalChunk
        if (produced > 0) fullChunks.push(Buffer.from(finalChunk))
        const [onlyChunk] = fullChunks
        return fullChunks.length === 1 && onlyChunk !== undefined
          ? onlyChunk
          : Buffer.concat(fullChunks, outputBytes)
      }
      fullChunks.push(Buffer.from(this.output))
      inputOffset += consumed
      inputRemaining = inputAfter
    }
  }

  /** @inheritdoc */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.stream.close()
  }
}
