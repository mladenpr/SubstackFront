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
#   --build-number <n>         Set CURRENT_PROJECT_VERSION; App Store Connect
#                              needs a new one for every upload of a version
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
APPICON_DIR="$SCRIPT_DIR/appicon/AppIcon.appiconset"

APP_NAME="Substack Front"
BUNDLE_ID="com.example.substackfront"
BUILD_NUMBER=""
PLATFORM_FLAGS=()
RUN_CONVERTER=1
OPEN_XCODE=0

usage() {
  # Print the header comment block, minus the shebang.
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-name)          APP_NAME="$2"; shift 2 ;;
    --bundle-identifier) BUNDLE_ID="$2"; shift 2 ;;
    --build-number)      BUILD_NUMBER="$2"; shift 2 ;;
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

# The file list is shared with the Chrome packager (scripts/shipping-files.txt)
# so the two builds cannot disagree about what ships.
echo "==> Assembling Safari payload in $PAYLOAD_DIR"
rm -rf "$PAYLOAD_DIR"
mkdir -p "$PAYLOAD_DIR"

payload_files=0
while IFS= read -r relative; do
  mkdir -p "$PAYLOAD_DIR/$(dirname "$relative")"
  cp "$REPO_ROOT/$relative" "$PAYLOAD_DIR/$relative"
  payload_files=$((payload_files + 1))
done < <("$REPO_ROOT/scripts/list-shipping-files.sh")

echo "    $payload_files files"

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

# Xcode requires an app extension's bundle identifier to be prefixed with its
# parent app's. The converter does not guarantee that: Xcode 26 derives the app
# target's identifier from a prefix plus the product name, so passing
# com.example.app yields an app of com.example.App-Name alongside an extension
# of com.example.app.Extension, and ValidateEmbeddedBinary fails the build.
# Pin both to the identifier that was asked for.
echo "==> Normalizing bundle identifiers and version"
"$PYTHON" - "$PROJECT_DIR" "$BUNDLE_ID" "$PAYLOAD_DIR/manifest.json" "$BUILD_NUMBER" <<'PY'
import json
import pathlib
import re
import sys

project_dir, bundle_id, manifest_path, build_number = sys.argv[1:5]

pbxprojs = sorted(pathlib.Path(project_dir).rglob('*.xcodeproj/project.pbxproj'))
if not pbxprojs:
    sys.exit(f'error: no project.pbxproj found under {project_dir}')

SETTING = re.compile(r'(PRODUCT_BUNDLE_IDENTIFIER = )([^;]+)(;)')


def target_identifier(current):
    """App targets get the identifier verbatim; extensions get it as a prefix."""
    trailing = current.strip('"').rsplit('.', 1)[-1]
    if 'extension' in trailing.lower():
        return f'{bundle_id}.{trailing}'
    return bundle_id


seen = []

for path in pbxprojs:
    text = path.read_text()

    def replace(match):
        new = target_identifier(match.group(2))
        seen.append((match.group(2), new))
        return f'{match.group(1)}{new}{match.group(3)}'

    updated, count = SETTING.subn(replace, text)
    if not count:
        sys.exit(f'error: {path} declares no PRODUCT_BUNDLE_IDENTIFIER')

    path.write_text(updated)

for old, new in dict.fromkeys(seen):
    print(f'    {old}  ->  {new}')

final = {new for _, new in seen}
if not any(identifier == bundle_id for identifier in final):
    sys.exit(f'error: no target ended up with the app identifier {bundle_id}')
for identifier in final:
    if identifier != bundle_id and not identifier.startswith(f'{bundle_id}.'):
        sys.exit(f'error: {identifier} is not nested under {bundle_id}')

# The App Store shows the app's version, not the extension's. Drive it from
# manifest.json so a release cannot ship with the two disagreeing.
version = json.loads(pathlib.Path(manifest_path).read_text())['version']

wanted = {'MARKETING_VERSION': version}
if build_number:
    # App Store Connect rejects a re-uploaded build number, so this is only set
    # when asked for.
    wanted['CURRENT_PROJECT_VERSION'] = build_number

for setting, value in wanted.items():
    pattern = re.compile(rf'({setting} = )([^;]+)(;)')
    total = 0
    for path in pbxprojs:
        text = path.read_text()
        updated, count = pattern.subn(rf'\g<1>{value}\g<3>', text)
        if count:
            path.write_text(updated)
        total += count
    if total:
        print(f'    {setting} -> {value}')
    else:
        print(f'    warning: no {setting} build setting found; '
              f'set the version in Xcode before submitting', file=sys.stderr)
PY

# The converter ships a placeholder app icon. Swap in the real set, which is
# generated from icons/appicon-source.png by safari/make-appicon.py.
echo "==> Installing app icons"
if [[ ! -d "$APPICON_DIR" ]]; then
  echo "error: $APPICON_DIR is missing; regenerate it with safari/make-appicon.py" >&2
  exit 1
fi

appicon_files="$(find "$APPICON_DIR" -type f | wc -l | tr -d ' ')"
appicon_targets=0
while IFS= read -r destination; do
  rm -rf "${destination:?}"/*
  cp "$APPICON_DIR"/* "$destination/"
  echo "    $appicon_files files -> ${destination#"$PROJECT_DIR"/}"
  appicon_targets=$((appicon_targets + 1))
done < <(find "$PROJECT_DIR" -type d -name 'AppIcon.appiconset')

if [[ "$appicon_targets" -eq 0 ]]; then
  echo "    warning: no AppIcon.appiconset in the generated project; set the icon in Xcode" >&2
fi

echo
echo "==> Done. Xcode project: $PROJECT_DIR"
echo "    Next: open it, set your signing team, and run the app once to register"
echo "    the extension with Safari. See safari/README.md for the full checklist."
