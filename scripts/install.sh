#!/bin/sh
# dsh one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/deepseek-harness/deepseek-harness/master/scripts/install.sh | sh
#
# It clones the harness to ~/.dsh/source, checks host dependencies (git, Node,
# pnpm) and offers to install a missing pnpm, runs `pnpm install` (no build —
# the `bin/dsh` launcher runs the TypeScript source through the repo's own tsx),
# symlinks `dsh` onto PATH, records your API credentials in the Harness home
# (`~/.dsh`) dsh reads at boot, and drops you into `dsh`.
#
# When run from inside an existing checkout (e.g. `sh scripts/install.sh` rather
# than `curl ... | sh`) it reuses that checkout and skips the clone/update, leaving
# the working tree untouched; DSH_REF is ignored in that mode. Setting DSH_SOURCE
# to a different directory opts back into the normal clone/update path.
#
# When run through `curl | sh` the script text arrives on stdin, so every
# prompt and the final launch read the controlling terminal (/dev/tty) directly;
# with no terminal the script prints the manual next steps instead.
#
# Overridable via environment:
#   DSH_REF          branch or tag to clone/checkout    (default: master)
#   DSH_REPO         clone URL                           (default: the GitHub repo)
#   DSH_SOURCE       checkout location                   (default: ~/.dsh/source)
#   DSH_BIN_DIR      directory the `dsh` symlink lands in (default: ~/.local/bin)
#   DSH_HOME         Harness home holding the personal config (default: ~/.dsh)
# FIXME(install-ts): Move the post-checkout workflow into a tested TypeScript
# entrypoint; keep this POSIX shell file as the curl/source bootstrap.
set -eu

DSH_REF=${DSH_REF:-master}
DSH_REPO=${DSH_REPO:-https://github.com/deepseek-harness/deepseek-harness.git}
# Remember whether the caller pinned a source location before defaulting it, so
# in-repo detection only repoints an unset DSH_SOURCE.
if [ -n "${DSH_SOURCE:-}" ]; then DSH_SOURCE_EXPLICIT=1; else DSH_SOURCE_EXPLICIT=0; fi
DSH_SOURCE=${DSH_SOURCE:-$HOME/.dsh/source}
DSH_BIN_DIR=${DSH_BIN_DIR:-$HOME/.local/bin}

# --- in-repo detection ---------------------------------------------------------
# Under `curl ... | sh` the script text arrives on stdin, so $0 is the shell
# name and no file path resolves; running a checked-out copy (`sh
# scripts/install.sh`) makes $0 the script file. When $0 is a readable file whose
# parent is a scripts/ dir inside a real dsh checkout (bin/dsh launcher present),
# reuse that checkout and skip the clone. An explicit DSH_SOURCE pointing
# elsewhere opts back into the clone/update path.
IN_REPO=0
if [ -f "$0" ]; then
  _self_dir=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P) || _self_dir=''
  if [ -n "$_self_dir" ]; then
    _repo_root=$(dirname -- "$_self_dir")
    if [ "$(basename -- "$_self_dir")" = scripts ] \
      && [ -x "$_repo_root/bin/dsh" ] && [ -f "$_repo_root/scripts/install.sh" ]; then
      if [ "$DSH_SOURCE_EXPLICIT" = 0 ] || [ "$DSH_SOURCE" = "$_repo_root" ]; then
        IN_REPO=1
        DSH_SOURCE=$_repo_root
      fi
    fi
  fi
fi

# --- terminal-aware prompting --------------------------------------------------
# stdin is the piped script, so read the controlling terminal for input.
if { true </dev/tty; } 2>/dev/null; then
  HAS_TTY=1
  # Restore terminal echo on exit or interrupt: ask_secret disables echo between
  # its stty toggles, and dash (a common `sh`) does not run an EXIT trap when the
  # shell is killed by a signal, so the fatal signals need their own handler. A
  # successful run ends in exec, which replaces this process and drops the traps.
  trap 'stty echo </dev/tty 2>/dev/null || true' EXIT
  trap 'stty echo </dev/tty 2>/dev/null || true; exit 130' INT TERM HUP
else
  HAS_TTY=0
fi

# Colour only when writing to a terminal.
if [ -t 1 ]; then
  B=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RED=$(printf '\033[31m')
  GRN=$(printf '\033[32m'); YEL=$(printf '\033[33m'); RST=$(printf '\033[0m')
else
  B=''; DIM=''; RED=''; GRN=''; YEL=''; RST=''
fi

info()  { printf '%s==>%s %s\n' "$GRN" "$RST" "$1"; }
step()  { printf '\n%s==>%s %s%s%s\n' "$GRN" "$RST" "$B" "$1" "$RST"; }
warn()  { printf '%s warn%s %s\n' "$YEL" "$RST" "$1" >&2; }
die()   { printf '%serror%s %s\n' "$RED" "$RST" "$1" >&2; exit 1; }

