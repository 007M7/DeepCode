// InputBar: the one composer input (figma Input_Bottom). The same component
// serves the empty state (variant='hero': centered launch card) and the
// resident composer (variant='composer') — the empty→content transition is a
// position move of this component, never a swap (layout ruling). Running
// LOCKS the input: textarea disabled with the draft visible, stop is the only
// action; the turn ending re-enables and refocuses.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, DragEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react'
import clsx from 'clsx'
import type { ComposerAttachment } from '../contract/slots.ts'
import { ImageLightbox } from './ImageLightbox.tsx'
import css from './InputBar.module.css'

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function supportedImages(files: Iterable<File>): File[] {
  return [...files].filter(file => IMAGE_MEDIA_TYPES.has(file.type))
}

/** Prompt failure surface (mirrors the session snapshot's promptError shape). */
export interface InputBarError {
  op: 'send' | 'stop'
  message: string
}

export interface InputBarProps {
  draft: string
  attachments?: readonly ComposerAttachment[]
  running: boolean
  disabled: boolean
  error: InputBarError | null
  /** Hero = empty-state centered card; composer = resident bottom bar. */
  variant: 'hero' | 'composer'
  placeholder?: string
  /** Optional leading accessory row content (the empty state mounts its cwd picker here). */
  accessory?: ReactNode
  onDraftChange: (text: string) => void
  onAddImages?: (files: readonly File[]) => void
  onRemoveAttachment?: (id: string) => void
  onSend: (mode: 'queue' | 'steer') => void
  onStop: () => void
}

export function InputBar({
  draft, attachments = [], running, disabled, error, variant, placeholder, accessory,
  onDraftChange, onAddImages = () => {}, onRemoveAttachment = () => {}, onSend, onStop,
}: InputBarProps) {
  const empty = draft.trim() === '' && attachments.length === 0
  const [preview, setPreview] = useState<ComposerAttachment | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [dropError, setDropError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const dragDepthRef = useRef(0)
  // IME guard: composition Enter picks a candidate, it must not send. The ref outlives renders;
  // clearing is deferred one tick because Safari delivers the closing keydown AFTER compositionend.
  const composingRef = useRef(false)
  const onCompositionStart = (): void => {
    composingRef.current = true
  }
  const onCompositionEnd = (): void => {
    setTimeout(() => {
      composingRef.current = false
    }, 10)
  }

  // Locked while running: the browser drops keystrokes AND focus on a disabled
  // textarea — no sending mid-turn, stop or wait.
  const locked = disabled || running

  // Unlock (mount / session switch / turn end) returns focus to the box.
  useEffect(() => {
    if (!locked) inputRef.current?.focus()
  }, [locked])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Enter') return
    if (composingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
    if (e.shiftKey) return // native newline
    if (e.ctrlKey || e.metaKey) {
      // execCommand keeps the browser undo stack intact, unlike a setState splice.
      e.preventDefault()
      document.execCommand('insertText', false, '\n')
      return
    }
    e.preventDefault()
    if (e.repeat) return // held-down Enter must not machine-gun sends
    if (!empty && !locked) onSend('queue')
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...event.clipboardData.items]
      .filter(item => item.kind === 'file' && IMAGE_MEDIA_TYPES.has(item.type))
      .map(item => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (files.length === 0) return
    event.preventDefault()
    setDropError(null)
    onAddImages(files)
  }

  const onDragEnter = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    if (locked) return
    dragDepthRef.current += 1
    setDropError(null)
    setDragActive(true)
  }

  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = locked ? 'none' : 'copy'
  }

  const onDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes('Files') || locked) return
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragActive(false)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    dragDepthRef.current = 0
    setDragActive(false)
    if (locked) return
    const dropped = [...event.dataTransfer.files]
    const images = supportedImages(dropped)
    if (images.length === 0) {
      setDropError('暂仅支持 PNG、JPEG、WebP 和 GIF 图片')
      return
    }
    setDropError(images.length === dropped.length ? null : '已忽略不受支持的非图片文件')
    onAddImages(images)
  }

  const closePreview = useCallback(() => { setPreview(null) }, [])

  // Button presses steal focus from the textarea; suppress at mousedown so typing continues seamlessly.
  const keepFocus = (e: MouseEvent<HTMLButtonElement>): void => {
    e.preventDefault()
    inputRef.current?.focus()
  }

  const primaryLabel = running ? '停止' : '发送'
  const onPrimary = (): void => {
    if (running) {
      onStop()
      return
    }
    /* v8 ignore next -- defensive: the primary button is disabled while empty||disabled, so a click cannot reach the false arm. */
    if (!empty && !disabled) onSend('queue')
  }

  return (
    <div className={clsx(css.root, variant === 'hero' && css.hero)}>
      {error !== null && (
        <div className={css.error}>
          {error.op === 'stop' ? '停止失败' : '发送失败'}：{error.message}
        </div>
      )}
      {dropError !== null && <div className={css.error}>{dropError}</div>}
      <div
        className={clsx(css.card, dragActive && css.dragActive)}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {dragActive && <div className={css.dropHint} role="status">松开以添加图片</div>}
        {accessory !== undefined && <div className={css.accessory}>{accessory}</div>}
        {attachments.length > 0 && (
          <div className={css.attachments} aria-label="待发送图片">
            {attachments.map(attachment => (
              <div key={attachment.id} className={css.attachment}>
                <button
                  type="button"
                  className={css.thumbnail}
                  title="双击查看原图"
                  onDoubleClick={() => { setPreview(attachment) }}
                >
                  <img src={attachment.previewUrl} alt={attachment.file.name || '待发送图片'} />
                </button>
                <button
                  type="button"
                  className={css.remove}
                  aria-label={`移除图片 ${attachment.file.name || ''}`}
                  onClick={() => { onRemoveAttachment(attachment.id) }}
                >×</button>
              </div>
            ))}
          </div>
        )}
        {/* Mirror-div auto-grow: the hidden mirror renders draft+'\n' and stretches the wrapper
            (min/max capped in CSS); the absolutely-positioned textarea rides its height. Counting
            rows by '\n' cannot see soft wraps. */}
        <div className={css.grow}>
          <textarea
            ref={inputRef}
            className={css.input}
            value={draft}
            disabled={locked}
            placeholder={placeholder ?? (disabled ? '会话不可用' : running ? '回复生成中，可停止后再输入' : '输入消息，Enter 发送，Shift+Enter 换行')}
            rows={2}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={onCompositionEnd}
          />
          <div aria-hidden className={css.mirror}>{`${draft}\n`}</div>
        </div>
        <div className={css.row}>
          <button
            type="button"
            className={clsx(css.primary, running && css.stopping)}
            aria-label={primaryLabel}
            title={running ? '停止本轮' : '发送（Enter）'}
            disabled={!running && (empty || disabled)}
            onMouseDown={keepFocus}
            onClick={onPrimary}
          >
            {running ? (
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                <path d="M8 13V3.8M8 3.8L3.8 8M8 3.8L12.2 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            )}
          </button>
        </div>
      </div>
      {preview !== null && <ImageLightbox src={preview.previewUrl} alt={preview.file.name || '原图'} onClose={closePreview} />}
    </div>
  )
}
