# Agent Note: Project-grouped session directories

Status: implemented

English | [中文](2026-07-24-project-session-directories.zh.md)

## Problem

A persistence root may be local to one project, shared by several projects, temporary, or centralized. The hashed cwd buckets kept all deployments functional but made a shared root difficult to navigate because a developer could not recognize a project from its directory name.

Each JSONL session also occupied one file directly inside the project bucket. That shape had no ownership directory for additional session artifacts such as metadata, attachments, spill files, or coordination state.

## Decision

The JSONL backend stores sessions under a readable project key and gives every session its own directory:

```text
<configured-root>/
  --<normalized-cwd>--<hash>/
    <encoded-session-id>/
      session.jsonl.zstd
```

Raw mode uses `session.jsonl`, and sessions without a cwd use `_no-cwd`. Filesystem and drive separators become `-`, unsafe code units use `~XXXX`, and the readable prefix is bounded to keep the component within filesystem limits. A short SHA-256 suffix distinguishes project paths whose readable forms collide or truncate alike.

The configured root remains a deployment choice. The layout neither selects a global root nor requires projects to share one. When a deployment does centralize storage, project paths remain recognizable; a project-local root uses the same deterministic structure.

The encoded session id names an ownership directory rather than the transcript itself. `SessionPersistence.locate()` continues to return the fixed transcript path, preserving hook `transcript_path` and `DSH_SESSION_JSONL` semantics. Discovery ignores other entries inside the session directory so the backend can add session-owned artifacts without another layout change.

Lazy materialization remains tied to the transcript: `create()` performs no filesystem I/O, and the first append creates the project/session directories before collision-safe transcript publication. Empty directories are not listed as sessions. The backend rejects flat `<project>/<id>.jsonl*` artifacts with an explicit layout error; the pre-release format provides no automatic data migration.

## Alternatives considered

**Keep opaque cwd hashes.** This preserved short names but defeated the requested navigation by project path when several projects share a persistence root.

**Put session files directly in each project directory.** This matched Claude Code and pi's basic file organization but left no session-level ownership boundary for future artifacts.

**Replace separators without a collision suffix.** This is readable but lossy: paths containing literal `-` can collide with paths where `-` represents a separator. Retaining a short hash suffix preserves readable navigation without merging distinct projects.

**Mandate a centralized root.** Rejected because storage placement belongs to deployment configuration. Project grouping is useful when roots are shared and harmless when they are not.

**Load both flat and directory layouts.** Rejected under the pre-release no-compatibility stance. One accepted layout keeps identity checks and discovery deterministic.

## Consequences

Shared stores can be navigated by recognizable project names, while local and custom roots keep their existing configuration freedom. Every session has a directory available for future backend-owned artifacts, and existing transcript consumers still receive a file path.

Project directory names are longer than the former 12-hex cwd hashes. Very long paths show only a bounded prefix plus their distinguishing hash, and moving a project still selects a different directory because the absolute cwd remains part of storage identity.
