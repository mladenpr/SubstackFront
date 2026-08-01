#!/usr/bin/env bash
#
# Build the Safari flavour of Substack Front.
#
#   1. Assembles a Safari-ready copy of the extension in safari/build/extension
#      (shared source + the Safari manifest overrides).
#   2. Runs Apple's converter to generate an Xcode project in safari/build/xcode.
#
# Step 1 runs anywhere. Step 2 needs macOS with Xcode installed; pass
# --no-convert to stop after step 1 (useful for loading the payload into
# Safari's unsigned-extension developer mode by hand).
#
# Usage: safari/build.sh [options]
#   --app-name <name>          App name for the wrapper (default: "Substack Front")
#   --bundle-identifier <id>   Bundle ID (default: com.example.substackfront)
#   --macos-only               Generate only the macOS target
#   --ios-only                 Generate only the iOS target
#   --no-convert               Assemble the payload, skip the Xcode conversion
#   --open                     Open the generated project in Xcode when done
#   -h, --help                 Show this help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PAYLOAD_DIR="$SCRIPT_DIR/build/extension"
PROJECT_DIR="$SCRIPT_DIR/build/xcode"

APP_NAME="Substack Front"
BUNDLE_ID="com.example.substackfront"
PLATFORM_FLAGS=()
RUN_CONVERTER=1
OPEN_XCODE=0

# Files and directories copied verbatim from the repo root into the payload.
SHARED_PATHS=(background content newtab popup icons)

usage() {
  # Print the header comment block, minus the shebang.
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-name)          APP_NAME="$2"; shift 2 ;;
    --bundle-identifier) BUNDLE_ID="$2"; shift 2 ;;
    --macos-only)        PLATFORM_FLAGS+=(--macos-only); shift ;;
    --ios-only)          PLATFORM_FLAGS+=(--ios-only); shift ;;
    --no-convert)        RUN_CONVERTER=0; shift ;;
    --open)              OPEN_XCODE=1; shift ;;
    -h|--help)           usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

PYTHON="$(command -v python3 || true)"
if [[ -z "$PYTHON" ]]; then
  echo "error: python3 is required to generate the Safari manifest" >&2
  exit 1
fi

echo "==> Assembling Safari payload in $PAYLOAD_DIR"
rm -rf "$PAYLOAD_DIR"
mkdir -p "$PAYLOAD_DIR"

for path in "${SHARED_PATHS[@]}"; do
  if [[ ! -e "$REPO_ROOT/$path" ]]; then
    echo "error: missing $path in $REPO_ROOT" >&2
    exit 1
  fi
  cp -R "$REPO_ROOT/$path" "$PAYLOAD_DIR/"
done

# Drop anything that should never ship inside the extension bundle.
find "$PAYLOAD_DIR" -name '.DS_Store' -delete

echo "==> Generating manifest.json from manifest.json + manifest.overrides.json"
"$PYTHON" - "$REPO_ROOT/manifest.json" "$SCRIPT_DIR/manifest.overrides.json" "$PAYLOAD_DIR/manifest.json" <<'PY'
import json
import sys

base_path, overrides_path, out_path = sys.argv[1:4]

with open(base_path) as f:
    manifest = json.load(f)
with open(overrides_path) as f:
    overrides = json.load(f)

for key, value in overrides.items():
    if key.startswith('_'):
        continue
    if value is None:
        manifest.pop(key, None)
    else:
        manifest[key] = value

manifest = {k: v for k, v in manifest.items() if not k.startswith('_')}

background = manifest.get('background', {})
if 'service_worker' in background and 'scripts' in background:
    print('warning: background declares both service_worker and scripts; '
          'Safari will prefer scripts', file=sys.stderr)

with open(out_path, 'w') as f:
    json.dump(manifest, f, indent=2)
    f.write('\n')

print(f"    {manifest['name']} {manifest['version']} "
      f"(manifest_version {manifest['manifest_version']})")
PY

echo "==> Payload ready: $PAYLOAD_DIR"

if [[ "$RUN_CONVERTER" -eq 0 ]]; then
  echo
  echo "Skipping Xcode conversion (--no-convert)."
  echo "To load it unsigned in Safari on macOS:"
  echo "  1. Safari > Settings > Advanced > Show features for web developers"
  echo "  2. Safari > Develop > Developer Settings > Allow unsigned extensions"
  echo "  3. Develop > Web Extension Background Pages, after loading the app wrapper"
  echo "     (Safari cannot load a bare extension directory - a wrapper app is required)"
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: the Xcode converter only runs on macOS. Re-run with --no-convert" >&2
  exit 1
fi

if ! command -v xcrun >/dev/null 2>&1; then
  echo "error: xcrun not found. Install Xcode and the Command Line Tools" >&2
  exit 1
fi

if ! xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
  echo "error: safari-web-extension-converter not found." >&2
  echo "       Install Xcode (not just the Command Line Tools) and run:" >&2
  echo "       sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" >&2
  exit 1
fi

echo "==> Running safari-web-extension-converter"
rm -rf "$PROJECT_DIR"
mkdir -p "$PROJECT_DIR"

# Apple has changed this tool's options across Xcode releases. Anything not
# advertised by --help is skipped with a note rather than failing the build;
# the three flags below it are essential, so they are always passed.
CONVERTER_HELP="$(xcrun safari-web-extension-converter --help 2>&1 || true)"

CONVERTER_FLAGS=(
  --project-location "$PROJECT_DIR"
  --app-name "$APP_NAME"
  --bundle-identifier "$BUNDLE_ID"
)

add_optional_flag() {
  if printf '%s' "$CONVERTER_HELP" | grep -q -- "$1"; then
    CONVERTER_FLAGS+=("$@")
  else
    echo "    note: converter does not advertise $1, skipping it"
  fi
}

add_optional_flag --swift
add_optional_flag --copy-resources
add_optional_flag --force
add_optional_flag --no-prompt
if [[ "$OPEN_XCODE" -eq 0 ]]; then
  add_optional_flag --no-open
fi
for platform_flag in "${PLATFORM_FLAGS[@]+"${PLATFORM_FLAGS[@]}"}"; do
  add_optional_flag "$platform_flag"
done

xcrun safari-web-extension-converter "$PAYLOAD_DIR" "${CONVERTER_FLAGS[@]}"

echo
echo "==> Done. Xcode project: $PROJECT_DIR"
echo "    Next: open it, set your signing team, and run the app once to register"
echo "    the extension with Safari. See safari/README.md for the full checklist."
