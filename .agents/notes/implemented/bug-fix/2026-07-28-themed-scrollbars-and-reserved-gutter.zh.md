# Agent Note: 滚动条 token 有了消费方，工作区列表预留出滚动条空位

Status: implemented

[English](2026-07-28-themed-scrollbars-and-reserved-gutter.md) | 中文

## 问题

`design-platform.css` 在亮色与暗色两套调色板中都声明了四个 `--dsw-alias-scrollbar-*` token（`bg-l1`、`bg-l2`、`hover-l1`、`hover-l2`），而客户端里没有任何一条规则读取它们。定义了却无人消费的 token 构不成主题：所有滚动区域渲染的都是浏览器自带的滚动条，它对调色板一无所知，因此暗色主题下暗色表面上出现的是一条亮色的原生滚动条。

暴露这一缺口的可见症状出在别处。工作区浏览器的会话列表（`WorkspaceBrowser.module.css` 中的 `.list`）是侧边栏里唯一的滚动区域，而每一行的尾部内容都紧贴该行 8px 的右内边距——`rows/Rows.module.css` 中的 `.time` 取 `flex: none`，hover 时取代它的操作按钮也是如此。于是覆盖式滚动条会画在相对时间戳之上。只在这一个列表里预留空间，滚动条本身仍然没有主题，因此两部分合为一次变更。

## 决策

`packages/client/ui-theme/src/styles/scrollbar.css` 是这四个 token 的唯一消费方，也是壳的导入链（`packages/client/web/src/base.css`）中第五张 ui-theme 样式表。它排在 `design-platform.css` 之后，因为它读取那张样式表的 token。

规则挂在 `body` 上，而非 `html`。`design-platform.css` 在 `body` 上声明 `--dsw-alias-*` token，暗色覆盖挂在 `body[data-ds-dark-theme]` 上，而自定义属性只向下继承；挂在 `html` 上的规则会把它们解析为 guaranteed-invalid 值，此时 `scrollbar-color` 计算为 `auto`，主题完全不起作用。

`scrollbar-width` 与 `scrollbar-color` 声明在 `body, body *` 上，而不是只在顶层声明一次。继承传下去的是已经在 `body` 处代入完成的颜色值，因此后代元素重新绑定这层间接变量也无法改变自己的滚动条；逐元素重新声明使每个元素按它自己看到的取值代入变量。`scrollbar-width` 本身就不是可继承属性，无论如何都需要逐元素声明。`::-webkit-scrollbar*` 伪元素同样不继承，因此以不加限定的选择器匹配。

两侧都读取同一组间接变量 `--dsh-scrollbar-thumb` 与 `--dsh-scrollbar-thumb-hover`，它们在 `body` 上绑定到 l1（基础表面）token。**这就是重新绑定契约，也是单看 CSS 无法得知的部分**：抬升表面在自己的容器上设置 `--dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2)` 与 `--dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2)`，这一次重新绑定同时作用于标准属性和 WebKit 伪元素。这组变量必须成对重新绑定；只改静止态滑块会让 hover 状态仍留在基础表面的 token 上。目前有四处抬升表面做了重新绑定：命令浮层、斜杠菜单、模型选择面板与设置面板。后两者把声明写在抬升面板上而非滚动的后代元素上，因为抬升层级是这个表面的属性，而自定义属性会继承到真正滚动的那个子元素。

轨道与两条滚动条相交的角落保持透明，因此滑块是以其下滚动的任何表面为背景被看到；只有滑块及其 hover 状态带 token 颜色。

`.list` 声明 `scrollbar-gutter: stable`，使滚动条位于行的旁边而非行的上方。取 `stable` 而非 `auto`，因为 `auto` 只在列表确实溢出时才预留空位：那样展开一个工作区分组时，所有行会在列表开始滚动的那一刻发生水平位移。`stable` 的预留是无条件的，行不会移动。

## 曾考虑的替代方案

**在每个滚动组件的样式表里各写一份 `::-webkit-scrollbar` 规则。** 之所以否决：客户端共有分布在九个包中的十三个滚动容器，每一个都要带上同一段规则，而第十四个会在没有任何门禁报错的情况下漏掉主题。由设计 token 驱动的皮肤应当归属于拥有这些 token 的包。

**提供一个工具类，由各滚动容器自行加上。** 重复同样被消除，但失败方式依旧存在：新的滚动容器只有在作者记得加类名时才有主题，而遗漏在评审中看不出来。`body, body *` 这种写法没有需要记住的启用步骤；确实想要不同滚动条的容器可以覆盖间接变量，这与抬升表面使用的机制相同。

