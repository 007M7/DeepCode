/**
 * Curated editor for the direct DeepSeek adapter's advisory model catalog.
 * The settings layer replaces `models` as one array, so the parent supplies
 * the effective inherited rows until the first edit materializes a user
 * override; reset removes that override instead of copying defaults into it.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { IconPlusOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** One catalog entry kept structurally open so hidden or future fields survive an edit. */
export type DeepSeekModelDraft = Record<string, unknown>

/** Accepted context-window spellings: a decimal count with an optional K/M suffix. */
const CONTEXT_WINDOW_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i

/** Decimal suffix scales — `1M` is 1000K, matching how model capacities are quoted. */
const CONTEXT_WINDOW_SCALE = { k: 1_000, m: 1_000_000 } as const

/**
 * Read a typed context window, so a user can write `256K` or `1M` instead of
 * counting zeroes. The stored value stays a plain token count.
 * @param text - raw field text.
 * @returns the count; `undefined` when blank (inherit), `NaN` when unreadable
 * (rejected by {@link validateDeepSeekModels} before any write).
 */
export function parseContextWindow(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  const match = CONTEXT_WINDOW_PATTERN.exec(trimmed)
  if (match === null) return Number.NaN
  const suffix = match[2]?.toLowerCase()
  const scale = suffix === 'k' || suffix === 'm' ? CONTEXT_WINDOW_SCALE[suffix] : 1
  const scaled = Number(match[1]) * scale
  // A decimal multiple is exact in intent but not in binary floating point
  // (2.3 * 1e6 lands a few ULPs high), so an integral intent snaps back.
  const rounded = Math.round(scaled)
  return Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled
}

/**
 * Spell a stored count back in the shortest form that survives a round trip
 * through {@link parseContextWindow}; a count that is not a whole number of
 * thousands stays written out.
 * @param value - stored context window.
 * @returns the field text.
 */
export function formatContextWindow(value: number): string {
  if (!Number.isInteger(value) || value <= 0) return String(value)
  if (value % CONTEXT_WINDOW_SCALE.m === 0) return `${String(value / CONTEXT_WINDOW_SCALE.m)}M`
  if (value % CONTEXT_WINDOW_SCALE.k === 0) return `${String(value / CONTEXT_WINDOW_SCALE.k)}K`
  return String(value)
}

/** A localized validation failure for one user-owned model array. */
export interface DeepSeekModelsValidationFailure {
  /** Zero-based model position. */
  index: number
  /** Message key owned by the Models settings section. */
  key: 'modelIdRequired' | 'modelIdDuplicate' | 'modelNameInvalid' | 'modelContextInvalid'
}

/** Convert a schema-validated catalog value into records without dropping hidden fields. */
export function modelDrafts(value: unknown): DeepSeekModelDraft[] {
  if (!Array.isArray(value)) return []
  return value.map(entry =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? entry as DeepSeekModelDraft
      : {})
}

/**
 * Validate adapter constraints that the serialized schema cannot express.
 * @param value - user-owned `models` value, or undefined while inherited.
 * @returns the first invalid row, or undefined when the adapter will accept it.
 */
export function validateDeepSeekModels(value: unknown): DeepSeekModelsValidationFailure | undefined {
  if (value === undefined) return undefined
  const models = modelDrafts(value)
  const seen = new Set<string>()
  for (const [index, model] of models.entries()) {
    const id = model['id']
    if (typeof id !== 'string' || id.length === 0) return { index, key: 'modelIdRequired' }
    if (seen.has(id)) return { index, key: 'modelIdDuplicate' }
    seen.add(id)
    const name = model['name']
    if (name !== undefined && (typeof name !== 'string' || name.length === 0)) {
      return { index, key: 'modelNameInvalid' }
    }
    const contextWindow = model['contextWindow']
    if (contextWindow !== undefined
      && (typeof contextWindow !== 'number' || !Number.isInteger(contextWindow) || contextWindow <= 0)) {
      return { index, key: 'modelContextInvalid' }
    }
  }
  return undefined
}

/** Props of {@link DeepSeekModelsEditor}. */
export interface DeepSeekModelsEditorProps {
  /** Effective rows: inherited until the parent materializes an override. */
  models: readonly DeepSeekModelDraft[]
  /** Whether the user layer currently owns the whole array. */
  overridden: boolean
  /** Fallback capacity used when a row omits its exact value. */
  defaultContextWindow: number | undefined
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable every mutation. */
  disabled: boolean
  /** Replace the user-owned array after one visible edit. */
  onChange: (models: DeepSeekModelDraft[]) => void
  /** Remove the user-owned array and return to inheritance. */
  onReset: () => void
}

/**
 * Render the direct DeepSeek adapter's id/name/context-window catalog.
 * @param props - effective rows plus the array-level override actions.
 * @returns the catalog editor.
 */
