# @deepseek-ai/dsh-code-runtime-e2b

[English](README.md) | 中文

[`ctx.codeRuntime`](../../code-runtime/code-runtime/README.md) 的 E2B 实现。每次运行都会在全新的远程 Node worker 中执行一段模型编写的 TypeScript 程序；绑定函数、类型剥离、输出记账和生命周期编排仍保留在宿主侧。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `computeMs` | `60000` | 远程 worker 的事件循环忙碌时间预算。 |
| `maxWallMs` | `600000` | 宿主观测到的墙钟时间上限。 |
| `maxOutputBytes` | `67108864` | 外层日志、值和诊断合计的序列化上限。 |
| `maxOldGenerationSizeMb` | `512` | 远程 worker 的老生代堆上限（MiB）。 |
| `maxFrameBytes` | `268435456` | 已解码桥接帧的最大大小，包括绑定流量。 |
| `killGraceMs` | `2000` | 远程进程组 TERM 到 KILL 的宽限期。 |

每个值都必须是正的安全整数。`maxOutputBytes` 必须至少为 4 字节，`maxWallMs` 不得超过 Node 的最大定时器延迟，且 `maxFrameBytes` 不得小于 `maxOutputBytes`。本服务要求使用具体的 `dsh-subprocess-e2b` 后端，使运行清理具备远程进程组语义。

## 执行与桥接契约

设置阶段会在 `ctx.e2b.runtimeRoot` 下上传一个无依赖的 runner，并解析远程 Node。每次运行时，宿主会包装仅使用可擦除语法的 TypeScript，再用 Node 的 `stripTypeScriptTypes` 剥离类型，然后在 `ctx.e2b.cwd` 中启动 runner。runner 会创建一个具有空环境与堆上限的全新 worker 线程，测量事件循环活跃时间，并在一次运行结算后销毁该 worker。每当运行返回结果、超时、中止或因资源释放终止时，系统都会终止外围的 E2B 进程组并等待其退出，因此组内的普通子进程会随本次运行一同停止。

由于 E2B 进程管理回调公开的是已解码文本，桥接层使用经过验证、以换行分隔的 base64 JSON 帧。绑定参数与 resolve 值使用 worker 运行时的迭代式无损 JSON wire 形状；绑定函数在宿主执行，类型化的 reject 类则在远程 worker 内物化。worker 会在模型代码运行前捕获其适配器边界调用的 JavaScript intrinsic，从而增强绑定传输、输出记账与完成值验证对这些引用修改的抵御能力。宿主会再次执行消息验证、调用 id 去重和无损 JSON 检查，并用外层输出账本再次计量。

程序失败会 resolve 为 `CodeRunResult.error`；只有 seam 误用才会 reject。`isolation` 报告为 `container`；这是部署描述符，不构成安全声明。

## 模型体验

通过 `dsh-tools` 中的 Code Mode 间接影响模型；它会通过现有 `run_code` 结果契约返回程序日志、值或类型化失败。

#### KV Cache 影响

不会直接失效；请求前缀变更由 Code Mode 负责。

## 已知限制与暂缓工作

- **并非完整的 agent（智能体）运行时**：Cordis、会话、LLM（大语言模型）调用、绑定分发、TypeScript 类型剥离、输出账本和 E2B SDK 状态仍保留在宿主侧。
- **运行不可重连**：保留沙箱会保留文件，但不会保留 worker／进程管理句柄、绑定调用、定时器或输出游标。
- **Node worker 内部机制与模型共享同一 realm**：修改 Node 自身使用、影响整个 realm 的全局对象或原型可能会终止 worker；已捕获的适配器 intrinsic 并不构成独立的 JavaScript realm 或安全边界。
- **不会捕获有意逃逸进程组的行为**：模型代码可以创建新的 POSIX 会话；该非受管进程不属于此后端的清理身份范围。
- **中间绑定流量的内存边界仅适用于单帧**：它不会进入模型上下文或外层输出账本，但其总量仍只受宿主／远程进程内存限制。
- **实验性类型剥离**：该后端与 worker 实现一样，依赖 Node 的实验性可擦除语法 API。
- **沙箱策略归模板负责**：本包不会额外增加网络、卷、快照或工作区同步策略。
