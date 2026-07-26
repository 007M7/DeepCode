/**
 * Workspace pick/create flow. WorkspaceCreateFlow is the reusable core
 * (menu + path/create dialogs) consumed directly by WorkspaceBrowser (same
 * package) and wrapped by WorkspacePicker for the conversation empty-state
 * slot registration.
 */
import type { RefObject } from 'react'
import { useCallback, useState } from 'react'
import {
  Button, IconFolderClose16, IconPlusOutline16, Menu, Modal, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceId, WorkspaceListState, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspacePickerProps } from './contract/slots.ts'
import css from './WorkspacePicker.module.css'

const CREATE_WORKSPACE = '::create-workspace'
const USE_EXISTING = '::use-existing'
const CREATE_NEW = '::create-new'

type ModalKind = 'path' | 'create' | null

/** Core flow props: the owner supplies popover control and pick semantics. */
export interface WorkspaceCreateFlowProps {
  /** Popover visibility (anchor button toggle state, owner-local). */
  open: boolean
  /** The anchor button element — the popover's placement anchor. */
  anchorRef?: RefObject<HTMLElement | null> | undefined
  /** Selector hook over the workspace list (framework standard hook). */
  useWorkspaces: <S>(selector: (state: WorkspaceListState) => S) => S
  /** Create or adopt a real Host Workspace. */
  createWorkspace: (input: { name: string } | { path: string }) => Promise<WorkspaceView>
  /** A real Workspace was picked or created. */
  onPick: (workspaceId: WorkspaceId) => void
  /** Close the popover (outside click / Escape / post-pick). */
  onClose: () => void
}

/**
 * Render the pick menu plus the two create dialogs.
 * @param props - owner-controlled flow props.
 * @returns menu + dialog elements.
 */
export function WorkspaceCreateFlow({
  open,
  anchorRef,
  useWorkspaces,
  createWorkspace,
  onPick,
  onClose,
}: WorkspaceCreateFlowProps) {
  const workspaceSnapshot = useWorkspaces(state => state)
  const workspaces = workspaceSnapshot.items
  const getAnchorRect = useCallback(
    () => anchorRef?.current?.getBoundingClientRect() ?? null,
    [anchorRef],
  )
  const [modalKind, setModalKind] = useState<ModalKind>(null)
  const [pathDraft, setPathDraft] = useState('')
  const [workspaceName, setWorkspaceName] = useState('')
  const [creating, setCreating] = useState(false)
  const [modalError, setModalError] = useState<string | null>(null)
  const normalizedWorkspaceName = workspaceName.trim()
  const duplicateWorkspaceName = normalizedWorkspaceName !== ''
    && workspaces.some(workspace => workspace.title === normalizedWorkspaceName)

  const items: MenuEntry[] = [
    ...workspaces.map(workspace => ({
      id: workspace.workspaceId as string,
      label: workspace.title,
      icon: <IconFolderClose16 size={16} />,
    })),
    ...(workspaces.length > 0 ? [{ type: 'separator' as const, id: 'sep-create' }] : []),
    {
      id: CREATE_WORKSPACE,
      label: 'Create workspace',
      icon: <IconPlusOutline16 size={16} />,
      submenu: [
        { id: USE_EXISTING, label: 'Use an existing folder' },
        { id: CREATE_NEW, label: 'Create a new workspace' },
      ],
    },
  ]

  const closeModal = (): void => {
    if (creating) return
    setModalKind(null)
    setModalError(null)
  }

  const handleSelect = (id: string): void => {
    if (id === USE_EXISTING) {
      onClose()
      setPathDraft('')
      setModalError(null)
      setModalKind('path')
      return
    }
    if (id === CREATE_NEW) {
      onClose()
      setWorkspaceName('workspace')
      setModalError(null)
      setModalKind('create')
      return
    }
    onPick(id as WorkspaceId)
  }

  const create = (input: { name: string } | { path: string }): void => {
    if (creating) return
    setCreating(true)
    setModalError(null)
    void createWorkspace(input).then((workspace) => {
      setCreating(false)
      setModalKind(null)
      onPick(workspace.workspaceId)
    }).catch((reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason)
      setModalError(`Workspace creation failed: ${message}`)
      setCreating(false)
    })
  }

  const confirmPath = (): void => {
    const path = pathDraft.trim()
    if (path !== '') create({ path })
  }

  const confirmCreate = (): void => {
    if (normalizedWorkspaceName !== '' && !duplicateWorkspaceName) {
      create({ name: normalizedWorkspaceName })
    }
  }

  return (
    <>
      <Menu
        open={open}
        anchor={null}
        items={items}
        onSelect={handleSelect}
        onClose={onClose}
        portal
        getAnchorRect={getAnchorRect}
      />
      {open && workspaceSnapshot.phase === 'pending' && <div className={css.menuStatus} role="status">Loading workspaces…</div>}
      <Modal
        open={modalKind === 'path'}
        onClose={closeModal}
        title="Use an existing folder"
        footer={(
          <>
            <Button variant="outline" className={css.modalAction!} disabled={creating} onClick={closeModal}>Cancel</Button>
            <Button
              variant="primary"
              className={css.modalAction!}
              disabled={creating || pathDraft.trim() === ''}
              onClick={confirmPath}
            >
              Use folder
            </Button>
          </>
        )}
      >
        <input
          className={css.modalInput}
          value={pathDraft}
          aria-label="Existing folder path"
          autoFocus
          disabled={creating}
          placeholder="/path/to/project"
          onChange={(event) => { setPathDraft(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              confirmPath()
            }
          }}
        />
        {creating && <div className={css.modalStatus} role="status">Creating workspace…</div>}
        {modalError !== null && <div className={css.modalError} role="alert">{modalError}</div>}
      </Modal>
      <Modal
        open={modalKind === 'create'}
        onClose={closeModal}
        title="Create a new workspace"
        description="The name is used for both the workspace and its new folder."
        footer={(
          <>
            <Button variant="outline" className={css.modalAction!} disabled={creating} onClick={closeModal}>Cancel</Button>
            <Button
              variant="primary"
              className={css.modalAction!}
              disabled={creating || normalizedWorkspaceName === '' || duplicateWorkspaceName}
              onClick={confirmCreate}
            >
              Create workspace
            </Button>
          </>
        )}
      >
        <input
          className={css.modalInput}
          value={workspaceName}
          aria-label="New workspace name"
          autoFocus
          disabled={creating}
          onChange={(event) => { setWorkspaceName(event.target.value); setModalError(null) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              confirmCreate()
            }
          }}
        />
        {creating && <div className={css.modalStatus} role="status">Creating workspace…</div>}
        {duplicateWorkspaceName && (
          <div className={css.modalError} role="alert">A workspace named “{normalizedWorkspaceName}” already exists.</div>
        )}
        {modalError !== null && <div className={css.modalError} role="alert">{modalError}</div>}
      </Modal>
    </>
  )
}

/**
 * The conversation empty-state registration: adapts the owner share to the
 * core flow (all state and semantics live in the flow / the owner).
 * @param props - empty-state slot props (owner share + injected creation callback).
 * @returns the flow element.
 */
export function WorkspacePicker({
  open,
  anchorRef,
  useWorkspaces,
  onPick,
  onClose,
  createWorkspace,
}: WorkspacePickerProps) {
  return (
    <WorkspaceCreateFlow
      open={open}
      anchorRef={anchorRef}
      useWorkspaces={useWorkspaces}
      createWorkspace={createWorkspace}
      onPick={onPick}
      onClose={onClose}
    />
  )
}
