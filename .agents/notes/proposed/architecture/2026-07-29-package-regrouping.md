# Agent Note: Regroup packages/ by measured clustering

Status: proposed

English | [中文](2026-07-29-package-regrouping.zh.md)

## Problem

The two-level `packages/<group>/<pkg>` hierarchy ([original decision](../../archived/architecture/2026-06-20-package-hierarchy.md)) has drifted since June: 167 packages now sit in 40 groups, and several group boundaries no longer match how the packages actually cluster.

- `ui/` mixes four unrelated planes: the human terminal channel (`tui`), the SDK's JSON-RPC server half (`jsonrpc`, whose peer dependency on `dsh-sdk-protocol` binds it to the `sdk/` stack), the human-interaction seams (`user-interaction`, `user-approval`, `permission`, `tool-ask-user`, `commands`), and channel-neutral boot glue (`app-boot`). Its own README narrates the mixture instead of stating a role.
- The session family is fragmented across five groups — `session-persistence/`, `session-projection/`, `session-query/`, `session-title/`, and `telemetry/` — although the measured dependency edges tie them together (query → persistence, title → projection, projection → persistence; see [docs/module-graph.md](../../../../docs/module-graph.md)).
- Two group names collide with unrelated packages: `telemetry/` (session reporting) vs `sdk/telemetry` = `dsh-telemetry` (launcher-side SDK telemetry), and `timeout/` (a tool-call guard) vs `util/timeout` (the generic promise utility).
- `cordis/` names its group after the framework every package is built on, so the name discriminates nothing; its single package `tool-cordis` is the runtime self-modification toolset.
- `sdk/` folder names are inconsistent: `sdk/sdk-client` and `sdk/sdk-protocol` repeat the group name while `sdk/telemetry`, `sdk/helper`, and `sdk/scripts` do not.

The north star for the regrouping: **closely clustered packages share a group.** A cluster is measured — peer-dependency edges and co-change — not thematic. An isolated seam family may stand alone as a small group; the failure mode to avoid is the grab-bag whose name describes no single role.

## Proposal

Recompose six groups; every other group keeps today's boundary and contents (the dependency analysis confirmed the capability families — `bash/`, `pty/`, `code-runtime/`, `sandbox/`, `subprocess/`, `fs/`, `lsp/`, `web/`, `skill/`, and the rest — were already drawn correctly). npm package names do not change in this reorganization; the folder tree carries the whole change.

| Group | Members (folder names) | From |
|---|---|---|
| `session/` | session-persistence, session-persistence-jsonl, session-persistence-sqlite, session-checkpoint-policy, session-projection, session-projection-cache, session-title, session-title-llm, session-title-first-message-llm, session-title-all-messages-llm, session-telemetry, session-telemetry-otel | `session-persistence/` + `session-projection/` + `session-title/` + `telemetry/` |
| `interaction/` | user-interaction, user-approval, permission, tool-ask-user, commands, tui | `ui/` |
| `boot/` | app-boot | `ui/` |
| `scaffold/` | helper, scripts, create-sdk, protocol, client, server, telemetry | `sdk/` + `ui/jsonrpc` |
| `guard/` | repeat-tool-guard, timeout-policy | `guard/` + `timeout/` |
| `self-modification/` | tool-cordis | `cordis/` |

