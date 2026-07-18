#!/usr/bin/env bash
# Rolling gate: on every new commit to HEAD, run full tests + record
# renderer/panels-c/session-tree/plugins-tab touch stats so cross-lane hunk
# leakage is visible fast. Meant to run in a foreground loop; kill with C-c.
#
# v2 (2026-07-16): tests run in a dedicated clean worktree at HEAD so
# in-flight lane WIP in the primary tree can't contaminate results (the v1
# false-alarm at 03cd26f + 3252d7f was uncommitted capabilities.js in the
# primary tree failing the IIFE-guard). The clean tree is reset to the new
# HEAD each pass via `git checkout --detach`, keeping node_modules symlinked
# from the primary.
set -u
STATE=/tmp/qa-gate-last-sha
LOG=/tmp/qa-gate.log
# Primary repo checkout defaults to the current git top-level; override
# with REPO_ROOT env var (e.g. REPO_ROOT=~/harness/dsh-desktop-demo).
PRIMARY="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
CLEAN=/tmp/dsh-clean-gate/tree
cd "$PRIMARY" || exit 1
touch "$STATE"
# Bootstrap the clean worktree once, symlinking node_modules from the primary
# so the loop doesn't reinstall on every commit.
if [ ! -d "$CLEAN" ]; then
  mkdir -p /tmp/dsh-clean-gate
  git worktree add "$CLEAN" HEAD >>"$LOG" 2>&1
  ln -sf "$PRIMARY/node_modules" "$CLEAN/node_modules"
fi
while :; do
  cur=$(git -C "$PRIMARY" rev-parse HEAD)
  last=$(cat "$STATE" 2>/dev/null || echo '')
  if [ "$cur" != "$last" ]; then
    ts=$(date '+%H:%M:%S')
    echo "[$ts] new HEAD $cur" | tee -a "$LOG"
    # Touch stats for hunk-cross-contamination watch (five renderer hotspots)
    git -C "$PRIMARY" show --stat "$cur" | grep -E "renderer\.js|panels-c\.js|session-tree\.js|context-meter\.js|plugins-tab\.js" | tee -a "$LOG"
    # Sync the clean worktree to the new HEAD (detached — never a branch tip
    # we could accidentally commit onto).
    if git -C "$CLEAN" checkout --detach "$cur" >/tmp/qa-gate-checkout.log 2>&1; then
      # Full test — capture only fail counter + tail
      if (cd "$CLEAN" && npm test --silent) >/tmp/qa-gate-npmtest.log 2>&1; then
        tail -5 /tmp/qa-gate-npmtest.log | tee -a "$LOG"
        echo "  ok tests green (clean tree)" | tee -a "$LOG"
      else
        echo "  RED: tests failed on $cur (clean tree, not WIP)" | tee -a "$LOG"
        tail -30 /tmp/qa-gate-npmtest.log | tee -a "$LOG"
      fi
    else
      echo "  ERROR: could not sync clean worktree to $cur" | tee -a "$LOG"
      tail -5 /tmp/qa-gate-checkout.log | tee -a "$LOG"
    fi
    echo "$cur" > "$STATE"
  fi
  sleep 15
done
