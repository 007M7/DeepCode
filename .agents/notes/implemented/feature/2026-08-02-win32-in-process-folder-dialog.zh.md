# Agent Note：Win32 文件夹选择器经 koffi 移入进程内

Status: implemented

[English](2026-08-02-win32-in-process-folder-dialog.md) | 中文

## 问题

Windows 目录选择器的主层此前是围绕 WinForms `FolderBrowserDialog` 的外部 PowerShell 脚本：只有恰好安装了 PowerShell 7 的机器才有现代对话框；review 指出的回归——PowerShell 6 可解析却没有 WinForms（退出码 1 而非 `ENOENT`，5.1 回退永远不会触发）；`SetProcessDPIAware` 只有系统 DPI 的上限；选择器的行为取决于机器装了哪些 shell，而不是取决于 Windows 本身。

## 决策

`packages/host/directory-picker-native` 现在经 koffi——它已是仓库其他 `win32.ts` 面的工作区依赖——在进程内打开 `IFileOpenDialog`（`FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR`），作为 win32 主层。COM 会话运行在 `worker_threads` worker 上，模态 `Show` 永不阻塞宿主事件循环；worker 在阻塞前上报其原生线程 id，driver 通过向该线程的窗口反复投递 `WM_CLOSE`（`EnumThreadWindows`）来服务中止，仅当关闭预算耗尽时才 terminate 并 unref worker（Node 无法打断原生调用，关不掉的 worker 决不能拖住进程退出）。worker 输入队列上的窗口默认只会被显示而不会被激活，因此 driver 还会在 worker 上报 `showing` 后把对话框抬升到前台——附加输入队列并调用 `SetForegroundWindow`，按关闭节奏重试直到 `Show` 内创建的窗口出现。worker 线程启用宿主接受的最佳线程 DPI 感知（`SetThreadDpiAwarenessContext`，按 per-monitor-v2 → per-monitor → system-aware 级联并检查返回值），严格优于脚本的系统 DPI 上限；DPI 保持为纯外观的 best-effort——全部不被接受的宿主仍得到现代对话框，而不会降级到回退链。模块切分让覆盖率在任何主机上都诚实：`win32-dialog-logic.ts`（纯时序）与 `win32-dialog.ts`（driver）在任何平台对假件测试；`win32-dialog-bindings.ts` 对 mock 的 `koffi` COM 世界测试（`dsh-session-persistence-jsonl` 的技法）；POSIX 主机把真实 spawn 管道跑到 koffi 加载失败的拒绝；win32 主机跑真实的"打开并中止关闭"冒烟。该冒烟位于 `processBoundTests`：threads 池下阻塞在原生模态中的 worker 会卡死池的收尾，fork 则能容纳它。PowerShell 链（见 [DPI note](../bug-fix/2026-08-01-windows-picker-pwsh-dpi.md)）保留为回退层，触发条件从 `ENOENT` 拓宽为 pwsh 的任何失败，同时关闭了 PowerShell 6 回归。

## 考虑过的替代方案

- **预编译原生助手（`native/` 家族，如 `node-addon-landlock-run`）。** 否决：镜像仓库、npm 包家族、MSVC 供给和发布交接——只为交付约 150 行 CI 无法执行的 C（没有真 Windows 通道）；koffi 以零新增供应链提供同一 COM 面。
- **N-API 进程内插件。** 否决：同样的 CI／工具链原因，另加需要自有 C++ 处理 STA 线程与消息泵，而 `worker_threads` + koffi 用 TypeScript 就能表达。
- **保留 PowerShell 为主层并探测版本。** 否决：选择器仍被 shell 打包形态挟持（6 与 7、Store 别名、profile），且没有 pwsh 的机器地板仍是 5.1 的旧版对话框；仅把回退触发条件的拓宽吸收进回退层。
- **在主线程上阻塞模态调用。** 直接否决：对话框打开期间 web 宿主必须继续服务 RPC。

## 后果

- 每台 Windows 机器都得到带其所支持的最佳 DPI 感知（1703+ 为 per-monitor-v2）的现代对话框，无论是否安装 PowerShell；PowerShell 层只服务 koffi 无法驱动 COM 的主机。
- 真实对话框渲染与选中路径仍是手动 Windows 检查（自动关闭冒烟证明打开／中止／收尾）；卡死的中止可能泄漏一个对话框线程直到进程退出，已记录于包 README。
- 所用 COM vtable 槽位与 GUID 是冻结的 Windows ABI（Vista 起）；koffi 签名错误是可能拖垮整个 Node 进程的原生崩溃风险——`worker_threads` 与主线程共享进程，访问冲突不会只局限在 worker 内，也不会进入 PowerShell 回退。mocked-koffi 的 ABI 钉与真实 win32 冒烟正是为了在交付前捕获这类错误。
- 打包二进制的 VFS 臂——在 pkg 快照内解析 `./worker.cjs`——不受任何自动化测试覆盖：源码 worker 与普通 Node 下构建出的 `lib/worker.cjs` 已被覆盖，VFS 专属的 spawn 推迟到 Windows CI 路线图。
