# AGENTS.md — CI gates

Run Windows gates from native `pwsh`, invoke pnpm shell-free, and normalize repo-relative glob paths to `/` at ingestion. Keep platform fixes at each gate boundary; do not add a shared platform layer.
