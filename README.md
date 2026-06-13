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

For agent instructions see [AGENTS.md](AGENTS.md). For the architecture design see [docs/architecture.md](docs/architecture.md). Each subdirectory has its own README.md with local context: [packages/](packages/), [vendor/](vendor/).
