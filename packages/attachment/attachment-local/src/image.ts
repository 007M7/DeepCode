/** Raster decoding used before bytes enter durable storage. */

import sharp from 'sharp'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

/** Decoded metadata from a supported image. */
export interface DetectedImage {
  mediaType: ImageMediaType
  width: number
  height: number
}

const MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

/**
 * Decode a supported raster and return its intrinsic metadata.
 * @param data - complete encoded image bytes.
 * @param maxPixels - optional write-time decoded-pixel limit; reads omit it.
 * @returns verified format and dimensions.
 */
export async function detectImage(data: Uint8Array, maxPixels?: number): Promise<DetectedImage> {
  try {
    const image = sharp(data, { failOn: 'error', limitInputPixels: false })
    const metadata = await image.metadata()
    const mediaType = MEDIA_TYPES[metadata.format as string]
    if (mediaType === undefined) {
      throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE')
    }
    const { width, height } = metadata
    if (maxPixels !== undefined && width * height > maxPixels) {
      throw new AttachmentError('Image exceeds the configured decoded-pixel limit.', 'IMAGE_TOO_MANY_PIXELS')
    }
    await image.raw().toBuffer()
    return { mediaType, width, height }
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
  }
}
