# DeepSeek Harness

[English](README.md) | 中文

**DeepSeek Harness SDK** 是用于构建 agent harness（智能体框架）的 SDK，采取基于插件的设计。

## 开发

本 monorepo 基于 [Cordis](https://github.com/cordiverse/cordis) 框架构建（以源码形式收录在 `vendor/` 下），采用微内核风格：所有功能都以插件形式提供。

```sh
pnpm install
pnpm run test          # vitest
pnpm run demo:repl     # REPL agent demo (needs DEEPSEEK_API_KEY)
pnpm run demo:acp      # ACP server agent demo (needs DEEPSEEK_API_KEY)
```

面向开发者：先读[开发指南](docs/development.md)，了解本地环境搭建、钩子、环境变量与质量门禁，动手改 package 之前再读[架构设计](docs/architecture.md)和[文档关系图索引](docs/graph-atlas.md)。局部上下文见 [packages/](packages/) 与 [vendor/](vendor/)。

面向 agent：遵循 [AGENTS.md](AGENTS.md)。
