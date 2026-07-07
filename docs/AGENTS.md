# AGENTS.md — The documentation standard

This file is the contract for every Markdown surface in the repo: each tier's job, the writing rules, and the word budgets the `verify-doc-budgets` gate enforces. The audit/apply workflow is the [dsh-doc-standards](../.agents/skills/dsh-doc-standards/SKILL.md) skill; the decision record is [the doc-tiers-and-budgets RFC](rfc/implemented/process/2026-07-04-doc-tiers-and-budgets.md).

## The tier taxonomy: one home per fact

Every fact has exactly one home — the tier whose job it is — and every other place that needs it links there instead of restating it. A rule restated in two files drifts word-by-word until the copies disagree; a link cannot drift, and `verify-md-links` keeps it resolving.

| Tier | Job | Does NOT belong there |
|---|---|---|
| Root `AGENTS.md` | Standing orders: rules an agent needs in context in every session, one to three lines each, linking its home | Stories, worked examples, situational procedures, anything restated from a linked home |
| Subtree `AGENTS.md` (`packages/`, `examples/`, `docs/`) | Orders specific to that subtree | Repo-wide rules the root file already carries |
| [architecture.md](architecture.md) | The system map: services, the loop, extension seams — read before changing `packages/` | Type shapes (→ core-data-structures), per-package detail (→ package READMEs), decision rationale (→ RFCs), implementation-status annotations |
| [core-data-structures/](core-data-structures/core.md) | The type catalog: literal shapes and semantics of the spine and seam vocabulary | Behavior narration (→ architecture.md) |
| [rfc/](rfc/README.md) | Decision records: the why and the what-was-given-up; `implemented/` RFCs describe shipped reality in present tense | Migration plans, test checklists, and spec-speak ("should…") once the decision has shipped |
| [postmortem/](postmortem/README.md) | Incident stories — the only tier where war-story narrative belongs | — |
| [cookbook/](cookbook/adding-a-package.md) | Step-by-step how-tos with numbered verify steps | Design rationale (→ the RFC each guide links) |
| Package README | The per-package contract: config, semantics, limitations, extension points | JSDoc restatement, generated-catalog restatement (event/tool tables), other packages' concerns |
| [development.md](development.md) | Human-facing setup and daily workflow; a bilingual pair under the [i18n contract](i18n/README.md) | Gate-by-gate enumerations that drift from `package.json` scripts |
| Generated catalogs: [cordis events](cordis-catalog/events.md), [cordis services](cordis-catalog/services.md), [tool-catalog](tool-catalog.md), [config-catalog](config-catalog.md), [persistence-catalog](persistence-catalog.md), [module-graph.md](module-graph.md) | Exhaustive enumerations regenerated from source, freshness-gated | Hand edits of any kind |
| Skills (`.agents/skills/`) | Workflows: how to carry out a recurring task against the contracts | The contracts themselves (→ docs) |

Placement test: a story about a bug → postmortem. Why we chose X → RFC. How to do task Y → cookbook. What type Z looks like → core-data-structures. What package P promises → its README. A rule every agent must always obey → root AGENTS.md, one line, linking the home that holds the why.

## Writing rules

