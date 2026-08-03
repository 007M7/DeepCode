# Agent Note: Windows 目录选择器优先 pwsh 并强制 DPI awareness

Status: implemented

[English](2026-08-01-windows-picker-pwsh-dpi.md) | 中文

## 问题

原生目录选择器的 Windows 分支原先启动 Windows PowerShell 5.1 的 `FolderBrowserDialog`，而 .NET Framework 将其硬编码为旧版 `SHBrowseForFolder` 树形对话框：没有地址栏、搜索或快速访问。同一进程又是 DPI-unaware 的（`powershell.exe` 未声明任何 DPI awareness），因此在缩放显示器上，Windows 会以 96 DPI 渲染该对话框再位图拉伸——文字模糊、边缘发虚。任何超过 100% 缩放的显示器上，两个缺陷同时可见。

## 决策

PowerShell 链现在是进程内 koffi 对话框之下的回退层（见[进程内文件夹对话框 Note](../feature/2026-08-02-win32-in-process-folder-dialog.md)）：win32 分支先启动 `pwsh.exe`（PowerShell 7），并在 pwsh 的任何失败上回退到 `powershell.exe`（Windows PowerShell 5.1）——可解析的 PowerShell 6 没有 WinForms，以退出码 1 而非 `ENOENT` 失败，而 5.1 每台 Windows 都自带。PowerShell 7 呈现现代资源管理器风格选择器，是因为 .NET Core 3.0 用 `IFileDialog` 重写了 `FolderBrowserDialog`（无条件生效；更晚的 `AutoUpgradeEnabled` 退出开关到 .NET 6 才加入，脚本从未设置它）。两个运行时执行完全相同的脚本，脚本在任何窗口存在前调用 `SetProcessDPIAware()`（user32），因此无论由哪个宿主服务，对话框都系统 DPI aware。脚本不设置 `Description`：现代 `FolderBrowserDialog` 会把它渲染成文件夹输入框上方的一条底带，5.1 经典对话框则渲染成未主题化的色块，因此该属性被整体移除。两个运行时都显式保留 `-STA`；回退维持 seam 的取消／失败契约（取消返回 `null`，其余为可重试错误）。宿主边界、RPC 信任与取消决策仍归[选择器功能 Note](../feature/2026-07-27-native-workspace-directory-picker.md)所有。

## 考虑过的替代方案

- **强制要求 PowerShell 7。** 否决：pwsh 并非 Windows 内置，没有它的机器将失去唯一的工作区创建路径；5.1 回退保持对话框可用，且 DPI 在那里同样被修正。
- **从 `dsh-pwsh-local` 导入 `resolvePwshPath`。** 本变更否决：host GUI 包依赖 bash 执行器包是跨 seam 耦合；PATH 上的 `execFile` 解析加 `ENOENT` 回退已覆盖实际安装形态（Program Files、Store 别名）；若两个消费者日后漂移，单一来源解析留作后续。
- **在 harness 进程内设置 DPI awareness。** 否决：DPI awareness 是进程级的，而对话框位于派生的子进程中，不会继承父进程缺失的声明。
- **Per-monitor v2（`SetProcessDpiAwarenessContext`）。** 暂缓：system-aware 是 .NET Framework WinForms 的上限，现代 Windows 中 shell 对话框自身处理 per-monitor 渲染，且一次调用让两个运行时共用一条代码路径。

## 后果

- 装有 PowerShell 7 的机器获得现代文件夹选择器；只有 5.1 的机器保留旧版树——但现在清晰了——包 README 的已知限制记录了该差距。
- PowerShell 链本身不新增任何包或依赖（koffi 与 tsx 随进程内主层引入，归属其 Note）；pwsh→5.1 的跳转在 pwsh 的任何非中止失败上触发——win32 路径上已不存在 `ENOENT` 分类——中止传播不变。
- 命令边界（`DirectoryPickerRunner`）在单元测试中固定启动顺序与脚本内容；真实对话框渲染仍与以前一样属于手动 Windows 检查。
