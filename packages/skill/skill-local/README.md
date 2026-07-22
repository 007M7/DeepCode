# @deepseek-ai/dsh-skill-local

Local filesystem provider for the `ctx.skills` registry.

This package implements one skill source. It scans local project, custom, and user skill roots, parses `SKILL.md` or flat Markdown skill files, and registers the provider on `ctx.skills`. The registry remains in `@deepseek-ai/dsh-skill`; the session-prefix catalog and model-facing loader tool remain in `@deepseek-ai/dsh-tool-skill`.

## Plugin

Requires `ctx.skills` (`inject: ['skills']`).

### Config

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME` or `~/.dsh` | DeepSeek Harness config root resolved by [`@deepseek-ai/dsh-paths`](../../util/paths/README.md); scans `skills` under this directory. |
| `agentsHome` | `$DSH_AGENTS_HOME` or `~/.agents` | Shared agent config root scanned for compatible skills. |
| `customSkillDirs` | `[]` | Additional local skill roots scanned after project roots and before user roots. |

## Discovery

Default roots are resolved in this provider's rank order:

| Rank | Source | Path |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills` |
| 500 | `user-agents` | `<agentsHome>/skills` |

The project root is the nearest ancestor containing `.git`; without one, the current cwd is used. The user DSH root skips its `.system` child so system-owned directories are not treated as normal user skills. This provider supplies project and user skills; another provider may supply built-in system skills.

When `ctx.fs` is available, discovery lists roots through `ctx.fs.listDir`, reads skill files through `ctx.fs.readText`, and probes `.git` through the filesystem service. Full skill loads forward the lookup abort signal to filesystem metadata and content reads. Without a filesystem service, the provider falls back to abortable Node filesystem I/O so minimal local contexts can still load skills. Missing, unreadable, or malformed skill files warn and skip instead of failing the whole request.

## Skill Format

Skills can be single-level directory bundles (`<name>/SKILL.md`) or flat Markdown files (`<name>.md`). Nested `**/SKILL.md` discovery is intentionally not part of v1. Frontmatter is parsed as YAML with the `yaml` package; it requires `name` and `description`, while `whenToUse`, `disableModelInvocation`, and `metadata` are optional. Names must be kebab-case.

## Model Experience

Indirectly, through `dsh-tool-skill`, which renders this provider's invocable names and capped descriptions into the session-prefix catalog and a selected instruction body plus resource-base guidance into retained tool history while paths, provider ranks, and disabled skills remain hidden.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Discovery is one level deep** — only `<root>/<name>/SKILL.md` and `<root>/<name>.md` are recognized; nested skill trees and package manifests are ignored.
- **Project scope is the nearest `.git` ancestor** — workspaces without that marker fall back to the supplied cwd, with no alternate project-root marker or monorepo subproject selection.
- **Unreadable or malformed entries disappear with a warning** — the model catalog receives no per-skill diagnostic and cannot distinguish an absent skill from a skipped one.
- **No filesystem watching** — edits rely on the registry cache being evicted or invalidated by provider reload before a previously collected cwd is rediscovered.
