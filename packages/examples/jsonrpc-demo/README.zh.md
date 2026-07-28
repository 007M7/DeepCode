# @deepseek-ai/dsh-jsonrpc-demo

[English](README.md) | 中文

只包含 bin 的应用，启动外部 `cordis.yml`；其 [`jsonrpc`](../../ui/jsonrpc/README.md) 入口通过按换行分隔的 stdio 为 SDK 客户端提供服务。配置负责组合主干、后端和服务插件。`lib/bin.js` 也是[单文件可执行 runtime](../../../.agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md) 的入口。

## 配置发现

第一个非空通道生效：先 `$DSH_CORDIS_CONFIG`，再位置参数 `argv[2]`。如果二者都没有指向现有文件，bin 会向 stderr 打印单行用法并以 1 退出；没有工作目录回退或内置回退。[`dsh-app-boot`](../../ui/app-boot/README.md) 会使插件加载失败成为致命错误。此协议不使用 `DSH_SNAPSHOT`。

不含 `dsh-jsonrpc` 的配置仍然有效，只是不提供任何服务；bin 不会指定服务器插件。

## 退出生命周期

stdin EOF 和 `SIGTERM` 会将根上下文释放至静默并以 0 退出；`SIGINT` 完成同样的释放后以 130 退出。EOF 可能按[分发 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md) 所述截断正在处理的轮次。`jsonrpc` 插件拥有先响应再退出的协议关闭流程；两条路径均幂等，可以安全竞态。

## stdout 是协议

stdout 只承载 JSON-RPC 帧。bin 和启动守卫在 stderr 上输出诊断，配置必须省略 stdout logger。

## 模型体验

模型通过外部 `cordis.yml` 加载的插件间接获得体验；每个插件拥有自身面向模型的提示词、schema、消息和结果，此 bin 不添加任何内容。

#### KV Cache 影响

不会直接失效；具名消费方拥有请求前缀的任何变更。

## 已知限制与延后工作

- **bin 无法证明配置提供 JSON-RPC 服务**：不含 `dsh-jsonrpc` 条目的有效配置也能成功启动，但不会提供任何服务。
- **不存在内置或默认配置**：每次启动都必须提供 `DSH_CORDIS_CONFIG` 或位置路径；部署拥有完整插件树和 stdout 纪律。
- **stdin EOF 会截断正在处理的工作**：客户端消失时立即释放根上下文；需要有序完成的调用方应使用协议级 `shutdown` 请求。
