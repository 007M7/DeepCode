# acp-agent 示例

[English](README.md) | 中文

通过 JSON-RPC stdio 提供的自动化导向 [Agent Client Protocol](https://agentclientprotocol.com) 服务器。它面向父 agent（智能体）、subagent 提供方和其他程序化客户端，而非产品 UI。

```sh
pnpm run demo:acp             # needs DEEPSEEK_API_KEY (repo-root .env or env)
pnpm run demo:code-mode acp   # same protocol with the Code Mode tool transport
```

该叶节点加载 ACP 应用、DeepSeek 适配器、受沙箱限制的 bash 与文件系统栈、一次性批准策略、压缩（compaction）、subagent、工作流、钩子、派生会话查询索引和重复守卫。应用为每次 `session/new` 创建一个新 agent，将会话持久化到 JSONL，并保持 stdout 只含协议内容。[`session-query.cordis.yml`](session-query.cordis.yml) 为其专用快照显式选用 workspace 授权的查询工具和通用超时／溢出策略；[`fs.cordis.yml`](fs.cordis.yml) 为文件系统场景添加溢出存储，[`code-mode.cordis.yml`](code-mode.cordis.yml) 则添加 `run_code` 及其生成的 TypeScript SDK。

## 协议通道

Stdout 只携带以换行分隔的 ACP JSON-RPC。`@deepseek-ai/dsh-acp-demo` 不安装 stdout logger；叶节点的附加项必须使用 stderr 输出诊断信息。

自动化契约（支持的方法、基线提示词内容、已提交文本输出，以及有意缺少的 UI 界面）位于 [`@deepseek-ai/dsh-acp`](../../packages/acp/acp/README.md)。

## 会话 workspace 与权限

每次 `session/new` 都提供一个绝对 `cwd`。受沙箱限制的 bash 与文件系统变更会根据该会话 cwd 解析 `workspace-write`，因此并发会话可以使用不同的项目根目录；平台临时根目录仍是共享可写暂存空间（参见[沙箱契约](../../packages/sandbox/sandbox/README.md)）。`DSH_PERMISSION_MODE` 在部署和测试中选择 `workspace-write` 或 `danger-full-access`。

在 `workspace-write` 下，模型请求扩大沙箱权限的重试会触发 `session/request_permission`，选项为 `allow_once` 和 `reject_once`。客户端以程序方式决策；解除对话框或答案不可用时会失败闭合。选定结果仅适用于该次重试，并通过常规工具结果／审计路径记录。服务器绝不公开权限选择器，也不持久化客户端策略。

## 快照测试

此示例拥有 ACP 快照套件。它会启动真实自动化服务器，通过 `dsh-llm-replay` 回放已提交的模型流，并比较规范化后的协议输出与重新持久化的会话日志。录制使用真实模型；刷新会复用已提交的回放输入。覆盖场景包括抛出／挂起行为，可选 `workspace/` fixture（测试前置数据）则为外部状态检查预置环境。

大多数场景锁定后端行为，而非 ACP 专用行为；[仅面向自动化的 ACP 决策](../../.agents/notes/implemented/simplification/2026-07-23-acp-automation-only-protocol.md#snapshot-boundary)说明了为何该覆盖仍与传输层耦合。
