# @deepseek-ai/dsh-settings

[English](README.md) | 中文

抽象用户设置 seam（`ctx.settings`）。一个 provider 持有按 namespace 分节的原始文档；插件注册 namespace schema 并读取分层解析值：schema 默认值，然后注册方的组合 `base`（其 cordis.yml entry 配置子集），最后用户文档分节。不挂载 provider 时消费者行为不变：仍只按 entry 配置解析，因此任何组合有无 settings 都能工作。

## 服务 API

- `register(ns, schema, { base?, applies? })` — 返回 owner 的 `SettingsScope`（`get`/`watch`/`update`）。注册是调用方插件 fiber 上的 effect：dispose 该 fiber 即移除 namespace 及其观察者。schema 拒绝的存量分节会使注册本身失败；重复 namespace 立即报错。
- `describe()` — 每个 namespace 一条描述（`schema.toJSON()` 信封、解析值、`applies`），供配置界面使用。
- `get(ns)` — 解析值；未注册时为 `undefined`。
- `update(ns, patch)` — 把普通对象 patch 深合并进用户分节（绝不合并进 `base`），校验解析候选值，经 provider 持久化后提交。patch 必须是 JSON 形状的数据：Date、Map、BigInt、非有限数或循环引用会在任何内容持久化前带着以 `$` 为根的路径拒绝（YAML/JSON 存储在重载时会静默扭曲这类值）。校验失败在持久化前拒绝；只读 provider（`writable: false`）拒绝一切写入。同一 namespace 的写入按调用顺序串行。
- `replace(ns, section)` — 整体替换用户分节：merge 表达不了的删除/重置路径（`replace({})` 重新继承 `base` 与 schema 默认值）。
- 解析值是深冻结快照。每次提交后观察者收到 `(next, prev)`：同一回调的调用异步、逐次、按提交顺序执行（慢的旧调用绝不会覆盖更新的结果），异常——同步抛出与异步拒绝——均被隔离。watch 的 disposer 返回后不再启动新的调用（已排队的那一次会被跳过）；已启动的调用仍会结算。`settings/updated` 事件逐 listener 扇出，一个抛错的 listener 不会饿死其余 listener；异步 listener 的拒绝会被隔离并记入日志，这正是 `INVARIANT` 编码的失败只从同步 listener 重新抛出的原因。
- 服务卸载先拒绝新写入与观察者调用的启动，再排干全部排队写入与已启动的观察者调用后才完成；registrant fiber 在写入途中被 dispose 时，该写入仍到达存储，但不向任何人提交或通知。

## Provider 契约

子类实现 `writable`、`load()`、`persist(ns, section)`，并通过受保护的 `publish(doc)` 推入外部观察到的文档。基类 service init 在服务可注入前加载并发布一次文档；自有 init（watcher、连接）的 provider 先经 `yield* super[Service.init]()` 委托。publish 时每个已注册 namespace 独立重解析：非法分节保留该 namespace 的最后可用值并告警——热重载绝不拖垮进程；启动期与注册期校验则立即报错。

## 事件

`settings/updated (ns, next, prev, source)` 在每次提交后触发；`source` 为 `update`（进程内写入）或 `provider`（外部变更）。解析值深相等时绝不触发。

## Model Experience

间接生效：消费插件从各自 namespace 解析影响模型的值（例如默认模型路由）；效果由各消费者自己的文档描述。

#### KV Cache effect

无直接失效；把设置值折叠进请求前缀的消费者拥有该变更。

## Known Limitations and Deferred Work

- **单一用户层** — 解析只认识 schema 默认值、一个组合 `base` 与一个用户文档；尚无 project/managed 分层或按值溯源。
- **跨进程并发由 provider 定义** — seam 仅在进程内按 namespace 串行化写入；跨进程并发按 provider 行为收敛（本地文件 provider 在写锁下读-改-写，因此 namespace 在并发写入者下不会丢失，同 namespace 冲突按后写胜出解决）。
- **无 secret 字段脱敏** — `describe()` 原样返回解析值；wire 面（RPC/UI）在暴露前必须对 `role('secret')` 字段脱敏。
