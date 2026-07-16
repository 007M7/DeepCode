# RFC：将 `dsh-fs-policy` 改为事件门禁插件，而非方法接口

Status: implemented

[English](2026-06-26-file-context-as-event-gate.md) | 中文

## 问题

[split-fs-seam RFC](../simplification/2026-06-26-fsspec-style-fs-seam.md) 在面向模型的工具与 `ctx.fs` 提供方之间放置了 `ctx.fileContext`：`dsh-tool-fs` 注入 `fileContext`，并将每次 `read`/`write`/`edit` 都路由到它的方法。这使得 `fileContext` **处于调用路径上且不可省略**。工具不经过它就无法触及 `ctx.fs`，策略层拥有 fs I/O 和读取窗口化，而一个不需要观测状态策略的部署无法简单地移除该包——否则 `dsh-tool-fs` 将无法解析 `ctx.fileContext`。

这把三件本应可分离的事情耦合在了一起：

1. **工具做什么**——解析路径、读取窗口、写入/编辑文件。这是工具的职责，只需要 `ctx.fs`。
2. **新鲜度/观测策略**——"编辑前必须先读"、"写入/编辑必须基于你读到的版本"。这是 `dsh-fs-policy` 插件的职责。
3. **观测状态的记录**——一个副作用，永远不应阻止工具正常运行。

因为工具调用 `fileContext` 的方法，移除策略层是一个破坏性变更，而非优雅地失去一个*附加功能*。策略对于工具的运行是承重的，而非可选的收紧。

## 决策

反转控制流。**`dsh-tool-fs` 成为执行器，直接调用 `ctx.fs`**；**`dsh-fs-policy` 成为门禁 + 记录器插件**，通过事件参与，既不通过工具调用的方法，也不注册 `ctx.fileContext` 服务。

```text
tool          dsh-tool-fs       executor: resolves, reads windows, writes/edits via ctx.fs;
                                emits fs policy events; renders results
policy        dsh-fs-policy  plugin: listens to fs/write-intent +
                                fs/edit-intent (single-slot waterfall) and fs/observed
                                (emit) events; adds observed-state + freshness.
provider seam dsh-fs            ctx.fs: text IO + ATOMIC mutation primitives whose version
                                guard is OPTIONAL; owns the fs policy event vocabulary
provider      dsh-fs-local      local implementation of ctx.fs
```

该模型是叠加式的：裸 `ctx.fs` 执行原子的、无约束的文本 I/O，而 `dsh-fs-policy` 在其上叠加观测状态、读后才能编辑、以及版本守卫。因此移除策略后工具仍可用，只是不受约束。正式发布的 agent 配置会加载策略；裸模式的存在是为了在服务边界保持策略可选，而非作为正常部署姿态。

`dsh-tool-fs` 不再注入 `fileContext`。它注入 `fs` 以及 `tools`/`systemPrompt`。

## 策略由提供方 CAS 强制执行，而非由 `dsh-fs-policy` stat

`dsh-fs-policy` 强制执行"你必须基于你读到的版本来写入/编辑"，**自身从不调用 `stat` 或比较版本**。它将观测到的版本作为 CAS 基准提供，让提供方的变更临界区检测陈旧：

- "你读过这个文件吗？"是 `dsh-fs-policy` 在本地决定的唯一事项——一次 `WeakMap` 查找，无 I/O。无记录 ⇒ `FS_NOT_OBSERVED`。
- "你读到的版本还是最新的吗？"由 **`ctx.fs.editText`/`writeText` 内部**决定，在执行 read-match-rename 的同一把原子锁中。`dsh-fs-policy` 将 `vObserved` 作为期望值传入；如果文件已变更，提供方抛出 `FS_STALE_VERSION`。

这是刻意的设计。如果 `dsh-fs-policy` 在其 waterfall（瀑布式事件）处理器中 stat 并比较版本，那么该检查与工具实际写入之间会存在 TOCTOU 间隙——文件可能在两者之间变化，因此该检查只是一个虚假保证，提供方的锁无论如何都要兜底。将版本检查放在提供方的临界区内既无竞态又零额外 `stat`。所以 `dsh-fs-policy` **不做**任何文件系统 I/O；"必须基于最新读取"的保证由 CAS *实现*，`dsh-fs-policy` 只负责选择基准（`vObserved`）并对先前观测进行门控。

