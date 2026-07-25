# Agent Note: 通过单个 Commander 适配器解析 `dsh` 的 argv

Status: implemented

[English](2026-07-24-dsh-commander-argument-adapter.md) | 中文

## 问题

`dsh` 的 CLI（命令行界面）入口（`apps/cli`）以三种手写方式解析 argv，这些方式无法组合，也不提供 `--help`/`--version`。`bin.ts` 通过原始检查进行分发：先判断 `argv[0] === 'web'`，再判断 `argv.includes('-p') || argv.includes('--prompt')`，否则走 TUI。这种方式对位置不敏感：位置错误的 prompt 标志或配置路径可能把模式路由错，而 `argv.includes('-p')` 无法区分真正的标志和偶然出现的 token。`headless.ts` 和 `web.ts` 各自运行自己的 `node:util` `parseArgs`，并内联校验 host/port，而 `dsh-app-boot` 携带 `parseResumeArg`——一个约 30 行的定制扫描器，为 `--resume` 重新实现了标志、`=` 形式、取值和重复的处理。用法说明只有一行硬编码的 `usage: dsh -p "task"`；既没有版本标志，也没有渲染出的帮助信息。

## 决策

argv 只在 `apps/cli/src/args.ts` 中解析一次，并使用 Commander 适配器（SDK bin `create-sdk`、`dsh-scripts` 已经统一采用的同一解析器）。`parseDshArgs(argv, version)` 返回仅包含三种实际模式的判别式 `DshInvocation` 联合类型：`{ mode: 'tui', config?, resume? }`、`{ mode: 'headless', prompt }` 或 `{ mode: 'web', host?, port?, dev }`。它**不会**将帮助、版本信息或错误建模为数据：这些情况由 Commander 处理，在触发处打印用法或诊断信息并退出。`exitOverride()` 会将每种情况转为抛出的 `CommanderError`，并携带预期退出码（帮助或版本为 0，解析错误或领域错误为 1）；唯一一处 `try/catch` 位于 `parseDshArgs` 中，捕获错误后调用 `process.exit`。

`bin.ts` 只调用适配器一次，并对 `mode` 做分支切换（封闭联合类型，默认分支为 `satisfies never`），仅动态导入所选模式对应的模块；只有合法的非帮助请求才会进入这段分支逻辑，因此其中没有帮助、版本或错误分支。每个模式模块只消费已解析好的值：`runTui(config, resume)`、`runHeadless(task)`、`runWeb(host, port, dev)`，都不会再次读取 argv。`web` 是一个**保留的首个 token**：`parseDshArgs` 将开头的 `web` 分发给它自己的 Commander 解析器，其余一切分发给默认的 TUI/headless 解析器，因此根级标志与 `web` 标志从不共用同一套语法；`dsh web -p x` 会显式报错（`web` 没有 `-p`）。每个解析器都读取 Commander 的 `opts()`/`processedArgs`（在 `parse()` 之后），随后对 Commander 无法表达的领域校验调用 `command.error(...)` 立即终止（打印信息并以退出码 1 退出）：`--prompt` 选择 headless 模式，并在任务为空或存在多余的配置位置参数或 `--resume` 时拒绝调用，而不会静默丢弃 TUI 输入；空的 `--resume=` id 会显式失败（agent-loop 把 `''` 视为不恢复）；提供 `--host`/`--port` 时，`--host` 必须是回环地址或全接口地址，`--port` 必须是 0–65535 范围内的整数（这两项校验都从 `runWeb` 的内联检查移入解析器）。适配器**不会**为 host/port 设置默认值：未提供某个标志时，对应字段保持 undefined；`runWeb` 仅在相应字段存在时才将 host/port 转发给 `AppCLIEntry`；随产品提供的 `apps/cli/cordis.yml` 中 `webserver` 配置项是 host/port 默认值的唯一真源，只有显式提供标志时才会覆盖该默认值。`--dev` 会挂载客户端 HMR（热模块替换）驱动，并启用构建产物监视。重复提供 `--resume`，或后续标志被捕获为 `--resume` 或 `--prompt` 的值，都是 Commander 的标准行为（最后一次取值生效／将下一 token 作为值），本适配器不作干预；无效 id 会在下游无法加载会话时显式失败。`dsh --help` 会展示 `web` 模式，具体通过一行 `addHelpText` 文本实现（真正的 `web` 子命令会劫持 `[config]` 位置参数）。`--version` 读取本应用的 `package.json`。

