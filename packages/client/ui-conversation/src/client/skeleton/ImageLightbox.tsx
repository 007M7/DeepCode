import { useEffect, useRef } from 'react'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './ImageLightbox.module.css'

/** Document-level original-image preview opened by an explicit double-click. */
export function ImageLightbox({ src, alt, onClose, t }: {
  src: string
  alt: string
  onClose: () => void
  t: ChatViewSlotProps['t']
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      restoreRef.current?.focus()
    }
  }, [onClose])

  return (
    <div
      className={css.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={t('image.preview')}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <img className={css.image} src={src} alt={alt} />
      <button ref={closeRef} type="button" className={css.close} aria-label={t('image.closePreview')} onClick={onClose}>×</button>
    </div>
  )
}
