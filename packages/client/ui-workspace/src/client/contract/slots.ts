/**
 * Shared Workspace picker contract for the sidebar and page-local Session Intent hero
 * slots. Each runtime share provides its owner's popover controls plus the
 * global useWorkspaces hook; this package adds the injected Host Workspace
 * creation callback.
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pull both owner SlotMap merges into programs that resolve the
// picker runtime union below.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Registrant-private injected share. Pick semantics remain in each owner's
 * onPick callback; this callback creates only the real Host Workspace. A type
 * alias supplies the implicit index signature required by the registry.
 */
export type WorkspacePickerInjected = {
  /** Explicitly create or adopt a real Workspace before targeting a Session. */
  createWorkspace(input: { name: string } | { path: string }): Promise<WorkspaceView>
}

/**
 * Full picker props: either owner's runtime share, including useWorkspaces,
 * plus this package's injected creation callback.
 */
export type WorkspacePickerProps =
  (PropsRuntime<'sidebar.workspace'> | PropsRuntime<'conversation.empty.workspace'>)
  & WorkspacePickerInjected
