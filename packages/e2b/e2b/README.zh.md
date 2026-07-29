# @deepseek-ai/dsh-e2b

[English](README.md) | 中文

一个 E2B 沙箱的共享生命周期所有者。文件系统与进程管理适配器注入 `ctx.e2b`，等待其唯一的 SDK 句柄，因此处于同一个远程 Linux 工作树与进程环境中。本包固定使用 `e2b@2.29.1`；可选组合见[包族索引](../README.md)。

## 配置

```yaml
- id: e2b
  name: '@deepseek-ai/dsh-e2b'
  config:
    cwd: /home/user/workspace
    timeoutMs: 300000
    onTimeout: pause
    onDispose: kill

- id: subprocess-e2b
  name: '@deepseek-ai/dsh-subprocess-e2b'

- id: fs-e2b
  name: '@deepseek-ai/dsh-fs-e2b'
```

`apiKey` 可省略；省略时读取 `E2B_API_KEY`。该密钥只配置宿主 SDK 连接，绝不会安装进沙箱。`cwd` 默认为 `/home/user/workspace`，并且必须是绝对 POSIX 路径。`timeoutMs` 默认为 5 分钟。`onTimeout` 默认为 `pause`，接受 `pause | kill`；它只在本服务创建沙箱时生效。超时时 pause 会启用 E2B 自动恢复，使共享 SDK 句柄在下一次操作时唤醒。`onDispose` 默认为 `kill`，接受 `kill | pause | leave`。

设置 `sandboxId` 可重新连接正在运行或已经暂停的沙箱，而不是创建新沙箱。连接时，E2B 会恢复已经暂停的沙箱；`template` 仅用于创建，不能与 `sandboxId` 同时使用。省略 `template` 时使用 E2B 的默认基础模板。

## 生命周期与所有权

构造阶段会启动一次 create/connect 操作。服务在 `getSandbox()` 结算前创建 `cwd` 和私有的 `cwd/.dsh-e2b` 适配器状态目录，验证该预留路径是真实目录而非符号链接或其他文件类型，再把该目录的 mode 设为 `0700`。每个适配器内部的 E2B 命令 shell 都会获得一个位于根目录下、全新随机生成的 `HOME`，因此 SDK 固定使用的登录 shell 不会在控制命令之前解析可变用户主目录中的配置文件。初始化完成后，`sandboxId` 会结算为品牌类型 `E2BSandboxId`。

资源释放会先阻止继续获取新句柄，再等待初始化完成，并且只应用一种已配置的处置方式。`SandboxNotFoundError` 仅在资源释放请求 `kill`，或本服务创建了配置为 `onTimeout: kill` 的沙箱时才可接受；否则，`pause` 请求返回的未找到错误会导致 teardown 拒绝，因为无法证明保留成功。新建沙箱的初始目录设置失败时，服务会终止该沙箱；如果该回滚失败，资源释放会在解除所有权前重试。重新连接的沙箱设置失败时不会被终止，因为它不是由本服务创建的。提供方插件必须在该所有者之后加载，并在其之前 dispose（资源释放）。

`pause` 和 `leave` 会保留远程文件系统及适配器产物，供稍后的 `sandboxId` 连接使用，但后续 harness 进程只会获得新的 SDK 句柄。进程管理服务仍会履行其 seam 契约，在所有者释放前终止受管进程组；这两种处置方式都不会恢复先前的进程对象、输出游标或内存中的适配器锁。

## 模型体验

无。本共享运行时所有者不注册模型可见上下文；提供方适配器及其消费方拥有所有渲染效果。

#### KV Cache 影响

不会直接失效；本包不会贡献请求 token。

## 已知限制与延后工作

- **这不是完整的 harness 运行时**：Cordis 服务、agent（智能体）／会话状态、会话日志、LLM（大语言模型）请求、skill（技能）和 SDK 侧缓冲仍留在宿主进程中。
- **保留的沙箱不会恢复宿主句柄**：重新连接会保留远程文件和适配器产物，但无法重建进程管理句柄、流游标或变更锁；进程管理服务 dispose 时会终止受管子进程。
- **没有配置部署平台**：模板、卷、快照、网络策略、宿主工作区同步和沙箱发现均不在本 POC 范围内。
- **`cwd` 是解析约定，而不是包含边界**：适配器和命令可以访问沙箱中的其他路径；E2B 网络访问也继续采用模板的策略。
