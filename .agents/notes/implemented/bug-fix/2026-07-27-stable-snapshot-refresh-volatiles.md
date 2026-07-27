# Agent Note: Stable snapshot refresh volatiles

Status: implemented

English | [中文](2026-07-27-stable-snapshot-refresh-volatiles.zh.md)

## Problem

ACP snapshot comparison normalizes generated UUIDs, cwd aliases, spill locators, embedded event times, and omitted-byte counts, but refresh write-back persisted the fresh raw values. A behaviorally unchanged refresh therefore rewrote fixtures with new randomness or host-specific path spellings even though the comparison contract considered both logs equal.

## Decision

Refresh write-back uses `normalizeSessionLog` as its sole volatile-value authority. It normalizes the original harvested records with the fresh run's ids, cwd, and every cwd alias, while normalizing fixture records with the fixture header context; literal replacements affect only the raw values being written. After existing record alignment, it recursively compares fresh and existing leaves through those normalized records: normalized-equivalent leaves retain the existing raw value, while normalized-distinct leaves retain the fresh semantic value.

Before reuse, the complete logical-record layout must align, apart from the existing packed-chunk and inserted-title equivalences. Normalized-equivalent changed strings form a log-wide bijection: one fresh string maps to exactly one existing string and vice versa, so repeated IDs remain correlated across records. An unexplained record mismatch or conflicting mapping disables normalized string reuse for that log.

Object fields align by key. Array elements align only when all corresponding arrays have the same length; otherwise the fresh array wins. Strings remain atomic leaves. Existing packed-chunk timing alignment and inserted-title handling remain separate because they align logical events rather than values inside one record.

## Alternatives considered

**Use deterministic UUIDs and spill filenames in snapshot deployments.** Replacing production randomness would weaken the security shape under test or require test-only behavior in storage and approval implementations.

**Commit normalized fixtures.** Tokenized session logs would stop being raw replay inputs and would cause a broad fixture migration unrelated to the write-back defect.

**Preserve a whole record when its normalized form is unchanged.** This is simpler but churns a random field whenever another field in the same record changes semantically. Leaf-level preservation keeps those decisions independent.

## Consequences

Repeated refreshes no longer rewrite aligned fixture values solely because the normalizer classifies them as volatile, and new volatile categories added to the normalizer automatically inherit the write-back behavior. Structural ambiguity remains conservative: unmatched records, conflicting string mappings, resized arrays, and strings containing both semantic and volatile changes use fresh values rather than risk reusing misaligned data.

Focused unit coverage pins recursive object/array behavior, correlated IDs, ambiguous-layout fallback, conflicting mappings, fresh cwd aliases, volatile strings, and fresh semantic fields. Keyless refresh coverage proves approval UUIDs, cwd aliases, spill paths, and event-read volatility leave their committed fixtures byte-identical.
