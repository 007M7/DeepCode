/**
 * Agent-presets settings section: the roster as cards, a copy dialog as the
 * only way a preset is created, and a read-only viewer over the shipped
 * compositions.
 *
 * The browser edits no composition text — a shipped preset opens read-only to
 * be READ (it is the known-good composition a copy starts from), and a custom
 * preset is edited in its own files, which is what the location action leads
 * to. Deleting a preset leaves running sessions alone: a composition is
 * mounted once at session creation and nothing re-reads the file.
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import {
  Button, IconBrowseOutline16, IconCopyOutline16, IconFolderOpen16, IconTrashOutline16, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { draftBlocker, type AgentPresetSectionState } from './section-store.ts'
import type { AgentPresetSettingsKey } from './locales.ts'
import css from './AgentPresetSection.module.css'

/** Registration-side business face for the management section. */
export interface AgentPresetSectionInjected {
  hooks: {
    /** Page snapshot bound by the renderer as useAgentPresetSection. */
    agentPresetSection: SnapshotStore<AgentPresetSectionState>
  }
  /** Read the roster; called once when the section first renders. */
  load: () => Promise<void>
  /** Open one shipped preset's composition in the read-only viewer. */
  view: (id: string) => Promise<void>
  /** Close the read-only viewer. */
  closeView: () => void
  /** Open the copy dialog over one preset. */
  beginCopy: (from: string) => void
  /** Close the copy dialog, discarding the draft. */
  cancelCopy: () => void
  /** Name the preset the copy creates. */
  setCopyId: (id: string) => void
  /** Name the copy's display name. */
  setCopyName: (name: string) => void
  /** Submit the copy. */
  confirmCopy: () => Promise<void>
  /** Open one preset's directory, or reveal its path where there is no desktop. */
  openLocation: (id: string) => Promise<void>
  /** Ask for delete confirmation, or dismiss it with null. */
  confirmDelete: (id: string | null) => void
  /** Delete the preset awaiting confirmation. */
  remove: () => Promise<void>
  /** Make one preset the default for sessions created later. */
  makeDefault: (id: string) => Promise<void>
}

/** Full component props. */
export type AgentPresetSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.agentPreset'>
  & InjectFace<AgentPresetSectionInjected>

/** Copy-dialog sub-view props: the draft plus the actions that mutate it. */
interface CopyDialogProps {
  state: AgentPresetSectionState
  t: (key: AgentPresetSettingsKey) => string
  actions: Pick<AgentPresetSectionInjected,
    'cancelCopy' | 'confirmCopy' | 'setCopyId' | 'setCopyName'>
}

function CopyDialog({ state, t, actions }: CopyDialogProps): ReactNode {
  const draft = state.copy
  const blocker = draft === null ? undefined : draftBlocker(draft, state.rows)
  const message = draft === null ? null : draft.error ?? (blocker === undefined ? null : t(blocker))
  return (
    <Modal
      open={draft !== null}
      onClose={() => { actions.cancelCopy() }}
      title={draft === null ? t('copyTitle') : `${t('copyTitle')} · ${t('copyOf')} ${draft.fromTitle}`}
      closeLabel={t('close')}
      description={t('copyIntro')}
      className={css.dialog as string}
      footer={(
        <>
          <Button
            variant="outline"
            disabled={draft?.saving === true}
            onClick={() => { actions.cancelCopy() }}
          >
            {t('cancel')}
          </Button>
          <Button
            disabled={draft === null || draft.saving || blocker !== undefined}
            onClick={() => { void actions.confirmCopy() }}
          >
            {draft?.saving === true ? t('creating') : t('create')}
          </Button>
        </>
      )}
    >
      {draft === null
        ? null
        : (
          <div className={css.dialogFields}>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('presetId')}</span>
              <input
                className={css.input}
                value={draft.id}
                autoFocus
                spellCheck={false}
                placeholder={t('presetIdPlaceholder')}
                onChange={(event) => { actions.setCopyId(event.target.value) }}
              />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('displayName')}</span>
              <input
                className={css.input}
                value={draft.name}
                spellCheck={false}
                placeholder={t('displayNamePlaceholder')}
                onChange={(event) => { actions.setCopyName(event.target.value) }}
              />
            </label>
            {message === null ? null : <p className={css.error} role="alert">{message}</p>}
          </div>
        )}
    </Modal>
  )
}

/**
 * Render the Agent presets section content column.
 * @param props - composed slot props.
 * @returns the section, or null when the deployment composes no presets.
 */
