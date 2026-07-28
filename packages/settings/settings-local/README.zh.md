# @deepseek-ai/dsh-settings-local

[English](README.md) | 中文

文件 settings provider。一个 YAML 或 JSON 文档承载全部 namespace 分节；外部编辑经 `ctx.settings` 热发布，`update()` 原子写回，并保留用户的 YAML 注释以及当前未加载插件所拥有的分节。

## 配置

| 字段 | 含义 | 默认 |
|---|---|---|
| `path` | 设置文档路径；扩展名决定格式（`.yaml`/`.yml`/`.json`） | harness home 下的 `settings.yaml` |
| `dshHome` | `path` 省略时使用的 harness home | `$DSH_HOME` 或 `~/.dsh` |
| `watch` | 监听文档并热发布外部编辑 | `true` |
| `debounceMs` | watcher 写入稳定窗口（毫秒） | `100` |

默认值解析是一步显式的 `resolveSpec(config)`；不支持的扩展名在加载时报错。

## 行为

- **启动报错响亮，重载保留最后可用值。** 存在但非法的文档使插件加载失败；运行中不可读或不可解析的编辑只告警并保留最后可用分节。文档缺失时所有 namespace 按默认值与 `base` 解析；删除文档发布同样的空状态。
- **写回原子且仅属主可读。** `persist` 以 `0600` 权限写 `<path>.tmp` 后 rename 覆盖目标。YAML 写回在保留注释的文档里只修补目标 namespace；JSON 重新序列化。
- **按内容抑制自写。** provider 缓存最后可用文本；watcher 事件内容与缓存相同（含自己的写入）即为 no-op。

## Model Experience

间接生效：本 provider 只存储并发布 namespace 分节，模型效果经由 `ctx.settings` 的消费插件产生，由各消费者自己的文档描述。

#### KV Cache effect

无直接失效；请求前缀的变更由消费插件拥有。

## Known Limitations and Deferred Work

- **无跨进程写锁** — 并发写入者（例如同一 home 上的 TUI 与 web）靠原子替换加 watcher 重载收敛，后写胜出；lockfile 等真实冲突出现再做。
- **注释保留仅限 YAML** — JSON 文档重新序列化，无注释（JSON 本身没有）且丢失手工排版。
- **无值间接引用** — 分节存字面值；面向密钥的 `${env:VAR}` 式引用是 seam 层的延后特性。
