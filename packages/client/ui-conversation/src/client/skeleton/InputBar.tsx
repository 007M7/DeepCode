// Shared empty-state and resident composer. Running retains the draft, locks
// the textarea, and exposes only Stop. Bottom controls are local visual state.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react'
import clsx from 'clsx'
import { IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComposerAttachment } from '../contract/slots.ts'
import { ImageLightbox } from './ImageLightbox.tsx'
import css from './InputBar.module.css'

/** Prompt failure surface (mirrors the session snapshot's promptError shape). */
export interface InputBarError {
  op: 'workspace' | 'session' | 'send' | 'stop'
  message: string
}

export interface InputBarProps {
  draft: string
  attachments?: readonly ComposerAttachment[]
  running: boolean
  disabled: boolean
  error: InputBarError | null
  /** Observable async phase for browser fixtures and assistive technology. */
  status?: string
  /** Hero = empty-state centered card; composer = resident bottom bar. */
  variant: 'hero' | 'composer'
  placeholder?: string
  accessory?: ReactNode
  onDraftChange: (text: string) => void
  onAddImages?: (files: readonly File[]) => string | null
  onRemoveAttachment?: (id: string) => void
  onSend: (mode: 'queue' | 'steer') => void
  onStop: () => void
  onAdd?: () => void
  addLabel?: string
}

interface SelectOption {
  id: string
  label: string
}

const PLAN_OPTIONS: readonly SelectOption[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'agent', label: 'Agent' },
]

const READONLY_OPTIONS: readonly SelectOption[] = [
  { id: 'readonly', label: 'Read-only' },
  { id: 'readwrite', label: 'Read-write' },
]

const MODEL_OPTIONS: readonly SelectOption[] = [
  { id: 'v4-pro-high', label: 'DeepSeek-V4-Pro High' },
  { id: 'v4-pro', label: 'DeepSeek-V4-Pro' },
]

export function InputBar({
  draft, attachments = [], running, disabled, error, status, variant, placeholder, accessory,
  onDraftChange, onAddImages = () => null, onRemoveAttachment = () => {}, onSend, onStop,
  onAdd, addLabel = 'Add attachment',
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

  // Placeholder chrome: selection is local until plan/mode/model seams land.
  const [planId, setPlanId] = useState('plan')
  const [readonlyId, setReadonlyId] = useState('readonly')
  const [modelId, setModelId] = useState('v4-pro-high')

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
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (files.length === 0) return
    if (event.clipboardData.getData('text/plain') === '') event.preventDefault()
    setDropError(onAddImages(files))
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
    if (dropped.length === 0) return
    setDropError(onAddImages(dropped))
  }

  const closePreview = useCallback(() => { setPreview(null) }, [])

  // Button presses steal focus from the textarea; suppress at mousedown so typing continues seamlessly.
  const keepFocus = (e: MouseEvent<HTMLButtonElement>): void => {
    e.preventDefault()
    inputRef.current?.focus()
  }

  const primaryLabel = running ? 'Stop generating' : 'Send message'
  const onPrimary = (): void => {
    if (running) {
      onStop()
      return
    }
    /* v8 ignore next -- defensive: the primary button is disabled while empty||disabled, so a click cannot reach the false arm. */
    if (!empty && !disabled) onSend('queue')
  }

  const renderSelect = (
    aria: string,
    value: string,
    options: readonly SelectOption[],
    onPick: (id: string) => void,
  ): ReactNode => (
    <select
      className={css.select}
      aria-label={aria}
      value={value}
      disabled={locked}
      onChange={(e: ChangeEvent<HTMLSelectElement>) => { onPick(e.target.value) }}
    >
      {options.map(opt => (
        <option key={opt.id} value={opt.id}>{opt.label}</option>
      ))}
    </select>
  )

  return (
    <div className={clsx(css.root, variant === 'hero' && css.hero)}>
      {status !== undefined && <div className={css.status} role="status">{status}</div>}
      {error !== null && <div className={css.error} role="alert">{error.message}</div>}
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
                  onClick={() => {
                    setDropError(null)
                    onRemoveAttachment(attachment.id)
                  }}
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
            placeholder={placeholder ?? (disabled ? 'Session unavailable' : running ? 'Generating a response…' : 'Message the agent')}
            rows={2}
            onChange={(e) => {
              setDropError(null)
              onDraftChange(e.target.value)
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={onCompositionEnd}
          />
          <div aria-hidden className={css.mirror}>{`${draft}\n`}</div>
        </div>
        <div className={css.row}>
          <div className={css.tools}>
            <button
              type="button"
              className={css.add}
              aria-label={addLabel}
              title={addLabel}
              disabled={locked}
              onMouseDown={keepFocus}
              onClick={onAdd}
            >
              <IconPlusOutline16 size={14} />
            </button>
            <div className={css.modes}>
              {renderSelect('Plan mode', planId, PLAN_OPTIONS, setPlanId)}
              {renderSelect('Access mode', readonlyId, READONLY_OPTIONS, setReadonlyId)}
            </div>
          </div>
          <div className={css.trailing}>
            {renderSelect('Model', modelId, MODEL_OPTIONS, setModelId)}
            <button
              type="button"
              className={clsx(css.primary, running && css.stopping)}
              aria-label={primaryLabel}
              title={primaryLabel}
              disabled={!running && (empty || disabled)}
              onMouseDown={keepFocus}
              onClick={onPrimary}
            >
              {running ? (
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                  <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                  <path d="M8 13V3.8M8 3.8L3.8 8M8 3.8L12.2 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
      {preview !== null && <ImageLightbox src={preview.previewUrl} alt={preview.file.name || '原图'} onClose={closePreview} />}
    </div>
  )
}