# ask PROMPT [DEFAULT] -> answer on stdout (plain-text line).
ask() {
  [ "$HAS_TTY" = 1 ] || die "no terminal available for input; re-run in an interactive shell"
  printf '%s%s%s ' "$B" "$1" "$RST" >/dev/tty
  IFS= read -r _ans </dev/tty || _ans=''
  [ -n "$_ans" ] || _ans=${2:-}
  printf '%s' "$_ans"
}

# ask_secret PROMPT -> answer on stdout, with terminal echo suppressed.
ask_secret() {
  [ "$HAS_TTY" = 1 ] || die "no terminal available for input; re-run in an interactive shell"
  printf '%s%s%s ' "$B" "$1" "$RST" >/dev/tty
  stty -echo </dev/tty 2>/dev/null || true
  IFS= read -r _sec </dev/tty || _sec=''
  stty echo </dev/tty 2>/dev/null || true
  printf '\n' >/dev/tty
  printf '%s' "$_sec"
}

# confirm PROMPT [Y] -> exit 0 on yes. Default is no unless second arg is "Y".
confirm() {
  _def=${2:-N}
  if [ "$HAS_TTY" != 1 ]; then
    [ "$_def" = Y ]  # non-interactive: take the default
    return
  fi
  if [ "$_def" = Y ]; then _hint='[Y/n]'; else _hint='[y/N]'; fi
  printf '%s%s%s %s ' "$B" "$1" "$RST" "$_hint" >/dev/tty
  IFS= read -r _r </dev/tty || _r=''
  [ -n "$_r" ] || _r=$_def
  case "$_r" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

printf '%s\n' "${B}DeepSeek Harness — dsh installer${RST}"
printf '%ssource %s @ %s%s\n' "$DIM" "$DSH_SOURCE" "$DSH_REF" "$RST"

# --- 1. dependency check -------------------------------------------------------
step "Checking dependencies"

command -v git >/dev/null 2>&1 || die "git is required but not found. Install git, then re-run."
info "git ... ok"

# Node ^22.19.0 || >=24.0.0 (see the root package.json "engines" field).
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  _v=$(node -v 2>/dev/null) || return 1
  _v=${_v#v}
  _major=${_v%%.*}
  _rest=${_v#*.}
  _minor=${_rest%%.*}
  case "$_major" in ''|*[!0-9]*) return 1 ;; esac
  case "$_minor" in ''|*[!0-9]*) _minor=0 ;; esac
  [ "$_major" -ge 24 ] && return 0
  [ "$_major" -eq 22 ] && [ "$_minor" -ge 19 ] && return 0
  return 1
}
if node_ok; then
  info "node $(node -v) ... ok"
else
  if command -v node >/dev/null 2>&1; then
    die "Node $(node -v) is unsupported. dsh needs ^22.19.0 || >=24.0.0 — upgrade Node, then re-run."
  fi
  die "Node is required but not found. Install Node ^22.19.0 || >=24, then re-run."
fi

# pnpm is the only dependency we offer to install for you.
if command -v pnpm >/dev/null 2>&1; then
  info "pnpm $(pnpm --version 2>/dev/null) ... ok"
else
  warn "pnpm is not installed."
  if confirm "Install pnpm now?" Y; then
    if command -v corepack >/dev/null 2>&1 && corepack enable pnpm >/dev/null 2>&1; then
      info "enabled pnpm via corepack"
    elif command -v npm >/dev/null 2>&1 && npm install -g pnpm >/dev/null 2>&1; then
      info "installed pnpm via npm"
    else
      die "could not install pnpm automatically. Install it (https://pnpm.io/installation), then re-run."
    fi
    command -v pnpm >/dev/null 2>&1 || die "pnpm still not on PATH after install. Open a new shell, then re-run."
  else
    die "pnpm is required. Install it (https://pnpm.io/installation), then re-run."
  fi
fi

# --- 2. clone (or update) the source ------------------------------------------
if [ "$IN_REPO" = 1 ]; then
  step "Using existing checkout at $DSH_SOURCE"
  info "running from inside the repo — skipping clone (DSH_REF ignored, working tree left untouched)"
else
step "Fetching source into $DSH_SOURCE"
if [ -d "$DSH_SOURCE/.git" ]; then
  info "existing checkout found — updating"
  git -C "$DSH_SOURCE" fetch --depth 1 origin "$DSH_REF"
  # Reset the checkout to the freshly fetched tip. FETCH_HEAD (not
  # origin/<ref>) so this resolves for a tag as well as a branch, and -B makes
  # the re-run idempotent whether or not DSH_REF changed since the last install.
  git -C "$DSH_SOURCE" checkout -q -B "$DSH_REF" FETCH_HEAD
else
  mkdir -p "$(dirname "$DSH_SOURCE")"
  git clone --depth 1 --branch "$DSH_REF" "$DSH_REPO" "$DSH_SOURCE"