export function DeepSeekModelsEditor(props: DeepSeekModelsEditorProps): ReactNode {
  // The context-window field is edited as text, so the keystrokes are held
  // here while one row has focus: re-deriving the text from the parsed count
  // on every change would rewrite `1000` to `1K` mid-word.
  const [editing, setEditing] = useState<{ index: number; text: string } | undefined>(undefined)

  const update = (index: number, key: 'id' | 'name' | 'contextWindow', value: unknown): void => {
    const next = props.models.map((model, at) => {
      const copy = { ...model }
      if (at !== index) return copy
      if (value === undefined) Reflect.deleteProperty(copy, key)
      else copy[key] = value
      return copy
    })
    props.onChange(next)
  }

  const remove = (index: number): void => {
    setEditing(undefined)
    props.onChange(props.models.filter((_model, at) => at !== index).map(model => ({ ...model })))
  }

  /** The row's field text: the live keystrokes, else the stored count spelled short. */
  const contextText = (model: DeepSeekModelDraft, index: number): string => {
    if (editing?.index === index) return editing.text
    const value = model['contextWindow']
    return typeof value === 'number' ? formatContextWindow(value) : ''
  }

  const settleContext = (index: number): void => {
    setEditing((current) => {
      if (current?.index !== index) return current
      // Unreadable text stays on screen: the save-time rejection names a row
      // the user can still see and correct.
      const parsed = parseContextWindow(current.text)
      return parsed !== undefined && Number.isNaN(parsed) ? current : undefined
    })
  }

  return (
    <section className={styles['modelCatalog']} aria-label={props.t('models')}>
      <div className={styles['modelCatalogHeader']}>
        <div className={styles['modelCatalogHeading']}>
          <span className={styles['modelCatalogTitle']}>{props.t('models')}</span>
          <span className={styles['modelCatalogMeta']}>
            {props.overridden ? props.t('modelsCustomized') : props.t('modelsInherited')}
          </span>
        </div>
        {props.overridden
          ? (
            <button
              type="button"
              className={styles['linkButton']}
              disabled={props.disabled}
              onClick={props.onReset}
            >
              {props.t('resetModels')}
            </button>
          )
          : null}
      </div>
      {props.models.length === 0
        ? <p className={styles['modelEmpty']}>{props.t('modelsEmpty')}</p>
        : (
          <div className={styles['modelTable']}>
            {/* Captions sit above the rows and are hidden from assistive tech:
                every field already carries the indexed `aria-label` naming it. */}
            <div className={styles['modelColumns']} aria-hidden="true">
              <span>{props.t('modelId')}</span>
              <span>{props.t('modelName')}</span>
              <span>{props.t('contextWindow')}</span>
            </div>
            {props.models.map((model, index) => (
              <div className={styles['modelRow']} key={index}>
                <input
                  className={styles['input']}
                  type="text"
                  value={typeof model['id'] === 'string' ? model['id'] : ''}
                  aria-label={`${props.t('modelId')} ${String(index + 1)}`}
                  disabled={props.disabled}
                  onChange={(event) => { update(index, 'id', event.target.value) }}
                />
                <input
                  className={styles['input']}
                  type="text"
                  value={typeof model['name'] === 'string' ? model['name'] : ''}
                  placeholder={props.t('modelNamePlaceholder')}
                  aria-label={`${props.t('modelName')} ${String(index + 1)}`}
                  disabled={props.disabled}
                  onChange={(event) => {
                    update(index, 'name', event.target.value === '' ? undefined : event.target.value)
                  }}
                />
                <input
                  className={styles['input']}
                  type="text"
                  value={contextText(model, index)}
                  placeholder={props.defaultContextWindow === undefined
                    ? props.t('contextWindowPlaceholder')
                    : formatContextWindow(props.defaultContextWindow)}
                  aria-label={`${props.t('contextWindow')} ${String(index + 1)}`}
                  disabled={props.disabled}
                  onChange={(event) => {
                    setEditing({ index, text: event.target.value })
                    update(index, 'contextWindow', parseContextWindow(event.target.value))
                  }}
                  onBlur={() => { settleContext(index) }}
                />
                <button
                  type="button"
                  className={styles['rowDelete']}
                  disabled={props.disabled}
                  onClick={() => { remove(index) }}
                >
                  <IconTrashOutline16 size={14} />
                  <span className={styles['hiddenLabel']}>{props.t('removeModel')}</span>
                </button>
              </div>
            ))}
          </div>
        )}
      <button
        type="button"
        className={styles['addModelButton']}
        disabled={props.disabled}
        onClick={() => { props.onChange([...props.models.map(model => ({ ...model })), { id: '' }]) }}
      >
        <IconPlusOutline16 size={14} />
        {props.t('addModel')}
      </button>
    </section>
  )
}
