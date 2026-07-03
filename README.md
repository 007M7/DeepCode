# DeepSeek Harness

English | [中文](README.zh.md)

The **DeepSeek Harness SDK** is a plugin-based SDK for building agent harnesses.

## Development

This monorepo is built on the [Cordis](https://github.com/cordiverse/cordis) framework (vendored as source under `vendor/`), microkernel-style: everything is a plugin.

```sh
pnpm install
pnpm run test          # vitest
pnpm run demo:echo     # runnable echo-agent example (no API key needed)
pnpm run demo:coding   # full-featured agent harness demo (needs DEEPSEEK_API_KEY)
```

For humans, start with the [development guide](docs/development.md) for local setup, hooks, environment variables, and quality gates, then read the [architecture design](docs/architecture.md) before package work. Local context lives in [packages/](packages/) and [vendor/](vendor/).

For agents, follow [AGENTS.md](AGENTS.md).
