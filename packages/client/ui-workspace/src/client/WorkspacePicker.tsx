/**
 * Workspace pick/create flow. WorkspaceCreateFlow is the reusable core
 * (menu + path/create dialogs) consumed directly by WorkspaceBrowser (same
 * package) and wrapped by WorkspacePicker for the conversation empty-state
 * slot registration. Directory picking itself lives in the composed flow
 * package's slot occupant (see the contract module doc): this core only
 * opens the flow, adopts the picked path, and owns the error surface.
 */
import type { ReactNode, RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button, IconFolderClose16, IconPlusOutline16, Menu, Modal, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  WorkspaceCreateError,
  type WorkspaceId, type WorkspaceListState, type WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryFlowOwnerProps, WorkspacePickerProps } from './contract/slots.ts'
import css from './WorkspacePicker.module.css'

const OPEN_LOCAL_FOLDER = '::open-local-folder'
const CREATE_NEW = '::create-new'

type ModalKind = 'create' | 'folder-error' | null

/** Core flow props: the owner supplies popover control and pick semantics. */
export interface WorkspaceCreateFlowProps {
  /** The standard locale seat, forwarded by whichever slot entry hosts the flow. */
  t: WorkspacePickerProps['t']
  /** Popover visibility (anchor button toggle state, owner-local). */
  open: boolean
  /** The anchor button element — the popover's placement anchor. */
  anchorRef?: RefObject<HTMLElement | null> | undefined
  /** Selector hook over the workspace list (framework standard hook). */
  useWorkspaces: <S>(selector: (state: WorkspaceListState) => S) => S
  /** Create or adopt a real Host Workspace. */
  createWorkspace: (input: { name: string } | { path: string }) => Promise<WorkspaceView>
  /** Bound occupancy selector hook for this surface's directory-flow hole (empty hides the local-folder entry). */
  useDirectoryFlow: SnapshotSelectorHook<boolean>
  /** Render this surface's directory-flow hole with the owner conversation (the entry's narrowed renderSlot). */
  renderDirectoryFlow: (owner: DirectoryFlowOwnerProps) => ReactNode
  /** A real Workspace was picked or created. */
  onPick: (workspaceId: WorkspaceId) => void
  /** Close the popover (outside click / Escape / post-pick). */
  onClose: () => void
  /** Only show create actions (open folder / create new), hide existing workspaces. */
  createOnly?: boolean
  /** Menu opening direction relative to the anchor. */
  side?: 'bottom' | 'top' | 'right'
  /** Currently active workspace (trailing check in the picker list). */
  selectedId?: WorkspaceId | undefined
}

/**
 * Render the pick menu plus the two create dialogs.
 * @param props - owner-controlled flow props.
 * @returns menu + dialog elements.
 */
