# `@deepseek-ai/dsh`

English | [中文](README.zh.md)

The `dsh` command is the product launcher for raw Cordis configurations, the Web UI, and one-shot headless tasks. [`src/args.ts`](src/args.ts) owns the command grammar, and [`src/bin.ts`](src/bin.ts) loads only the selected runner. Invalid commands, options from another mode, configuration errors, and boot failures exit nonzero.

## Entry modes

| Command | Purpose |
|---|---|
| `dsh --config ./app.cordis.yml` | Run an explicit patch-list configuration over the shipped base. |
| `dsh web` | Start the browser UI with the shipped Web composition and optional personal configuration. |
| `dsh -p "task"` | Run one fresh persisted session, print the final answer, and exit. |

The invoking directory is the default workspace root. Web and headless share the shipped provider, persistence, policy, tool, repository Plugin, and telemetry composition; raw config selects its own deployment-specific front door.

## Raw config

Raw `dsh` requires `--config`. The named patch list is applied directly over [`config/base.cordis.yml`](config/base.cordis.yml); it is not a complete replacement tree and does not add a surface overlay or personal `$DSH_HOME/config.yaml`. Use `--dump-default-config` and `--dump-config` to inspect the resulting tree without booting it.

The [CLI behavior reference](reference/README.md) owns exact overlay precedence, flags, shutdown behavior, deployment defaults, and the source launcher.

## Development

Production Web and headless runs require built package and frontend artifacts. From a checkout, `pnpm run dsh` runs the TypeScript entry and forwards arguments; the [source-launcher reference](reference/README.md#source-launcher) describes the PATH symlink and module-resolution contract.
