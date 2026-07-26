# `@deepseek-ai/dsh-acp-snapshot`

[English](README.md) | 中文

ACP 快照套件工具包：无密钥快照层（`pnpm run test:snapshot`，见[测试策略](../../../docs/testing.md)）背后的共享机制。示例只需场景表和 fixture 目录就能获得完整快照套件；每项比较/保护机制都位于此处，受每文件覆盖率门禁约束，而不是在每个示例中复制。

四层可单独导入：

- **`launchAcpTestAgent`（启动器）**：从指定 cwd 在 tsx 下启动源 agent，或在普通 Node 下启动已构建 `lib` agent；通过原始字节 stdout tee 连接 SDK 客户端，收集会话更新和 stderr，在启动过程中公开异步 spawn 失败，对未处理权限请求快速失败，并负责优雅或带信号关闭。关闭会等待进程退出、继承 stdio 关闭和 ACP parser 耗尽，然后才解析或传播子级错误，使捕获内容完整，且调用方可在任一结果后移除自有路径。当 Windows 接受强制终止但异步发布退出标记时，关闭会给该标记有界宽限，然后才将回退拒绝视为第二次失败。快照和普通 e2e 套件共享该进程边界；测试只需提供 agent 路径、cwd、环境覆盖和任何权限策略。
- **`runScenario`（harness）**：通过启动器从确定性 `input.json` 脚本驱动 ACP JSON-RPC stdio，将原始 stdout tee 给预期输出和纯度检查，并在优雅 stdin EOF 后收集每个持久化原始 JSONL 会话日志（父级和 subagent 子级，主级优先）。`AgentUnderTest` 提供绝对 `binScript`、可选 `libBinScript`、`configPath` 和 `tsconfigPath` 路径，因为子进程 cwd 位于仓库外。当生成子级 cwd 自身位于待测授权中时，`workspaceParent` 可以将它从平台临时目录移出。启动失败会在拒绝诊断中保留已捕获 agent stderr。
- **规范化器**：将两个已捕获接口转换为稳定文本的纯函数：`normalizeStdout`（JSON-RPC id → 首次出现序列；UUID 以及生成 cwd 的每个原生/JavaScript 文件系统写法 → token，按最长优先；根据 cwd 的分隔符选择规范 `/` 或宿主原生形式；同时作为 stdout 纯度检查）、`normalizeSessionLog`（时间归零、保留 `seq`、使用同一 cwd 路径策略）、`scrubSystemPrompts`（提示词文本 → `{{system}}`）、`scrubToolSchemas`（schema bulk → `{{tools}}`）和 `scrubRequestHeaders`（每个 pin 之外的所有 header bulk → `{{system}}`/`{{tools}}`/`{{messagePrefix}}`，保留结构；见[header 固定 Agent Note](../../../.agents/notes/archived/testing/2026-07-06-pin-request-header-content-in-one-scenario.md)）。
- **`defineAcpSnapshotSuite`（工厂）**：为场景表注册完整 describe/it 树：每场景预期输出与重新持久化日志比较、录制/刷新 fixture 回写、拒绝结构化 `UNKNOWN_TOOL` 结果、每 header 类别 pin（`system-prompt.expected.md` 加 `tool-schemas.expected.json`）及其实时一致性保护，以及 fixture 保护块（无遗留场景目录、必需文件存在、每类别恰好一个 pin、每个 JSONL 的提示词/schema 已擦除、非 pin fixture 的 header 已完全擦除）。刷新会在对齐现有可变事件时间前展开打包时序 envelope，因此切换打包/非打包布局无法移动后续记录；新分片碎片数组仍为权威数据。新插入的 `session/title` 使用前一个事件的时间，因此功能驱动的插入不会扰动 fixture 余下部分。每个场景目录的 `session.jsonl` 和连续 `session.<n>.jsonl` 同级文件是有序主级/子级清单；场景表不重复其数量。必须在 vitest 收集时调用。

消费方 `*.snapshot.ts` 就是场景表加一次工厂调用：

```ts
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defineAcpSnapshotSuite,
  type Scenario,
  type SnapshotSuiteOptions,
} from '@deepseek-ai/dsh-acp-snapshot'

function snapshotMode(value: string | undefined): SnapshotSuiteOptions['mode'] {
  switch (value) {
    case undefined:
    case '':
    case 'replay': return 'replay'
    case 'record': return 'record'
    case 'refresh': return 'refresh'
    default: throw new Error(`unknown DSH_SNAPSHOT mode: ${value}`)
  }
}

const SCENARIOS: Scenario[] = [
  { name: 'text-turn', hasModelTurn: true, recorded: true, pinsHeader: true },
]

defineAcpSnapshotSuite({
  agent: { // absolute paths, resolved from the suite's own location
    binScript: fileURLToPath(new URL('../../../packages/examples/acp-demo/src/bin.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  },
  snapshotsDir: join(dirname(fileURLToPath(import.meta.url)), 'snapshots'),
  scenarios: SCENARIOS, // exactly one entry per header class sets pinsHeader
  mode: snapshotMode(process.env.DSH_SNAPSHOT),
})
```