fi
fi

# --- 3. install dependencies (no build; the launcher runs from source) --------
step "Installing dependencies with pnpm (this can take a while)"
( cd "$DSH_SOURCE" && pnpm install )

[ -x "$DSH_SOURCE/bin/dsh" ] || die "launcher $DSH_SOURCE/bin/dsh missing after install — is DSH_REF a branch that ships apps/cli?"

# --- 4. put `dsh` on PATH ------------------------------------------------------
step "Linking dsh into $DSH_BIN_DIR"
mkdir -p "$DSH_BIN_DIR"
ln -sf "$DSH_SOURCE/bin/dsh" "$DSH_BIN_DIR/dsh"
info "linked $DSH_BIN_DIR/dsh -> $DSH_SOURCE/bin/dsh"

case ":$PATH:" in
  *":$DSH_BIN_DIR:"*) ON_PATH=1 ;;
  *) ON_PATH=0 ;;
esac
if [ "$ON_PATH" = 0 ]; then
  warn "$DSH_BIN_DIR is not on your PATH."
  _line="export PATH=\"$DSH_BIN_DIR:\$PATH\""
  _rc=''
  _sh=${SHELL:-}  # SHELL may be unset; word-removal on an unset var trips set -u under dash.
  case "${_sh##*/}" in
    zsh)  _rc="$HOME/.zshrc" ;;
    bash) _rc="$HOME/.bashrc" ;;
  esac
  if [ -n "$_rc" ] && [ -f "$_rc" ] && grep -qF "$_line" "$_rc" 2>/dev/null; then
    info "$_rc already exports $DSH_BIN_DIR — open a new shell to pick it up"
  elif [ -n "$_rc" ] && confirm "Add it to $_rc?" Y; then
    printf '\n# Added by the dsh installer\n%s\n' "$_line" >>"$_rc"
    info "updated $_rc — run 'source $_rc' or open a new shell to pick it up"
  else
    warn "add this line to your shell profile yourself:"
    printf '    %s\n' "$_line"
  fi
fi

# --- 5. credentials ------------------------------------------------------------
# Mirror app-boot's resolveDshHome precedence ($DSH_HOME, else ~/.dsh) so creds land where dsh reads them.
if [ -n "${DSH_HOME:-}" ]; then
  CONF="$DSH_HOME"
else
  CONF="$HOME/.dsh"
fi
ENV_FILE="$CONF/.env"

step "Configuring credentials"
if [ -f "$ENV_FILE" ] && grep -q '^DEEPSEEK_API_KEY=' "$ENV_FILE" 2>/dev/null; then
  info "DEEPSEEK_API_KEY already set in $ENV_FILE"
  if ! confirm "Replace it?" N; then
    SKIP_CREDS=1
  fi
fi
if [ "${SKIP_CREDS:-0}" != 1 ]; then
  if [ "$HAS_TTY" = 1 ]; then
    API_KEY=$(ask_secret "DeepSeek API key (input hidden):")
    if [ -z "$API_KEY" ]; then
      warn "no key entered — skipping. Set DEEPSEEK_API_KEY in $ENV_FILE before using dsh."
    else
      BASE_URL=$(ask "DeepSeek base URL (optional, Enter to skip):")
      mkdir -p "$CONF"
      # The installer owns exactly the two DEEPSEEK_* lines; any other lines the
      # user keeps in this .env are preserved. The rewrite happens in a subshell
      # so umask 077 (which closes the create-time permission race) does not leak
      # into the exec'd dsh, and lands atomically via a same-dir temp + mv.
      _tmp="$ENV_FILE.dsh.$$"
      (
        umask 077
        if [ -f "$ENV_FILE" ]; then
          grep -v -e '^DEEPSEEK_API_KEY=' -e '^DEEPSEEK_BASE_URL=' "$ENV_FILE" >"$_tmp" || true
        else
          : >"$_tmp"
        fi
        printf 'DEEPSEEK_API_KEY=%s\n' "$API_KEY" >>"$_tmp"
        if [ -n "$BASE_URL" ]; then printf 'DEEPSEEK_BASE_URL=%s\n' "$BASE_URL" >>"$_tmp"; fi
      )
      mv "$_tmp" "$ENV_FILE"
      chmod 600 "$ENV_FILE" 2>/dev/null || true
      info "wrote $ENV_FILE"
    fi
  else
    warn "no terminal for credential input — set DEEPSEEK_API_KEY in $ENV_FILE before using dsh."
  fi
fi

# --- 6. launch -----------------------------------------------------------------
step "Done"
if [ "$HAS_TTY" = 1 ]; then
  info "launching dsh — run 'dsh' anytime to start again"
  exec "$DSH_BIN_DIR/dsh" </dev/tty
else
  info "install complete. Start it with:"
  printf '    %s\n' "$DSH_BIN_DIR/dsh"
fi
