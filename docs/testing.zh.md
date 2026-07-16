# 测试策略

[English](testing.md) | 中文

本文说明本仓库如何逐层测试，以及保持绿色测试套件有意义的规则。命令见根目录 [AGENTS.md](../AGENTS.md)；关联 RFC 承载设计动机。

## 层级

- **单元测试**（`pnpm run test`）：vitest 运行 `packages|examples/*/tests/**/*.spec.ts`，与被测代码同目录。每个注册表都有一个 HMR（热模块替换）安全测试（dispose 贡献该注册的 fiber，断言清理完成）。优先覆盖边界情况、错误路径、事件顺序、并发竞态与永久契约回归（见 `packages/core/agent-loop/tests/contract-regressions.spec.ts`）。
- **覆盖率门禁**（`pnpm run test:coverage`）：门禁级运行，对 `packages/*/*/src` 按文件 100% 覆盖。未覆盖的行往往是门禁正确标记出的死代码（应删除），而非需要补写的测试。行覆盖率是必要条件，绝非充分条件：它证明代码行被执行过，不证明功能按交付预期工作。
- **真实 API e2e**（`pnpm run test:e2e`）：带密钥测试，对接真实提供方 API——DeepSeek 模型加各提供方独立冒烟测试（各自依赖自己的密钥：`EXA_API_KEY`、`PERPLEXITY_API_KEY` 等）；每个套件在缺少对应密钥时自动跳过，确保无密钥 CI 保持绿色（[真实 API e2e RFC](rfc/implemented/testing/2026-06-19-real-api-e2e-ci.md)）。
- **快照测试**（`pnpm run test:snapshot`）：启动真实示例子进程，无密钥回放录制的会话，将归一化后的 stdout 与重新持久化的日志同已提交的 golden 文件做 diff（[快照 RFC](rfc/implemented/testing/2026-06-19-acp-snapshot-tests.md)）。当模型 transcript（文本记录）需要变更时使用 `pnpm run test:snapshot:record`；当已提交的 transcript 仍是正确的 mock LLM（大语言模型）输入、只需无密钥重写回放 golden 时使用 `pnpm run test:snapshot:refresh`。请评审 golden diff。系统提示词/工具 schema 内容由一个场景（`text-turn`）固定，其余 fixture（测试前置数据）中以 token 化形式引用，因此 prompt 或 schema 的修改只变动一行已提交内容（[pinned-header RFC](rfc/implemented/testing/2026-07-06-pin-request-header-content-in-one-scenario.md)）。

## 带密钥策略：推理在这里很便宜

我们是 DeepSeek：不要吝惜真实 API 测试。无密钥测试证明管道通了；只有带密钥运行才能证明 agent 对接真实模型时能正常工作。多写：文件写入 prompt、多轮对话、工具调用、流中取消。价值最高的是**冒烟测试**：启动真实示例、发送一条真实 prompt、检查外部世界的状态。它们能捕获「单元测试全绿、产品却坏了」这类 mock 在结构上无法发现的问题（[事后分析 0001](postmortem/0001-acp-default-export-drops-inject.md)）。自动跳过机制的存在仅仅是为了不阻塞无密钥 CI 和无密钥贡献者，它不是成本信号。每个示例都附带一个无密钥冒烟测试，以及（除非本身就不需要密钥）一个带密钥冒烟测试（[examples/AGENTS.md](../examples/AGENTS.md)）。

## 优先使用真实实现而非 mock

只 mock 真正昂贵或不确定的边界（LLM 适配器、网络、时钟）；下游一切保持真实。手写的替身只能证明桥接层在搬运字节，不能证明交付的工具行为符合断言——两者会漂移，而测试仍然绿着。示例：bridge 工具调用测试运行脚本化的 mock 模型，但使用真实的 tool + 真实的执行器（`makeBridgeHarness({ withBash: true })` 接入 `dsh-bash-local` + `dsh-tool-bash`，执行真正的 `echo`）。

## 验证外部世界，而非自我报告

e2e 断言应重新运行命令或从外部重新读取文件；仅对 agent 自身输出做关键词探测会让作弊的 agent 通过。断言未改动的文件字节相同。e2e 测试拥有自己的资源：在测试中创建 harness，在 `afterEach` 中 dispose（即使失败/重试/超时）；共享 fixture 放在普通的 `tests/harness.ts` 中，绝不放在另一个 `*.e2e.ts` 里（import 一个 spec 会重新注册其 `describe`，导致真实 API 调用重复）。

## 测试真实入口路径

- 产品可见的插件需要一个非单元的真实组合测试。手工搭建的 `ctx.plugin(...)` 套件不够：通过 Loader 和 app/process 启动仅用于测试的 `cordis.yml`，只 mock 外部/不确定边界，断言模型可见的请求/日志、持久状态或用户可见输出。不要把 opt-in 混入默认交付。
- 一个守卫只有在回归真正让它失败时才算守卫。对于没有 `inject` 的插件（bundle/组合插件），Loader 冒烟测试在导出形状损坏时仍然绿——需要加一个显式的 `expect('default' in mod).toBe(false)` 加 `unwrapExports` 往返断言，并证明它有效：引入回归、观察变红、还原。
- 「真实入口路径」指已发布的产物：package 的 `bin` 指向构建出的 `lib/bin.js`，在原生 `node` 下运行；tsx 会掩盖竞态、模块解析问题以及静默以 0 退出的加载失败。同理适用于构建后 package 在运行时解析的任何非 index 运行时入口（worker-thread 运行时的兄弟文件 `lib/worker.cjs`）。保持构建产物冒烟测试绿色（`packages/ui/*/tests/built-bin.e2e.ts`、`packages/code-runtime/code-runtime-worker/tests/built-lib.e2e.ts`），并断言真正缺失的配置以非零退出。
- 从临时 cwd spawn 示例的 e2e 测试需要设置 `TSX_TSCONFIG_PATH` 指向仓库根 tsconfig，否则会静默回退到陈旧的构建 `lib/`（[examples/AGENTS.md](../examples/AGENTS.md)）。

## 何时需要快照测试

任何影响编辑器侧 transcript 或端到端 agent 用户体验的变更——ACP bridge、agent loop（智能体循环）的可观测输出、工具呈现——都应在所属示例的快照套件中添加或更新场景（`examples/<name>/tests/snapshots/`，基于 [`dsh-acp-snapshot`](../packages/support/acp-snapshot/README.md) 套件工厂的场景表；`examples/acp-agent` 是主套件），或在 PR 中说明为何不适用。新的能力 seam、生命周期形态或 transcript 表面在计划阶段就要标明各层的覆盖方式，并验证 harness 能表达它——harness 的缺口是排期工作，不是构建中途的意外。
