#!/usr/bin/env bash
#
# Install envctl as a personal global CLI (like `gh`): build the project, then
# symlink the built entrypoint into a directory on your PATH.
#
#   ./install.sh                      # install into ~/.local/bin
#   PREFIX=/usr/local/bin ./install.sh  # install into a custom dir
#
# Re-runnable: re-run any time to rebuild and refresh the symlink.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${PREFIX:-$HOME/.local/bin}"
TARGET="$REPO_DIR/dist/envctl.js"
LINK="$PREFIX/envctl"

echo "Building envctl..."
pnpm -C "$REPO_DIR" install --frozen-lockfile
pnpm -C "$REPO_DIR" build

mkdir -p "$PREFIX"
# -f replaces an existing link/file so re-running is clean and idempotent.
ln -sf "$TARGET" "$LINK"
echo "Installed: $LINK -> $TARGET"

# Nudge if the install dir is not yet on PATH.
case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *)
    echo
    echo "Note: $PREFIX is not on your PATH. Add it to your shell profile:"
    echo "  export PATH=\"$PREFIX:\$PATH\""
    ;;
esac
