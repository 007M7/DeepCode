# @deepseek-ai/dsh-subagent-dsh-sdk

[English](README.md) | 中文

SDK provider 把每个子代理作为一个完整的 DeepSeek Harness 运行时跑在全新子进程里，经由 [TypeScript SDK 客户端](../../sdk/sdk-client/README.md)走 stdio JSON-RPC 驱动。它是 [`subagent-acp`](../subagent-acp/README.md) 之外的第二个进程外后端，差异在线协议与子进程契约：ACP 后端能驱动任何 Agent Client Protocol 代理；本后端专门驱动 harness SDK 运行时（`dsh-jsonrpc-agent` bin 或打包可执行文件），因此子进程是一个完整的对等 harness——自有 `cordis.yml` 决定的组成、会话持久化、模型路由与工具。

## 启动与所有权

`start(request)` 先解析子进程工作目录，经 `DeepSeekHarness` 生成运行时，并在履行前完成 `initialize` 握手（携带配置的 `provider`/`model` 路由）。因此履行意味着子运行时已就绪、所有权已移交调用方。生成、握手或发布前取消的失败只在子进程被收割之后拒绝；工作目录解析失败在生成任何东西之前拒绝。

工作目录的解析与 ACP 后端完全一致，经由接缝共享的进程外助手（[`dsh-subagent`](../subagent/README.md)）：设置了 `cwd` 覆盖则用之（加载时校验一次），否则用发起委托的父会话 cwd——绝不用服务器进程自己的 cwd。解析出的路径同时成为子进程 cwd 与其 SDK 会话的工作区 cwd。

返回的 run id 铸造于父命名空间；子运行时的会话 id 只存在于子进程内部。发布之后，provider 跑一个 SDK 回合，并从子会话事件中读取答案：最后一条完整 `assistant/message`，或回合被截断时已累积的 `text-delta` 流——部分答案在取消与错误路径上都得以保留。

`dispose()` 幂等：先把结果就地定格为 `aborted`（线上没有 prompt 取消方法），再关闭运行时——一次有界的协议 `shutdown` 请求，随后是共享的 stdin-EOF → SIGTERM → SIGKILL 阶梯直到真正退出。

## 停止原因映射

子进程在 `session.finished` 上以结构化 `TurnEndReason` 报告回合结局；provider 把它映射进接缝词汇表。`completed` → `completed`，`max-tokens` → `max-tokens`，`aborted` → `aborted`；其余一切——`error`、`interrupted`、`disposed`、未来变体、或根本没跑回合——映射为 `error`，不洁终止绝不报告为成功。发布后的传输层失败经 `onError` 诊断汇（接到 `ctx.logger.warn`）压平为 `stopReason: 'error'`；接缝契约禁止 `result` 拒绝。

## 能力与上下文

Provider 不宣告任何启动期能力（`outputSchema`/`depthLimit`/`toolFilter`/`persona` 全为 false），且 `inheritsParentContext: false`：子进程是另一进程里的全新运行时，唯一来自父方的输入是工作区 cwd。基于本 provider 的 `dsh-tool-subagent` 部署应设置 `maxDepth: 'provider-managed'`——子 harness 拥有自己的递归预算。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `providerName` | `dsh-sdk` | `ctx.subagents` 上的注册名。 |
| `command` | 必填 | 每次 run 生成的可执行文件（子运行时 bin 或打包 exe）。 |
| `args` | `[]` | 命令参数（通常是子进程的 `cordis.yml` 路径）。 |
| `cwd` | 父会话 cwd | 工作目录覆盖；校验规则与 [`subagent-acp`](../subagent-acp/README.md) 相同。 |
| `provider` | `deepseek` | 写入子进程 `initialize` 的 provider 路由。 |
| `model` | `deepseek-v4-flash` | 写入子进程 `initialize` 的模型。 |
| `env` | `{}` | 在凭据擦除后的父环境之上叠加的显式子环境（例如子进程自己的 `DEEPSEEK_API_KEY`，或 `DSH_CORDIS_CONFIG`）。 |
| `shutdownTimeoutMs` | `1000` | 处置期间协议 `shutdown` 交换的时限。 |
| `disposeEofGraceMs` | `6000` | stdin EOF 之后、平台终止之前的宽限。 |
| `disposeGraceMs` | `3000` | 终止后的退出确认窗口；POSIX 在 SIGTERM 之后、SIGKILL 之前也等待同样时长。 |

```yaml
- id: subagent-dsh-sdk
  name: '@deepseek-ai/dsh-subagent-dsh-sdk'
  config:
    providerName: dsh-sdk
    command: node
    args: ['./packages/examples/jsonrpc-demo/lib/bin.js', './examples/jsonrpc-agent/cordis.yml']
    env:
      DEEPSEEK_API_KEY: !!js process.env.DEEPSEEK_API_KEY
- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config: { provider: dsh-sdk, toolName: subagent, maxDepth: 'provider-managed' }
```

## 进程边界

子环境以 [`dsh-subprocess`](../../subprocess/README.md) 接缝的 `scrubbedParentEnv()` 为基底——移除形似凭据与 `DSH_*` 的环境变量——再在擦除之后合并显式 `config.env` 值。子进程由 SDK 客户端生成而非经 `ctx.subprocess`（subprocess README 记载的 SDK 托管传输例外），因此本后端自行应用该擦除。JSON-RPC 线就是真实的序列化边界。

本包没有默认导出。否则 Cordis loader 解包会隐藏具名 `inject` 元数据；见[事后分析 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)。

免密钥测试通过真实 stdio 驱动 SDK 客户端包的脚本化伪运行时，还包括一个 Loader 组合 e2e：子进程是真实的第二个 harness 运行时，端到端证明父会话 cwd 继承（`tests/loader-composition.e2e.ts`）。

## Model Experience

### Child-agent request

#### What the model sees

子运行时的模型收到独立任务作为其用户消息，加上该运行时自己配置的系统提示、工具与全新会话。它收不到任何父对话。本 provider 不宣告可选启动期能力，因此本地服务会拒绝需要 persona、工具过滤、深度强制或结构化输出的请求，而不是静默省略。

#### Token effect

子进程支付一份独立的完整上下文与自己的多步历史。这些 token 绝不进入父上下文。

#### KV Cache effect

独立于父请求缓存。每个 SDK 子进程只能复用在其自身 provider、模型、组成与历史下完全相同的前缀；子步骤在此之外只增不改。

### Parent tool result, indirectly

#### What the model sees

经由 `dsh-tool-subagent`，父方只收到子进程的最终助手文本（或累积的部分文本），或该消费者精确的停止原因错误——收不到中间消息与工具流量。

#### Token effect

父输入只增长最终结果或错误，其大小依数据而定，保留至压缩。本 provider 自身不给父方增加任何 schema。

#### KV Cache effect

只追加；新可见内容跟在可复用请求前缀之后，不使既有 KV 缓存条目失效。

## Known Limitations and Deferred Work

- **每次 run 一个全新运行时进程** —— 无池化；harness 运行时要启动完整插件树，单次生成成本高于 ACP 后端的典型子进程。
- **无可选启动期能力** —— 父方无法在子进程内强制 `outputSchema`、深度、工具过滤或 persona；请改为配置子进程自己的 `cordis.yml`。
- **子进程的转录留在其自己的会话根** —— 父日志只记录委托工具调用/结果（接缝的子隔离规则）；流式 `session.event` 通道只用于提取输出，不桥接进父日志。
- **仅限本地子进程** —— 解析出的 cwd 是本地路径；远程运行时需要自己的后端。
