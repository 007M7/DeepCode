# Agent Note: Native Windows pull-request CI

Status: implemented

English | [中文](2026-08-08-native-windows-pull-request-ci.zh.md)

## Problem

The required pull-request Windows verdict must protect behavior that depends on the operating system, not only toolchain branches selected by `process.platform`. The Wine lane executed Windows Node and PE binaries over a Linux kernel and case-sensitive ext4, required a hoisted dependency layout and host-created symlinks, and omitted NTFS, DACL, ConPTY, crash-durability, and the broader observational Windows inventory. With the native serial references disabled, ordinary CI had no real Windows-kernel signal.

The coverage audit found that PR #499 had restored deterministic native-Windows LSP coverage, but a later GUI branch replayed its three temporary source exclusions from stale branch state. The current LSP fixtures skip only genuinely POSIX primitives and otherwise exercise the supported Windows process, transport, and lifecycle paths, so excluding `connection.ts`, `index.ts`, and `instance.ts` hid supported behavior rather than a platform limitation.

## Decision

The required `windows` job in [ci.yml](../../../../.github/workflows/ci.yml) runs on GitHub's standard `windows-2025` image under native PowerShell. It enables Developer Mode for workspace symlinks, provisions the repository-pinned pnpm through `pnpm/action-setup`, performs an immutable install without a transferred store archive, and runs `pnpm run check:ci:windows-complete`. The stable `windows` job id remains a dependency of `all checks passed`; its display name is `windows node 24 / native complete`.

The aggregate keeps workspace build, production-site, and 100%-per-file coverage failures blocking while reporting the broader static, documentation, package, and built-artifact portability inventory as observational. Coverage has a four-worker budget; one runner shares installation and build outputs across those gates, and serial gate and publint worker bounds keep the standard image within a predictable resource envelope. Linux remains the owner of duplicate lint and snapshot enforcement.

The first native run exposed two failures hidden by the compatibility lane. Documentation projection tests derived an image basename by splitting only on `/`; they now use Node's platform basename. Chokidar consumers received `%TEMP%` through the `C:\\Users\\RUNNER~1` 8.3 alias while libuv returned the long directory name, tripping its Windows event-path assertion. Shared settings and credentials watchers, plus Cordis module and exact-config HMR, now canonicalize the existing native watch base or deepest existing ancestor before opening the watcher and preserve a missing suffix, while file access and diagnostics retain the configured path.

The coverage follow-up then exercised the serial heavy suites on the native host and removed their remaining path-spelling assumptions. Filesystem identity assertions compare native real paths instead of Git's slash convention with Node's temporary-directory spelling; quoted diagnostics are matched in their escaped form; TypeScript-owned file names are compared after separator normalization; and Typert passes a slash-normalized config name consistently across TypeScript's read and parse boundary so malformed Windows configs produce the owned analysis error instead of a compiler debug failure. The Oxlint subprocess contract also uses the same explicit twenty-second budget as its neighboring executable probes. These are portability repairs to supported tests and parser behavior, not platform skips or coverage exclusions.

The blocking coverage gate exposed two more fixture contracts that had never run on the native lane. The JSONL materialization fault now asserts the structured filesystem error code because the Windows durable-directory implementation owns an `ENOTDIR` code without copying it into human prose. The ACP teardown ladder now uses Node children instead of assuming a POSIX shell and asserts Windows' force-termination outcome rather than POSIX signal names; POSIX still proves the `SIGTERM` and `SIGKILL` tiers. Those suites load native bindings or own real process trees, so the Windows thread pool runs them in the existing fork-isolated project while still merging their coverage into the same per-file threshold.

After the branch incorporated a newer `master`, the next native coverage run found the last uncatalogued watcher path and a stress-test budget. `skill-local` opened existing Chokidar roots with the configured spelling, so `%TEMP%` could still reach libuv through `C:\\Users\\RUNNER~1` while events used the long directory name; its root and ancestor modes now share the canonical watch-path contract, while discovery retains the configured path. The newly added 10,000-session descendant walk also exceeded Vitest's default timeout under Windows coverage instrumentation, so that unchanged stack-safety workload has an explicit twenty-second stress-test budget rather than a smaller depth or a platform skip.

