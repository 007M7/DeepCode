# Spill Storage

The spill storage seam — a [capability seam](../rfc/implemented/architecture/2026-07-08-tool-output-spill-files.md) that persists a tool's oversized text to a session-scoped path the model can later `read`, split across packages: interface ([dsh-spill](../../packages/spill/spill), `ctx.spillFiles`), implementation ([dsh-spill-local](../../packages/spill/spill-local), private session-scoped files on the host filesystem), and consumer ([dsh-spill-policy](../../packages/spill/spill-policy), the `tools/post-execute` policy). Spill is **one optional capability**, not part of the agent-loop spine — so its vocabulary lives here, not in [core.md](core.md). Preview mechanics stay in [dsh-retention](../../packages/util/retention); this seam only saves the final text the policy hands it.

Source: [`packages/spill/spill/src/types.ts`](../../packages/spill/spill/src/types.ts)

## The save request

`saveText` is the whole seam: persist `content` verbatim, return a readable path plus the exact byte count. The request carries WHO the artifact belongs to (`owner`), WHERE it came from (`source`, descriptive provenance for the filename and future cleanup — not access control), and a `suggestedName` the backend sanitizes to one safe path segment before use (it is a hint, never a path).

```ts type-equiv
interface SaveTextSpill {
  owner: SpillOwner
  source: SpillSource
  suggestedName: string
  content: string
}
```

```ts type-equiv
interface SpillOwner {
  sessionId: SessionId
}
```

`SpillOwner` scopes storage to a `SessionId` — spill is inherently session-scoped (its directory layout and future cleanup unit are per session), so the seam imports `dsh-session`'s `SessionId` directly rather than minting a decoupled token like the bash executor's cross-session `OwnerToken` ([bash.md](bash.md)).

```ts type-equiv
interface SpillSource {
  toolName: string
  callId: CallId
  label: string
}
```

## The result

```ts type-equiv
interface SpillRef {
  path: SpillPath
  bytes: number
}
```

`SpillPath` is a [branded](core.md#branded-ids) local filesystem path returned by the backend and intended for the model's `read` tool. The brand records that the path came from the spill seam (a runtime artifact, not a workspace file the model authored); it is still rendered to the model as an ordinary path string in v1. A future remote or virtual backend may replace it with a `spill://…` URI plus a read-only filesystem bridge, so consumers treat it as opaque.

```ts type-equiv
type SpillPath = Branded<'SpillPath'>
```

## The service

`SpillFiles` (`ctx.spillFiles`, defined in [`packages/spill/spill/src/index.ts`](../../packages/spill/spill/src/index.ts)) is a one-method abstract service: `saveText(input) → Promise<SpillRef>`. It persists the FULL `content`, chooses a private (not world-readable) location and a collision-free name derived from — never equal to — `suggestedName`, and REJECTS on a real storage failure (permissions, ENOSPC, backend unavailable). The seam owns storage only: no retention policy, no tool-result replacement, no file inspection.

The local backend ([dsh-spill-local](../../packages/spill/spill-local)) writes under `<root>/session-<hash>/<random>-<safeName>` — a configured or lazily-created private (0700) root, a `sha256(sessionId)` session subdir, and an exclusive owner-only (`open(path, 'wx', 0o600)`) write so a planted symlink cannot redirect it. The policy consumer ([dsh-spill-policy](../../packages/spill/spill-policy)) replaces an over-`maxInlineBytes` plain-text final result with a retention-library head/tail preview plus the spill path, best-effort: a save failure keeps the original inline result rather than turning a successful call into an `isError`.
