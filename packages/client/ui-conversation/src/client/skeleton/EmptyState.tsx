// EmptyState (figma NEW SESSION screen): centered hero — fish + title,
// workspace picker row (MenuDropdown 122:9481 + New Workspace submenu
// 419:16920 + Dialog 451:18655), then the SAME InputBar the resident
// composer uses (empty→content is a position move, never a swap). Project
// options derive in-component from useSessions; Create new runs
// createWorkspaceSession (host mkdir + session.create + open).

import { useId, useMemo, useState } from 'react'
import {
  Button,
  FishLogo,
  IconChevronDownOutline14,
  IconFolderClose16,
  IconFolderOpen16,
  IconPlusOutline16,
  Menu,
  Modal,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { EmptyStateSlotProps } from '../contract/slots.ts'
import { InputBar } from './InputBar.tsx'
import type { InputBarError } from './InputBar.tsx'
import css from './EmptyState.module.css'

/** Menu id for "New Workspace" (opens submenu; not a cwd). */
const NEW_WORKSPACE = '::new-workspace'
/** Submenu: path modal (figma 451:18655 copy). */
const USE_EXISTING = '::use-existing'
/** Submenu: create-workspace modal → mkdir + default session. */
const CREATE_NEW = '::create-new'

/** Which full-page dialog is open (null = none). */
type ModalKind = 'path' | 'create' | null

/** Full props composed by reference from the contract (runtime share & injected share; no store). */
export type EmptyStateProps = EmptyStateSlotProps

/** Deduped cwd set in list order (pure derivation over the sessions list). */
function deriveCwds(state: SessionListState): readonly string[] {
  const seen = new Set<string>()
  for (const id of state.ids) {
    const cwd = state.byId[id]?.cwd
    if (cwd !== undefined && cwd !== '') seen.add(cwd)
  }
  return [...seen]
}

/** Basename for the workspace chip / menu row; empty → the design's "New Workspace" label. */
function workspaceLabel(cwd: string): string {
  if (cwd === '') return 'New Workspace'
  const base = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop()
  return base !== undefined && base !== '' ? base : cwd
}

export function EmptyState({ useSessions, startSession, createWorkspaceSession }: EmptyStateProps) {
  const list = useSessions(s => s)
  const cwds = useMemo(() => deriveCwds(list), [list])
  // Local viewing state: the empty state owns no session, so its draft is
  // ephemeral by design (drafts are keyed by session id; there is none yet).
  const [draft, setDraft] = useState('')
  const [cwd, setCwd] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [modalKind, setModalKind] = useState<ModalKind>(null)
  const [pathDraft, setPathDraft] = useState('')
  const [workspaceName, setWorkspaceName] = useState('New WorkSpace')
  const [creating, setCreating] = useState(false)
  const [modalError, setModalError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<InputBarError | null>(null)
  // Stable filter id so multiple EmptyState mounts do not collide in the DOM.
  const glowFilterId = `empty-glow-${useId().replace(/:/g, '')}`

  const submit = (mode: 'queue' | 'steer'): void => {
    const text = draft.trim()
    /* v8 ignore next -- defensive: InputBar disables send while empty. */
    if (text === '' || sending) return
    setSending(true)
    setError(null)
    const chosen = cwd.trim()
    startSession({ text, mode, ...(chosen === '' ? {} : { cwd: chosen }) })
      .catch((reason: unknown) => {
        // The empty state survives failure with the draft intact (no session
        // exists to carry promptError; this is the only local error surface).
        setError({ op: 'send', message: reason instanceof Error ? reason.message : String(reason) })
        setSending(false)
      })
    // Success needs no cleanup: the session selection swaps this slot out for the session body.
  }

  const items: MenuEntry[] = [
    ...cwds.map(c => ({
      id: c,
      label: workspaceLabel(c),
      icon: <IconFolderClose16 size={16} />,
    })),
    ...(cwds.length > 0 ? [{ type: 'separator' as const, id: 'sep-new' }] : []),
    {
      id: NEW_WORKSPACE,
      label: 'New Workspace',
      icon: <IconPlusOutline16 size={16} />,
      submenu: [
        { id: USE_EXISTING, label: 'Use a existing folder' },
        { id: CREATE_NEW, label: 'Create new' },
      ],
    },
  ]

  const closeModal = (): void => {
    if (creating) return
    setModalKind(null)
    setModalError(null)
  }

  const openPathModal = (): void => {
    setPathDraft(cwd)
    setModalError(null)
    setModalKind('path')
  }

  const openCreateModal = (): void => {
    setWorkspaceName('New WorkSpace')
    setModalError(null)
    setModalKind('create')
  }

  const confirmPath = (): void => {
    const next = pathDraft.trim()
    if (next === '') return
    setCwd(next)
    setModalKind(null)
  }

  const confirmCreate = (): void => {
    if (creating) return
    setCreating(true)
    setModalError(null)
    createWorkspaceSession(workspaceName)
      .catch((reason: unknown) => {
        setModalError(reason instanceof Error ? reason.message : String(reason))
        setCreating(false)
      })
    // Success swaps this slot out for the new session body — no local cleanup.
  }

  const modalBusy = creating
  const isPath = modalKind === 'path'
  const isCreate = modalKind === 'create'

  return (
    <div className={css.root}>
      <div className={css.stack}>
        <div className={css.headline}>
          {/* figma 34:10412: fish 34×25 leading the headline, gap 10. */}
          <FishLogo size={34} className={css.fish} />
          Let&apos;s start building
        </div>
        <div className={css.body}>
          {/* figma 313:14109: soft ellipse behind workspace + InputBar; width
              tracks the card (glow asset 1051 vs design card 776) so blur
              scales in userSpace with it. */}
          <svg className={css.glow} viewBox="0 0 1051 468" fill="none" aria-hidden="true">
            <defs>
              <filter
                id={glowFilterId}
                x="0"
                y="0"
                width="1051"
                height="468"
                filterUnits="userSpaceOnUse"
                colorInterpolationFilters="sRGB"
              >
                <feFlood floodOpacity="0" result="BackgroundImageFix" />
                <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
                <feGaussianBlur stdDeviation="50" result="effect1_foregroundBlur" />
              </filter>
            </defs>
            <g filter={`url(#${glowFilterId})`}>
              <ellipse cx="525.5" cy="234" rx="425.5" ry="134" fill="#6187D8" fillOpacity="0.1" />
            </g>
          </svg>
          <div className={css.workspaceRow}>
            <Menu
              open={menuOpen}
              onClose={() => { setMenuOpen(false) }}
              {...(cwd !== '' ? { selectedId: cwd } : {})}
              items={items}
              side="top"
              className={css.workspaceMenu!}
              onSelect={(id) => {
                if (id === USE_EXISTING) {
                  setMenuOpen(false)
                  openPathModal()
                  return
                }
                if (id === CREATE_NEW) {
                  setMenuOpen(false)
                  openCreateModal()
                  return
                }
                setCwd(id)
                setMenuOpen(false)
              }}
              anchor={(
                <button
                  type="button"
                  className={css.workspace}
                  aria-label="项目目录"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => { setMenuOpen(!menuOpen) }}
                >
                  <IconFolderOpen16 className={css.folder} size={16} />
                  <span className={css.workspaceLabel}>{workspaceLabel(cwd)}</span>
                  <IconChevronDownOutline14 className={css.chevron} size={12} />
                </button>
              )}
            />
          </div>
          <InputBar
            draft={draft}
            running={false}
            disabled={sending}
            error={error}
            variant="hero"
            placeholder="Message to run task, plan and build, enter for / commands"
            onDraftChange={setDraft}
            onSend={submit}
            /* v8 ignore next -- structural noop: hero never passes running=true, so stop is unreachable. */
            onStop={() => {}}
          />
        </div>
      </div>
      <Modal
        open={isPath}
        onClose={closeModal}
        title="Enter an existing folder path"
        footer={(
          <>
            <Button variant="outline" className={css.modalAction!} onClick={closeModal}>Cancel</Button>
            <Button
              variant="primary"
              className={css.modalAction!}
              disabled={pathDraft.trim() === ''}
              onClick={confirmPath}
            >
              Open Folder
            </Button>
          </>
        )}
      >
        <input
          className={css.modalInput}
          value={pathDraft}
          aria-label="Folder path"
          autoFocus
          placeholder="ex. User/Documents/Harness/Space"
          onChange={(e) => { setPathDraft(e.target.value) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              confirmPath()
            }
          }}
        />
      </Modal>
      <Modal
        open={isCreate}
        onClose={closeModal}
        title="Create new workspace"
        footer={(
          <>
            <Button variant="outline" className={css.modalAction!} disabled={modalBusy} onClick={closeModal}>
              Cancel
            </Button>
            <Button
              variant="primary"
              className={css.modalAction!}
              disabled={modalBusy || workspaceName.trim() === ''}
              onClick={confirmCreate}
            >
              Create
            </Button>
          </>
        )}
      >
        <input
          className={css.modalInput}
          value={workspaceName}
          aria-label="Workspace name"
          autoFocus
          disabled={modalBusy}
          onChange={(e) => { setWorkspaceName(e.target.value) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              confirmCreate()
            }
          }}
        />
        {modalError !== null && <div className={css.modalError} role="alert">{modalError}</div>}
      </Modal>
    </div>
  )
}
