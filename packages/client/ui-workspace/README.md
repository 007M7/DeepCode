# @deepseek-ai/dsh-client-ui-workspace

English | [中文](README.zh.md)

Shared Workspace picker plugin. `WorkspaceBrowser` is registered into the sidebar's `sidebar.workspaces` slot and `WorkspacePicker` into the page-local Session Intent hero's `conversation.hero.workspace` slot, so both surfaces use the same menu and creation flow.

The picker lists real Host Workspace entities through the global `useWorkspaces` hook. Selecting a Workspace invokes the slot owner's `onPick` callback to retarget the frontend Session object. The flat **Open local folder...** action delegates to the Host's native single-directory picker, adopts a returned path through the object layer, and selects the committed Workspace only after its list projection has refreshed; cancellation is silent, and errors remain retryable. **Create a new workspace** retains the name dialog and disables names already present in that list, while the Host remains authoritative for concurrent or non-UI callers. The runtime Session and Workspace services own materialization. The Workspace row's Delete action opens a confirmation that states the retention boundary, blocks duplicate submission, and keeps failures open; success removes the group while its Sessions remain under Ungrouped.

Both target slots are declared by other plugins, so `apply` registers through declaration-aware deferral and re-registers after a declaring slot is restored.

## Model Experience

None, as the picker is browser chrome; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No Session deletion control** — the existing Session menu row remains visual-only; Workspace registration deletion does not delete Sessions.
- **Native folder selection depends on the local Host carrier** — fixture-only or remote browser deployments cannot open a local operating-system dialog; platform failures are shown in a retryable modal.
