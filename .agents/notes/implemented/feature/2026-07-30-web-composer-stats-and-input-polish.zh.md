# Agent Note: Web composer stats detail and input-zone polish

Status: implemented

[English](2026-07-30-web-composer-stats-and-input-polish.md) | 中文

## Problem

Web 编辑器页脚原本以独立 stack 行显示一条拼接的统计字符串（cache／tokens／turns／steps），视觉上与输入卡脱节，且缺少设计稿中的耗时与 token 拆分细节。输入区自身也积累了逐条目的间距补丁：dock 条各带自己的 margin，sticky 座位下是硬切消息流的纯色填充，「回到底部」控件用硬编码偏移躲避编辑器、草稿一长高就失效，goal 与 todo 条的底色和列宽也互不一致。

## Decision

**统计行经由新的 `footer` owner prop 渲染进 InputBar 的宽度列内，并扩展为设计稿的分组细节行；composer stack 拥有唯一的 8px 节奏；座位以固定 36px 的 token 绑定渐变淡出消息流；「回到底部」控件跟随实时的 `--dsh-composer-height`；goal 与 todo 共用一条 752px 的 tip 填充列。**

- `'conversation.composer.dock'` 条目以 `ComposerBarOwnerProps.footer` 席位到达页面，渲染在卡片下方、bar 的 `.root` 之内，统计行与卡片因此共享同一宽度约束。`StatsLine` 全部在客户端从快照推导：turns／steps、由 assistant `timing`（`completedTime - stepStartTime`）折算的 LLM 墙钟时间、由 tool-result 的 `time - callTime` 配对折算的工具墙钟时间、把 cache-read 并入输入侧的提示／输出 token 拆分，以及缓存命中率。各组以竖线分隔、无数据时整组消失；`formatTokens`（517 / 12.2K / 1.2M）与 `formatDuration`（45.2s / 2m42s）导出供测试。耗时只覆盖窗口内节点——该限制由 README 记录。
- `.composerStack` 携带 `gap: 8px`，条目不带外边距（QueueDock 的 margin 已删除），渲染为 null 的 dock 条目零成本。GoalBar 是唯一的刻意例外：`margin: 0 auto -10px` 抵消 gap，把方形下缘塞进卡片下方 2px。
- sticky 座位的背景是从 0px 处的 `color-mix(bg-base 0%, transparent)` 到 36px 处纯色 `bg-base` 的 `linear-gradient`——像素节点而非 figma 导出的百分比，草稿长高只扩大纯色区域；`color-mix` 让两个主题都从各自的底色淡出。
- 座位上的 `useCallback` ref 挂 ResizeObserver，把 `--dsh-composer-height` 发布到滚动体上；ChatView 的回到底部席位据此计算 `bottom`（首帧回退 152px），替换先前硬编码的 168px。
- textarea 的 52px 两行下限只保留在 hero 变体；停靠态编辑器折叠到内容高度。goal 与 todo 条统一使用 44px 边距／752px 上限的列、todo 的 `tip` 填充与 l1 边框；todo 表头紧凑化（13/20 字号、8+8 内边距），折叠高度与 goal 条的 38px 对齐。

## Alternatives considered

**百分比渐变节点（figma 导出的 24%）。** 否决：节点随座位高度缩放，长草稿会把过渡带拉伸到消息流的大半；固定 36px 过渡带等于设计稿在静息 ~150px 编辑器下的 24%，且随编辑器长高保持恒定。

**骨架拥有的 dock 列加通用「最底条目贴卡」契约。** 实现后在评审中撤回：由 `.inputDock` 包装层拥有宽度／节奏、在 `:last-child` 上发布 `--dsh-dock-tuck-*` 变量，重排时贴卡会自动换人，但它在一次待合并前重写了每个条目和 GoalBar 的 DOM。最终选择逐条目 CSS、GoalBar 自持贴卡；dock 条目增多时通用列方案仍然可用。

**由后端为统计行提供耗时字段。** 不必要：assistant `timing` 与工具 call/result 配对已经到达快照，墙钟时间可在客户端折算，无需新的会话事件或 host 投影。

**统计行保持为 composer stack 的兄弟节点。** 否决：作为 stack 行它携带独立的宽度约束、与卡片漂移；作为 bar 的 `footer`，两者共享一列，统计行也天然落在座位的 sticky／渐变区域内。

## Consequences

统计行现在一眼可读 turns／steps、LLM 与工具耗时、缓存命中和输入／输出 token，代价是耗时只覆盖已加载事件窗口（README 已知限制）。单 gap 的 stack 节奏使 dock 间距与组合无关，但 GoalBar 的贴卡是位置性的：它必须保持为最底的 dock 条目（`order: 1`），否则其负边距会塞到错误的邻居下面。过渡带恒为 36px，未来设计调整只改一个节点值。`chat-stats-bash-sample.spec.tsx` 钉住推导（timing／工具折算、token 拆分）、两个格式化器、分组渲染，以及流式期间零重渲染的验收。
