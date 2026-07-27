# Agent Note: 在 Linux runner 上用 Wine 运行 Windows 阻断门禁

Status: proposed

[English](2026-07-27-wine-windows-gates-experiment.md) | 中文

## 问题

Pull request 的 Windows 通道存在的意义是证明两个阻断性 win32 表面——workspace 构建与生产站点——外加一份观察性可移植性清单，它运行在一个专用的付费 Windows larger-runner 池上；master 串行参照又增加一个托管 Windows 作业。该池是这条流水线中唯一需要 Windows VM 的理由，而其供给、计价与缓慢的准备阶段主导了该通道的成本。

悬而未决的问题是：一台普通 Linux runner 能否为阻断表面产出等效的 win32 信号，让专用 Windows 池收缩为仅 master 的参照、甚至完全退出 pull request 路径？

## 提案

[exp-wine-windows.yml](../../../../.github/workflows/exp-wine-windows.yml)（自身路径过滤，外加手动触发）在 `ubuntu-latest` 上通过 Wine 用真实 Windows 二进制运行阻断门禁命令：校验和验证过的 win-x64 Node.js 执行 `tsc -b`、`tsdown` 与 VitePress 生产构建，因此工具链的 win32 分支——反斜杠路径处理、`CreateProcess` 派生语义、`@esbuild/win32-x64` 的 PE 加载、以及 rolldown/rollup 的 MSVC `.node` 插件——都真正执行。

依赖在 Linux 上原生安装，`supportedArchitectures` 扩展到 win32-x64，使 Windows 平台包物化进同一个 store；通过直接调用各工具的 JavaScript 入口绕开 cmd-shim 层，这正是 `run-gates` 最终派生的那些进程。`nodeLinker: hoisted` 是承重的，不是风格问题：[PR #689](https://github.com/deepseek-harness/deepseek-harness/pull/689) 的独立原型保留了 pnpm 默认的 isolated 布局——包括在 Linux 预取的 store 上忠实地用 Windows pnpm 离线重装——而 Wine 下的 Windows Node 依然无法穿过 isolated 符号链接链解析 `@esbuild/win32-x64` 或加载 koffi 预编译产物，在任何仓库门禁运行前就失败了。扁平的真实文件布局才让门禁变得可达；本通道采纳了 #689 的校验和固定，同时明确放弃其"Windows pnpm 安装依赖树"的目标（安装契约在此仍由 Linux 侧验证）。

该通道以 Linux CI 作业的墙钟（约两分钟）为目标，靠四个杠杆：master 刷新的 pnpm store 缓存（只恢复，与 ci.yml 同键）、Wine 供给（apt 安装、Windows Node 下载、`wineboot`）与 `pnpm install` 并发运行、两个阻断表面并发运行——与 `run-gates` 在原生 Windows 上给它们的形状相同——以及按 runner 镜像为键的 apt 归档缓存，使 Wine 的包下载每个镜像版本只付一次。

2026-07-27 实测：热缓存 pull request 运行端到端 2 分 46 秒（准备与缓存恢复约 17 秒，并发安装+供给 33 秒，并发门禁 110 秒），对照 Linux CI 作业的 1.5–2.5 分钟与付费 Windows 通道的 7–9 分钟；冷缓存约多付一分钟。8 核基准腿从未离开队列——受限的 `dsh-ubuntu-*` 池在兄弟 KVM 实验中也被观察到无限排队——因此标准 runner 的数字即为结果，达标不需要更大的机器。

这刻意是一次保真度探针，而非直接替换：Wine 在大小写敏感的 ext4 之上重实现 Win32 API（默认不模拟 NTFS 的大小写不敏感）、不提供 ConPTY、并用自己的安全描述符与 `MoveFileExW` 语义替代——恰是本仓库 `win32.ts` 模块与 PTY 后端关心的表面。实验度量哪些阻断门禁通过、哪些因 Wine 原因而非产品原因失败，以及相对已记录 Windows 基准通道的墙钟成本。

若结论为正则晋升：把 Wine 通道并入为 pull request 的阻断门禁 Windows 信号，将真实 Windows 池降级为 master 串行参照；否则在此记录失败类别并保留该池。

## 考虑过的替代方案

**保留专用 Windows 池（现状）。** 它正是被计价的基线；其信号没有问题，问题只在于为一个阻断表面仅是两条构建命令的 Windows VM 池付费。

**在 Linux runner 内用 QEMU/KVM 跑完整 Windows 客户机。** 真实 NT 内核，保真度完整，包括大小写不敏感的 NTFS 与 ConPTY——但首个门禁运行前要花数十分钟下载镜像并做无人值守安装。作为兄弟实验分支 `exp/kvm-windows-ci` 探索；两个实验共同为保真度与延迟定价。

**在 Wine 下由 Windows pnpm 执行安装（[PR #689](https://github.com/deepseek-harness/deepseek-harness/pull/689)）。** 同一想法的更高保真度变体：把 MinGit 与 pnpm 放进 prefix，用 Linux 预取填充 store，再由 Windows Node 运行 `pnpm install --offline`，让安装契约本身以 win32 身份执行。它到达了安装但没到达门禁——Wine 的网络无法直接访问 registry，且 isolated 的 `node_modules` 布局即便在干净的离线安装后也挫败了 Windows 平台包的解析。本通道用掉这份保真度（hoisted 布局、Linux 侧安装）来换取门禁可达；两份记录是同一裁决互补的两半。

**Linux 上的文件系统语义通道（casefold ext4、文件名 lint）。** 以近零成本捕获最高频的 Windows 破坏类别，但对 win32 二进制什么也证明不了。作为兄弟实验分支 `exp/casefold-windows-ci` 探索。

**Windows 容器。** 不可行：Windows 容器要求 Windows 宿主内核；托管 Linux runner 无法运行。

**砍掉 Windows 通道。** 已否决——win32 是一等产品目标：基于 koffi 的 DACL 与持久命名空间模块、基于 ConPTY 的 PTY 会话、以及 Windows 路径策略都随 `packages/` 交付。

## 验收标准

- 该 workflow 在 `ubuntu-latest` 上完成，对每个阻断表面（构建、生产站点）给出独立的通过/失败裁决，并记录与付费 Windows 通道及 Linux CI 作业两者的墙钟对比。
- 端到端墙钟落在 Linux CI 作业的同一档位（分钟级，而非数十分钟），从成本与信号两方面共同论证替换池的理由。
- 在此记录一项决定：晋升该通道、保留为非阻断金丝雀、或以观察到的失败类别否决。

## 风险

- 假绿：Wine 的大小写敏感文件系统与宽松路径处理可能放过在真实 NTFS 上会坏的代码，因此该通道可以补充、但永远无法完全替代发布资格所需的真实内核检查。
- 假红：Wine 下缺失或桩化的 Win32 API 会因非产品原因让门禁失败，每次此类失败都要花分诊时间归类。
- 吞吐：Wine 的系统调用翻译在 2 核标准 runner 上可能让阻断门禁的墙钟超过付费 Windows 通道，抹掉成本论点；无论结果如何，运行都会记录数字。
