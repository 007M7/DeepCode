# Agent Note: Storage root placement and derived-medium recovery

Status: proposed

English | [中文](2026-07-28-storage-root-and-derived-medium-recovery.zh.md)

## Problem

The persisted projection cache ([RFC](2026-07-27-session-projection-and-command-log.md), shipped as `dsh-session-projection-cache`) surfaced two gaps in the storage substrate it landed on. Both are properties of the domain-KV stack ([design](2026-07-24-domain-kv-storage-and-workspace.md)), not of the cache itself, and both bite the cache first because it is the first *derived* medium on that stack.

**Where the files actually live.** The shipped Web overlay gives the json backend a relative root — `root: './.storages'` (`apps/cli/config/web.cordis.yml`) — while the shared base defaults the session store to the global harness home (`$DSH_HOME/sessions`, default `~/.dsh/sessions`); no equivalent global root exists for `storage-json`. `JsonStorageBackend` never resolves its root either — each unit open joins the still-relative path against whatever `process.cwd()` is at that moment (packages/storage/storage-json/src/index.ts) — the exact hazard the JSONL session backend resolves-once to prevent ("later process.cwd() changes cannot split one backend across roots", packages/session-persistence/session-persistence-jsonl/src/index.ts). Net effect: session logs are global across launch directories, but `workspace.json` and `session_projcache.json` land under `<launch dir>/.storages/`. Two launches from different directories share their sessions yet see different workspace registries and different projection caches — and the cache exists precisely to serve the cross-session cold listing, which now misses for every session last cached under another launch directory.

**How recovery works today.** Inside a healthy medium the cache is fully self-healing by design: a `stateVersion`-mismatched row is discarded and refolded, a log shrunk below a row's watermark is detected by the anchored restore floor and answered with one full re-read, and every background write is fail-soft. But at the *medium* level there is no recovery at all: a truncated, hand-edited, or version-bumped `session_projcache.json` fails `openJsonUnit` with `malformed-medium`/`version-mismatch` (packages/storage/storage-json/src/format.ts), a schema-drifted record fails domain open with `invalid-record` (packages/storage/storage-domain/src/index.ts), the rejection propagates through `SessionProjectionCache[Service.init]`, and under the CLI's fail-loud boot the assembly refuses to start. A file whose entire content is rebuildable from session logs can brick boot. This contradicts the cache package's own stated stance ("a stale or unreadable cache costs a longer tail replay, never a wrong value") and the cache domain spec's JSDoc ("version bumps discard the whole medium"), which today describes an aspiration, not the implementation. The same fail-loud path is *correct* for `workspace.json` — workspace records are authoritative, not derivable — so the missing concept is a per-domain declaration of authority, not a global behavior change.

## Proposal

Two independent changes, one per gap.

### One global storage root, resolved once

- `AppCLIEntry.composePatches` Source 0 additionally patches `storage-json.root` to `join(resolveDshHome(), 'storages')` — `~/.dsh/storages` by default, beside `~/.dsh/sessions` — and `PROFILE_MAPPINGS` gains `storageRoot` → (`storage-json`, `root`), mirroring `persistenceRoot` exactly. The yml keeps `./.storages` as the raw-composition engineering default (tests and bare Loader boots are unaffected), same layering as the session root today.
- `JsonStorageBackend` resolves its configured root once at construction (`resolve(config.root)`), adopting the JSONL backend's recorded rationale verbatim: a later `process.cwd()` change must not split one backend across roots. The SQLite storage backend already resolves its path.
- Pre-release stance applies: no migration shim. A deployment that cached under `<cwd>/.storages` re-derives everything (workspace re-bootstraps from the header index; the projection cache refolds lazily) or moves the two json files by hand once.

### Declared derived media: reset instead of reject

