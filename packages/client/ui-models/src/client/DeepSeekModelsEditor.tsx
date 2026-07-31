/**
 * Curated editor for the direct DeepSeek adapter's advisory model catalog.
 * The settings layer replaces `models` as one array, so the parent supplies
 * the effective inherited rows until the first edit materializes a user
 * override; reset removes that override instead of copying defaults into it.
 */

import type { ReactNode } from 'react'
import { IconPlusOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** One catalog entry kept structurally open so hidden or future fields survive an edit. */
export type DeepSeekModelDraft = Record<string, unknown>

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
    props.onChange(props.models.filter((_model, at) => at !== index).map(model => ({ ...model })))
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
                  type="number"
                  min={1}
                  step={1}
                  value={typeof model['contextWindow'] === 'number' ? model['contextWindow'] : ''}
                  placeholder={props.defaultContextWindow === undefined
                    ? props.t('contextWindowPlaceholder')
                    : String(props.defaultContextWindow)}
                  aria-label={`${props.t('contextWindow')} ${String(index + 1)}`}
                  disabled={props.disabled}
                  onChange={(event) => {
                    update(
                      index,
                      'contextWindow',
                      event.target.value === '' ? undefined : Number(event.target.value),
                    )
                  }}
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
