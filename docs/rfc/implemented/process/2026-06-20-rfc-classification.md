# RFC: Classify RFCs by kind via path-encoded subdirectories

Status: implemented (proposed 2026-06-20, accepted 2026-06-20)

## Context

`docs/rfc/` grouped RFCs by **lifecycle** only — `proposed/` / `implemented/` / `rejected/`. Nothing recorded what *kind* of decision each RFC was. The index was one flat list per lifecycle, with no way to scan "show me every simplification" or "every testing-strategy decision." A wave of simplification RFCs landing on the same day made the gap concrete: a reader skimming `proposed/` could not tell a new capability from a removal from a tooling-policy change without opening each file.

The repo's standing bias is [mechanical quality gates over prose guidelines](2026-06-11-quality-gates.md): a convention that isn't machine-checked rots. So a classification scheme here had to be enforceable, not an honor-system header.

## Decision

Add a second axis — the RFC's **class** — and encode it in the path: `{lifecycle}/{class}/yyyy-mm-dd-topic.md`. The folder *is* the label. A file's location declares its class, the closed set is "these folders and no others," and the existing [verify-md-links](2026-06-18-markdown-cross-link-lint.md) gate already protects the path rewrites the move required.

### The closed set of six classes

| Class | Covers |
|---|---|
| `feature` | A new user- or model-facing capability. |
| `bug-fix` | Corrects a defect or closes a gap a postmortem surfaced. |
| `simplification` | Removes code, behavior, or surface area without adding a capability. |
| `architecture` | A structural decision about the **shipped source** — how packages relate, what the runtime vocabulary is. |
| `process` | Tooling, policy, or workflow **around** the code, not runtime behavior. |
| `testing` | Test infrastructure and strategy. |

The `architecture` / `process` line: **architecture** is about the source we ship; **process** is the surrounding tooling and workflow. This RFC is itself a `process` decision — it changes how the repo is organized and gated, not what the harness does at runtime — so it lives under `implemented/process/`.

### Two gates

Both are `doc-sync` members, in the `verify-md-wrap` style (tsx ESM, verify-don't-generate, exit non-zero on the first violation):

- **`scripts/verify-rfc-classification.ts`** — the closed set and index completeness. It asserts every file under a lifecycle folder lives in a class folder from the canonical set (a loose `.md` at a lifecycle root, or an unknown class folder, fails), and that `README.md` lists every RFC exactly once under the `###` heading matching its `{lifecycle}/{class}` path. The canonical class set lives as a `const` in this script — the machine source of truth — and [the index](../../README.md) documents it in prose; the two are kept in sync by hand (the README's completeness is gated, its class *descriptions* are not). This mirrors `verify-event-taxonomy`, which checks a doc table against source.
- **`scripts/verify-doc-refs.ts`** — source comments that cite docs. RFC paths are referenced not only from Markdown but from TypeScript doc comments (root-relative prose like `docs/rfc/implemented/testing/2026-06-19-acp-snapshot-tests.md`). `verify-md-links` never saw those, so the reorg could have silently orphaned them. This gate scans repo-authored `.ts` under `packages/**` and `examples/**` (excluding built `lib/` and `vendor/`) for `docs/….md` tokens, resolves each root-relative, and asserts it exists. It requires the `.md` extension so extensionless prose (`docs/postmortem/0001`, `docs/architecture.md § plugin checklist`) is left alone.

### Rejected alternatives

- **A `Classification:` prose line** in each file (next to `Status:`), parsed by the gate. Workable, but it duplicates into the file a fact the path can already carry, and a line can disagree with its folder. Path-encoding makes the label and its storage the same thing — there is nothing to keep in sync.
- **A `refactor` class.** It overlaps `simplification` almost entirely; the only discriminator anyone reached for was "does observable behavior change?", which `simplification` already encodes (it does not). One class, not two.
- **Auto-generating the README index** from the filesystem. Rejected to keep the index hand-written like every other doc here; the completeness gate gives the same drift-protection without generated Markdown in a curated file.

## Consequences

- Every RFC now sits under a class folder, and the index groups by class within each lifecycle. A reader scans one heading to see all simplifications, or all testing decisions.
- Two more fast tsx scripts in the `doc-sync` chain; no new dependency (the mdast/GFM stack was already present for `verify-md-wrap`/`verify-md-links`).
- Adding a class is a deliberate act: amend the `const` in `verify-rfc-classification.ts` and the [Classification section](../../README.md#classification), not just `mkdir` a folder. The gate rejects an unknown folder, so an ad-hoc class can't slip in.
- Source-comment doc references are now gated too — a moved or renamed doc that a `.ts` comment cites fails the pre-push hook, closing a drift class `verify-md-links` structurally could not see.
