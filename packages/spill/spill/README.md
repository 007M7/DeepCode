# @deepseek-ai/dsh-spill

The **spill storage seam**: an abstract `SpillFiles` service (`ctx.spillFiles`) defining WHAT a spill backend does — persist a tool's oversized text to a session-scoped path the model can later `read` — without saying HOW.

This package is one third of the spill capability, split so each concern evolves (and swaps) independently:

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-spill` (this) | the interface: abstract service + vocabulary types |
| `@deepseek-ai/dsh-spill-local` | an implementation: private session-scoped files on the host filesystem |
| `@deepseek-ai/dsh-spill-policy` | the tool-result policy that spills oversized final results |

The split mirrors the bash/fs seams. A future remote or virtual backend (e.g. a `spill://…` URI plus a read-only bridge for ACP or remote environments) implements this interface without touching the policy plugin.

## Service API (`ctx.spillFiles`)

| Member | Semantics |
|---|---|
| `saveText(input)` | Persist `input.content` verbatim to a session-scoped file; resolves with a `SpillRef` (path readable by the local `read` tool + exact bytes written). **Rejects on a real storage failure** (permissions, ENOSPC, backend unavailable) — the caller decides how to degrade. |

Storage is scoped by the request's `owner` session; the backend chooses a private (not world-readable) location and a collision-free name derived from — never equal to — the caller's `suggestedName`. The seam owns storage only: NO retention policy (that is [`@deepseek-ai/dsh-retention`](../../util/retention)), NO tool-result replacement (that is `@deepseek-ai/dsh-spill-policy`), NO file inspection (the model uses the existing `read` tool on the returned path).

## Vocabulary

`SaveTextSpill` (owner, source, suggestedName, content) is the request; `SpillRef` (path, bytes) is the result. `SpillPath` is [branded](../../util/brand) and rendered to the model as an ordinary path string in v1 — the brand records provenance (a runtime artifact, not a workspace file) so a future virtual backend can swap the path shape without a consumer change. `SpillOwner` scopes storage to a `SessionId`; unlike the bash executor's decoupled `OwnerToken`, spill is inherently session-scoped, so the seam imports `dsh-session`'s `SessionId` directly. `SpillSource` (toolName, callId, label) is descriptive provenance for the filename and future cleanup, not access control. See `src/types.ts` for the full contracts.

See the [tool output spill RFC](../../../docs/rfc/implemented/architecture/2026-07-08-tool-output-spill-files.md) for the design rationale, including why creation belongs to the runtime spill seam rather than the model-facing `write` tool.
