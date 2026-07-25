# Storage + Workspace 工程开发文档

> 施工范围：5 个新包，session 侧零 diff。规范正典：[Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)——本文只写工程拆解（目录/文件、class 落位、teammate 分工、并行依赖），接口语义以 Note 为准，冲突时改这里不改 Note（除非经用户拍板）。
> 门禁口径：GUI 免门禁期同款——不随手写测试门禁，跑 typecheck/build 保证编译；测试文件按仓库惯例落位（包级 `tests/`、`.spec.ts`），红绿在 PR 窗口收口。

## 0. 总览

```
packages/storage/
  storage/         dsh-storage         枢纽：Storage service + BackendRegistry + StorageForms
  storage-json/    dsh-storage-json    JsonStorageBackend（kv facet）
  storage-sqlite/  dsh-storage-sqlite  SqliteStorageBackend（kv facet）
  storage-domain/  dsh-storage-domain          DomainFacility + Domain + KvTable + domain/changed
packages/workspace/
  workspace/       dsh-workspace       WorkspaceRegistry + WorkspaceEntity + workspaceDomainSpec
```

依赖与并行关系（→ = 依赖）：

```
W1 storage(枢纽) ──→ W2a storage-json ──┐
                └──→ W2b storage-sqlite ─┼──→ 集成冒烟（W4 兼）
                └──→ W3 domain ──────────┘
                            └──→ W4 workspace
```

- W1 先行（接口包是所有人的编译依赖），完成后 W2a/W2b/W3 **三线并行**；W4 依赖 W3 的接口定型（不必等 json/sqlite 完工，可对着 W3 的类型先写，用内存假 backend 跑测试）。
- 每包的 package.json/tsconfig/README/invariant 伴生由该包 owner 自己配齐（模板照抄 `packages/session-persistence/session-persistence-sqlite/` 的形状）。

## 1. W1：`dsh-storage`（枢纽）——主线程自做

量小且是全组编译根，主线程直接写，不派 teammate。

```
packages/storage/storage/
  package.json                # 无运行时依赖；cordis peerDep + dev
  tsconfig.json
  src/index.ts                # Storage service + apply + 全部导出
  src/registry.ts             # BackendRegistry
  src/backend.ts              # StorageBackend/KvFacet/KvUnitDescriptor/KvUnit 类型
  src/error.ts                # StorageError + code 联合
  src/invariant.ts            # 见下
  tests/registry.spec.ts      # registry/mount 套件
  README.md
```

class/接口逐条（签名以 Note 为准，此处列实现要点）：

| 成员 | 实现要点 |
| --- | --- |
| `class Storage extends Service` | `super(ctx, 'storage')`；`readonly backend = new BackendRegistry()`；`mount(form, facility)` 存入私有 `Map<keyof StorageForms, unknown>`，重复 → `StorageError('duplicate-mount')`，返回删除闭包；`get domain()` 从 map 取，缺 → `StorageError('form-not-mounted')` |
| `class BackendRegistry` | 私有 `Map<string, StorageBackend>`；`register` 重名 → `duplicate-backend`，返回 `() => map.delete(name)`；`get` 缺名 → `backend-not-found`；`names()` 返回数组拷贝 |
| `interface StorageForms {}` | 空接口 + JSDoc（merge-extensible，键 = 数据形式名） |
| `interface StorageBackend / KvFacet / KvUnitDescriptor / KvUnit` | 纯类型 + 契约 JSDoc（七条契约写在 KvUnit 各方法 JSDoc 上——这是 backend 实现者的规范文本） |
| `class StorageError extends Error` | `constructor(code, message?, cause?)`；`name = 'StorageError'` |
| `const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` | 导出；descriptor 校验用（backend open 时验，fail loud） |
| invariant | 枢纽自身无运行时不变量（纯注册表，无事件流/可变盘面），写"explained empty"（措辞照抄 sqlite 后端 invariant.ts 的 "No runtime invariant:" 模板） |

