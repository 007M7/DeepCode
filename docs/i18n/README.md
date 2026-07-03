# Bilingual documentation

English | [中文](README.zh.md)

This repo's documentation is read by people and agents both inside and outside the company, so the README and the docs tree are maintained in English and Simplified Chinese. This page defines the pairing contract, the enforcement gate, and the rollout policy; [translation-rules.md](translation-rules.md) defines how to translate; [terminology.md](terminology.md) is the terminology source of truth. The committed agent workflow lives in [.agents/skills/dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md).

## The pairing contract

- **English is canonical.** Every document is authored in English at its existing path, and the Chinese file is derived from it — translation flows EN → ZH only. A content change starts in the English file; the Chinese file never carries information its English source lacks.
- **Paired sibling files.** The translation of `foo.md` is `foo.zh.md` in the same directory. No locale directories, no separate translation repo, no interleaved bilingual files.
- **Source fingerprint.** The FIRST line of every `.zh.md` file is an HTML comment recording the repo-relative path and the git blob hash (first 12 hex digits of `git hash-object`) of the English source it was translated from:

  ```markdown
  <!-- i18n-source: docs/architecture.md@8a9f0c21d3e4 -->
  ```

  A blob hash, not a commit hash, so the fingerprint is computable for an English file edited in the same PR (`git hash-object docs/foo.md`), and so staleness is a pure content comparison. The fingerprint is also the update tool: `git cat-file -p <hash>` recovers the exact source text a stale translation was based on, and `git diff <hash> <current-blob>` isolates what changed so the translation can be updated minimally instead of re-translated.
- **Language switcher.** Both files link to each other immediately after their H1 heading: the English file carries `English | [中文](foo.zh.md)` and the Chinese file carries `[English](foo.md) | 中文`.
- **Structure mirrors the source.** Heading depths and order, list kinds, table columns, link targets, and verbatim code blocks match the English file one to one — see [translation-rules.md](translation-rules.md) for the full preservation rules. Existing Markdown gates apply to `.zh.md` files unchanged (`verify-md-wrap`, `verify-md-links`).

## The gate: verify-translation-pairing

`pnpm run verify-translation-pairing` (part of `doc-sync`, so CI and the pre-push hook run it) enforces the contract mechanically:

1. Every English file listed as `required` in [scripts/translation-pairing.manifest.json](../../scripts/translation-pairing.manifest.json) has a `.zh.md` sibling.
2. Every existing `.zh.md` file — required or not — passes all of: its English source exists (no orphans), its fingerprint matches the source's current blob hash (no stale translations), both sides carry the language switcher, and its structural signature matches the source in order — heading depths, verbatim code blocks (info string and content), table column counts, list kinds, and every link target apart from the switcher.
3. Files listed as `excluded` have no `.zh.md` sibling at all.

`pnpm run verify-translation-pairing --list` prints the current translation state of every document in scope — missing, stale, or ok — and is the work list for translation batches. It never fails; it reports.

The practical rule this gate creates: **when a PR edits an English document that has a `.zh.md` sibling, the same PR updates the translation** (run the [dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md) skill), exactly like the repo's existing doc-sync rule for code and READMEs. A PR that leaves a translation stale goes red in CI.

The gate's limit, stated plainly: **a green gate means fresh and structurally sound, not verified.** It checks the fingerprint and the shape; it cannot judge whether the Chinese is accurate, well-termed, or natural — that is the reviewer's half of the contract, per [translation-rules.md](translation-rules.md). A re-fingerprinted `.zh.md` with a sloppy translation passes the gate; it must not pass review.

## Scope, exclusions, and rollout

**Scope**: the root `README.md` and everything under `docs/**`. Package READMEs (`packages/**`) join the scope in a later batch.

**Excluded** (never paired, and the gate rejects a `.zh.md` for them):

- `docs/cordis-catalog/`, `docs/tool-catalog/`, `docs/module-graph.md` — generated files; their generators emit English only, so a translation would go stale on every regeneration.
- `docs/AGENTS.md` — agent instructions, maintained in English only like the root `AGENTS.md`.
- `docs/i18n/terminology.md` — the terminology table is itself bilingual by construction.

**Rollout**: the `required` list in the manifest is the enforcement frontier, not the goal. The goal is full bilingual coverage of the scope. Translation lands in reviewable batches (core entry docs, cookbook, RFCs, postmortems, …); each merged batch adds its files to `required`, so the gate ratchets forward and never regresses. Documents not yet in `required` are backlog — visible in `--list` — but any translation that already exists is held to the full contract regardless of the list. Pairing a document is a commitment: every later English edit to it must carry the translation along, so grow the frontier at the pace translation review is actually resourced, not ahead of it.

## Division of labor

Translations here are produced by an agent running [dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md) and reviewed by a human — inference is cheap here, review attention is the scarce resource. The gate exists so that neither the agent nor the reviewer has to remember the contract: pairing, freshness, and structure are checked mechanically, and review attention goes to translation quality and terminology, where human judgment is the whole point.
