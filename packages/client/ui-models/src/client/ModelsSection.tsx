/**
 * Models settings section: the provider rows joined from the configurable
 * directory, settings namespaces, and credential states, with one editor
 * card at a time (edit an existing provider or add a dormant one). Every
 * mutation writes through the wire; the page re-renders from the pushed
 * invalidations or the post-apply reload.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient, SettingsNamespaceView } from '@deepseek-ai/dsh-client-connection/client'
import { deletePath } from '@deepseek-ai/dsh-client-schema-form'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
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
  /** Wire faces the editor and credential control write through. */
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
  settingsNs: string
  settingsPath: readonly string[]
}

/**
 * Remove one user-added provider profile from its namespace's user section
 * (wholesale replace — merge cannot express a removal) and reload on success.
 * @param api - settings wire face.
 * @param controller - the page store to refresh.
 * @param target - the provider's settings address.
 * @param namespace - the owning namespace view.
 * @returns settles when the write and any reload finished.
 */
export async function removeProviderProfile(
  api: Pick<IApiClient, 'settings'>,
  controller: ModelsSettingsStore,
  target: { settingsNs: string; settingsPath: readonly string[] },
  namespace: SettingsNamespaceView,
): Promise<void> {
  const user = structuredClone((namespace.user ?? {}) as Record<string, unknown>)
  const next = deletePath(user, [...target.settingsPath])
  const response = await api.settings.replace({ ns: target.settingsNs, section: next })
  if (response.result.ok) await controller.load()
}

function StatusBadges({ row, t }: { row: ProviderRow; t: ModelsSectionInjected['t'] }): ReactNode {
  return (
    <span className={styles['badges']}>
      {row.entry.active
        ? <span className={styles['badgeOk']}>{t('active')}</span>
        : <span className={styles['badgeMuted']}>{t('dormant')}</span>}
      {!row.literalApiKeyConfigured && row.credential !== undefined && !row.credential.configured
        ? <span className={styles['badgeWarn']}>{t('keyMissing')}</span>
        : null}
    </span>
  )
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
          const target: EditorTarget = {
            provider: row.entry.provider,
            settingsNs: row.entry.settingsNs,
            settingsPath: row.entry.settingsPath,
          }
          const open = !adding && editing?.provider === row.entry.provider
          const namespace = state.namespaces.get(target.settingsNs)
          /* v8 ignore next -- the join marks a row configured only when its namespace resolved */
          if (namespace === undefined) return null
          return (
            <li key={row.entry.provider} className={styles['rowCard']}>
              <div className={styles['rowHead']}>
                <span className={styles['rowName']}>{row.entry.displayName}</span>
                <StatusBadges row={row} t={t} />
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
                        onClick={() => { void removeProviderProfile(api, controller, target, namespace) }}
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
            <ProviderEditor
              provider={addTarget.provider}
              namespace={addNamespace}
              settingsPath={addTarget.settingsPath}
              api={api}
              t={t}
              readOnly={!state.writable}
              onClose={closeEditor}
            />
          )
          : (
            <select
              className={styles['addSelect']}
              value=""
              disabled={addable.length === 0 || !state.writable}
              aria-label={t('add')}
              onChange={(event) => {
                const row = addable.find(candidate => candidate.entry.provider === event.target.value)
                if (row === undefined) return
                setAdding(true)
                setEditing({
                  provider: row.entry.provider,
                  settingsNs: row.entry.settingsNs,
                  settingsPath: row.entry.settingsPath,
                })
              }}
            >
              <option value="">{`+ ${t('add')}`}</option>
              {addable.map(row => (
                <option key={row.entry.provider} value={row.entry.provider}>{row.entry.displayName}</option>
              ))}
            </select>
          )}
      </div>
    </div>
  )
}
