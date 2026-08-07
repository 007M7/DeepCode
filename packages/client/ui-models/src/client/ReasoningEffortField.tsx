/**
 * The provider-level reasoning-effort select: the profile's own default
 * effort, applied to every model on the route unless a request names one. The
 * empty option means "inherit", which on the wire is the field being absent
 * rather than an empty string.
 *
 * It carries the per-family vocabulary and field name so the editor's two
 * layouts cannot spell them differently. Only routes the adapter ships get
 * this control at all — a hand-declared model has no reasoning capability to
 * configure, and a profile effort over one makes its whole route fail to
 * resolve — so the create card renders nothing here by construction.
 */

import type { ReactNode } from 'react'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** The adapter families that expose a provider-level effort, and their vocabularies. */
export type EffortFamily = 'deepseek' | 'pi-ai'

/** Reasoning vocabularies per family; the empty option means "inherit". */
export const EFFORT_CHOICES: Record<EffortFamily, readonly string[]> = {
  deepseek: ['off', 'high', 'max'],
  'pi-ai': ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
}

/** The profile key each family's effort lives under. */
export const EFFORT_FIELD: Record<EffortFamily, string> = {
  deepseek: 'reasoningEffort',
  'pi-ai': 'reasoning',
}

/** Props of {@link ReasoningEffortField}. */
export interface ReasoningEffortFieldProps {
  /** Which vocabulary to offer. */
  family: EffortFamily
  /** Current value; the empty string is the inherit option. */
  value: string
  /** Receives the chosen effort, or undefined for inherit. */
  onChange: (effort: string | undefined) => void
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable the control (busy or read-only). */
  disabled: boolean
}

/**
 * Render the provider-level reasoning-effort select.
 * @param props - family vocabulary, current value, change sink, copy, and disabled state.
 * @returns the labelled select.
 */
export function ReasoningEffortField(
  { family, value, onChange, t, disabled }: ReasoningEffortFieldProps,
): ReactNode {
  return (
    <div className={styles['field']}>
      <span className={styles['fieldLabel']}>{t('effort')}</span>
      <select
        className={`${styles['input']} ${styles['selectInput']}`}
        value={value}
        aria-label={t('effort')}
        disabled={disabled}
        onChange={(event) => { onChange(event.target.value === '' ? undefined : event.target.value) }}
      >
        <option value="">{t('effortInherit')}</option>
        {EFFORT_CHOICES[family].map(choice => (
          <option key={choice} value={choice}>{choice}</option>
        ))}
      </select>
    </div>
  )
}
