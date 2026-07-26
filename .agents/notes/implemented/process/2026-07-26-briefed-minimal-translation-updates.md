# Agent Note: Briefed minimal translation updates

Status: implemented

English | [中文](2026-07-26-briefed-minimal-translation-updates.zh.md)

## Problem

The [bilingual pairing contract](2026-07-02-bilingual-docs-and-pairing-gate.md) already prescribed minimal counterpart updates — diff the edited side against its last-confirmed state, patch the counterpart, never re-translate — but the committed workflow made every update pay whole-document overheads. The translating subagent loaded the full guidance corpus (skill, pairing contract, translation rules, the 192-line terminology table, style samples, prose standard) before touching a two-line diff; it re-derived the last-confirmed diff by hand through `git cat-file`; and each iteration re-ran the corpus-wide pairing gate, which parses every pair in the tree to validate one. A small English prose edit routinely cost tens of times its proportional share of tokens and minutes, which taxes exactly the behavior the contract wants — bringing the counterpart along in the same PR.

## Decision

Pair updates run on a generated briefing instead of the guidance corpus; only new pairs still run the whole-document workflow, which is unchanged.

- **`pnpm run gen-translation-brief [pair...]`** ([scripts/gen-translation-brief.ts](../../../../scripts/gen-translation-brief.ts), assembly in [scripts/translation-brief.ts](../../../../scripts/translation-brief.ts)) prints, per out-of-sync pair: the authored side's diff from its recorded last-confirmed blob to the working tree, the counterpart sections that diff lands in with current line numbers (mapped through the heading structure, which the gate proves aligned at the last confirmed state; when both sides drifted or headings do not align, the briefing says so and withholds the mapping instead of guessing), the terminology rows whose terms appear in the changed lines, and a fixed digest of the binding update rules. The briefing is the translator's whole working set; the full sources of truth remain the escalation path for decisions the briefing cannot answer.
- **The update path in [dsh-translate-docs](../../../skills/dsh-translate-docs/SKILL.md)** consumes the briefing: mechanical diffs (changed lines confined to the byte-identical code fences) are applied by the orchestrator directly; prose diffs go to a subagent whose prompt is the briefing, not the corpus; verification is clause-by-clause on the changed hunks, not the whole document.
- **The pairing gate takes pair arguments.** `verify-translation-pairing [pair...]` checks just the named pairs (any of a pair's three files, or the bare stem, names it); the corpus-wide sweep remains the no-argument form that `doc-sync` and CI run. `--write` now requires naming the confirmed pairs — bare `--write` refuses, and re-recording everything is an explicit `--write --all` — because the old bare form silently blessed every drifted pair in the tree, including ones the caller never looked at, and a prose-only drift would then stay green forever. Each record's comment names its own scoped command.

## Benchmark

The decision followed a controlled replay of ten real pair updates from this repo's history (July 2026; 1-64 changed English lines each, READMEs, RFCs, Agent Notes, and user docs). Each example was reconstructed in a scratch repo at its true last-confirmed state with the English edit uncommitted, then run through competing workflows with fresh subagents: the status-quo corpus-loading path, the briefed path, a no-guidance control, whole-document re-translation, the briefed path on a small model, and a three-pairs-per-agent batch. Outputs were gated mechanically and scored blind by judges who also received the real historical update and the untouched stale counterpart as controls.

- The briefed path matched the status-quo path on judged faithfulness, preservation, and fluency — both at or above the real historical updates — while spending roughly a third of the tokens and wall clock on the stall-free examples (medians across all ten: 276k vs 595k relative token-cost units, 14 vs 32 turns).
- Re-translation was confirmed harmful, not merely wasteful: judged preservation collapsed (4.4/10 vs 9.8) because it discards reviewed phrasing, it drifted established terminology the update arms kept (the counterpart's own text carries the renderings), and it was the most expensive arm.
- The no-guidance control held quality too — the binding context for an update is the diff plus the counterpart's own reviewed text, not the corpus — but the briefing buys a fixed working set, inline terminology, and the both-sides-drifted warning at negligible cost over it.
- On the briefing, a small model performed at parity with the large one, so the update path no longer assumes a frontier translator.
- Batching three pairs into one subagent showed no reliable saving over three briefed runs and couples unrelated failures; it was rejected.

## Alternatives considered

- **Keep the workflow, just scope the gate** — the gate scan was the smaller cost; the corpus loads and archaeology dominated. Scoping alone would have left the ~3x overhead in place.
- **Whole-document re-translation as the update path** (what a naive pipeline does) — rejected on benchmark evidence: preservation collapse, terminology drift, highest cost. The contract's minimal-update rule survives with data behind it.
- **Batching several pairs per subagent** — rejected: no measured saving (briefings already deduplicate the fixed content), and one stalled or confused pair holds the others hostage.
- **Per-paragraph translation-memory records in the sidecar** (segment hashes instead of whole-file hashes) — rejected: paragraph boundaries may legitimately differ across the pair, either side can be authored first, and the records would bloat and conflict in merges. Heading-level mapping from the existing whole-file hashes recovers the same alignment when it is trustworthy and says so when it is not.
- **An update mode in the automated prompt pipeline (prompt-v5)** — deferred, not designed here: nothing drives [scripts/translation-prompt.ts](../../../../scripts/translation-prompt.ts) today, and the agent path was the live cost center. The pipeline keeps its whole-document v4 contract until it has a consumer.

## Consequences

- A small prose edit's counterpart update now costs a briefing generation plus one small focused task — no corpus reads, no archaeology, no corpus-wide scans inside the loop — and the same PR obligation holds; the cheap path and the correct path point the same way.
- The briefing generator is a second consumer of the consistency records: recorded blob hashes now also drive diff recovery and section mapping, strengthening the incentive to keep records honest.
- `--write` without arguments no longer works; muscle-memory callers must name pairs or pass `--all`. That is the point — the bulk bless is now a visible, deliberate act.
- Scoped checks mean an update loop can be green while an unrelated pair elsewhere is red; the corpus-wide check in `doc-sync`/CI still owns the tree-level invariant.
- The section mapping trusts heading alignment only where the gate proved it at the last confirmed state; documents restructured on one side fall back to an explicit "locate the regions yourself" briefing rather than a wrong map.

## Testing

[scripts/translation-brief.spec.ts](../../../../scripts/translation-brief.spec.ts) pins diff parsing, section mapping (including preamble and multi-section hunks), terminology row matching in both directions with word-boundary discipline, fence escalation, and the rendered briefing's contract (aligned sections, both-drifted warning, per-direction digests, scoped finish commands). [scripts/translation-pairing.spec.ts](../../../../scripts/translation-pairing.spec.ts) pins argument normalization (any pair file or bare stem to the anchor) and the CLI matrix: scoped check, bare `--write` refusal, `--write <pair>`, `--write --all`, `--list` exclusivity, unknown flags.
