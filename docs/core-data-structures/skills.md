# Skills

The skill stack is split across two core packages: the service ([dsh-skill](../../packages/core/skill), `ctx.skills`) discovers and parses local `SKILL.md` instructions, injects a stable request-time listing, and exposes full skill bodies on demand; the consumer ([dsh-tool-skill](../../packages/core/tool-skill), model-facing `skill`) loads one complete body for progressive disclosure. Skills are optional instructions, not session events, so their vocabulary lives here rather than in [core.md](core.md).

Source: [`packages/core/skill/src/index.ts`](../../packages/core/skill/src/index.ts) and [`packages/core/tool-skill/src/index.ts`](../../packages/core/tool-skill/src/index.ts).

## Discovery priority

For a request with a cwd, `ctx.skills` finds the nearest git root and scans roots in first-wins order:

| Priority | Source | Root |
|---|---|---|
| 1 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 2 | `project-agents` | `<projectRoot>/.agents/skills` |
| 3 | `runtime` | `ctx.skills.register(...)` |
| 4 | `user-dsh` | `~/.dsh/skills` |
| 5 | `user-agents` | `~/.agents/skills` |
| 6 | `extra` | `Config.extraRoots` |
| 7 | `system` | `~/.dsh/skills/.system` |

The user DSH root skips its `.system` child during normal scanning so built-in skills are discovered exactly once. Same-name skills keep the highest-priority copy and log a warning for later duplicates. After this priority pass, model-visible summaries are sorted by `name` before prompt rendering so the `## Skills` fragment is deterministic and friendly to provider prefix caches.

## Skill identity

Skill names are kebab-case (`^[a-z0-9]+(?:-[a-z0-9]+)*$`). A skill can be a directory bundle (`<name>/SKILL.md`) or a flat Markdown file (`<name>.md`). Nested recursive `**/SKILL.md` discovery is intentionally outside v1.

```ts type-equiv
type SkillSource = 'project-dsh' | 'project-agents' | 'runtime' | 'user-dsh' | 'user-agents' | 'extra' | 'system'
```

## Summaries and complete definitions

`SkillSummary` is the model-visible shape: the request prompt gets the name, source, description, and optional routing hint, but never the body or absolute file path. `disableModelInvocation` hides a skill from listings while allowing trusted code to load it by name.

```ts type-equiv
interface SkillSummary {
  name: string
  description: string
  whenToUse?: string
  disableModelInvocation?: boolean
  directory: string
  source: SkillSource
}
```

`SkillDefinition` is the complete parsed result returned by `ctx.skills.get()` and used by the `skill` tool. `directory` is the base directory for resolving relative references in the skill body; `path` is present for disk skills; `metadata` preserves optional frontmatter for future consumers without changing v1 routing behavior.

```ts type-equiv
interface SkillDefinition extends SkillSummary {
  content: string
  path?: string
  metadata?: Record<string, unknown>
}
```

Runtime skills use the same complete shape and participate in the same first-wins collection order. The returned disposer removes the contribution and invalidates discovery caches.

```ts type-equiv
type SkillRegistration = Omit<SkillDefinition, 'disableModelInvocation'> & {
  disableModelInvocation?: boolean
}
```

## Lookup and configuration

Skill lookup is cwd-sensitive because project skill roots are relative to the current workspace. If no git root is found, the supplied cwd itself is the project root.

```ts type-equiv
interface SkillLookupOptions {
  cwd?: string | undefined
}
```

The service can be pointed at alternate user roots in tests or deployments. `installSystemSkills` controls whether bundled system skills are materialized under `<dshHome>/skills/.system` on startup. `promptFieldMaxLength` must be at least `3`, matching the `...` truncation suffix reserved in rendered prompt fields.

```ts type-equiv
interface Config {
  dshHome?: string
  agentsHome?: string
  extraRoots?: string[]
  installSystemSkills?: boolean
  promptFieldMaxLength?: number
  collectCacheMaxEntries?: number
}
```

## Prompt and tool contract

`ctx.skills.renderModelListing()` returns a `## Skills` fragment wrapped in `<available_skills>`. Descriptions and `whenToUse` are whitespace-normalized, length-capped, and XML-escaped before rendering. The listing is appended to the same `GenerateOptions.system` string by the `agent/request` waterfall, after the base system prompt is assembled.

The model-facing `skill({ name })` tool validates the kebab-case name, loads the complete definition for the calling agent cwd, rejects unknown or `disableModelInvocation` skills, and returns a `<skill_content name="...">` block with the body plus base-directory and relative-path guidance. The tool result is the only v1 path that exposes full skill instructions to the model.
