/**
 * One provider's editor card, hand-written per adapter family: the primary
 * field is a single write-only **API key** input (the page never asks for an
 * environment-variable name — a typed key stores through `credentials.set`
 * under the profile's reference, deriving `<ROUTE>_API_KEY` when the profile
 * has none, and the pi-ai profile records that derivation as `apiKeyEnv`);
 * the collapsed 自定义设置 area carries the per-family extras (deepseek:
 * `baseURL` + `reasoningEffort`; pi-ai: `reasoning`). Everything else stays
 * owned by `settings.yaml` — the folded hint says so. Profile edits land as a
 * minimal `settings.update` merge patch; clearing a field back to inherited
 * removes its key, so that apply replaces the user section (safe: the section
 * stores references, never key values).
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { CredentialView, IApiClient, SettingsNamespaceView } from '@deepseek-ai/dsh-client-connection/client'
import {
  deletePath, getPath, nodeAtPath, rehydrateSchema, setPath, validateDraft,
} from '@deepseek-ai/dsh-client-schema-form'
import { deriveKeyRef } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Per-adapter-family curated field sets (unknown namespaces get the hint alone). */
type EditorLayout = 'deepseek' | 'pi-ai' | 'unknown'

/** Reasoning vocabularies per layout; the empty option means "inherit". */
const EFFORT_CHOICES: Record<'deepseek' | 'pi-ai', readonly string[]> = {
  deepseek: ['off', 'high', 'max'],
  'pi-ai': ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
}

/** The draft key the effort select edits, per layout. */
const EFFORT_FIELD: Record<'deepseek' | 'pi-ai', string> = {
  deepseek: 'reasoningEffort',
  'pi-ai': 'reasoning',
}

/** Props of {@link ProviderEditor}. */
export interface ProviderEditorProps {
  /** Provider route id. */
  provider: string
  /** Display name for the card title. */
  displayName: string
  /** Hide the title row (the add card renders its own provider select). */
  hideTitle?: boolean
  /** The owning namespace view (schema, layers, secrets). */
  namespace: SettingsNamespaceView
  /** Path from the section root to this provider's profile. */
  settingsPath: readonly string[]
  /** Wire faces for writes. */
  api: Pick<IApiClient, 'settings' | 'credentials'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable writes (read-only settings provider). */
  readOnly: boolean
  /** Close the editor; `changed` reports whether an Apply committed. */
  onClose: (changed: boolean) => void
}

/** A user-section subtree as a plain draft object (absent → empty). */
function draftAt(namespace: SettingsNamespaceView, path: readonly string[]): Record<string, unknown> {
  const subtree = getPath(namespace.user, path)
  if (typeof subtree !== 'object' || subtree === null || Array.isArray(subtree)) return {}
  return structuredClone(subtree) as Record<string, unknown>
}

/**
 * Whether any key present in `before` is absent from `after` (a reset
 * happened somewhere in the draft, so the apply must replace, not merge).
 * @param before - the user-layer subtree the draft started from.
 * @param after - the edited draft.
 * @returns whether a removal exists at any depth.
 */
export function removedAny(before: unknown, after: unknown): boolean {
  if (typeof before !== 'object' || before === null) return false
  /* v8 ignore next -- the editor edits containers in place; a container cannot become a primitive */
  if (typeof after !== 'object' || after === null) return true
  for (const [key, value] of Object.entries(before)) {
    if (!(key in (after as Record<string, unknown>))) return true
    if (removedAny(value, (after as Record<string, unknown>)[key])) return true
  }
  return false
}

/** The editor layout the owning namespace selects. */
function layoutOf(ns: string): EditorLayout {
  if (ns === 'llm-deepseek') return 'deepseek'
  if (ns === 'llm-pi-ai') return 'pi-ai'
  return 'unknown'
}

/** The credential reference this profile resolves keys through. */
function refFor(namespace: SettingsNamespaceView, path: readonly string[], provider: string): string {
  const profile = getPath(namespace.value, path)
  const named = typeof profile === 'object' && profile !== null
    ? (profile as { apiKeyEnv?: unknown }).apiKeyEnv
    : undefined
  return typeof named === 'string' && named.length > 0 ? named : deriveKeyRef(provider)
}

/**
 * Render one provider's editing card.
 * @param props - the addressed profile plus wire faces and copy.
 * @returns the editor card.
 */