事件面：本包**无**事件（`domain/changed` 归 dsh-storage-domain）。

## 2. W2a：`dsh-storage-json` —— teammate **json-backend**

```
packages/storage/storage-json/
  src/index.ts                # Config + apply + JsonStorageBackend
  src/unit.ts                 # JsonKvUnit
  src/atomic.ts               # temp+fsync+rename 原子写（含 win32 分支）
  src/format.ts               # 文件格式 parse/serialize + malformed 检查
  src/invariant.ts
  tests/json-backend.spec.ts  # 挂共享契约套件（见 §5）+ json 特有（文件肉眼格式、malformed）
```

| class | 要点 |
| --- | --- |
| `Config` | schemastery，`root: z.string().required()`（JSDoc 说明为何无默认：防 cwd 散落，参照 session-persistence 措辞） |
| `class JsonStorageBackend implements StorageBackend` | `name='json'`；`kv = { open }`；持 `Map<unitName, JsonKvUnit>`（同名重复 open → 复用还是报错：**报错**，unit 生命周期归调用方，double-open 是 bug）；`close()` 逐 unit close，幂等 |
| `class JsonKvUnit implements KvUnit` | 内存态 `{ version, global, tables: Map<string, Map<string, unknown>> }` 为权威；构造时读盘：文件缺失 = 空单元（不落盘），存在则 parse + 版本比对；每个写原语 = 改内存 → `writeAtomic(serialize())`；**写不排队**（契约第 4 条：串行是调用方的事），但单次 writeAtomic 内部完整（temp/fsync/rename）；close 后操作 → `closed` |
| `atomic.ts` | `writeAtomic(path, data)`：同目录 temp 文件 + fsync + rename；win32 分支照抄 `session-persistence-jsonl/src/win32.ts` 的替换语义（先照抄，`log` facet 迁移期再提共享——Note 已记）|
| `format.ts` | `serialize(unit): string`（`JSON.stringify(…, null, 2)` + 尾换行）；`parse(text): ParsedUnit`，缺 `unit` 头/结构不符 → `malformed-medium` |
| apply | `ctx.effect(() => { const d = ctx.storage.backend.register('json', backend); return async () => { d(); await backend.close() } })`；inject: `['storage']` |
| invariant | 断言候选：rename 发布后盘上文件必可 parse 回等价内存态（写后读回校验，仅测试态开启）；若判断无运行时可断言关系则 explained empty |

## 3. W2b：`dsh-storage-sqlite` —— teammate **sqlite-backend**

```
packages/storage/storage-sqlite/
  src/index.ts                # Config + apply + SqliteStorageBackend
  src/unit.ts                 # SqliteKvUnit
  src/schema.ts               # SCHEMA_VERSION + openDatabase + DDL
  src/invariant.ts
  tests/sqlite-backend.spec.ts
```

| class | 要点 |
| --- | --- |
| `Config` | `path: z.string().required()`（`:memory:` 允许）+ `journalMode` 枚举 default 'wal' |
| `schema.ts` | `STORAGE_SQLITE_SCHEMA_VERSION = 1`；`openDatabase(config)` 照抄 session-persistence-sqlite 的序列（mkdir 0o700 → wx 0o600 建文件 → PRAGMA foreign_keys → journal_mode → user_version 检查盖章/拒绝 → 建 `units`/`unit_globals`）；**先照抄不提共享 helper**（Note 已记：提取放迁移期） |
| `class SqliteStorageBackend` | `name='sqlite'`；单 `DatabaseSync` 连接；`kv.open(descriptor)`：校验名字字符集 → `units` 行版本比对（无行则 INSERT 盖章）→ 按 descriptor.tables 逐张 `CREATE TABLE IF NOT EXISTS "u_<unit>_<table>"` → 返回 unit；`close()` 关连接 |
| `class SqliteKvUnit` | 预编译语句（每表 upsert/delete/select-all + global upsert）；`loadAll` 全表 SELECT 组装；`putRecord` = `INSERT … ON CONFLICT(key) DO UPDATE`；单语句原子，无显式事务；value `JSON.stringify`/parse |
| invariant | 断言候选：STRICT 表 + user_version 与常量一致（open 后检）；或 explained empty |