## 提供方契约变更：版本守卫变为可选

为使裸提供方不受约束，其两个变更操作上的版本守卫变为**可选**——有则守卫，无则无条件：

```ts ignore-check
// writeText: expected is now optional. The FsWriteIntent union is UNCHANGED.
writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome>
//   undefined          → unconditionally create-or-overwrite (bare default)
//   createIfAbsent     → create only, reject an existing file (dsh-fs-policy, unobserved)   [unchanged]
//   replaceIfVersion   → overwrite only at the observed version, else FS_STALE_VERSION    [unchanged]

// editText: expected becomes optional (was the required { version: FsVersion }).
editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome>
//   undefined    → unconditionally replace literal text in the current content (bare default);
//                  a missing target still reports FS_STALE_VERSION
//   { version }  → edit only at that version, else FS_STALE_VERSION (the current behavior)
```

`FsWriteIntent` 联合类型本身不变——第三种"无条件"状态通过*省略* `expected` 来表达，因此两个变更操作共享一个对称的形状（`expected?`：省略 = 无守卫，提供 = 有守卫）。这对 `dsh-fs-policy` 使用的有守卫路径保持完全向后兼容；只有之前不可能的"无守卫"情况是新增的，且它是裸提供方的默认行为。无论哪种情况，变更操作仍在后端的 per-target 锁内运行，因此无条件的写入/编辑仍然是原子的（不会出现文件撕裂）；"无条件"去掉的是*版本*前置条件，而非原子性。`editText` 在有守卫和无守卫路径上都将缺失的目标报告为 `FS_STALE_VERSION`，为"此刻无法编辑该目标"保留一个统一的编辑失败码。

## 事件词汇（归属 `dsh-fs`）

事件定义在 `@deepseek-ai/dsh-fs` 中，而非 `dsh-fs-policy` 中。这是解耦契约所要求的：`dsh-tool-fs` 是事件发射方，因此它必须引用事件类型，且即使 `dsh-fs-policy` 不再提供方法服务，它也必须能编译通过。`dsh-fs` 是 `dsh-tool-fs` 和 `dsh-fs-policy` 都已依赖的包，因此它是唯一能让发射方和策略监听方共享词汇而不让发射方依赖策略插件的归属地。

这些事件携带既有的 `dsh-fs` 词汇（`FsTarget`、`FsVersion`、`FsWriteIntent`）加上一个不透明的 actor——而非面向模型的概念（行窗口、行号、渲染页脚均不会泄漏到此层）。

**两个 `fs/*` 决策事件是单槽位、先到先得的 waterfall。** `dsh-fs-policy` 不调用 `next()` 即返回，因此在默认部署中它占据该槽位；一个注册更早或使用 `prepend` 的监听器会取代该策略。权限、审计和沙箱关注点仍在可组合的 `tools/execute` waterfall 上。

actor 在 `dsh-fs` 中类型为 `object`——一个纯粹的不透明载体，提供方 seam 从不读取或窄化它。owner 的推导（`actor.agent?.session`）和 `{ agent?: { session? } }` 结构形状完全留在 `dsh-fs-policy` 内部，由其监听器将 `object` actor 窄化为该形状。`dsh-fs` 拥有事件名和 fs 词汇；它**不**拥有策略层的运行时 owner 结构。

```ts
import type { FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'

interface Events {
  /**
   * Single-slot decision: produce the write expectation for the next
   * ctx.fs.writeText. The default returns undefined (unconditional create-or-
   * overwrite — the bare provider). The policy listener returns createIfAbsent
   * (unobserved) or { kind: 'replaceIfVersion', version: vObserved } (observed).
   * The listener does NOT call next(): one decision, not a composable chain. @mode waterfall
   */
  'fs/write-intent'(target: FsTarget, actor: object | undefined, next: () => FsWriteIntent | undefined | Promise<FsWriteIntent | undefined>): Promise<FsWriteIntent | undefined>
  /**
   * Single-slot decision: produce the optional version guard for the next
   * ctx.fs.editText. The default returns undefined (unconditional edit of the
   * current content — the bare provider; no stat). The policy listener returns
   * { version: vObserved }, or throws FS_NOT_OBSERVED if the actor is unset or
   * has not observed the target. Does NOT call next(): one decision. @mode waterfall
   */
  'fs/edit-intent'(target: FsTarget, actor: object | undefined, next: () => { version: FsVersion } | undefined | Promise<{ version: FsVersion } | undefined>): Promise<{ version: FsVersion } | undefined>
  /**
   * Record that an actor observed a target at a version, after a successful
   * read/write/edit. Fire-and-forget (plain emit). Listeners MUST be
   * synchronous, side-effect-only recorders (`dsh-fs-policy`'s is a WeakMap
   * write); the tool does not guard the emit, so a throwing listener surfaces as
   * the tool's isError result. No listener ⇒ nothing recorded.
   * @mode emit
   */
  'fs/observed'(target: FsTarget, version: FsVersion, actor: object | undefined): void
}
```

