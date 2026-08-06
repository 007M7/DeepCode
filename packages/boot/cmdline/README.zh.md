# `@deepseek-ai/dsh-cmdline`

[English](README.md) | 中文

dsh 启动器交给它所引导应用的那条命令行。启动器只解析属于自己的 flag（`--profile`、`--patch`、配置 dump），并把**其后的一切**原样交给配置树，因此 flag 家族、`--help` 文本和解析错误都由应用自己持有，启动器不必知道它们。

## 启动器提供的三个值

启动器在任何配置树条目挂载之前调用 `provideCmdline(ctx, host)`，它提供：

- `ctx.cmdlineArgs`：本次调用的内层参数。`get()` 就是它的全部接口，返回一份快照：`dsh --profile tui --resume abc` 得到 `['--resume', 'abc']`。
- `ctx.appExit`：一个有边界的进程退出请求，接到启动器的关停控制器上。
- `ctx.appPatches`：启动行记录自身决策的去处，面向会重新组合自己配置树的启动器。从不重新组合的宿主不提供它。

没有命令行的嵌入宿主提供空列表；这是诚实的答案，而不是缺失的值。

## 启动行，以及各行所等待的服务

应用从**启动行**读取这些参数：启动行是一个注入 `cmdlineArgs` 并调用 `runStartup(ctx, service, program, plan)` 的插件：

```ts ignore
export const name = 'web-startup'
export const inject = ['cmdlineArgs']

export function apply(ctx: Context): Promise<void> {
  return runStartup(ctx, 'webStartup', webCommand(), planWebStartup)
}
```

应用用 flag 配置的每一行，都在组合包 patch 中注入那个启动服务：

```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: 127.0.0.1
    port: 3080
```

`runStartup` 解析参数，向 `plan` 询问每个等待中的行应有的取值，应用这些取值，然后提供启动服务，正是这一步让这些行得以启动。遇到 `--help`、`--version`、解析错误，或 `plan` 发出的 `program.error(...)` 时，它输出 commander 的文本，禁用等待中的行并请求退出：应用从不启动，结算审计看到的是一棵被要求不要启动它的树。

`plan` 收到的是每个等待中的行**组合后**的选项，因此决策在覆盖之前能读到组合包 patch 与用户自己那几层达成的结果；`overrideConfig(row, { port })` 只替换点名的那些配置键。plan 中未出现的行按组合后的取值启动；而为某一行 plan 了改动，也会顺带启用它。

必填配置由启动流程**供给**而非覆盖的行，必须以 `disabled: true` 交付，因为等待中的行的配置在其 fiber 创建时就会被校验（此时启动服务尚未到达），缺少一个必填键会在那里就让 boot 失败。一次性运行器的 `task` 就是随附的例子。因其他原因以禁用状态交付的行也以同样方式打开：`dsh web --dev` 为 HMR（热模块替换）接收方 plan 了一个 `{ disabled: false }`。

这些决策同时经 `ctx.appPatches` 到达启动器，正是这一点让它们在一次重新组合中存活下来：没有它，用户编辑一个活动的 patch 文件就会把每一行都从其组合后的选项重建出来，并悄悄把一台以 `--port 8080` 启动的服务器挪回组合后的端口。

### 为什么改动过的行要回收重建

等待中的行的配置在 Loader 创建它的 fiber 时就已解析，而这发生在该行仍在等待的时候。把新配置写到这个 fiber 上，永远到不了插件，因此每个改动过的行都会先禁用再重新启用，从而丢弃陈旧的 fiber 并重新解析配置。自身挂载仍在进行中的行会先被放行至停稳，这样禁用时才有一个 fiber 可供 dispose（资源释放），而不是与一个正在诞生的 fiber 抢跑。

回收重建刻意不动 `inject`。更新一行的 `inject` 会让它从未经包装的回调重新启动，从而丢失插件自身的静态注入：声明了 `inject = ['httpServer', 'apiProxy']` 的行回来之后，两个服务都读不到。

### 一条命令行，一个所有者

一套组合有且只有一个命令行所有者。叠加在另一应用之上的应用会禁用下层的启动行，并同时点名两个启动服务，使它吸收过来的行按组合后的取值启动：[`dsh-headless`](../../bundle/headless/README.md) 相对 [`dsh-web-app`](../../bundle/web-app/README.md) 就是这么做的。

树外插件会带来自己的一份 commander 副本，因此 commander 的控制流错误按结构识别，而不是按类身份识别；按身份判断会把已经打印出来的 help 重新抛成致命的加载失败。

## 模型体验

无。本包在任何会话存在之前解析进程自身的命令行。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

- **启动器的 flag 必须写在应用参数之前**：切分按位置进行，启动器不认识的第一个 token 就是内层参数的起点，因此写在某个应用 flag 之后的 `--patch` 属于应用。启动器的解析器会消耗掉一个 `--`，因此必须以字面量 `--` 存活到应用的参数需要写成 `-- --`。
- **启动服务没有声明所有者**：各行点名它，由启动行提供它；两者之间没有静态关联，因此交付了等待中的行却缺少对应启动行的组合包会在结算时失败（出现指向该服务的待处理条目），而不是在加载时失败。
