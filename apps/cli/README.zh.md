# `@deepseek-ai/dsh`

[English](README.md) | 中文

`dsh` 命令行入口遵循 `apps/` 组装层：`apps/*` 是位于 `packages/*` 库之上的产品组装。直接运行 `dsh` 会启动交互式 TUI 编码 agent（智能体），`dsh -p "task"` 运行一个无头轮次，`dsh web` 则提供浏览器 UI。

Argv 只会通过 [Commander](https://github.com/tj/commander.js) 适配器（[`src/args.ts`](src/args.ts)）解析一次：同一个程序的默认形式（无子命令）是 TUI／无头界面（`--config`、`-p`/`--prompt`、`--resume`），`web` 子命令则是浏览器 UI。`src/bin.ts` 按解析后的 mode 分支，仅动态导入该 mode 的模块。`dsh --help` 列出所有 mode，`dsh web --help` 渲染 Web 用法，`dsh --version` 打印此应用的版本；未知选项或拼错的 `--resume` 会明确报错（stderr，退出码 1），而不会被错路由。`dsh web` 的 `--host`/`--port` 是未验证的直通覆盖：`dsh-host-webserver` schema 是默认值（标志缺失时使用已交付的 `cordis.yml` 值）和有效性的唯一真源，并在启动时拒绝错误值。

TUI 界面：

- 启动已交付的默认配置（`examples/tui-agent/cordis.yml`），或由 `--config <path>` 指定的树（演示／测试用于启动其他示例树的逃生口），并通过 [`dsh-app-boot`](../../packages/ui/app-boot/README.md) 完成启动；
- 使用 `dsh --resume <session-id>` 恢复已持久化会话。当 Node 宿主公开 `process.execve` 时，还会提供 TUI 的原地移交宿主：选择器预检并刷新当前会话后，宿主会释放应用，并以规范化的 `dsh --resume <id>` 替换进程；不支持进程替换的运行时保留屏幕上显示的命令回退。该标志通过 `RESUME_SESSION_ID_KEY` 在启动上下文中提供 id（不使用环境变量），已交付的配置通过 `!!js` 读取它；缺失或无法读取的 id 会明确报错，而不会创建新会话；
- 将 **调用目录** 视为 workspace：会话、相对路径和 workspace 指令都从 cwd 解析；
- 告知 agent 自身源码所在位置：启动后添加一个命名此 harness checkout 的提示词段。该路径从启动器的真实路径解析，因此在 PATH 符号链接和任意 cwd 下仍然有效，使自指的 `cordis` 工具集可以读取并修改它；
- 应用 `~/.dsh` 中的个人覆盖（参见 [app-boot 的个人配置](../../packages/ui/app-boot/README.md#personal-config)）：`.env` 填补环境缺口（环境中已有的值 > 项目 `.env` > 个人 `.env`），`config.yaml` 则修补已启动的树。

Web 和无头界面启动同一个共享组合（`cordis.yml`）：两者都将调用目录视为默认项目和 Workspace 根目录，除非通过 `--workspace-root <path>` 覆盖，否则会在该根目录下创建具名 Workspace；它们会把适用的 `AGENTS.md`/`CLAUDE.md` 指令加载到每个 agent-loop 请求前缀中，渲染预算为 65,536 字节，并选用首条消息模型标题。无头界面唯一的差异是监听操作系统分配的端口（并行 `dsh -p` 运行绝不冲突；stderr 打印的 URL 会在浏览器中打开实时会话）。两者都需要先构建前端 dist 和客户端 bundle（`pnpm run build && pnpm run build:web`）。

## 安装（开发机）

将从源码运行的启动器符号链接到 PATH 上；它通过自身真实路径解析 checkout，因此代码更改会在下次启动时生效，无需构建：

```sh
ln -sf "$(pwd)/bin/dsh" ~/.local/bin/dsh
```

`pnpm run dsh` 从仓库根目录运行同一入口并直接转发参数，例如 `pnpm run dsh -p "task"`。构建形式（`lib/bin.js`，通过 `pnpm run build`）会在普通 Node 下启动同一配置。
