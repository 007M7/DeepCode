# `@deepseek-ai/dsh-cmdline`

[English](README.md) | 中文

dsh 启动器交给它所引导应用的那条命令行。启动器只解析属于自己的 flag（`--profile`、`--patch`、配置 dump），并把**其后的一切**原样交给配置树，因此 flag 家族、`--help` 文本和解析错误都由应用自己持有，启动器不必知道它们。

## 启动器提供的值

启动器在任何配置树条目挂载之前调用 `provideCmdline(ctx, host)`，它提供：

- `ctx.cmdlineArgs`：本次调用的内层参数。`get()` 就是它的全部接口，返回一份快照：`dsh --profile tui --resume abc` 得到 `['--resume', 'abc']`。
- `ctx.appExit`：一个有边界的进程退出请求，接到启动器的关停控制器上。
- `ctx.appReady`：在启动器挂载完毕时结算，供需要公布就绪信号的行使用（例如督程会等待的 URL 行）。

没有命令行的嵌入宿主提供空列表；这是诚实的答案，而不是缺失的值。

## 入口点，以及它的应用所读取的服务

应用从自己的**入口点行**读取这些参数：入口点行是一个注入 `cmdlineArgs` 并调用 `runStartup(ctx, service, program, plan)` 的插件：

```ts ignore
export const name = 'web-startup'
export const inject = ['cmdlineArgs']

export function apply(ctx: Context): void {
  runStartup(ctx, 'webStartup', webCommand(), planWebStartup)
}
```

组合包的 `package.json` 点名那一行，这正是 boot 先于其他一切挂载它的依据：

```json
{ "dsh": { "bundle": { "patch": "./cordis.patch.yml", "entrypoint": "web-startup" } } }
```

应用用 flag 配置的每一行随后读取入口点解析出的取值，各自点名自己取用的键，以及回退时使用的值：

```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: !!js ctx.get('webStartup')?.host ?? '127.0.0.1'
    port: !!js ctx.get('webStartup')?.port ?? 3080
```

`runStartup` 解析参数，向 `plan` 索取取值，并把它们作为服务提供出去。遇到 `--help`、`--version`、解析错误，或 `plan` 发出的 `program.error(...)` 时，它输出 commander 的文本并请求退出：什么也不会被提供，组合的其余部分也从不挂载。

`plan` 收到的是所有注入该服务的行的选项，用于那些必须顾及组合本身的取值：随附的例子是 `/api` 栅栏 authority，因为组合所配置的 bind 决定了是否要派生 LAN 字面量。

### 为什么 boot 分阶段

行的配置表达式在 include 施加该行时求值，而严格的 `ctx.get` 只对提供方 fiber 已经 active 的服务作答。因此一套组合分两趟挂载：先是各入口点，然后才是其余部分——这正是 manifest（元数据清单）声明所换来的东西。后一趟的行读到的是活的取值，`--help` 在第二趟存在之前就退出，而用户编辑一个活动的 patch 文件时，这一趟会针对仍然在线的服务重新运行，因此 flag 不会被悄悄重置。

`enableRow(ctx, id)` 打开某个组合包以禁用状态交付、只有部分调用才需要的行（`dsh web --dev` 及其客户端插件重载链路）。要从与被启用行同一趟挂载的行里调用它，而不是从入口点：在第一趟被启用的行会去等待第二趟才挂载的服务。

### 一条命令行，一个所有者

一套组合有且只有一个命令行所有者。叠加在另一应用之上的应用会禁用下层的入口点行，并同时点名两个服务，使它吸收过来的行按各自回退值启动：[`dsh-headless`](../../bundle/headless/README.md) 相对 [`dsh-web-app`](../../bundle/web-app/README.md) 就是这么做的。

树外插件会带来自己的一份 commander 副本，因此 commander 的控制流错误按结构识别，而不是按类身份识别；按身份判断会把已经打印出来的 help 重新抛成致命的加载失败。

## 模型体验

无。本包在任何会话存在之前解析进程自身的命令行。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

- **启动器的 flag 必须写在应用参数之前**：切分按位置进行，启动器不认识的第一个 token 就是内层参数的起点，因此写在某个应用 flag 之后的 `--patch` 属于应用。启动器的解析器会消耗掉一个 `--`，因此必须以字面量 `--` 存活到应用的参数需要写成 `-- --`。
- **启动服务没有声明所有者**：各行点名它，由入口点提供它；两者之间没有静态关联，因此交付了读取行却缺少对应入口点的组合包会在结算时失败（出现指向该服务的待处理条目），而不是在加载时失败。
- **用户 patch 若整体替换某行的 `config`，会连同其中的表达式一起丢掉**：flag 胜过的是表达式旁写着的那个值，而不是用户用字面量替换掉表达式之后的结果；保留表达式才能保留 flag 的优先级。
