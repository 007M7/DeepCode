# Bilingual documentation via paired sibling files and a pairing gate

## Context

This repo's README and docs tree are read by people and agents inside and outside the company, in both English and Chinese. Maintaining a second language by hand, with no mechanism, is how translations rot: the English file moves on, the Chinese file silently lies, and no gate notices. The repo's standing answer to invariants of this kind is to encode them as a mechanical check (see [quality gates](2026-06-11-quality-gates.md) and [doc-sync enforcement](2026-06-11-doc-sync-enforcement.md)), so the bilingual policy ships with one.

## Decision

- **Paired sibling files, English canonical.** The translation of `foo.md` is `foo.zh.md` in the same directory; English is the only authoring language and translation flows EN → ZH. Policy: [docs/i18n/README.md](../../../i18n/README.md); translation rules: [docs/i18n/translation-rules.md](../../../i18n/translation-rules.md); terminology source of truth: [docs/i18n/terminology.md](../../../i18n/terminology.md).
- **A blob-hash fingerprint makes freshness checkable.** The first line of every `.zh.md` records the repo-relative path and the first 12 hex digits of the git blob hash of the English source it renders. Staleness is then a pure content comparison — no history lookup — and the hash is computable for a source edited in the same PR, which a commit-hash fingerprint (the MDN `l10n.sourceCommit` model) is not.
- **`verify-translation-pairing` joins `doc-sync`.** The gate ([scripts/verify-translation-pairing.ts](../../../../scripts/verify-translation-pairing.ts)) enforces: required pairs exist, every existing translation is fresh/switched/structure-matched/non-orphaned, and excluded (generated or bilingual-by-construction) files stay unpaired. The `required` list in [scripts/translation-pairing.manifest.json](../../../../scripts/translation-pairing.manifest.json) is a ratchet: each merged translation batch adds its files, so coverage only grows.
- **Translation is agent work with human review.** The committed workflow is [.agents/skills/dsh-translate-docs](../../../../.agents/skills/dsh-translate-docs/SKILL.md), following the same pattern as [dsh-code-review](../../../../.agents/skills/dsh-code-review/SKILL.md): the skill carries the workflow and defers to the docs as sources of truth.

## Alternatives considered

- **Locale directories (`docs/en/` + `docs/zh/`, the Kubernetes/ECharts model)** — rejected: this repo has no docs-site framework to map locales to routes, moving every English file would churn every existing cross-reference, and `verify-md-links`/`verify-doc-refs` would need path-mapping logic instead of working unchanged.
- **A separate translation repo (the PingCAP `docs`/`docs-cn` model)** — rejected: right for a docs product with independent release trains, overkill for a monorepo's own documentation; it also puts the translation outside the reach of this repo's gates.
- **Interleaved bilingual files (single file, both languages)** — rejected: doubles every diff, breaks the one-line-per-paragraph convention's diff ergonomics, and makes partial staleness invisible.
- **Commit-hash fingerprints (MDN `l10n.sourceCommit`)** — rejected in favor of blob hashes: a same-PR source edit has no commit hash yet, so the MDN model cannot express "translated against the version this PR introduces", and verifying it requires git history instead of file content.
- **Comparing git timestamps of the pair (no fingerprint)** — rejected: formatting-only English edits would false-positive, and a translation committed after an unrelated English edit would false-negative; content identity is the only signal that means what the gate claims.

## Industry precedent

Paired sibling files with locale suffixes are the dominant Chinese big-tech convention (ant-design `index.zh-CN.md`/`index.en-US.md`; arco-design `README.zh-CN.md` with a top-of-file switcher; Apache ShardingSphere's 387 `.cn.md`/`.en.md` pairs) — but none of those repos *enforce* pairing or freshness in CI; the convention holds by review alone. Freshness automation exists outside China: MDN's `l10n.sourceCommit` front-matter fingerprint, Vue's Ryu-Cho action (upstream-commit watcher that opens issues/PRs for stale translations), Kubernetes' localization drift scripts, and Microsoft's Azure co-op-translator (source-hash-driven LLM re-translation in CI). This design combines the two: the Chinese-ecosystem file layout with a fingerprint gate, plus a committed agent skill in place of a bot service.

## Consequences

- Editing an English doc that has a `.zh.md` sibling obligates the same PR to update the translation — the gate makes the doc-sync rule bilingual, and CI (not reviewer memory) carries the invariant.
- Generated docs (`cordis-catalog/`, `tool-catalog/`, `module-graph.md`) are never paired; their generators emit English only, and the gate rejects a stray translation of them.
- Rollout is incremental by design: documents outside `required` are visible backlog (`--list`), not red CI, so translation lands in reviewable batches without a big-bang PR.
- The fingerprint doubles as the update tool (`git cat-file -p <hash>` recovers the exact translated-from text for a minimal diff-based update), so re-translation of whole files is never forced by the mechanism.
