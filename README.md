# DeepSeek Harness

English | [中文](README.zh.md)

The **DeepSeek Harness SDK** is a plugin-based SDK for building agent harnesses.

## Development

This monorepo is built on the [Cordis](https://github.com/cordiverse/cordis) framework (vendored as source under `vendor/`), microkernel-style: everything is a plugin.

```sh
pnpm install
pnpm run test          # vitest
# Agent demos require DEEPSEEK_API_KEY.
pnpm run demo:tui      # full-screen TUI coding agent
pnpm run demo:headless "task" # one-shot coding agent
pnpm run demo:cordis   # self-referential agent demo
pnpm run demo:acp      # ACP server agent demo
```

For humans, start with the [development guide](docs/development.md) for local setup, hooks, environment variables, and quality gates, then read the [architecture design](docs/architecture.md) and [documentation graph index](docs/graph-atlas.md) before package work. Local context lives in [packages/](packages/) and [vendor/](vendor/).

For agents, follow [AGENTS.md](AGENTS.md).
