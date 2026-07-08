# Skills

The skill stack is split across three core packages: the registry ([dsh-skill](../../packages/core/skill), `ctx.skills`) merges provider catalogs and renders request-time guidance; the local provider ([dsh-skill-local](../../packages/core/skill-local)) scans project/custom/user directories; the consumer ([dsh-tool-skill](../../packages/core/tool-skill), model-facing `skill`) loads one complete body for progressive disclosure. Skills are optional instructions, not session events, so their vocabulary lives here rather than in [core.md](core.md).

Source: [`packages/core/skill/src/index.ts`](../../packages/core/skill/src/index.ts), [`packages/core/skill-local/src/index.ts`](../../packages/core/skill-local/src/index.ts), and [`packages/core/tool-skill/src/index.ts`](../../packages/core/tool-skill/src/index.ts).

## Provider registry

`ctx.skills` is a multi-provider registry. Providers can represent local directories, embedded plugin data, HTTP catalogs, or another source. The registry validates candidates, resolves duplicate skill names first-wins by rank/provider order/local order, and sorts the final model-visible catalog by `name` for deterministic prompt text. A provider `list()` rejection is logged and skipped without caching the degraded catalog; malformed candidates still fail fast because they violate the provider contract.

```ts type-equiv
interface SkillProvider {
  name: string
  list(options: SkillLookupOptions): Promise<SkillCandidate[]>
  get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined>
}
```

## Local discovery priority

The shipped local provider scans roots in rank order:

| Rank | Source | Root |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills` |
| 500 | `user-agents` | `<agentsHome>/skills` |

The project root is the nearest ancestor containing `.git`; without one, the current cwd is used. When `ctx.fs` is available, the git-root walk probes `.git` through the filesystem service so remote or sandboxed workspaces do not fall back to the host filesystem boundary. The user DSH root skips its `.system` child, and DeepSeek Harness no longer ships built-in system skills from the local provider. Additional built-ins can be supplied later by another provider.

## Skill identity

Skill names are kebab-case (`^[a-z0-9]+(?:-[a-z0-9]+)*$`). The local provider accepts directory bundles (`<name>/SKILL.md`) and flat Markdown files (`<name>.md`). Nested recursive `**/SKILL.md` discovery is intentionally outside v1.

```ts type-equiv
type SkillSource = 'project-dsh' | 'project-agents' | 'runtime' | 'user-dsh' | 'user-agents' | 'custom' | (string & {})
```

## Summaries, candidates, and complete definitions

`SkillSummary` is the model-visible shape: the request prompt gets name, source, provider, description, and optional routing hint, but never the body or absolute file path. `disableModelInvocation` hides a skill from listings while allowing trusted code to load it by name.

```ts type-equiv
interface SkillSummary {
  name: string
  description: string
  whenToUse?: string
  disableModelInvocation?: boolean
  source: SkillSource
  provider: string
  resourceBase?: SkillResourceBase
}
```

`SkillCandidate` is the provider-to-registry shape. `locator` is opaque provider state; the registry only stores it and gives it back to the winning provider's `get()`.

```ts type-equiv
interface SkillCandidate extends SkillSummary {
  rank: number
  locator: unknown
  path?: string
  metadata?: Record<string, unknown>
}
```

`SkillDefinition` is the complete parsed result returned by `ctx.skills.get()` and used by the `skill` tool. `resourceBase` tells the tool how to render relative-resource guidance for local, URL, or provider-managed skills.

```ts type-equiv
type SkillResourceBase =
  | { kind: 'directory'; path: string }
  | { kind: 'url'; url: string }
  | { kind: 'opaque'; description: string }
```

```ts type-equiv
interface SkillDefinition extends SkillSummary {
  content: string
  path?: string
  metadata?: Record<string, unknown>
}
```

Runtime skills use the same complete shape and participate in the same first-wins collection order. The returned disposer removes the contribution and invalidates discovery caches.

```ts type-equiv
type SkillRegistration = Omit<SkillDefinition, 'provider'> & {
  provider?: string
}
```

## Lookup and configuration

Skill lookup is cwd-sensitive because providers may expose workspace-local skills. If no git root is found, the local provider treats the supplied cwd itself as the project root.

```ts type-equiv
interface SkillLookupOptions {
  cwd?: string | undefined
}
```

The registry owns prompt/cache bounds. The local provider owns filesystem roots (`dshHome`, `agentsHome`, and `customSkillDirs`).

```ts type-equiv
interface Config {
  promptFieldMaxLength?: number
  collectCacheMaxEntries?: number
}
```

## Prompt and tool contract

`ctx.skills.renderModelListing()` returns a `## Skills` fragment wrapped in `<available_skills>`. Descriptions and `whenToUse` are whitespace-normalized, length-capped, XML-escaped, and have `{{` / `}}` split before rendering so skill metadata cannot be parsed as prompt-template variables. The listing is appended as a late `system-prompt/assemble` section for the calling agent, so it remains cwd-sensitive while still flowing through the reconstructable system-prompt path.

The model-facing `skill({ name })` tool validates the kebab-case name, loads the complete definition for the calling agent cwd, rejects unknown or `disableModelInvocation` skills, and returns a `<skill_content name="...">` block with the body plus provider resource guidance. The tool result is the only v1 path that exposes full skill instructions to the model.
