# @deepseek-ai/dsh-skill

Agent skill discovery and model-facing skill guidance.

## Service: `SkillService` (ctx key: `skills`)

### Public API

- `ctx.skills.list({ cwd? })` Returns model-invocable skill summaries for the current workspace.
- `ctx.skills.get(name, { cwd? })` Returns the full skill, including disabled-for-model skills.
- `ctx.skills.register(skill): () => void` Registers a runtime skill, disposed with the calling fiber.

### Config

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME` or `~/.dsh` | DeepSeek Harness config root; system skills live under `skills/.system`. |
| `agentsHome` | `$DSH_AGENTS_HOME` or `~/.agents` | Shared agent config root scanned for compatible skills. |
| `extraRoots` | `[]` | Additional skill roots scanned after user roots and before system skills. |
| `installSystemSkills` | `true` | Whether startup materializes bundled system skills under `dshHome`. |
| `promptFieldMaxLength` | `500` | Maximum rendered `description` / `whenToUse` length in the prompt listing. |
| `collectCacheMaxEntries` | `128` | Maximum cwd/root discovery promises kept in memory. |

### Discovery

Default roots are resolved in this conflict priority order:

| Source | Path |
|---|---|
| Project DSH | `<projectRoot>/.dsh/skills` |
| Project agents | `<projectRoot>/.agents/skills` |
| Runtime | `ctx.skills.register(...)` |
| User DSH | `~/.dsh/skills` |
| User agents | `~/.agents/skills` |
| Extra | `Config.extraRoots` |
| System | `~/.dsh/skills/.system` |

The project root is the nearest ancestor containing `.git`; without one, the current cwd is used. The user DSH root skips `.system` during normal user scanning so system skills are read exactly once. Same-name skills keep the highest-priority copy, then model-visible summaries are sorted by skill name for stable prompts and provider prefix-cache friendliness.

Discovery is memoized per resolved root set and runtime-skill revision. Runtime `register()` and disposer calls invalidate the cache; disk-only changes are picked up on the next invalidation or process restart.

## Skill Format

Skills can be single-level directory bundles (`<name>/SKILL.md`) or flat Markdown files (`<name>.md`). Nested `**/SKILL.md` discovery is intentionally not part of v1. Frontmatter requires `name` and `description`; `whenToUse`, `disableModelInvocation`, and `metadata` are optional. Names must be kebab-case.

## Prompt Integration

The service listens on `agent/request` and appends a short `## Skills` listing to the request system prompt for the calling agent's cwd. The listing contains only stable routing metadata (`name`, `source`, `description`, and optional `whenToUse`), not skill bodies or local absolute paths. `description` and `whenToUse` are whitespace-normalized and capped in the listing so one pathological skill cannot bloat every model request. Models load full instructions through the `skill` tool.

## System Skills

On startup, the service ensures bundled system skills exist under `~/.dsh/skills/.system` unless `installSystemSkills: false` is configured. Project, runtime, user, and extra-root skills can override system skills by name.
