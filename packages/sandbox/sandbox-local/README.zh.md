# @deepseek-ai/dsh-sandbox-local

[English](README.md) | 中文

[`dsh-sandbox`](../sandbox/) seam 的本地实现。它选择并缓存一个平台 runner：Linux 优先选择可工作的 `bwrap`，否则选择 Landlock；macOS 使用 Seatbelt。多个候选项会按顺序探测，只有一个候选项时则直接选择。

包根导出默认及命名的 `LocalSandboxProvider` 插件、`Config` 和公共测试注入 seam；平台 profile builder 保持内部状态。

不受支持的平台和不可用 runner 会以 `SANDBOX_UNAVAILABLE` 快速失败；执行绝不会静默回退为不受限制。每次包装都携带 runner 失败签名，使消费方能够区分损坏的沙箱与命令失败。[沙箱 Agent Note](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.md)拥有选择原理与 profile 差异。

策略逐调用传入；提供方只存储机制与缓存的 runner 结论。每次包装都会报告强制执行完整度，以及后端专用的拒绝和 runner 失败签名。`runnerCommand` 是操作方对 bwrap 形状 runner 的断言，会跳过探测；但命令缺失或不可执行时，执行仍会快速失败。由于其机制未知，它会同时携带两种 Linux 拒绝方言。`probeTimeoutMs` 限制功能探测。[沙箱 Agent Note](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.md)拥有选择与失败语义。

Seatbelt profile 默认允许，但带 `(deny file-write*)` 和写入 allow-list，因此恰好治理对应模式承诺的文件 effect：`read-only` 只授予 `/dev/null` 字面路径；`workspace-write` 另加 Workspace 根、`/tmp` 和逐用户 darwin 临时目录（`os.tmpdir()`，即平台供 mkstemp 家族工具使用的真实临时区域）。每个根都经过规范化，因为 Seatbelt 匹配解析后的路径（`/tmp` 就是 `/private/tmp`）。Apple 将 `sandbox-exec` CLI 标为 deprecated，但每个 macOS 仍会提供它；若情况发生变化，功能探测会快速失败。

[`node-addon-landlock-run`](https://www.npmjs.com/package/node-addon-landlock-run)提供平台 launcher、功能探测和 CLI 参数词汇。该提供方只拥有模式到授权的映射与 runner 选择。把路径解析和探测解析保留在带版本的 binary 中，可防止契约漂移。

每个阶梯都有会自行跳过的无密钥 world-effect 测试；CI 在真实内核上运行平台 job，并拒绝所有测试静默跳过。打包安装测试通过纯 Node 消费方运行 registry launcher 与可执行模式。

```yaml
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
```

消费方：[`@deepseek-ai/dsh-bash-sandbox`](../../bash/bash-sandbox/)；可运行的默认组合见 [acp-agent 示例](../../../examples/acp-agent/)。

## 模型体验

通过 [`dsh-bash-sandbox`](../../bash/bash-sandbox/README.md) 和 [`dsh-tool-bash`](../../bash/tool-bash/README.md) 间接影响；它们渲染该提供方的强制执行与拒绝事实，而 [`dsh-sandbox`](../sandbox/README.md) seam 拥有 `SANDBOX_UNAVAILABLE` 文本，runner 选择与 profile 则不进入上下文。

#### KV Cache 影响

不会直接失效；请求前缀变更由命名消费方负责。

## 已知限制与暂缓事项

- **Windows 没有 runner**：`win32` 以 `SANDBOX_UNAVAILABLE` 快速失败；AppContainer 家族后端暂缓实现。
- **Landlock 可能只实现部分强制执行**：较旧且受支持的内核 ABI 只能限制自身公开的访问类别，因此报告 `enforcement: 'partial'`，不会夸大为完整强制执行。
- **Seatbelt 依赖 deprecated 的 `sandbox-exec`**：macOS 仍会提供它，但若 Apple 移除该私有策略引擎，该提供方无法替换或探测。
- **runner 选择在提供方生命周期内缓存**：安装、移除或修复 runner 后，必须重载插件才能改变选择。
- **`runnerCommand` 是操作方断言**：配置的自定义 runner 会跳过功能探测，并假定它诚实实现 bwrap 形状 profile。
