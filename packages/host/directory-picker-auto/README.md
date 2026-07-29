# @deepseek-ai/dsh-host-directory-picker-auto

English | [中文](README.zh.md)

The **adaptive chooser** of the [directory-picker seam](../directory-picker/README.md): a node-half-only plugin that resolves the host's situation once at boot and mounts the matching dual-face backend — [`-native`](../directory-picker-native/README.md) or [`-browse`](../directory-picker-browse/README.md) — as a real Loader entry in the in-memory root tree (never persisted to a config file; the root tree's `write()` is a no-op). Because the backend arrives as an ordinary entry, its browser half is discovered by the client module table exactly as a config-row's would be, so the seam's one-row-swaps-both-faces invariant holds for the resolved choice. Unloading the chooser removes the entry again, unloading both faces with it.

Resolution is one pure boot-time sample (`resolveDirectoryPickerBackend`), exported for reuse and tests. `native` requires every signal that the operator can see the host display: a loopback-only bind (read from the injected `httpServer`; an all-interfaces bind admits remote browsers no OS chooser can reach), no SSH launch (`SSH_CONNECTION`/`SSH_TTY` unset or blank — under SSH port-forwarding the chooser would open on the unattended server), and a display session (assumed on darwin/win32; `DISPLAY`/`WAYLAND_DISPLAY` elsewhere). Anything ambiguous resolves to `browse`, which works everywhere. The sample happens exactly once per boot so the mounted capability stays stable for the service lifetime, as the seam requires. Pinning an interaction is not a config field here — compose the `-native` or `-browse` row directly instead of this one, the seam's documented swap point; mounting the chooser **and** a backend row together fails loud (duplicate `directoryPicker` service, duplicate client flow in the `single` holes).

## Model Experience

None, as the chooser only composes the GUI host's directory selection; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Detection is a heuristic, not a proof** — a tmux session detached from its SSH launch loses the `SSH_*` markers, and a darwin process outside an Aqua session still counts as displayed; a wrong `native` choice degrades to the backend's existing retryable failure dialog, and composing `-browse` directly pins the safe interaction.
- **Boot-time only** — one resolution serves every client of the boot; per-connection adaptivity (native for a local browser, browse for a remote one, same server) would need a per-client capability and the wire advertisement the seam deliberately deleted, and waits for a deployment that serves both at once.
