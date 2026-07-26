# Agent Note: Make packed chunk rows the default JSONL layout

Status: proposed

English | [中文](2026-07-26-packed-chunk-rows-by-default.zh.md)

## Problem

The JSONL persistence backend can losslessly replace a run of at least three consecutive same-block `assistant/chunk` delta events with one `text-chunks`, `reasoning-chunks`, or `tool-call-chunks` storage row. Loading expands that row back into the exact events, including sequence numbers, timestamps, and chunk boundaries. The codec therefore reduces repeated JSON envelopes without changing the authoritative logical session log.

`packChunks` nevertheless defaults to `false` in both `dsh-session-persistence-jsonl` and the ACP demo composition. That default was chosen so the first packed-row implementation could land without rewriting the snapshot corpus. It now makes the ordinary write path, most tests, and almost every committed session fixture exercise the larger one-event-per-line representation, while only one dedicated ACP scenario exercises packing.

The snapshot corpus is part of the default contract, not disposable test data. ACP and headless snapshots harvest physical persistence files, but the TUI snapshot writer serializes `Session.events` directly and bypasses the backend encoder. Flipping one schema default would therefore leave different products and test tiers with different physical layouts, and future fixtures could silently return to unpacked rows.

This proposal changes only the physical storage representation. Every provider chunk remains one logical `assistant/chunk` session event, is delivered live through `session/event`, occupies its own sequence number, and remains addressable by `sourceEventSeqs` after load. Coalescing live events before `Session.append()` is outside this proposal because it would change UI streaming, cancellation evidence, provenance, and replay semantics established by the [session-persistence decision](../../implemented/architecture/2026-06-14-session-persistence.md).

## Proposal

Packed chunk rows become the default physical layout for every JSONL writer, shipping composition, default-path test, and committed session-log fixture. The JSONL backend resolves omitted `packChunks` to `true`; the ACP demo's pass-through config does the same; CLI, TUI, headless, and other compositions that omit the option inherit the backend default.

`packChunks: false` remains an explicit write-side opt-out for line-per-event diagnostics and compatibility tests. Reading stays unconditional and layout-blind, so packed, unpacked, and mixed existing logs continue to load without migration or a session-format version change. The option controls only newly appended batches; it does not select a reader mode.

The packed codec remains at the `dsh-session` storage seam. Persistence, fixture producers, normalizers, and replay readers share `packChunkRuns()` and `decodeStorageRecord()` rather than introducing a snapshot-only encoding. Packing remains per durable append batch and retains the existing minimum run length and exact-shape allowlist.

## Implementation plan

1. Change `SessionPersistenceJsonl.Config.packChunks` and the ACP demo wrapper default to `true`. Update their JSDoc, bilingual READMEs, generated config catalog, and every current-state statement that calls packed rows opt-in. Keep the explicit boolean so deployments can request unpacked writes without coupling that choice to `compression: 'none'`.
2. Make the JSONL backend's default-path tests assert packed output without passing `packChunks: true`. Retain narrowly named tests for `packChunks: false`, byte-identical unpacked writes, mixed-layout reads, malformed packed rows, and torn tails. Tests whose subject is unrelated persistence behavior omit the flag and therefore exercise the shipping default.
3. Make every snapshot fixture producer emit the same physical layout. ACP and headless suites harvest the backend's packed raw-mode artifacts. The TUI snapshot writer applies the shared codec instead of mapping `session.events` directly to lines. Raw `compression: 'none'` remains necessary for reviewable fixtures but no longer implies one logical event per physical line.
4. Re-encode every committed session-format JSONL fixture by decoding its current records and packing the recovered event list after the unchanged header. This includes parent and child `session*.jsonl` files plus replay and expected-session files whose first record is `session`. The migration must prove exact decoded event equality before and after; it does not call a model or regenerate transcript content.
5. Remove the `packed-chunks.cordis.yml` and replay overlay because packing no longer needs a special composition. Keep the authored `packed-chunks` scenario as the all-row-kinds contract under the ordinary config: it must contain `text-chunks`, `reasoning-chunks`, and `tool-call-chunks`, decode event-for-event equal to its independent source fixture, and re-persist identically through the assembled application.
6. Add an inventory-free check to the keyless snapshot gate that discovers session-format JSONL fixtures by their `session` header, decodes them, and rejects any fixture whose physical records differ from the canonical packed encoding. This covers future scenarios and child logs without a hand-maintained path list. Explicit unpacked and mixed-layout compatibility inputs stay in focused package tests, not the default snapshot corpus.
7. Update the implemented session-persistence and snapshot Agent Notes to distinguish logical events from storage records and to describe packed fixtures as the ordinary layout. Run focused codec and JSONL persistence coverage, every snapshot suite, documentation synchronization, lint, and whitespace validation.

## Alternatives considered

**Flip only the backend schema default.** This would change most runtime writes but leave the ACP wrapper's resolved default, TUI's direct serializer, existing fixtures, and future fixture policy inconsistent. A default is credible only when shipping compositions and the tests that represent them share it.

**Keep snapshots unpacked for readability.** The decoder and normalizer already understand packed rows, and one row retains every chunk boundary and timestamp explicitly. Keeping the largest committed consumer on the legacy layout would make snapshot coverage avoid the shipping write path and preserve the original reason the default stayed off.

**Remove `packChunks` and always pack.** One canonical writer is simpler, but an explicit unpacked form remains useful for line-oriented diagnostics and for proving mixed-layout compatibility. The pre-release stance permits removing the option later if those concrete uses disappear; changing the default does not require that additional decision.

**Batch chunks as logical session events.** This would reduce event count rather than only storage envelopes, but it would also delay or reshape live `session/event` delivery, renumber provenance, and require every UI and replay consumer to understand a second streaming unit. The storage codec already obtains the size benefit behind a smaller interface without changing those contracts.

## Acceptance criteria

- Omitting `packChunks` writes eligible runs as packed rows in the JSONL backend and every shipping app composition.
- `packChunks: false` still writes one event per line, while both configurations read packed, unpacked, and mixed logs into identical contiguous `SessionEvent[]` values.
- Every committed session-format snapshot fixture is in canonical packed form, and a keyless top-level snapshot check prevents unpacked packable runs from returning.
- ACP, headless, and TUI snapshot recording or refresh preserves the packed layout without changing the decoded event stream, model script, transcript, or expected user output.
- The ordinary packed scenario retains all three row kinds and exact decoded equality with its source fixture without a packing-specific config overlay.
- Current documentation consistently calls packed rows the default physical JSONL layout and preserves the distinction between storage rows and logical `assistant/chunk` events.

## Risks

The implementation creates a large fixture diff even though logical behavior is unchanged; reviewers must use decoded equality and the canonical-layout check rather than inspect thousands of mechanical line replacements. Tools that read raw JSONL and assume every post-header line is a `SessionEvent` will encounter storage-row tags more often, although that assumption is already outside the documented format and the repository readers decode rows unconditionally. Packed rows also make a raw file less convenient for per-token line processing; `packChunks: false` remains the deliberate escape hatch.
