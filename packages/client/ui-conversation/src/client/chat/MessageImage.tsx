import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { ImageLightbox } from '../skeleton/ImageLightbox.tsx'
import css from './MessageImage.module.css'

/** Loads a session-authorized durable image URL. */
export type ImageLoader = (attachment: ImageAttachmentRef) => Promise<string>

/** Compact history renderer with retryable loading and double-click original preview. */
export function MessageImage({ attachment, load, t }: {
  attachment: ImageAttachmentRef
  load: ImageLoader
  t: ChatViewSlotProps['t']
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

  const label = attachment.name ?? t('image.label')
  if (error) return <button type="button" className={css.error} onClick={request}>{t('image.loadFailed')}</button>
  return (
    <>
      <button
        type="button"
        className={css.frame}
        style={size}
        title={t('image.openOriginal')}
        aria-label={t('image.openOriginalLabel', { label })}
        onDoubleClick={() => { if (src !== null) setOpen(true) }}
      >
        {src === null ? <span className={css.loading}>{t('image.loading')}</span> : <img src={src} alt={label} />}
      </button>
      {open && src !== null && <ImageLightbox src={src} alt={label} onClose={close} t={t} />}
    </>
  )
}

/** Wrapping image group shared by user and assistant history. */
export function ImageGallery({ images, load, align, t }: {
  images: readonly { attachment: ImageAttachmentRef }[]
  load: ImageLoader
  align: 'start' | 'end'
  t: ChatViewSlotProps['t']
}) {
  if (images.length === 0) return null
  return (
    <div className={css.gallery} data-align={align}>
      {images.map((image, index) => (
        <MessageImage key={`${image.attachment.attachmentId}:${index}`} {...image} load={load} t={t} />
      ))}
    </div>
  )
}
