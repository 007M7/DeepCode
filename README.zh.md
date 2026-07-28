# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是一款基于 DeepSeek Harness SDK 构建的开源 coding agent（编程智能体）。

它采用了**一切皆插件**的架构。

## 安装

使用一条命令安装 `dsh`：

```sh
curl -fsSL https://raw.githubusercontent.com/deepseek-harness/deepseek-harness/master/scripts/install.sh | sh
```

安装器要求系统已安装 `git` 和 Node `^22.19 || >=24`，缺少 `pnpm` 时可代为安装，并会提示输入 DeepSeek API 密钥。

安装器会把所有检出都放在 `~/.dsh/source` 下：master 克隆位于 `~/.dsh/source/master`，每次安装的 staging 检出是一个 git worktree `~/.dsh/source/staging-<时间戳>`。稳定符号链接 `~/.dsh/source/current` 指向当前生效的 staging worktree，`~/.local/bin` 中的 `dsh` 链接到 `current/bin/dsh`，因此升级只需重指一个符号链接，PATH 上的 `dsh` 从不移动。再次运行该命令会基于更新后的 master 新增一个 staging worktree，并把 `current` 重指到它。其他安装位置和选项见 [`scripts/install.sh`](scripts/install.sh)。

## 使用 DeepSeek Harness

### Web UI

推荐在本地使用 Web UI。安装完成后以及每次更新后，请先构建前端，再启动 Web UI。通过 `dsh` 启动器解析当前运行的检出，这样无论当前是哪个 staging worktree，命令都成立（启动器会经由稳定的 `current` 符号链接解析）：

```sh
dsh_bin=$(cd "$(dirname "$(command -v dsh)")" && pwd -P)/$(basename "$(command -v dsh)")
while [ -L "$dsh_bin" ]; do
  link=$(readlink "$dsh_bin")
  case $link in /*) dsh_bin=$link ;; *) dsh_bin=$(cd "$(dirname "$dsh_bin")" && cd "$(dirname "$link")" && pwd -P)/$(basename "$link") ;; esac
done
dsh_dir=$(cd "$(dirname "$dsh_bin")/.." && pwd -P)
pnpm --dir "$dsh_dir" run build && pnpm --dir "$dsh_dir" run build:web
dsh web
```

Web UI 默认通过 `http://127.0.0.1:3080` 提供服务。

### TUI

启动全屏终端界面：

```sh
dsh
```

### Headless

运行一项任务，打印最终答案后退出：

```sh
dsh -p "summarize this workspace"
```

## 为什么选择 DeepSeek Harness

内置功能涵盖文件读取、编辑与搜索、shell 执行、可复用 skill（技能）、任务跟踪、subagent 与工作流、持久化会话，以及上下文压缩（context compaction）。TUI 还包含 Plan Mode。

- **一切皆插件。** 模型、工具、策略、存储、上下文管理和界面均可组合为 [Cordis 插件](docs/user/develop/basic/index.md)，部署方无需 fork agent loop（智能体循环）即可扩展或替换行为。底层设计见[架构文档](docs/architecture.md)。
- **Code Mode（需显式启用）。** 它会提供 `run_code` 工具和生成的 TypeScript SDK，只有程序输出会重新进入模型上下文。参见 [Code Mode](packages/core/tools/README.md#code-mode)。
- **自指 Cordis 工具需显式启用。** 这些工具可让 agent 检查自身的实时运行时，并在运行中挂载或卸载插件。参见 [Cordis 工具](packages/cordis/tool-cordis/README.md)。

## 社区

扫描二维码，或打开 <a href="https://wj.qq.com/s2/27234598/03eb/">DeepSeek Harness 微信社区申请页面</a> 申请加入。

<p>
  <img src="assets/community-wecom-survey.png" alt="DeepSeek Harness 微信社区二维码" width="240">
</p>

## 开发

```sh
pnpm install
pnpm run test:coverage
```

请先阅读[开发指南](docs/development.md)；修改包之前，请阅读[架构文档](docs/architecture.md)。

面向 agent：遵循 [AGENTS.md](AGENTS.md)。

DeepSeek Harness 目前处于预发布阶段。

## 许可证

[BSD 3-Clause](LICENSE)