`parseResumeArg` 从 `dsh-app-boot` 中删除（包括其导出、README 中的对应行以及单元测试块）；预发布阶段的立场允许这次删除。`dsh-app-boot` 保留其 boot/env/config/个人覆盖辅助函数，只有 argv 扫描器被移除。

## 无需环境变量即可恢复

将与本解析器并行开发的安全会话恢复功能合入时，系统移除了 `RESUME_SESSION_ID` 环境变量。此前，它是将 `--resume` 的值传给随产品提供的配置字段 `resumeSessionId: !!js process.env.RESUME_SESSION_ID` 的唯一通道。`runTui` 现在通过 `boot` 的 `prepare(ctx)` 钩子注入已解析的 id：`ctx.provide(RESUME_SESSION_ID_KEY, id)`（`dsh-app-boot` 的新导出，值为 `'resumeSessionId'`）；tui-agent 和 cordis-agent 的四份配置将该值作为裸标识符读取：`resumeSessionId: !!js "typeof resumeSessionId === 'string' ? resumeSessionId : undefined"`。这个表达式需要加引号，否则 YAML 会把 `?` 和 `:` 解析为映射；`typeof` 守卫使从未提供该槽位的启动器也能正常运行。`/resume` 原地交接（`process.execve`）直接根据解析后的值将重新执行的 argv 构造成 `dsh --resume=<id> [-- <config>]`；其中 `--` 可确保名称为 `web` 或以 `-` 开头的配置仍被视为位置参数。因此，合并时引入的 `replaceResumeArg` 与 `parseResumeArg` 一并删除。

## 唯一的终端入口：`dsh`

`dsh-tui-demo` 包（package）原本包含一个插件（即 `dsh` 配置挂载的 TUI 应用组合）和一个冗余的 `bin`；后者启动一份叶子配置 `cordis.yml`，所做的工作与 `dsh [config]` 相同。该 bin 已移除：`demo:cordis`、`demo:code-mode` 以及 tui-agent 和 cordis-agent 的两个无密钥 PTY 冒烟测试现在都通过 `apps/cli/src/bin.ts` 启动，并将配置作为位置参数；该包只保留插件入口和不变式入口。与该 bin 一同移除的还有对 `dsh-app-boot` 的对等依赖（peer dependency）和开发依赖、`bin` 和 `./bin` 导出、演示包的 `built-bin.e2e.ts`，以及 tsdown 的 `bin` 入口。`dsh` 自身的 TTY 守卫会在标准输入输出接入管道时，于启动应用前拒绝运行，并提示自动化场景改用 `dsh -p`；为此新增的 `apps/cli/tests/built-bin.e2e.ts` 将标准输入输出接入管道，直接使用 Node 运行构建后的 `lib/bin.js`（`apps/*/tests` 已加入 e2e Vitest 的测试文件匹配范围）。`cli-demo`、`acp-demo` 和 `jsonrpc-demo` 保留各自的 bin，因为它们分别提供 `dsh` 所没有的独立接口（headless、ACP（Agent Client Protocol）、JSON-RPC）。

## 包拓扑

参数解析留在 `apps/cli`（组装层）内，而不是 `packages/*` 库中：它是这一个应用自身的路由，而非可复用的 seam。`dsh-app-boot` 收缩为纯粹的 boot 胶水代码，不再承担 CLI 解析职责。`commander@^15` 被加入 `apps/cli/package.json`，与 SDK bin 锁定的版本一致。

## 考虑过的替代方案

**保留 `node:util` `parseArgs`，只统一分发。** 已否决：`parseArgs` 没有子命令模型、没有渲染出的帮助、也没有版本标志，因此 `web` 路由和 `--help`/`--version` 仍将保持手写。本仓库其他 CLI 已经选择了 Commander；单独为 `dsh` 引入第二套解析器方式，正是这次变更要消除的碎片化。