## 4. W3：`dsh-storage-domain` —— teammate **domain-layer**

```
packages/storage/storage-domain/
  src/index.ts                # Config + apply + DomainFacility
  src/spec.ts                 # DomainSpec/defineDomain/domainTable + descriptorOf
  src/domain.ts               # DomainImpl + KvTableImpl + 写链
  src/events.ts               # domain/changed declaration merging
  src/error.ts                # DomainError
  src/invariant.ts
  tests/domain.spec.ts        # 用内存假 backend（tests/helpers/memory-backend.ts）
```

| class | 要点 |
| --- | --- |
| `Config` | `backend: z.string().required()` + `routes: z.dict(z.string()).default({})` |
| `spec.ts` | `defineDomain` 恒等函数（编译期收窄）+ 名字/表名正则校验（违规 throw，misconfiguration fails loud）；`descriptorOf(spec)` 投影 |
| `class DomainFacility` | 持 `Map<domainName, DomainImpl>`（already-open 检查）；`open(spec)` 按 Note 六步实现；zod 依赖在此包（dependencies，不是 peer） |
| `class DomainImpl` | 写链 `chain: Promise<void>`（`enqueue<T>(job): Promise<T>` 私有方法，所有写走它）；内存态 `Map<table, Map<key, value>>` + global；每写：链上 → 改内存 → unit 原语 await → `ctx.emit('domain/changed', …)`；dispose：`enqueue(noop)` 排空 → `unit.close()` |
| `class KvTableImpl<K,V>` | 读同步走内存；`update` fn 同步纯（类型上 `(current: V) => V`），缺 key → `missing-key`；`delete` 返回是否存在 |
| `events.ts` | 按 Note 全文（`@mode emit` + `@param`）；`DomainChanged` 接口导出 |
| invariant | 断言候选（真不变量，建议做）：**每次 `domain/changed` 事件的 value 必等于内存态当前值**（事件流 vs 可变数据的 owned relationship，正合仓库 invariant 规范）|
| tests/helpers/memory-backend.ts | `MemoryStorageBackend`：Map 实现 KvUnit，宣称版本可注入——共享给 W4 用 |

## 5. 共享 backend 契约套件 —— domain-layer 兼写（或主线程）

```
packages/storage/storage/tests/contract.ts      # export function runKvBackendContract(factory)
```

- 仿 `runPersistenceContract` 形状：`factory: () => Promise<{ backend, reopen(): Promise<StorageBackend> }>`，两后端 spec 文件各自 import 调用。
- 覆盖 Note 七条契约 + 版本拒绝 + close 幂等；"崩溃再 open"用 `reopen()`（新实例指向同一介质）模拟。
- 落在接口包 tests/ 下（不进 src，不发布），json/sqlite 的 devDependencies 指向 workspace 接口包即可复用。

## 6. W4：`dsh-workspace` —— teammate **workspace-domain**

```
packages/workspace/workspace/
  src/index.ts                # apply + WorkspaceRegistry（service 挂 ctx.workspace）
  src/types.ts                # WorkspaceId brand + Workspace 接口
  src/spec.ts                 # workspaceRecord zod + workspaceDomainSpec
  src/entity.ts               # WorkspaceEntity（不出包：index.ts 不 re-export）
  src/paths.ts                # realpathNormalize(path)
  src/invariant.ts
  tests/workspace.spec.ts     # MemoryStorageBackend + 假 sessionPersistence stub
```

（删除入口本期不存在：registry 无 delete、entity 无关联清理——整套删除语义在 Agent Note 的 future work 节。）