启动不同组合树的场景会设置自己的 `configPath`（一个 basename 仍以 `cordis.yml` 结尾的 overlay，使 bin 的回放交换可找到同级 `*cordis.snapshot.yml`）；当该组合改变请求 header 时，还会设置自己的 `headerClass` 和 pin 场景，acp-agent 示例的 Code Mode 与文件系统场景是模板。当临时目录授权自身待测时，`workspaceParent` 将生成 cwd 移出平台临时区域；harness 仍只拥有并移除生成的子级。每个 pin 目录将规范化的完整提示词序列存入生成的 `system-prompt.expected.md`，将对应完整工具 schema 序列存入生成的 `tool-schemas.expected.json`；`session.jsonl` 存储 `"system":"{{system}}","tools":"{{tools}}"`，同时保留配置、原因和任何模型可见前缀。具有合法运行中 header 变更的 pin 声明 `expectedHeaderChanges`，用于固定两个 sidecar 序列的长度。

每个场景都比较 `stdout.expected.jsonl`，其中以 cwd 为根的分隔符规范化为 `/`。在 Windows 上，`pinsNativeWindowsStdout` 还会在共享预期输出之后比较完整 `stdout.expected.windows.jsonl`，并在启用时精确要求该 sidecar。驱动行为需要 POSIX 进程语义的场景（例如取消实时 bash 调用会终止脱离进程组）声明 `posixOnly`，在 Windows 上跳过运行测试，但 fixture 保护仍在所有平台覆盖其已提交文件。

示例还发布 `cordis.snapshot.yml` 回放 overlay，位于 `cordis.yml` 旁边（bin 在 `DSH_SNAPSHOT=replay` 下交换它们，见[单源回放配置 Agent Note](../../../.agents/notes/archived/testing/2026-07-04-single-source-acp-replay-config.md)）；回放 fixture 由 [`dsh-llm-replay`](../llm-replay/README.md) 提供，该包通过对子级设置的 `DSH_SNAPSHOT_*` env var 指向它。`pnpm run test:snapshot:record` 调用实时 LLM，并重写已记录场景的模型 fixture；`pnpm run test:snapshot:refresh` 保持无密钥，运行回放 overlay，并从已提交模型脚本重写 stdout、可比较会话日志预期输出，以及每个 pin 的提示词与工具 schema sidecar。Fixture 角色、录制/回放/刷新语义和场景表字段记录在 `Scenario` 以及[快照 Agent Note](../../../.agents/notes/implemented/testing/2026-06-19-acp-snapshot-tests.md) 中。

约束：`suite.ts` 导入 vitest，因此包入口只能在 vitest 运行中导入（启动器、harness 和规范化器没有此依赖，但从同一入口发布）。启动器和套件工厂按设计专用于 ACP，启动器使用 SDK 的 `ClientSideConnection`；规范化器是与传输无关的会话日志/文本辅助工具，还由 TUI 快照套件和 web 浏览器 e2e lane 消费。输入脚本覆盖初始化、新建会话、文本提示、取消、预期 RPC 失败和持久轮次边界等待。权限往返是选项类别选择（`allow_once`、`reject_once`等）的 FIFO 队列，映射到 agent 发出的 `optionId`；缺少或耗尽的队列回答 `cancelled`，未提供类别会拒绝运行。

## 模型体验

无。该测试专用 harness 记录、规范化并比较 ACP transcript，不会改变 agent 组装的模型请求。

#### KV 缓存影响

无；该包既不组装也不发送提供方请求。

## 已知限制与待完成工作

- **会话收集需要原始 JSONL mode**：`runScenario` 收集持久化 `.jsonl` 日志，因此快照配置使用 `persistenceCompression: 'none'`；压缩 JSONL 和 SQLite 组合没有快照收集路径。
- **构建 mode 需要当前产物**：先运行 `pnpm run build`，再选择 `DSH_EXAMPLE_MODE=lib`；源 mode 仍是零构建路径。
- **后端覆盖仍使用 ACP 驱动器**：保留场景为何使用该传输，见[仅自动化 ACP 决策](../../../.agents/notes/implemented/simplification/2026-07-23-acp-automation-only-protocol.md#snapshot-boundary)。