**把这两个属性绑定在 `html` 上。** 这是文档级皮肤最自然的落点，而它的失败是可测量的：规则挂在 `html` 上时，chromium 中滚动容器计算出的 `scrollbar-color` 为 `auto`，因为别名 token 在那个作用域内不存在。

**只声明一次，靠继承下传。** 匹配的元素更少，但它破坏重新绑定契约——继承携带的是代入后的颜色，而不是变量引用，因此抬升表面无法给自己的滚动条换色。它本身也不完整，因为 `scrollbar-width` 不继承。

**改用内边距而不是预留空位（给 `.list` 加右内边距，或把 `.time` 向内移）。** 之所以否决：内边距无论滚动条是否存在都生效，因此在常见的短列表情形下白白占用横向空间；而且它只修好一个容器，其余每个滚动区域的内容仍然压在滚动条之下。

**给 `.list` 用 `scrollbar-gutter: auto`。** 空位在列表溢出时出现，也就是滚动条存在的时候。之所以否决：侧边栏的列表会随分组展开与收起而伸缩，因此空位会在用户光标之下出现又消失，并带动行一起位移。

## 后果

- 客户端的每个滚动容器都绘制带主题的滑块：亮色基础表面为 `rgb(229, 229, 229)`，暗色基础表面为 `rgb(60, 60, 61)`，重新绑定到 l2 的暗色抬升表面为 `rgb(84, 85, 87)`。
- 两种渲染分别指定，因此改动滑块的几何或 hover 行为需要改两处：一处在 `scrollbar-width`／`scrollbar-color`，一处在伪元素。让两者都经由这组间接变量，把这份重复限制在 Firefox 与 WebKit 不共用的那些属性上。
- `body *` 匹配所有元素，涉及的两个属性其效果本就被浏览器限制在实际会滚动的元素上。代价是一个覆盖面很宽的选择器；另一种选择是一个不生效的重新绑定契约。
- 工作区列表在任何列表长度下都永久少了预留空位那一条宽度。这正是该修复换来的代价：以稳定的行几何，换掉只在列表较短时才可读的时间戳。
- 调色板中没有轨道 token，因此日后若设计需要不透明轨道，要新增一个别名 token，而不是在这张样式表里写字面颜色。

## 测试

三份单元测试读取磁盘上的 CSS 文本。`ui-theme/tests/scrollbar-styles.spec.ts` 从 `design-platform.css` 中扫描出滚动条 token 集合，而不是把它写死，因此新增、重命名或删除 token 时断言会随之变化；它检查每个 token 都有消费方，且每处抬升表面重新绑定的都是完整的一对。`web/tests/base-styles.spec.ts` 锁定导入顺序，以及 `base.css` 列出的每张样式表确实存在。`ui-workspace/tests/browser-styles.spec.ts` 锁定 `.list` 上的空位预留。

`apps/web/tests/sidebar-scrollbar.e2e.ts` 覆盖只有真实渲染引擎才能报告的两个事实：预留条带的宽度，以及代入后的 `scrollbar-color`。它不需要任何模型调用——列表只要溢出即可——因此以只读方式复用一份既有的已提交 fixture（测试前置数据）来铺入冷会话。

在构建产物客户端上于 headless chromium 中读取计算值确认，这正是区分「token 链真正生效」与「语法合法」的手段：滚动容器在两套调色板下分别计算出 l1 的滑块颜色，而重新绑定间接变量的容器计算出 l2 的颜色，证明重新绑定作用到了计算值，而不只是作用到自定义属性上。

headless chromium 绘制的是覆盖式滚动条，因此其中预留空位不会缩小 `clientWidth`。该预留表现为列表上非零的 `offsetWidth - clientWidth` 条带；仅凭内容区几何无法证明它，而把时间元素右边缘与内容区右边缘做比较的断言，在有无预留的两种状态下都成立，因此它的通过或失败取决于平台的滚动条样式，而不是取决于被测的那条声明。

验证浏览器可见的插件 CSS 需要一次 `pnpm run build:web` 并不执行的重建。`WorkspaceBrowser.module.css` 从不进入 `apps/web/dist`：ui-workspace 以运行时插件方式加载，其 CSS 内联进 `packages/client/ui-workspace/lib/client.js`，由该包自己的 `bundle` 脚本构建。因此只重跑 `build:web` 的反向对照实际测的是旧产物，去掉声明后仍会通过，看起来像测试无效，实际是对照无效。正确做法是先 `pnpm --filter @deepseek-ai/dsh-client-ui-workspace run bundle`，用 grep 在 `lib/client.js` 中确认该声明确实存在或消失，然后再 `build:web`。web 通道中没有任何脚本会做这一步：`test:web` 只运行 `build:web`，因此任何滚动区域或插件 CSS 的改动都会碰到同一个陷阱。
