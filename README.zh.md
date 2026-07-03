# DeepSeek Harness

[English](README.md) | 中文

**DeepSeek Harness SDK** 是一个基于插件的 SDK，用于构建 agent harness。

## 开发

本 monorepo 基于 [Cordis](https://github.com/cordiverse/cordis) 框架构建（以源码形式收录在 `vendor/` 下），采用微内核风格：一切皆插件。

```sh
pnpm install
pnpm run test          # vitest
pnpm run demo:coding   # coding-agent demo (needs DEEPSEEK_API_KEY)
pnpm run demo:acp      # ACP server demo (needs DEEPSEEK_API_KEY)
```

面向人类读者：先读[开发指南](docs/development.md)了解本地环境搭建、钩子、环境变量与质量门禁，动手改 package 之前再读[架构设计](docs/architecture.md)。局部上下文见 [packages/](packages/) 与 [vendor/](vendor/)。

面向 agent：遵循 [AGENTS.md](AGENTS.md)。
