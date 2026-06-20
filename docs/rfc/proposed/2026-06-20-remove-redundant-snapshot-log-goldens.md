# RFC: Remove redundant recorded snapshot log goldens

Status: proposed

## Problem

Recorded ACP snapshot scenarios ship both `session.jsonl` and `session.golden.jsonl`. For normal recorded scenarios, `session.jsonl` is the replay fixture harvested from a real run, and the replay test normalizes the newly persisted log and compares it to `session.golden.jsonl`. In the current fixtures, the normalized recorded log and normalized golden are identical for the ordinary recorded scenarios.

The duplicate file can help review by showing "expected persisted log" separately from "model replay input", but for recorded scenarios those are intentionally the same artifact. Keeping both means a re-record churns two files with the same semantic content.

## Proposal

For recorded scenarios, compare the replay run's normalized session log directly against normalized `session.jsonl`. Keep explicit `session.golden.jsonl` only for authored scenarios where `replay.override.json` drives behavior that is not derivable from the fixture, or where the expected persisted log intentionally differs from the replay script.

Stdout goldens remain unchanged; they are the editor-facing projection and are not redundant with the session fixture.

## Acceptance criteria

- Recorded scenarios stop committing `session.golden.jsonl`.
- The snapshot test derives the expected session log from `session.jsonl` for `recorded: true` scenarios.
- Authored sidecar scenarios keep explicit session goldens when needed.
- Orphan-fixture guards understand which files are required by scenario kind.
- The [ACP snapshot tests RFC](../implemented/2026-06-19-acp-snapshot-tests.md) is updated to describe the reduced fixture set.

## What we give up

Reviewers lose one redundant artifact that made the expected persisted log visually separate from the replay fixture. The stdout golden still protects the editor transcript, and comparing replay output to the recorded fixture preserves the loop/persistence regression check without duplicating files.
