/** The default composer body: the 'conversation.composer.bar' slot entry
 * (decision 20). Machine state arrives through the standard provide channel
 * (useInput + inputActions); the keyboard/DOM command face and stop arrive
 * through this entry's own inject, whose hooks compartment binds
 * useNotices/useLexicon; layout-phase inputs (variant, placeholder,
 * region-slot content) ride the owner props. Session facts
 * (running/removed/promptError) are self-selected via useSession. */

import { useEffect, useRef } from 'react'
import type { ChangeEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react'
import clsx from 'clsx'
import { IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: the `plan` projection key merge (the TodoDock posture — the
// composer reads a host-computed value; the domain owns the key).
import type {} from '@deepseek-ai/dsh-plan-mode/client'
// Type-only: the `goal` projection key merge (hint disambiguation).
import type {} from '@deepseek-ai/dsh-goal/client'
import type { ComposerBarProps } from '../contract/slots.ts'
import { deriveDecorations } from '../input/decorations.ts'
import { PermissionSelect } from './PermissionSelect.tsx'
import css from './InputBar.module.css'

/** Prompt failure surface (derived from promptError). */
export interface InputBarError {
  op: 'send' | 'stop'
  message: string
}

export type InputBarProps = ComposerBarProps

export function InputBar({
  useSession, useInput, inputActions, keyboard, stop, command, translateHint, renderSlot, useNotices, useLexicon, useProjection,
  variant, placeholder, accessory, overlay, leftItems, rightItems, footer, onAdd, addLabel = 'Add attachment',
}: InputBarProps) {
  const input = useInput(s => s)
  const notice = useNotices(s => s)
  const lexicon = useLexicon(s => s)
  const promptError = useSession(s => s.promptError)
  const running = useSession(s => s.running)
  const disabled = useSession(s => s.removed)
  // Plan mode swaps the textarea placeholder (the projection is the folded
  // host value; owner-prop placeholders — hero, session-unavailable — win).
  const planActive = useProjection('plan', plan => plan !== undefined && (plan.pending ? !plan.active : plan.active))
  // Absent (undefined: no frame yet) and cleared (null) both mean no goal.
  const hasGoal = useProjection('goal', goal => goal != null)
  // Prompt failures are ordinary failures (no create/attach transaction
  // exists anymore): the strip renders promptError, the draft stays in the
  // machine, and the user resubmits.
  const error: InputBarError | null = promptError === null
    ? null
    : { op: promptError.op, message: `${promptError.error.message} (${promptError.error.code})` }
  const draft = input.draft
  const empty = draft.trim() === ''
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
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

  // The Access seat's data: the host-computed permissions projection
  // (undefined = capability absent → the chip renders nothing).
  const permissions = useProjection('permissions')

  // Queue cut 1: running input stays free; locked = session disabled only.
  // The transient machine locks (adjudicating pending / submitting) render
  // read-only — the draft stays visible and focused, keystrokes drop.
  const locked = disabled
  const machineBusy = input.phase === 'adjudicating' || input.phase === 'submitting'

  // Unlock (mount / session switch) returns focus to the box.
  useEffect(() => {
    if (!locked) inputRef.current?.focus()
  }, [locked])

  // Active conversation scrollport: chain the wheel. While the textarea (capped
  // at 14 lines with overflow-y:auto) can still move in this direction, keep
  // the native scroll; only at its own edge forward delta to the host so a
  // short draft never traps the gesture and a long draft stays scrollable.
  // Hero mounts have no host and keep native wheel scrolling.
  useEffect(() => {
    const el = inputRef.current
    if (el === null) return
    const onWheel = (e: WheelEvent): void => {
      const host = el.closest('[data-conversation-scroll]')
      if (!(host instanceof HTMLElement) || e.deltaY === 0) return
      const atTop = el.scrollTop <= 0
      const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 1
      if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atEnd)) return
      e.preventDefault()
      host.scrollTop += e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { el.removeEventListener('wheel', onWheel) }
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Shift+Enter is the native newline UNCONDITIONALLY — decided before the
    // IME guard so a composition-closing Shift+Enter still breaks the line.
    if (e.key === 'Enter' && e.shiftKey) return
    // keyCode 229 is the legacy IME-composition signal engines emit without isComposing.
    // oxlint-disable-next-line typescript/no-deprecated
    const composing = composingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (keyboard.arbitrate(e.key === 'ArrowUp' ? 'up' : 'down', composing) === 'consumed') e.preventDefault()
      return
    }
    if (e.key === 'Escape') {
      // Escape layering: an open overlay closes; claimed without an overlay
      // does NOT release (backspacing the token is the only exit gesture).
      keyboard.dismissPopup()
      if (keyboard.arbitrate('escape', composing) === 'consumed') e.preventDefault()
      return
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) {
      // The machine owns the undo/redo log (chip transactions have semantics
      // the browser stack cannot represent); never let the native stack run.
      e.preventDefault()
      if (machineBusy || locked) return
      const redo = e.key === 'y' || e.shiftKey
      if (redo) keyboard.redo()
      else keyboard.undo()
      return
    }
    if (e.key === ' ') {
      if (composing) return
      if (keyboard.space()) e.preventDefault() // claim token already carries the trailing separator
      return
    }
    if (e.key !== 'Enter') return
    if (composing) return
    // Menu-open Enter picks the highlight through arbitration; a no-highlight
    // menu passes down to the machine's own adjudication.
    const arbitrated = keyboard.arbitrate('enter', composing)
    if (arbitrated !== 'pass') {
      e.preventDefault()
      return
    }
    if (e.ctrlKey || e.metaKey) {
      // Newline as a machine transaction (the machine owns undo history; an
      // execCommand write would fork a second, browser-owned history).
      e.preventDefault()
      if (!machineBusy && !locked) {
        const el = e.currentTarget
        const sel = selectionOf(el)
        keyboard.newline(sel)
        const caret = sel.start + 1
        requestAnimationFrame(() => { el.setSelectionRange(caret, caret) })
      }
      return
    }
    e.preventDefault()
    if (e.repeat) return // held-down Enter must not machine-gun sends
    if (locked || machineBusy) return
    inputActions.submit('queue')
  }

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    if (machineBusy) return // submitting is the read-only span; adjudicating holds the pending lock
    const next = e.target.value
    keyboard.setDraft(next)
    // selectionStart is number|null in lib.dom; the type-aware lint program narrows it.
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    keyboard.track(next, e.target.selectionStart ?? next.length)
  }

  // ---- chip atomicity (DOM layer; the machine sees only transactions) ----
  // Placeholders occupy exactly one char, so caret positions are always
  // BETWEEN them — what needs normalizing is deletion (whole chip per
  // Backspace/Delete via native single-char semantics, which U+FFFC already
  // gives us) and selection endpoints: Shift-extension snapping is native
  // too (one char = one step). Mouse selection of a chip is handled in the
  // backdrop click handler below. Undo/redo must NOT reach the browser: the
  // machine owns the transaction log.
  // selectionStart/End are number|null in lib.dom; the type-aware lint program narrows them.
  /* oxlint-disable typescript/no-unnecessary-condition */
  const selectionOf = (el: HTMLTextAreaElement) => ({
    start: el.selectionStart ?? 0,
    end: el.selectionEnd ?? el.selectionStart ?? 0,
  })
  /* oxlint-enable typescript/no-unnecessary-condition */

  const onCopyOrCut = (e: React.ClipboardEvent<HTMLTextAreaElement>, cut: boolean): void => {
    const el = e.currentTarget
    const { start, end } = selectionOf(el)
    if (start === end) return
    const slice = draft.slice(start, end)
    const touched = input.occurrences.filter(o => o.offset >= start && o.offset < end)
    if (touched.length === 0 && !cut) return // plain copy of plain text: native path is fine
    e.preventDefault()
    // Expand placeholders to their owner clipboard projections.
    let text = ''
    let cursor = start
    for (const o of touched) {
      text += draft.slice(cursor, o.offset) + o.clipboardText
      cursor = o.offset + 1
    }
    text += draft.slice(cursor, end)
    e.clipboardData.setData('text/plain', text)
    if (cut && !machineBusy && !locked) {
      keyboard.setDraft(draft.slice(0, start) + draft.slice(end), { start, end, insertedLength: 0 })
      requestAnimationFrame(() => { el.setSelectionRange(start, start) })
    }
    void slice
  }

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    if (machineBusy || locked) return
    const text = e.clipboardData.getData('text/plain')
    if (text === '') return
    e.preventDefault()
    const el = e.currentTarget
    const sel = selectionOf(el)
    // Sync components stay empty at this layer: hot-snapshot matching needs
    // the Slash roster, which lives behind keyboard.track — the paste attempt
    // opens in the machine and the controller upgrades tokens as matches
    // land (paste-upgrade). The DOM layer only starts the transaction.
    keyboard.pasteBegin(text, sel)
    const caret = sel.start + text.length
    requestAnimationFrame(() => { el.setSelectionRange(caret, caret) })
    keyboard.track(keyboard.snapshot.draft, caret)
  }

  const onSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>): void => {
    // Any caret/selection gesture ends a live paste attempt (the machine
    // cannot observe DOM selection). Cheap no-op when none is live.
    if (keyboard.snapshot.paste !== undefined) keyboard.invalidatePaste()
    void e
  }

  // Button presses steal focus from the textarea; suppress at mousedown so typing continues seamlessly.
  const keepFocus = (e: MouseEvent<HTMLButtonElement>): void => {
    e.preventDefault()
    inputRef.current?.focus()
  }

  const primaryLabel = running ? 'Stop generating' : 'Send message'
  const onPrimary = (): void => {
    if (running) {
      stop()
      return
    }
    /* v8 ignore next -- defensive: the primary button is disabled while empty||disabled, so a click cannot reach the false arm. */
    if (!empty && !disabled && !machineBusy) inputActions.submit('queue')
  }

  // The Access seat: the projection-fed permission chip (renders nothing
  // while the permissions key is absent — permission-less host or Draft).
  const accessSelect: ReactNode = (
    <PermissionSelect value={permissions} locked={locked} command={command} />
  )

  // Mirror-layer decorations: a visible backdrop with transparent text. The
  // claim token highlights through behind the textarea glyphs; each U+FFFC
  // placeholder renders as a chip (the textarea's own glyph is invisible, the
  // backdrop chip supplies the visual); the claim hint is ghost text.
  const deco = deriveDecorations(input, lexicon)
  const backdrop: ReactNode[] = []
  {
    // Segment boundaries: the token range end, every chip offset, and every
    // text-ref range (decision 21) — merged in draft order (the sources never
    // overlap: chips sit on placeholders, text-refs on plain tokens, the
    // claim token only leads).
    let cursor = 0
    const pushPlain = (upTo: number): void => {
      if (upTo > cursor) backdrop.push(draft.slice(cursor, upTo))
      cursor = upTo
    }
    if (deco.token !== null) {
      backdrop.push(
        <mark key="token" className={css.hlToken} data-decoration="token">
          {draft.slice(deco.token.start, deco.token.end)}
        </mark>,
      )
      cursor = deco.token.end
    }
    type Boundary =
      | { at: number; kind: 'chip'; chip: (typeof deco.chips)[number] }
      | { at: number; kind: 'text-ref'; ref: (typeof deco.textRefs)[number] }
    const boundaries: Boundary[] = [
      ...deco.chips.map(chip => ({ at: chip.offset, kind: 'chip' as const, chip })),
      ...deco.textRefs.map(ref => ({ at: ref.start, kind: 'text-ref' as const, ref })),
    ].sort((a, b) => a.at - b.at)
    for (const b of boundaries) {
      if (b.at < cursor) continue // claim-token overlap: the leading mark wins
      pushPlain(b.at)
      if (b.kind === 'chip') {
        const chip = b.chip
        backdrop.push(
          // The cell's ::before renders U+FFFC itself so its advance equals the
          // textarea's placeholder exactly (same char, same font); the label is
          // a clipped overlay that never affects layout.
          <span
            key={`chip-${chip.occurrenceId}`}
            className={clsx(css.chip, chip.invalid && css.chipInvalid)}
            data-decoration="chip"
            data-occurrence={chip.occurrenceId}
            data-invalid={chip.invalid || undefined}
            title={chip.label}
          >
            <span className={css.chipLabel}>{chip.label}</span>
          </span>,
        )
        cursor = chip.offset + 1 // the placeholder char the chip stands for
      } else {
        // Plain-range highlight (decision 21): the glyphs stay the
        // textarea's (advance untouched); the mark paints the chip look.
        backdrop.push(
          <mark key={`ref-${b.ref.start}`} className={css.textRef} data-decoration="text-ref">
            {draft.slice(b.ref.start, b.ref.end)}
          </mark>,
        )
        cursor = b.ref.end
      }
    }
    pushPlain(draft.length)
    if (deco.hint !== null) {
      // Claim tokens are shaped `/name ` (trailing space); trim to the bare name.
      const commandName = input.claim?.token.slice(1).trim() ?? ''
      const hintKey = commandName === 'goal' && hasGoal ? 'goal.active' : commandName
      const translated = translateHint(hintKey)
      const displayHint = translated !== hintKey ? translated : deco.hint
      backdrop.push(<span key="hint" className={css.hint} data-decoration="hint">{displayHint}</span>)
    }
  }

  return (
    <div className={clsx(css.root, variant === 'hero' && css.hero)}>
      {error !== null && (
        <div className={css.error} role="alert">
          {error.message}
        </div>
      )}
      {notice !== null && (
        <div className={clsx(css.notice, notice.level === 'error' && css.noticeError)} role="status">
          {notice.text}
        </div>
      )}
      <div className={css.card} data-composer-card>
        {overlay !== undefined && <div className={css.overlayAnchor}>{overlay}</div>}
        {accessory !== undefined && <div className={css.accessory}>{accessory}</div>}
        {/* Mirror-div auto-grow: the hidden mirror renders draft+'\n' and stretches the wrapper
            (min/max capped in CSS); the absolutely-positioned textarea rides its height. Counting
            rows by '\n' cannot see soft wraps. */}
        <div className={css.grow}>
          <div aria-hidden className={css.backdrop} data-input-backdrop>{backdrop}</div>
          <textarea
            ref={inputRef}
            className={css.input}
            value={draft}
            disabled={locked}
            readOnly={machineBusy}
            data-phase={input.phase}
            placeholder={placeholder ?? (disabled
              ? 'Session unavailable'
              : planActive ? translateHint('placeholder.plan') : translateHint('placeholder.default'))}
            rows={2}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onSelect={onSelect}
            onCopy={(e) => { onCopyOrCut(e, false) }}
            onCut={(e) => { onCopyOrCut(e, true) }}
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
              {accessSelect}
              {renderSlot('conversation.input.plan', { locked })}
            </div>
            {leftItems}
          </div>
          <div className={css.trailing}>
            {rightItems}
            {renderSlot('conversation.input.model', { locked })}
            {/* {machineBusy && <span className={css.pending} data-input-pending aria-label="处理中" />} */}
            <button
              type="button"
              className={css.primary}
              aria-label={primaryLabel}
              title={primaryLabel}
              disabled={!running && (empty || disabled || machineBusy)}
              onMouseDown={keepFocus}
              onClick={onPrimary}
            >
              {running ? (
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                  <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                  <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
      {footer}
    </div>
  )
}
