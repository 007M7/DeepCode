# @deepseek-ai/dsh-subagent-subprocess

[English](README.md) | 中文

用于**进程外 subagent 后端** 的共享机制：这类提供方会把外部 agent（智能体）作为子进程派生，例如 [ACP 后端](../subagent-acp/README.md)。这是纯库（无提供方、无注册、无 Config），提供所有「派生 CLI 子进程」后端都需要的机制：阻止父级部署凭据进入子进程、把子进程清理至完全停稳，以及将子进程与宿主用户的磁盘 CLI 状态隔离。设计理由见 [Claude Code / Codex subagent 后端 Agent Note](../../../.agents/notes/proposed/feature/2026-07-07-claude-code-and-codex-subagent-backends.md)。

每个可调项都是**参数**：dispose（资源释放）阶梯每次调用时接收宽限时间，配置目录辅助函数接收可选的固定路径。默认值位于各个消费插件的 Config 中（带默认值且经过校验的字段，可从 `cordis.yml` 修改），绝不位于本库。

## 导出内容

### `buildChildEnv(extra)`

凭据环境变量清理采用与 [bash 执行器](../../bash/bash-local/README.md)相同的模式：子进程环境等于环境继承值移除名称形似凭据的变量（`/KEY|SECRET|TOKEN/i`）后，再把 `extra` 叠加到清理结果之后。`PATH`、`HOME`、`TMPDIR`、locale 和代理变量会保留，使子 CLI 正常运行；父级自身的秘密绝不会隐式泄漏，而显式提供的凭据（后端 `env` 配置中子进程自己的密钥）仍会传给子进程。

### `spawnFailure(child)`

派生失败捕获：返回一个 promise，它会以子进程的第一个 `error` 事件兑现（绝不拒绝）。`ENOENT` 等派生失败是事件而非抛出的异常；没有监听器时 Node 会使父进程崩溃。因此，请在调用 `spawn()` 的同一个 tick 内调用此函数，并在运行结果路径中将其纳入竞速；错误命令随后会作为普通的子进程级失败结算。对于正常派生的子进程，该 promise 永不结算。

### `disposeChildProcess(child, graces)`

平台感知的 dispose 阶梯只会在子进程确实退出后兑现：达到完全停稳，而不只是发出请求（见[防御性模式](../../../docs/defensive-patterns.md)）：

1. stdin EOF（如果 stdin 已建立管道），然后等待 `graces.disposeEofGraceMs`：可协作的子进程自行完全停稳，同时保留其 flush 与嵌套子进程清理；
2. 在 POSIX 上发送 `SIGTERM`，然后等待 `graces.disposeGraceMs`；
3. 强制终止：POSIX 使用 `SIGKILL`，Windows 使用 Node 映射的 `TerminateProcess`；然后最多等待 `graces.disposeGraceMs` 以确认退出。信号错误或未退出会导致 dispose 拒绝。

两个宽限时间（`DisposeLadderGraces`）来自消费插件的 `disposeEofGraceMs`/`disposeGraceMs` Config 字段。POSIX 在优雅信号和强制信号之后都使用 `disposeGraceMs`；Windows 跳过冗余的优雅信号，但用该值限定强制退出确认时间。EOF 窗口有意独立设置且通常更宽，因为协作式清理可能要等待捕获信号的孙进程和最后一次 flush。

退出等待逻辑位于该阶梯内部。无论结算结果如何，它们都会清理自己的 timer 和监听器，因此升级过程不会在子进程上累积监听器。

### `createIsolatedConfigDir(prefix, pinnedPath?)`

为外部 CLI 子进程创建每次运行独立的隔离配置目录（`CLAUDE_CONFIG_DIR` / `CODEX_HOME` 式重定向的目标），使子进程行为只取决于部署配置，绝不取决于宿主上任何 `~/.claude` / `~/.codex` 式状态。返回一个 `IsolatedConfigDir` 句柄：`path` 写入子进程环境，`remove()` 在 dispose 时运行。

- **全新（默认）**：OS 临时根目录下的私有（0700）`mkdtemp` 目录；`remove()` 会尽力删除它，且绝不拒绝（留下临时目录胜过 dispose 失败），并且是幂等的。
- **固定**（设置 `pinnedPath`）：原样返回该路径，绝不创建、绝不移除。通过固定目录在运行间共享子进程状态的部署负责该目录的生命周期。

## 测试

`tests/subagent-subprocess.spec.ts`：环境变量清理和配置目录辅助函数使用真实进程环境与真实文件系统运行（rm 失败路径在 fs 边界注入拒绝，因为真实递归 rm 失败无法跨平台稳定触发，而且 root 会忽略权限位）；退出等待和平台终止路径使用可脚本化的假子进程。[ACP 后端测试套件](../subagent-acp/README.md)会针对真实子进程端到端执行这些机制。

## 模型体验

通过基于进程的 subagent 后端间接产生影响；这些后端的子进程组合受凭据清理和隔离配置目录约束。

#### KV Cache 影响

不会直接使缓存失效；具名消费方负责请求前缀的任何变化。

## 已知限制与延期工作

- **凭据清理基于名称**：只移除匹配 `KEY` / `SECRET` / `TOKEN` 的变量；除非后端提供更严格的环境，否则 `PASSWORD` 等名称不同的秘密仍会传入。
- **信号只针对直接子进程**：清理依赖可协作的 CLI 在退出前回收其后代；重新托管或独立脱离的孙进程可能比该阶梯存活更久。
- **全新配置目录的清理是尽力而为**：`rm` 失败时会在 OS 临时根目录下留下私有状态，而不会使 dispose 失败。
- **固定配置目录完全由操作方负责**：辅助函数既不创建、校验、锁定，也不移除这些目录，因此并发运行可能共享该状态并发生竞态。
