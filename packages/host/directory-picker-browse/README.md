# @deepseek-ai/dsh-host-directory-picker-browse

English | [中文](README.zh.md)

The **in-app browsing backend** of the [directory-picker seam](../directory-picker/README.md): `BrowseDirectoryPicker` registers `ctx.directoryPicker` with the `browse` capability — one-level directory listing and child-directory creation over Node's stdlib, which already carries the per-OS adaptation. Nothing renders on the host display, so this backend serves remote clients the native backend cannot.

Behavior facts: listings return **directories only**, name-sorted, with symlinks-to-directories followed (broken/cyclic links skipped — the probe `stat` failing means "not enterable") and a host-owned `hidden` flag (POSIX dot convention) left for the client to act on; `crumbs` is the root-to-target ancestor chain, the root crumb labeled by its full path (`/`, `C:\`); an absent `list` path means the host account's home directory. `createDirectory` is non-recursive (a missing parent is a real failure, not a level to invent) and validates the name as a single non-blank segment even when called directly, mirroring the wire schema's fence. Both primitives reject an explicit path that is not fully qualified — relative forms, and on Windows the rooted drive-less forms (`\foo`, `/foo`) and incomplete UNC prefixes (`\\`, `\\server`) that `isAbsolute` accepts — with `directory-unreadable`/`directory-create-failed`, instead of letting `resolve` rebase it under the host process cwd or current drive. One `list` call returns at most `maxEntries` rows (config, default 1000 — the bound GitHub's web UI applies to directory listings), and the level streams through a bounded window so memory stays O(maxEntries) no matter how many children the directory holds: a cut level keeps the name-sorted head, counts hidden rows against the bound, probes only windowed candidates, and reports `truncated: true` so the client can say the level is incomplete (a windowed broken symlink is not backfilled from beyond the window — the eviction already marks the level truncated); window insertion is binary with an O(1) full-window tail rejection, and `list` threads the caller's `AbortSignal` so a disconnect or timeout stops the scan instead of letting it outlive the caller. Failures throw the seam's typed `DirectoryPickerError`. Policy rationale: [the directory-picker capability seam Agent Note](../../../.agents/notes/implemented/architecture/2026-07-28-directory-picker-capability-seam.md).

## Model Experience

None, as the backend serves the GUI host's directory selection; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No client half yet** — the in-app browsing dialog that consumes these primitives lands in the next PR of this stack; until then a `-browse` composition hides the picking affordance entirely (ui-workspace's documented empty-hole default) and the listing/creation RPCs go unconsumed.
- **Windows hidden attribute is not read** — Node dirents do not expose `FILE_ATTRIBUTE_HIDDEN`, so `hidden` means dot-prefixed on every platform until a native probe is worth its cost.
- **No drive-root enumeration** — on Windows the ancestry stops at the drive root; crossing drives waits for the browser UI's path-entry affordance rather than an enumeration primitive here.
- **Whole-filesystem scope** — no per-deployment browse-root restriction; `workspace.create` accepts arbitrary paths today, so a root here would be UX scoping, not a boundary — deferred until a deployment needs it.
