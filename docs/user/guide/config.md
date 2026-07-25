# Configuration

English | [中文](config.zh.md)

Harness uses `cordis.yml` to describe which plugins an agent loads and the configuration passed to each one. The file composes capabilities; the generated configuration catalog records the fields and defaults each package actually supports, avoiding a second hand-maintained reference.

## Start from a real configuration

The repository examples are runnable configurations and the most reliable starting points for a new project:

- [tui-agent](../../../examples/tui-agent/cordis.yml) combines the DeepSeek model, Bash, filesystem, compaction, subagents, workflows, and the interactive TUI.
- [headless-agent](../../../examples/headless-agent/cordis.yml) exposes the coding composition as a one-shot task.
- [acp-agent](../../../examples/acp-agent/cordis.yml) exposes fresh sessions to programmatic ACP clients.

A minimal configuration is a list of plugin entries:

```yaml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKey: !!js process.env.DEEPSEEK_API_KEY
    models:
      - deepseek-v4-flash

- id: bash
  name: '@deepseek-ai/dsh-bash-local'

- id: tui-agent
  name: '@deepseek-ai/dsh-tui-demo'
  config:
    provider: deepseek
    model: deepseek-v4-flash
    workspaceContext: false
```

## Plugin entries

`name` identifies an npm package or a local module relative to `cordis.yml`; `id` gives the plugin instance a stable identity; and `config` supplies plugin-specific configuration. Set `disabled: true` to skip an entry temporarily.

```yaml
- id: local-tool
  name: './src/my-tool.ts'
  disabled: false
  config:
    toolName: my_tool
```

Plugins load in file order. Place plugins that depend on services after the applications or capability plugins that provide them. Missing models, tools, and plugins fail as early as possible instead of being silently ignored.

## JavaScript values and environment variables

The Cordis loader evaluates runtime expressions tagged with `!!js`. Keep API keys and other secrets in the gitignored `.env` file at the repository root, never in committed configuration.

```yaml
config:
  apiKey: !!js process.env.DEEPSEEK_API_KEY
  cwd: !!js process.cwd()
```

The tag is `!!js`, not `!js`.

## Exact configuration reference

The generated [plugin configuration catalog](../../config-catalog.md) lists every current field, type, and default. For composition concepts, continue to the [architecture](../../architecture.md) and [capability interfaces](../../capability-seams.md). To create a configuration, copy the closest entry from the [examples overview](../../../examples/README.md) and adapt it.
