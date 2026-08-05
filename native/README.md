# native/

English | [中文](README.zh.md)

Source of record for `node-addon-landlock-run`, the Landlock self-restrict-then-exec launcher consumed by the harness. The [`landlock-run/` workspace](landlock-run/README.md) owns its architecture, package family, platform support, development workflow, and release procedure. The standalone repository is a release mirror.

## Release mirror

| Directory | Mirror repo | Last exported release | Commit |
|---|---|---|---|
| `landlock-run/` | https://github.com/deepseek-harness/node-addon-landlock-run | `v0.0.1` | `614f7fd7dc11e6eaceefba9e7ff1fbe28b51ba22` |

The subtree is a self-contained pnpm workspace and is not part of the harness workspace. The [launcher release reference](landlock-run/docs/release.md) owns the export and publication workflow. The mirror must not diverge: port any direct mirror hotfix back here before the next export.
