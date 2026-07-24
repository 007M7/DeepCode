# Agent Note: 通过单个 Commander 适配器解析 `dsh` 的 argv

Status: implemented

[English](2026-07-24-dsh-commander-argument-adapter.md) | 中文

## 问题

`dsh` 的 CLI（命令行界面）入口（`apps/cli`）以三种手写方式解析 argv，这些方式无法组合，也不提供 `--help`/`--version`。`bin.ts` 通过原始检查进行分发：先判断 `argv[0] === 'web'`，再判断 `argv.includes('-p') || argv.includes('--prompt')`，否则走 TUI。这种方式对位置不敏感：位置错误的 prompt 标志或配置路径可能把模式路由错，而 `argv.includes('-p')` 无法区分真正的标志和偶然出现的 token。`headless.ts` 和 `web.ts` 各自运行自己的 `node:util` `parseArgs`，并内联校验 host/port，而 `dsh-app-boot` 携带 `parseResumeArg`——一个约 30 行的定制扫描器，为 `--resume` 重新实现了标志、`=` 形式、取值和重复的处理。用法说明只有一行硬编码的 `usage: dsh -p "task"`；既没有版本标志，也没有渲染出的帮助信息。

## 决策

argv 只在 `apps/cli/src/args.ts` 中解析一次，通过一个 Commander 适配器（即 SDK bin，如 `create-sdk`、`dsh-scripts`，已经统一采用的那个解析器）。`parseDshArgs(argv, version)` 将调用解析为一个判别式 `DshInvocation` 联合类型：`{ mode: 'tui', config?, resume? }`、`{ mode: 'headless', prompt }`、`{ mode: 'web', host, port }`、`{ mode: 'help' | 'version', text }` 或 `{ mode: 'error', message }`。Commander 在 `exitOverride()` 下运行并捕获输出，因此它自身从不写出或退出：`--help`、`--version` 和每个解析错误都以数据形式返回。

`bin.ts` 调用一次适配器，并对 `mode` 做分支切换（封闭联合类型，默认分支为 `satisfies never`），只动态导入所选模式对应的模块。每个模式模块现在只消费已解析好的值：`runTui(config, resume)`、`runHeadless(task)`、`runWeb(host, port)`，都不会再次读取 argv。`web` 是一个真正的 `program.command('web')` 子命令；`--host` 是 Commander 的 `.choices([LOOPBACK_HOST, ALL_INTERFACES_HOST])`，`--port` 是一个对 0–65535 做范围检查的 `argParser`，二者都从内联的 `runWeb` 检查移入了解析器。`--resume` 使用一个 `argParser`，同时拒绝空 id（`--resume=`）和重复出现的标志（`--resume a --resume b`），`--prompt` 则拒绝空任务，保留旧有的「绝不静默重新开始」不变式（已删除的 `parseResumeArg` 在相同情形下也会显式报错）。程序设置了 `enablePositionalOptions()`，且 `web` 动作会拒绝置于其前的根级 `--prompt`/`--resume`，因此位置错误的标志（`dsh web -p x`、`dsh -p x web`）会显式报错，而不会静默地以默认值提供服务。`--version` 读取本应用的 `package.json`。

`parseResumeArg` 从 `dsh-app-boot` 中删除（包括其导出、README 中的对应行以及单元测试块）；预发布阶段的立场允许这次删除。`dsh-app-boot` 保留其 boot/env/config/个人覆盖辅助函数，只有 argv 扫描器被移除。

## 包拓扑

参数解析留在 `apps/cli`（组装层）内，而不是 `packages/*` 库中：它是这一个应用自身的路由，而非可复用的 seam。`dsh-app-boot` 收缩为纯粹的 boot 胶水代码，不再承担 CLI 解析职责。`commander@^15` 被加入 `apps/cli/package.json`，与 SDK bin 锁定的版本一致。

## 考虑过的替代方案

**保留 `node:util` `parseArgs`，只统一分发。** 已否决：`parseArgs` 没有子命令模型、没有渲染出的帮助、也没有版本标志，因此 `web` 路由和 `--help`/`--version` 仍将保持手写。本仓库其他 CLI 已经选择了 Commander；单独为 `dsh` 引入第二套解析器方式，正是这次变更要消除的碎片化。

**保留 `parseResumeArg` 作为共享辅助函数，并向它喂入 Commander 的残余参数。** 已否决：整件事的核心就是要退役这个定制扫描器。Commander 原生解析 `--resume`（空格和 `=` 形式、缺值、位置无关性）；为这一个标志保留一条平行的手写路径，只会保留这次变更要终结的重复。

**把参数解析做成 `packages/*` 的 seam。** 已否决：`dsh` 之外没有任何消费方使用它，而能力 seam 不应被提前拆分。这个 Commander 适配器是 `apps/cli` 自身的事务。

## 测试

`apps/cli/tests/args.spec.ts`（新增；`apps/*/tests` 加入 vitest include，`apps/cli/tests` 加入 `tsconfig.host.json`）直接驱动适配器：TUI 默认值、config 位置参数、`--resume` 的空格/内联形式及其位置无关性、对空值/无值/重复 `--resume` 的拒绝、`-p`/`--prompt` 路由及对空 prompt 和游离位置参数的拒绝、`web` 的 host/port 默认值与校验（含 `--host`/`--port` 诊断信息）、围绕 `web` 位置错误的根级标志会显式报错、对多余参数的拒绝，以及 `--help`/`web --help`/`--version`/未知选项的处理结果。`examples/tui-agent/tests/tui-keyless-smoke.e2e.ts` 中的 `dsh CLI keyless smoke` 组通过 PTY 端到端地运行真实的 `bin.ts` 分发（默认启动、个人覆盖、无效配置、`--resume` 失败、源路径 prompt），且保持绿色不变。`packages/ui/app-boot/tests/app-boot.spec.ts` 移除其 `parseResumeArg` 测试块。

## 影响

`dsh` 获得了渲染出的 `--help`/`--version` 以及一致的显式报错式解析错误，模式路由也不再依赖标志位置。argv 解析集中在一处，并与 SDK bin 共用一套解析器方式，代价是 `apps/cli` 新增一项 `commander` 依赖，且 Commander 的解析语义（它的错误字符串、它的 `exitOverride` 契约）如今落在 CLI 的入口处。`dsh-app-boot` 不再拥有任何 CLI 解析职责；未来需要 `--resume` 式解析的消费方应组合 Commander，而不是复活已删除的扫描器。
