# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness 小组的 monorepo。

## 项目

- **DeepSeek Code** — DeepSeek 的编码 agent（智能体）产品。

## 开发

本 monorepo 基于 [Cordis](https://github.com/cordiverse/cordis) 框架构建（以源码形式收录在 `vendor/` 下），采用微内核风格：一切皆插件。

```sh
pnpm install
pnpm run test          # vitest
pnpm run demo:echo     # runnable echo-agent example (no API key needed)
pnpm run demo:coding   # the real DeepSeek coding agent (needs DEEPSEEK_API_KEY)
```

面向人类读者：先读[开发指南](docs/development.md)了解本地环境搭建、钩子、环境变量与质量门禁，动手改 package 之前再读[架构设计](docs/architecture.md)。局部上下文见 [packages/](packages/) 与 [vendor/](vendor/)。

面向 agent：遵循 [AGENTS.md](AGENTS.md)。
