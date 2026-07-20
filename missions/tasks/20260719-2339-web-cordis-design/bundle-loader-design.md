# 产物 bundle + Loader 拉包链路（明细设计）

> 2026-07-20。正式稿 [design.md](design.md) §5 的明细展开；裁决基线=blueprint-v2（bundle dist.js/强制 external/启动器注入/按 ID 经 web server 代理拉取）。本文明细中标注【选型】的项给理由，标注【关键设计点】的项给选项+推荐，供用户 review 圈定。

## 1. 每插件单独打包

**【选型】构建器 = tsdown**（不用 vite lib mode）：仓库运行时 bundle 本就是 tsdown（构型统一、共享 preset 即「全员共用的特殊编译方式」的落点）；vite 只活在 apps/web 应用层，给每个插件包引 vite 是第二套构建系统。tsdown 原生支持 esm 单文件+external+独立 d.ts 发射，够用。

| 项 | 定案 |
|---|---|
| entry | `src/client.ts`（`./client` 出口的源头） |
| format | esm 单文件（非 CJS——浏览器原生 import） |
| 产物 | `dist/client.js`（+ `.map`）；`.d.ts` 走既有独立发射（类型消费者是 TS program，不经 bundle） |
| target | 浏览器基线（es2022；与 apps/web vite target 对齐，实施时取同一常量） |
| sourcemap | 带（dev 排障必需）；发布裁剪与否随第三方开放一并议（§6 台账） |

**依赖处置判据**（三条规则，不是清单）：

| 判据 | 处置 | 例 |
|---|---|---|
| **跨边界身份**：对象要 apply 进宿主 ctx / 与宿主共享 class 身份（instanceof、Symbol） | **不打进 bundle**：`import type` 只取类型，运行时实体经启动器参数注入（§2）——插件运行时零跨边界 import | cordis（Context/Service）、cosmokit（若暴露类） |
| **纯值语义**：只被鸭子协议消费（调方法不验身份） | **一律内联**（各 bundle 自带副本） | zod（peer 框架经 StandardSchemaV1 鸭子协议调 parse，不 instanceof——这正是 §6a zod 红利的用处）；插件私有依赖 |
| **插件自有代码** | **一律内联**（bundle 自包含） | `./shared` 的 peer 声明（值 import 进 client 半边） |

结果：bundle **没有任何运行时裸包名 import**——依赖供给全走 §2 参数注入，不依赖浏览器模块解析配置。

## 2. 启动器形态（终裁：DSHClientProxy 命名空间注册，bundle 不 export）

**bundle 不 export 任何东西**——执行时主动调框架命名空间对象的注册方法。全局面只占一个名字 **`window.DSHClientProxy`**（用户定名；不带下划线前缀——是否加防撞前缀曾议，以此拼写为准）：

```ts
// dist/client.js 的执行效果（包装层由构建自动生成，见下）
window.DSHClientProxy.loadPlugin({
  id: 'echo',                          // = 插件 ID（与 node 半边同 ID，1:1 对等的钥匙；Loader 对账用）
  callback() {                         // 惰性工厂：注册 ≠ 实例化
    return {
      Config,                          // zod schema（config 同源下发后 client 侧再 parse；zod 为内联副本）
      apply(ctx: ClientContext, config: Config): void { … },
    }
  },
})
```

**DSHClientProxy = client 侧框架总入口**，框架未来能力都长在此对象上、不再新增全局（「还能干别的」是设计动机）：

| 成员 | 职责 |
|---|---|
| `loadPlugin({id, callback})` | 插件注册口（本节协议） |
| `newContext()` | client realm 的 cordis Context 创建也经它——web-runtime boot 里 `new Context()` 那步统一走此口（形态提案：方法返回新 realm 的 Context；boot 自己也是消费者） |
| `version` | 供 bundle 兼容自检 |
| （按需生长） | 调试钩子、registry 查询等 |

