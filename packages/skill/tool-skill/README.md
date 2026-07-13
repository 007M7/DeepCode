# @deepseek-ai/dsh-tool-skill

The model-facing skill catalog and `skill` tool.

Requires `ctx.tools` and `ctx.skills` (`inject: ['tools', 'skills']`).

## Session-prefix catalog

The plugin contributes one user-role `<system-reminder>` catalog through `agent/session-prefix`. It resolves skills for the calling session's cwd, forwards the prefix abort signal to discovery, and lists only sorted `name` and `description` entries; skill bodies, paths, sources, providers, and `whenToUse` hints remain outside the catalog. The catalog is omitted when no model-invocable skills are available, and also when that agent's tool view restricts away the shipped `skill` tool or resolves a same-name scoped shadow instead. This exact-definition check keeps prompt guidance, the model-visible schema, and executable dispatch aligned.

`catalogDescriptionMaxLength` controls normalized, XML-escaped catalog descriptions. Its default is `500` and values must be integers of at least `3`, which reserves room for a truncation ellipsis. The [session-prefix RFC](../../../docs/rfc/implemented/feature/2026-07-07-session-prefix.md) defines the request-only, header-logged lifecycle of this message.

## Tool: `skill`

| Arg | Type | Notes |
|---|---|---|
| `name` | string (required) | Exact kebab-case skill name from the available skills listing. |

Execution uses the calling agent's `session.header.cwd` so workspace-sensitive providers can resolve the right winning skill. A successful call returns one text tool result with `<skill_content name="...">`, containing `<skill_resources>` followed by `<skill_instructions>`. Resource guidance resolves paths or URLs explicitly referenced by the loaded instructions against `resourceBase`; referenced scripts, references, and assets load only when needed, and the tool does not enumerate a skill directory. Local filesystem skills provide a base directory, while remote or embedded providers can provide a URL or opaque provider-managed guidance. A name that cannot be resolved reports that the skill is unknown or no longer available; invalid names and skills marked `disableModelInvocation: true` retain distinct `isError` results.

The tool does not call `agent.inject()` in v1. Its result is already recorded as the tool result and becomes available to the next model step without duplicating the content as synthetic context.

## Model Experience

| Context surface | What the model sees | Token effect |
|---|---|---|
| Session prefix | If model-invocable skills exist and this exact `skill` tool is visible, the agent receives the exact [catalog template](#skill-catalog-template), with one data-dependent entry per sorted skill. The catalog is a frozen user-role session prefix. | Repeated input cost scales with skill count and `catalogDescriptionMaxLength`; no catalog tokens are sent when the list is empty or the tool is hidden or shadowed. |
| Tool schema | The model sees `skill(name)` with exact description `Load the full instructions for an available skill. Call this with the exact skill name from the session skill catalog before acting on a task that names or clearly matches that skill.` and parameter description `The exact skill name from the available skills list.` | Fixed schema cost per request where the tool is visible. |
| Tool result | A successful call uses the exact [result template](#skill-result-template) with the exact [provider-managed](#provider-managed-resource-guidance), [directory](#directory-resource-guidance), [URL](#url-resource-guidance), or [opaque](#opaque-resource-guidance) resource guidance. | Loaded instructions are data-dependent tool-result tokens, resent on later steps until compaction; no duplicate `agent.inject()` copy is made. |
| Tool errors | Invalid or stale selections return exactly `Error: invalid skill name "<name>"`, `Error: skill "<name>" is unknown or no longer available`, or `Error: skill "<name>" is not available for model invocation`. Provider-thrown lookup text is data-dependent and receives the same `Error: <message>` wrapper. | Only a failing call adds these retained tokens. |

### Verbatim model-visible text

#### Skill catalog template

```text
<system-reminder>
A skill is a reusable set of task-specific instructions. The following skills are available in this session:

<available_skills>
- `<name>`: <normalized-and-capped-description>
</available_skills>

If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.
</system-reminder>
```

#### Skill result template

```text
<skill_content name="<escaped-name>">
<skill_resources>
<resource-guidance>
</skill_resources>

<skill_instructions>
<provider-owned-instruction-body>
</skill_instructions>
</skill_content>
```

#### Provider-managed resource guidance

```text
Resources for this skill are managed by provider "<provider>".
Load referenced resources only as needed.
```

#### Directory resource guidance

```text
Base directory for this skill: <path>
Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
```

#### URL resource guidance

```text
Base URL for this skill: <url>
Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.
```

#### Opaque resource guidance

```text
Resources for this skill: <description>
Load referenced resources only as needed.
```

## Known Limitations and Deferred Work

- **The catalog omits `whenToUse`, source, and provider metadata** — routing is based only on name and a capped description; `whenToUse` remains provider metadata and is not rendered by the loaded wrapper either.
- **Loaded instruction bodies have no size cap** — a provider can return a skill large enough to consume substantial next-step context; only catalog descriptions are truncated.
- **Resources are guidance, not attachments** — the tool reports a base directory/URL/opaque hint but neither enumerates nor fetches referenced files for the model.
- **Loading is one-shot text** — there is no partial, streaming, or cached-content handle when a remote provider is slow or a skill body is large.
