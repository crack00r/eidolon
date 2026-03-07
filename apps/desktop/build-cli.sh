#!/bin/bash
# Build the Eidolon CLI as a standalone binary for Tauri sidecar
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TARGET_DIR="$SCRIPT_DIR/src-tauri/binaries"

# Detect target triple
ARCH=$(uname -m)
OS=$(uname -s)
case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64) TARGET="aarch64-apple-darwin" ;;
      x86_64) TARGET="x86_64-apple-darwin" ;;
    esac
    ;;
  Linux)
    case "$ARCH" in
      x86_64) TARGET="x86_64-unknown-linux-gnu" ;;
      aarch64) TARGET="aarch64-unknown-linux-gnu" ;;
    esac
    ;;
  MINGW*|MSYS*)
    TARGET="x86_64-pc-windows-msvc"
    ;;
esac

if [ -z "$TARGET" ]; then
  echo "Error: Unsupported platform $OS/$ARCH"
  exit 1
fi

echo "Building CLI for target: $TARGET"
mkdir -p "$TARGET_DIR"

# Use bun build --compile to create standalone binary
cd "$REPO_ROOT"
bun build packages/cli/src/index.ts \
  --compile \
  --outfile "$TARGET_DIR/eidolon-cli-$TARGET"

echo "CLI binary built: $TARGET_DIR/eidolon-cli-$TARGET"
