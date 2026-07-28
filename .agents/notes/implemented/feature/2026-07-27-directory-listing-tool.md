# Agent Note: Sample over-cap glob results across the tree, and give the model a directory-listing tool

Status: implemented

English | [中文](2026-07-27-directory-listing-tool.zh.md)

## Problem

Asked what a workspace contained, an agent described one subfolder as if it were the whole project.

The session log shows exactly how. The workspace held 22 top-level entries and 11,485 files. The model called `glob {"pattern": "*"}`, which matched 10,030 paths; the tool showed the first 100, and all 100 sat under a single recently-unpacked subdirectory holding 355 of those files. The model never saw the other 21 top-level entries and answered from the one it did see. The session cwd was correct throughout — nothing was misconfigured, and every number the tool printed was true.

Three properties of `glob` compose into that page:

- **A pattern with no `/` matches at any depth.** The pattern goes to ripgrep as `--glob=<pattern>`, where a glob without a separator matches the basename anywhere in the tree. `*` therefore means "every file in the workspace", not "the top level" — the opposite of what it means in a shell. The tool said nothing about this, and every example in its schema was `**/…`, so nothing suggested the plain form was recursive.
- **`--sort=modified` orders oldest first.** Unpacking an archive restores the timestamps stored inside it, which predate everything the user wrote, so a freshly unpacked subtree lands at the very front of any broad match. (Ripgrep sorts ascending; `--sortr` is the descending form and is not used here.)
- **The inline page was the head of that order.** `globMaxResults` (100) paths were kept from the front. Under the first two properties, one subtree takes every slot.

Each property is defensible alone. Together they make the most ordinary request an agent receives — "what is in this directory" — reliably produce a confident wrong answer, because nothing in the result distinguishes "the 100 newest files in this workspace" from "this workspace".

### What ordering can and cannot fix

A directory's name reaches the model only as the prefix of one of its files' paths, since `rg --files` emits files and never directory entries. That is enough for ordering to matter a great deal, and not enough for `glob` to answer the question.

Measured on a reproduction of the failure's shape — 24 top-level entries, 716 files, one recently-written subtree:

| First 100 paths chosen by | Distinct top-level names visible |
| --- | --- |
| modification time, oldest first (the shipped behavior) | 7 |
| round-robin across top-level entries | 21 |

