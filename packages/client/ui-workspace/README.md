# @deepseek-ai/dsh-client-ui-workspace

English | [中文](README.zh.md)

Shared Workspace picker plugin. `WorkspacePicker` is registered into the sidebar's `sidebar.workspace` slot and the page-local Session Intent hero's `conversation.empty.workspace` slot, so both surfaces use the same menu and creation modals.

The picker lists real Host Workspace entities through the global `useWorkspaces` hook. Selecting a Workspace invokes the slot owner's `onPick` callback to retarget the frontend Session object; the existing-folder and create-new actions first create a real Workspace through the object layer, then select it. Create-new disables names already present in that list, while the Host remains authoritative for concurrent or non-UI callers. The runtime Session and Workspace services own materialization.

Both target slots are declared by other plugins, so `apply` registers through declaration-aware deferral and re-registers after a declaring slot is restored.

## Model Experience

None, as the picker is browser chrome; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No Workspace rename/delete controls** — the picker supports selection and creation only.
- **Existing-folder entry is manual path input only** — Host creation failures are shown in the modal.