- **callback 惰性层的价值**：主框架先收齐注册、再按自己的序点火——实例化时机/依赖序完全归主框架，bundle 执行只表达「我到了」。
- **预置与防御**：`window.DSHClientProxy` 由 web-runtime boot 在拉任何 bundle 前挂好（loadPlugin+newContext+version 起步）；防御一句——若 bundle 因缓存等原因先于 boot 执行（理论不应发生），入口脚本顶部的极小 shim 缓冲注册、boot 后重放。
- **依赖供给 = apply 参数注入**（不变）：宿主构造 `Context` 经 `apply(ctx, config)` 传入；插件对 cordis 的耦合面=`ClientContext` 类型（`import type`，编译后消失）。bundle **零运行时 import**（cordis 从参数来、zod/shared 内联）——双实例问题消解为无问题，成本只是体积（§6 台账）。
- **包装层自动生成**：`DSHClientProxy.loadPlugin({id, callback})` 调用壳由 tsdown 共享 preset 的 banner/footer 生成（id 取自包声明）——**插件作者只写 apply（与 Config）**，注册协议零手写。
- **备胎（不实施）**：共享实体注入——DSHClientProxy 下挂运行时实体 + tsdown `globals` 映射。触发条件：出现参数注入覆盖不了的共享需求（如插件间共享同一大型运行时实体）。

**单例部署、多例可测**（实现约束，正面写成设计约束——G-2 getSessionManager 单例的教训不再重演）：

1. DSHClientProxy 的全部状态（注册表/「创建中」集合/hold 队列/newContext 产出的 realm 引用）**收在实例内，禁止模块级状态**（仓内先例教训：rpc-log 模块级 Map 跨实例串味、boot 重入——同族问题已收编两次）。
2. window 挂载只是 boot 时的**部署动作**（`createDSHClientProxy()` 工厂 + `window.DSHClientProxy = 实例`），不是构造约束。
3. 测试维度：vitest 直接 `new` 多实例并行验证（注册隔离/各自 loadPlugin 不串/各自 newContext 独立 realm/dispose 互不影响），不经 window。这同时是将来多 runtime 场景（并行测试/Electron 多窗/一页多 host 连接）的预埋。

## 3. Loader 拉包链路

```
host 侧                                      client 侧
────────                                     ────────
Loader 加载插件 node 半边
  └─ resolve `./client` 出口 → dist/client.js 物理路径
  └─ 登记清单条目 {pluginId, clientUrl, version}
        │
        │  ①插件清单（boot/重连 unary 拉取；含 reload 事件的更新面）
        ▼
                                             收到清单
                                             └─ 「创建中」集合登记（hold 判据开窗）
                                             └─ ② 加载 bundle（import(url) 或 script 注入，见选型）
                                             └─ ③ bundle 执行 → DSHClientProxy.loadPlugin({id, callback}) 注册
                                                  └─ id 对账：自报 id ≠ Loader 预期 → plugin-load-failed
                                             └─ ④ 主框架点火：callback() → ctx.plugin(工厂产物, config)
                                             └─ ⑤ apply 完成 → 创建中集合移除
                                                  → drain 该插件 hold 队列（§4.3 三出口）
```

**【选型】加载方式：import(url) 与 script 注入并列**——全局注册协议下 bundle 不 export，加载方式只需「把脚本跑起来」，两者都成立：

| 方式 | 机制 | 错误通道 |
|---|---|---|
| **`import(url)`（推荐）** | 执行副作用即注册（不读导出）；仍是 esm 模块作用域 | import reject 直接可捕获 → `plugin-load-failed` |
| `<script>` 注入（候选，不再排除） | 无 export 约定后回到候选；经典脚本或 module 均可 | `window.onerror` + 超时兜底 + id 对账三层拼 |

推荐仍取 import(url)：错误通道是原生 Promise 一层，不用拼三层。**id 对账**（两种方式共用）：注册的自报 id 与 Loader 本次加载预期比对，不符=`plugin-load-failed`（防分发端点错配/缓存串包）。blob URL 留给将来校验形态（§6）。

