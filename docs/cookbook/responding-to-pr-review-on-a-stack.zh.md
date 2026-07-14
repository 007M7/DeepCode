# 在堆叠 PR 链中回应评审意见

[English](responding-to-pr-review-on-a-stack.md) | 中文

评审意见可能同时针对一条依赖堆叠（`A ← B ← C …`）中的多个 PR（Pull Request）。本指南说明如何在不破坏堆叠的前提下解决这些意见。它依赖的两个不变式是根 [AGENTS.md](../../AGENTS.md) § Conventions 中的常设指令：只用 merge commit，以及永远不改写已推送的分支。

## 基本规则

1. **每个 PR 分支一个 worktree。** 每个 PR 的修复在该 PR 自己的 worktree 中进行；并行修复绝不共享同一个 checkout。
2. **通过将父分支向下合并来更新子分支**（在子分支中执行 `git merge <parent-branch>`，产生一个新的 merge commit）。绝不对已推送的分支做 rebase/amend/force-push：改写会使分支与父 PR 及 GitHub 记录的内容产生分歧，破坏堆叠合并图，并抹去评审修复历史。
3. **修复落在引入问题的那个 PR 上，然后向下流动。** 当 PR `B` 上的评论指向 `B` 引入的代码时，在 `B` 上修复，再将 `B` 合并到 `C`——即使 `C` 也包含该文件。把修复发起在下游会导致 `B` 带着未修复的代码交付，并对 `B` 的评审者隐藏修复。
4. **每个评审修复是一个独立 commit，绝不 amend。** "修复评审发现"的 commit 记录了评审捕获的内容。只有你自己尚未推送、尚未评审的工作才可以 amend。

## 沿堆叠解决评审意见

1. 在行动之前先就事论事地审视每条评论：对照代码验证其论断——评审者指出了正确的症状，但仍可能误诊原因。
2. 将每个被接受的发现映射到其发起 PR，在那里修复，然后按顺序沿链向下合并。
3. 委派的修复需要信任但验证：子 agent（智能体）的报告描述的是意图，不一定是实际落地的内容。请亲自在实际代码树上重新运行门禁；对于回归守卫，要证明它在未修复的代码上**失败**（引入回归、观察变红、再还原）——两种情况都通过的守卫什么也守不住。子 agent 将问题重新定性为「已处理」时，这是一个需要亲自深入的信号。
4. 在评审线程中回复（`gh api repos/{owner}/{repo}/pulls/{pr}/comments/{id}/replies`），而非发顶层评论；说明修复内容及承载修复的 commit。
5. 合并堆叠之前，检查依赖方：删除一个 PR 的 base 分支会自动关闭依赖它的 PR。用 `gh pr list --state open --base <branch> --json number --jq length` 检查每个分支（非零 = 有打开的依赖方），当子 PR 仍以该分支为 base 时，合并时不带 `--delete-branch`。完整的落地流程见 [dsh-merging-stacked-prs](../../.agents/skills/dsh-merging-stacked-prs/SKILL.md) skill（技能）。

## 验证

- 每个已修复的 PR 显示一个新 commit（PR 时间线中没有 force-push 图标）。
- 每个子 PR 相对其父 PR 的 diff 仍然只包含自身的变更。
- 门禁在堆叠中的每个 PR 上都通过，而不仅仅是顶部。
