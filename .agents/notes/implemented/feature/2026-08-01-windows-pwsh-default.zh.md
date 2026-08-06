# Agent Note: Windows 默认改用 pwsh

Status: implemented

[English](2026-08-01-windows-pwsh-default.md) | 中文

## 问题

harness 交付的执行画像在每个平台都是 bash 优先。Windows 主机必须安装 bash 垫片（WSL 或 Git-Bash），或退回到仅 POSIX 的 `dsh-bash-local` 行为（硬编码 `bash -c` argv、进程组语义）；面向模型的 bash 工具教的是 bash 方言。Windows 原生基础已随 [pwsh 执行器与工具决策](2026-08-01-pwsh-tool-and-executor.md) 交付——`ctx.bash` seam 的 PowerShell 实现与对等的 `pwsh` 工具——但交付组合在 Windows 上仍然挂载 bash 栈，没有垫片的 Windows 主机跑不了交付的 shell。

## 决策

启动交付 profile（`dsh web`、`dsh --profile headless`、一次性任务）的 Windows 主机默认获得 PowerShell 栈；POSIX 主机不变。

- **平台层是数据文件，不是清单重写。** `@deepseek-ai/dsh-base` 随通用 `cordis.patch.yml` 一起交付 [`windows.cordis.patch.yml`](../../../../packages/bundle/base/windows.cordis.patch.yml)：它禁用 `bash-sandbox`/`tool-bash`（仅 POSIX 的执行器及其方言工具）、禁用 `permission`/`ui-permission`（dsh-permission 要求有限权能力的执行器——preset 捆绑的是无限制 pwsh 执行器无法兑现的 sandbox 模式；见其构造函数守卫——客户端旋钮会宣传一个它无法强制执行的 shell），并插入 `pwsh-local`/`tool-pwsh`。fs 工具保留 sandbox 策略与批准服务，因此 Windows 上的文件限制与升级仍然生效。
- **启动器按平台注入该层。** `apps/cli/src/windows-shell.ts` 在 `win32` 主机上从 base bundle 层的 `packageDir` 解析它，置于 bundle 层与用户层之间，覆盖所有组合路径（启动、config-only HMR 重组合、配置转储）。覆盖交付默认是组合决策：偏好 bash 栈的 Windows 主机通过其 profile 或 home 的 `cordis.patch.yml` 重新启用 bash 行。未挂 base bundle 的自定义 profile 被跳过（它们自己拥有 shell 栈）；base bundle 缺 `windows.cordis.patch.yml` 时 fail loud。
- **冷启动的模块解析已恢复。** profiles 重构把 pwsh 包从 `apps/cli` 的依赖闭包中删掉了，`healProfilesModuleFallback` 因此从未把它们链接进 `$DSH_HOME/profiles/node_modules`，新 Windows 主机解析不到插入的行。`apps/cli` 与 `dsh-base` 重新声明 `dsh-pwsh-local`/`dsh-tool-pwsh`；按仓库惯例，base bundle 把每个行插件都列为依赖。

原路线图的阶段 2（pwsh GUI 渲染）已随 [pwsh UI 呈现与 bash 对齐决策](2026-08-05-pwsh-ui-bash-parity.md) 先行交付；[pwsh 工具与 bash 对齐决策](2026-08-02-pwsh-tool-bash-parity.md) 交付了工具表面。本决策不改变任何 POSIX 行为。

## 备选方案

**在 `dsh-bash-local` 内部让 Windows 默认 pwsh（一个执行器，方言开关）。** 否决，理由与执行器决策否决模式开关相同：执行器的身份就是它 spawn 的 shell，而按平台门控的组合是部署选择，不是执行器配置。

**从 `apps/cli` 代码而非 bundle 数据文件交付平台层。** 否决：patch 应放在它替换的行旁边、属于拥有这些行的 bundle，让交付清单作为组合数据保持可见、转储带有出处；启动器只贡献 win32 门控。

**在 Windows 上保留 `permission`/`ui-permission`。** 否决：`dsh-permission` 硬性要求 `ctx.bash.sandboxMode`，在无限制执行器上加载即 fail loud；让它容忍无限制 shell 会宣传 shell 无法兑现的 preset。文件限制继续经由 fs 栈生效。

**交付 `DSH_WINDOWS_SHELL` 环境变量逃生门。** 否决：决定性的行为变更应集中在组合配置中，而组合配置已能按行 id 覆盖平台层；第二条覆盖通道会分裂清单决策的单一事实来源。

## 后果

- 运行交付版 `dsh` 表面的 Windows 主机无需配置即获得 `pwsh` 作为 shell 工具、PowerShell 作为 `ctx.bash` 执行器；那里的模型可见清单中没有 `bash`（其工具行被禁用）。
- POSIX 主机不变：平台层永不生效，bash 栈仍是通用 `cordis.patch.yml` 的行。
- 偏好 bash 栈的 Windows 主机（例如 PATH 上有 WSL/Git-Bash 时）通过其 profile 或 home 的 `cordis.patch.yml` 覆盖交付默认——组合配置是唯一的覆盖通道。
- 权限切换器离开 Windows 清单；会话权限事实通过批准服务与 sandbox 策略固定组合默认值。

## 验证

- 单元：`apps/cli/tests/windows-shell.spec.ts` 固定 win32 默认、自定义 profile 跳过与缺文件失败，平台注入。
- Keyless：win32 上的 `dsh --profile <name> --dump-config` 显示带 `windows.cordis.patch.yml` 出处的 pwsh 行、被禁用的 bash 行；POSIX 转储（CI Linux）不变。
- 真实组合冒烟在 win32 上启动 web profile，pwsh 栈挂载成功（即本笔记描述的确切清单）。