`fs/*` 决策事件是**由工具分发的无绑定 waterfall**（类似 `agent/request`，由 loop 分发且无 `this`），而非服务绑定的 waterfall（如 `llm/stream`）。分发方是 `dsh-tool-fs` 插件，它不是一个服务。

## 工具契约（`dsh-tool-fs`）

工具保留其面向模型的 schema（`read`/`write`/`edit`，逐字节不变）和 prompt 段落。prompt 引导仍以策略为先，因为加载 fs 工具的部署预期也会加载 `dsh-fs-policy`：模型仍被告知在覆写或编辑前先读取，任何说"后端"要求如此的措辞应改为说 fs-policy 插件要求如此。裸提供方的回退不改变 prompt 立场。

`dsh-tool-fs` 获得了从旧 `fileContext` 方法服务迁移来的执行器职责，包括**读取渲染**（`read-render.ts`：`buildWindow` + `formatReadOutput`、`READ_MAX_BYTES`、`READ_MAX_LINE_LENGTH`、`FileReadOutcome`/`FileTextLine`，以及 `read.ts` 中的 `STREAM_MIN_SIZE`），这些现在是工具的渲染细节，因为工具拥有了读取操作。这些读取渲染类型和辅助函数迁入 `dsh-tool-fs`；策略插件不得继续作为工具的类型依赖。

`dsh-tool-fs` 是一个注册全部三个工具（`read`/`write`/`edit`）的单根插件，与 `dsh-tool-bash` 对齐。它注入 `fs`（加 `tools`/`systemPrompt`），从不注入 `fileContext`。（最初的提案还将每个工具作为 `/read`/`/write`/`/edit` 子路径插件暴露，以支持聚焦部署；实现时已放弃——没有消费方需要单工具部署，且子路径发布迫使引入定制的 `tsdown`/`tsconfig`/`files`/workspace-constraint 处理，而同级的工具包都不需要这些。每工具的注册辅助函数（`applyReadTool`/`applyWriteTool`/`applyEditTool`）保留为根插件组合的内部模块。）

`stat` 预算通过让 waterfall 惰性产出期望值来最小化——裸默认返回 `undefined`（无守卫），从不 stat：

- **read**——一次 `stat`（类型 + 大小路由 + 版本），然后 `readText`/`streamText`，然后 `buildWindow`，然后 `emit('fs/observed', target, info.version, exec)`。旧 `fileContext.read` 中读取后的确认 `stat` 被移除；在路由 stat 和读取之间竞争的写入者最多只能使*后续*有守卫的编辑虚假地 `FS_STALE_VERSION`（快速失败：模型重新读取，从不基于错误版本写入，因为 `editText` 在其锁内重新检查）。
- **write**——`expectation = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)`，然后 `ctx.fs.writeText(target, content, expectation)`，然后 `emit('fs/observed', target, outcome.version, exec)`。**工具内零 stat**，无论是否有 `dsh-fs-policy`。
- **edit**——`expectation = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)`，然后 `ctx.fs.editText(target, edit, expectation)`，然后 `emit('fs/observed', target, outcome.version, exec)`。**两种情况下工具内均零 stat**：裸默认为 `undefined`（无条件编辑），因此工具从不 stat 来制造基准。如果目标不存在，提供方即使在无守卫路径上也报告 `FS_STALE_VERSION`。

