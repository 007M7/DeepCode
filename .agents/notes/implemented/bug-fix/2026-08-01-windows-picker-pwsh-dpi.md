# Agent Note: Windows directory picker prefers pwsh and forces DPI awareness

Status: implemented

English | [中文](2026-08-01-windows-picker-pwsh-dpi.zh.md)

## Problem

The Windows branch of the native directory picker spawned Windows PowerShell 5.1's `FolderBrowserDialog`, which .NET Framework hardwires to the legacy `SHBrowseForFolder` tree dialog: no address bar, search, or quick access. The same process is DPI-unaware (`powershell.exe` declares no DPI awareness), so on scaled displays Windows renders the dialog at 96 DPI and bitmap-stretches it — blurry text and soft edges. Both defects were visible at once on any display above 100 % scaling.

## Decision

The win32 branch in `packages/host/directory-picker-native` now spawns `pwsh.exe` (PowerShell 7) first and falls back to `powershell.exe` (Windows PowerShell 5.1) only when pwsh is missing (`ENOENT`), mirroring the Zenity→KDialog fallback. PowerShell 7's WinForms `FolderBrowserDialog` supports `AutoUpgradeEnabled` (added in .NET Core 3.0, absent from .NET Framework) and renders the modern Explorer-style folder picker. Both runtimes execute the identical script, which calls `SetProcessDPIAware()` (user32) before any window exists, so the dialog is system-DPI-aware no matter which host serves it. `-STA` stays explicit for both, and the fallback keeps the seam's cancellation/failure contract (`null` on cancel, a retryable error otherwise). The host-boundary, RPC trust, and cancellation decisions stay with the [picker feature note](../feature/2026-07-27-native-workspace-directory-picker.md).

## Alternatives considered

- **Require PowerShell 7.** Rejected: pwsh is not a Windows built-in, so machines without it would lose the only workspace-creation route; the 5.1 fallback keeps the dialog functional, and DPI is corrected there too.
- **Import `resolvePwshPath` from `dsh-pwsh-local`.** Rejected for this change: a host GUI package importing from a bash-executor package is a cross-seam coupling, and PATH-based `execFile` resolution plus `ENOENT` fallback already covers the practical installs (Program Files, Store aliases); single-source resolution remains a follow-up if the two consumers drift.
- **Set DPI awareness in the harness process.** Rejected: DPI awareness is per-process, and the dialog lives in a spawned child that inherits nothing from the parent's absent declaration.
- **Per-monitor v2 (`SetProcessDpiAwarenessContext`).** Deferred: system-aware is the ceiling .NET Framework WinForms supports, the shell dialog handles per-monitor rendering itself on modern Windows, and one call keeps both runtimes on a single code path.

## Consequences

- Machines with PowerShell 7 get the modern folder picker; 5.1-only machines keep the legacy tree — now sharp — and the package README's Known Limitations documents the gap.
- No new packages or runtime dependencies; the fallback reuses the existing `ENOENT` classification and abort propagation.
- The command boundary (`DirectoryPickerRunner`) pins the spawn order and script content in unit tests; real dialog rendering remains a manual Windows check, as before.