时序要点：「创建中」登记发生在**收到清单时**而非加载时——host 通知先行（blueprint §6a.2 的根据），加载/注册/点火/apply 全程都在 hold 窗口内；apply 是唯一关窗点。注册到点火之间的间隔归主框架（依赖序调度的自由度即在此）。

## 4. web server 分发端点

| 项 | 定案 |
|---|---|
| URL | `GET /plugins/<pluginId>/client.js`——web server 静态映射到该插件包 dist/client.js（物理路径来自 host 清单 resolve，不做目录遍历；未知 id=404） |
| 缓存 | 清单里的 `clientUrl` 带版本戳 query（`?v=<content-hash>`）→ 响应 `Cache-Control: immutable` 长缓存；**reload 失效=清单里版本戳变、URL 天然换新**，无需主动失效。etag 兜底（dev 与无戳访问） |
| dev 模式 | tsdown `--watch` 持续出 dist/client.js；web server 每请求读盘+etag（dev 不给 immutable）。插件产物**不进 vite module graph**（它是独立 bundle），无 HMR——reload 靠清单版本戳+页面刷新（§6 台账） |

## 5. 内部包与第三方的差别

- **内部包**：tsdown 共享 preset 加一份 client 编译形态（`entry: src/client.ts` + 浏览器 target + banner/footer 注册包装层自动生成），住仓库级共享配置、各包引用——包内只声明「我有 client 半边」，插件作者只写 apply，形态零自造。
- **第三方（预留一段，不实施）**：构建约定文档化（entry/format/external 清单/default 启动器形状/版本戳），加完整性校验（hash/签名）后才开放拉取面；分发端点届时可能从「映射内部 dist」升级为「注册制产物库」。

## 6. 妥协台账（触发条件 → 返工点 → 预埋要求）

| # | 妥协 | 触发条件 | 返工点 | 预埋要求 |
|---|---|---|---|---|
| 1 | 产物无完整性校验 | 第三方插件出现 | 拉包链加 hash/签名验证（届时 fetch→校验→blob URL import 的形态替换裸 import(url)） | 清单条目已带 version（content-hash），校验字段 additive |
| 2 | 无版本协商 | 插件产物与 host 独立发布 | 清单加 minHostVersion 类字段+握手拒载 | client/host 绑定发布期不需要；清单结构留扩展位 |
| 3 | dev 无 HMR（reload=刷新页面） | 插件开发迭代痛感实证（改一行等一轮刷新不可忍） | 清单 reload 事件→client Loader 卸旧 fiber+重 import 新 URL | reload 事件已是更新面约束（blueprint 四问②）；fiber dispose 语义 cordis 已有 |
| 4 | zod 各 bundle 内联副本（StandardSchemaV1 鸭子协议，无身份问题；成本=每 bundle 体积增量） | bundle 体积实证超预算 | 共享供给面（备胎全局注入路线，或届时再议） | 鸭子协议保证共享/内联语义等价，切换零 API 变化 |
| 5 | 依赖供给走参数注入不走 ESM 共享（import map 方案被否） | 出现参数注入覆盖不了的共享需求（插件间共享同一大型运行时实体） | 备胎共享实体注入：DSHClientProxy 下挂实体 + tsdown globals 映射 | 判据表已定「跨边界身份」集合，切换只动供给面不动插件源码形态 |
| 6 | 全局面占 window.DSHClientProxy 一个符号（bundle 不 export，注册面不走模块系统） | 宿主页面符号冲突，或多 runtime 并存需部署多实例 | 部署面改造（如按 runtime 实例命名挂载）——工厂+实例内状态已就绪（§2），只动 window 挂载一行 | 命名收单一常量（web-runtime boot 与 tsdown preset 同源引用）；createDSHClientProxy 工厂与零模块级状态是硬约束 |
