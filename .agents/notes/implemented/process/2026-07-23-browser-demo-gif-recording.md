# Agent Note: Browser demo GIF recording

Status: implemented

English | [中文](2026-07-23-browser-demo-gif-recording.zh.md)

## Problem

Browser demonstrations have been assembled with one-off capture and encoding commands. That makes timing and output size inconsistent, encourages continuous recordings that obscure the useful state changes, and can blur the boundary between a genuine server or API flow and a fixture. Combining local recording with attachment upload or pull-request editing also gives a media task unrelated remote-write authority.

## Decision

The repository provides the [`record-browser-gif`](../../../skills/record-browser-gif/SKILL.md) skill for local browser-demo artifacts. It uses the available browser-control workflow, establishes whether the requested flow is real, fixture-backed, or otherwise simulated, and captures a small storyboard only after semantically observable UI states. Frames and the output live outside the Git worktree by default.

The bundled `encode_gif.py` helper orders frames lexically, assigns explicit hold durations, uses an `ffmpeg` palette pipeline, and validates source dimensions plus the encoded frame count, dimensions, duration, and byte limit through `ffprobe`. The workflow stops after returning the verified absolute GIF path; uploading the artifact and mutating a pull request, issue, or document remain separate workflows.

## Alternatives considered

**Record continuous video and convert it afterward.** Continuous capture preserves every cursor movement and loading transition but produces larger, noisier artifacts and makes deterministic timing harder. A state storyboard better fits short feature demonstrations where the meaningful evidence is a handful of visible transitions.

**Keep an inline `ffmpeg` recipe in the skill.** Reconstructing quoting, timing manifests, palette filters, overwrite behavior, and post-encode checks in every run is error-prone. A bundled helper keeps those mechanics executable while the skill owns capture judgment.

**Include GitHub attachment and description editing.** Upload and remote mutation require separate authentication, confirmation, and recovery rules. Excluding them keeps invocation of a recording skill local and reversible.

**Use a fixture whenever it is easier to stage.** Fixtures are valid when the requested demonstration is explicitly fixture-backed, but they do not substantiate a real-server or real-API claim. The skill preserves the requested provenance and reports a missing prerequisite instead of silently changing it.

## Consequences

Recordings are small, repeatable local artifacts with explicit provenance and a clean repository boundary. The workflow gives up smooth continuous motion, depends on locally available `ffmpeg` and `ffprobe`, and requires the recorder to identify semantic capture points. The helper is exercised against a four-state browser demonstration and invalid duration input; skill shape and repository links are covered by the skill validator and documentation gates.
