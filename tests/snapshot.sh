#!/usr/bin/env bash
# Phase 0 — Capture API snapshots from all server endpoints
# Usage: ./tests/snapshot.sh [BASE_URL]
# Default: http://localhost:7103

set -euo pipefail

BASE_URL="${1:-http://localhost:7103}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SNAP_DIR="$SCRIPT_DIR/snapshots"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SNAP_DEST="$SNAP_DIR/$TIMESTAMP"

mkdir -p "$SNAP_DEST"

echo "=== API Snapshot — $(date) ==="
echo "Server: $BASE_URL"
echo "Output: $SNAP_DEST"
echo ""

# Helper: capture endpoint response + HTTP status
capture() {
  local method="$1"
  local path="$2"
  local filename="$3"
  local body="${4:-}"
  local timeout="${5:-10}"

  local url="$BASE_URL$path"
  local outfile="$SNAP_DEST/${filename}.json"
  local metafile="$SNAP_DEST/${filename}.meta"

  if [ "$method" = "GET" ]; then
    http_code=$(curl -s -o "$outfile" -w "%{http_code}" \
      --max-time "$timeout" "$url" 2>/dev/null) || http_code="TIMEOUT"
  else
    http_code=$(curl -s -o "$outfile" -w "%{http_code}" \
      --max-time "$timeout" \
      -X "$method" \
      -H "Content-Type: application/json" \
      ${body:+-d "$body"} \
      "$url" 2>/dev/null) || http_code="TIMEOUT"
  fi

  echo "method=$method" > "$metafile"
  echo "path=$path" >> "$metafile"
  echo "http_code=$http_code" >> "$metafile"
  echo "timestamp=$(date -Iseconds)" >> "$metafile"

  if [ "$http_code" = "TIMEOUT" ]; then
    printf "  %-6s %-40s → TIMEOUT\n" "$method" "$path"
  else
    printf "  %-6s %-40s → %s\n" "$method" "$path" "$http_code"
  fi
}

# ─── GET endpoints (safe to snapshot) ─────────────────────────────

echo "--- GET endpoints ---"
capture GET  "/ping"                         "ping"
capture GET  "/status"                       "status"           ""  15
capture GET  "/logs/tomcat"                  "logs_tomcat"      ""  10
capture GET  "/logs/agent/SomeAgent"         "logs_agent"       ""  10
capture GET  "/git/branches"                 "git_branches"     ""  15
capture GET  "/git/status"                   "git_status"       ""  10
capture GET  "/deploy/status"                "deploy_status"
capture GET  "/deploy/stream"                "deploy_stream"    ""  5

# ─── POST/PUT endpoints (read-only or safe ones only) ─────────────
# NOTE: Dangerous endpoints (stop/restart/deploy) are NOT captured
# automatically. Use --dangerous flag to include them.

echo ""
echo "--- Safe POST/PUT endpoints ---"
capture POST "/exec"                         "exec_uptime"      '{"cmd":"uptime"}'
capture POST "/exec"                         "exec_df"          '{"cmd":"df -h"}'

echo ""

# ─── Dangerous endpoints (only with --dangerous flag) ─────────────

if [[ "${2:-}" == "--dangerous" ]]; then
  echo "--- DANGEROUS endpoints (state-changing) ---"
  echo "WARNING: These endpoints modify server state!"
  echo ""
  capture POST "/stop/tomcat"                "stop_tomcat"
  capture POST "/restart/tomcat"             "restart_tomcat"
  capture POST "/stop/agent/SomeAgent"       "stop_agent"
  capture POST "/restart/agent/SomeAgent"    "restart_agent"
  capture POST "/restart/agents"             "restart_agents"
  capture POST "/restart/server"             "restart_server"
  capture POST "/system/clear-swap"          "system_clear_swap"
  capture POST "/system/free-ram"            "system_free_ram"
  capture PUT  "/config/agent/SomeAgent/autostart"  "config_autostart"  '{"enabled":true}'
  capture PUT  "/config/agent/SomeAgent/memory"     "config_memory"     '{"memory":"512m"}'
  capture POST "/git/stash"                  "git_stash"
  capture POST "/pull"                       "pull"             '{"branch":"master"}'
  capture POST "/deploy"                     "deploy"           '{"branch":"master"}'
  capture POST "/quick-deploy"               "quick_deploy"     '{"agents":[],"restartTomcat":false}'
else
  echo "--- Skipped dangerous endpoints (use --dangerous to include) ---"
  echo "  POST /stop/tomcat"
  echo "  POST /restart/tomcat"
  echo "  POST /stop/agent/:name"
  echo "  POST /restart/agent/:name"
  echo "  POST /restart/agents"
  echo "  POST /restart/server"
  echo "  POST /system/clear-swap"
  echo "  POST /system/free-ram"
  echo "  PUT  /config/agent/:name/autostart"
  echo "  PUT  /config/agent/:name/memory"
  echo "  POST /git/stash"
  echo "  POST /pull"
  echo "  POST /deploy"
  echo "  POST /quick-deploy"
fi

echo ""
echo "=== Done. Snapshots saved to: $SNAP_DEST ==="
echo ""

# Create/update 'latest' symlink
ln -sfn "$SNAP_DEST" "$SNAP_DIR/latest"
echo "Symlink: $SNAP_DIR/latest → $SNAP_DEST"
