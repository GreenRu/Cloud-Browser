#!/usr/bin/env bash
#
# Build Cloud Browser into a distributable app folder.
#
#   ./build.sh                    build for this machine
#   ./build.sh --platform win32 --arch x64
#   ./build.sh --zip              also produce a .zip next to the app folder
#   ./build.sh --clean            remove dist/ first
#   ./build.sh --help
#
set -euo pipefail

cd "$(dirname "$0")"

APP_NAME="Cloud Browser"
OUT_DIR="dist"
PLATFORM=""
ARCH=""
MAKE_ZIP=0
DO_CLEAN=0

# Colours, but only when writing to a terminal.
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; RESET=""
fi

say()  { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
note() { printf '%s    %s%s\n' "$DIM" "$*" "$RESET"; }
die()  { printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

usage() {
  sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --platform) PLATFORM="${2:-}"; [ -n "$PLATFORM" ] || die "--platform needs a value"; shift 2 ;;
    --arch)     ARCH="${2:-}";     [ -n "$ARCH" ]     || die "--arch needs a value";     shift 2 ;;
    --out)      OUT_DIR="${2:-}";  [ -n "$OUT_DIR" ]  || die "--out needs a value";      shift 2 ;;
    --zip)      MAKE_ZIP=1; shift ;;
    --clean)    DO_CLEAN=1; shift ;;
    -h|--help)  usage ;;
    *)          die "unknown option: $1  (try --help)" ;;
  esac
done

# --- prerequisites -----------------------------------------------------------

command -v node >/dev/null 2>&1 || die "node is not installed or not on PATH"
command -v npm  >/dev/null 2>&1 || die "npm is not installed or not on PATH"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "node 18 or newer is required (found $(node -v))"

say "Node $(node -v), npm $(npm -v)"

if [ ! -d node_modules ]; then
  say "Installing dependencies"
  if [ -f package-lock.json ]; then npm ci; else npm install; fi
else
  note "dependencies already installed"
fi

# --- sanity check ------------------------------------------------------------

say "Checking sources parse"
FAILED=0
while IFS= read -r file; do
  node --check "$file" >/dev/null 2>&1 || { printf '%s  syntax error: %s%s\n' "$RED" "$file" "$RESET"; FAILED=1; }
done < <(find src -name '*.js' -type f)
[ "$FAILED" -eq 0 ] || die "fix the syntax errors above before building"
note "all JavaScript parsed"

# --- build -------------------------------------------------------------------

if [ "$DO_CLEAN" -eq 1 ]; then
  say "Removing $OUT_DIR/"
  rm -rf "${OUT_DIR:?}"
fi

PACKAGER_ARGS=(
  .
  "$APP_NAME"
  --overwrite
  --asar
  --prune
  --out="$OUT_DIR"
  --ignore="^/(dist|CloudBrowser-win32-x64|\.git|.*\.sh|.*\.md)$"
)
[ -n "$PLATFORM" ] && PACKAGER_ARGS+=(--platform="$PLATFORM")
[ -n "$ARCH" ]     && PACKAGER_ARGS+=(--arch="$ARCH")

say "Packaging${PLATFORM:+ for $PLATFORM}${ARCH:+/$ARCH}"
note "this downloads an Electron binary the first time and takes a minute"
npx --yes @electron/packager "${PACKAGER_ARGS[@]}"

# --- report ------------------------------------------------------------------

BUILD_DIR="$(find "$OUT_DIR" -maxdepth 1 -mindepth 1 -type d | head -n 1)"
[ -n "$BUILD_DIR" ] || die "packager produced no output in $OUT_DIR/"

if [ "$MAKE_ZIP" -eq 1 ]; then
  say "Compressing"
  ( cd "$OUT_DIR" && zip -qr "$(basename "$BUILD_DIR").zip" "$(basename "$BUILD_DIR")" ) \
    || note "zip is unavailable; skipping the archive"
fi

SIZE="$(du -sh "$BUILD_DIR" 2>/dev/null | cut -f1)"
printf '\n%sBuilt%s %s  %s(%s)%s\n' "$GREEN" "$RESET" "$BUILD_DIR" "$DIM" "${SIZE:-unknown size}" "$RESET"
note "run it from that folder, or use 'npm start' for development"
