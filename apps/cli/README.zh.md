# `@deepseek-ai/dsh`

[English](README.md) | 中文

`dsh` 命令是原始 Cordis 配置、Web UI 和一次性无头任务的产品启动器。[`src/args.ts`](src/args.ts) 负责命令语法，[`src/bin.ts`](src/bin.ts) 只加载选中的运行器。无效命令、来自其他模式的选项、配置错误和启动失败都会以非零状态退出。

## 入口模式

| 命令 | 用途 |
|---|---|
| `dsh --config ./app.cordis.yml` | 在随附基础配置之上运行显式 patch 列表配置。 |
| `dsh web` | 使用随附 Web 组合和可选个人配置启动浏览器 UI。 |
| `dsh -p "task"` | 运行一个新的持久化会话，打印最终答案并退出。 |

调用目录是默认 workspace 根目录。Web 与无头模式共享随附的提供方、持久化、策略、工具、repository Plugin 和遥测组合；原始配置自行选择部署专用前端入口。

## 原始配置

原始 `dsh` 必须提供 `--config`。指定的 patch 列表直接应用到 [`config/base.cordis.yml`](config/base.cordis.yml) 之上；它不是完整替代树，也不会添加 surface overlay 或个人 `$DSH_HOME/config.yaml`。使用 `--dump-default-config` 和 `--dump-config` 可在不启动的情况下检查生成的配置树。

[CLI（命令行界面）行为参考](reference/README.md)负责确切的 overlay 优先级、flag、关闭行为、部署默认值和源码启动器。

## 开发

生产环境的 Web 和无头运行需要已构建的包与前端产物。在 checkout 中，`pnpm run dsh` 会运行 TypeScript 入口并转发参数；[源码启动器参考](reference/README.md#source-launcher)说明 PATH 符号链接和模块解析契约。