export function AgentPresetSection(props: AgentPresetSectionProps): ReactNode {
  const { useAgentPresetSection, t, load } = props
  const state = useAgentPresetSection(snapshot => snapshot)

  useEffect(() => {
    void load()
  }, [load])

  // A deployment that composes no presets has nothing to manage: every
  // session shares the host composition and the page would be an empty list.
  if (state.status === 'unavailable') return null
  if (state.status === 'error') {
    /* v8 ignore next -- an error status always carries text; the fallback satisfies the nullable type */
    const detail = state.error ?? ''
    return (
      <div className={css.section}>
        <p className={css.error} role="alert">{`${t('error')} ${detail}`}</p>
        <button type="button" className={css.secondaryButton} onClick={() => { void load() }}>
          {t('retry')}
        </button>
      </div>
    )
  }

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('nav')}</h2>
      <p className={css.intro}>{`${t('sectionIntro')} ${t('copyHint')}`}</p>
      {state.error === null ? null : <p className={css.error} role="alert">{state.error}</p>}
      {([['system', t('builtInGroup')], ['user', t('customGroup')]] as const).map(([trust, heading]) => {
        const group = state.rows.filter(row => row.trust === trust)
        if (group.length === 0) return null
        return (
          <section key={trust} className={css.group}>
            <h3 className={css.groupHead}>{heading}</h3>
            <ul className={css.cards}>
              {group.map(row => (
                <li key={row.id} className={row.isDefault ? `${css.card} ${css.cardActive}` : css.card}>
                  {/* The card body IS the control: picking a preset is the
                      common act, so it should not hide behind a small button.
                      The action row sits outside it — nesting buttons is
                      invalid, and these act on the card rather than select it. */}
                  <button
                    type="button"
                    className={css.cardMain}
                    aria-pressed={row.isDefault}
                    disabled={row.isDefault}
                    // Without this the name is the whole card read aloud —
                    // title, badge, description, id.
                    aria-label={`${row.isDefault ? t('inUse') : t('setDefault')}: ${row.name ?? row.id}`}
                    title={row.isDefault ? t('inUse') : t('setDefault')}
                    onClick={() => { void props.makeDefault(row.id) }}
                  >
                    <span className={css.cardHead}>
                      <span className={css.cardName}>{row.name ?? row.id}</span>
                      <span className={css.badge}>
                        {row.trust === 'user' ? t('userTrust') : t('builtIn')}
                      </span>
                      {row.isDefault ? <span className={css.inUse}>{t('inUse')}</span> : null}
                    </span>
                    <span className={css.cardDesc}>{row.description ?? t('noDescription')}</span>
                    <code className={css.cardId}>{row.id}</code>
                  </button>
                  <div className={css.cardFoot}>
                    {/* Shipped presets are the compositions a copy starts
                        from, so READING one is the point; a custom preset is
                        edited in its files instead, which the location action
                        leads to. */}
                    {row.trust === 'system'
                      ? (
                        <button
                          type="button"
                          className={css.iconButton}
                          data-tip={t('view')}
                          aria-label={`${t('view')}: ${row.name ?? row.id}`}
                          onClick={() => { void props.view(row.id) }}
                        >
                          <IconBrowseOutline16 />
                        </button>
                      )
                      : (
                        <button
                          type="button"
                          className={css.iconButton}
                          data-tip={state.hasDocument ? t('openLocation') : t('showLocation')}
                          aria-label={`${state.hasDocument ? t('openLocation') : t('showLocation')}: ${row.name ?? row.id}`}
                          onClick={() => { void props.openLocation(row.id) }}
                        >
                          <IconFolderOpen16 />
                        </button>
                      )}
                    <button
                      type="button"
                      className={css.iconButton}
                      disabled={!state.authorable}
                      data-tip={state.authorable ? t('duplicate') : t('duplicateUnavailable')}
                      aria-label={`${t('duplicate')}: ${row.name ?? row.id}`}
                      onClick={() => { props.beginCopy(row.id) }}
                    >
                      <IconCopyOutline16 />
                    </button>
                    {row.trust === 'user'
                      ? (
                        <button
                          type="button"
                          className={`${css.iconButton} ${css.iconDanger}`}
                          data-tip={t('delete')}
                          aria-label={`${t('delete')}: ${row.name ?? row.id}`}
                          onClick={() => { props.confirmDelete(row.id) }}
                        >
                          <IconTrashOutline16 />
                        </button>
                      )
                      : null}
                  </div>
                  {state.revealedPaths[row.id] === undefined
                    ? null
                    : (
                      <p className={css.revealedPath}>
                        <span className={css.revealedPathLabel}>{t('revealedPathLabel')}</span>
                        <code>{state.revealedPaths[row.id]}</code>
                      </p>
                    )}
                </li>
              ))}
            </ul>
          </section>
        )
      })}
      <CopyDialog
        state={state}
        t={t}
        actions={{
          cancelCopy: props.cancelCopy,
          confirmCopy: props.confirmCopy,
          setCopyId: props.setCopyId,
          setCopyName: props.setCopyName,
        }}
      />
      <Modal
        open={state.view !== null}
        onClose={() => { props.closeView() }}
        title={state.view === null ? '' : `${t('view')} · ${state.view.title}`}
        closeLabel={t('close')}
        description={t('composition')}
        className={css.dialog as string}
        footer={(
          <Button variant="outline" autoFocus onClick={() => { props.closeView() }}>
            {t('close')}
          </Button>
        )}
      >
        {state.view === null
          ? null
          : <pre className={css.viewerCode}>{state.view.content}</pre>}
      </Modal>
      <Modal
        open={state.pendingDelete !== null}
        onClose={() => { props.confirmDelete(null) }}
        title={t('deleteTitle')}
        closeLabel={t('close')}
        description={t('deleteDescription')}
        className={css.deleteDialog as string}
        footer={(
          <>
            <Button
              variant="outline"
              autoFocus
              disabled={state.deleting}
              onClick={() => { props.confirmDelete(null) }}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              className={css.deleteConfirm}
              disabled={state.deleting}
              onClick={() => { void props.remove() }}
            >
              {state.deleting ? t('deleting') : t('deleteConfirm')}
            </Button>
          </>
        )}
      />
    </div>
  )
}
