# Agent Note: Win32 folder picker moves in-process over koffi

Status: implemented

English | [中文](2026-08-02-win32-in-process-folder-dialog.zh.md)

## Problem

The Windows directory picker's primary tier was a spawned PowerShell script around WinForms `FolderBrowserDialog`: the modern dialog only where PowerShell 7 happens to be installed, a review-flagged regression where PowerShell 6 resolves but has no WinForms (exit 1 is not `ENOENT`, so the 5.1 fallback never ran), a `SetProcessDPIAware` ceiling of system DPI, and a picker whose behavior depended on which shells a machine ships rather than on Windows itself.

## Decision

`packages/host/directory-picker-native` now opens `IFileOpenDialog` (`FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR`) in-process through koffi — already a workspace dependency for the repo's other `win32.ts` surfaces — as the primary win32 tier. The COM conversation runs on a `worker_threads` worker so the modal `Show` never blocks the host event loop; the worker posts its native thread id before blocking, and the driver services aborts by re-posting `WM_CLOSE` to that thread's windows (`EnumThreadWindows`), terminating and unrefing the worker only when the close budget is exhausted (Node cannot interrupt native calls, so an unclosable worker must never hold the process open). The worker thread opts into the best thread DPI awareness the host accepts (`SetThreadDpiAwarenessContext`, cascading per-monitor-v2 → per-monitor → system-aware with the return value checked), a strict upgrade over the script's system-DPI ceiling; DPI stays a cosmetic best-effort — a host accepting none of them still gets the modern dialog rather than a downgrade to the fallback chain. The module split keeps coverage honest on every host: `win32-dialog-logic.ts` (pure sequencing) and `win32-dialog.ts` (driver) test against fakes anywhere; `win32-dialog-bindings.ts` tests against a mocked `koffi` COM world (the `dsh-session-persistence-jsonl` technique); POSIX hosts run the real spawn plumbing to its koffi-load rejection; win32 hosts run a real open-and-abort-close smoke. That smoke lives in `processBoundTests`: under the threads pool a worker blocked in a native modal wedges pool teardown, while a fork contains it. The PowerShell chain (see the [DPI note](../bug-fix/2026-08-01-windows-picker-pwsh-dpi.md)) stays as the fallback tier, its trigger widened from `ENOENT` to any pwsh failure, which also closes the PowerShell 6 regression.

## Alternatives considered

- **A prebuilt native helper (`native/` family like `node-addon-landlock-run`).** Rejected: a mirror repository, an npm package family, MSVC provisioning, and a release handoff — all to ship ~150 lines of C the repository cannot exercise on CI (no real-Windows lane); koffi delivers the same COM surface with zero new supply chain.
- **An N-API in-process addon.** Rejected for the same CI/toolchain reasons plus owned C++ for STA threading and message pumping that `worker_threads` + koffi express in TypeScript.
- **Keep PowerShell primary and probe versions.** Rejected: the picker stays hostage to shell packaging (6 vs 7, Store aliases, profiles), and 5.1's legacy dialog remains the floor wherever pwsh is absent; the fallback-trigger widening alone was accepted into the fallback tier instead.
- **Blocking the main thread for the modal call.** Rejected outright: the web host must keep serving RPC while the dialog is open.

## Consequences

- Every Windows machine gets the modern dialog with the best DPI awareness it supports (per-monitor-v2 on 1703+), PowerShell installed or not; the PowerShell tiers only serve hosts where koffi cannot drive COM.
- Real dialog rendering and the selection path stay a manual Windows check (the auto-close smoke proves open/abort/unwind); a wedged abort can leak one dialog thread until process exit, documented in the package README.
- The COM vtable slots and GUIDs used are frozen Windows ABI (Vista); a koffi signature mistake is a native-crash risk that can take down the whole Node process — `worker_threads` share the process, so an access violation is not contained to the worker and no PowerShell fallback runs. The mocked-koffi ABI pins and the real win32 smoke exist to catch such mistakes before shipping.
- The packaged-binary VFS arm — resolution of `./worker.cjs` inside a pkg snapshot — is not exercised by any automated test: the source worker and the built `lib/worker.cjs` under plain Node are covered, and the VFS-specific spawn remains deferred to the Windows CI roadmap.
