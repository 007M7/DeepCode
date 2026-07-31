# Agent Note: composer 的字形层跟随 textarea 的滚动偏移

Status: implemented

[English](2026-07-31-composer-glyph-layer-tracks-the-textarea.md) | 中文

## 问题

草稿一旦超过 14 行的高度上限，就无法再滚动。光标会动，选区会动，但文字始终冻结在第 1 行——无论滚轮、拖拽还是方向键，都无法把长草稿的末尾带到可见范围内，因此约 14 行之后的内容在书写过程中既够不着也读不到。

高度上限本身是正常工作的。composer 的文本由两层叠放绘制（见 [InputBar](../../../../packages/client/ui-conversation/src/client/skeleton/InputBar.tsx)）：`<textarea>` 持有取值、选区与光标，但它自己的字形以 `color: transparent` 渲染；用户看到的每一个字符都由其下的 `[data-input-backdrop]` 层绘制，该层同时承载 claim token 高亮、chip 与提示影子文本。这一拆分正是 chip 与高亮得以存在的前提——textarea 无法为自身文本的某个区间单独设置样式。

两层在几何上是耦合的，在滚动上却不是。backdrop 为 `position: absolute; inset: 0; overflow: hidden`：它只做裁剪，不做滚动，浏览器也不会把它的偏移与 textarea 关联起来。未达上限时这一点不可见，因为两层都停在偏移 0，且镜像层会把盒子撑到草稿的高度。一旦触及上限，textarea 开始滚动而 backdrop 不跟随，于是用户真正在读的那一层从不移动。

因此该缺陷与高度上限同龄，并且藏在静止状态背后：短草稿——也就是所有截图与既有 fixture（测试前置数据）所捕获的那个状态——在有无该耦合时渲染完全一致。

## 决策

`InputBar` 把 textarea 的 `scrollTop` 镜像到 backdrop 上，来自两处：

- textarea 上的 `scroll` 监听，与既有的滚轮接力监听注册在同一个 effect 中（textarea 从不卸载——失效状态渲染的是同一个元素的 disabled 形态）。它覆盖所有手势，以及浏览器因光标而执行的每一次滚动。
- 一个以已提交草稿为 key 的 layout effect。一次编辑会让两层重排，却不一定让 textarea 移动——光标仍在可见范围内时不会触发 `scroll` 事件——而草稿变短时两层各自独立地被钳位。

两者都把 textarea 的偏移写给 backdrop，绝不反向：textarea 是权威方，因为它持有光标，而浏览器滚动的目标正是光标。

## 曾考虑的替代方案

**给 backdrop 加 `overflow: auto`，让它自行滚动。** 那样它就有了一个属于自己的滚动偏移需要同步，问题原样保留，还额外多出一条画在输入框上的滚动条。backdrop 是 textarea 的投影，而不是一个可独立导航的界面。

**去掉 backdrop，直接为 textarea 自身文本设置样式。** 这会消除分层，连同整类失步问题一并消除。之所以否决，是因为它根本无法实现：textarea 只渲染一段统一的文本流，因此 claim token 高亮、chip 与提示影子文本——backdrop 存在的全部理由——都无从表达。为修滚动而放弃它们，是拿一个有界的缺陷去换一次功能删除。

**改用 `contenteditable` div 承载草稿，不再用 textarea。** 一个元素、一个滚动偏移、区间可设样式。之所以否决，是它与该缺陷的体量严重不相称：`contenteditable` 会把 IME 组词、撤销／重做、选区语义与粘贴规范化重新压回我们身上，而这些目前都由 textarea 加输入状态机处理，且状态机已持有一份以 textarea 取值语义为前提的撤销日志。

**在既有的滚轮处理函数里滚动 backdrop，而不是新增 `scroll` 监听。** 该处理函数本就在 textarea 上的每次滚轮时运行，看似是自然的落点。之所以否决，是它只覆盖了盒子滚动的其中一种成因：在末尾输入、`End`、方向键、拖选越过边缘、拖动滚动条，都会在没有滚轮事件的情况下移动 textarea。监听 `scroll` 是在监听事情本身，而不是它的某一个成因。

**在 `onChange` 处理函数里同步，而不用 layout effect。** 之所以否决，是它在 React 把新草稿提交到 backdrop 之前触发，因而会按上一次的布局做镜像。layout effect 在提交之后、绘制之前运行，那正是两层同时处于最新状态的时刻。

## 后果

- 超过上限的草稿会滚动其字形。浏览器场景实测：在 40 行草稿上做一次滚轮手势后，最后一行位于可见盒子之内，第一行已滚出上方；此前最后一行仍停在盒子下方整整一个草稿高度处，而 textarea 自身的偏移已经移动了。
- 该耦合是单向且廉价的——两次对一个数字的赋值，没有测量，除 `scrollTop` 外没有额外的布局读取——因此不会给输入路径增加开销。
- chip、claim token 高亮与文本引用标记在滚动时始终与其字形对齐，因为它们定位在 backdrop 内部并随之移动。装饰扫描本身没有任何改动。
- composer 的双层设计保留了这一隐患：日后在 backdrop 旁新增的任何一层都需要同样的镜像。e2e 场景断言的是用户真正关心的关系（哪一行在屏幕上），而非实现机制，因此无论层数变成多少它都成立。

## 验证

[input-bar.spec.tsx](../../../../packages/client/ui-conversation/tests/input-bar.spec.tsx) 中的单元用例证明镜像路径确实执行：它对两侧偏移都做了桩替换——因为 jsdom 对任何元素都报告 `scrollHeight === clientHeight` 且从不滚动任何元素——并断言 backdrop 跟随 textarea 的 `scroll` 与一次已提交的编辑。撤掉那个 `ref` 会让它失败。

用户可见的事实需要真实引擎，因此 [composer-draft-scroll.e2e.ts](../../../../apps/web/tests/composer-draft-scroll.e2e.ts) 在 chromium 中针对构建产物客户端测量它：在全新工作区空白会话的 composer 中放入 40 行草稿，零模型调用，用一个跨越 backdrop 自身文本的 DOM Range 报告首行与末行相对于可见盒子的位置。一个防空转守卫会先断言草稿确实溢出了设有上限的盒子。

已双向确认。撤掉镜像并重新构建各包后，滚轮用例在两层偏移上失败，编辑用例随之失败，golden 差异读作 `last draft line is on screen: false` 而 `textarea moved: true`——即以 fixture（测试前置数据）形式陈述的原始现象。静止状态用例在两种构建下都通过，这正是要点所在：它就是掩盖了该缺陷的那个状态。

注意 composer 随客户端模块 bundle 一同发布，因此仅运行 `pnpm run build:web` 不会纳入对 `InputBar.tsx` 的改动——必须运行包构建，浏览器测试通道才能看到它；针对陈旧 `lib/` 运行的场景，断言的是比当前工作树更旧的客户端。
