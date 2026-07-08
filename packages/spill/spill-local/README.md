# @deepseek-ai/dsh-spill-local

The **local-filesystem** implementation of the [`@deepseek-ai/dsh-spill`](../spill) storage seam. Registers as `ctx.spillFiles` and persists a tool's oversized text to a private, session-scoped file the model's `read` tool can open.

## Storage layout

Files land at `<root>/session-<hash>/​<random>-<safeName>`:

- **`root`** — the config `root` (resolved to absolute), or a lazily-created private (0700) per-process directory under the OS temp dir when omitted. A predictable, world-readable root would let other local users read spilled tool output or plant symlinks.
- **`session-<hash>`** — a short `sha256(sessionId)` prefix, so a session's spill files group together and a future cleanup can drop them per session.
- **`<random>-<safeName>`** — an unpredictable hex prefix (defeats symlink planting in a shared root) plus the caller's `suggestedName` sanitized to one safe path segment (traversal-proof; mirrors the JSONL persistence backend's `encodeSegment`). The write is exclusive + owner-only (`open(path, 'wx', 0o600)`): it fails on any pre-existing path, symlink or not, so a planted target cannot redirect it.

## Config

| Key | Default | Meaning |
|---|---|---|
| `root` | private 0700 temp dir | Root directory for spill files. Set to keep them under a known location. |

`saveText` rejects on a real storage failure (permissions, ENOSPC); the spill policy treats a rejection as best-effort and keeps the inline result. See the seam README for the vocabulary and the [tool output spill RFC](../../../docs/rfc/implemented/architecture/2026-07-08-tool-output-spill-files.md) for the design.
