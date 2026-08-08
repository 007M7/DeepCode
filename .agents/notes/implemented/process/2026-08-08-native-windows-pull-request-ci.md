# Agent Note: Native Windows pull-request CI

Status: implemented

English | [中文](2026-08-08-native-windows-pull-request-ci.zh.md)

## Problem

The required pull-request Windows verdict must protect behavior that depends on the operating system, not only toolchain branches selected by `process.platform`. The Wine lane executed Windows Node and PE binaries over a Linux kernel and case-sensitive ext4, required a hoisted dependency layout and host-created symlinks, and omitted NTFS, DACL, ConPTY, crash-durability, and the broader observational Windows inventory. With the native serial references disabled, ordinary CI had no real Windows-kernel signal.

## Decision

The required `windows` job in [ci.yml](../../../../.github/workflows/ci.yml) runs on GitHub's standard `windows-2025` image under native PowerShell. It enables Developer Mode for workspace symlinks, provisions the repository-pinned pnpm through `pnpm/action-setup`, performs an immutable install without a transferred store archive, and runs `pnpm run check:ci:windows-complete`. The stable `windows` job id remains a dependency of `all checks passed`; its display name is `windows node 24 / native complete`.

The aggregate keeps workspace build and production-site failures blocking while reporting the broader static, documentation, package, and built-artifact portability inventory as observational. One runner shares installation and build outputs across those gates, and serial gate and publint worker bounds keep the standard image within a predictable resource envelope. Linux remains the owner of duplicate lint, coverage, and snapshot enforcement until those suites have an explicit native-Windows contract.

The first native run exposed two failures hidden by the compatibility lane. Documentation projection tests derived an image basename by splitting only on `/`; they now use Node's platform basename. Chokidar consumers received `%TEMP%` through the `C:\\Users\\RUNNER~1` 8.3 alias while libuv returned the long directory name, tripping its Windows event-path assertion. Shared settings and credentials watchers, plus Cordis module and exact-config HMR, now canonicalize the existing native watch base or deepest existing ancestor before opening the watcher and preserve a missing suffix, while file access and diagnostics retain the configured path.

Wine-only infrastructure is absent from the supported workflow: there is no apt-cache producer, compatibility script, hoisted snapshot install, Windows Node download, or local `check:windows-wine` command. The [archived Wine experiment](../../archived/process/2026-07-27-wine-windows-gates-experiment.md) remains historical evidence for its measured latency and fidelity trade-offs, not a current execution path.

## Alternatives considered

**Keep Wine on the required path.** Its warm wall clock was close to Linux CI and it selected win32 toolchain branches, but the compatibility-specific layout and kernel gaps could report green while supported native behavior was broken. Latency no longer outweighs that missing signal.

**Restore the pre-Wine workflow verbatim.** The old definition captured the right runner boundary but also carried then-current provisioning and topology assumptions. Reconstructing the native job against the current actions, pnpm setup, gate graph, and aggregate dependency avoids reviving obsolete machinery.

**Run native Windows only after merge.** A post-merge reference diagnoses portability regressions after they enter `master`; it cannot protect a pull request while those references are disabled or delayed.

**Use an organization-owned larger Windows runner.** Larger images can reduce wall clock, but a required correctness path would then depend on repository-external labels and allocation. Standard `windows-2025` is the portable recovery boundary; larger runners remain benchmark targets.

## Consequences

Pull requests receive a real NT kernel, NTFS, PowerShell, Windows process, and native addon signal before the aggregate can pass. The job is slower than the Wine compatibility lane and can queue on Windows capacity, but its green result now describes the supported host rather than an approximation.

The native lane is also a portability inventory: its exact-head acceptance requires every blocking gate to pass and the final summary to contain no non-blocking failure. That distinction caught path contracts which a successful wrapper conclusion alone would have concealed.

Removing the Wine cache producer and local script deletes a separate install topology and its recurring compatibility failures. Native coverage and snapshots remain a named gap rather than being implied by the job name; they require their own tested contract before becoming part of this required lane.
