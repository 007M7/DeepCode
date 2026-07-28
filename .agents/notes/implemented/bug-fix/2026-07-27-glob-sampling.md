# Agent Note: Sample over-cap glob results across the tree

Status: implemented

English | [中文](2026-07-27-glob-sampling.zh.md)

## Problem

Asked what a workspace contained, an agent described one subfolder as if it were the whole project. The workspace held 22 top-level entries and 11,485 files. `glob {"pattern":"*"}` matched 10,030 paths, but all 100 inline paths sat under one recently unpacked subtree, so the model never saw the other 21 entries.

Three individually valid behaviors composed into the false impression. A glob without `/` matches basenames at any depth, so `*` means every file in the tree rather than the shell's current-directory expansion. Ripgrep's `--sort=modified` is ascending, so an archive's restored old timestamps put that subtree first. The inline page then took the head of that order without saying that it represented only one concentrated slice.

## Decision

A result that fits within `globMaxResults` remains complete and byte-for-byte modification-time ordered. An over-cap result is sampled round-robin across the complete result's top-level entries: every entry receives one slot before any receives a second, exhausted groups drop out, and relative order remains stable within each group. Grouping is relative to the actual search root, including an explicit `path`.

The footer states that the page is a cross-entry sample rather than the modification-time head, reports how many top-level entries it reaches when that fact adds information, and preserves the complete sorted list in the spill artifact. When more top-level entries exist than inline slots, it tells the model to narrow `path`.

The prompt and schema also state that a pattern without `/` matches at any depth and that glob returns files, never directory entries. Directory orientation remains ordinary shell work in deployments that expose the model-facing bash tool: use `ls` for one directory, and glob for a named file-path pattern across the tree. `ctx.fs.listDir` remains an internal provider primitive used by skill discovery; this decision adds no model-facing `list` tool.

## Alternatives considered

**Keep the modification-time head and only warn about concentration.** Rejected after measuring the failure shape. A warning asks the model to distrust the only paths it received; representative data fixes the answer directly.

**Sample every result.** Rejected. A complete result loses nothing to truncation, so modification-time order remains useful for age-oriented questions. Sampling begins only when the head stops describing the whole.

**Switch to newest-first order.** Rejected. It merely changes which concentrated subtree can dominate and removes the existing oldest-first contract without making a capped page representative.

**Sample only past a skew threshold.** Rejected. No current evidence supports a deployment-wide threshold, and the model could not know which ordering contract applied. The existing cap is the explainable transition.

**Balance recursively below the top level.** Deferred. First-segment balance fixes the observed failure; deeper balancing needs an unsupported depth-versus-breadth policy.

**Add a model-facing `list` tool.** Rejected after implementation review. The default coding composition already exposes general bash and the model understands `ls`; a duplicate tool would add permanent schema/prompt tokens plus ordering, pagination, symlink, escaping, UI, and snapshot contracts without a distinct security or policy benefit. Thin deployments without a model-facing bash tool do not gain directory orientation from this change.

**Reject `*` or silently anchor separator-free patterns.** Rejected. The same basename-at-any-depth behavior makes `*.ts` useful across a tree. Documenting the rule preserves working ripgrep semantics.

## Consequences

An over-cap glob page no longer answers age-order questions from its inline paths; its footer says so, and the spill artifact retains the complete sorted view. Sampling balances only the first segment beneath the search root, so a deeper hot subtree can still dominate within one top-level entry.

The tool surface does not grow. The fix changes glob's prompt, schema description, canonical output (`root` records the sampling basis), and over-cap Native rendering while leaving fitting results unchanged.

## Testing

Package tests pin concentrated and flat results, explicit roots, more groups than the JavaScript argument limit, exhausted groups, fewer slots than groups, and paths outside the workdir. The `fs-glob-sampling` ACP scenario boots a minimal real Loader/app/local-bash composition and executes the real search plugin against a deterministic `rg` process fixture; its result spans four top-level entries instead of returning one subtree's head.
