# Agent Note: Windows directory picker prefers pwsh and forces DPI awareness

Status: implemented

English | [中文](2026-08-01-windows-picker-pwsh-dpi.zh.md)

## Problem

The Windows branch of the native directory picker spawned Windows PowerShell 5.1's `FolderBrowserDialog`, which .NET Framework hardwires to the legacy `SHBrowseForFolder` tree dialog: no address bar, search, or quick access. The same process is DPI-unaware (`powershell.exe` declares no DPI awareness), so on scaled displays Windows renders the dialog at 96 DPI and bitmap-stretches it — blurry text and soft edges. Both defects were visible at once on any display above 100 % scaling.

## Decision

The PowerShell chain is now the FALLBACK tier below the in-process koffi dialog (see the [in-process folder dialog note](../feature/2026-08-02-win32-in-process-folder-dialog.md)): the win32 branch spawns `pwsh.exe` (PowerShell 7) first and falls back to `powershell.exe` (Windows PowerShell 5.1) on ANY pwsh failure — a resolvable PowerShell 6 has no WinForms and exits 1, not `ENOENT`, and 5.1 ships with every Windows. PowerShell 7 renders the modern Explorer-style folder picker because .NET Core 3.0 rewrote `FolderBrowserDialog` over `IFileDialog` (unconditionally; the later `AutoUpgradeEnabled` opt-out arrived in .NET 6 and the script never sets it). Both runtimes execute the identical script, which calls `SetProcessDPIAware()` (user32) before any window exists, so the dialog is system-DPI-aware no matter which host serves it. The script sets no `Description`: .NET 10's modern `FolderBrowserDialog` renders it as a bottom strip above the folder input, and the 5.1 classic dialog as an unthemed box, so the property is dropped entirely. `-STA` stays explicit for both, and the fallback keeps the seam's cancellation/failure contract (`null` on cancel, a retryable error otherwise). The host-boundary, RPC trust, and cancellation decisions stay with the [picker feature note](../feature/2026-07-27-native-workspace-directory-picker.md).

## Alternatives considered

- **Require PowerShell 7.** Rejected: pwsh is not a Windows built-in, so machines without it would lose the only workspace-creation route; the 5.1 fallback keeps the dialog functional, and DPI is corrected there too.
- **Import `resolvePwshPath` from `dsh-pwsh-local`.** Rejected for this change: a host GUI package importing from a bash-executor package is a cross-seam coupling, and PATH-based `execFile` resolution plus `ENOENT` fallback already covers the practical installs (Program Files, Store aliases); single-source resolution remains a follow-up if the two consumers drift.
- **Set DPI awareness in the harness process.** Rejected: DPI awareness is per-process, and the dialog lives in a spawned child that inherits nothing from the parent's absent declaration.
- **Per-monitor v2 (`SetProcessDpiAwarenessContext`).** Deferred: system-aware is the ceiling .NET Framework WinForms supports, the shell dialog handles per-monitor rendering itself on modern Windows, and one call keeps both runtimes on a single code path.

## Consequences

- Machines with PowerShell 7 get the modern folder picker; 5.1-only machines keep the legacy tree — now sharp — and the package README's Known Limitations documents the gap.
- No new packages or runtime dependencies; the fallback reuses the existing `ENOENT` classification and abort propagation.
- The command boundary (`DirectoryPickerRunner`) pins the spawn order and script content in unit tests; real dialog rendering remains a manual Windows check, as before.