- **Document the current state — never the process or history that produced it.** Prose describes what the code IS and why, as if it had always been so: no "previously/now/no longer/used to/renamed/moved here", and never name a change unit the reader cannot see — a PR, commit, or stack position — in comments, JSDoc, or test names; name the mechanism instead. A genuinely clarifying contrast is framed against the live alternative as a standing fact, not against the past. The change story belongs in the commit message, the PR description, or an RFC.
- **A decision worth re-litigating gets an RFC in the same PR.** The test: would a maintainer six months out ask "why was it done this way?" and find no answer in the code? If yes, write one ([when to write one](rfc/README.md)); mechanical or self-evident changes need none.
- **One physical line per paragraph** (`verify-md-wrap`): the editor soft-wraps; hard breaks make a one-word edit re-diff the whole paragraph. Prose only — code blocks, tables, and list structure stay; code comments stay under the linter's column limit.
- **Fenced `ts` blocks must compile** (`doc-typecheck`); a pasted type definition is fenced ` ```ts type-equiv ` and registered in the manifest so it cannot drift ([mechanics](development.md#documenting-types-verbatim-ts-type-equiv)).
- **Every new event's JSDoc carries an `@mode` tag** (emit | waterfall | parallel | serial); the catalog generator hard-errors without it. Write the JSDoc to stand alone — it becomes the catalog entry ([catalog RFC](rfc/implemented/process/2026-06-20-generated-cordis-catalog.md)).
- **The [core-data-structures catalog](core-data-structures/core.md) updates in the same change** that reshapes a documented type. `verify-type-equiv` catches drifted pastes, not never-documented new types ([what counts as core](core-data-structures/core.md#what-counts-as-core)).
- **Bilingual pairs update together**: editing either side obligates the counterpart and a re-record in the same change ([i18n contract](i18n/README.md)).

## Budgets and the ceiling gate

Standing docs accrete: every PR has a lesson it wants to append, and without displacement pressure nothing ever leaves. The gate is that pressure. [scripts/doc-budgets.manifest.json](../scripts/doc-budgets.manifest.json) lists the accretion-prone standing docs with a word ceiling each; `pnpm run verify-doc-budgets` (part of `doc-sync`, so CI and pre-push run it) fails when a doc exceeds its ceiling, and fails when a budgeted file is missing so a rename cannot orphan its budget.

- Ceilings are an enforcement frontier with working headroom: a ceiling sits at least 5% above the doc's current size — routine edits pass, real growth trips the gate — and ratchets down, keeping the margin, as the doc reaches target. Target budgets: root `AGENTS.md` ≤ 1,500 words; `architecture.md` ≤ 1,800; each subtree `AGENTS.md` ≤ 600, except this file (which carries the standard) ≤ 1,250; `packages/README.md` ≤ 600.
- When the gate goes red, first ask whether the added words belong in this tier and whether the existing wording can be condensed. If the words do not belong, relocate per the taxonomy above; if they belong but can be shorter, condense. If they truly need the space, raise the ceiling and justify the manifest diff in the PR. A ceiling set too low is a budget bug, and correcting it is the fix.
- Unbudgeted tiers (package READMEs, RFCs, reference matrices) have no ceiling — length is legitimate there when every row is a fact. Review and the slop checklist govern them instead.

## The slop checklist

Hunt these in any doc; the [dsh-doc-standards](../.agents/skills/dsh-doc-standards/SKILL.md) skill runs this list as an audit:

- The same rule stated in more than one home. Grep a distinctive phrase; keep one home, convert the rest to links.
- Narrated history: "previously", "now", "no longer", "used to", "renamed", "was moved", references to PRs or commits. State the current fact; the why belongs in an RFC, the story in a postmortem or git.
- A war story told inline where a one-line rule plus a postmortem/RFC link would do.
- Implementation-status annotations in prose or diagrams ("implemented!", "future: …"). Status rots; the repo layout and package manifests carry it.
- Hand-restating a generated catalog or JSDoc: event tables, tool arg tables, method signatures. Link instead.
- Paragraph walls: one paragraph carrying several rules and parenthetical asides. Split it, or demote the detail to the linked home.
- Emphasis inflation: bold, CAPS, or "critically" everywhere means nothing stands out. Reserve emphasis for the clause that changes behavior.
- Spec-speak in `implemented/` RFCs: "should", migration plans, acceptance checklists. An implemented RFC describes what is, per [rfc/implemented/AGENTS.md](rfc/implemented/AGENTS.md).

## Cross-reference with machine-checkable links, never free prose

When one doc refers to another doc, an RFC, a package README, or any file in the repo, link it with a relative Markdown link to the actual path — never bare prose or a number ("see RFC 005"), which is uncheckable and rots on rename. `pnpm run verify-md-links` (part of `doc-sync`; see [the cross-link lint RFC](rfc/implemented/process/2026-06-18-markdown-cross-link-lint.md)) fails when a relative target does not exist, so a rename that orphans a link is caught before review. This is also why RFC files carry dates and topics instead of stable numbers: they survive moves between lifecycle and class folders without dangling references.

The gate checks file existence, not `#anchor` validity — verify anchors yourself when linking to one.
