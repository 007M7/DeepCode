/**
 * Hand-written controls for the plugin configuration forms. Each renders one
 * field's label, its current effective value, whether the user overrode it,
 * and — when overridden — the reset that clears it back to the composition
 * layer. Commits happen on blur and on Enter rather than per keystroke: a
 * write per keystroke would burn namespace revisions and race its own reads.
 */

import { useState, type KeyboardEvent } from 'react'
import css from './fields.module.css'

/** What every field control needs regardless of its value type. */
export interface FieldProps {
  /** Stable id associating the label with its control. */
  id: string
  /** Visible label. */
  label: string
  /** One-line explanation rendered under the control. */
  hint: string
  /** True when the raw user layer carries this field. */
  overridden: boolean
  /** Copy for the overridden badge. */
  overriddenLabel: string
  /** Copy for the reset control. */
  resetLabel: string
  /** Disables every control (read-only document, or an unavailable namespace). */
  disabled: boolean
  /** Clear the field so it re-inherits the composition layer. */
  onReset: () => void
}

/** Label, badge, and reset chrome shared by every control. */
function FieldFrame(props: FieldProps & { children: React.ReactNode }) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {props.overridden
          ? (
            <span className={css.badges}>
              <span className={css.badge}>{props.overriddenLabel}</span>
              <button
                type="button"
                className={css.reset}
                disabled={props.disabled}
                onClick={props.onReset}
              >
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
      </div>
      {props.children}
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}

/**
 * Keep a draft seeded from the authoritative value, re-seeding whenever that
 * value changes underneath (a Host acceptance, or a reset).
 * @param value - the current authoritative text.
 * @returns the draft and its setter.
 */
function useDraft(value: string): [string, (next: string) => void] {
  const [draft, setDraft] = useState(value)
  const [seed, setSeed] = useState(value)
  if (seed !== value) {
    setSeed(value)
    setDraft(value)
  }
  return [draft, setDraft]
}

/** A whole-number field committed on blur or Enter. */
export function NumberField(props: FieldProps & {
  /** Current effective value. */
  value: number
  /** Commit a parsed value; a draft that is not a finite number is discarded. */
  onCommit: (next: number) => void
}) {
  const [draft, setDraft] = useDraft(String(props.value))
  const commit = () => {
    const parsed = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(parsed)) {
      setDraft(String(props.value))
      return
    }
    if (parsed === props.value) return
    props.onCommit(parsed)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') event.currentTarget.blur()
  }
  return (
    <FieldFrame {...props}>
      <input
        id={props.id}
        className={css.input}
        type="text"
        inputMode="numeric"
        value={draft}
        disabled={props.disabled}
        onChange={(event) => { setDraft(event.target.value) }}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
    </FieldFrame>
  )
}

/** A free-text field committed on blur or Enter; an empty draft clears the field. */
export function TextField(props: FieldProps & {
  /** Current effective value; the empty string when the field is unset. */
  value: string
  /** Placeholder shown while the draft is empty. */
  placeholder?: string
  /** Commit the trimmed draft. */
  onCommit: (next: string) => void
}) {
  const [draft, setDraft] = useDraft(props.value)
  const commit = () => {
    const next = draft.trim()
    if (next === props.value) return
    props.onCommit(next)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') event.currentTarget.blur()
  }
  return (
    <FieldFrame {...props}>
      <input
        id={props.id}
        className={css.input}
        type="text"
        value={draft}
        placeholder={props.placeholder ?? ''}
        disabled={props.disabled}
        onChange={(event) => { setDraft(event.target.value) }}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
    </FieldFrame>
  )
}

/**
 * A write-only credential field. The value never rides a response, so the
 * control reports only whether one is configured, and an empty draft commits
 * nothing — leaving the field blank keeps the stored key rather than clearing it.
 */
export function SecretField(props: Omit<FieldProps, 'overridden' | 'onReset'> & {
  /** Whether the Host reports a configured credential for this reference. */
  configured: boolean
  /** Copy describing the configured state. */
  stateLabel: string
  /** Commit a non-empty draft. */
  onCommit: (next: string) => void
}) {
  const [draft, setDraft] = useState('')
  const commit = () => {
    const next = draft.trim()
    if (next === '') return
    setDraft('')
    props.onCommit(next)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') event.currentTarget.blur()
  }
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        <span className={css.badges}>
          <span className={props.configured ? css.badge : css.badgeMuted}>{props.stateLabel}</span>
        </span>
      </div>
      <input
        id={props.id}
        className={css.input}
        type="password"
        autoComplete="off"
        value={draft}
        disabled={props.disabled}
        onChange={(event) => { setDraft(event.target.value) }}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}
