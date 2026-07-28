# @deepseek-ai/dsh-pty-e2b

[English](README.md) | 中文

用于 [`ctx.pty`](../../pty/pty/README.md) 的 E2B 字节 PTY 后端。它在共享的 `ctx.e2b` 沙箱内创建持久交互式 shell；PTY 注册表则在宿主侧维护会话身份、精确的 Agent 所有权和清理策略。

## 插件与配置

`pty-e2b` 插件注入 `e2b` 和 `pty`，然后以 `backendType` 注册一个后端。

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `backendType` | `shell` | `terminal_open` 选择的注册表类型。 |
| `rows` / `cols` | `40` / `160` | 远程 PTY 的初始尺寸。 |
| `scrollbackLines` | `10000` | 保留的逻辑行数上限。 |
| `scrollbackMaxBytes` | `4194304` | 保留的 UTF-8 scrollback 字节数上限。 |
| `maxReadBytes` | `262144` | 单次读取或发送结算时返回的字节数上限。 |
| `pollIntervalMs` | `50` | 宿主就绪轮询间隔。 |
| `idleSilenceMs` | `3000` | 触发 `inferred_idle` 的输出静默时长。 |
| `timeoutMs` | `30000` | 启动与发送等待的绝对上限。 |
| `disposeGraceMs` | `3000` | TERM 到 KILL 的清理宽限期。 |

数值必须是正的安全整数，`backendType` 必须非空，且 `maxReadBytes` 不得超过 `scrollbackMaxBytes`。相对的 spawn cwd 以 `ctx.e2b.cwd` 为基准解析；绝对远程路径保持不变。启动前，后端会枚举沙箱默认环境变量名，清空 `DSH_*` 和形似凭据的名称，再覆盖其受控终端值与显式 `spec.env` 条目。

## 运行时契约

该后端为 E2B 面向字节的 PTY 回调配备流式、遇到无效序列即失败的 UTF-8 解码器，随后使用 `dsh-pty` 提供的后端无关行清理器与有界缓冲区。它会安装受控的 Bash 提示符标记，并等待可打印的提示符文本；若该标记不可用，系统会在已经观察到输出且达到已配置的静默上限时得出 `inferred_idle`。零输出的启动过程会达到绝对超时并失败，不会发布空会话。

每次发送都会写入 UTF-8 字节，并可选写入回车提交序列。取消与显式信号会通过 `ps` 确定远程终端的前台进程组，再向该组发送信号；取消处理会在查找后重新检查原发送操作是否仍为当前操作，以免已结算的操作向后继操作发送信号或令其失败；发送 `SIGKILL` 时拒绝以 shell 本身为目标。后端会在启动时记录终端的 POSIX 会话 id。关闭操作会向该会话内仍存在的每个进程组发送 `SIGTERM`，对存活者升级为 `SIGKILL`，验证会话已经清空，并且直到 SDK 句柄报告退出才结算。如果启动失败，系统会关闭尚未发布的 PTY；若清理同时失败，`PtyBackendCleanupError` 会保留这项失败。

远程 PTY 进程及其子进程位于 E2B。提示符／就绪状态、scrollback、操作句柄、所有者权限和 SDK 事件交付仍保留在宿主内存中。

## 模型体验

### 间接消费方

#### 模型看到的内容

没有直接可见内容。模型通过 `@deepseek-ai/dsh-tool-pty` 可能收到有界的 MOTD、发送增量、scrollback 页、就绪原因、信号结果和清理失败。

#### Token 影响

消费方返回有界的后端输出前没有影响。本包不会把宿主保留的 PTY scrollback 放入模型历史。

#### KV Cache 影响

不会直接失效；提示词、schema 和追加结果由消费方负责。

## 已知限制与暂缓工作

- **面向行的终端模型**：CSI／OSC 控制序列会被移除；备用屏幕与完整终端仿真仍不受支持。
- **就绪判断基于标记或静默**：E2B 会公开前台进程组，但不提供本地后端使用的 Linux syscall 检查，因此系统有意保留返回 `inferred_idle` 的可能性。
- **仅支持 UTF-8**：无效字节序列会使会话失败，而不是返回有损文本。
- **主动逃离会话的进程不受管理**：调用 `setsid` 的进程会离开终端会话，因而不属于本后端的清理身份。
- **没有可重连的终端句柄**：保留 E2B 沙箱会保留远程文件，但不会保留宿主所有权、缓冲区、回调或实时 PTY 会话。
