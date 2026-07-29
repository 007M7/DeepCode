import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import LocalAttachmentStore, {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGE_PIXELS,
} from '../src/index.ts'

describe('local attachment service', () => {
  it('resolves every omitted admission limit explicitly', () => {
    const service = new LocalAttachmentStore(new Context(), {})
    expect(service.imageLimits).toEqual({
      maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
      maxImagePixels: DEFAULT_MAX_IMAGE_PIXELS,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    })
  })

  it('saves and reads through the service boundary', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-attachment-service-'))
    try {
      const service = new LocalAttachmentStore(new Context(), { dshHome })
      const data = Uint8Array.from(Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ))
      const ref = await service.saveImage({ data, mediaType: 'image/png' })
      await expect(service.readImage(ref)).resolves.toEqual({ ref, data })
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })
})
