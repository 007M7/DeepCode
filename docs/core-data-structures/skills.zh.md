# Skills

[English](skills.md) | 中文

[skill（技能）能力族](../../packages/skill)拆分为三个包（package）：注册表（[dsh-skill](../../packages/skill/skill)，`ctx.skills`）合并各提供方的目录；本地提供方（[dsh-skill-local](../../packages/skill/skill-local)）扫描项目/自定义/用户目录；消费方（[dsh-tool-skill](../../packages/skill/tool-skill)）拥有会话前缀目录和面向模型的 `skill` 工具。skill 是可选的指令而非会话事件，因此其词汇定义在此处而非 [core.md](core.md)。

源码：[`packages/skill/skill/src/index.ts`](../../packages/skill/skill/src/index.ts)、[`packages/skill/skill-local/src/index.ts`](../../packages/skill/skill-local/src/index.ts) 与 [`packages/skill/tool-skill/src/index.ts`](../../packages/skill/tool-skill/src/index.ts)。

## 提供方注册表

`ctx.skills` 组合本地、内嵌、远程或其他提供方。注册是同步的；远程初始化与发现属于 `list()` 的 await 阶段。提供方对象、选项与候选项以只读方式借用，语义字段会被校验。

重名按 rank、提供方顺序、本地顺序依次解决；摘要按名称排序。`list()` 拒绝时记录日志并跳过，不缓存降级后的目录；格式错误的候选项快速失败。

```ts type-equiv
/** Provider interface for one source of skills, such as local directories or a remote registry. */
interface SkillProvider {
  /** Unique provider name in the `ctx.skills` registry. */
  readonly name: string
  /**
   * List available skill candidates for the current lookup context. Provider
   * plugins register synchronously during `apply()`; remote initialization,
   * authentication, and discovery are awaited inside this method. Implementations
   * should settle promptly when `options.signal` aborts.
   * @param options - lookup options; `cwd` selects workspace-sensitive skills and `signal` cancels work.
   * @returns provider candidates with precedence ranks and opaque locators.
   */
  readonly list: (options: SkillLookupOptions) => Promise<readonly SkillCandidate[]>
  /**
   * Load a complete skill body for a previously listed candidate.
   * @param candidate - the winning candidate originally returned by this provider.
   * @param options - lookup options; `cwd` selects workspace-sensitive skills and `signal` cancels work.
   * @returns the full skill body, or `undefined` if it is no longer loadable.
   */
  readonly get: (candidate: SkillCandidate, options: SkillLookupOptions) => Promise<SkillDefinition | undefined>
}
```

## 本地发现优先级

内置的本地提供方按 rank 顺序扫描各根目录：