- `DomainSpec` gains `recovery?: 'reject' | 'reset'` (default `'reject'`). The spec object is already the single source of a domain's identity and layout; whether its medium is authoritative or derived is the same kind of fact and lives in the same place. `session_projcache` declares `'reset'`; `workspace` stays on the default.
- `KvFacet` gains one primitive: `destroy(descriptor): Promise<void>` — remove the unit's medium entirely (json: delete the file; sqlite: drop the unit's tables). Like `open`, it is a backend storage primitive, not policy.
- `DomainFacility.open`, when a spec declares `'reset'` and the open fails with exactly a damage-class error — `StorageError('version-mismatch' | 'malformed-medium')` or `DomainError('invalid-record')` — logs one warning naming the domain and the discarded medium, calls `destroy`, and opens again empty. Every other failure (`backend-not-found`, `facet-unsupported`, `already-open`, I/O errors) stays loud regardless of the declaration: misconfiguration and environmental faults are not medium damage. The retry is single-shot — a second failure propagates, so a persistently failing medium cannot loop.
- With this in place the cache domain spec's version field gains its intended meaning: bumping `version` (or letting zod reject drifted rows) genuinely discards the whole medium and the cache rebuilds through its normal write points and cold reads — the recovery ladder's outermost rung, matching the row-level rungs already shipped.

## Alternatives considered

**Keep per-launch-directory `.storages` (status quo)** — rejected: sessions are global, so every derived-from-sessions medium splits against its own source of truth; the cache's motivating scenario (one listing over all sessions) structurally misses rows, and the workspace registry indexes sessions it cannot see from another launch directory.

**Patch only the projection cache's route to a global root, leave `workspace.json` per-cwd** — rejected: the workspace registry has the identical global-vs-cwd mismatch, and the user decision that shaped the cache placed it deliberately beside `workspace.json` — one hub root keeps the media co-located and the mental model single.

**Cache-plugin-local recovery (catch damage errors in `SessionProjectionCache[Service.init]`, delete the file, reopen)** — rejected: the plugin cannot name the medium path without reaching around the backend abstraction, and every future derived domain would re-implement the same catch; the facility is the one place that already classifies open failures.

**Fall back to an ephemeral in-memory domain on damage** — rejected: it silently degrades to memory-only for the life of the process and the damaged file never heals; the next boot fails the same way.

**Rename the damaged medium aside (`<unit>.json.corrupt-<ts>`) instead of deleting** — not chosen: a derived medium's damaged bytes have no recovery value (the logs are the source of truth) and the litter accumulates unbounded; delete is the honest operation. Rename-aside remains the right choice if a future *authoritative* domain ever wants reset semantics — which is exactly why `recovery` is per-spec.

**A blanket auto-reset for every domain (no spec field)** — rejected outright: `workspace.json` is authoritative user data; silently resetting it on a version bump would destroy workspaces. Authority is a property of the domain and must be declared by its owner.

## Acceptance criteria

- `dsh` launched from any directory reads and writes the same `$DSH_HOME/storages/*.json` (default `~/.dsh/storages`); the profile key `storageRoot` overrides it; a raw Loader boot of the yml still lands in `./.storages` relative to the boot cwd, resolved once at backend construction.
- With a truncated, version-bumped, or schema-drifted `session_projcache.json`, the assembly boots clean: one warning names the discarded medium, the file is gone, the cache rebuilds through normal operation, and the cold listing column reappears as sessions are re-checkpointed.
- The same damage to `workspace.json` still fails boot loudly.
- Facility tests cover: each damage class resets a `'reset'` domain exactly once; non-damage failures stay loud on a `'reset'` domain; a `'reject'` domain propagates every failure; `destroy` removes the medium on both shipped backends.

## Risks

- **Auto-delete on a misclassified error destroys a healthy file.** Mitigated by the closed damage-class list: reset fires only on the three deterministic parse-time codes; ENOENT is already "empty unit", and every I/O error (EACCES, EIO) propagates loudly. The single-shot retry bounds the blast radius to one delete per open.
- **Root relocation changes where existing checkouts look.** Accepted under the pre-release stance (backends reject old formats, no external consumers); the note above records the one-time manual move for anyone who cares about a per-cwd `workspace.json`'s content.
- **`destroy` is a new destructive primitive on the storage seam.** Its only caller is the facility's declared-reset path; the backend contract documents it as facility-owned, and nothing model-facing or user-facing can reach it.