工具在每次分发时将 `exec`（工具执行上下文）作为 `actor` 参数传入，这样 `dsh-fs-policy` 就能推导其观测状态的 owner。工具不知道策略插件是否存在：它总是在 `next` thunk 中提供裸默认行为，而 `dsh-fs-policy` 在默认部署中会在 thunk 运行前短路它。

**`fs/observed` 在操作成功后触发。** 其监听器必须是同步的、不抛异常的记录器；工具不对 plain emit 做守卫，因此抛异常的监听器会在变更已成功后报告失败。异步或可失败的观测需要另一个事件契约。

## 策略插件契约（`dsh-fs-policy`）

`dsh-fs-policy` 是一个插件，不是服务。它不注册 `ctx.fileContext`，没有公开方法面，也不暴露 `read`/`write`/`edit`/`resolve` 方法。它通过 `ctx.on()` 注册三个监听器（每个返回一个用于 HMR（热模块替换）的 disposer（资源释放））。它维护观测状态的 `WeakMap<owner, Map<targetKey, { version }>>` 和结构化的 owner 推导（将事件中不透明的 `object` actor 窄化为自己的 `{ agent?: { session? } }` 形状），但不注入 `fs`——每个处理器只操作自己的 `WeakMap`，从不操作 `ctx.fs`。

- `fs/write-intent` 监听器：`prior = getObserved(owner, key)`；返回 `prior ? { kind: 'replaceIfVersion', version: prior.version } : { kind: 'createIfAbsent' }`。它不调用 `next()`：完全占据单一决策槽位。
- `fs/edit-intent` 监听器：`prior = getObserved(owner, key)`；如果无 `owner` 或无 `prior`，抛出 `FS_NOT_OBSERVED`；否则返回 `{ version: prior.version }`。同样不调用 `next()`。
- `fs/observed` 监听器：`record(owner, key, version)`。

一条观测状态条目是**先前观测记录**：成功的 `read`、`write` 或 `edit` 都会 emit `fs/observed` 并记录 `{ version }`，因此条目的存在意味着"该 owner 在此版本观测过该目标"，而非狭义的"已读取过"。这使得 create-then-edit 或 edit-then-edit 序列无需中间重新读取即可工作：变更操作将记录的版本刷新为自身的结果，因此下一次编辑的基准就是它刚产出的版本。`FS_NOT_OBSERVED` 只拒绝完全没有任何先前观测的编辑。owner 从 `{ agent?: { session? } }` 结构化推导；dispose（资源释放）时丢弃所有状态（HMR 安全）。

`dsh-fs-policy` 现在是一个纯策略/记录插件，没有服务面——它只通过事件 seam 影响外部世界。这正是从 `dsh-tool-fs` 移除方法耦合的关键。

## 裸提供方行为（无 `dsh-fs-policy`）

这不是预期的部署姿态——加载 fs 工具的配置预期也会加载 `dsh-fs-policy`。这是工具不再耦合于策略方法服务后存在的无约束提供方下限。在 `dsh-fs-policy` 缺席时，每个 `fs/*` waterfall 都落入其 `undefined` 默认值，`fs/observed` 无监听器：

- **read** 不变（它从不需要策略；只是 emit 了一个现在无人听取的 `fs/observed`）。
- **write** 无条件 create-or-overwrite：`expected` 为 `undefined`，因此 `writeText` 无论文件是否存在、无论当前版本如何都直接写入。无读取前置要求，无版本检查。
- **edit** 无条件替换文件当前内容中的字面文本：`expected` 为 `undefined`，因此 `editText` 不带版本守卫或读取前置要求即进行匹配和重写（`FS_EDIT_NOT_FOUND`/`FS_AMBIGUOUS_EDIT` 仍然适用——它们关乎字面匹配，而非新鲜度）。缺失的目标仍报告 `FS_STALE_VERSION`，与有守卫编辑路径的"此刻无法编辑该目标"错误码一致。

两个变更操作仍然是原子的（后端的 per-target 锁是无条件的）。简单地*不存在*（而非丢失）的是 `dsh-fs-policy` 本会叠加的策略：观测状态、读后才能编辑、以及版本守卫的写入/编辑。加载 `dsh-fs-policy` 后，其监听器返回有守卫的 `expected` 值而非 `undefined`，从而叠加这些约束；裸提供方本身不变。

## 取代

