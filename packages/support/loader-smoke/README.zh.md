# `@deepseek-ai/dsh-loader-smoke`

[English](README.md) | 中文

用于测试通过 Cordis Loader 启动应用和 `cordis.yml` 的共享子进程 harness。`resolveExampleLaunch` 选择本地 `src` mode（tsx 和根 tsconfig 路径）或 CI `lib` mode（普通 Node 和包导出）；选择依据为显式 mode 或 `DSH_EXAMPLE_MODE`。

`runLoaderSmoke` 接受 bin 和配置路径、可选的完整 bin 参数、环境覆盖、stdin、运行前设置和清理前检查。它负责隔离 cwd、DSH 主目录、诊断、deadline、终止、EOF 和清理；在零退出后返回两个流，失败时拒绝并携带两个流。

这是支持层测试基础设施，而非产品 API。

## 模型体验

无。该测试专用 harness 启动示例进程并检查它们的流，不会改变已组装模型请求。

#### KV 缓存影响

无；该包既不组装也不发送提供方请求。

## 已知限制与待完成工作

- **构建 mode 需要事先构建**：配置还必须能够通过 `examples/node_modules` 向上解析每个命名包。
- **捕获的 stdout 和 stderr 无界**：失控子进程可以消耗内存，直到 deadline 将其终止。
- **超时只终止直接子进程**：故障 fixture 生成的进程树可以比冒烟测试存活更久，需要外部清理。
