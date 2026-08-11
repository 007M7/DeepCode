import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { ImageLightbox } from './ImageLightbox.tsx'
import type { ImageLightboxLabels } from './ImageLightbox.tsx'
import css from './MessageImage.module.css'

/** Loads a session-authorized durable image URL. */
export type ImageLoader = (attachment: ImageAttachmentRef) => Promise<string>

/** Message-image strings the owner resolves from its own locale namespace. */
export interface MessageImageLabels {
  /** Fallback display name for an unnamed image. */
  image: string
  /** Thumbnail tooltip inviting the original-image preview. */
  open: string
  /** Accessible thumbnail label; receives the image's display name. */
  openNamed: (label: string) => string
  /** Loading placeholder shown until bytes resolve. */
  loading: string
  /** Retry-control label shown when the load fails. */
  loadFailed: string
  /** Lightbox strings forwarded to the opened preview. */
  lightbox: ImageLightboxLabels
}

/**
 * Compact history renderer with retryable loading and click-to-open original
 * preview.
 *
 * @param props.attachment - the durable image reference to load and bound.
 * @param props.load - session-authorized URL loader.
 * @param props.labels - resolved strings (tooltip, loading, retry, lightbox).
 * @returns the bounded thumbnail button, or the retry control on failure.
 */
export function MessageImage({ attachment, load, labels }: {
  attachment: ImageAttachmentRef
  load: ImageLoader
  labels: MessageImageLabels
}) {
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => { setOpen(false) }, [])
  const size = useMemo(() => {
    const scale = Math.min(1, 240 / attachment.width, 240 / attachment.height)
    return { width: Math.max(1, Math.round(attachment.width * scale)), height: Math.max(1, Math.round(attachment.height * scale)) }
  }, [attachment.height, attachment.width])

  const request = useCallback(() => {
    setError(false)
    setSrc(null)
    void load(attachment).then(setSrc).catch(() => { setError(true) })
  }, [attachment, load])

  useEffect(() => {
    let live = true
    setError(false)
    void load(attachment).then((url) => { if (live) setSrc(url) }).catch(() => { if (live) setError(true) })
    return () => { live = false }
  }, [attachment, load])

  const label = attachment.name ?? labels.image
  if (error) return <button type="button" className={css.error} onClick={request}>{labels.loadFailed}</button>
  return (
    <>
      <button
        type="button"
        className={css.frame}
        style={size}
        title={labels.open}
        aria-label={labels.openNamed(label)}
        onClick={() => { if (src !== null) setOpen(true) }}
      >
        {src === null ? <span className={css.loading}>{labels.loading}</span> : <img src={src} alt={label} />}
      </button>
      {open && src !== null && <ImageLightbox src={src} alt={label} labels={labels.lightbox} onClose={close} />}
    </>
  )
}

/** Wrapping image group shared by user and assistant history. */
export function ImageGallery({ images, load, align, labels }: {
  images: readonly { attachment: ImageAttachmentRef }[]
  load: ImageLoader
  align: 'start' | 'end'
  labels: MessageImageLabels
}) {
  if (images.length === 0) return null
  return (
    <div className={css.gallery} data-align={align}>
      {images.map((image, index) => (
        <MessageImage key={`${image.attachment.attachmentId}:${index}`} {...image} load={load} labels={labels} />
      ))}
    </div>
  )
}
