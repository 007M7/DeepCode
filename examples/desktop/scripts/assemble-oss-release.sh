#!/usr/bin/env bash
# Assemble a clean OSS release tree from the current HEAD.
#
# Reads: current git HEAD (via `git archive`).
# Writes: a fresh directory (default: /tmp/dsh-oss-release) containing only
#         what the first plugin author / researcher who clones this repo
#         actually needs. Everything on the exclude list below is dropped.
#
# Run BEFORE the first public push. Re-run whenever the exclude list needs
# to catch up with new internal review chatter.
#
# **Not covered by this script**: git-history mailmap rewrite for
# @deepseek.com author emails (hygiene report §1-M1 / M1). That's a
# destructive one-time op — wait for user green-light, then run
# `git filter-repo --mailmap` before the first push. See docs/oss-review-
# hygiene.md §6 for the checklist.
#
# Usage:
#   scripts/assemble-oss-release.sh               # → /tmp/dsh-oss-release
#   scripts/assemble-oss-release.sh /path/to/out  # → custom out dir
#   DRY_RUN=1 scripts/assemble-oss-release.sh     # print exclusions only
#
# Exit non-zero on: git error, output dir already populated, any residual
# leak detected in the post-scrub verification grep.

set -euo pipefail

OUT_DIR="${1:-/tmp/dsh-oss-release}"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"

echo "[assemble-oss-release] source repo : $REPO_ROOT"
echo "[assemble-oss-release] source HEAD : $HEAD_SHA"
echo "[assemble-oss-release] output dir  : $OUT_DIR"

if [ -d "$OUT_DIR" ] && [ "$(ls -A "$OUT_DIR" 2>/dev/null)" ]; then
  echo "[assemble-oss-release] ERROR: $OUT_DIR is not empty; refusing to overwrite" >&2
  exit 1
fi

# ─── Exclude list (docs/oss-review-hygiene.md §4) ────────────────────────
# Each entry is a path relative to the repo root. Kept as an array so the
# dry-run mode can just print it.

EXCLUDES=(
  # §4.A — internal review / audit chatter
  "docs/arch-review-report.md"
  "docs/capability-frontend-audit.md"
  "docs/capability-ui-coverage.md"
  "docs/context-fork-intent.md"
  "docs/demo-clickability-audit.md"
  "docs/design-confirm-162.md"
  "docs/design-confirm-185-section-7.md"
  "docs/design-confirm-198-section-7.md"
  "docs/e2e-real-audit.md"
  "docs/field-viz-audit.md"
  "docs/oss-tree-ui-patterns.md"
  "docs/plugin-mcp-audit.md"
  "docs/preflight-passthrough.md"
  "docs/product-flow-review.md"
  "docs/product-ia-design.md"
  "docs/qa-walkthrough-report.md"
  "docs/qa-walkthrough-round2.md"
  "docs/qa-walkthrough-round3.md"
  "docs/qa-walkthrough-round3b.md"
  "docs/review-demo-labels.md"
  "docs/review-fresh-eyes.md"
  "docs/review-wire-live.md"
  "docs/stabilization-review.md"
  "docs/strategy-feature-list.md"
  "docs/viz-coverage-matrix.md"
  "docs/walkthrough-baseline.md"
  "docs/walkthrough-round-real-api.md"
  "docs/walkthrough-round-visual.md"
  "docs/widget-channel-design.md"
  "docs/launch-smoke-checklist.md"
  "docs/oss-review-hygiene.md"
  "docs/oss-review-redundancy.md"

  # §4.B — screenshot archives (~90 MB)
  "docs/demo-shots"
  "docs/162-selfies"
  "docs/selfies"
  "docs/qa-round2-shots"
  "docs/qa-round3-shots"
  "docs/qa-round3-real-shots"
  "docs/qa-round3b-shots"
  "docs/qa-round3b-shots-r4final"
  "docs/qa-round4-shots"
  "docs/qa-round4-preverify"
  "docs/qa-round5-shots"
  "docs/qa-oss-survey-shots"
  "docs/walkthrough-round-real-api-shots"
  "docs/design-growth-v2"

  # §4.C — internal ticket work
  "docs/tickets"
  "docs/ticket-c"
  "docs/upstream-rfc-pack"

  # §4.D — design-refs (LangSmith reference material + internal codename URL)
  "docs/design-refs"

  # §4.E — internal QA/probe tooling (contains hardcoded absolute paths)
  "docs/default-profile-real-v2-probe"
  "scripts/layout-overlap-scan.mjs"
  "scripts/qa-cdp-shoot-affordance.mjs"
  "scripts/interactive-sweep-v2.mjs"
  "scripts/showcase-12x12-verify.mjs"
)

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "[assemble-oss-release] DRY_RUN=1 — printing exclusions and exiting"
  printf '  exclude: %s\n' "${EXCLUDES[@]}"
  exit 0
fi

# ─── Stage 1: git archive → OUT_DIR ────────────────────────────────────
mkdir -p "$OUT_DIR"
echo "[assemble-oss-release] git archive HEAD → $OUT_DIR"
(cd "$REPO_ROOT" && git archive HEAD) | tar -x -C "$OUT_DIR"

# ─── Stage 2: apply excludes ────────────────────────────────────────────
echo "[assemble-oss-release] pruning ${#EXCLUDES[@]} exclude entries"
for path in "${EXCLUDES[@]}"; do
  target="$OUT_DIR/$path"
  if [ -e "$target" ]; then
    rm -rf "$target"
    echo "  removed: $path"
  fi
