# Agent Note: Stable snapshot refresh volatiles

Status: implemented

English | [中文](2026-07-27-stable-snapshot-refresh-volatiles.zh.md)

## Problem

ACP snapshot comparison normalizes generated UUIDs, cwd aliases, spill locators, embedded event times, and omitted-byte counts, but refresh write-back persisted the fresh raw values. A behaviorally unchanged refresh therefore rewrote fixtures with new randomness or host-specific path spellings even though the comparison contract considered both logs equal.

## Decision

Refresh write-back uses `normalizeSessionLog` as its sole volatile-value authority. After existing record alignment, it recursively compares fresh and existing leaves through their normalized records: normalized-equivalent leaves retain the existing raw value, while normalized-distinct leaves retain the fresh semantic value.

Object fields align by key. Array elements align only when all corresponding arrays have the same length; otherwise the fresh array wins. Records must retain the same type, and strings remain atomic leaves. Existing packed-chunk timing alignment and inserted-title handling remain separate because they align logical events rather than values inside one record.

## Alternatives considered

**Use deterministic UUIDs and spill filenames in snapshot deployments.** Replacing production randomness would weaken the security shape under test or require test-only behavior in storage and approval implementations.

**Commit normalized fixtures.** Tokenized session logs would stop being raw replay inputs and would cause a broad fixture migration unrelated to the write-back defect.

**Preserve a whole record when its normalized form is unchanged.** This is simpler but churns a random field whenever another field in the same record changes semantically. Leaf-level preservation keeps those decisions independent.

## Consequences

Repeated refreshes no longer rewrite aligned fixture values solely because the normalizer classifies them as volatile, and new volatile categories added to the normalizer automatically inherit the write-back behavior. Structural ambiguity remains conservative: changed record types, resized arrays, and strings containing both semantic and volatile changes use fresh values rather than risk reusing misaligned data.

Focused unit coverage pins recursive object/array behavior, volatile strings, and fresh semantic fields. Keyless refresh coverage proves approval UUIDs, cwd aliases, spill paths, and event-read volatility leave their committed fixtures byte-identical.
