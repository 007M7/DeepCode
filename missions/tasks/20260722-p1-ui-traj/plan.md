# ui-trajectory P-I 占位视图（ui-traj 属地档案）

**一句话计划**：三刀落 ui-trajectory 纯消费型插件——刀1 双入口骨架（src/client/ apply+inject+两条 registerView+两个占位组件+tsdown/paths/package.json 工程件），刀2 chrome.header 统计条+占位 span 派生，刀3 包内 jsdom spec（两 tab 注册/切换/chrome 渲染/不塌 chat）+tsdown 产物 loadPlugin 形状验证。

范围 = v3 §8 ui-trajectory 行：零 service、零 declare module 'cordis'，只 merge ConversationViewMap{trajectory,waterfall} + registerView 两条 + chrome.header 第二挂点实证；占位不要求效果（P-I 台账 #3）。

## 备案

- **merge 目标取 `/client` 子路径**：v3 §7 示例写 `declare module '@deepseek-ai/dsh-client-ui-conversation'`（根），但 §6b 双入口拆分后 ConversationViewMap 真身在 `@deepseek-ai/dsh-client-ui-conversation/client`——对根路径 merge 挂不到真身（T0 桩即如此，无效 merge）。实现按现状对 `/client` merge；契约文本待对账时更新措辞。
- runtime 只用类型（ConversationSnapshot 节点收窄），按 §4 type-only devDep 豁免口径入 devDependencies；不动 pnpm-lock（他人在途改动，PR 窗口统一 install 对账）。

## 刀序台账

- 刀1 双入口骨架：✅ 21ebdd606（client/index.ts apply+inject=['conversation']+merge 对 /client+两条 registerView、Trajectory/Waterfall 占位组件、css-modules.d.ts、node 半边去桩、package.json ./client 带 types+bundle/watch 脚本+runtime type-only devDep、tsdown.config 三行式、tsconfig +runtime ref、tsconfig.base +/client paths）
- 刀2 chrome.header+span 派生：✅ 293c68437（spans.ts per-turn 折叠 steps/calls/nodes、TrajectoryStatsHeader 两视图共用 chrome.header 第二挂点、两视图吃 span 派生真渲染，--dsw-* token；只订 nodes 引用 streaming 静默）
- 刀3 包内 spec+tsdown 产物验证：✅ 4767249fa（views.spec.tsx 7 例：真 ConversationService 注册序/fiber 卸载不塌 chat/三 tab 切换含 chrome.header 断言/空窗口空态/span 派生边界；client-bundle.spec.ts 3 例：loadPlugin handoff id+DI require+object-plugin 挂载注册两视图+CSS style 注入，dist 未构建自 skip。测试基建强制 invariant 伴生随刀补齐——纯消费型 explained-empty）

## 排坑记录

- vitest jsdom pool 里 `import.meta.url` 是 http scheme，`fileURLToPath` 抛 ERR_INVALID_URL_SCHEME 且被 try/catch 吃掉导致产物 spec 静默全 skip——bundle 读取改 repo-relative `resolve()`（vitest 从仓根跑）。runtime 的 client-loader-bundle.e2e.ts 无此问题因为 e2e lane 不走 jsdom。
- `scripts/test-invariants.ts` 对任何 `ctx.plugin()` 的包测试强制 `src/invariant.ts` 伴生存在（GUI 免门禁期也躲不开——它挂 vitest setupFiles，不在门禁序列里），照 ui-conversation 模板补 explained-empty+package.json ./invariant 导出+peerDep/devDep+tsconfig ref 即可。
- pnpm exec 在 package.json 变更后自动触发全仓 install（约 15s）——包内跑 tsdown/vitest 前若刚改过 manifest 属预期，非网络故障。
