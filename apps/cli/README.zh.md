# `@deepseek-ai/dsh`

[English](README.md) | 中文

`dsh` 命令行入口遵循 `apps/` 组装层：`apps/*` 是位于 `packages/*` 库之上的产品组装。直接运行 `dsh` 会启动交互式 TUI 编码 agent（智能体），`dsh -p "task"` 运行一个无头轮次，`dsh web` 则提供浏览器 UI。

Argv 只会通过 [Commander](https://github.com/tj/commander.js) 适配器（[`src/args.ts`](src/args.ts)）解析一次：同一个程序的默认形式（无子命令）是 TUI／无头界面（`--config`、`-p`/`--prompt`、`--resume`），`web` 子命令则是浏览器 UI。`src/bin.ts` 按解析后的 mode 分支，仅动态导入该 mode 的模块。`dsh --help` 列出所有 mode，`dsh web --help` 渲染 Web 用法，`dsh --version` 打印此应用的版本；未知选项或拼错的 `--resume` 会明确报错（stderr，退出码 1），而不会被错路由。`dsh web` 的 `--host`/`--port` 是未验证的直通覆盖：`dsh-host-webserver` schema 是默认值（标志缺失时使用已交付的 `cordis.yml` 值）和有效性的唯一真源，并在启动时拒绝错误值。`--trusted-host` 为 /api 浏览器信任栅栏追加具名权威；全接口绑定还会自行推导本机的 LAN IP 字面量（[`src/app-cli-entry.ts`](src/app-cli-entry.ts)），因此打印出的 LAN URL 无需任何标志即可使用。

TUI 界面：

- 启动已交付的默认配置（`examples/tui-agent/cordis.yml`），或由 `--config <path>` 指定的树（演示／测试用于启动其他示例树的逃生口），并通过 [`dsh-app-boot`](../../packages/ui/app-boot/README.md) 完成启动；
- 使用 `dsh --resume <session-id>` 恢复已持久化会话。当 Node 宿主公开 `process.execve` 时，还会提供 TUI 的原地移交宿主：选择器预检并刷新当前会话后，宿主会释放应用，并以规范化的 `dsh --resume <id>` 替换进程；不支持进程替换的运行时保留屏幕上显示的命令回退。该标志通过 `RESUME_SESSION_ID_KEY` 在启动上下文中提供 id（不使用环境变量），已交付的配置通过 `!!js` 读取它；缺失或无法读取的 id 会明确报错，而不会创建新会话；
- 将 **调用目录** 视为 workspace：会话、相对路径和 workspace 指令都从 cwd 解析；
- 告知 agent 自身源码所在位置：启动后添加一个命名此 harness checkout 的提示词段。该路径从启动器的真实路径解析，因此在 PATH 符号链接和任意 cwd 下仍然有效，使自指的 `cordis` 工具集可以读取并修改它；
- 应用 `~/.dsh` 中的个人覆盖（参见 [app-boot 的个人配置](../../packages/ui/app-boot/README.md#personal-config)）：`.env` 填补环境缺口（环境中已有的值 > 项目 `.env` > 个人 `.env`），`config.yaml` 则修补已启动的树。

Web 和无头界面启动同一个共享组合（`cordis.yml`）：两者都将调用目录视为默认项目和 Workspace 根目录，除非通过 `--workspace-root <path>` 覆盖，否则会在该根目录下创建具名 Workspace；它们会把适用的 `AGENTS.md`/`CLAUDE.md` 指令加载到每个 agent-loop 请求前缀中，渲染预算为 65,536 字节，并选用首条消息模型标题。无头界面唯一的差异是监听操作系统分配的端口（并行 `dsh -p` 运行绝不冲突；stderr 打印的 URL 会在浏览器中打开实时会话）。两者都需要先构建前端 dist 和客户端 bundle（`pnpm run build && pnpm run build:web`）。

`DSH_TOOLS_MODE` 为整个 Web／无头进程选择工具呈现模式：可选值为 `native`（未设置时的 schema 默认值）、`code`（仅含 `run_code` 的 Code Mode 协议接口）或 `both`；任何其他值都会经由 `dsh-tools` 配置 schema 在启动时明确报错。它是一个临时 seam：Loader 组合是静态的，因此该设置作用于整个进程；待 Web UI 负责逐会话工具模式选择后便会移除。TUI 界面会忽略该变量（其配置树固定了自身模式）。

## 安装（开发机）

将从源码运行的启动器符号链接到 PATH 上；它通过自身真实路径解析 checkout，因此代码更改会在下次启动时生效，无需构建：

```sh
ln -sf "$(pwd)/bin/dsh" ~/.local/bin/dsh
```

源码启动会通过 Node 的 `--experimental-transform-types` 运行 `apps/cli/src/bin.ts`；`scripts/tspath-loader.ts` 只会将 tsconfig 的 `paths` 映射投射到模块解析中，而不会转换代码。从 CLI 源码入口可达的每个模块都遵守 Node transform-types 契约：会被擦除的绑定使用 `import type`，export 使用原生 ESM，整个依赖图不含 TSX/JSX，也不依赖仅由 tsx/esbuild 提供的转换。设置 `TSX_TSCONFIG_PATH` 时，loader 会读取该路径（相对路径从调用方的 cwd 解析），否则读取仓库根 tsconfig；它使用根目录的 TypeScript 开发工具，而不是应用依赖。仅当 workspace import 是包自身引用或已声明的运行时依赖时，loader 才会映射该 import。TUI 配置通过 `examples/package.json` 解析裸插件，而 Web／无头 `cordis.yml` 则通过本包的 `dependencies` 解析；`verify-cordis-config` 要求每个已配置的裸插件均已声明，同时允许存在无关依赖。

`pnpm run dsh` 从仓库根目录运行同一入口并直接转发参数，例如 `pnpm run dsh -p "task"`。构建形式（`lib/bin.js`，通过 `pnpm run build`）会在普通 Node 下启动同一配置。