The next exact-head run exposed one remaining observational built-bin failure: its lifecycle fixtures used `process.kill()` or `subprocess.kill()` to send `SIGTERM`, which unconditionally terminates a Windows target instead of delivering the registered process event for graceful disposal. POSIX acceptance still sends the real signal. On Windows the fixture requests that same registered event from inside the child, directly for a self-terminating probe and through a marker for parent-controlled lifecycle cases, so the assembled shutdown and disposal path remains covered without asserting an operating-system facility that does not exist. That acceptance then exposed the underlying early-shutdown race: a signal could dispose the root after boot returned while fallback HMR watchers were mounting, and the resulting inactive-service error escaped as a boot failure. Post-boot setup now admits work only while the authoritative root fiber is active and contains a concurrent setup error only when the same invocation's recorded signal already owns shutdown; unrelated HMR failures remain loud.

Running the complete instrumented graph instead of the earlier reduced inventory exposed the remaining cross-platform fixture contracts. Windows path identity now accounts for 8.3 aliases, native separators, Git checkout line endings, cross-drive relative paths, and file URLs before constructing loader symlinks. The JSONL durable-directory helper applies the extended-length namespace to probes and staging creation, real product tests invoke portable executable entries and tolerate bounded Windows handle release, and stress tests retain their workloads with explicit coverage budgets. A credential document or watch path whose deepest existing ancestor is a file now fails `ENOTDIR` on every host, while `skill-local` uses effect-owned persistent Chokidar handles so asynchronous libuv errors are contained instead of escaping the test process.

POSIX mode bits, chmod-based unreadability, and chmod-based writer-lock refusal do not exist as equivalent Windows facilities. Those acceptance cases remain enforced on POSIX and are skipped on Windows; content, atomic replacement, symlink safety, rollback and recovery through platform-independent filesystem conflicts, and native Windows long-path behavior remain covered. No supported product source is excluded from Windows coverage to accommodate these differences.

Wine-only infrastructure is absent from the supported workflow: there is no apt-cache producer, compatibility script, hoisted snapshot install, Windows Node download, or local `check:windows-wine` command. The [archived Wine experiment](../../archived/process/2026-07-27-wine-windows-gates-experiment.md) remains historical evidence for its measured latency and fidelity trade-offs, not a current execution path.

## Alternatives considered

**Keep Wine on the required path.** Its warm wall clock was close to Linux CI and it selected win32 toolchain branches, but the compatibility-specific layout and kernel gaps could report green while supported native behavior was broken. Latency no longer outweighs that missing signal.

**Restore the pre-Wine workflow verbatim.** The old definition captured the right runner boundary but also carried then-current provisioning and topology assumptions. Reconstructing the native job against the current actions, pnpm setup, gate graph, and aggregate dependency avoids reviving obsolete machinery.

**Run native Windows only after merge.** A post-merge reference diagnoses portability regressions after they enter `master`; it cannot protect a pull request while those references are disabled or delayed.

**Use an organization-owned larger Windows runner.** Larger images can reduce wall clock, but a required correctness path would then depend on repository-external labels and allocation. Standard `windows-2025` is the portable recovery boundary; larger runners remain benchmark targets.

## Consequences

Pull requests receive a real NT kernel, NTFS, PowerShell, Windows process, and native addon signal before the aggregate can pass. The job is slower than the Wine compatibility lane and can queue on Windows capacity, but its green result now describes the supported host rather than an approximation.

The native lane is also a portability inventory: its exact-head acceptance requires every blocking gate to pass and the final summary to contain no non-blocking failure. That distinction caught path contracts which a successful wrapper conclusion alone would have concealed.

Removing the Wine cache producer and local script deletes a separate install topology and its recurring compatibility failures. Native coverage now runs through the same required job and enforces the repository's per-file threshold without Windows-only source exclusions for supported LSP behavior. Native snapshots remain a named gap rather than being implied by the job name; they require their own tested contract before becoming part of this required lane.
