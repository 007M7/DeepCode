# dsh-native-command

[English](README.md) | 中文

宿主原生 OS 集成共享的**零依赖免 shell `execFile` 运行器**：一次 `runNativeCommand(command, args, signal)` 调用直接派生可执行文件（绝不拼 shell 字符串），以 utf8 捕获 stdout/stderr，把调用方的 abort 传播为子进程终止，并在 Windows 上隐藏瞬时控制台窗口。失败时以附带退出 `code` 与两路已捕获输出的错误拒绝，调用方无需重跑即可分类（工具缺失、已取消、真实失败）。

它的两个消费者都是宿主侧原生集成：[`directory-picker-native`](../../host/directory-picker-native/README.md) 后端的 OS 选择器命令，以及网关的按默认应用打开转交（[`dsh-host-apiproxy`](../../host/apiproxy/README.md) 的 `host.openPath`）。`NativeCommandRunner` 类型是这些调用方为确定性测试暴露的可注入命令边界。

它是**库，不是服务或插件**：没有 `ctx`、不注册任何东西、不持有状态、不发事件。

## Surface

```ts
import { runNativeCommand, type NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
```

## Model Experience

无；这是宿主侧子进程管道，这里没有任何东西进入模型请求。

#### KV Cache effect

无；该包既不组装也不发送 provider 请求。

## Known Limitations and Deferred Work

- **不做输出限量**——两路流在内存中无界缓冲；当前每个调用方只运行输出为一个路径或一行错误的小型原生工具。把它指向输出量可观的命令之前，先接入 `dsh-retention` 限量。
