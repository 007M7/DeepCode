import { describe, expect, it } from 'vitest'
import { detectImage } from '../src/image.ts'

function bytes(text: string): number[] {
  return [...Buffer.from(text, 'ascii')]
}

function webp(chunk: string, mutate: (data: Uint8Array) => void): Uint8Array {
  const data = new Uint8Array(30)
  data.set(bytes('RIFF'), 0)
  data.set([22, 0, 0, 0], 4)
  data.set(bytes('WEBP'), 8)
  data.set(bytes(chunk), 12)
  mutate(data)
  return data
}

describe('raster header detection', () => {
  it('detects PNG dimensions', () => {
    const data = Uint8Array.from(Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ))
    expect(detectImage(data)).toEqual({ mediaType: 'image/png', width: 1, height: 1 })
  })

  it('detects both GIF revisions and rejects zero dimensions', () => {
    expect(detectImage(Uint8Array.from([...bytes('GIF87a'), 3, 0, 2, 0])))
      .toEqual({ mediaType: 'image/gif', width: 3, height: 2 })
    expect(detectImage(Uint8Array.from([...bytes('GIF89a'), 4, 0, 5, 0])))
      .toEqual({ mediaType: 'image/gif', width: 4, height: 5 })
    expect(() => detectImage(Uint8Array.from([...bytes('GIF89a'), 0, 0, 1, 0])))
      .toThrow(/positive/)
    expect(() => detectImage(Uint8Array.from([...bytes('GIF89a'), 1, 0, 0, 0])))
      .toThrow(/positive/)
  })

  it('walks JPEG marker forms and reports malformed dimensions', () => {
    const sof = [0xff, 0xc0, 0, 7, 8, 0, 2, 0, 3]
    expect(detectImage(Uint8Array.from([0xff, 0xd8, ...sof])))
      .toEqual({ mediaType: 'image/jpeg', width: 3, height: 2 })
    expect(detectImage(Uint8Array.from([
      0xff, 0xd8,
      0xe0, 0, 2,
      0x01,
      0xff, ...sof,
    ]))).toEqual({ mediaType: 'image/jpeg', width: 3, height: 2 })

    expect(() => detectImage(Uint8Array.from([0xff, 0xd8, 0xd9, 0, 0, 0])))
      .toThrow(/missing/)
    expect(() => detectImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xff, 0xff, 0xff])))
      .toThrow(/missing/)
    expect(() => detectImage(Uint8Array.from([0xff, 0xd8, 0xe0, 0, 1, 0])))
      .toThrow(/truncated/)
    expect(() => detectImage(Uint8Array.from([0xff, 0xd8, 0xe0, 0, 9, 0])))
      .toThrow(/truncated/)
    expect(() => detectImage(Uint8Array.from([0xff, 0xd8, 0xc0, 0, 6, 0, 0, 0, 0])))
      .toThrow(/dimensions are truncated/)
  })

  it('detects each WebP header and rejects truncated or unknown chunks', () => {
    expect(detectImage(webp('VP8X', (data) => {
      data.set([2, 0, 0], 24)
      data.set([3, 0, 0], 27)
    }))).toEqual({ mediaType: 'image/webp', width: 3, height: 4 })

    expect(detectImage(webp('VP8L', (data) => {
      data[20] = 0x2f
      data.set([2, 0, 1, 0], 21)
    }))).toEqual({ mediaType: 'image/webp', width: 3, height: 5 })

    expect(detectImage(webp('VP8 ', (data) => {
      data.set([0x9d, 0x01, 0x2a], 23)
      data.set([6, 0, 7, 0], 26)
    }))).toEqual({ mediaType: 'image/webp', width: 6, height: 7 })

    const truncated = webp('VP8X', () => {})
    truncated[4] = 23
    expect(() => detectImage(truncated)).toThrow(/truncated/)
    expect(() => detectImage(webp('NOPE', () => {}))).toThrow(/dimensions are missing/)
    expect(() => detectImage(webp('VP8L', () => {}))).toThrow(/dimensions are missing/)
    expect(() => detectImage(webp('VP8 ', () => {}))).toThrow(/dimensions are missing/)
  })

  it('rejects unrecognized bytes and near-miss signatures', () => {
    expect(() => detectImage(new Uint8Array(0))).toThrow(/Unsupported/)
    expect(() => detectImage(Uint8Array.from([...bytes('GIFxxa'), 1, 0, 1, 0])))
      .toThrow(/Unsupported/)
    const nearWebp = webp('VP8X', () => {})
    nearWebp[8] = 0
    expect(() => detectImage(nearWebp)).toThrow(/Unsupported/)
  })
})
