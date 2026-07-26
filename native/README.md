# native/

English | [中文](README.zh.md)

Source of record for `node-addon-landlock-run`, the Landlock self-restrict-then-exec launcher the harness consumes from npm (`packages/sandbox/sandbox-local`, `packages/bash/bash-sandbox`). Launcher development happens HERE, next to the consumers; the standalone repository is the release mirror that packs and publishes the npm package family.

## Release mirror

| Directory | Mirror repo | Last exported release | Commit |
|---|---|---|---|
| `landlock-run/` | https://github.com/deepseek-harness/node-addon-landlock-run | `v0.0.1` | `614f7fd7dc11e6eaceefba9e7ff1fbe28b51ba22` |

The subtree is a self-contained pnpm workspace with its own `AGENTS.md`, docs, gates, and lockfile; it is NOT part of the harness workspace (`pnpm-workspace.yaml` does not include it), so harness installs, builds, and CI gates never touch it. The mirror's `.github/` stays out of the subtree — [.github/workflows/landlock-run.yml](../.github/workflows/landlock-run.yml) (manual dispatch) runs the subtree's CI legs here, and a change to those legs is mirrored into the mirror's `ci.yml` at the next export.

## Export procedure (cutting a release)

1. Land the launcher change here through a normal harness PR; dispatch the `Landlock Run` workflow and get its legs green.
2. In the mirror checkout, replace everything except `.github/`: `git -C <mirror> rm -rq -- . ':!.github'`, then `git -C <harness> archive HEAD:native/landlock-run | tar -x -C <mirror>`, then `git -C <mirror> add -A` and commit.
3. In the mirror, follow its release checklist (`docs/release.md`): `pnpm release:commit <version>` → merge → tag `vX.Y.Z` → two-phase `Release` workflow (`publish=false` rehearsal, then `publish=true` from the tag).
4. Update the manifest table above with the released tag/commit, and bump the harness consumers' dependency range in the same change.

The mirror must not diverge: a change committed there directly (hotfix during a release) is ported back here before the next export.
