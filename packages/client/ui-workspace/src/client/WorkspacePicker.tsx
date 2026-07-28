/**
 * Workspace pick/create flow. WorkspaceCreateFlow is the reusable core
 * (menu + path/create dialogs) consumed directly by WorkspaceBrowser (same
 * package) and wrapped by WorkspacePicker for the conversation empty-state
 * slot registration.
 */
import type { RefObject } from 'react'
import { useCallback, useEffect, useState } from 'react'
import {
  Button, IconFolderClose16, IconPlusOutline16, Menu, Modal, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  WorkspaceCreateError,
  type DirectoryPickerKind, type WorkspaceId, type WorkspaceListState, type WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspacePickerProps } from './contract/slots.ts'
import css from './WorkspacePicker.module.css'

const OPEN_LOCAL_FOLDER = '::open-local-folder'
const CREATE_NEW = '::create-new'

type ModalKind = 'create' | 'folder-error' | null

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
  /** Open the Host's native single-directory picker. */
  pickDirectory: () => Promise<string | null>
  /** The Host's advertised picker interaction (read per flow open); gates which picking affordance renders. */
  directoryPickerKind: () => Promise<DirectoryPickerKind>
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
  pickDirectory,
  directoryPickerKind,
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
  const [workspaceName, setWorkspaceName] = useState('')
  const [creating, setCreating] = useState(false)
  const [modalError, setModalError] = useState<string | null>(null)
  const [pickingFolder, setPickingFolder] = useState(false)
  const [folderConflict, setFolderConflict] = useState(false)
  const normalizedWorkspaceName = workspaceName.trim()
  const duplicateWorkspaceName = !creating && normalizedWorkspaceName !== ''
    && workspaces.some(workspace => workspace.title === normalizedWorkspaceName)

  // The advertised interaction gates the picking affordance: 'dialog' is the
  // only kind pickDirectory() can serve, so its entry renders under that kind
  // alone; 'browse' (until the in-app browser UI lands) and unknown kinds
  // hide the entry, the seam's documented unknown-kind default. Re-read per
  // flow open — no cache to go stale across reconnects.
  const [dialogPicker, setDialogPicker] = useState(false)
  useEffect(() => {
    if (!open) {
      // Close discards the answer: a reconnect or HMR can swap the composed
      // backend while the menu is closed, and the reopened menu must never
      // paint the previous host's entry before the fresh read lands.
      setDialogPicker(false)
      return
    }
    // Reset before each read: the injected reader can also change identity
    // while the flow stays open, and that prior answer must not leak either;
    // a settlement from a superseded read is discarded via the
    // cleanup-toggled flag.
    setDialogPicker(false)
    let stale = false
    void directoryPickerKind()
      .then((kind) => { if (!stale) setDialogPicker(kind === 'dialog') })
      // A failed describe hides the entry too: the same Host that cannot
      // answer describe cannot serve pickDirectory.
      .catch(() => { if (!stale) setDialogPicker(false) })
    return () => { stale = true }
  }, [open, directoryPickerKind])

  const items: MenuEntry[] = [
    ...workspaces.map(workspace => ({
      id: workspace.workspaceId,
      label: workspace.title,
      icon: <IconFolderClose16 size={16} />,
      disabled: pickingFolder,
    })),
    ...(workspaces.length > 0 ? [{ type: 'separator' as const, id: 'sep-create' }] : []),
    ...(dialogPicker
      ? [{ id: OPEN_LOCAL_FOLDER, label: 'Open local folder…', icon: <IconFolderClose16 size={16} />, disabled: pickingFolder }]
      : []),
    { id: CREATE_NEW, label: 'Create a new workspace', icon: <IconPlusOutline16 size={16} />, disabled: pickingFolder },
  ]

  const closeModal = (): void => {
    if (creating) return
    setModalKind(null)
    setModalError(null)
  }

  const openLocalFolder = (): void => {
    onClose()
    setModalKind(null)
    setModalError(null)
    setFolderConflict(false)
    setPickingFolder(true)
    void pickDirectory().then(async (path) => {
      if (path === null) return
      const workspace = await createWorkspace({ path })
      onPick(workspace.workspaceId)
    }).catch((reason: unknown) => {
      setFolderConflict(
        reason instanceof WorkspaceCreateError
        && reason.rpcError.code === 'workspace-name-conflict',
      )
      setModalError(reason instanceof Error ? reason.message : String(reason))
      setModalKind('folder-error')
    }).finally(() => { setPickingFolder(false) })
  }

  const handleSelect = (id: string): void => {
    if (id === OPEN_LOCAL_FOLDER) {
      openLocalFolder()
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
        open={modalKind === 'folder-error'}
        onClose={closeModal}
        title={folderConflict ? 'A workspace with this name already exists' : 'Couldn’t open folder'}
        footer={(
          <>
            <Button variant="outline" className={css.modalAction} onClick={closeModal}>Cancel</Button>
            <Button variant="primary" className={css.modalAction} onClick={openLocalFolder}>Choose again</Button>
          </>
        )}
      >
        <div className={css.modalError} role="alert">
          {folderConflict
            ? 'Choose a folder with a different name.'
            : modalError}
        </div>
      </Modal>
      <Modal
        open={modalKind === 'create'}
        onClose={closeModal}
        title="Create a new workspace"
        description="The name is used for both the workspace and its new folder."
        footer={(
          <>
            <Button variant="outline" className={css.modalAction} disabled={creating} onClick={closeModal}>Cancel</Button>
            <Button
              variant="primary"
              className={css.modalAction}
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
  pickDirectory,
  directoryPickerKind,
}: WorkspacePickerProps) {
  return (
    <WorkspaceCreateFlow
      open={open}
      anchorRef={anchorRef}
      useWorkspaces={useWorkspaces}
      createWorkspace={createWorkspace}
      pickDirectory={pickDirectory}
      directoryPickerKind={directoryPickerKind}
      onPick={onPick}
      onClose={onClose}
    />
  )
}