- **`session/`** is the durable session data plane: the persistence seam with its backends and checkpoint policy, the projection fold that serves whole values from that log, log-backed titles, and OTel reporting. The title fold is itself load-bearing for the read side (`session-query` peer-depends on `dsh-session-title`), so titles belong with the data plane, not in a derived-services annex. The plain name is deliberate (review: prefer names a human would say); the nearby `core/session` package remains the live in-memory service, while this group is the durable family around it. `session-query/` stays a standalone group — the read/tool surface has its own model tools and SQLite FTS backend and is consumed independently of persistence internals. Absorbing `telemetry/` ends the group-name collision with `dsh-telemetry`.
- **`interaction/`** is the human-collaboration plane plus the terminal channel that answers it: the question/approval seams, the permission preset, the model-facing `ask_user_question` tool, the human-command registry (`plan-mode` and `command-goal` already consume `commands` together with the interaction seams), and `tui` — the interactive channel is the plane's richest provider and consumer (peer edges to `commands` and `user-interaction`), and a one-package `tui/` group would spend a top-level name on one plugin.
- **`boot/`** is a role-complete single-package group: the shared bin boot glue that belongs to no channel and no assembly (consumed by `apps/cli`, the `scaffold/` launcher, and the `examples/` demo bins).
- **`scaffold/`** is the developer-tooling family: project helper, launcher, initializer, wire protocol with both ends (`server` is today's `ui/jsonrpc`), and launcher telemetry. Renamed from `sdk/` in review: the whole `packages/` tree *is* the SDK, so a group named `sdk/` inside it says nothing; `scaffold/` names the create/launch/drive-a-project role. Folders drop the legacy `sdk-` prefix (`protocol`, `client`, `server`), matching the `client/`/`host/` role-named folder style.
- **`guard/`** keeps its documented role, loop-hygiene guards, and gains the tool-call timeout enforcer, dissolving the one-package `timeout/` group whose name collided with `util/timeout`.
- **`self-modification/`** names the role `cordis/` obscured: the toolset with which the agent inspects and mounts plugins in its own live runtime, and the landing zone for future self-modification packages.

40 groups become 37; the win is clustering correctness and truthful names, not count.

## Deferred renames (FIXME markers)

Five npm names should eventually change, but renaming inside the reorganization would turn a pure-move PR into an import-churn PR. Instead, the implementation adds a `FIXME` to each affected package's module JSDoc naming the intended new name. `FIXME` blocks a tagged release ([marker semantics](../../../../docs/development.md)), which is the wanted forcing function: these renames are only free while nothing external consumes the packages.

| Current npm name | Intended name | Why |
|---|---|---|
| `@deepseek-ai/dsh-jsonrpc` | `@deepseek-ai/dsh-sdk-server` | Names the wire encoding, not the role; it is the server half of the SDK protocol |
| `@deepseek-ai/dsh-telemetry` | `@deepseek-ai/dsh-sdk-telemetry` | Collides with the `dsh-session-telemetry` family; it is launcher-side SDK telemetry |
| `@deepseek-ai/dsh-helper` | `@deepseek-ai/dsh-sdk-helper` | Indefensibly generic as a published name |
| `@deepseek-ai/dsh-scripts` | `@deepseek-ai/dsh-sdk-scripts` | Same |
| `@deepseek-ai/dsh-timeout-policy` | `@deepseek-ai/dsh-timeout-guard` | Suggestion, not settled: aligns the name with its `guard/` home; decide at resolution time |

The first four are settled intent; resolving them converges the SDK wire stack's npm names on `dsh-sdk-*` (the npm prefix names the product stack; the `scaffold/` folder names the role). `@deepseek-ai/create-sdk` keeps its documented npm-initializer exception.

## Implementation

One mechanical PR, landed in a quiet window: a single conflict event for the many open PRs, an atomic documentation update, and pure-move reviewability (`git mv` + path fixes, rename detection intact). If review prefers, the same content splits into a three-PR stack (the session fold; `ui/` dissolution + `scaffold/`; `self-modification/` + `guard/` merge), at the cost of three rebase events for everyone else.

A group move touches: the moved package's `tsconfig.json` relative `references` and every dependent's entry (including the `apps/cli` project references), the tsconfig aggregate and path maps, group READMEs (five new bilingual triplets, deletions for dissolved groups, the [packages/README.md](../../../../packages/README.md) hierarchy table, the root `AGENTS.md` layout map), regenerated artifacts (`docs/module-graph.md`, path-embedding catalogs, the lockfile's importer keys), and root-relative `packages/...` citations in prose (root and `apps/cli` READMEs, 7 script files + 22 docs files measured today; `verify-package-paths` gates the Markdown/TypeScript classes of stragglers). This list conveys the shape of the change, not a file inventory: every remaining group-path referent (workspace configs, test globs, lint keys) is found mechanically at implementation time by the acceptance gates failing loud, which is the repository's own misconfiguration rule.

A group move does not touch: npm names, imports, `cordis.yml` configs, snapshot fixtures, the `pnpm-workspace.yaml`/`tsdown` globs (both `packages/*/*`), or the Python runtime manifest — all reference packages by npm name (verified by grep before this proposal). Each FIXME lands in the same PR as the move that creates its context.

`client/` and `host/` are out of scope and unchanged. The in-flight `experimental/` group proposal (PR #844) is orthogonal — a release-boundary container, not a clustering decision; the only interaction is a trivial merge in the packages/README.md table.

## Alternatives considered

**Coarse domain buckets** (`exec/` = subprocess+sandbox+bash+pty+code-runtime, `workspace/` = fs+lsp+workspace, `orchestration/` = subagent+workflow+tasks, `knowledge/` = web+skill, `collab/` = plan+todo+goal; ~16 groups). Rejected: the measured graph contradicts the merges. `sandbox` and `subprocess` are shared infrastructure consumed across families (bash ×5, fs ×5, pty, lsp, mcp, subagent, sdk edges), `web` ↔ `skill` have zero edges, and a large bucket reproduces the `ui/` grab-bag at a larger scale.

**Abstract layer names** (`capability/`, `policy/`, `extension/`, `provider/`). Rejected: they describe every plugin equally badly, and a `capability/` bucket would hold ~50 packages.

**A full npm rename sweep** (`dsh-<group>-<pkg>` for every package). Rejected: npm names are flat, so group-prefixing adds churn across imports, configs, and fixtures with no disambiguation gain; targeted FIXME-tracked renames cover the actual collisions.

**Performing the five renames inside the reorganization.** Rejected in review: renames multiply open-PR conflicts and destroy the pure-move review property. The FIXME markers keep them visible release blockers to resolve as small follow-up PRs.

**A two-way session split** (`session-core/` + `session-utils/`). Rejected: query belongs to neither side cleanly, and `session-core` invites confusion with `core/session` (`dsh-session`, the live in-memory service, which stays in `core/`).

**A three-way session split** (`session-store/` + `session-query/` + `session-utils/`), this RFC's first draft. Rejected in review: `session-utils/` was a negatively-defined annex ("derived, nothing load-bearing depends on it") — the grab-bag shape the north star forbids, and factually wrong besides (`session-query` peer-depends on `dsh-session-title`). The invented compound names also read machine-generated; one plain `session/` group says what a human would say. Query stays standalone in both drafts: it is an independently consumed read surface with its own tool package and backend.

**Recomposing `ui/` as a single `channels/` group** (tui + jsonrpc + acp + interaction seams + boot). Rejected: the same grab-bag under a new name — those packages serve four planes, `jsonrpc`'s measured cluster is the SDK wire stack, and `acp/` is an automation transport, not a human channel.

**A standalone one-package `tui/` group**, this RFC's first draft. Rejected in review: `tui` is the interaction plane's primary provider/consumer (peer edges to `commands`, `user-interaction`), and a top-level name spent on one plugin adds a group without adding information; it folds into `interaction/`.

**Keeping the group name `sdk/`.** Rejected in review: the whole `packages/` tree is the SDK, so an `sdk/` group inside it discriminates nothing — the same disease as `cordis/`. `scaffold/` names the actual role (create, launch, and drive projects from outside).

**Moving `app-boot` to `apps/`** (review question). Rejected: `apps/` is the assembly tier over the package tier, and `dsh-app-boot` is a library that package-tier code imports (`scaffold/scripts`' launcher peer-depends on it) — placing it in `apps/` would invert the tiers and put a workspace library outside the `packages/*/*` build globs. It stays a package; `boot/` is its role-complete home.

**Moving `tool-cordis` into `core/`.** Rejected: self-modification is its own product seam, expected to grow; the spine stays minimal. The group was first named `self-evolve/`; review settled on `self-modification/` as the plainer term.

**Renaming `context/` to `request-context/`.** Rejected: within this tree the group is unambiguous in situ; the churn is unjustified.

## Acceptance criteria

- The tree matches the map: the six recomposed groups hold exactly the listed members; the groups `ui/`, `sdk/`, `telemetry/`, `timeout/`, `cordis/`, `session-persistence/`, `session-projection/`, and `session-title/` no longer exist; every other group's contents are unchanged.
- Zero npm renames: the workspace package-name set is identical before and after.
- The five FIXME markers are present, each naming its intended new name.
- New and updated group READMEs form complete bilingual triplets; the packages/README.md hierarchy table matches the tree; docs/module-graph.md is regenerated.
- `pnpm run typecheck`, `pnpm run test`, `pnpm run doc-sync`, and `pnpm run hygiene` pass, and the unit/snapshot suites collect the same test files before and after the move (group-scoped globs in test configs must not silently match nothing).

## Risks

- **Open-PR conflicts.** Every open PR touching a moved file must rebase across the move. Mitigated by landing as one PR in a quiet window, publishing the mapping table in the PR body, and the moves being pure renames (rename detection resolves most hunks mechanically).
- **Reference drift.** Docs or scripts citing old paths can go stale; `verify-package-paths` exists precisely for moved-package drift and runs in `doc-sync`.
- **Translation load.** Five new group README triplets plus edits to existing pairs land in the implementation PR.
- **Deferred renames are release blockers by design.** A FIXME that later proves wrong must be removed explicitly with rationale, never silently dropped.
- **Single-package groups remain** (`boot/`, `self-modification/`, and existing ones such as `acp/`). Accepted deliberately: each is role-complete rather than a fragment of a family, and a truthful small group beats a nominal merge.
- **What this gives up:** nothing functional — the change is navigational. Muscle memory and external links to old GitHub paths break, which is acceptable pre-release with no external consumers.
