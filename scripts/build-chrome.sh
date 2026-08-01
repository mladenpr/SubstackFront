#!/usr/bin/env bash
#
# Package the Chrome build for the Web Store.
#
# Produces dist/substack-front-<version>.zip containing exactly the files in
# scripts/shipping-files.txt, with manifest.json at the top level of the zip.
# That last part matters: the Web Store rejects an archive whose manifest is
# nested inside a directory, which is what `zip -r ext.zip .` from the parent
# gives you.
#
# Usage: scripts/build-chrome.sh [options]
#   --output-dir <dir>   Where to write the zip (default: dist)
#   -h, --help           Show this help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="$REPO_ROOT/dist"

usage() {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

PYTHON="$(command -v python3 || true)"
if [[ -z "$PYTHON" ]]; then
  echo "error: python3 is required" >&2
  exit 1
fi

VERSION="$("$PYTHON" -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' \
  "$REPO_ROOT/manifest.json")"

STAGE="$OUTPUT_DIR/chrome"
ZIP="$OUTPUT_DIR/substack-front-$VERSION.zip"

echo "==> Staging Chrome payload"
rm -rf "$STAGE"
mkdir -p "$STAGE"

cd "$REPO_ROOT"
file_count=0
while IFS= read -r relative; do
  mkdir -p "$STAGE/$(dirname "$relative")"
  cp "$relative" "$STAGE/$relative"
  file_count=$((file_count + 1))
done < <("$SCRIPT_DIR/list-shipping-files.sh")

echo "    $file_count files"

echo "==> Writing $ZIP"
rm -f "$ZIP"
# Built with python's zipfile rather than the zip binary: python3 is already a
# hard dependency of the Safari build, and fixing the timestamps makes the
# archive byte-identical for identical input.
"$PYTHON" - "$STAGE" "$ZIP" <<'PY'
import pathlib
import sys
import zipfile

stage, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
files = sorted(p for p in stage.rglob('*') if p.is_file())

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in files:
        info = zipfile.ZipInfo(str(path.relative_to(stage)), date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, path.read_bytes())

names = zipfile.ZipFile(out).namelist()
if 'manifest.json' not in names:
    sys.exit('error: manifest.json is not at the top level of the archive')
print(f'    {len(names)} entries, {out.stat().st_size:,} bytes')
PY

echo
echo "==> Done: $ZIP"
echo "    Upload at https://chrome.google.com/webstore/devconsole"
