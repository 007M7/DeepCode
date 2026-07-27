# Agent Note: 采用 execa 替换手写的测试子进程管道代码

Status: proposed

[English](2026-07-26-execa-for-test-subprocess-plumbing.md) | 中文

## 问题

大约十个 e2e/冒烟测试文件各自手工重写同一套「spawn、收集输出、超时终止」编排：用 `setEncoding` 加 `data` 处理器做 `let stdout = ''` 式累积，用 `setTimeout` → `kill('SIGKILL')` 设定超时截止，再以 `once('exit')`/`once('error')` 结算结果，各处只有细微差别。这些位置是：`runLoaderSmoke` 的内层 spawn 代码块（`packages/support/loader-smoke/src/index.ts`）、`apps/cli/tests/built-bin.e2e.ts` 与 `packages/examples/cli-demo/tests/built-bin.e2e.ts` 中的 `runBuiltBin`、`packages/examples/acp-demo/tests/built-bin.e2e.ts` 中的 `runBinExpectingExit`、`lsp-local` 与 `code-runtime-worker` 中基于构建产物的 e2e 辅助函数、`examples/tui-agent/tests/pty-harness.ts` 的外层收集器、`examples/jsonrpc-agent/tests/keyless-smoke.e2e.ts`，以及部分涉及的 `apps/web/tests/smoke-real.e2e.ts` 和 `session-checkpoint-policy/tests/crash-recovery.e2e.ts`。净可删除量：约 100–150 行测试基础设施代码。

另有两处相关的测试基础设施手写代码进一步强化了替换的理由：

- `packages/support/llm-mock-server/src/cli.ts` 手工逐个切分 17 个带值的 `--flag value` 选项外加若干布尔标志（约 45–60 行的循环与取值辅助函数），而 `node:util` 内置的 `parseArgs` 早已是本仓库的惯用写法（`cli-demo`、`acp-demo`、`verify-runtime-closure.ts`、`packages/sdk/scripts`）。
- `apps/web/tests/smoke-real.e2e.ts` 与 `apps/web/tests/scaffold.ts` 携带两份逐字相同的正则 `.env` 解析器拷贝（约 20 行），而内置的 `process.loadEnvFile` 恰好具备所需的「不覆盖已有值」语义；并且 vitest 的 e2e/snapshot/web 配置在这些文件运行之前就已用它加载了根 `.env`，这两份拷贝几乎可以视为死代码。
- 快照 harness 手写了三个「轮询直到截止时间」的循环（`packages/support/acp-snapshot/src/harness.ts` 中的 `waitForPersistedTurnStart`/`waitForPersistedTurnEnd`/`waitForWorkspaceFile`，约 55 行），外加 `crash-recovery.e2e.ts` 中的 `waitForFile`，而 `vi.waitFor`/`expect.poll` 正好覆盖这种形态；vitest 本来就是 `dsh-acp-snapshot` 的运行时依赖，因此这不新增任何东西。

## 提案

- 将 `execa` 添加为根 devDependency，把上述 spawn、收集、超时的代码位置改写到 `await execa(cmd, args, { cwd, env, timeout, killSignal: 'SIGKILL', reject: false })` 上：其结果以相互独立的字段报告 `{ stdout, stderr, exitCode, signal, timedOut }`，与本仓库防御模式中「正交的子进程结果各自独立上报」的规则一致。真正定制的部分继续保持定制：cli-demo 在流中遇到标记即中断的逻辑、jsonrpc 基于行谓词的协议驱动，以及 crash-recovery 在故障点发送 SIGKILL 的编排。
- 把 `llm-mock-server` 的 CLI 切分器换成 `parseArgs`（数值转换、边界检查与跨选项约束仍手工实现；被固定的错误消息文本随测试一并更新）。
- 删除两份 `loadRootEnv` 拷贝，改用包在 try/catch 中的 `process.loadEnvFile`；如果 vitest 配置的加载已经覆盖了它们，则直接整体移除。
- 用 `vi.waitFor`/`expect.poll` 替换那四个轮询循环，显式传入 `{ interval, timeout }`，并在回调中抛出带描述信息的错误。

## 曾考虑的替代方案

- **用 `tinyexec` 代替 execa。**它已经作为 vitest 的传递依赖存在于 `node_modules` 中，API 也更小；但它没有终止信号逐级升级，不会把丰富的输出嵌入错误对象，而且传递依赖并不构成契约。如果最终更倾向这个更轻的包，替换的形态完全相同。
- **仓库内共享的 spawn 辅助函数（不引入新依赖）。**可行，供应链成本也更低，但当一个久经实战的包恰好负责这件事时，它把截止时限、终止与结算逻辑的维护留在了仓库内；这与[依赖策略](../../implemented/process/2026-07-26-dependencies-over-hand-rolling.md)背道而驰，它还得重新踩坑换来 execa 已经自带的 Windows 行为（taskkill、退出码）。
- **`get-port`、`wait-on`、`tempy`、`tree-kill`。**逐一不予采纳：仓库仅有的一处端口探测替换后收支相抵；文件等待场景已由 `vi.waitFor` 更优地覆盖；临时目录处理在各处已经使用内置的 `mkdtemp` + `rm {recursive}`；acp-snapshot 的 `close()` 是排空顺序逻辑，不是进程树遍历。

## 验收标准

- 所列位置全部通过 execa（或最终选定的等价包）spawn 子进程；手写的收集/超时代码块，连同 `loader-smoke` 中两个标注 `/* v8 ignore */`、无法人为诱发的 OS 错误分支，全部移除。
- `llm-mock-server` 的 CLI 经由 `parseArgs` 解析；其 cli 测试文件在更新消息期望后通过。
- `apps/web/tests` 下不再存在手写的 `.env` 解析器。
- 受影响的 e2e 与快照测试套件在 POSIX 与 Windows 两条 CI 车道上均通过。

## 风险

- `loader-smoke` 是逐文件 100% 覆盖率门禁下的 `src/` 文件；这次替换实际上简化了它的覆盖率问题（移除了无法人为诱发的分支），但新的调用形态需要补齐覆盖。
- 每个改写后的 e2e 都必须在两个平台上重新运行；终止信号升级或 stdin 关闭语义上的细微差异（loader-smoke 的 stdin 关闭契约对应 `input: ''`）是需要逐处核验的风险。
- execa 是新增的根 devDependency（当前完全不存在于 lockfile 中）；它是 npm 上被依赖最多的包之一且维护活跃，健康度不是顾虑；至于 exe/运行时闭包，无论选哪个包都不受影响（仅测试使用）。
