# @deepseek-ai/dsh-tool-skill

The model-facing `skill` tool for loading full skill instructions.

Requires `ctx.tools` and `ctx.skills` (`inject: ['tools', 'skills']`).

## Tool: `skill`

| Arg | Type | Notes |
|---|---|---|
| `name` | string (required) | Exact kebab-case skill name from the available skills listing. |

Execution uses the calling agent's `session.header.cwd` to resolve project-local skills. A successful call returns a text block containing `<skill_content name="...">`, the skill body, the skill base directory, and relative-path guidance. Unknown names, invalid names, and skills marked `disableModelInvocation: true` return `isError` tool results through the normal tool registry error path.

The tool does not call `agent.inject()` in v1. Its result is already recorded as the tool result and becomes available to the next model step without duplicating the content as synthetic context.
