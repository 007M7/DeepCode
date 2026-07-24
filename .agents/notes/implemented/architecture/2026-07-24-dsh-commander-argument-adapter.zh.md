# Agent Note: 通过单个 Commander 适配器解析 `dsh` 的 argv

Status: implemented

[English](2026-07-24-dsh-commander-argument-adapter.md) | 中文

## 问题

`dsh` 的 CLI（命令行界面）入口（`apps/cli`）以三种手写方式解析 argv，这些方式无法组合，也不提供 `--help`/`--version`。`bin.ts` 通过原始检查进行分发：先判断 `argv[0] === 'web'`，再判断 `argv.includes('-p') || argv.includes('--prompt')`，否则走 TUI。这种方式对位置不敏感：位置错误的 prompt 标志或配置路径可能把模式路由错，而 `argv.includes('-p')` 无法区分真正的标志和偶然出现的 token。`headless.ts` 和 `web.ts` 各自运行自己的 `node:util` `parseArgs`，并内联校验 host/port，而 `dsh-app-boot` 携带 `parseResumeArg`——一个约 30 行的定制扫描器，为 `--resume` 重新实现了标志、`=` 形式、取值和重复的处理。用法说明只有一行硬编码的 `usage: dsh -p "task"`；既没有版本标志，也没有渲染出的帮助信息。

## 决策

argv 只在 `apps/cli/src/args.ts` 中解析一次，通过一个 Commander 适配器（即 SDK bin，如 `create-sdk`、`dsh-scripts`，已经统一采用的那个解析器）。`parseDshArgs(argv, version)` 将调用解析为一个判别式 `DshInvocation` 联合类型：`{ mode: 'tui', config?, resume? }`、`{ mode: 'headless', prompt }`、`{ mode: 'web', host, port }`、`{ mode: 'help' | 'version', text }` 或 `{ mode: 'error', message }`。Commander 在 `exitOverride()` 下运行并捕获输出，因此它自身从不写出或退出：`--help`、`--version` 和每个解析错误都以数据形式返回。

`bin.ts` 调用一次适配器，并对 `mode` 做分支切换（封闭联合类型，默认分支为 `satisfies never`），只动态导入所选模式对应的模块。每个模式模块现在只消费已解析好的值：`runTui(config, resume)`、`runHeadless(task)`、`runWeb(host, port)`，都不会再次读取 argv。`web` 是一个**保留的首个 token**：`parseDshArgs` 将开头的 `web` 分发给它自己的 Commander 解析器，其余一切分发给默认的 TUI/headless 解析器，因此根级标志与 `web` 标志从不共用同一套语法——`dsh web -p x` 会显式报错（`web` 没有 `-p`），而 `dsh -p x web` 只是一个 headless prompt，其第二个位置参数被丢弃，无需防范任何跨命令泄漏。每个解析器都在 `parse()` 之后读取 Commander 的 `opts()`/`processedArgs`，而不是通过 action 闭包。`--host` 是一个 `.choices([LOOPBACK_HOST, ALL_INTERFACES_HOST])`，`--port` 是一个对 0–65535 做范围检查的 `argParser`，二者都从内联的 `runWeb` 检查移入了解析器。两处解析后的检查保留了「绝不静默重新开始」不变式：空的 `--resume=` id 和空的 `-p` 任务各自变为 `mode: 'error'`，因为 agent-loop 把空的 resume id 视为不恢复，而空的 prompt 没有任何内容可运行。重复出现的 `--resume` 采用 Commander 天然的后者胜出（旧的定制扫描器会拒绝它；后者胜出是标准的 CLI 行为，无需特殊处理）。`--version` 读取本应用的 `package.json`。

`parseResumeArg` 从 `dsh-app-boot` 中删除（包括其导出、README 中的对应行以及单元测试块）；预发布阶段的立场允许这次删除。`dsh-app-boot` 保留其 boot/env/config/个人覆盖辅助函数，只有 argv 扫描器被移除。

## 包拓扑

参数解析留在 `apps/cli`（组装层）内，而不是 `packages/*` 库中：它是这一个应用自身的路由，而非可复用的 seam。`dsh-app-boot` 收缩为纯粹的 boot 胶水代码，不再承担 CLI 解析职责。`commander@^15` 被加入 `apps/cli/package.json`，与 SDK bin 锁定的版本一致。

## 考虑过的替代方案

**保留 `node:util` `parseArgs`，只统一分发。** 已否决：`parseArgs` 没有子命令模型、没有渲染出的帮助、也没有版本标志，因此 `web` 路由和 `--help`/`--version` 仍将保持手写。本仓库其他 CLI 已经选择了 Commander；单独为 `dsh` 引入第二套解析器方式，正是这次变更要消除的碎片化。

**保留 `parseResumeArg` 作为共享辅助函数，并向它喂入 Commander 的残余参数。** 已否决：整件事的核心就是要退役这个定制扫描器。Commander 原生解析 `--resume`（空格和 `=` 形式、缺值、位置无关性）；为这一个标志保留一条平行的手写路径，只会保留这次变更要终结的重复。

**把 `web` 做成单个根程序的 Commander 子命令。** 已否决：一个程序若把根级 `-p`/`--resume` 语法与 `web` 子命令混在一起，除非再加上 `enablePositionalOptions()` 和一个父级选项守卫，否则根级选项会泄漏到 `web` 上——而这正是这次变更要移除的那类特殊处理机制。把 `web` 作为保留的首个 token 分发给第二个解析器更小巧，且让两套语法完全独立。

**把参数解析做成 `packages/*` 的 seam。** 已否决：`dsh` 之外没有任何消费方使用它，而能力 seam 不应被提前拆分。这个 Commander 适配器是 `apps/cli` 自身的事务。

## 测试

`apps/cli/tests/args.spec.ts`（新增；`apps/*/tests` 加入 vitest include，`apps/cli/tests` 加入 `tsconfig.host.json`）在关键层面覆盖适配器：按形态进行的模式路由、显式报错检查（空 resume/prompt、错误的 host/port、未知选项），以及 `--help`/`--version` 以数据形式呈现。`examples/tui-agent/tests/tui-keyless-smoke.e2e.ts` 中的 `dsh CLI keyless smoke` 组通过 PTY 端到端地运行真实的 `bin.ts` 分发（默认启动、个人覆盖、无效配置、`--resume` 失败、源路径 prompt），且保持绿色不变。`packages/ui/app-boot/tests/app-boot.spec.ts` 移除其 `parseResumeArg` 测试块。

## 影响

`dsh` 获得了渲染出的 `--help`/`--version` 以及一致的显式报错式解析错误，模式路由也不再依赖标志位置。argv 解析集中在一处，并与 SDK bin 共用一套解析器方式，代价是 `apps/cli` 新增一项 `commander` 依赖，且 Commander 的解析语义（它的错误字符串、它的 `exitOverride` 契约）如今落在 CLI 的入口处。`dsh-app-boot` 不再拥有任何 CLI 解析职责；未来需要 `--resume` 式解析的消费方应组合 Commander，而不是复活已删除的扫描器。