done

# ─── Stage 2b: rewrite in-repo relative paths in cordis yml leaves ──────
# P0-2 fix (2026-07-18). In this source repo the shell sits alongside a
# sibling `deepseek-harness-dev/` checkout — the yml leaves import the
# mock-llm/echo-tool ts files via `../../deepseek-harness-dev/examples/
# echo-agent/…`. In the OFFICIAL repo layout (deepseek-harness with this
# shell copied under examples/desktop/) those same ts files live at
# `../../echo-agent/…` — no sibling, they're siblings-of-desktop inside
# the monorepo. Rewriting at assemble time keeps the source yml usable
# for local dev AND ships a working shape to the released tree.
#
# BSD sed (default on macOS) has no `-i ''`-vs-`-i` compat trick that
# works both places, so we do stream-in / stream-out to a temp file per
# leaf — portable, boring.
echo "[assemble-oss-release] rewriting cordis yml relative paths (sibling-clone → in-repo)…"
YML_LEAVES=(
  "config/echo-jsonrpc.yml"
  "config/daemon-echo.yml"
  "config/daemon-vibe.yml"
)
for leaf in "${YML_LEAVES[@]}"; do
  target="$OUT_DIR/$leaf"
  if [ ! -f "$target" ]; then
    echo "[assemble-oss-release] ERROR: yml leaf missing after archive: $leaf" >&2
    exit 3
  fi
  # Replace the sibling-clone prefix with the in-repo relative prefix.
  # From examples/desktop/config/ up two levels lands at examples/, so
  # `../../echo-agent/…` reaches examples/echo-agent/ — where the ts
  # files sit in the official repo. Fail loud if the replacement leaves
  # any residual `deepseek-harness-dev` reference inside the config leaf.
  tmp="$target.oss.tmp"
  sed 's#\.\./\.\./deepseek-harness-dev/examples/echo-agent/#../../echo-agent/#g' \
    "$target" > "$tmp"
  mv "$tmp" "$target"
  if grep -q 'deepseek-harness-dev' "$target"; then
    echo "  LEAK: still references deepseek-harness-dev in $leaf" >&2
    exit 3
  fi
  echo "  rewrote: $leaf"
done

# ─── Stage 2c: rewrite package.json name for OSS release ────────────────
# Source repo carries the dev name `dsh-desktop-demo` (proof-of-concept
# breadcrumb, kept unchanged there). In the official repo layout under
# examples/desktop/ the package publishes as `dsh-desktop` — the "demo"
# suffix is a source-side breadcrumb, not a shipping name. Rewrite here
# so the source repo stays legible for local dev while the released
# tree ships the launch name. Fail loud if the sed didn't take.
PKGJSON="$OUT_DIR/package.json"
if [ ! -f "$PKGJSON" ]; then
  echo "[assemble-oss-release] ERROR: package.json missing after archive" >&2
  exit 3
fi
echo "[assemble-oss-release] rewriting package.json name (dsh-desktop-demo → dsh-desktop)…"
tmp="$PKGJSON.oss.tmp"
sed 's#"name": "dsh-desktop-demo"#"name": "dsh-desktop"#' "$PKGJSON" > "$tmp"
mv "$tmp" "$PKGJSON"
if ! grep -q '"name": "dsh-desktop"' "$PKGJSON"; then
  echo "  LEAK: package.json name rewrite did not take" >&2
  exit 3
fi
if grep -q '"name": "dsh-desktop-demo"' "$PKGJSON"; then
  echo "  LEAK: package.json still shows dev name" >&2
  exit 3
fi
echo "  rewrote: package.json name → dsh-desktop"

# ─── Stage 3: verification grep ─────────────────────────────────────────
# Any residual hit here means the exclude list has drifted — abort.
echo "[assemble-oss-release] verifying scrub…"
LEAK=0
scan() {
  local pattern="$1" label="$2"
  # -r recursive, -I skip binaries, -l list-only. Only fail on **text**
  # hits — png bytes that happen to contain the ASCII string are ignored
  # via -I. This script itself contains the patterns literally, so skip
  # its own copy in the output tree.
  local hits
  hits="$(grep -rIl -E "$pattern" "$OUT_DIR" 2>/dev/null \
    | grep -v '/scripts/assemble-oss-release\.sh$' || true)"
  if [ -n "$hits" ]; then
    echo "  LEAK [$label]:" >&2
    echo "$hits" | sed 's/^/    /' >&2
    LEAK=1
  fi
}
scan 'api-internal\.deepseek\.com'          'internal proxy hostname (H1)'
scan 'yinghuo|high-flyer'                   'internal codename (H2)'
# Only flag UI-visible / source-of-truth carriers: rubric fixture
# frontmatter ("description:" line) and the auto-inlined seed JS. Code
# comments in src/renderer/*model.js are explicitly OK per hygiene §2.2.
scan '^description:.*LangSmith'             'competitor-name in rubric frontmatter (2.1)'
scan 'LangSmith FeedbackSchema.*primitive parity' 'competitor-name in UI seed (2.1)'

if [ "$LEAK" != "0" ]; then
  echo "[assemble-oss-release] FAIL: residual leak — update EXCLUDES and re-run" >&2
  exit 2
fi

echo "[assemble-oss-release] ok — clean tree at $OUT_DIR"
echo "[assemble-oss-release] next: mailmap-rewrite the git history (hygiene §6 M1) before the first public push."
