#!/usr/bin/env bash
# relay installer for macOS / Linux / WSL.
#
# Builds the project in-place and symlinks bin/relay into PREFIX/bin
# so that `relay` is available on PATH.
#
# Usage:
#   ./install.sh                  # interactive — asks before PATH edit
#   ./install.sh --yes            # unattended — skip prompts
#   ./install.sh --no-path-edit   # don't touch your shell rc
#   PREFIX=/usr/local ./install.sh
#
# Requires: node 20+, pnpm.

set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${PREFIX:-$HOME/.local}"

for arg in "$@"; do
  case "$arg" in
    -y|--yes)         RELAY_ASSUME_YES=1 ;;
    --no-path-edit)   RELAY_NO_PATH_EDIT=1 ;;
    -h|--help)
      sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "install.sh: unknown flag '$arg'" >&2
      echo "run with --help to see options" >&2
      exit 2
      ;;
  esac
done

if [ -t 1 ]; then
  C_GREEN=$'\033[32m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_GREEN=""; C_BOLD=""; C_DIM=""; C_RESET=""
fi

# ---------------------------------------------------------------------------
# 1. Toolchain checks
# ---------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "error: node is not installed or not on PATH" >&2
  echo "relay requires Node.js 20+: https://nodejs.org/" >&2
  exit 1
fi

node_major="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [ "$node_major" -lt 20 ] 2>/dev/null; then
  echo "error: node $node_major found, but relay requires node 20+" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: pnpm is not installed or not on PATH" >&2
  echo "install with: npm install -g pnpm" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Build
# ---------------------------------------------------------------------------
printf "${C_BOLD}relay install${C_RESET}\n"
printf "${C_DIM}  source:  %s${C_RESET}\n" "$SRC"
printf "${C_DIM}  prefix:  %s${C_RESET}\n" "$PREFIX"
echo ""

(cd "$SRC" && pnpm install --silent && pnpm build) || {
  echo "error: build failed" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# 3. Symlink bin/relay into PREFIX/bin
# ---------------------------------------------------------------------------
mkdir -p "$PREFIX/bin"
ln -sf "$SRC/bin/relay" "$PREFIX/bin/relay"

_short_sha="unknown"
if git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1; then
  _short_sha="$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || printf unknown)"
fi
printf "${C_BOLD}relay${C_RESET} → %s  ${C_DIM}(%s)${C_RESET}\n" "$PREFIX/bin/relay" "$_short_sha"

# ---------------------------------------------------------------------------
# 4. PATH wiring
# ---------------------------------------------------------------------------
shell_rc=""
case "$(basename "${SHELL:-}")" in
  zsh)  shell_rc="$HOME/.zshrc" ;;
  bash)
    if [ "$(uname -s)" = "Darwin" ] && [ -f "$HOME/.bash_profile" ]; then
      shell_rc="$HOME/.bash_profile"
    else
      shell_rc="$HOME/.bashrc"
    fi
    ;;
  fish) shell_rc="$HOME/.config/fish/config.fish" ;;
esac

export_line="export PATH=\"$PREFIX/bin:\$PATH\""
[ "$(basename "${SHELL:-}")" = "fish" ] \
  && export_line="set -gx PATH $PREFIX/bin \$PATH"

case ":$PATH:" in
  *":$PREFIX/bin:"*) ;;  # already on PATH
  *)
    if [ -n "$shell_rc" ] && [ "${RELAY_NO_PATH_EDIT:-0}" != "1" ]; then
      mkdir -p "$(dirname "$shell_rc")"
      touch "$shell_rc"
      if ! grep -Fqs "$export_line" "$shell_rc"; then
        {
          echo ""
          echo "# added by relay install.sh"
          echo "$export_line"
        } >> "$shell_rc"
        printf "${C_DIM}path     ${C_RESET}+ %s in %s ${C_DIM}(open a new terminal)${C_RESET}\n" \
          "$PREFIX/bin" "$shell_rc"
      fi
    else
      printf "${C_DIM}path     ${C_RESET}add to your shell rc:  %s\n" "$export_line"
    fi
    ;;
esac

# ---------------------------------------------------------------------------
# 5. Verify
# ---------------------------------------------------------------------------
if [ -x "$PREFIX/bin/relay" ]; then
  PATH="$PREFIX/bin:$PATH" relay --version >/dev/null 2>&1 \
    && printf "${C_DIM}verify   ${C_RESET}${C_GREEN}ok${C_RESET}\n"
fi

printf "\n${C_GREEN}→ ready.${C_RESET}  next: ${C_BOLD}relay dev${C_RESET}\n"
