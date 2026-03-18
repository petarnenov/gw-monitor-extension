#!/usr/bin/env bash
# Phase 0 — Compare current API responses against saved snapshots
# Usage: ./tests/compare-snapshots.sh [BASE_URL] [SNAPSHOT_DIR]
# Default: http://localhost:7103, tests/snapshots/latest

set -euo pipefail

BASE_URL="${1:-http://localhost:7103}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SNAP_DIR="${2:-$SCRIPT_DIR/snapshots/latest}"

if [ ! -d "$SNAP_DIR" ]; then
  echo "ERROR: Snapshot directory not found: $SNAP_DIR"
  echo "Run ./tests/snapshot.sh first to capture baseline snapshots."
  exit 1
fi

echo "=== Snapshot Comparison — $(date) ==="
echo "Server: $BASE_URL"
echo "Baseline: $SNAP_DIR"
echo ""

PASS=0
FAIL=0
SKIP=0

compare() {
  local filename="$1"
  local metafile="$SNAP_DIR/${filename}.meta"
  local baseline="$SNAP_DIR/${filename}.json"

  if [ ! -f "$metafile" ] || [ ! -f "$baseline" ]; then
    printf "  %-40s → SKIP (no baseline)\n" "$filename"
    SKIP=$((SKIP + 1))
    return
  fi

  # Read method and path from meta
  local method path
  method=$(grep '^method=' "$metafile" | cut -d= -f2)
  path=$(grep '^path=' "$metafile" | cut -d= -f2)

  local url="$BASE_URL$path"
  local tmpfile
  tmpfile=$(mktemp)

  # Fetch current response
  if [ "$method" = "GET" ]; then
    curl -s --max-time 10 "$url" > "$tmpfile" 2>/dev/null || true
  else
    # For POST/PUT, skip comparison (state-changing)
    printf "  %-40s → SKIP (state-changing %s)\n" "$filename" "$method"
    SKIP=$((SKIP + 1))
    rm -f "$tmpfile"
    return
  fi

  # Compare structure (keys only) using jq if available
  if command -v jq &>/dev/null; then
    # Extract and sort keys for structural comparison
    local baseline_keys current_keys
    baseline_keys=$(jq -S 'paths | map(tostring) | join(".")' "$baseline" 2>/dev/null | sort -u) || baseline_keys=""
    current_keys=$(jq -S 'paths | map(tostring) | join(".")' "$tmpfile" 2>/dev/null | sort -u) || current_keys=""

    if [ -z "$baseline_keys" ] && [ -z "$current_keys" ]; then
      # Not JSON — do plain text diff
      if diff -q "$baseline" "$tmpfile" &>/dev/null; then
        printf "  %-40s → PASS (identical)\n" "$filename"
        PASS=$((PASS + 1))
      else
        printf "  %-40s → FAIL (content differs)\n" "$filename"
        echo "    --- Diff ---"
        diff --unified=3 "$baseline" "$tmpfile" | head -20 || true
        echo ""
        FAIL=$((FAIL + 1))
      fi
    else
      # JSON — compare structure
      local missing_keys new_keys
      missing_keys=$(comm -23 <(echo "$baseline_keys") <(echo "$current_keys"))
      new_keys=$(comm -13 <(echo "$baseline_keys") <(echo "$current_keys"))

      if [ -z "$missing_keys" ] && [ -z "$new_keys" ]; then
        printf "  %-40s → PASS (structure match)\n" "$filename"
        PASS=$((PASS + 1))
      else
        printf "  %-40s → FAIL (structure differs)\n" "$filename"
        if [ -n "$missing_keys" ]; then
          echo "    Missing keys:"
          echo "$missing_keys" | head -10 | sed 's/^/      - /'
        fi
        if [ -n "$new_keys" ]; then
          echo "    New keys:"
          echo "$new_keys" | head -10 | sed 's/^/      + /'
        fi
        echo ""
        FAIL=$((FAIL + 1))
      fi
    fi
  else
    # No jq — fallback to plain diff
    if diff -q "$baseline" "$tmpfile" &>/dev/null; then
      printf "  %-40s → PASS\n" "$filename"
      PASS=$((PASS + 1))
    else
      printf "  %-40s → FAIL\n" "$filename"
      diff --unified=3 "$baseline" "$tmpfile" | head -20 || true
      echo ""
      FAIL=$((FAIL + 1))
    fi
  fi

  rm -f "$tmpfile"
}

# Compare all saved snapshots
echo "--- Comparing GET endpoints ---"
for metafile in "$SNAP_DIR"/*.meta; do
  [ -f "$metafile" ] || continue
  filename=$(basename "$metafile" .meta)
  compare "$filename"
done

echo ""
echo "=== Results ==="
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo "  SKIP: $SKIP"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "REGRESSION DETECTED — $FAIL endpoint(s) changed!"
  exit 1
else
  echo "All endpoints match baseline."
  exit 0
fi
