#!/usr/bin/env bash
#
# Print every file that ships inside the extension, one per line, relative to
# the repo root.
#
# Both packagers call this rather than expanding scripts/shipping-files.txt
# themselves, so the Chrome zip and the Safari payload cannot drift. A pattern
# that matches nothing is an error, not an empty result - a rename that orphans
# a line should fail the build, not quietly ship less than it used to.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LIST="$SCRIPT_DIR/shipping-files.txt"

if [[ ! -f "$LIST" ]]; then
  echo "error: $LIST not found" >&2
  exit 1
fi

cd "$REPO_ROOT"

status=0
while IFS= read -r pattern || [[ -n "$pattern" ]]; do
  pattern="${pattern%%#*}"
  pattern="$(printf '%s' "$pattern" | tr -d '[:space:]')"
  [[ -z "$pattern" ]] && continue

  matches=()
  while IFS= read -r match; do
    [[ -f "$match" ]] && matches+=("$match")
  done < <(compgen -G "$pattern" || true)

  if [[ ${#matches[@]} -eq 0 ]]; then
    echo "error: '$pattern' in shipping-files.txt matches no file" >&2
    status=1
    continue
  fi

  printf '%s\n' "${matches[@]}"
done < "$LIST"

exit "$status"