| class | 要点 |
| --- | --- |
| `types.ts` | `WorkspaceId` brand + 工厂；`Workspace` 接口（Note 签名照录，JSDoc 齐全——这是对外契约） |
| `spec.ts` | `workspaceRecord`（path/title/sessionIds/createdAt/updatedAt）+ `workspaceDomainSpec = defineDomain({ name: 'workspace', version: 1, tables: { workspaces: … } })` |
| `paths.ts` | `realpathNormalize(p): Promise<string>`——`fs.realpath`；ENOENT 原样抛（create 的 reject 路径） |
| `class WorkspaceRegistry extends Service` | `super(ctx, 'workspace')`；inject `['storage', 'sessionPersistence']`（sessionPersistence optional：`ctx.get()` 取，缺席时 attach 拒绝）；`start()`：`ctx.storage.domain.open(workspaceDomainSpec)` + 重建 `Map<WorkspaceId, WorkspaceEntity>`；`create`：realpath → resolveByPath 撞 → reject；否则 `WorkspaceId(randomUUID())` + `table.put` + 建实体入缓存；`list()` 快照数组（过滤无效 sessionId 的投影在实体 getter 做）；**无 delete 方法**（future work，与 session 级联一体落地） |
| `class WorkspaceEntity implements Workspace` | 构造持 registry/id/record；getter 投影；`mutate(fn)` 私有：`table.update(id, r => stampUpdatedAt(fn(r)))` 后原地换 record；`attachSession`：读 `sessionPersistence.list()` 找 header（或 inspect），cwd realpath ≠ path → reject；幂等（已在账 → no-op）；`detachSession` 摘账（不动 session 文件）；`status()`：`fs.access(path)` |
| 一致性口径 | ①账指向的 session 查无：**投影过滤**（getter 层）+ 下次 mutate 摘除；③双重账 load 检出 → throw；④missing-dir 只反映在 status() |
| invariant | 断言候选：缓存实体集合与 domain 表 key 集合一致（owned relationship：registry 缓存 vs 权威盘面）|

## 7. Teammate 编成与节奏

| teammate | 包 | 开工条件 | 预估节奏 |
| --- | --- | --- | --- |
| （主线程） | W1 storage 枢纽 + §5 契约套件骨架 | 立即 | 首批落盘，随后进入 review/dispatcher 角色 |
| json-backend | W2a | W1 类型可编译即开工 | 分批落盘：atomic/format 先行，unit 次之，契约套件接入收尾 |
| sqlite-backend | W2b | 同上 | schema.ts 先行（照抄源已指明），unit 次之 |
| domain-layer | W3 + memory-backend helper | 同上 | spec/error 先行 → DomainImpl 写链 → 事件 → 契约套件（若主线程未完成则兼） |
| workspace-domain | W4 | W3 的 src 类型定型（不等其测试） | types/spec/paths 先行 → registry/entity → 测试 |

协作规矩（照 conventions）：分批落盘每批几分钟内、每批一句话回执；产出零落盘超 5 分钟报告；不混 commit 别人的在途文件；代码注释一律英文且只写非显然契约；干完不 kill 保持待命。commit 纪律：`--no-verify`，按包分刀（W1 一刀 → W2a/W2b/W3 各一刀 → W4 一刀 → 测试/文档尾刀），文档（本文件 + Agent Note 增量）住顶刀。

## 8. 主线程验收清单（每包合入前）

- [ ] `pnpm run typecheck` 过（本期唯一硬门禁）
- [ ] 包结构齐：package.json（`@deepseek-ai/dsh-*`、ESM、cordis peerDep）、README、invariant 伴生（真断言或 explained empty）
- [ ] 接口与 Agent Note 一致；发现实现逼着改接口 → 停下来报主线程裁决（不擅改 Note）
- [ ] 测试文件落位正确（包级 tests/、`.spec.ts`），能跑多少跑多少，红的记台账不追修
- [ ] session-persistence 包零 diff（`git status` 检查线）