本 RFC 修正——而非撤销——[split-fs-seam RFC](../simplification/2026-06-26-fsspec-style-fs-seam.md)。四层拆分、提供方契约和新鲜度*策略*均保留。改变的是**工具与策略层之间的耦合方式**：一个强制方法服务变成了插件拥有的事件门禁，fs I/O + 读取窗口化从 `fileContext` 上移到了 `dsh-tool-fs`。split-fs-seam RFC 中关于 `dsh-tool-fs` 注入 `fileContext` 以及 `fileContext` 拥有 `read`/`write`/`edit` 的描述已在同一变更中更新。

## 验证

测试固定了两条路径：无 `dsh-fs-policy` 时，根工具插件对 `dsh-fs-local` 启动，read、create、overwrite 和未读取的 edit 均成功；有策略时，未读取的 edit 返回 `FS_NOT_OBSERVED`，未读取的 overwrite 被 `createIfAbsent` 门控。策略做出决策后，后注册的 intent 监听器不会被触达。陈旧编辑通过提供方 CAS 失败，而策略不执行 `stat`；工具的预算在两条路径上均为 read 一次 `stat`、write 或 edit 零次 `stat`。面向模型的 schema 逐字节不变，因此快照不变。

## 曾考虑的替代方案

- **保留 `ctx.fileContext` 作为路径内方法服务**——[split-fs-seam RFC](../simplification/2026-06-26-fsspec-style-fs-seam.md) 最初落地的形态；否决，因为工具不加载策略层就无法运行，使策略对基本操作是承重的，而非可选的收紧。
- **策略侧版本检查**（`dsh-fs-policy` 在其 waterfall 处理器中 stat 并比较）——否决，因为该检查与工具实际写入之间存在 TOCTOU 间隙；提供方的变更临界区是唯一无竞态的位置，因此策略只选择 CAS 基准并对先前观测进行门控。
- **每工具 `/read`/`/write`/`/edit` 子路径插件**——实现时放弃。没有消费方需要单工具部署，且子路径发布迫使引入定制的 `tsdown`/`tsconfig`/`files`/workspace-constraint 处理，而同级的工具包都不需要这些；每工具的注册辅助函数保留为根插件组合的内部模块。

## 后果

- **事件间接层取代方法调用。** 一次 waterfall + emit 不如 `await ctx.fileContext.edit(...)` 直接。收益是移除了工具对策略的方法依赖，同时保留默认策略插件；代价是多了一套事件词汇需要学习。通过将三个事件保持窄小并在每个事件上记录 default-thunk 语义来缓解。
- **策略事件放在存储 seam 中。** `dsh-fs` 获得了两个版本决策事件加一个记录事件，尽管它"只是存储"。这是解耦的代价（发射方不能依赖策略插件）。这些事件只携带 `dsh-fs` 词汇加一个不透明的 `object` actor，不含面向模型的概念，因此 seam 不会沾染行窗口/观测策略类型和 agent/session owner 结构。
- **单策略占位，按约定先到先得。** `fs/write-intent`/`fs/edit-intent` 槽位恰好容纳一个决策者；先注册（或 `prepend` 的）监听器获胜，其余被短路。`dsh-fs-policy` 占据该槽位是部署约定，而非事件强制的不变式——一个先注册的第二决策者会绕过它。这是可接受的，因为第二个 fs 版本策略决策者是配置错误，而非功能特性。如果未来出现*分层* fs 版本策略的需求，那是一个新 RFC（可组合的值传递 seam），而非在这些事件上静默添加第二个监听器。分层的权限/审计/沙箱拦截已有其归属：`tools/execute`。
- **移除读取后的确认 stat** 使后续*有守卫*的编辑在读写竞争下偶尔快速失败（`FS_STALE_VERSION` → 重新读取）。这是丢失的 UX 便利，从不是正确性漏洞；提供方锁仍然阻止基于错误版本的写入。
- **裸提供方不做读后写入/编辑检查，也不做版本检查。** 不加载 `dsh-fs-policy` 的部署允许模型无条件覆写或编辑任何现有文件。这正是保持工具独立于策略服务的刻意含义：安全纪律存在于 `dsh-fs-policy` 插件中。省略它的部署是有意选择无约束的文件系统；这不是发布 fs 工具的配置的预期姿态。
