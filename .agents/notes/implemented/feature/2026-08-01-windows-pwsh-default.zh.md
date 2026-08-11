# Agent Note: Windows 默认改用 pwsh

Status: implemented

[English](2026-08-01-windows-pwsh-default.md) | 中文

## 问题

harness 交付的执行画像在每个平台都是 bash 优先。Windows 主机必须安装 bash 垫片（WSL 或 Git-Bash），或退回到仅 POSIX 的 `dsh-bash-local` 行为（硬编码 `bash -c` argv、进程组语义）；面向模型的 bash 工具教的是 bash 方言。Windows 原生基础已随 [pwsh 执行器与工具决策](2026-08-01-pwsh-tool-and-executor.md) 交付——`ctx.bash` seam 的 PowerShell 实现与对等的 `pwsh` 工具——但交付组合在 Windows 上仍然挂载 bash 栈，没有垫片的 Windows 主机跑不了交付的 shell。

## 决策

启动交付 profile（`dsh web`、`dsh --profile headless`、一次性任务）的 Windows 主机默认获得 PowerShell 栈；POSIX 主机不变。

- **平台层是数据文件，不是清单重写。** `@deepseek-ai/dsh-base` 随通用 `cordis.patch.yml` 一起交付 [`windows.cordis.patch.yml`](../../../../packages/bundle/base/windows.cordis.patch.yml)。它禁用仅限 POSIX 的 `bash-sandbox`/`tool-bash` 行，并插入 `pwsh-sandbox`/`tool-pwsh`。后续的 [Windows ACL 沙箱决策](2026-08-08-windows-acl-restricted-token-sandbox.md)填充了 win32 runner 链，并取代了本笔记最初的不限权清单：`sandbox`、`sandbox-policy`、`fs-sandbox`、`permission`/`ui-permission` 与 `approval` 均与 POSIX 上一样保持启用，而 ACL 后端则如实把 Everyone 与硬链接缺口报告为部分强制执行。
- **启动器按平台注入该层。** `apps/cli/src/windows-shell.ts` 在 `win32` 主机上从 base bundle 层的 `packageDir` 解析它，置于 bundle 层与用户层之间，覆盖所有组合路径（启动、config-only HMR 重组合、配置转储）。覆盖交付默认是组合决策：偏好 bash 栈的 Windows 主机通过其 profile 或 home 的 `cordis.patch.yml` 重新启用 bash 行，并禁用两个 pwsh 行。未挂 base bundle 的自定义 profile 被跳过（它们自己拥有 shell 栈）；base bundle 缺 `windows.cordis.patch.yml` 时 fail loud。
- **冷启动的模块解析已恢复。** profiles 重构把 pwsh 包从 `apps/cli` 的依赖闭包中删掉了，`healProfilesModuleFallback` 因此从未把它们链接进 `$DSH_HOME/profiles/node_modules`，新 Windows 主机解析不到插入的行。`apps/cli` 与 `dsh-base` 声明 `dsh-pwsh-sandbox`/`dsh-tool-pwsh`；执行器的依赖链提供 `dsh-pwsh-local`，按仓库惯例，base bundle 把每个行插件都列为依赖。

pwsh GUI 渲染已随 [pwsh UI 呈现与 bash 对齐决策](2026-08-05-pwsh-ui-bash-parity.md) 先行交付；[pwsh 工具与 bash 对齐决策](2026-08-02-pwsh-tool-bash-parity.md) 交付了工具表面。本决策不改变任何 POSIX 行为。

## 备选方案

**在 `dsh-bash-local` 内部让 Windows 默认 pwsh（一个执行器，方言开关）。** 否决，理由与执行器决策否决模式开关相同：执行器的身份就是它 spawn 的 shell，而按平台门控的组合是部署选择，不是执行器配置。

**从 `apps/cli` 代码而非 bundle 数据文件交付平台层。** 否决：patch 应放在它替换的行旁边、属于拥有这些行的 bundle，让交付清单作为组合数据保持可见、转储带有出处；启动器只贡献 win32 门控。

**在 Windows 没有隔离 runner 时保留 `permission`/`ui-permission`。** 最初交付时否决：`dsh-permission` 硬性要求 `ctx.bash.sandboxMode`，并在不限权执行器上加载时 fail loud。后续的 ACL runner 消除了该前提，因此当前清单保留这两行。

**在 Windows 没有 OS runner 时保留 fs 路径规则限制。** 最初交付时否决：不限权 shell 可以绕过仅限 fs 的路径规则。当前 ACL runner 用同一策略约束 shell 与 fs 提供方，因此这项被否决的半边界已不是当前交付形态。

**交付 `DSH_WINDOWS_SHELL` 环境变量逃生门。** 否决：决定性的行为变更应集中在组合配置中，而组合配置已能按行 id 覆盖平台层；第二条覆盖通道会分裂清单决策的单一事实来源。

## 后果

- 运行交付版 `dsh` 表面的 Windows 主机无需配置即获得 `pwsh` 作为 shell 工具、PowerShell 作为 `ctx.bash` 执行器；那里的模型可见清单中没有 `bash`（其工具行被禁用）。
- Windows 命令与 fs 操作共用沙箱策略、权限切换器和 approval 服务。ACL runner 限制写入，但报告 `enforcement: 'partial'`；显式的 `danger-full-access` 仍是获准的绕过方式，而非平台默认。
- POSIX 主机不变：平台层永不生效，bash 栈仍是通用 `cordis.patch.yml` 的行。
- 偏好 bash 栈的 Windows 主机（例如 PATH 上有 WSL/Git-Bash 时）通过其 profile 或 home 的 `cordis.patch.yml` 覆盖交付默认——禁用 `pwsh-sandbox`/`tool-pwsh` 并重新启用 `bash-sandbox`/`tool-bash`（两个执行器注册同一个 `bash` 服务，配方不完整会在加载时 fail loud）——组合配置是唯一的覆盖通道。

## 验证

- 单元：`apps/cli/tests/windows-shell.spec.ts` 固定 win32 默认、自定义 profile 跳过、缺少 patch 时失败、冷启动依赖闭包和真实组合清单；`packages/bundle/base/tests/base.spec.ts` 固定 Windows 层仅禁用 bash 行、插入受限的 pwsh 行，并且不改变沙箱、权限、fs 与审批的归属。
- Keyless：win32 上的 `dsh --profile <name> --dump-config` 显示带 `windows.cordis.patch.yml` 出处的 pwsh 行、被禁用的 bash 行；POSIX 转储（CI Linux）不变。
- 真实组合冒烟在 win32 上启动 web profile，pwsh 栈挂载成功（即本笔记描述的确切清单）。
