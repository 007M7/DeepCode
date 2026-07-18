// Auto-inlined fixture seeds for the Rubrics + Annotation pages.
// Renderer runs at file:// so we inline the SKILL.md blobs and sample
// sessions here instead of relying on fetch(). To refresh:
//   python3 scripts/regen-rubrics-seed.py
//
// The 4 rubrics live at fixtures/rubrics/*.md; the sample sessions live at
// fixtures/annotation/sample-sessions.json.

'use strict'

const RUBRICS_SEED = [
  "---\nname: bug-fix\ngroup: fix-optimize\ntemplate: fixed\nexecutor: llm-judge\nversion: v1\ndescription: Evaluate a bug-fix trajectory — reproduction, minimality, tests, regressions, explanation.\n---\n\n## Checklist\n\n- Reproduces the reported failure with a minimal case before patching\n- Patch is minimal: no unrelated cleanups, formatting, or refactors\n- Regression test added or existing test updated to cover the fix\n- No obvious regressions in adjacent behavior (spot-check callers)\n- Written explanation states the root cause, not just the symptom\n\n## Notes\n\n- Prefer patches that add a regression test in the same PR.\n- Deduct when the model conflates symptom (crash) with cause (bad input).\n- Deduct when the model rewrites more than the failing branch.\n",
  "---\nname: svg-generation\ngroup: interaction-reasoning\ntemplate: per-prompt\nexecutor: llm-judge\nversion: v1\ndescription: Per-prompt rubric — judge model composes SVG-specific criteria before scoring, comparing to a reference image described in the prompt.\n---\n\n## Checklist\n\n- The generated SVG renders without XML errors\n- Shape count and composition match the prompt intent\n- Colors and gradient use match the reference (or spec)\n- Text elements (if any) match the requested strings\n- Prompt-specific criteria (added by the judge model per task)\n\n## Notes\n\n- Per-prompt template: the judge model receives the prompt + reference image\n  description, then extends the fixed checklist with 2–4 prompt-specific\n  items before scoring. Output preserves the {resolved, score, reason}\n  block for DSBench compatibility.\n- Deduct heavily when the SVG is a stub (empty viewBox, no shapes).\n",
  "---\nname: multi-turn-feedback\ngroup: interaction-reasoning\ntemplate: multi-turn\nexecutor: llm-judge\nversion: v1\ndescription: Score each assistant turn against the 5 fixed multi-turn dimensions; each dim 1-5 relative to the immediately preceding user feedback.\n---\n\n## Checklist\n\n- Feedback understanding — the model correctly parsed the user's ask\n- Fix effectiveness — the response actually addressed the previous feedback\n- No regression — behavior that was already good stayed good\n- Over-correction — the model changed only what the feedback asked for\n- Convergence — the turn is moving toward a stable answer\n\n## Notes\n\n- One score per dimension per assistant turn, on a 1–5 scale.\n- The pinned prior-user feedback is the anchor: every dim scores this turn\n  relative to that specific prior message, not the whole trajectory.\n- Stage-2 of the RL plan uses this rubric alongside the stage-1 task rubric\n  — this one grades feedback response quality, the other grades base\n  task quality.\n",
  "---\nname: code-review\ngroup: se-process\ntemplate: code-review\nexecutor: llm-judge\nversion: v1\ndescription: Reviewer rubric — evaluates a code-review trajectory on style, correctness, and test coverage.\n---\n\n## Checklist\n\n- Identifies incorrect behavior (bugs, edge cases) present in the diff\n- Style feedback is specific to project conventions, not generic\n- Suggests test coverage where the diff adds untested code paths\n- Prioritizes correctness over style when both are present\n- Tone is direct without being hostile; asks questions when uncertain\n\n## Notes\n\n- LLM-as-judge for now; the code-executor variant would run project\n  linters and compare their output against the review comments.\n- Deduct when reviewer misses a real bug the diff introduces.\n- Deduct when reviewer flags a style-only issue as correctness-critical.\n",
  "---\nname: correctness-score\ngroup: fix-optimize\ntemplate: fixed\nexecutor: llm-judge\nversion: v1\ndescription: Continuous 0-1 correctness score — real-valued continuous primitive.\n---\n\n## Dimensions\n\n- correctness :: continuous :: 0-1 :: Correctness\n\n## Checklist\n\n- Overall correctness on the trajectory's stated goal (0 = wrong, 1 = correct)\n\n## Notes\n\n- Continuous primitive: judge model emits a real number in [0, 1].\n- Export carries `dim_types.correctness = { type: 'continuous', min: 0, max: 1 }`\n  so downstream consumers can treat this as a probability rather than a\n  discrete class.\n- Small integer ranges (like 1-5) render as button rows; the 0-1 range\n  renders as a numeric input for a real-valued score.\n",
  "---\nname: intent-triage\ngroup: interaction-reasoning\ntemplate: fixed\nexecutor: llm-judge\nversion: v1\ndescription: Categorical verdict on how well the model triaged user intent — enum categorical primitive.\n---\n\n## Dimensions\n\n- verdict :: categorical :: bad,ok,good :: Triage verdict\n\n## Checklist\n\n- Categorical judgment on intent triage quality: bad · ok · good\n\n## Notes\n\n- Categorical primitive: judge emits one of {bad, ok, good}.\n- Export preserves the enum text (`verdict: 'good'`) rather than mapping\n  to an integer index — matches LangSmith's Feedback tab where a\n  categorical value renders as its string label.\n- Renders as a three-button pill row; keyboard 1/2/3 selects.\n",
  "---\nname: passes-bench\ngroup: se-process\ntemplate: fixed\nexecutor: llm-judge\nversion: v1\ndescription: Boolean pass/fail on a bench probe — two-state boolean primitive.\n---\n\n## Dimensions\n\n- passes :: boolean :: pass/fail :: Passes bench probe\n\n## Checklist\n\n- Did the trajectory pass the associated bench probe?\n\n## Notes\n\n- Boolean primitive: two-state (pass / fail).\n- Export carries `passes: true` or `passes: false`; downstream RL loop can\n  treat this as a hard label for reward-shaping.\n- Renders as a two-button toggle; keyboard 1 = true, 2 = false.\n"
]