export function ProviderEditor(props: ProviderEditorProps): ReactNode {
  const { namespace, settingsPath, api, t } = props
  const [draft, setDraft] = useState<Record<string, unknown>>(() => draftAt(namespace, settingsPath))
  const [keyDraft, setKeyDraft] = useState('')
  const [keyState, setKeyState] = useState<CredentialView | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const root = useMemo(() => rehydrateSchema(namespace.schema), [namespace.schema])
  const node = useMemo(() => nodeAtPath(root, settingsPath), [root, settingsPath])
  const fallback = getPath(namespace.value, settingsPath)
  const disabled = props.readOnly || busy
  const layout = layoutOf(namespace.ns)
  const keyRef = refFor(namespace, settingsPath, props.provider)

  useEffect(() => {
    let stale = false
    setKeyState(undefined)
    void api.credentials.describe({ refs: [keyRef] }).then((response) => {
      if (stale || !response.result.ok) return
      setKeyState(response.result.value.credentials[keyRef])
    })
    return () => { stale = true }
  }, [api.credentials, keyRef])

  const stringAt = (source: unknown, key: string): string | undefined => {
    const value = getPath(source, [key])
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  const setField = (key: string, next: string | undefined): void => {
    setDraft(current => next === undefined ? deletePath(current, [key]) : setPath(current, [key], next))
  }

  const apply = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    const ns = namespace.ns
    const original = getPath(namespace.user, settingsPath)
    // The pi-ai profile must name the reference the key stores under, so a
    // dormant add (or a legacy profile without one) records the derivation.
    const next = layout === 'pi-ai' && stringAt(draft, 'apiKeyEnv') === undefined
      && stringAt(fallback, 'apiKeyEnv') === undefined
      ? setPath(draft, ['apiKeyEnv'], keyRef)
      : draft
    const settingsChanged = JSON.stringify(next) !== JSON.stringify(original ?? {})
    if (settingsChanged) {
      const needsReplace = removedAny(original, next)
      // Merge patches stay minimal (just this profile); a replace must carry
      // the complete next user section because it lands wholesale.
      const patch = settingsPath.length === 0 ? next : setPath({}, [...settingsPath], next)
      /* v8 ignore next 3 -- a subtree apply implies the join served this namespace's user layer */
      const nextSection = settingsPath.length === 0
        ? next
        : setPath(structuredClone((namespace.user ?? {}) as Record<string, unknown>), [...settingsPath], next)
      /* v8 ignore next -- apply is only reachable from the rendered card, which required a resolved node */
      if (node !== undefined) {
        const sectionError = settingsPath.length === 0 ? validateDraft(node, next) : undefined
        if (sectionError !== undefined) {
          setBusy(false)
          setFailure(sectionError)
          return
        }
      }
      const response = needsReplace
        ? await api.settings.replace({ ns, section: nextSection })
        : await api.settings.update({ ns, patch })
      if (!response.result.ok) {
        setBusy(false)
        setFailure(response.result.error.message)
        return
      }
    }
    if (keyDraft.length > 0) {
      const stored = await api.credentials.set({ ref: keyRef, value: keyDraft })
      if (!stored.result.ok) {
        setBusy(false)
        setFailure(stored.result.error.message)
        return
      }
      setKeyDraft('')
    }
    setBusy(false)
    props.onClose(true)
  }

  if (node === undefined) {
    // A directory entry addressing a position its schema cannot resolve is a
    // host-side inconsistency; showing it beats a blank card.
    return <p className={styles['error']}>{`${props.provider}: unresolvable settings path`}</p>
  }

  const keyLocked = keyState?.writable === false
  const effortField = layout === 'unknown' ? undefined : EFFORT_FIELD[layout]

  return (
    <div className={styles['editor']}>
      {props.hideTitle === true
        ? null
        : (
          <div className={styles['editorHeader']}>
            <span className={styles['editorTitle']}>{props.displayName}</span>
            {props.provider !== props.displayName
              ? <span className={styles['editorRoute']}>{props.provider}</span>
              : null}
          </div>
        )}
      {layout === 'unknown'
        ? <p className={styles['advancedHint']}>{`${t('advancedHint')} (${namespace.ns})`}</p>
        : (
          <>
            <div className={styles['field']}>
              <span className={styles['fieldLabel']}>{t('keyInput')}</span>
              <input
                className={styles['input']}
                type="password"
                autoComplete="off"
                value={keyDraft}
                placeholder={keyLocked
                  ? t('keyEnvLocked')
                  : keyState?.configured === true ? t('keyStored') : t('keyPlaceholder')}
                aria-label={t('keyInput')}
                disabled={disabled || keyLocked}
                onChange={(event) => { setKeyDraft(event.target.value) }}
              />
            </div>
            <details className={styles['customized']}>
              <summary className={styles['customizedSummary']}>{t('customized')}</summary>
              <div className={styles['customizedBody']}>
                {layout === 'deepseek'
                  ? (
                    <div className={styles['field']}>
                      <span className={styles['fieldLabel']}>{t('baseUrl')}</span>
                      <input
                        className={styles['input']}
                        type="text"
                        value={stringAt(draft, 'baseURL') ?? ''}
                        placeholder={stringAt(fallback, 'baseURL') ?? t('baseUrlDefault')}
                        aria-label={t('baseUrl')}
                        disabled={disabled}
                        onChange={(event) => {
                          setField('baseURL', event.target.value === '' ? undefined : event.target.value)
                        }}
                      />
                    </div>
                  )
                  : null}
                {/* v8 ignore next -- EFFORT_FIELD is total over non-unknown layouts; the check only narrows the type */}
                {effortField !== undefined
                  ? (
                    <div className={styles['field']}>
                      <span className={styles['fieldLabel']}>{t('effort')}</span>
                      <select
                        className={styles['input']}
                        value={stringAt(draft, effortField) ?? ''}
                        aria-label={t('effort')}
                        disabled={disabled}
                        onChange={(event) => {
                          setField(effortField, event.target.value === '' ? undefined : event.target.value)
                        }}
                      >
                        <option value="">{t('effortInherit')}</option>
                        {EFFORT_CHOICES[layout].map(choice => (
                          <option key={choice} value={choice}>{choice}</option>
                        ))}
                      </select>
                    </div>
                  )
                  : null}
                <p className={styles['advancedHint']}>{`${t('advancedHint')} (${namespace.ns})`}</p>
              </div>
            </details>
          </>
        )}
      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}
      <div className={styles['editorActions']}>
        <button
          type="button"
          className={styles['secondaryButton']}
          disabled={busy}
          onClick={() => { props.onClose(false) }}
        >
          {t('cancel')}
        </button>
        <button
          type="button"
          className={styles['primaryButton']}
          disabled={disabled || layout === 'unknown'}
          onClick={() => { void apply() }}
        >
          {busy ? t('applying') : t('apply')}
        </button>
      </div>
    </div>
  )
}
