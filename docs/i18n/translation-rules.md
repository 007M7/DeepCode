# Translation rules

English | [中文](translation-rules.zh.md)

How to translate between the two sides of a documentation pair in this repo. Both languages carry equal authority ([README.md](README.md)): a change is authored in either language, and that side is the source for that update — these rules govern producing or updating the counterpart. They bind humans and agents equally; the committed agent workflow that applies them is [.agents/skills/dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md). Rule levels follow RFC 2119 usage: **MUST** / **MUST NOT** are gate- or review-blocking; **SHOULD** needs a stated reason to deviate; **MAY** is discretionary.

## Faithfulness

- The counterpart MUST say what the authored side says — no added behavior, prerequisites, warnings, version claims, or examples, and no dropped ones. If the pair disagrees on substance, neither language wins by default: fix the side that is wrong, then bring the other along in the same change.
- The counterpart SHOULD read as natural technical writing in its own language, not word-by-word gloss. Translate meaning, restructure sentences where the target grammar wants it, and keep the author's register — terse stays terse.
- Do not translate the untranslatable: if a sentence resists natural rendering because it leans on an idiom of the source language, translate the idea, not the idiom.

## Voice

- The register is calibrated by [style-samples.md](style-samples.md) — human-approved gold pairs, one per document genre. The counterpart MUST match the register of the nearest sample; where a sample and a prose rule here disagree, the sample wins. The target is institutional technical Chinese: complete sentences, declarative, neither chatty nor academic.
- Write as a native technical author restating the content, not as a translator transposing sentences. Then verify against the source clause by clause: nothing added, nothing dropped — fluency never justifies losing a clause.
- Give sentences an explicit agent: where the English uses a passive or an abstract subject, name the actor (系统、门禁、评审人).
- Prefer established Chinese engineering idiom over calques (误报／漏检 for false positive/negative, 执行红线 for enforcement frontier); localize metaphors instead of transplanting them, and unpack English noun chains into verb clauses.
- Split long paragraphs by semantic unit — one idea per paragraph. Paragraph boundaries MAY differ from the source; the structural signature does not count paragraphs.
- Category nouns render in Chinese with a first-mention English annotation (实操手册（cookbook）); literal directory or file references stay code-formatted English.

## Structure preservation

Shape is enforced by the pairing gate, so the writer never trades fluency against it — write naturally inside the frame. The paired files MUST match one to one in:

- heading hierarchy (same levels, same order — heading TEXT is translated),
- list shape and numbering,
- tables (same columns, same row order; header cells translated per terminology),
- fenced code blocks — **byte-identical, including comments**; code is part of the verified surface (` ```ts ` blocks compile under `doc-typecheck`), and an edited comment is drift the fence-count gate cannot see,
- inline code spans (commands, flags, config keys, file paths, event names, API names, version numbers) — verbatim, never translated or reformatted,
- links and anchors: every relative link MUST point at the same target in both files — by convention the `.md` path, not the `.zh.md` sibling — so links never dangle when one pair lands before its neighbors. The ONLY zh-specific link is the language switcher. Link TEXT is translated; the target is not.

The repo's Markdown conventions apply to `.zh.md` files unchanged: one physical line per paragraph (`verify-md-wrap`), resolving relative links (`verify-md-links`), exactly one trailing newline.

## Terminology

- [terminology.md](terminology.md) is the source of truth in both directions. Before translating, load it; while translating, every term it lists MUST be rendered exactly as it specifies, including its first-occurrence annotations (e.g. `agent（智能体）` on first mention, plain `agent` after) and its "不要译作" prohibitions. When the Chinese side is authored first, the English counterpart uses the table's English column the same way.
- A technical term NOT in the table MAY be translated only when a major Chinese-language OSS or vendor doc has an established rendering for it (K8s/Vue/MDN Chinese docs, 微软简中风格指南, big-tech project docs). Cite the precedent in the PR.
- A term with NO established precedent MUST stay in English in the translation and MUST be listed in the PR description under 「待定术语」(pending terms) with a suggested rendering for the reviewer to decide. MUST NOT invent a Chinese rendering inline — an unprecedented translation creates exactly the ambiguity the terminology table exists to prevent. Decided terms then land in [terminology.md](terminology.md) in the same PR or a follow-up.

## Typography

These rules govern the Chinese side; the English side follows the repo's normal Markdown conventions (root `AGENTS.md`). The mixed-script rules below follow the cross-project consensus of the [MDN Simplified Chinese translation guide](https://github.com/mdn/translated-content/blob/main/docs/zh-cn/translation-guide.md), the [Kubernetes zh-cn localization guide](https://kubernetes.io/zh-cn/docs/contribute/localization_zh/), the [Vue.js Chinese translation conventions](https://github.com/vuejs-translations/docs-zh-cn/wiki/%E7%BF%BB%E8%AF%91%E9%A1%BB%E7%9F%A5), and [中文文案排版指北](https://github.com/sparanoid/chinese-copywriting-guidelines), which in turn ground in [W3C clreq](https://www.w3.org/TR/clreq/) and GB/T 15834—2011:

- MUST put one half-width space between Chinese text and Latin words, and between Chinese text and numerals: `每个 plugin 注册 3 个 tool`。No space between a full-width punctuation mark and anything.
- MUST use full-width (Chinese) punctuation in Chinese prose: `，。：；？！（）「」`. Half-width punctuation stays inside code spans, inside complete English sentences quoted as-is, and in numbers (`3.5`, `1,024`).
- Enumeration commas: a Chinese list of parallel items uses 顿号（、）, not commas.
- MUST NOT use full-width digits or full-width Latin letters — `１２３` never, `123` always.
- Proper nouns keep their canonical casing: GitHub, TypeScript, DeepSeek — never `github`/`Github` unless quoting code.
- Second person is 你, not 您 (matches the Vue and Kubernetes Chinese conventions and this repo's direct voice).
- Emphasis markers (`**bold**`, `*italic*`) stay on the same spans as the source; Chinese has no italics, so the rendered emphasis may look identical — do not substitute quotation marks or other decoration.

## Quality bar

- A pair is done when a bilingual engineer reading either file alone gets everything a reader of the other gets — same facts, same caveats, same tone — and nothing extra.
- Before handing off, self-check the result against this file and re-read the counterpart ALONE, without the source side by side; awkward phrasing is easier to hear without the source anchoring you.
- The mechanical contract (consistency record, switcher, structure, wrap, links) is checked by `pnpm run verify-translation-pairing` and the rest of `doc-sync` — run them; do not hand-verify what a gate covers.

## References

Authorities cited by these rules, for humans and agents who want the underlying reasoning:

- [中文文案排版指北](https://github.com/sparanoid/chinese-copywriting-guidelines) — the de-facto community standard for mixed CJK/Latin spacing and punctuation.
- [MDN zh-CN translation guide](https://github.com/mdn/translated-content/blob/main/docs/zh-cn/translation-guide.md) — an in-repo translation-rules file of the same shape as this one; spacing, punctuation, and glossary practice.
- [Kubernetes zh-cn localization guide](https://kubernetes.io/zh-cn/docs/contribute/localization_zh/) — terminology-first-occurrence and punctuation practice from the largest zh localization team.
- [Vue.js docs-zh-cn 翻译须知](https://github.com/vuejs-translations/docs-zh-cn/wiki/%E7%BF%BB%E8%AF%91%E9%A1%BB%E7%9F%A5) — per-term translate/keep decisions and tone.
- [zh-style-guide](https://zh-style-guide.readthedocs.io) — a community Chinese technical-writing style guide whose rule-level taxonomy (and RFC 2119 keyword levels) this file borrows; aggregates GB/T 15834/15835, clreq, and vendor guides.
- [W3C clreq](https://www.w3.org/TR/clreq/) and the [Microsoft Simplified Chinese style guide](https://learn.microsoft.com/en-us/globalization/reference/microsoft-style-guides) — the formal typographic and vendor-localization baselines.
- GB/T 19682-2005《翻译服务译文质量要求》 — the national standard whose three base requirements (忠实原文、术语统一、行文通顺) this file's Faithfulness and Terminology sections operationalize.
