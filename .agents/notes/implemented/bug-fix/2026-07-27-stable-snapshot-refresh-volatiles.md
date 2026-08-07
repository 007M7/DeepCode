# Agent Note: Stable snapshot refresh volatiles

Status: implemented

English | [中文](2026-07-27-stable-snapshot-refresh-volatiles.zh.md)

## Problem

ACP snapshot comparison normalizes generated UUIDs, cwd aliases, spill locators, embedded event times, and omitted-byte counts, but refresh write-back persisted the fresh raw values. A behaviorally unchanged refresh therefore rewrote fixtures with new randomness or host-specific path spellings even though the comparison contract considered both logs equal.

Message identity needs a weaker structural precondition than aligned records: an unrelated log event can break record alignment while an inherited message's identity-free value remains unchanged across parent and child logs. Record mode also begins with freshly minted message UUIDs when it replaces an existing fixture.

## Decision

Before record or refresh writes session fixtures, the shared snapshot support fingerprints every complete surface message with its top-level `id` removed and groups occurrences across all parent/child logs. It reuses an existing UUID only when one fingerprint resolves to exactly one fresh ID and one existing ID, then applies that mapping to every fresh log. Repeated inherited occurrences with the same ID remain one candidate, while new, changed, duplicate-content, malformed, and conflicting messages keep their fresh IDs. ACP, JSON-RPC, and Web recorders pass fixture-ready logs through the same helper before writing.

Refresh write-back uses `normalizeSessionLog` as its volatile-value authority for aligned leaves. It normalizes the original harvested records with the fresh run's ids, cwd, and every cwd alias, while normalizing fixture records with the fixture header context; literal replacements affect only the raw values being written. After existing record alignment, it recursively compares fresh and existing leaves through those normalized records: normalized-equivalent leaves retain the existing raw value, while normalized-distinct leaves retain the fresh semantic value.

Before reuse, the complete logical-record layout must align, apart from the existing packed-chunk and inserted-title equivalences. Normalized-equivalent changed strings form a log-wide bijection: one fresh string maps to exactly one existing string and vice versa, so repeated IDs remain correlated across records. An unexplained record mismatch or conflicting mapping disables normalized string reuse for that log.

Object fields align by key. Array elements align only when all corresponding arrays have the same length; otherwise the fresh array wins. Strings remain atomic leaves. Existing packed-chunk timing alignment and inserted-title handling remain separate because they align logical events rather than values inside one record.

## Alternatives considered

**Use deterministic UUIDs and spill filenames in snapshot deployments.** Replacing production randomness would weaken the security shape under test or require test-only behavior in storage and approval implementations.

**Commit normalized fixtures.** Tokenized session logs would stop being raw replay inputs and would cause a broad fixture migration unrelated to the write-back defect.

**Preserve a whole record when its normalized form is unchanged.** This is simpler but churns a random field whenever another field in the same record changes semantically. Leaf-level preservation keeps those decisions independent.

## Consequences

Record and refresh no longer rewrite an unchanged unique message UUID solely because another event changed the surrounding record layout, regardless of whether ACP, JSON-RPC, or Web owns the recording. Repeated refreshes also retain aligned fixture values that the normalizer classifies as volatile, and new volatile categories added to the normalizer automatically inherit that write-back behavior. Structural ambiguity remains conservative: unmatched records, conflicting string mappings, resized arrays, strings containing both semantic and volatile changes, and non-unique message fingerprints use fresh values rather than risk reusing misaligned data.

Focused unit coverage pins scenario-wide parent/child message correlation, unrelated event insertion, record write-back, new/changed/ambiguous messages, recursive object/array behavior, conflicting mappings, fresh cwd aliases, volatile strings, and fresh semantic fields. Keyless refresh coverage proves approval UUIDs, cwd aliases, spill paths, and event-read volatility leave their committed fixtures byte-identical.
