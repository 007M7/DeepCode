# RFC: Single-source the acp-agent replay config

Status: proposed

## Problem

`examples/acp-agent` ships two hand-maintained configs: `cordis.yml` (the live tree) and `cordis.snapshot.yml` (the keyless replay tree). Stripped of comments and blanks, their entire difference is ONE plugin entry — the eight-line `llm-deepseek` stanza (with its `!!js` env keys and model list) versus the two-line `llm-replay` stanza. Every other entry is byte-identical, including the multi-line system prompt and both hook-bridge stanzas. Every app-shape change must therefore be made twice, and the [hook-snapshot-matrix RFC](../../implemented/testing/2026-07-04-hook-snapshot-matrix.md) records paying exactly that tax: "hence the symmetric edit to both configs".

Nothing gates the symmetry. If the copies drift, the snapshot tier silently exercises a different app than the one that ships — the ["green units, broken product" class of gap](../../../postmortem/0001-acp-default-export-drops-inject.md) the snapshot tier exists to close, reintroduced one level up, with reviewer vigilance as the only defense.

## Proposal

Make the replay tree derive from the live tree instead of mirroring it. Preferred endpoint: a single source — either `cordis.snapshot.yml` becomes a thin overlay that includes `cordis.yml` and swaps only the llm entry (if the vendored loader/include config supports entry-level override), or the acp-agent bin's existing `DSH_SNAPSHOT=replay` branch performs the one-entry swap on the parsed config and `cordis.snapshot.yml` is deleted. Fallback endpoint, if single-sourcing is judged too magical for a teaching example: keep both files and add a boring verify gate (in the `doc-sync`/`hygiene` family) asserting the two configs' entry sets are equal modulo the llm entry. The implementing PR picks after checking the loader's include/override capability, updates the recording docs, and amends the snapshot RFCs' facts per [implemented/AGENTS.md](../../implemented/AGENTS.md).

## Why not keep the twin?

An explicit replay file is transparently readable and teaches replay semantics — the strongest counterargument, and the reason the fallback keeps the file and adds only the gate. YAML surgery inside the published bin is real complexity in a shipping artifact, and an include-overlay depends on loader capability that may not exist. But the status quo — a 125-line hand-maintained near-copy of a 141-line file whose one meaningful difference is two lines, defended by nothing — is the one option with a silent failure mode, and it grows with every plugin the app gains (the hook-bridge stanzas are twins in both files).

## Acceptance criteria

- Either one config file plus a mechanical llm-entry swap exercised by the snapshot suite itself, or two files plus a symmetry gate that fails CI on any non-llm divergence.
- All snapshot scenarios (hook matrix included) pass unchanged; `pnpm run test:snapshot:record` still boots the live tree.

## Risks

The include-overlay shape may be unsupported by the vendored loader — then the bin-side swap or the gate. `echo-agent`/`coding-agent` are unaffected (no snapshot twin). If the gate route is chosen, it is one more bespoke verify script — the cost the repo's gate-friendly policy explicitly accepts for encoding an invariant no human reliably remembers.
