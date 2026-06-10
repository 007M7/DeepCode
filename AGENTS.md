# AGENTS.md

This is the monorepo for the DeepSeek Harness group. It currently hosts the code for **DeepSeek Code**, DeepSeek's coding agent product.

## Architecture

This codebase is based on the **Cordis** framework. All necessary Cordis dependencies are copied into this monorepo as vendored source instead of being depended on via npm.

## Design Documents

- [Coding Harness MVP 需求分析](https://trtgsjkv6r.feishu.cn/wiki/ZwK6wfBE9i91V6kzMGYcgRGanxg) — requirement analysis for the initial MVP.
- [微内核Harness实现思路](https://trtgsjkv6r.feishu.cn/wiki/VS9Lw1kQki6mDJk2UHocyuphnsc) — discussion of the microkernel plugin-style architecture ("everything is a plugin").
