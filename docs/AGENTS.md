# AGENTS.md — The documentation standard

This file defines Markdown tiers, writing rules, and `verify-doc-budgets` ceilings. Use [dsh-doc-standards](../.agents/skills/dsh-doc-standards/SKILL.md) for placement and validation, and [dsh-prose-standard](../.agents/skills/dsh-prose-standard/SKILL.md) for required coverage and editorial judgment; the [doc-tiers Agent Note](../.agents/notes/implemented/process/2026-07-04-doc-tiers-and-budgets.md) owns rationale.

## The tier taxonomy: one home per fact

Each fact has one home: the tier whose job it is. Elsewhere, link to that home; `verify-md-links` keeps links resolving while duplicated prose drifts.

| Tier | Job | Does NOT belong there |
|---|---|---|
| Root `AGENTS.md` | Standing orders: rules an agent needs in context in every session, one to three lines each, linking its home | Stories, worked examples, situational procedures, anything restated from a linked home |
| Subtree `AGENTS.md` (`packages/`, `examples/`, `docs/`, `.agents/notes/`) | Orders specific to that subtree | Repo-wide rules the root file already carries |
| [architecture.md](architecture.md) | The system map: services, the loop, extension seams — read before changing `packages/` | Type shapes (→ core-data-structures), per-package detail (→ package READMEs), decision rationale (→ Agent Notes), implementation-status annotations |
| [core-data-structures/](core-data-structures/core.md) | The type catalog: literal shapes and semantics of the spine and seam vocabulary | Behavior narration (→ architecture.md) |
| [Agent Notes](../.agents/notes/README.md) | Decision records: the why, what-was-given-up, and concise verification contract; `implemented/` notes describe shipped reality in present tense | Migration plans, acceptance-task checklists, fixture walkthroughs, and spec-speak ("should…") once the decision has shipped |
| [postmortem/](postmortem/README.md) | Incident stories — the only tier where war-story narrative belongs | — |
| [cookbook/](cookbook/adding-a-package.md) | Step-by-step how-tos with numbered verify steps | Design rationale (→ the Agent Note each guide links) |
| Package README | The per-package contract: config, semantics, limitations, extension points, and [Model Experience](cookbook/adding-a-package.md#4-write-the-package-readme) | JSDoc restatement, generated-catalog restatement (event/tool tables), other packages' concerns |
| [development.md](development.md) | First-stop contributor onboarding: local setup, daily workflow, and CI shape at summary level; a bilingual pair under the [i18n contract](i18n/README.md) | Runtime/version rationale (→ Agent Notes), gate-by-gate enumerations that drift from `package.json` scripts |
| Generated catalogs: [cordis events](cordis-catalog/events.md), [cordis services](cordis-catalog/services.md), [tool-catalog](tool-catalog.md), [config-catalog](config-catalog.md), [persistence-catalog](persistence-catalog.md), [module-graph.md](module-graph.md) | Exhaustive enumerations regenerated from source, freshness-gated | Hand edits of any kind |
| Skills (`.agents/skills/`) | Reusable workflows and specialized decision standards | Product and runtime contracts (→ docs or source) |

Placement: bugs → postmortems; rationale → Agent Notes; procedures → cookbooks; type shapes → core data; package contracts → READMEs; standing orders → root `AGENTS.md` with a rationale link.

## Writing rules

- **Document current state, not change history.** Avoid "previously/now/no longer", PRs, commits, and stack positions in durable prose; name the live mechanism. Put change stories in commits, PRs, Agent Notes, or postmortems.
- **Every non-trivial change includes at least one Agent Note in the same PR.** Update the owning note or add one; only mechanical/local edits are exempt ([scope](../.agents/notes/README.md#when-to-write-one)).
- **One physical line per paragraph** (`verify-md-wrap`): use editor soft-wrap. Code blocks, tables, and list structure keep their formatting; code comments stay under the linter's column limit.
- **Fenced `ts` blocks must compile** (`doc-typecheck`); a pasted type declaration and its original JSDoc use ` ```ts type-equiv `, while a body-stripped public class declaration uses ` ```ts public-api `; register either in the manifest so neither can drift ([mechanics](development.md#documenting-types-verbatim-ts-type-equiv)).
- **The [core-data-structures catalog](core-data-structures/core.md) updates in the same change** that reshapes a documented type. `verify-type-equiv` catches drifted pastes, not never-documented new types ([what counts as core](core-data-structures/core.md#what-counts-as-core)).
- **Bilingual pairs update together**: editing either side obligates the counterpart and a re-record in the same change ([i18n contract](i18n/README.md)).
- **Comments and JSDoc state complete contracts, not reasoning transcripts.** Preserve behavior, conditions, timing, modality, exceptions, consequences, and non-obvious orientation; delete implementation narration, test walkthroughs, review analysis, and code restatement. Keep the local contract and link to its owning rationale. Use [dsh-prose-standard](../.agents/skills/dsh-prose-standard/SKILL.md) for required coverage, decision rules, and examples.
- Your audience is professional programmers. Prefer concise and straight-forward English over metaphor. Do not overuse words like "gate", "vocabulary", "surface", "seams".

## Wordcount Budgets

[scripts/doc-budgets.manifest.json](../scripts/doc-budgets.manifest.json) sets standing-doc ceilings; `pnpm run verify-doc-budgets` rejects excess or missing files.

When the gate goes red:

1. **Relocate** content that belongs in another tier; leave a one-line link if needed.
2. **Condense** content that belongs here but can be shorter.
3. **Raise** the ceiling only when the words truly need the space; justify the manifest diff in the PR. A too-low ceiling is a budget bug.

Ceilings are guardrails, not reduction targets. Retain at least 5% headroom; lower a ceiling only when the document's durable contract still has room, and raise it when necessary content would otherwise be deleted. Targets: root `AGENTS.md` ≤ 1,600 words; `architecture.md` ≤ 1,800; each subtree `AGENTS.md` ≤ 600, except `packages/AGENTS.md` ≤ 650 and this file ≤ 1,250; `packages/README.md` ≤ 600. Review and the slop checklist govern unbudgeted tiers.

## The slop checklist

Hunt these in any doc; the [dsh-doc-standards](../.agents/skills/dsh-doc-standards/SKILL.md) skill runs this list as an audit:

- The same rule stated in more than one home. Grep a distinctive phrase; keep one home, convert the rest to links.
- Narrated history: "previously", "now", "no longer", "used to", "renamed", "was moved", references to PRs or commits. State the current fact; the why belongs in an Agent Note, the story in a postmortem or git.
- A war story told inline where a one-line rule plus a postmortem/Agent Note link would do.
- Implementation-status annotations in prose or diagrams ("implemented!", "future: …"). Status rots; the repo layout and package manifests carry it.
- Hand-restating a generated catalog or JSDoc: event tables, tool arg tables, method signatures. Link instead.
- Hand-maintained inventories of tests, packages, or implementation status when the tree or a generator is authoritative.
- Reasoning transcripts: step-by-step implementation narration, proof of obvious branches, test walkthroughs, or rejected local alternatives. Keep the resulting contract or durable rationale; delete the path used to derive it.
- The same rationale repeated beside sibling methods. State it once at the owning seam or shared helper.
- Paragraph walls: one paragraph carrying several rules and parenthetical asides. Split it, or demote the detail to the linked home.
- Emphasis inflation: bold, CAPS, or "critically" everywhere means nothing stands out. Reserve emphasis for the clause that changes behavior.
- Spec-speak in `implemented/` Agent Notes: "should", migration plans, acceptance checklists. An implemented Agent Note describes what is, per the [implemented-note instructions](../.agents/notes/implemented/AGENTS.md).

## Cross-reference with machine-checkable links, never free prose

Link repository references with relative Markdown paths, never bare filenames or Agent Note numbers. `verify-md-links` catches missing targets; the [cross-link Agent Note](../.agents/notes/implemented/process/2026-06-18-markdown-cross-link-lint.md) owns the rationale.

The gate checks file existence, not `#anchor` validity — verify anchors yourself when linking to one.
