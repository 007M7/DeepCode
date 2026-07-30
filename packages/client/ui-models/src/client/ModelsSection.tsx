/**
 * Models settings section: the provider rows joined from the configurable
 * directory, settings namespaces, and credential states, with one editor
 * card at a time. A whole-section provider without a configured key (the
 * unconfigured DeepSeek posture) renders as its open setup card instead of a
 * row; the add flow is a card carrying the dormant-provider select. Every
 * mutation writes through the wire; the page re-renders from the pushed
 * invalidations or the post-apply reload.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import { messageOf } from './store.ts'
import type { ModelsSettingsState, ModelsSettingsStore, ProviderRow } from './store.ts'
import { ProviderEditor } from './ProviderEditor.tsx'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Injected dependencies of {@link ModelsSection} (slot `inject`). */
export interface ModelsSectionInjected {
  /** The page store (loaded on mount, refreshed on pushed invalidations). */
  controller: ModelsSettingsStore
  /** uSES subscription hook bound to the store. */
  useSnapshot: SnapshotSelectorHook<ModelsSettingsState>
  /** Wire faces the editor writes through. */
  api: Pick<IApiClient, 'settings' | 'credentials'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/**
 * Props delivered by the slot outlet: the inject face spread flat (the
 * renderer erases the share boundary at the render call).
 */
export type ModelsSectionProps = Partial<ModelsSectionInjected>

/** The editor target: an existing row or a dormant directory entry. */
interface EditorTarget {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: readonly string[]
}

/**
 * Remove one user-added provider profile by unsetting its path in the stored
 * user section, then reload. The removal names the profile rather than
 * rebuilding the section: this page only ever holds the redacted descriptor,
 * so a rebuilt section would drop every literal secret stored elsewhere in
 * the namespace along with the profile being removed.
 * @param api - settings wire face.
 * @param controller - the page store to refresh.
 * @param target - the provider's settings address.
 * @returns the failure message, or undefined once the write and reload landed.
 */
export async function removeProviderProfile(
  api: Pick<IApiClient, 'settings'>,
  controller: ModelsSettingsStore,
  target: { settingsNs: string; settingsPath: readonly string[] },
): Promise<string | undefined> {
  let response
  try {
    response = await api.settings.mutate({
      ns: target.settingsNs,
      ops: [{ op: 'unset', path: [...target.settingsPath] }],
    })
  } catch (error) {
    // The transport rejected rather than answering; the caller must be able
    // to say so instead of the row silently staying put.
    return messageOf(error)
  }
  if (!response.result.ok) return response.result.error.message
  await controller.load()
  return undefined
}

/**
 * Whether a whole-section provider still needs its first key: nothing marks
 * the credential configured and no literal `apiKey` is stored, so the page
 * opens the setup card instead of showing a row.
 * @param row - the joined provider row.
 * @returns whether to render the setup card.
 */
export function needsSetup(row: ProviderRow): boolean {
  if (row.entry.settingsPath.length > 0) return false
  if (row.credential?.configured === true) return false
  return !row.literalApiKeyConfigured
}

function targetOf(row: ProviderRow): EditorTarget {
  return {
    provider: row.entry.provider,
    displayName: row.entry.displayName,
    settingsNs: row.entry.settingsNs,
    settingsPath: row.entry.settingsPath,
  }
}

/**
 * Render the Models section content column.
 * @param props - slot-delivered injected dependencies.
 * @returns the section, or null while the shell has not injected yet.
 */
export function ModelsSection(props: ModelsSectionProps): ReactNode {
  const { controller, useSnapshot, api, t } = props
  if (controller === undefined || useSnapshot === undefined || api === undefined || t === undefined) return null
  return <Loaded injected={{ controller, useSnapshot, api, t }} />
}

function Loaded({ injected }: { injected: ModelsSectionInjected }): ReactNode {
  const { controller, api, t } = injected
  const state = injected.useSnapshot(snapshot => snapshot)
  const [editing, setEditing] = useState<EditorTarget | undefined>(undefined)
  const [adding, setAdding] = useState(false)

  const closeEditor = (changed: boolean): void => {
    setEditing(undefined)
    setAdding(false)
    if (changed) void controller.load()
  }

  if (state.status === 'idle') void controller.load()
  if (state.status === 'error') {
    /* v8 ignore next -- an error status always carries text; the fallback satisfies the nullable type */
    const errorText = state.error ?? ''
    return (
      <div className={styles['section']}>
        <p className={styles['error']}>{`${t('loadFailed')}: ${errorText}`}</p>
        <button type="button" className={styles['secondaryButton']} onClick={() => { void controller.load() }}>
          {t('retry')}
        </button>
      </div>
    )
  }

  const configured = state.rows.filter(row => row.configured)
  const addable = state.rows.filter(row => !row.configured && row.entry.settingsNs !== '')
  const addTarget = adding ? editing : undefined
  const addNamespace = addTarget === undefined ? undefined : state.namespaces.get(addTarget.settingsNs)

  return (
    <div className={styles['section']}>
      <h2 className={styles['title']}>{t('title')}</h2>
      <p className={styles['intro']}>{t('intro')}</p>
      {!state.writable && state.status === 'ready' ? <p className={styles['notice']}>{t('readOnly')}</p> : null}
      <ul className={styles['rows']}>
        {configured.map((row) => {
          const target = targetOf(row)
          const namespace = state.namespaces.get(target.settingsNs)
          /* v8 ignore next -- the join marks a row configured only when its namespace resolved */
          if (namespace === undefined) return null
          if (needsSetup(row)) {
            // First-run posture: the provider exists but has no key — the
            // setup card IS its presence on the page.
            return (
              <li key={row.entry.provider} className={styles['setupCard']}>
                <ProviderEditor
                  provider={target.provider}
                  displayName={target.displayName}
                  namespace={namespace}
                  settingsPath={target.settingsPath}
                  api={api}
                  t={t}
                  readOnly={!state.writable}
                  onClose={closeEditor}
                />
              </li>
            )
          }
          const open = !adding && editing?.provider === row.entry.provider
          return (
            <li key={row.entry.provider} className={styles['rowCard']}>
              <div className={styles['rowHead']}>
                <span className={styles['rowName']}>{row.entry.displayName}</span>
                <span className={styles['badges']}>
                  {row.entry.active
                    ? <span className={styles['badgeOk']}>{t('active')}</span>
                    : <span className={styles['badgeMuted']}>{t('dormant')}</span>}
                </span>
                <span className={styles['rowActions']}>
                  <button
                    type="button"
                    className={styles['secondaryButton']}
                    onClick={() => { setAdding(false); setEditing(open ? undefined : target) }}
                  >
                    {t('edit')}
                  </button>
                  {row.removable
                    ? (
                      <button
                        type="button"
                        className={styles['dangerButton']}
                        disabled={!state.writable}
                        onClick={() => {
                          void removeProviderProfile(api, controller, target).then((failure) => {
                            if (failure !== undefined) controller.fail(failure)
                          })
                        }}
                      >
                        {t('remove')}
                      </button>
                    )
                    : null}
                </span>
              </div>
              {open
                ? (
                  <ProviderEditor
                    provider={target.provider}
                    displayName={target.displayName}
                    namespace={namespace}
                    settingsPath={target.settingsPath}
                    api={api}
                    t={t}
                    readOnly={!state.writable}
                    onClose={closeEditor}
                  />
                )
                : null}
            </li>
          )
        })}
      </ul>
      <div className={styles['addBlock']}>
        {addTarget !== undefined && addNamespace !== undefined
          ? (
            <div className={styles['addCard']}>
              <div className={styles['field']}>
                <span className={styles['fieldLabel']}>{t('provider')}</span>
                <select
                  className={styles['input']}
                  value={addTarget.provider}
                  aria-label={t('provider')}
                  onChange={(event) => {
                    const row = addable.find(candidate => candidate.entry.provider === event.target.value)
                    /* v8 ignore next -- the select only lists addable rows */
                    if (row === undefined) return
                    setEditing(targetOf(row))
                  }}
                >
                  {addable.map(row => (
                    <option key={row.entry.provider} value={row.entry.provider}>{row.entry.displayName}</option>
                  ))}
                </select>
              </div>
              <ProviderEditor
                key={addTarget.provider}
                provider={addTarget.provider}
                displayName={addTarget.displayName}
                hideTitle
                namespace={addNamespace}
                settingsPath={addTarget.settingsPath}
                api={api}
                t={t}
                readOnly={!state.writable}
                onClose={closeEditor}
              />
            </div>
          )
          : (
            <button
              type="button"
              className={styles['addButton']}
              disabled={addable.length === 0 || !state.writable}
              onClick={() => {
                const first = addable[0]
                /* v8 ignore next -- the button is disabled while nothing is addable */
                if (first === undefined) return
                setAdding(true)
                setEditing(targetOf(first))
              }}
            >
              {`+ ${t('add')}`}
            </button>
          )}
      </div>
    </div>
  )
}
