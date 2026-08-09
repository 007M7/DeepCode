# Agent Note: Wine 与原生 Windows 双通道拉取请求 CI

Status: implemented

[English](2026-08-08-native-windows-pull-request-ci.md) | 中文

## 问题

拉取请求必需的 Windows 判定既需要快速的 win32 工具链信号，也不能让聚合流程等待稀缺的 Windows 容量。Wine 通道提供这项关键路径信号，但它运行在 Linux 内核与区分大小写的 ext4 之上，要求采用 hoisted 依赖布局和由宿主侧创建的符号链接，且无法证明 NTFS、DACL、ConPTY、崩溃持久性或原生进程行为。原生串行参考流程停用期间，即使真实 Windows 内核结果不属于分支保护，常规 CI 也需要针对每个拉取请求分支头自动产出该结果。

## 决策

[ci.yml](../../../../.github/workflows/ci.yml) 中必需的 `windows` 作业仍是在 `ubuntu-latest` 上运行的 `windows node 24 / wine blocking`。它保留经过校验和验证的 Windows Node、Wine apt 与 pnpm 缓存、仅限工作区快照的 hoisted 安装，以及运行工作区构建与生产网站的[共享 Wine 门禁脚本](../../../../scripts/wine-windows-gates.sh)。Node 分发文件传输采用有界重试；nodejs.org 的大文件传输停滞时，由支持范围请求的传输镜像续传相同字节，但版本和 SHA-256 权威仍属于 nodejs.org，归档通过该校验前绝不会投入使用。稳定的 `windows` 作业 ID 仍是 `all checks passed` 的依赖项。[已归档的 Wine 实验](../../archived/process/2026-07-27-wine-windows-gates-experiment.md)保留其实测取舍，而本文负责当前双通道拓扑。

每个拉取请求还会在 GitHub 标准 `windows-2025` 镜像上启动一个独立的 `windows-native` 作业，名称为 `windows node 24 / native complete`。该作业为工作区符号链接启用开发人员模式，通过 `pnpm/action-setup` 提供仓库固定版本的 pnpm，在不传输 store 归档的情况下执行不可变安装，并在原生 PowerShell 下运行 `pnpm run check:ci:windows-complete`。该作业被刻意排除在 `all-checks-passed.needs` 之外：聚合流程既不等待它，也不会因它改变结论；原生作业则保留自身未被掩盖的成功或失败结果。

原生门禁在其自身作业内继续将工作区构建与生产网站故障设为阻断项，同时将更广泛的静态检查、文档、包和构建产物可移植性清单作为观测项报告。同一台运行器在这些门禁之间共享安装结果与构建输出，串行门禁与 publint 工作线程上限使标准镜像的资源使用保持在可预测范围内。在这些套件明确建立原生 Windows 契约之前，重复执行的 lint、覆盖率与快照强制检查仍由 Linux 负责。

首次原生运行暴露出两项被兼容性通道掩盖的故障。文档投影测试此前只按 `/` 拆分来派生图片 basename；现在改为使用 Node 根据平台计算的 basename。Chokidar 消费方收到的 `%TEMP%` 以 `C:\\Users\\RUNNER~1` 这个 8.3 别名表示，而 libuv 返回的是长目录名，导致其 Windows 事件路径断言失败。共享的设置 watcher 与凭据 watcher，以及 Cordis 的模块 HMR（热模块替换）与精确配置 HMR，现在都会在打开 watcher 前规范化现有的原生监听基准路径或层级最深的现有祖先路径，并保留尚不存在的后缀；文件访问和诊断仍使用配置路径。模块 HMR 会挂接监听器并等待主 watcher 的 ready 事件，之后插件启动才会完成，因此启动后立即发生的编辑无法与初始扫描形成竞态。

下一次分支头精确运行暴露出观测项中剩余的一项 built-bin 故障：其生命周期 fixture（测试前置数据）通过 `process.kill()` 或 `subprocess.kill()` 发送 `SIGTERM`；在 Windows 上，这种调用会无条件终止目标进程，而不会交付为优雅释放所注册的进程事件。POSIX 验收仍发送真实信号。在 Windows 上，fixture 改为从子进程内部请求同一个已注册事件：自终止探测直接请求，由父进程控制的生命周期场景则通过标记请求；因此，完整组装后的关闭与释放路径仍得到覆盖，也无需断言操作系统提供了本不存在的信号机制。该项验收随即暴露出底层的提前关闭竞态：boot 返回后，回退 HMR watcher 仍在挂载，此时信号可能对根 fiber 执行 dispose（资源释放），由此产生的服务未激活错误会逸出并被报告为 boot 失败。boot 后 setup 现在只会在权威根 fiber 仍处于活跃状态时接纳工作；只有当本次调用所记录的信号已取得关闭流程所有权时，才会隔离并发 setup 错误，无关的 HMR 故障仍会响亮失败。

## 曾考虑的替代方案

**让原生 Windows 成为 `all checks passed` 的依赖项。** 这会为聚合流程提供保真度最高的 Windows 判定，但也会让每次合并等待最长的托管作业与 Windows 容量。独立结果能让该信号保持自动产生，而不改变现有必需路径。

**只在拉取请求上运行 Wine。** Wine 能快速触达阻断性的 win32 工具链分支，但即使真实 NT、NTFS、PowerShell、进程或原生插件契约已经损坏，也可能报告绿灯。

**将原生作业标记为 `continue-on-error`。** 门禁失败后，该设置会让其检查显示为成功。保留普通独立作业可维持诊断结论；仅从聚合流程的 `needs` 中省略它，才是不阻断的机制。

**只在合并后运行原生 Windows。** 合并后的参考流程只能在可移植性回归进入 `master` 后进行诊断；它无法向评审者提供分支头精确的原生结果。

**使用组织自有的大型 Windows 运行器。** 更大规格的运行器镜像可以缩短墙钟时间，但诊断路径将因此依赖仓库外部的运行器标签与分配能力。标准 `windows-2025` 具备可移植性；大型运行器仍作为基准测试目标。

## 后果

Wine 保留必需聚合流程现有的关键路径和作业身份。`all checks passed` 变绿时，原生 Windows 仍可能处于待处理或红灯状态，因此分支保护采用 Wine 结果，而评审者和后续自动化采用独立的原生结果。

尽管如此，每个拉取请求都会获得来自真实 NT 内核、NTFS、PowerShell、Windows 进程和原生插件的信号。原生作业比 Wine 更慢，并重复执行设置流程和两项阻断构建，但它也会运行那份可移植性清单；兼容性通道隐藏的路径、watcher 与生命周期缺陷正是由该清单暴露。

维护者必须保留两种有意设计的执行拓扑：Wine 快照使用 Linux 安装加 hoisted 布局来触达 win32 二进制文件，而原生作业在 Windows 上使用不可变工作区。任一作业独有的失败都必须依据该边界分类，不得削弱或静默跳过。