const ANNOTATION_SAMPLES = {
  "_note": "Sample sessions for the RL annotation demo — three multi-turn trajectories chosen to exercise the 5-dim scoring card + the export pipeline. Each session's events follow the shape the renderer already uses elsewhere in the demo (role/content/type).",
  "sessions": [
    {
      "sessionId": "sess-fib-01",
      "title": "Fibonacci — from naive to memoized",
      "taskGroup": "code-gen",
      "taskSubtask": "function-completion",
      "createdAt": 1721030400000,
      "events": [
        {
          "type": "user/message",
          "content": "Please write a fibonacci function.",
          "seq": 1
        },
        {
          "type": "assistant/message",
          "content": "Here is a naive recursive implementation:\n\n```python\ndef fib(n):\n    if n < 2:\n        return n\n    return fib(n-1) + fib(n-2)\n```",
          "reasoning_content": "The user wants a fibonacci function. A naive recursive one is the simplest starting point.",
          "seq": 2
        },
        {
          "type": "user/message",
          "content": "That is exponential time. Make it iterative.",
          "seq": 3
        },
        {
          "type": "assistant/message",
          "content": "Iterative version:\n\n```python\ndef fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n```",
          "seq": 4
        },
        {
          "type": "user/message",
          "content": "Now add memoization so repeated calls are fast.",
          "seq": 5
        },
        {
          "type": "assistant/message",
          "content": "Using functools:\n\n```python\nfrom functools import lru_cache\n\n@lru_cache(maxsize=None)\ndef fib(n):\n    if n < 2:\n        return n\n    return fib(n-1) + fib(n-2)\n```",
          "seq": 6
        }
      ]
    },
    {
      "sessionId": "sess-bug-02",
      "title": "Off-by-one in slice range",
      "taskGroup": "fix-optimize",
      "taskSubtask": "bug-fix",
      "createdAt": 1721116800000,
      "events": [
        {
          "type": "user/message",
          "content": "This test fails: `page(items, 2)` should return items 10-19 but returns 11-20. What's wrong?",
          "seq": 1
        },
        {
          "type": "assistant/message",
          "content": "Looking at `page(items, page_num)`: the slice `items[page_num*10:(page_num+1)*10]` for page 2 gives `items[20:30]`, not `items[10:20]`. If page numbering is 1-based (page 1 = items 0-9), the fix is `items[(page_num-1)*10:page_num*10]`.",
          "seq": 2
        },
        {
          "type": "tool/call",
          "tool": "shell",
          "arguments": {
            "cmd": "pytest tests/test_pagination.py -v"
          },
          "seq": 3
        },
        {
          "type": "user/message",
          "content": "Good catch. Please write a regression test for this.",
          "seq": 4
        },
        {
          "type": "assistant/message",
          "content": "```python\ndef test_page_1_based():\n    items = list(range(30))\n    assert page(items, 1) == list(range(0, 10))\n    assert page(items, 2) == list(range(10, 20))\n    assert page(items, 3) == list(range(20, 30))\n```",
          "seq": 5
        }
      ]
    },
    {
      "sessionId": "sess-svg-03",
      "title": "SVG cat icon — three iterations",
      "taskGroup": "interaction-reasoning",
      "taskSubtask": "svg-gen",
      "createdAt": 1721203200000,
      "events": [
        {
          "type": "user/message",
          "content": "Draw a simple SVG cat face — two triangles for ears, a circle for the head, and eyes.",
          "seq": 1
        },
        {
          "type": "assistant/message",
          "content": "<svg viewBox=\"0 0 100 100\"><circle cx=\"50\" cy=\"55\" r=\"30\" fill=\"none\" stroke=\"#333\"/><polygon points=\"25,35 35,15 45,35\" fill=\"#333\"/><polygon points=\"55,35 65,15 75,35\" fill=\"#333\"/><circle cx=\"42\" cy=\"52\" r=\"2\" fill=\"#333\"/><circle cx=\"58\" cy=\"52\" r=\"2\" fill=\"#333\"/></svg>",
          "seq": 2
        },
        {
          "type": "user/message",
          "content": "The ears look pointy but the eyes are too small. Make the eyes bigger and add whiskers.",
          "seq": 3
        },
        {
          "type": "assistant/message",
          "content": "<svg viewBox=\"0 0 100 100\"><circle cx=\"50\" cy=\"55\" r=\"30\" fill=\"none\" stroke=\"#333\"/><polygon points=\"25,35 35,15 45,35\" fill=\"#333\"/><polygon points=\"55,35 65,15 75,35\" fill=\"#333\"/><circle cx=\"40\" cy=\"52\" r=\"4\" fill=\"#333\"/><circle cx=\"60\" cy=\"52\" r=\"4\" fill=\"#333\"/><line x1=\"20\" y1=\"65\" x2=\"40\" y2=\"67\" stroke=\"#333\"/><line x1=\"20\" y1=\"70\" x2=\"40\" y2=\"70\" stroke=\"#333\"/><line x1=\"60\" y1=\"67\" x2=\"80\" y2=\"65\" stroke=\"#333\"/><line x1=\"60\" y1=\"70\" x2=\"80\" y2=\"70\" stroke=\"#333\"/></svg>",
          "seq": 4
        },
        {
          "type": "user/message",
          "content": "The whiskers are only two — cats usually have three. And add a small nose.",
          "seq": 5
        },
        {
          "type": "assistant/message",
          "content": "<svg viewBox=\"0 0 100 100\"><circle cx=\"50\" cy=\"55\" r=\"30\" fill=\"none\" stroke=\"#333\"/><polygon points=\"25,35 35,15 45,35\" fill=\"#333\"/><polygon points=\"55,35 65,15 75,35\" fill=\"#333\"/><circle cx=\"40\" cy=\"52\" r=\"4\" fill=\"#333\"/><circle cx=\"60\" cy=\"52\" r=\"4\" fill=\"#333\"/><polygon points=\"48,60 52,60 50,64\" fill=\"#333\"/><line x1=\"20\" y1=\"63\" x2=\"40\" y2=\"66\" stroke=\"#333\"/><line x1=\"20\" y1=\"68\" x2=\"40\" y2=\"68\" stroke=\"#333\"/><line x1=\"20\" y1=\"73\" x2=\"40\" y2=\"70\" stroke=\"#333\"/><line x1=\"60\" y1=\"66\" x2=\"80\" y2=\"63\" stroke=\"#333\"/><line x1=\"60\" y1=\"68\" x2=\"80\" y2=\"68\" stroke=\"#333\"/><line x1=\"60\" y1=\"70\" x2=\"80\" y2=\"73\" stroke=\"#333\"/></svg>",
          "seq": 6
        }
      ]
    }
  ],
  "seedAnnotations": {
    "sess-fib-01": {
      "overall": "good",
      "taskGroup": "code-gen",
      "taskSubtask": "function-completion",
      "turnScores": [
        {
          "turnIndex": 0,
          "dims": {
            "feedback-understanding": 5,
            "fix-effectiveness": 4,
            "no-regression": 5,
            "over-correction": 5,
            "convergence": 3
          },
          "priorFeedback": "Please write a fibonacci function.",
          "note": "Correct implementation but starts with the naive shape — leaves room for follow-ups."
        },
        {
          "turnIndex": 1,
          "dims": {
            "feedback-understanding": 5,
            "fix-effectiveness": 5,
            "no-regression": 5,
            "over-correction": 5,
            "convergence": 4
          },
          "priorFeedback": "That is exponential time. Make it iterative.",
          "note": "Iterative fix is minimal and correct."
        },
        {
          "turnIndex": 2,
          "dims": {
            "feedback-understanding": 5,
            "fix-effectiveness": 5,
            "no-regression": 4,
            "over-correction": 4,
            "convergence": 5
          },
          "priorFeedback": "Now add memoization so repeated calls are fast.",
          "note": "lru_cache is clean; slight over-correction switching back to recursive."
        }
      ]
    }
  }
}

if (typeof window !== 'undefined') {
  window.__dshRubricsSeed = RUBRICS_SEED
  window.__dshAnnotationSamples = ANNOTATION_SAMPLES
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RUBRICS_SEED, ANNOTATION_SAMPLES }
}