So a differently chosen page does surface most of the missing names, and the original diagnosis that ordering could not have helped was wrong. What no ordering fixes: an entry with no files beneath it never appears at all (the reproduction's empty directory is absent from the complete 716-path output), and nothing in the output says which names are directories or how many entries a directory holds. `glob` can therefore convey a tree's rough shape; it cannot state a directory's contents.

## Decision

Two changes, in the two packages that own the two halves of the failure.

### The inline page of an over-cap `glob` result is sampled, not taken from the head

`@deepseek-ai/dsh-tool-fs-search`. A result within `globMaxResults` is unchanged: shown whole, in modification-time order. Only when the result is larger does the page change — and there, taking the head is what fails.

`sampleAcrossTopLevel` groups the complete result by leading path segment and fills the page round-robin: every top-level entry gets a slot before any entry gets a second, and an entry that runs out of paths drops out so its remaining slots go to the rest. Sort order survives where it still carries meaning — groups are visited in the order ripgrep first emits them, and each group's own paths keep their relative order. The page is emitted grouped by entry rather than interleaved, so the breadth is legible at a glance.

The footer states the basis, because a page that silently stopped being "the newest N" would be a second, quieter version of the same lie:

```
(Showing 100 of 10030 paths, sampled across 22 of the 22 top-level entries this pattern matched
instead of taken in modification-time order. Full sorted result stored at: …)
```

When the page cannot reach every top-level entry — more entries than slots — the footer says so with the shown/total spread and points at `list`. A flat result, where every path is its own top-level entry, keeps the plain `(Showing k of n paths. …)` footer: there the round-robin *is* the sorted head, and naming a spread would only restate the counts. The spill artifact always holds the complete list in modification-time order, so the sorted view is never lost.

The guidance and schema stop misleading in the same change: "not shell find or ls" becomes "not shell find"; both now state that a pattern without `/` matches basenames at any depth, that results are files and never directories, that a fitting result is modification-time ordered while a larger one is sampled, and that `list` is the tool for a directory's contents.

### `list`, in `@deepseek-ai/dsh-tool-fs`

A fourth model-facing filesystem tool over the existing `ctx.fs.listDir` primitive, which until now shipped with skill discovery as its only consumer; [the seam Agent Note](../../archived/architecture/2026-07-03-filesystem-directory-listing-seam.md) deferred the model-facing consumer to a separate decision, which this is.

It takes an optional `path` — defaulting to `.`, the calling agent's session workspace, so the common question needs no argument — and returns the direct children of one directory as `{ path, entries: [{ name, type }] }`, where `type` is `file`, `directory`, or `other`. It calls `listDir` and nothing else: the seam already reports absence as `FS_NOT_FOUND` and a non-directory target as `FS_NOT_DIRECTORY`, so a preceding `stat` would add a round-trip and a second source of truth.

Two presentation rules carry the decision:

- **Directories sort first, then files, then non-regular children, each alphabetically** — in the canonical value as well as the rendered text, so a Code Mode caller and the model see one ordering contract. The seam returns stable name order, which scatters subdirectories through the alphabet; capping such a list can drop every subdirectory and reproduce, inside `list`, the same blindness. Directory-first ordering makes truncation lose leaves, never structure.
- **The footer always states the complete listing's size and composition** — `(22 entries: 18 directories, 4 files)`, and when the view is capped at `listMaxEntries` (default 200, configurable), `(Showing 200 of 5000 entries: 12 directories, 4988 files. …)`. A partial listing therefore cannot read as a whole directory.

Directory entries render with a trailing `/` and non-regular children with `@`, so the model can tell what it may descend into without a second call.

`list` emits no `fs/observed`. Seeing a filename is not reading a file, and a listing must never satisfy the read-before-write gate that `@deepseek-ai/dsh-fs-policy` enforces. It declares `isConcurrencySafe`, because it mutates nothing at all.

### Why both

They answer different questions and neither substitutes for the other. `list` answers "what is here" exactly — entry names, their types, the complete count — which `glob` cannot do at any ordering. Sampling fixes the page a broad `glob` returns for every *other* question, which stays wrong even once a better tool exists, because the model has no reason to abandon a page that looks representative.

## Alternatives considered

**Leave `glob` ordering alone and only warn in the footer.** This is what the first implementation did: keep the recency head and add a clause saying the head covered 1 of 22 top-level entries. Rejected once measured. A warning asks the model to distrust the only data it has and go elsewhere; a better page just is not wrong. The warning also does nothing for a model that stops reading at the paths, which is the failure being fixed.

**Sample always, replacing modification-time order outright.** Rejected. Over a complete result the order answers age questions — what is stale, what was touched last — a genuinely useful and separate purpose, and a complete result is the case where the order costs nothing and means everything. Sampling only past the cap is the point where the order has already stopped describing the result: the head of a 10,030-path list is not "the oldest files worth knowing about", it is an arbitrary 1% of them.

**Sample by a skew threshold — head unless the head is badly concentrated.** Rejected. A threshold is a deployment-varying tunable with no evidence behind any value, and it makes the result's ordering contract conditional on data the model cannot see. "Over the cap" is a boundary the model already knows about from the footer.

**Balance recursively, not just at the top level.** Deferred, and recorded as a Known Limitation. Top-level balance fixes the observed failure and is explainable in one sentence of tool description; per-level balancing needs a policy for how depth trades against breadth, which no current evidence settles.

**Reject `*`, or silently rewrite it to a top-level-anchored pattern.** Rejected. The same basename-at-any-depth rule that makes `*` recursive is what makes `*.ts` mean "every TypeScript file", the overwhelmingly common and correct use; anchoring one and not the other is an arbitrary special case, and rejecting a pattern ripgrep accepts turns a working call into an error. Documenting the rule costs nothing and generalizes.

**Add `list` without touching `glob`.** Rejected, for the reason stated under *Why both* above. The misleading page is reachable from any broad pattern, and a model that believes its sample is representative has no reason to reach for another tool.

**Fix `glob` without adding `list`.** Rejected for the same reason in reverse. A sampled page shows most top-level *names*, but not which are directories, not the empty ones, and not the entry count; "what is in this directory" deserves a tool that answers it rather than a sample the model must infer from.

**Report per-directory child counts in `list`.** Rejected. Counting each entry's children means one `listDir` per child — an N+1 fan-out across a seam that may be remote or sandboxed, paid on every listing, to sharpen a decision the model can settle by listing the one subdirectory it cares about.

**Make `list` recursive with a depth argument.** Rejected for now. One level composes: the model lists what it needs to descend into. Recursion reintroduces the size and truncation problems this note exists to fix, and the provider primitive is deliberately one-level.

**Spill a capped listing through `ctx.spillStore`, as `glob` does.** Rejected for v1. `glob` needs spill because a truncated path list has no cheap successor call; a truncated listing does, and the footer states the complete size and composition, so the model knows both that it is looking at part of a directory and what to do about it.

## Consequences

An over-cap `glob` result no longer returns the most recently modified paths. That is a real contract change on a hot path, and it is why the footer, the prompt section, and the schema all state the sampled basis rather than leaving the model to infer it. A result within the cap is byte-identical to before, so age-ordered reading keeps working wherever it was working.

Balancing is by first path segment only, so a result concentrated deeper — one enormous directory inside an otherwise even tree — is still shown unevenly below the top level. Recorded in the package's Known Limitations.

The shipped tool surface grows by one tool in every deployment that loads `@deepseek-ai/dsh-tool-fs`, which is all of them: a fixed schema and prompt cost on every request, and an invalidated pinned request header in the ACP snapshot scenario that pins full system-prompt and tool-schema content. The gain is that the harness's most common question has a correct answer; the previous state was not a missing convenience but a capability hole that produced confidently wrong answers.

`ctx.fs.listDir` gains its first model-facing consumer, which makes its contract load-bearing for a product surface: a future remote or sandboxed backend must implement direct-child listing well enough for a model to navigate by, not merely well enough for skill discovery. The `other` type stays collapsed at the seam, so `list` cannot distinguish a symlink from a socket and marks both `@`.

## Testing

Package tests pin the model-visible text of both surfaces. For `glob`: `sampleAcrossTopLevel` over a concentrated result, an exhausted group handing its slots on, a page smaller than the top level, absolute paths outside the workdir, and a flat result that must reproduce the sorted head; plus end-to-end assertions that a fitting result is untouched, that an over-cap result returns the sampled page with the sampled-basis footer, that the list hint disappears once the page reaches every entry, and that a flat over-cap result keeps the plain footer. For `list`: the envelope, type markers, singular and plural footers, the empty-directory footer, and the capped footer that keeps the sole directory visible. A registry-level test asserts that a listing emits no `fs/observed` and that a following `edit` still fails `FS_NOT_OBSERVED`, so the tool cannot become an accidental read-before-write bypass. Prompt-section registration, schema registration, and HMR disposal cover the fourth tool alongside the existing three.

The assembled transcript is the `fs-list` ACP scenario: a workspace whose answer is its subdirectories, where the model calls `list` with no arguments and the pinned tool result carries the directory-first envelope and its composition footer — an answer `glob` could not have produced at all.
