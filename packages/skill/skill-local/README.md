# @deepseek-ai/dsh-skill-local

Local filesystem provider for the `ctx.skills` registry.

This package implements one skill source. It scans local project, custom, and user skill roots, parses `SKILL.md` or flat Markdown skill files, and registers the provider on `ctx.skills`. The registry remains in `@deepseek-ai/dsh-skill`; the session-prefix catalog and model-facing loader tool remain in `@deepseek-ai/dsh-tool-skill`.

## Plugin

Requires `ctx.skills` (`inject: ['skills']`).

### Config

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME` or `~/.dsh` | DeepSeek Harness config root; scans `skills` under this directory. |
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

The project root is the nearest ancestor containing `.git`; without one, the current cwd is used. The user DSH root skips its `.system` child so system-owned directories are not accidentally treated as normal user skills. DeepSeek Harness no longer ships built-in system skills from this provider; additional built-ins can be supplied later by another provider.

When `ctx.fs` is available, discovery lists roots through `ctx.fs.listDir`, reads skill files through `ctx.fs.readText`, and probes `.git` through the filesystem service. Full skill loads forward the lookup abort signal to filesystem metadata and content reads. Without a filesystem service, the provider falls back to abortable Node filesystem I/O so minimal local contexts can still load skills. Missing, unreadable, or malformed skill files warn and skip instead of failing the whole request.

## Skill Format

Skills can be single-level directory bundles (`<name>/SKILL.md`) or flat Markdown files (`<name>.md`). Nested `**/SKILL.md` discovery is intentionally not part of v1. Frontmatter is parsed as YAML with the `yaml` package; it requires `name` and `description`, while `whenToUse`, `disableModelInvocation`, and `metadata` are optional. Names must be kebab-case.
