# Agent Note: Wine-run Windows blocking gates on Linux runners

Status: proposed

English | [中文](2026-07-27-wine-windows-gates-experiment.zh.md)

## Problem

The pull-request Windows lane exists to prove the two blocking win32 surfaces — the workspace build and the production site — plus an observational portability inventory, and it runs on a dedicated paid Windows larger-runner pool; the master serial reference adds a second hosted Windows job. That pool is the only reason a Windows VM exists anywhere in this pipeline, and its provisioning, pricing, and slow setup dominate the lane's cost.

The open question: can a plain Linux runner produce an equivalent win32 signal for the blocking surfaces, so the dedicated Windows pool can shrink to a master-only reference or disappear from the pull-request path entirely?

## Proposal

[exp-wine-windows.yml](../../../../.github/workflows/exp-wine-windows.yml) (self-path-filtered, plus manual dispatch) runs the blocking gate commands on `ubuntu-latest` under Wine with real Windows binaries: a checksum-verified win-x64 Node.js executes `tsc -b`, `tsdown`, and the VitePress production build, so the win32 branches of the toolchain — backslash path handling, `CreateProcess` spawn semantics, PE loading of `@esbuild/win32-x64`, and the rolldown/rollup MSVC `.node` addons — actually execute.

Dependencies install natively on Linux with `supportedArchitectures` extended to win32-x64, which materializes the Windows platform packages in the same store; the cmd-shim layer is bypassed by invoking each tool's JavaScript entrypoint directly, the same processes `run-gates` ultimately spawns. `nodeLinker: hoisted` is load-bearing, not stylistic: the independent prototype in [PR #689](https://github.com/deepseek-harness/deepseek-harness/pull/689) kept pnpm's default isolated layout — including a faithful offline Windows-pnpm re-install over a Linux-prefetched store — and Windows Node under Wine still could not resolve `@esbuild/win32-x64` or load the koffi prebuild through the isolated symlink chain, failing before any repository gate ran. A flat layout with real files is what makes the gates reachable at all; #689's checksum pinning is adopted, while its Windows-pnpm-installs-the-tree goal is explicitly given up (the install contract stays Linux-tested here).

The lane targets the wall clock of the Linux CI jobs (about two minutes), from four levers: the master-refreshed pnpm store cache (restore-only, same key as ci.yml), Wine provisioning (apt install, Windows Node download, `wineboot`) running concurrently with `pnpm install`, the two blocking surfaces running concurrently — the same shape `run-gates` gives them on native Windows — and an apt-archive cache keyed on the runner image so Wine's package downloads are paid once per image version.

This is deliberately a fidelity probe, not a drop-in replacement: Wine reimplements the Win32 API over a case-sensitive ext4 (NTFS case-insensitivity is not emulated by default), provides no ConPTY, and substitutes its own security-descriptor and `MoveFileExW` semantics — exactly the surfaces the repo's `win32.ts` modules and PTY backend care about. The experiment measures which blocking gates pass, which fail for Wine reasons rather than product reasons, and the wall-clock cost relative to the recorded Windows benchmark lanes.

Promotion, if the verdict is positive: fold the Wine lane in as the pull-request Windows signal for blocking gates and demote the real-Windows pool to the master serial reference; otherwise record the failure class here and keep the pool.

## Alternatives considered

**Keep the dedicated Windows pool (status quo).** It is the baseline being priced; nothing is wrong with its signal, only with paying for a Windows VM pool whose blocking surface is two build commands.

**A full Windows guest under QEMU/KVM inside the Linux runner.** Real NT kernel, so full fidelity including case-insensitive NTFS and ConPTY — but tens of minutes of image download and unattended install before the first gate runs. Explored as the sibling experiment branch `exp/kvm-windows-ci`; the two experiments price fidelity against latency.

**Windows pnpm performing the install under Wine ([PR #689](https://github.com/deepseek-harness/deepseek-harness/pull/689)).** The higher-fidelity variant of this same idea: MinGit and pnpm staged into the prefix, a Linux prefetch filling the store, then `pnpm install --offline` run by Windows Node so the install contract itself executes as win32. It reached the install but not the gates — Wine's networking could not reach the registry directly, and the isolated `node_modules` layout defeated resolution of the Windows platform packages even after a clean offline install. This lane trades that fidelity away (hoisted layout, Linux-side install) to reach the gates; the two records are complementary halves of the same verdict.

**Filesystem-semantics lanes on Linux (casefolded ext4, filename lint).** Catches the highest-frequency Windows breakage class for near-zero cost but proves nothing about win32 binaries. Explored as the sibling experiment branch `exp/casefold-windows-ci`.

**Windows containers.** Not possible: Windows containers require a Windows host kernel; a hosted Linux runner cannot run them.

**Dropping the Windows lane.** Rejected — win32 is a first-class product target: the koffi-backed DACL and durable-namespace modules, ConPTY-based PTY sessions, and Windows path policy all ship in `packages/`.

## Acceptance criteria

- The workflow completes on `ubuntu-latest` with an independent pass/fail verdict per blocking surface (build, production site) and a recorded wall-clock comparison against both the paid Windows lane and the Linux CI jobs.
- End-to-end wall clock lands in the same band as the Linux CI jobs (minutes, not tens of minutes), demonstrating the pool-replacement case on cost as well as signal.
- A decision is recorded here: promote the lane, keep it as a non-blocking canary, or reject it with the observed failure class.

## Risks

- False greens: Wine's case-sensitive filesystem and permissive path handling can pass code that breaks on real NTFS, so this lane can complement but never fully replace a real-kernel check for release qualification.
- False reds: missing or stubbed Win32 APIs under Wine fail gates for non-product reasons, and each such failure costs triage time to classify.
- Throughput: Wine's syscall translation on the 2-core standard runner may push the blocking gates past the paid Windows lane's wall clock, erasing the cost argument; the run records the numbers either way.
