# Agent Note: Windows 默认改用 pwsh（路线图）

Status: proposed

[English](2026-08-01-windows-pwsh-default.md) | 中文

## 问题

harness 交付的执行画像在每个平台都是 bash 优先。Windows 主机必须安装 bash 垫片（WSL 或 Git-Bash），或退回到仅 POSIX 的 `dsh-bash-local` 行为；面向模型的 bash 工具教的是 bash 方言，TUI/Web 表面以 bash 形状的预期渲染终端输出。第一块 Windows 原生基础已随 [pwsh 执行器与工具决策](../../implemented/feature/2026-08-01-pwsh-tool-and-executor.md) 交付：`ctx.bash` seam 的 PowerShell 实现与对等的 `pwsh` 工具——但还没有任何东西让 Windows 主机默认使用它们。

## 提案

两个阶段，各自可独立交付。原阶段 2（bash 工具对等孪生）已随 [pwsh 工具与 bash 对齐决策](../../implemented/feature/2026-08-02-pwsh-tool-bash-parity.md) 交付：`tool-pwsh` 现在在前台与后台工作（减 sandbox 面）上镜像 `tool-bash`，通过 `dsh-bash-env` 共享 `DSH_*` 环境，并携带其组装表面的 keyless 应用快照。

1. **Windows 默认组合**——交付的 CLI 组合在 Windows 主机上挂载 `dsh-pwsh-local` 作为 `ctx.bash` 执行器、`dsh-tool-pwsh` 作为面向模型的 shell 工具（那里不挂载 bash），POSIX 主机保持 bash 栈。这是 `base.cordis.yml` 与 surface 覆盖层里按平台门控的组合/清单决策；它让交付的 Windows 体验端到端 PowerShell 原生。
2. **pwsh TUI/GUI 渲染**——TUI 与 Web 表面以 PowerShell 感知的呈现渲染 pwsh 输出（原生路径显示、`$env:` 实情），即 bash 终端卡片的对应物。这是终端/控制台渲染约定获得 PowerShell 孪生的地方。

各阶段刻意排序：先组合（Windows 用户无需选择即获得 PowerShell），再渲染。本提案不改变任何 POSIX 行为。

## 备选方案

**在 `dsh-bash-local` 内部让 Windows 默认 pwsh（一个执行器，方言开关）。** 否决，理由与执行器决策否决模式开关相同：执行器的身份就是它 spawn 的 shell，而按平台门控的组合是部署选择，不是执行器配置。

**把 Windows 默认与执行器/工具一起交付。** 否决：清单变更需要自己的证据（交付的 Windows 树停挂 bash 后什么会坏、哪些工具依赖 bash 语义），并且它属于带批准/PTY 表面可见的组合决策。

**用垫片在 Windows 上保留 bash，跳过 PowerShell 默认。** 否决：这延续了安装税与路线图要消除的方言错配；垫片是部署要求，不是产品行为。

## 验收标准

- 运行交付版 `dsh` TUI/Web 的 Windows 主机无需配置即获得 `pwsh` 作为其 shell 工具、PowerShell 作为 `ctx.bash` 执行器，且那里的模型可见清单中没有 `bash`。
- POSIX 主机逐字节不受影响（清单相同，执行器相同）。
- 交付组合 e2e 在两个平台族上断言按平台门控的清单。
- 阶段 1 落地时，parity 变更带来的 keyless pwsh 工具快照已经就位；阶段 2 附带 pwsh 输出的 TUI/Web 渲染快照落地。

## 风险

- **依赖 bash 的组合行**——任何假设 bash 语义的交付插件（执行 shell hooks 的 hooks 桥、工作区工具）必须按阶段审计；审计可能迫使分阶段推出而非一次切换。
- **Windows CI 覆盖缺口**——单元覆盖在 Linux 上运行；pwsh 栈里仅 Windows 的回归通过 Windows 构建/静态通道与 e2e 浮出，必须按阶段扩展而不是想当然。
- **渲染约定**——终端卡片的 PowerShell 孪生是带快照表面的 UI 设计决策；把它延期（阶段 2）让阶段 1 无需 UI 翻动即可交付。
