# Skills

The [skill capability family](../../packages/skill) is split across three packages: the registry ([dsh-skill](../../packages/skill/skill), `ctx.skills`) merges provider catalogs; the local provider ([dsh-skill-local](../../packages/skill/skill-local)) scans project/custom/user directories; the consumer ([dsh-tool-skill](../../packages/skill/tool-skill)) owns the session-prefix catalog and model-facing `skill` tool. Skills are optional instructions, not session events, so their vocabulary lives here rather than in [core.md](core.md).

Source: [`packages/skill/skill/src/index.ts`](../../packages/skill/skill/src/index.ts), [`packages/skill/skill-local/src/index.ts`](../../packages/skill/skill-local/src/index.ts), and [`packages/skill/tool-skill/src/index.ts`](../../packages/skill/tool-skill/src/index.ts).

## Provider registry

`ctx.skills` combines local, embedded, remote, or other providers. Registration is synchronous; remote initialization and discovery belong in awaited `list()`. Provider objects, options, and candidates are borrowed readonly, while semantic fields are validated.

Duplicate names resolve by rank, provider order, then local order; summaries sort by name. A rejected `list()` is logged and skipped without caching the degraded catalog, while malformed candidates fail fast.

```ts type-equiv
interface SkillProvider {
  readonly name: string
  readonly list: (options: SkillLookupOptions) => Promise<readonly SkillCandidate[]>
  readonly get: (candidate: SkillCandidate, options: SkillLookupOptions) => Promise<SkillDefinition | undefined>
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

The project root is the nearest ancestor containing `.git`; without one, the current cwd is used. When `ctx.fs` is available, the git-root walk probes `.git` through the filesystem service so remote or sandboxed workspaces do not fall back to the host filesystem boundary. The user DSH root skips its `.system` child. The local provider does not ship built-in system skills; deployments supply built-ins through another provider.

## Skill identity

Skill names are kebab-case (`^[a-z0-9]+(?:-[a-z0-9]+)*$`). The local provider accepts directory bundles (`<name>/SKILL.md`) and flat Markdown files (`<name>.md`). Nested recursive `**/SKILL.md` discovery is intentionally outside v1.

```ts type-equiv
type SkillSource = 'project-dsh' | 'project-agents' | 'runtime' | 'user-dsh' | 'user-agents' | 'custom' | (string & {})
```

## Summaries, candidates, and complete definitions

`SkillSummary` is the registry's model-invocable summary shape. Consumers choose which fields to render; the session catalog uses only `name` and `description`, never the body or absolute file path. `disableModelInvocation` hides a skill from model listings while allowing trusted code to load it by name.

```ts type-equiv
interface SkillSummary {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly disableModelInvocation?: boolean
  readonly source: SkillSource
  readonly provider: string
  readonly resourceBase?: SkillResourceBase
}
```

`SkillCandidate` is the provider-to-registry shape. `locator` is opaque provider state; the registry only stores it and gives it back to the winning provider's `get()`.

```ts type-equiv
interface SkillCandidate extends SkillSummary {
  readonly rank: number
  readonly locator: unknown
  readonly path?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}
```

`SkillDefinition` is the complete parsed result returned by `ctx.skills.get()` and used by the `skill` tool. `resourceBase` tells the tool how to render relative-resource guidance for local, URL, or provider-managed skills.

```ts type-equiv
type SkillResourceBase =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'opaque'; readonly description: string }
```

```ts type-equiv
interface SkillDefinition extends SkillSummary {
  readonly content: string
  readonly path?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}
```

Runtime skills use the same complete shape and participate in the same first-wins collection order. The returned disposer removes the contribution and invalidates discovery caches.

```ts type-equiv
type SkillRegistration = Omit<SkillDefinition, 'provider'> & {
  readonly provider?: string
}
```

## Lookup and configuration

Skill lookup is cwd-sensitive because providers may expose workspace-local skills, and its optional signal cancels provider work for the caller. Providers receive the same readonly options object used for cache identity and loading. Cancellation is checked before and after catalog selection, including cache hits, and races both discovery and full-definition loading. If no git root is found, the local provider treats the supplied cwd itself as the project root.

```ts type-equiv
interface SkillLookupOptions {
  readonly cwd?: string | undefined
  readonly signal?: AbortSignal | undefined
}
```

The registry owns only its discovery-cache bound. The local provider owns filesystem roots (`dshHome`, `agentsHome`, and `customSkillDirs`). The consumer owns its catalog description bound.

```ts type-equiv
interface Config {
  readonly collectCacheMaxEntries?: number
}
```

## Session catalog and tool contract

`dsh-tool-skill` contributes a user-role `<system-reminder>` through `agent/session-prefix`. The catalog contains sorted skill `name` and normalized, XML-escaped `description` only; it omits bodies, paths, sources, providers, and routing hints. Prefix discovery forwards the caller's abort signal through `SkillLookupOptions`. `catalogDescriptionMaxLength` is the consumer config for the description bound, with default `500` and integer minimum `3`. Its request-only, header-logged lifecycle is defined by the [session-prefix RFC](../rfc/implemented/feature/2026-07-07-session-prefix.md).

The model-facing `skill({ name })` tool validates the kebab-case name, loads the complete definition for the calling agent cwd, reports an unresolved skill as unknown or no longer available, rejects `disableModelInvocation` skills, and returns a tool result containing `<skill_content name="...">`, `<skill_resources>`, and `<skill_instructions>`. `resourceBase` resolves explicitly referenced scripts, references, and assets only as needed; the loaded result does not enumerate a skill directory. The tool result is the model-visible path for complete instructions.
