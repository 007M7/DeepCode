/**
 * ui-workspace contracts. Two registrations share this package:
 *
 * - WorkspaceBrowser fills the sidebar shell's `sidebar.workspaces` hole —
 *   the whole browsing region (section header, search, grouped/flat session
 *   list, workspace dialogs). It registers this package's viewing store and
 *   consumes the shell's two-fact owner share (wide / expandSidebar).
 * - WorkspacePicker fills the conversation empty-state hole (menu +
 *   create dialogs shared with the browser).
 */
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pull the owner SlotMap merges into programs that resolve the
// runtime shares below.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  DirectoryListing, DirectoryPickerKind, SessionId, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { Translate } from '@deepseek-ai/dsh-client-locale/client'
import type { createWorkspaceViewStore } from '../stores.ts'

/**
 * Directory-picking share both registrations consume: the Host's composed
 * picker interaction decides which calls the flow drives (`dialog` opens the
 * native chooser through `pickDirectory`; `browse` drives the in-app browser
 * through `listDirectory`/`createDirectory`; an unknown kind hides the
 * local-folder entry — the merge-extensible union's documented default).
 */
export type DirectoryPickingInjected = {
  /** The Host's advertised picker interaction, read per flow open. */
  directoryPickerKind: () => Promise<DirectoryPickerKind>
  /** Ask the local Host to open its native single-directory picker (`dialog`). */
  pickDirectory: () => Promise<string | null>
  /** List one directory level with breadcrumb ancestry (`browse`). */
  listDirectory: (path?: string) => Promise<DirectoryListing>
  /** Create one child directory under an existing parent (`browse`). */
  createDirectory: (path: string, name: string) => Promise<string>
  /** Localized picker copy (this package's locale namespace). */
  t: Translate
}

/**
 * Browser-private injected share (arrives via the register inject factory).
 * Data reads use the global framework hooks; these are the Host actions the
 * browsing region drives.
 */
export type WorkspaceBrowserInjected = DirectoryPickingInjected & {
  /**
   * Start a New Session in a Workspace: reuse-or-create its blank session
   * and open it; with no workspace, clear the selection into the New Session
   * pure view state (the conversation.empty seat).
   */
  startSession: (workspaceId?: WorkspaceId) => void
  /** Open a real Session. */
  open: (sessionId: SessionId) => void
  /** Rename a Host Workspace (rejects on name conflict; resolves on durability). */
  renameWorkspace: (workspaceId: WorkspaceId, title: string) => Promise<void>
  /** Delete only a Host Workspace registration; directory and Session logs remain. */
  deleteWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  /**
   * Reorder a session inside its Workspace account (DOM-insertBefore
   * semantics: omitted anchor appends to the end). The view refreshes from
   * the Host response/changed frame; failures leave the order unchanged.
   */
  insertSessionBefore: (workspaceId: WorkspaceId, sessionId: SessionId, beforeSessionId?: SessionId) => Promise<void>
  /** Explicitly create or adopt a real Workspace before targeting a Session. */
  createWorkspace: (input: { name: string } | { path: string }) => Promise<WorkspaceView>
}

/** Full browser props: shell owner share + viewing store + injected actions. */
export type WorkspaceBrowserProps =
  PropsRuntime<'sidebar.workspaces'>
  & PropsStore<ReturnType<typeof createWorkspaceViewStore>>
  & WorkspaceBrowserInjected

/**
 * Picker-private injected share. Pick semantics remain in the owner's onPick
 * callback; this callback creates only the real Host Workspace. A type alias
 * supplies the implicit index signature required by the registry.
 */
export type WorkspacePickerInjected = DirectoryPickingInjected & {
  /** Explicitly create or adopt a real Workspace before targeting a Session. */
  createWorkspace: (input: { name: string } | { path: string }) => Promise<WorkspaceView>
}

/**
 * Full picker props: the owner share plus the creation callback. The two
 * picker holes (blank-session hero / New-Session view) share one owner
 * currency, so one composed type serves both registrations.
 */
export type WorkspacePickerProps =
  PropsRuntime<'conversation.hero.workspace'> & WorkspacePickerInjected
