/**
 * Agent-presets settings section: the roster as rows, and one composition
 * open in a YAML editor at a time.
 *
 * A shipped preset opens read-only — it is the known-good composition a local
 * one is written against — so authoring starts by duplicating one. Deleting a
 * preset leaves running sessions alone: a composition is mounted once at
 * session creation and nothing re-reads the file.
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import {
  Button, IconBrowseOutline16, IconCopyOutline16, IconEditOutline16, IconTrashOutline16, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { draftBlocker, type AgentPresetSectionState, type PresetDraft } from './section-store.ts'
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
  /** Open one preset's composition in the editor. */
  open: (id: string) => Promise<void>
  /** Open a copy of one preset — or of the default — as a new preset. */
  createFrom: (from?: string) => Promise<void>
  /** Close the editor, discarding the draft. */
  close: () => void
  /** Name the preset a new draft saves to. */
  setId: (id: string) => void
  /** Replace the draft's composition text. */
  setContent: (content: string) => void
  /** Rename the draft. */
  setName: (name: string) => void
  /** Replace the draft's description. */
  setDescription: (description: string) => void
  /** Save the open draft. */
  save: () => Promise<void>
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

/** Editor sub-view props: the draft plus the actions that mutate it. */
interface EditorProps {
  draft: PresetDraft
  blocker: ReturnType<typeof draftBlocker>
  t: (key: AgentPresetSettingsKey) => string
  actions: Pick<AgentPresetSectionInjected,
    'close' | 'save' | 'setContent' | 'setDescription' | 'setId' | 'setName'>
}

function Editor({ draft, blocker, t, actions }: EditorProps): ReactNode {
  const message = draft.error ?? (blocker === undefined ? null : t(blocker))
  return (
    <div className={css.editor}>
      {draft.creating
        ? (
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('presetId')}</span>
            <input
              className={css.input}
              value={draft.id}
              autoFocus
              spellCheck={false}
              placeholder={t('presetIdPlaceholder')}
              onChange={(event) => { actions.setId(event.target.value) }}
            />
            {draft.source === undefined
              ? null
              : <span className={css.hint}>{`${t('copyOf')} ${draft.source}`}</span>}
          </label>
        )
        : null}
      {draft.writable
        ? (
          <>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('displayName')}</span>
              <input
                className={css.input}
                value={draft.name}
                spellCheck={false}
                placeholder={draft.id === '' ? t('displayNamePlaceholder') : draft.id}
                onChange={(event) => { actions.setName(event.target.value) }}
              />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('displayDescription')}</span>
              <input
                className={css.input}
                value={draft.description}
                placeholder={t('displayDescriptionPlaceholder')}
                onChange={(event) => { actions.setDescription(event.target.value) }}
              />
            </label>
          </>
        )
        : null}
      {draft.writable ? null : <p className={css.notice}>{t('readOnlyNotice')}</p>}
      <label className={`${css.field} ${css.codeField}`}>
        <span className={css.fieldLabel}>{t('composition')}</span>
        <textarea
          className={css.code}
          value={draft.content}
          readOnly={!draft.writable}
          spellCheck={false}
          rows={16}
          onChange={(event) => { actions.setContent(event.target.value) }}
        />
      </label>
      {message === null ? null : <p className={css.error} role="alert">{message}</p>}
      {/* Read-only has nothing to commit or abandon, and leaving is already the
          back link above — a lone Close button would be a second way out. */}
      {draft.writable
        ? (
          <div className={css.editorActions}>
            <Button variant="outline" disabled={draft.saving} onClick={() => { actions.close() }}>
              {t('cancel')}
            </Button>
            <Button
              disabled={draft.saving || blocker !== undefined}
              onClick={() => { void actions.save() }}
            >
              {draft.saving ? t('saving') : t('save')}
            </Button>
          </div>
        )
        : null}
    </div>
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

  const { draft } = state
  const blocker = draft === null ? undefined : draftBlocker(draft, state.rows)
  // Editing replaces the list rather than hanging off the end of it: the form
  // is tall, and a column of the card grid is far too narrow to hold it.
  if (draft !== null) {
    const editorActions = {
      close: props.close,
      save: props.save,
      setContent: props.setContent,
      setDescription: props.setDescription,
      setId: props.setId,
      setName: props.setName,
    }
    return (
      <div className={`${css.section} ${css.sectionFill}`}>
        <div className={css.editorBar}>
          <button type="button" className={css.backButton} onClick={() => { props.close() }}>
            {`← ${t('backToList')}`}
          </button>
          <span className={css.editorTitle}>
            {draft.creating
              ? (draft.source === undefined ? t('newPreset') : `${t('newPreset')} · ${t('copyOf')} ${draft.source}`)
              : `${draft.writable ? t('edit') : t('view')} · ${draft.name === '' ? draft.id : draft.name}`}
          </span>
        </div>
        <Editor draft={draft} blocker={blocker} t={t} actions={editorActions} />
      </div>
    )
  }

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('nav')}</h2>
      <p className={css.intro}>{t('sectionIntro')}</p>
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
                    <button
                      type="button"
                      className={css.iconButton}
                      data-tip={row.trust === 'user' ? t('edit') : t('view')}
                      aria-label={row.trust === 'user' ? t('edit') : t('view')}
                      onClick={() => { void props.open(row.id) }}
                    >
                      {row.trust === 'user' ? <IconEditOutline16 /> : <IconBrowseOutline16 />}
                    </button>
                    {state.authorable
                      ? (
                        <button
                          type="button"
                          className={css.iconButton}
                          data-tip={t('duplicate')}
                          aria-label={t('duplicate')}
                          onClick={() => { void props.createFrom(row.id) }}
                        >
                          <IconCopyOutline16 />
                        </button>
                      )
                      : null}
                    {row.trust === 'user'
                      ? (
                        <button
                          type="button"
                          className={`${css.iconButton} ${css.iconDanger}`}
                          data-tip={t('delete')}
                          aria-label={t('delete')}
                          onClick={() => { props.confirmDelete(row.id) }}
                        >
                          <IconTrashOutline16 />
                        </button>
                      )
                      : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
      {(
        <button
          type="button"
          className={css.addButton}
          disabled={!state.authorable || state.rows.length === 0}
          onClick={() => { void props.createFrom() }}
        >
          {`+ ${t('newPreset')}`}
        </button>
      )}
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
