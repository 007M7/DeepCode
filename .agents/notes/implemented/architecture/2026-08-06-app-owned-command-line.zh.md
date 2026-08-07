# Agent Note: 应用通过 `ctx.cmdlineArgs` 持有自己的命令行

Status: implemented

[English](2026-08-06-app-owned-command-line.md) | 中文

## 问题

profile 落地之后，组合可以安装，命令行却不能。`apps/cli` 仍然声明着 Web flag 家族（`--host`、`--port`、`--dev`、`--workspace-root`、`--trusted-host`）和一次性任务位置参数，再为自己硬编码的行 id（`webserver`、`api-gateway`、`connection`、`web-runtime`）派生 patch。像 [turtle-ui](https://github.com/deepseek-harness/turtle-ui) 这样的树外应用能贡献行，却无处接受一个 flag：`dsh --profile tui --resume <session>` 没有地方可供解析，而 `dsh --profile web --help` 打印的是启动器的 help，而不是 web 应用的 help。

## 决策

启动器只解析属于自己的部分（`--profile`、`--patch`、配置 dump），并把**自己 flag 之后的一切**原样交给引导起来的配置树。切分按位置进行：启动器不认识的第一个 token 就是应用参数的起点（依靠 commander 的 `passThroughOptions` + `allowUnknownOption` + `helpOption(false)`）。裸的 `dsh -h` 没有可交付的应用，仍然打印启动器自己的 help。

新包 `@deepseek-ai/dsh-cmdline` 持有这次交接。启动器在任何条目挂载之前调用 `provideCmdline(ctx, host)`，提供 `ctx.cmdlineArgs`（其全部接口就是 `get(): readonly string[]`）、`ctx.appExit` 和 `ctx.appReady`。应用从自己的**入口点行**消费它们——该行由其组合包 manifest（元数据清单）点名（`dsh.bundle.entrypoint`），注入 `cmdlineArgs`，以自己的 commander program 调用 `runStartup(ctx, service, program, plan)`，再把解析结果作为自己的服务提供出去。应用所配置的行从各自的配置表达式中读取该服务（`port: !!js ctx.get('webStartup')?.port ?? 3080`），因此 flag 胜过写在它旁边的值，也没有任何东西被写回任何一行。

boot 分两趟挂载，这正是 manifest 声明所换来的：先是各入口点，然后才是整套组合。行的配置表达式在 include 施加该行时求值，而严格的 `ctx.get` 只对提供方 fiber 已经 active 的服务作答，因此配置树的其余部分必须在入口点起来之后才施加。于是 `--help` 在第二趟存在之前就退出；用户编辑一个活动的 patch 文件时，这一趟会针对仍然在线的服务重新施加，因此已经服务中的端口不会被悄悄重置。

已交付的各应用把自己的 flag 搬进了组合包：`dsh-web-app` 持有 Web 家族（并为 `--dev` 启用它如今以禁用状态交付的 `client-hmr` 行），`dsh-headless` 持有任务位置参数，缺少任务时按用法错误拒绝。`apps/cli/src/web.ts` 已删除；`runProfile` 不再知道任何行 id。在树外，turtle-ui 以同样的方式获得了 `--resume <session>` / `--session <id>`，这才是这套设计的真正验证：一个已安装的插件加上了一个 flag，启动器毫无改动。

还有两条后果。Loader 结算不再意味着「应用已经起来」——在第二趟中挂载的行可能看到一棵已结算的树，而挂载它的那一趟仍在进行，甚至已经在回滚——因此公布就绪信号的行（web 的 URL 行）改为等待 `ctx.appReady`。另外，`dsh --profile web` 现在也会加上过去只有 `dsh web` 别名才会加的 harness 源码提示词章节：两条路径终于以完全相同的方式引导，这也意味着名为 `web` 的用户 profile 会继承它。

## 为什么 boot 分阶段

vendored Loader 的四个事实塑造了这套机制，它们都是靠探针试出来的：

- **profile 的各行是作为根 include 的 `patches` 选项送达的，而一个条目的整份配置会在该条目启动时被插值。** 因此每一行里的每个 `!!js` 都会在 include 挂载时一次性求值——早于任何行的存在。位于根配置*文件*中的行会逐行插值，但 profile 的根按设计就是空的。
- **严格的 `ctx.get` 会隐藏提供方 fiber 尚未 ACTIVE 的服务**，而插件自身的 fiber 在其 `apply` 仍在运行时并未 active。在同一趟里既提供服务又用它配置各行，是不可能成立的。
- **更新一行的 `inject` 会丢失插件自身的静态注入。** Loader 从 `runtime.callback`（未经包装的函数）重启被替换的行，此时 `Inject.resolve(plugin.inject)` 什么也找不到：声明了 `inject = ['httpServer', 'apiProxy']` 的行回来之后，两个服务都读不到。
- **不能从正在挂载的插件内部插入一行**——`tree.create` 返回一个带前缀的 id，随后它自己解析不出来——因此条件性的行以 `disabled: true` 交付，由与它同趟挂载的行来启用（`dsh web --dev` 及其重载链路）。

这些事实合起来排除了「一趟之内用服务配置各行」，并确立了分阶段挂载：各行保留自己的 `inject` 和自己的配置，而启动器在两阶段之间所做的，仅仅是再施加一次组合。

## 曾考虑的替代方案

- **把解析出的取值写进每一行**（逐行一次配置更新，外加交还给启动器的一层 patch，使重载无法撤销它）：它能工作，但这意味着 patch 在应用与启动器之间来回传递、同一件事有两套机制，以及一套其正确性依赖 Loader 重启内部细节的回收重建。维护者否决了这次往返；供各行读取的服务取代了这一切。
- **通过清空行的 `inject` 来放行**：孤立测试可行，在真实 web 树上失败，因为清空 `inject` 恰恰会丢失插件的静态注入。在插件真的去读它声明过的服务之前，这个失败是静默的。
- **在单趟挂载中让各行等待该服务**：配置表达式在任何行存在之前就已插值，因此每个读取方都会看到 `undefined`。
- **由启动器在 boot 之前运行每个组合包的启动函数**（完全不经过 cordis）：严格早于「先 boot 再 help」，但这会让应用启动成为配置树之外的第二套插件协议。声明一个入口点*行*则只保留一套协议：入口点就是一个普通的行，可 dump、可 patch，叠加的组合包也能像禁用其他行那样禁用它。
- **两个应用解析同一份 argv**（一次性组合包叠加在 web 组合包之上）：两个解析器不可能同时持有 `-h`。一套组合有且只有一个命令行所有者：叠加的组合包禁用下层的启动行，并同时提供这两个启动服务，使被吸收的行按组合后的取值启动。
- **`instanceof CommanderError`**：树外插件会带来自己的一份 commander 副本，类身份因此不同，已经打印出来的 `--help` 会被重新抛成致命的加载失败。改为按结构识别 commander 的控制流错误。

## 后果

- 应用的 flag、help 文本和用法错误与它们所配置的行放在一起；给已安装的插件加一个 flag 不需要改动启动器。
- `--help` 只挂载各入口点然后退出，组合中的其余部分从不启动。
- 启动服务没有静态声明的所有者：交付了读取行却缺少对应入口点的组合包会在结算时失败，报出指向该服务的待处理条目，而不是在加载时失败。
- 用户 patch 若整体替换某行的 `config`，会连同其中的表达式一起丢掉，该行上 flag 的优先级也随之消失。
- 启动器的 flag 必须写在应用参数之前；如果应用的第一个参数恰好是 `web` 或 `plugin`，选中的将是这两个子命令，而且启动器的解析器会消耗掉一个 `--`，因此要给应用传一个字面量 `--` 需要写成 `-- --`。
- `--dump-config` 从不运行启动行，因此它在任何应用参数被解析之前打印组合，并拒绝携带应用参数的调用。
