# @deepseek-ai/dsh-host-directory-picker-dialog

English | [中文](README.zh.md)

The **native-OS-dialog backend** of the [directory-picker seam](../directory-picker/README.md): `DialogDirectoryPicker` registers `ctx.directoryPicker` with the `dialog` capability, whose `pick(signal)` opens one native chooser per call and resolves the chosen absolute path (`null` on cancel). Platform tools run without a shell: `osascript` on macOS, an STA PowerShell `FolderBrowserDialog` on Windows, and Zenity with a KDialog fallback on Linux; the caller's abort terminates the native process. Only viable when the operator sits at the host's display — remote deployments compose [`-browse`](../directory-picker-browse/README.md) instead. The command boundary (`DirectoryPickerRunner`) and platform facts are injectable for deterministic tests.

## Model Experience

None, as the backend serves the GUI host's directory selection; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Linux requires desktop tooling** — with neither Zenity nor KDialog installed, `pick` rejects with an actionable error; it does not fall back to a typed-path prompt (the browse backend is that fallback at the composition level).
