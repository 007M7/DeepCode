# @deepseek-ai/dsh-client-ui-workspace

English | [中文](README.zh.md)

Shared Workspace browser and picker plugin. `WorkspaceBrowser` fills the sidebar's `sidebar.workspaces` slot, while `WorkspacePicker` fills the page-local Session Intent hero's `conversation.hero.workspace` slot; both surfaces use the same Workspace menu and creation modals.

The browser renders grouped or flat Session rows from the global runtime hooks and owns the Workspace create/rename and in-Workspace reorder flows. A non-blank search query replaces either browsing mode with one flat result list: case-insensitive title and Workspace substring matches appear immediately, while a 250 ms debounced Host request adds ranked current-conversation content matches and snippets. The English search input and its defensive request path remove NUL, cap the query at the wire schema's 500 UTF-16 code units without splitting a surrogate pair, and preserve the existing debounce and cancellation behavior. Each new query aborts the preceding request; a failed content search leaves metadata matches visible with a warning. The list is capped at 20, asks the user to narrow broader queries, and opens the selected Session without clearing the query or jumping to a specific event.

The picker lists real Host Workspace entities through the global `useWorkspaces` hook. Selecting a Workspace invokes the slot owner's `onPick` callback to retarget the frontend Session object; the existing-folder and create-new actions first create a real Workspace through the object layer, then select it. Create-new disables names already present in that list, while the Host remains authoritative for concurrent or non-UI callers. The runtime Session and Workspace services own materialization.

Both target slots are declared by other plugins, so `apply` registers through declaration-aware deferral and re-registers after a declaring slot is restored.

## Model Experience

None, as the picker is browser chrome; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No fuzzy content search or event deep links** — the content backend uses literal token/phrase matching, and selecting a result opens the Session rather than the matching event.
- **No Workspace delete control** — the browser supports creation and rename, while the picker supports selection and creation.
- **Existing-folder entry is manual path input only** — Host creation failures are shown in the modal.