export function WorkspaceCreateFlow({
  t,
  open,
  anchorRef,
  useWorkspaces,
  createWorkspace,
  useDirectoryFlow,
  renderDirectoryFlow,
  onPick,
  onClose,
  createOnly = false,
  side = 'bottom',
  selectedId,
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
  const [flowOpen, setFlowOpen] = useState(false)
  const [pickingFolder, setPickingFolder] = useState(false)
  const [folderConflict, setFolderConflict] = useState(false)
  const composingRef = useRef(false)
  // One picking interaction at a time: while the flow is open (native chooser
  // pending, browse dialog up) or its pick is being adopted, every other
  // menu action stays disabled — a late outcome must not race a concurrent
  // selection or creation.
  const flowBusy = flowOpen || pickingFolder
  const normalizedWorkspaceName = workspaceName.trim()
  const duplicateWorkspaceName = !creating && normalizedWorkspaceName !== ''
    && workspaces.some(workspace => workspace.title === normalizedWorkspaceName)

  // The occupied hole gates the picking affordance: with no composed flow the
  // entry simply is not there (the seam's documented no-flow default). The
  // framework-bound hook keeps occupancy live: flow plugins activate (and
  // HMR-reload) independently of this menu's renders.
  const flowAvailable = useDirectoryFlow(occupied => occupied)
  // An occupant that unloads mid-interaction leaves nobody to cancel: an
  // open flow over an empty hole withdraws so the menu actions come back.
  // flowOpen is a dependency because the flow can also OPEN over an already
  // empty hole (Choose again after the occupant unloaded with the error
  // dialog up) — that transition must snap back too, not just occupancy loss.
  useEffect(() => {
    if (flowOpen && !flowAvailable) setFlowOpen(false)
  }, [flowOpen, flowAvailable])
  const createEntries: MenuEntry[] = [
    ...(flowAvailable
      ? [{ id: OPEN_LOCAL_FOLDER, label: t('menu.openFolder'), icon: <IconFolderClose16 size={16} />, disabled: flowBusy }]
      : []),
    { id: CREATE_NEW, label: t('menu.createWorkspace'), icon: <IconPlusOutline16 size={16} />, disabled: flowBusy },
  ]
  // With workspaces listed, the create actions pin below the scroll region
  // (divider + always visible); otherwise they ARE the menu.
  const pinCreate = !createOnly && workspaces.length > 0
  const items: MenuEntry[] = pinCreate
    ? workspaces.map(workspace => ({
      id: workspace.workspaceId,
      label: workspace.title,
      icon: <IconFolderClose16 size={16} />,
      disabled: flowBusy,
    }))
    : createEntries

  const closeModal = (): void => {
    if (creating) return
    setModalKind(null)
    setModalError(null)
  }

  /** Adopt a picked directory; failures land in the folder-error dialog (Choose again reopens the flow). */
  const adoptDirectory = (path: string): Promise<void> =>
    createWorkspace({ path }).then((workspace) => {
      setFlowOpen(false)
      onPick(workspace.workspaceId)
    }).catch((reason: unknown) => {
      setFolderConflict(
        reason instanceof WorkspaceCreateError
        && reason.rpcError.code === 'workspace-name-conflict',
      )
      setModalError(reason instanceof Error ? reason.message : String(reason))
      setFlowOpen(false)
      setModalKind('folder-error')
    })

  const openLocalFolder = (): void => {
    onClose()
    setModalKind(null)
    setModalError(null)
    setFolderConflict(false)
    setFlowOpen(true)
  }

  /** Owner side of the flow conversation: adopt keeps the flow open (busy) until the Host answers. */
  const flowOwner: DirectoryFlowOwnerProps = {
    open: flowOpen,
    busy: pickingFolder,
    onPicked: (path) => {
      setPickingFolder(true)
      void adoptDirectory(path).finally(() => { setPickingFolder(false) })
    },
    onCancel: () => { setFlowOpen(false) },
    onError: (message) => {
      setFlowOpen(false)
      setFolderConflict(false)
      setModalError(message)
      setModalKind('folder-error')
    },
  }

  const handleSelect = (id: string): void => {
    if (id === OPEN_LOCAL_FOLDER) {
      openLocalFolder()
      return
    }
    if (id === CREATE_NEW) {
      onClose()
      setWorkspaceName('')
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
        {...pinCreate ? { footer: createEntries } : {}}
        selectedId={selectedId}
        onSelect={handleSelect}
        onClose={onClose}
        side={side}
        portal
        getAnchorRect={getAnchorRect}
      />
      {open && workspaceSnapshot.phase === 'pending' && <div className={css.menuStatus} role="status">{t('picker.loading')}</div>}
      {renderDirectoryFlow(flowOwner)}
      <Modal
        open={modalKind === 'folder-error'}
        onClose={closeModal}
        closeLabel={t('close')}
        title={folderConflict ? t('conflict.title') : t('folderError.title')}
        footer={(
          <>
            <Button variant="outline" className={css.modalAction} onClick={closeModal}>{t('cancel')}</Button>
            {/* Retrying needs an occupant to serve the flow; without one the
              * button would open a flow nobody can answer or cancel. */}
            <Button variant="primary" className={css.modalAction} disabled={!flowAvailable} onClick={openLocalFolder}>{t('folderError.retry')}</Button>
          </>
        )}
      >
        <div className={css.modalError} role="alert">
          {folderConflict
            ? t('conflict.hint')
            : modalError}
        </div>
      </Modal>
      <Modal
        open={modalKind === 'create'}
        onClose={closeModal}
        closeLabel={t('close')}
        title={t('menu.createWorkspace')}
        description={t('create.desc')}
        footer={(
          <>
            <Button variant="outline" className={css.modalAction} disabled={creating} onClick={closeModal}>{t('cancel')}</Button>
            <Button
              variant="primary"
              className={css.modalAction}
              disabled={creating || normalizedWorkspaceName === '' || duplicateWorkspaceName}
              onClick={confirmCreate}
            >
              {t('create.confirm')}
            </Button>
          </>
        )}
      >
        <input
          className={css.modalInput}
          value={workspaceName}
          placeholder={t('field.workspaceName')}
          aria-label={t('create.name.aria')}
          autoFocus
          disabled={creating}
          onChange={(event) => { setWorkspaceName(event.target.value); setModalError(null) }}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !composingRef.current) {
              event.preventDefault()
              confirmCreate()
            }
          }}
        />
        {creating && <div className={css.modalStatus} role="status">{t('create.pending')}</div>}
        {duplicateWorkspaceName && (
          <div className={css.modalError} role="alert">{t('conflict.named', { name: normalizedWorkspaceName })}</div>
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
  selectedId,
  onPick,
  onClose,
  createWorkspace,
  useDirectoryFlow,
  renderSlot,
  t,
}: WorkspacePickerProps) {
  return (
    <WorkspaceCreateFlow
      t={t}
      open={open}
      anchorRef={anchorRef}
      useWorkspaces={useWorkspaces}
      createWorkspace={createWorkspace}
      useDirectoryFlow={useDirectoryFlow}
      renderDirectoryFlow={owner => renderSlot('conversation.hero.workspace.directoryFlow', owner)}
      selectedId={selectedId}
      onPick={onPick}
      onClose={onClose}
    />
  )
}
