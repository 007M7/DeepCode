# Skills

The [skill capability family](../../packages/skill) is split across three packages: the registry ([dsh-skill](../../packages/skill/skill), `ctx.skills`) merges provider catalogs; the local provider ([dsh-skill-local](../../packages/skill/skill-local)) scans project/custom/user directories; the consumer ([dsh-tool-skill](../../packages/skill/tool-skill)) owns the session-prefix catalog and model-facing `skill` tool. Skills are optional instructions, not session events, so their vocabulary lives here rather than in [core.md](core.md).

Source: [`packages/skill/skill/src/index.ts`](../../packages/skill/skill/src/index.ts), [`packages/skill/skill-local/src/index.ts`](../../packages/skill/skill-local/src/index.ts), and [`packages/skill/tool-skill/src/index.ts`](../../packages/skill/tool-skill/src/index.ts).

## Provider registry

`ctx.skills` is a multi-provider registry. Providers can represent local directories, embedded plugin data, HTTP catalogs, or another source. Provider plugins register synchronously during `apply()`; remote initialization, authentication, and discovery are awaited by `list()`. The registry validates candidates, resolves duplicate skill names first-wins by rank/provider order/local order, and sorts the final summaries by `name` for deterministic consumers. A provider `list()` rejection is logged and skipped without caching the degraded catalog; malformed candidates still fail fast because they violate the provider contract.

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

`SkillSummary` is the registry's model-invocable summary shape. Consumers choose which fields to render; the session catalog uses only `name` and `description`, never the body or absolute file path. `disableModelInvocation` hides a skill from model listings while allowing trusted code to load it by name.

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

Skill lookup is cwd-sensitive because providers may expose workspace-local skills, and its optional signal cancels provider work for the caller. If no git root is found, the local provider treats the supplied cwd itself as the project root.

```ts type-equiv
interface SkillLookupOptions {
  cwd?: string | undefined
  signal?: AbortSignal | undefined
}
```

The registry owns only its discovery-cache bound. The local provider owns filesystem roots (`dshHome`, `agentsHome`, and `customSkillDirs`). The consumer owns its catalog description bound.

```ts type-equiv
interface Config {
  collectCacheMaxEntries?: number
}
```

## Session catalog and tool contract

`dsh-tool-skill` contributes a user-role `<system-reminder>` through `agent/session-prefix`. The catalog contains sorted skill `name` and normalized, XML-escaped `description` only; it omits bodies, paths, sources, providers, and routing hints. Prefix discovery forwards the caller's abort signal through `SkillLookupOptions`. `catalogDescriptionMaxLength` is the consumer config for the description bound, with default `500` and integer minimum `3`. Its request-only, header-logged lifecycle is defined by the [session-prefix RFC](../rfc/implemented/feature/2026-07-07-session-prefix.md).

The model-facing `skill({ name })` tool validates the kebab-case name, loads the complete definition for the calling agent cwd, reports an unresolved skill as unknown or no longer available, rejects `disableModelInvocation` skills, and returns a tool result containing `<skill_content name="...">`, `<skill_resources>`, and `<skill_instructions>`. `resourceBase` resolves explicitly referenced scripts, references, and assets only as needed; the loaded result does not enumerate a skill directory. The tool result is the model-visible path for complete instructions.
