/** Minimal raster header validation used before bytes enter durable storage. */

import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

/** Decoded metadata from a supported image header. */
export interface DetectedImage {
  mediaType: ImageMediaType
  width: number
  height: number
}

function ascii(data: Uint8Array, start: number, value: string): boolean {
  /* v8 ignore next -- Every call site establishes the fixed header span before comparing it. */
  if (data.length < start + value.length) return false
  for (let i = 0; i < value.length; i++) if (data[start + i] !== value.charCodeAt(i)) return false
  return true
}

function u16be(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(offset)
}

function u16le(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(offset, true)
}

function u24le(data: Uint8Array, offset: number): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16)
}

function u32be(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset)
}

function u32le(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true)
}

function dimensions(width: number, height: number, mediaType: ImageMediaType): DetectedImage {
  if (width < 1 || height < 1) throw new AttachmentError('Image dimensions must be positive.', 'INVALID_IMAGE')
  return { mediaType, width, height }
}

function jpeg(data: Uint8Array): DetectedImage | null {
  if (data[0] !== 0xff || data[1] !== 0xd8) return null
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  let offset = 2
  while (offset + 3 < data.length) {
    while (data[offset] === 0xff) offset++
    const marker = data[offset]
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset++
      continue
    }
    const length = u16be(data, offset + 1)
    if (length < 2 || offset + 1 + length > data.length) throw new AttachmentError('JPEG data is truncated.', 'INVALID_IMAGE')
    if (sof.has(marker)) {
      if (length < 7) throw new AttachmentError('JPEG dimensions are truncated.', 'INVALID_IMAGE')
      return dimensions(u16be(data, offset + 6), u16be(data, offset + 4), 'image/jpeg')
    }
    offset += length + 1
  }
  throw new AttachmentError('JPEG dimensions are missing.', 'INVALID_IMAGE')
}

/**
 * Detect a supported raster type and intrinsic dimensions from encoded bytes.
 * @param data - complete encoded image bytes.
 * @returns verified format and dimensions.
 */
export function detectImage(data: Uint8Array): DetectedImage {
  if (data.length >= 24
    && data[0] === 0x89 && ascii(data, 1, 'PNG\r\n\u001a\n') && ascii(data, 12, 'IHDR')) {
    return dimensions(u32be(data, 16), u32be(data, 20), 'image/png')
  }
  if (data.length >= 10 && (ascii(data, 0, 'GIF87a') || ascii(data, 0, 'GIF89a'))) {
    return dimensions(u16le(data, 6), u16le(data, 8), 'image/gif')
  }
  const detectedJpeg = jpeg(data)
  if (detectedJpeg !== null) return detectedJpeg
  if (data.length >= 30 && ascii(data, 0, 'RIFF') && ascii(data, 8, 'WEBP')) {
    const declaredLength = u32le(data, 4) + 8
    if (declaredLength > data.length) throw new AttachmentError('WebP data is truncated.', 'INVALID_IMAGE')
    if (ascii(data, 12, 'VP8X')) return dimensions(u24le(data, 24) + 1, u24le(data, 27) + 1, 'image/webp')
    if (ascii(data, 12, 'VP8L') && data[20] === 0x2f) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
      const b0 = view.getUint8(21)
      const b1 = view.getUint8(22)
      const b2 = view.getUint8(23)
      const b3 = view.getUint8(24)
      return dimensions(1 + b0 + ((b1 & 0x3f) << 8), 1 + (b1 >> 6) + (b2 << 2) + ((b3 & 0x0f) << 10), 'image/webp')
    }
    if (ascii(data, 12, 'VP8 ') && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
      return dimensions(u16le(data, 26) & 0x3fff, u16le(data, 28) & 0x3fff, 'image/webp')
    }
    throw new AttachmentError('WebP dimensions are missing.', 'INVALID_IMAGE')
  }
  throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE')
}
