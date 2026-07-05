# Bilingual documentation

English | [中文](README.zh.md)

This repo's documentation is read by people and agents both inside and outside the company, so the README and the docs tree are maintained in English and Simplified Chinese. This page defines the pairing contract, the enforcement gate, and the rollout policy; [translation-rules.md](translation-rules.md) defines how to translate; [terminology.md](terminology.md) is the terminology source of truth. The committed agent workflow lives in [.agents/skills/dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md).

## The pairing contract

- **Both languages carry equal authority.** A document may be authored and reviewed in either language first — a Chinese-first RFC is as legitimate as an English-first one — and the counterpart is translated from it. Neither file outranks the other; what binds them is that they must say the same thing.
- **A pair is three sibling files.** The English `foo.md`, the Chinese `foo.zh.md`, and a consistency record `foo.i18n.yaml`, all in the same directory. No locale directories, no separate translation repo, no interleaved bilingual files. Pairs merge whole: a PR never lands one language without the other two files.
- **The consistency record.** `foo.i18n.yaml` holds the full git blob hash of each side as of the last time the two were confirmed to say the same thing:

  ```yaml
  foo.md: 3f786850e387550fdab836ed7e6dc881de23001b
  foo.zh.md: 89e6c98d92887913cadf06b2adb97f26cde4849b
  ```

  Blob hashes, not commit hashes, so the record is computable for files edited in the same PR (`git hash-object foo.md`) and consistency is a pure content comparison. The recorded hash also recovers the exact last-confirmed text of either side (`git cat-file -p <hash>`), so an out-of-sync pair is updated by diffing the edited side against its last-confirmed state and patching the counterpart minimally — never by re-translating whole files. After bringing the pair back in line, `pnpm run verify-translation-pairing --write` re-records both hashes; that yaml diff is the reviewable act of confirming consistency.
- **Language switcher.** Both files link to each other immediately after their H1 heading: the English file carries `English | [中文](foo.zh.md)` and the Chinese file carries `[English](foo.md) | 中文`.
- **Structure mirrors the counterpart.** Heading depths and order, list kinds, table columns, link targets, and verbatim code blocks match one to one across the pair — see [translation-rules.md](translation-rules.md) for the full preservation rules. Existing Markdown gates apply to `.zh.md` files unchanged (`verify-md-wrap`, `verify-md-links`).

## The gate: verify-translation-pairing

`pnpm run verify-translation-pairing` (part of `doc-sync`, so CI and the pre-push hook run it) enforces the contract mechanically:

1. Every file listed as `required` in [scripts/translation-pairing.manifest.json](../../scripts/translation-pairing.manifest.json) has a complete pair.
2. Every pair that exists at all — required or not — is complete and consistent: all three files present, each side's current blob hash equals the recorded one (editing either side without re-confirming the pair goes red), both sides carry the language switcher, and the structural signatures match in order — heading depths, verbatim code blocks (info string and content), table column counts, list kinds, and every link target apart from the switcher.
3. Files listed as `excluded` have no `.zh.md` and no `.i18n.yaml` at all.

`pnpm run verify-translation-pairing --list` prints the current pairing state of every document in scope — missing, out-of-sync, or ok — and is the work list for translation batches. It never fails; it reports.

The practical rule this gate creates: **when a PR edits either side of a paired document, the same PR updates the counterpart and re-records the pair** (run the [dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md) skill, then `--write`), exactly like the repo's existing doc-sync rule for code and READMEs. A PR that leaves a pair out of sync goes red in CI.

The gate's limit, stated plainly: **a green gate means the pair was confirmed consistent at these exact contents, not that the confirmation was sound.** It checks hashes and shape; it cannot judge whether the two sides actually say the same thing, or whether the wording is accurate, well-termed, and natural — that is the reviewer's half of the contract, per [translation-rules.md](translation-rules.md). A re-recorded pair with a sloppy counterpart passes the gate; it must not pass review.

## Scope, exclusions, and rollout

**Scope**: the root `README.md` and everything under `docs/**`. Package READMEs (`packages/**`) join the scope in a later batch.

**Excluded** (never paired, and the gate rejects a `.zh.md` or `.i18n.yaml` for them):

- `docs/cordis-catalog/`, `docs/tool-catalog/`, `docs/module-graph.md` — generated files; their generators emit English only today, so a hand-written translation would go stale on every regeneration. The planned follow-up is to teach the generators to emit Chinese alongside English, at which point these leave the exclusion list.
- `docs/AGENTS.md` — agent instructions, maintained in English only like the root `AGENTS.md`.
- `docs/i18n/terminology.md` — the terminology table is itself bilingual by construction.

**Rollout**: the `required` list in the manifest is the enforcement frontier, not the goal. The goal is full bilingual coverage of the scope. Pairs land in reviewable batches (core entry docs, cookbook, RFCs, postmortems, …); each merged batch adds its files to `required`, so the gate ratchets forward and never regresses. Documents not yet in `required` are backlog — visible in `--list` — but any pair that already exists is held to the full contract regardless of the list. Pairing a document is a commitment: every later edit to either side must carry the counterpart along, so grow the frontier at the pace translation review is actually resourced, not ahead of it.

## Division of labor

Counterparts here are produced by an agent running [dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md) and reviewed by a human — inference is cheap here, review attention is the scarce resource. The gate exists so that neither the agent nor the reviewer has to remember the contract: pair completeness, consistency, and structure are checked mechanically, and review attention goes to translation quality and terminology, where human judgment is the whole point.
