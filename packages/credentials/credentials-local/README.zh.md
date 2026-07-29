# dsh-credentials-local

[English](README.md) | 中文

文件型[凭据](../credentials/README.md) provider：两层来源，一条诚实的优先级。

| 层 | 来源 id | 可写 | 优先 |
|---|---|---|---|
| 活跃进程环境 | `env` | 否 | 恒定优先 |
| `$DSH_HOME/.env` 文档 | `file` | 是（`set`/`unset`） | 其余情况 |

环境优先，因为启动时覆盖（`DEEPSEEK_API_KEY=… dsh`、CI 机密、加载了仓库 `.env` 的开发 shell）代表本次运行的操作者意图——而它无法从进程内部修改，就必须*可见地*只读：`describe()` 报告 `source: 'env', writable: false`，`set`/`unset` 直接拒绝，而不是写下一个读取方永远看不到的变更。解析实时读取 `process.env`，绝不写回。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `path` | `<harness home>/.env` | 凭据文档位置。 |
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | `path` 缺省时使用的 harness home。 |
| `watch` | `true` | 热发布外部编辑。 |
| `debounceMs` | `100` | watcher 写入稳定窗口。 |

## 文档本身

dotenv 格式，用 `dotenv` 解析；写回用行级编辑器，保留一切不属于本次编辑的字节：`set` 原位改写该键的第一条赋值行（丢弃后续重复行——dotenv 按最后一条生效，重复行会反过来覆盖这次编辑），`unset` 只删除所属行，注释与无关行逐字保留。落盘经 [`dsh-atomic-write`](../../util/atomic-write/README.md)，权限 `0600`。

值按 dotenv 能逐字读回的最窄样式渲染——裸值，其次单引号（完全字面），再次双引号（仅限无反斜杠，双引号读取会展开转义）。任何样式都无法表示的值，以及已经跨越多个物理行的条目，都会响亮失败而不是被静默破坏。空的存储值等于不存在（seam 规则）。

## 热重载

外部编辑在快照**整体替换**后按变更引用逐个发布 `credentials/updated`——磁盘上删掉的条目绝不在内存滞留。provider 自己的写入按内容识别，只发布属于该次提交的一个事件。运行期文档不可读时保留最后可用快照并告警；文件不存在即空存储；启动时不可读则响亮失败。非 POSIX 标识符的键属于被保留的文件内容，seam 无法寻址。

## Model Experience

经由消费它的 LLM 适配器间接生效：存储的值为适配器的提供方请求授权，每个模型可见面都归适配器所有。

#### KV Cache effect

无直接失效；凭据绝不进入请求前缀。

## Known Limitations and Deferred Work

- **多行条目拒绝 `set`/`unset`**——行编辑器不改写会被它破坏的条目；请直接编辑文件。
- **无法表示的值响亮失败**——控制字符，或同时混用两种引号又含反斜杠的值，无法在 dotenv 行格式中往返。
- **环境变化不可见**——每次解析实时读取 `process.env`，但那里的变化不可能发出事件。
- **原子但不保证崩溃持久**——继承自 `dsh-atomic-write`；存储在启动时重新读取。
