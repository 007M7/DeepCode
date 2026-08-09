# Agent Note: Dual Wine and native Windows pull-request CI

Status: implemented

English | [中文](2026-08-08-native-windows-pull-request-ci.zh.md)

## Problem

The required pull-request Windows verdict needs a fast win32 toolchain signal without making the aggregate wait for scarce Windows capacity. The Wine lane provides that critical-path signal but executes over a Linux kernel and case-sensitive ext4, requires a hoisted dependency layout and host-created symlinks, and cannot prove NTFS, DACL, ConPTY, crash-durability, or native process behavior. With the native serial references disabled, ordinary CI also needs an automatic real Windows-kernel result on every pull-request head even when that result is not part of branch protection.

## Decision

The required `windows` job in [ci.yml](../../../../.github/workflows/ci.yml) remains `windows node 24 / wine blocking` on `ubuntu-latest`. It retains the checksum-verified Windows Node, Wine apt and pnpm caches, a hoisted install confined to a workspace snapshot, and the [shared Wine gate script](../../../../scripts/wine-windows-gates.sh) that runs the workspace build and production site. Node distribution transfers use bounded retries; when nodejs.org stalls on the large archive, a range-capable transport mirror resumes the same bytes, but nodejs.org remains the version and SHA-256 authority and the archive is never promoted before that checksum passes. The stable `windows` job id remains a dependency of `all checks passed`. The [archived Wine experiment](../../archived/process/2026-07-27-wine-windows-gates-experiment.md) preserves its measured trade-offs, while this note owns the current dual topology.

Every pull request also starts an independent `windows-native` job named `windows node 24 / native complete` on GitHub's standard `windows-2025` image. It enables Developer Mode for workspace symlinks, provisions the repository-pinned pnpm through `pnpm/action-setup`, performs an immutable install without a transferred store archive, and runs `pnpm run check:ci:windows-complete` under native PowerShell. The job is deliberately absent from `all-checks-passed.needs`: the aggregate neither waits for it nor changes conclusion because of it, while the native job retains its own unmasked success or failure result.

The native gate keeps workspace build and production-site failures blocking inside its own job while reporting the broader static, documentation, package, and built-artifact portability inventory as observational. One runner shares installation and build outputs across those gates, and serial gate and publint worker bounds keep the standard image within a predictable resource envelope. Linux remains the owner of duplicate lint, coverage, and snapshot enforcement until those suites have an explicit native-Windows contract.

The first native run exposed two failures hidden by the compatibility lane. Documentation projection tests derived an image basename by splitting only on `/`; they now use Node's platform basename. Chokidar consumers received `%TEMP%` through the `C:\\Users\\RUNNER~1` 8.3 alias while libuv returned the long directory name, tripping its Windows event-path assertion. Shared settings and credentials watchers, plus Cordis module and exact-config HMR, now canonicalize the existing native watch base or deepest existing ancestor before opening the watcher and preserve a missing suffix, while file access and diagnostics retain the configured path. Module HMR attaches listeners and awaits the main watcher's ready event before plugin startup settles, so an immediate post-boot edit cannot race the initial scan.

The next exact-head run exposed one remaining observational built-bin failure: its lifecycle fixtures used `process.kill()` or `subprocess.kill()` to send `SIGTERM`, which unconditionally terminates a Windows target instead of delivering the registered process event for graceful disposal. POSIX acceptance still sends the real signal. On Windows the fixture requests that same registered event from inside the child, directly for a self-terminating probe and through a marker for parent-controlled lifecycle cases, so the assembled shutdown and disposal path remains covered without asserting an operating-system facility that does not exist. That acceptance then exposed the underlying early-shutdown race: a signal could dispose the root after boot returned while fallback HMR watchers were mounting, and the resulting inactive-service error escaped as a boot failure. Post-boot setup now admits work only while the authoritative root fiber is active and contains a concurrent setup error only when the same invocation's recorded signal already owns shutdown; unrelated HMR failures remain loud.

## Alternatives considered

**Make native Windows a dependency of `all checks passed`.** This gives the aggregate the highest-fidelity Windows verdict, but makes every merge wait for the longest hosted job and for Windows capacity. The independent result keeps that signal automatic without changing the existing required path.

**Run only Wine on pull requests.** Wine reaches the blocking win32 toolchain branches quickly, but can report green while a real NT, NTFS, PowerShell, process, or addon contract is broken.

**Mark the native job `continue-on-error`.** That would make its check appear successful after a gate failure. Keeping an ordinary independent job preserves the diagnostic conclusion; omission from aggregate `needs` is the only non-blocking mechanism.

**Run native Windows only after merge.** A post-merge reference diagnoses portability regressions after they enter `master`; it does not give reviewers an exact-head native result.

**Use an organization-owned larger Windows runner.** Larger images can reduce wall clock, but the diagnostic path would then depend on repository-external labels and allocation. Standard `windows-2025` is portable; larger runners remain benchmark targets.

## Consequences

Wine preserves the required aggregate's existing critical path and job identity. Native Windows can still be pending or red when `all checks passed` turns green, so branch protection consumes Wine while reviewers and follow-up automation consume the separate native result.

Every pull request nevertheless receives a real NT kernel, NTFS, PowerShell, Windows process, and native addon signal. The native job is slower than Wine and duplicates setup plus the two blocking builds, but it also executes the portability inventory that exposed path, watcher, and lifecycle defects hidden by the compatibility lane.

Maintainers must preserve two intentional execution topologies: the Wine snapshot uses Linux installation plus a hoisted layout to reach win32 binaries, while the native job uses the immutable workspace on Windows. A failure unique to either job must be classified against that boundary rather than weakened or silently skipped.
