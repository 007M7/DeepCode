# Agent Note: 应用通过 `ctx.cmdlineArgs` 持有自己的命令行

Status: implemented

[English](2026-08-06-app-owned-command-line.md) | 中文

## 问题

profile 落地之后，组合可以安装，命令行却不能。`apps/cli` 仍然声明着 Web flag 家族（`--host`、`--port`、`--dev`、`--workspace-root`、`--trusted-host`）和一次性任务位置参数，再为自己硬编码的行 id（`webserver`、`api-gateway`、`connection`、`web-runtime`）派生 patch。像 [turtle-ui](https://github.com/deepseek-harness/turtle-ui) 这样的树外应用能贡献行，却无处接受一个 flag：`dsh --profile tui --resume <session>` 没有地方可供解析，而 `dsh --profile web --help` 打印的是启动器的 help，而不是 web 应用的 help。

## 决策

启动器只解析属于自己的部分（`--profile`、`--patch`、配置 dump），并把**自己 flag 之后的一切**原样交给引导起来的配置树。切分按位置进行：启动器不认识的第一个 token 就是应用参数的起点（依靠 commander 的 `passThroughOptions` + `allowUnknownOption` + `helpOption(false)`）。裸的 `dsh -h` 没有可交付的应用，仍然打印启动器自己的 help。

新包 `@deepseek-ai/dsh-cmdline` 持有这次交接。启动器在任何条目挂载之前调用 `provideCmdline(ctx, host)`，提供 `ctx.cmdlineArgs`（其全部接口就是 `get(): readonly string[]`）、`ctx.appExit` 和 `ctx.appPatches`。应用从**启动行**消费它们：启动行注入 `cmdlineArgs`，并以自己的 commander program 调用 `runStartup(ctx, service, program, plan)`；应用所配置的行在组合包 patch 中注入这个启动服务，因此在取值解析完成之前无法启动，而 `--help` 会打印文本、禁用这些行并退出，应用自始至终不会启动。

已交付的各应用把自己的 flag 搬进了组合包：`dsh-web-app` 持有 Web 家族（并为 `--dev` 启用它如今以禁用状态交付的 `client-hmr` 行），`dsh-headless` 持有任务位置参数，缺少任务时按用法错误拒绝。`apps/cli/src/web.ts` 已删除；`runProfile` 不再知道任何行 id。在树外，turtle-ui 以同样的方式获得了 `--resume <session>` / `--session <id>`，这才是这套设计的真正验证：一个已安装的插件加上了一个 flag，启动器毫无改动。

评审中还落出两条后果。应用的决策同时以 patch 的形式交还给启动器（`ctx.appPatches`），因为用户编辑一个活动的 patch 文件时，启动器会重新施加自己的整个 patch 栈：没有这一层，一次无关的编辑就会把每一行都从其组合出的选项重建出来，把一台以 `--port 8080` 启动的服务器悄悄挪回组合出的端口，并连带丢掉 `--dev` 和由此派生的 `/api` 围栏 authority。另外，`dsh --profile web` 现在也会加上过去只有 `dsh web` 别名才会加的 harness 源码提示词章节 —— 两条路径终于以完全相同的方式引导，这也意味着名为 `web` 的用户 profile 会继承它。

## 等待中的行实际如何拿到自己的取值

vendored Loader 的三个事实塑造了这套机制，三者都是靠探针试出来的：

- **行的配置在 Loader 创建其 fiber 时就已解析，而这发生在它仍在等待自己启动服务的时候。** 把新配置写到这个等待中的 fiber 上，永远到不了插件。因此每个改动过的行都会被回收重建：先禁用，再带着新取值重新启用，从而丢弃陈旧的 fiber 并重新解析配置。
- **更新一行的 `inject` 会丢失插件自身的静态注入。** Loader 从 `runtime.callback`（未经包装的函数）重启被替换的行，此时 `Inject.resolve(plugin.inject)` 什么也找不到：声明了 `inject = ['httpServer', 'apiProxy']` 的行回来之后，两个服务都读不到。因此回收重建绝不触碰 `inject`；等待中的行是靠提供服务来放行的。
- **行的配置同样在 fiber 创建时被校验**，因此一个*必填*配置由启动流程提供的行（一次性运行器的 `task`）必须以 `disabled: true` 交付；只让它等待并不够，因为 boot 会在启动行得以运行之前就失败。它之所以看起来能工作，只是因为启动模块碰巧先被 import。

还有一条相关约束：不能从正在挂载的插件内部插入一行（`tree.create` 返回一个带前缀的 id，随后它自己解析不出来），因此条件性的行以 `disabled: true` 交付，由启动流程启用。回收重建还会先让某次仍在进行中的挂载结算完毕，因为单靠禁用并不构成屏障。

## 曾考虑的替代方案

- **通过清空行的 `inject` 来放行**（每行一次原子更新）：孤立测试可行，在真实 web 树上失败，因为清空 `inject` 恰恰会丢失插件的静态注入。在插件真的去读它声明过的服务之前，这个失败是静默的。
- **通过 `!!js ctx.get('webStartup')` 从行配置中读取 flag**：配置表达式在 fiber 创建时求值，早于启动服务存在，因此每个等待中的行都会读到 `undefined`。
- **由启动器在 boot 之前运行每个组合包的启动函数**（完全不经过 cordis）：最简单，而且严格早于「先 boot 再 help」，但这会让应用启动成为配置树之外的第二套插件协议。维护者的裁定是做成其他行所依赖的启动*服务*，从而只保留一套协议。
- **两个应用解析同一份 argv**（一次性组合包叠加在 web 组合包之上）：两个解析器不可能同时持有 `-h`。一套组合有且只有一个命令行所有者：叠加的组合包禁用下层的启动行，并同时提供这两个启动服务，使被吸收的行按组合后的取值启动。
- **`instanceof CommanderError`**：树外插件会带来自己的一份 commander 副本，类身份因此不同，已经打印出来的 `--help` 会被重新抛成致命的加载失败。改为按结构识别 commander 的控制流错误。

## 后果

- 应用的 flag、help 文本和用法错误与它们所配置的行放在一起；给已安装的插件加一个 flag 不需要改动启动器。
- `--help` 的代价是一次 boot：配置树挂载到足以运行启动行，随后拆除。等待该应用的行从不启动，这正是维护者选择服务形态的设计时所接受的代价。
- 启动服务没有静态声明的所有者：交付了等待中的行却缺少对应启动行的组合包会在结算时失败，报出指向该服务的待处理条目，而不是在加载时失败。
- 启动器的 flag 必须写在应用参数之前；如果应用的第一个参数恰好是 `web` 或 `plugin`，选中的将是这两个子命令，而且启动器的解析器会消耗掉一个 `--`，因此要给应用传一个字面量 `--` 需要写成 `-- --`。
- `--dump-config` 从不运行启动行，因此它在任何应用参数被解析之前打印组合，并拒绝携带应用参数的调用。