| Rank | Source | Root |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills` |
| 500 | `user-agents` | `<agentsHome>/skills` |

项目根目录为包含 `.git` 的最近祖先目录；找不到时使用当前 cwd。当 `ctx.fs` 可用时，git-root 向上查找通过文件系统服务探测 `.git`，使远程或沙箱工作区不会回退到宿主文件系统边界。用户 DSH 根目录会跳过其 `.system` 子目录。本地提供方不附带内置系统 skill；部署方通过另一个提供方提供内置 skill。

## Skill 身份

skill 名称为 kebab-case（`^[a-z0-9]+(?:-[a-z0-9]+)*$`）。本地提供方接受目录包（`<name>/SKILL.md`）和扁平 Markdown 文件（`<name>.md`）。嵌套递归的 `**/SKILL.md` 发现有意不在 v1 范围内。

```ts type-equiv
/** Origin bucket for a skill contribution. The value is prompt-visible metadata, not precedence by itself. */
type SkillSource = 'project-dsh' | 'project-agents' | 'runtime' | 'user-dsh' | 'user-agents' | 'custom' | (string & {})
```

## 摘要、候选项与完整定义

`SkillSummary` 是注册表中可供模型调用的摘要形状。消费方自行选择渲染哪些字段；会话目录仅使用 `name` 和 `description`，从不使用 body 或绝对文件路径。`disableModelInvocation` 将 skill 从模型列表中隐藏，但允许受信代码按名称加载。

```ts type-equiv
/** Model-visible skill metadata returned by `ctx.skills.list()` and rendered into request guidance. */
interface SkillSummary {
  /** Kebab-case identifier used with the `skill` tool. */
  readonly name: string
  /** Short routing description shown to the model. */
  readonly description: string
  /** Optional extra routing guidance shown to the model. */
  readonly whenToUse?: string
  /** Whether the skill is hidden from model listings while remaining loadable by trusted callers. */
  readonly disableModelInvocation?: boolean
  /** Discovery source that produced this winning skill. */
  readonly source: SkillSource
  /** Provider that owns this skill body. */
  readonly provider: string
  /** Provider-specific base for relative resources. */
  readonly resourceBase?: SkillResourceBase
}
```

`SkillCandidate` 是提供方到注册表的形状。`locator` 是提供方的不透明状态；注册表只存储它并在调用获胜提供方的 `get()` 时传回。

```ts type-equiv
/** Provider catalog entry used by the registry to merge and later load skills. */
interface SkillCandidate extends SkillSummary {
  /** Lower ranks win duplicate skill names before provider registration order is considered. */
  readonly rank: number
  /** Opaque provider-owned handle passed back to `provider.get()`. */
  readonly locator: unknown
  /** Absolute file path when the provider has one. */
  readonly path?: string
  /** Parsed optional metadata object from provider-specific skill frontmatter. */
  readonly metadata?: Readonly<Record<string, unknown>>
}
```

`SkillDefinition` 是 `ctx.skills.get()` 返回的完整解析结果，供 `skill` 工具使用。`resourceBase` 告知工具如何为本地、URL 或提供方管理的 skill 渲染相对资源引导。

```ts type-equiv
/** Optional provider-specific base used by loaded skill bodies to resolve relative resources. */
type SkillResourceBase =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'opaque'; readonly description: string }
```

```ts type-equiv
/** Complete parsed skill definition, including the body loaded by `ctx.skills.get()`. */
interface SkillDefinition extends SkillSummary {
  /** Markdown instruction body after any provider-specific metadata removal. */
  readonly content: string
  /** Absolute file path when the skill came from disk. */
  readonly path?: string
  /** Parsed optional metadata object from frontmatter. */
  readonly metadata?: Readonly<Record<string, unknown>>
}
```

运行时 skill 使用相同的完整形状，参与相同的先到先得收集顺序。返回的 disposer 移除该贡献并使发现缓存失效。

```ts type-equiv
/** Runtime skill contribution accepted by `ctx.skills.register()`. */
type SkillRegistration = Omit<SkillDefinition, 'provider'> & { readonly provider?: string }
```

## 查找与配置

skill 查找对 cwd 敏感，因为提供方可能暴露工作区本地的 skill；可选的 signal 为调用方取消提供方的工作。提供方接收与缓存标识和加载相同的只读选项对象。取消在目录选择前后（包括缓存命中时）都会检查，并与发现和完整定义加载竞争。如果找不到 git root，本地提供方将所提供的 cwd 本身视为项目根目录。

```ts type-equiv
/** Caller context used for cwd-sensitive and abortable provider work. */
interface SkillLookupOptions {
  /** Workspace selector for the current lookup. */
  readonly cwd?: string | undefined
  /** Abort discovery or loading work for the current caller. */
  readonly signal?: AbortSignal | undefined
}
```

注册表只拥有其发现缓存上限。本地提供方拥有文件系统根目录（`dshHome`、`agentsHome` 与 `customSkillDirs`）。消费方拥有其目录描述上限。

```ts type-equiv
/** Skill registry configuration. */
interface Config {
  /** Maximum number of completed cwd/provider catalogs kept in memory. */
  readonly collectCacheMaxEntries?: number
}
```

## 会话目录与工具契约

`dsh-tool-skill` 通过 `agent/session-prefix` 贡献一条 user-role `<system-reminder>`。目录只包含已排序的 skill `name` 和规范化、经 XML 转义的 `description`；不包含正文、路径、来源、提供方或路由提示。Prefix 发现通过 `SkillLookupOptions` 转发调用方的 abort signal。`catalogDescriptionMaxLength` 是消费方用于 description 上限的配置，默认值为 `500`，整数最小值为 `3`。其仅用于请求、记录在 header 中的生命周期由 [session-prefix Agent Note（agent 决策记录）](../../.agents/notes/implemented/feature/2026-07-07-session-prefix.md)定义。

面向模型的 `skill({ name })` 工具校验 kebab-case 名称，为调用方 agent 的 cwd 加载完整定义，将未解析的 skill 报告为 unknown 或 no longer available，拒绝 `disableModelInvocation` 的 skill，并返回包含 `<skill_content name="...">`、`<skill_resources>` 和 `<skill_instructions>` 的工具结果。`resourceBase` 仅按需解析显式引用的脚本、参考资料和资产；加载结果不枚举 skill 目录。工具结果是模型获取完整指令的可见路径。
