# @deepseek-ai/dsh-host-directory-picker-native

[English](README.md) | 中文

[目录选择 seam](../directory-picker/README.md) 的**原生 OS 选择器后端**：`NativeDirectoryPicker` 以 `native` 能力注册 `ctx.directoryPicker`，其 `pick(signal)` 每次调用打开一个原生选择器并解析出所选绝对路径（取消时为 `null`）。平台工具不经 shell 调用：macOS 使用 `osascript`，Windows 使用以 STA 模式运行的 PowerShell `FolderBrowserDialog`，Linux 使用 Zenity 并以 KDialog 回退；调用方的中止信号会终止原生进程。只有操作者坐在宿主屏幕前时才可用——远程部署应组合 [`-browse`](../directory-picker-browse/README.md)。命令边界（`DirectoryPickerRunner`）与平台事实可注入，便于确定性测试。共享的免 shell 子进程运行器位于 [`dsh-native-command`](../../util/native-command/README.md)。

**双面包**：browser half（`./client`）向 [ui-workspace](../../client/ui-workspace/README.md) 的两个目录流洞注册一个无渲染的流程占用者——每次 `open` 请求驱动 `host.pickDirectory`，并经洞的 owner 会话上报唯一结果（所选路径／取消／失败）。因此一行 cordis.yml 同时组合原生交互的两侧；client 侧不含任何能力 kind 分支，挂载第二个流程包会在加载期失败（洞为 `single` kind）。

## 模型体验

无。该后端服务于 GUI 宿主的目录选择；这里没有任何内容进入模型请求。

#### KV 缓存影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

- **Linux 依赖桌面工具**——Zenity 与 KDialog 均未安装时，`pick` 以包含解决建议的错误拒绝；它不会回退为手输路径提示（组合层面的回退是 browse 后端）。