**保留 `parseResumeArg` 作为共享辅助函数，并向它喂入 Commander 的残余参数。** 已否决：整件事的核心就是要退役这个定制扫描器。Commander 原生解析 `--resume`（空格和 `=` 形式、缺值、位置无关性）；为这一个标志保留一条平行的手写路径，只会保留这次变更要终结的重复。

**把 `web` 做成单个根程序的 Commander 子命令。** 已否决：一个程序若把根级 `-p`/`--resume` 语法与 `web` 子命令混在一起，除非再加上 `enablePositionalOptions()` 和一个父级选项守卫，否则根级选项会泄漏到 `web` 上——而这正是这次变更要移除的那类特殊处理机制。把 `web` 作为保留的首个 token 分发给第二个解析器更小巧，且让两套语法完全独立。

**把参数解析做成 `packages/*` 的 seam。** 已否决：`dsh` 之外没有任何消费方使用它，而能力 seam 不应被提前拆分。这个 Commander 适配器是 `apps/cli` 自身的事务。

**保留 `RESUME_SESSION_ID` 作为恢复通道**：不予采纳。`--resume` 已被解析成 bin 当前持有的值；若再通过环境变量传递并由配置重新读取，只会引入无益的间接层，还会使演示 bin 保留第二条仅依赖环境变量的恢复路径。在启动上下文中提供 id，与 `boot` 的 `prepare` 钩子为 `tuiResumeHost` 提供值所采用的是同一通道。

**保留 `dsh-tui-demo` bin**：不予采纳。它与 `dsh [config]` 的功能完全重复；保留它还会迫使演示专用的 `RESUME_SESSION_ID` 回退路径继续存在。配置实际挂载的是该包的插件；冗余的只有作为终端入口的 bin，而 `dsh` 是唯一的终端入口。

## 测试

`apps/cli/tests/args.spec.ts`（新增；`apps/*/tests` 加入 vitest include，`apps/cli/tests` 加入 `tsconfig.host.json`）覆盖适配器的关键行为：根据参数形态进行模式路由（包括 `web --dev`），并验证以下情况各自的退出码行为：显式报错检查（恢复 id 或提示词为空、host 或 port 无效、`--prompt` 与配置混用、未知选项）以及 `--help` 和 `--version`；这些退出码通过 `process.exit` spy 捕获。`examples/tui-agent/tests/tui-keyless-smoke.e2e.ts` 中的两组 PTY 冒烟测试现在都驱动真实的 `apps/cli/src/bin.ts`：`tui-agent` 组将配置作为位置参数启动，`dsh CLI` 组覆盖默认启动、个人覆盖、无效配置、配置对 `--resume` 的接收、通过 `process.execve` 原地恢复交接，以及包含源码路径的系统提示词。`examples/cordis-agent/tests/keyless-smoke.e2e.ts` 同样通过 `dsh` 启动。`packages/ui/app-boot/tests/app-boot.spec.ts` 移除其 `parseResumeArg` 和 `replaceResumeArg` 测试块；TUI 单元测试和快照 fixture（测试前置数据）使用 `dsh --resume {session}` 恢复命令。

## 影响

`dsh` 获得了渲染出的 `--help`/`--version` 以及一致的显式报错式解析错误，模式路由也不再依赖标志位置。argv 解析集中在一处，并与 SDK bin 共用一套解析器方式，代价是 `apps/cli` 新增一项 `commander` 依赖，且 Commander 的解析语义（它的错误字符串、它的 `exitOverride` 契约）如今落在 CLI 的入口处。`dsh-app-boot` 不再拥有任何 CLI 解析职责；未来需要 `--resume` 式解析的消费方应组合 Commander，而不是复活已删除的扫描器。恢复会话不再需要环境变量，且 `dsh` 是唯一的终端入口；`dsh-tui-demo` 包现在是一个不带 bin 的插件组合包。原先运行 `dsh-tui-demo <config>` 或 `RESUME_SESSION_ID=<id> dsh-tui-demo` 的用户，改用 `dsh <config>` 或 `dsh --resume <id>`。
