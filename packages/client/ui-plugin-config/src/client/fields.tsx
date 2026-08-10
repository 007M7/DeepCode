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

/** Blur the input so its own blur handler is the single commit path. */
function commitOnEnter(event: KeyboardEvent<HTMLInputElement>): void {
  if (event.key === 'Enter') event.currentTarget.blur()
}

/**
 * The text input both editable fields render: a draft seeded from the
 * authoritative text, committed on blur and on Enter.
 */
function DraftInput(props: {
  /** Stable id associating the label with this control. */
  id: string
  /** Authoritative text the draft re-seeds from. */
  value: string
  /** Disables editing. */
  disabled: boolean
  /** Placeholder shown while the draft is empty. */
  placeholder?: string | undefined
  /** Hints a numeric keypad without narrowing the value type. */
  numeric?: boolean | undefined
  /** Settle the draft; the returned text replaces it (a rejected draft restores the value). */
  onSettle: (draft: string, restore: (text: string) => void) => void
}) {
  const [draft, setDraft] = useDraft(props.value)
  return (
    <input
      id={props.id}
      className={css.input}
      type="text"
      {...props.numeric === true ? { inputMode: 'numeric' as const } : {}}
      value={draft}
      placeholder={props.placeholder ?? ''}
      disabled={props.disabled}
      onChange={(event) => { setDraft(event.target.value) }}
      onBlur={() => { props.onSettle(draft, setDraft) }}
      onKeyDown={commitOnEnter}
    />
  )
}

/** A whole-number field committed on blur or Enter. */
export function NumberField(props: FieldProps & {
  /**
   * Current effective value, or undefined when the Host served none — which
   * renders empty rather than as a number nobody chose.
   */
  value: number | undefined
  /** Commit a parsed value; a draft that is not a finite number is discarded. */
  onCommit: (next: number) => void
}) {
  return (
    <FieldFrame {...props}>
      <DraftInput
        id={props.id}
        value={props.value === undefined ? '' : String(props.value)}
        disabled={props.disabled}
        numeric
        onSettle={(draft, restore) => {
          const parsed = Number(draft)
          if (draft.trim() === '' || !Number.isFinite(parsed)) {
            restore(props.value === undefined ? '' : String(props.value))
            return
          }
          if (parsed === props.value) return
          props.onCommit(parsed)
        }}
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
  return (
    <FieldFrame {...props}>
      <DraftInput
        id={props.id}
        value={props.value}
        disabled={props.disabled}
        placeholder={props.placeholder}
        onSettle={(draft) => {
          const next = draft.trim()
          if (next === props.value) return
          props.onCommit(next)
        }}
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
        onBlur={() => {
          const next = draft.trim()
          if (next === '') return
          setDraft('')
          props.onCommit(next)
        }}
        onKeyDown={commitOnEnter}
      />
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}
