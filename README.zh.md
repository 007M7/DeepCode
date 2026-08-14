# DeepCode

[English](README.md) | 中文

![DeepCode 终端 CLI](assets/deepcode-cli-preview.png)

DeepCode 是一个本地优先、原生运行于终端的 coding-agent CLI，建立在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 与 [Cordis](https://github.com/cordiverse/cordis) 的插件架构之上。面向用户的命令是 `deepseek`；随附 profile 会在 CMD、PowerShell、Windows Terminal 及兼容的 POSIX 终端中直接打开 DeepCode 界面。

DeepCode 目前处于开发者预览阶段。本地 CLI 是第一期交付目标；Herdr 适配明确暂缓，不阻塞本地使用。

## 主要能力

- **专业终端工作流** — 支持流式回答、多行编辑、输入历史、slash 补全、取消运行、会话恢复、模型选择、遮罩登录、审批和稳定的终端滚动区域。
- **DeepCode 产品身份** — 使用从效果图提取的蓝色像素鲸鱼、`DeepCode` 控制台标题，并在所有支持的 shell 中提供统一的 `deepseek` 入口。
- **插件优先扩展** — 模型 provider 通过 `ctx.llm` 注册，人工命令通过 `ctx.commands` 注册，工具通过 `ctx.tools` 注册；执行、会话、设置、凭据、审批和 UI adapter 也都保持为可替换插件。
- **本地安全能力** — 文件系统策略、权限预设、审批路由、凭据引用、子进程约束和持久 Session 日志均来自组合后的 Harness 能力。

## 环境要求

- Node.js `^22.19` 或 `>=24`
- 通过 Corepack 使用 pnpm
- 真实模型请求需要 DeepSeek API key；启动、帮助、配置检查和无密钥快照不需要密钥

<a id="run"></a>

## 从源码运行

Windows 用户克隆或解压仓库后，只需运行一次安装器：

```cmd
git clone https://github.com/007M7/DeepCode.git
cd DeepCode
install-deepcode.cmd
```

安装器会恢复依赖、构建 CLI、生成一份由 CMD 与 PowerShell 共用的 `deepseek.cmd` 入口，并把 npm 全局命令目录写入当前用户的持久 `PATH`。直接启动器不会产生递归 npm 包链接，在 PowerShell 禁止脚本执行时也能使用。该命令指向检出目录中的构建入口，因此安装后请勿移动或删除下载目录。打开新的命令提示符、PowerShell 或 Windows Terminal 窗口，然后运行：

```cmd
deepseek
```

安装过程可安全重复执行；拉取更新后再次运行 `install-deepcode.cmd` 即可，运行 `uninstall-deepcode.cmd` 可移除全局命令。开发者及 POSIX 用户也可以直接运行源码入口：

```sh
corepack pnpm install
corepack pnpm run build:lib:host
node apps/cli/lib/deepseek.js
```

profile 启动形式仍与其等价：

```sh
dsh cli
```

## 核心交互

| 命令 | 用途 |
|---|---|
| `/login` | 通过 credential service 保存当前 provider 的 API key。 |
| `/logout` | 删除托管凭据。 |
| `/models` | 列出已安装 provider 插件注册的全部模型目录。 |
| `/model` | 选择 provider、模型、思考模式和推理等级。 |
| `/new` | 创建新的持久化会话。 |
| `/sessions` | 列出当前工作区内可恢复的会话。 |
| `/resume <id>` | 恢复符合条件的会话。 |
| `/status` | 查看会话、模型、认证和工作区状态。 |
| `/clear` | 清空终端回滚并重新绘制 DeepCode 标题。 |
| `/help` | 显示内置命令及当前注册的全部插件命令。 |
| `/exit` | 刷新当前会话并退出。 |

Enter 发送；Ctrl+J 或 Shift+Enter 换行；Up/Down 浏览历史或选择项；Tab 补全 slash command；Ctrl+O 打开工具详情；Ctrl+N 新建会话；Escape 或 Ctrl+C 取消运行中的工作；空闲 Ctrl+C 或空缓冲区 Ctrl+D 退出。

## 插件与模型 Provider

默认预览组合只安装 DeepSeek 官方 provider。DeepCode 不会把未来 provider 硬编码进终端主循环：注册到 `ctx.llm` 的 adapter 会自动进入 `/models`、`/model`、状态显示、认证引用解析和 Agent 请求流程。

通过以下命令向 CLI profile 安装树外组合包或插件：

```sh
dsh plugin --profile cli add <package>
```

注册后的 slash command 会自动进入补全与 `/help`，包括随附的 `/compact` 和 `/goal`。profile patch 层可以替换或扩展工具、模型 provider、策略、会话行为和命令 producer，无需修改 Agent loop。

## 仓库结构

- [`apps/cli`](apps/cli) 持有 `dsh`、`deepseek` 可执行入口、profile boot 和包入口。
- [`packages/bundle/cli-app`](packages/bundle/cli-app) 持有 DeepCode 终端界面与本地多轮 driver。
- [`packages`](packages) 包含 CLI profile 组合使用的可复用 Harness 能力。
- [`docs/architecture.md`](docs/architecture.md) 说明底层插件架构与扩展点。

DeepCode 保留 Harness 源码布局，以持续兼容上游能力更新和第三方插件。产品身份与终端行为位于 CLI 应用层；新增能力通过已记录的插件 API 接入，而不是派生 core loop 分支。

## 当前范围与演进方向

当前预览版只预装 DeepSeek 官方模型 provider。后续方向包括更多 provider 插件、更完善的 Markdown 与 diff 渲染、工具专用终端展示、更强的 Windows 终端集成，以及 Herdr 等可选外部编排。这些是扩展目标，不代表当前版本已经具备。

交互体验将持续向 Claude Code 等成熟 coding-agent CLI 靠近，同时保留 DeepCode 的插件组合、持久 Session 日志、明确审批和普通终端 scrollback。

## 致谢与许可证

DeepCode 派生自 DeepSeek Harness，并使用 vendored Cordis 组件。上游作者保留各自版权。本仓库采用 [MIT](LICENSE) 许可证，第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
