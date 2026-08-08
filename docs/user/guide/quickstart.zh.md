# 快速开始

[English](quickstart.md) | 中文

本指南带你在 5 分钟内跑起一个 Agent。

## 环境准备

- [Node.js](https://nodejs.org/) ^22.19 或 >= 24
- 通过 Corepack 使用 [pnpm](https://pnpm.io/) 11
- [DeepSeek Platform](https://platform.deepseek.com/) API key

```sh
node -v
corepack enable
pnpm -v
```

## 第一步：安装并配置 API key

```sh
git clone https://github.com/deepseek-ai/deepseek-harness-sdk.git
cd deepseek-harness
pnpm install
```

在仓库根目录创建已被 Git 忽略的 `.env`：

```sh
DEEPSEEK_API_KEY=sk-your-key-here
```

## 第二步：运行一个 Headless 任务

运行一个非交互式任务并打印最终回答：

```sh
pnpm run demo:headless "summarize the architecture of this workspace"
```

Headless 运行一个完整的模型/工具轮次，持久化会话，打印结果后退出。需要规范事件流时可使用 `--output-format stream-json`。

## 第三步：使用 Web UI

构建并启动浏览器界面：

```sh
pnpm run build
pnpm run dsh web
```

打开 `http://127.0.0.1:3080`。agent 可以读写文件、运行命令、分配子任务和跟踪计划。可以尝试：`Create hello.js in the current directory, print "Hello from Harness!", and run it`。

## 回头看

headless-agent 使用 `@deepseek-ai/dsh-cli-demo` app。`dsh web` 则启动 `web` profile：由 [`dsh-base`](../../../packages/bundle/base/cordis.patch.yml) 与 [`dsh-web-app`](../../../packages/bundle/web-app/cordis.patch.yml) 两个组合包的 patch 层在空根之上组合而成。二者都会根据各自入口模式选择 DeepSeek 模型和能力插件。

## 下一步

- [配置模型](./providers.md) — 接入 DeepSeek 之外的提供方与自定义网关
- [配置文件](./config.md) — 了解 `cordis.yml` 的格式
- [开发插件](../develop/basic/) — 编写自己的 tool 或后端
