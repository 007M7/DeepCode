# DeepSeek Harness

English | [中文](README.zh.md)

The **DeepSeek Harness SDK** is a plugin-based SDK for building agent harnesses.

## Development

This monorepo is built on the [Cordis](https://github.com/cordiverse/cordis) framework (vendored as source under `vendor/`), microkernel-style: everything is a plugin.

```sh
pnpm install
pnpm run test          # vitest
pnpm run demo:echo     # keyless mock-model REPL
pnpm run demo:repl     # readline coding agent (needs DEEPSEEK_API_KEY)
pnpm run demo:tui      # full-screen TUI coding agent (needs DEEPSEEK_API_KEY)
pnpm run demo:headless -- "task" # one-shot coding agent (needs DEEPSEEK_API_KEY)
pnpm run demo:cordis   # self-referential agent demo (needs DEEPSEEK_API_KEY)
pnpm run demo:acp      # ACP server agent demo (needs DEEPSEEK_API_KEY)
```

For humans, start with the [development guide](docs/development.md) for local setup, hooks, environment variables, and quality gates, then read the [architecture design](docs/architecture.md) and [documentation graph index](docs/graph-atlas.md) before package work. Local context lives in [packages/](packages/) and [vendor/](vendor/).

For agents, follow [AGENTS.md](AGENTS.md).
