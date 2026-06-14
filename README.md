# DeepSeek Harness

Monorepo for the DeepSeek Harness group.

## Projects

- **DeepSeek Code** — DeepSeek's coding agent product.

## Development

This monorepo is built on the [Cordis](https://github.com/cordiverse/cordis) framework (vendored as source under `vendor/`), microkernel-style: everything is a plugin.

```sh
yarn install
yarn test          # vitest
yarn demo:echo     # runnable echo-agent example (no API key needed)
yarn demo:coding   # the real DeepSeek coding agent (needs DEEPSEEK_API_KEY)
```

For humans, start with the [development guide](docs/development.md) for local setup, hooks, environment variables, and quality gates, then read the [architecture design](docs/architecture.md) before package work. Local context lives in [packages/](packages/) and [vendor/](vendor/).

For agents, follow [AGENTS.md](AGENTS.md).
