---
name: dsh-skill-creator
description: Create or update DeepSeek Harness SKILL.md instructions.
whenToUse: Use when writing reusable agent instructions for DeepSeek Harness or adding system/project/user skills.
---

Use this skill to write focused DeepSeek Harness skills.

A skill is a directory `<name>/SKILL.md` or a flat `<name>.md` file with YAML frontmatter.
Frontmatter must include kebab-case `name` and a concise `description` that tells the model when to load it.
Use optional `whenToUse` for extra routing signal and `disableModelInvocation: true` for user-only skills.
Keep the body procedural, evidence-oriented, and scoped to the workflow the skill owns.
