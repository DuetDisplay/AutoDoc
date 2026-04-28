#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

APP_BUNDLE="${AUTODOC_TCC_APP_BUNDLE:-}"
BUNDLE_ID="${AUTODOC_TCC_BUNDLE_ID:-com.kairos.autodoc}"
SERVICE="${AUTODOC_TCC_SERVICE:-kTCCServiceMicrophone}"
RESET_TCC="${AUTODOC_TCC_RESET:-1}"
RESET_APP_DATA="${AUTODOC_TCC_RESET_APP_DATA:-1}"
WAIT_TIMEOUT_SEC="${AUTODOC_TCC_WAIT_TIMEOUT_SEC:-20}"
USER_DATA_DIR="${AUTODOC_TEST_USER_DATA_DIR:-/tmp/autodoc-tcc-smoke-user-data}"
OPEN_SETTINGS="${AUTODOC_TCC_OPEN_SETTINGS:-0}"

log() {
  printf '[tcc-smoke] %s\n' "$*"
}

fail() {
  printf '[tcc-smoke] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

find_app_bundle() {
  local candidate

  if [[ -n "$APP_BUNDLE" ]]; then
    [[ -d "$APP_BUNDLE" ]] || fail "AUTODOC_TCC_APP_BUNDLE does not exist: $APP_BUNDLE"
    printf '%s\n' "$APP_BUNDLE"
    return 0
  fi

  for candidate in \
    "${REPO_ROOT}/dist/mac-arm64/AutoDoc.app" \
    "${REPO_ROOT}/dist/mac/AutoDoc.app" \
    "${REPO_ROOT}/dist/mac-universal/AutoDoc.app" \
    "${REPO_ROOT}/build/mac-arm64/AutoDoc.app" \
    "${REPO_ROOT}/build/mac/AutoDoc.app" \
    "${REPO_ROOT}/build/mac-universal/AutoDoc.app" \
    "/Applications/AutoDoc.app"
  do
    if [[ -d "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  fail "Could not find AutoDoc.app. Set AUTODOC_TCC_APP_BUNDLE or build an unpacked mac app first."
}

sqlite_query() {
  local db_path="$1"
  local sql="$2"
  sqlite3 -readonly -noheader "$db_path" "$sql"
}

resolve_tcc_db() {
  local db_path="${HOME}/Library/Application Support/com.apple.TCC/TCC.db"
  [[ -f "$db_path" ]] || fail "TCC database not found at $db_path"
  printf '%s\n' "$db_path"
}

lookup_tcc_row() {
  local db_path="$1"
  sqlite_query "$db_path" \
    "SELECT service || '|' || client || '|' || auth_value || '|' || auth_reason || '|' || last_modified FROM access WHERE service='${SERVICE}' AND client='${BUNDLE_ID}' ORDER BY last_modified DESC LIMIT 1;"
}

has_tcc_row() {
  local db_path="$1"
  local count
  count="$(sqlite_query "$db_path" "SELECT COUNT(*) FROM access WHERE service='${SERVICE}' AND client='${BUNDLE_ID}';")"
  [[ "${count:-0}" != "0" ]]
}

stop_autodoc() {
  killall AutoDoc 2>/dev/null || true
  killall -9 AutoDoc 2>/dev/null || true
}

reset_tcc() {
  log "Resetting microphone TCC state for ${BUNDLE_ID}"
  tccutil reset Microphone "${BUNDLE_ID}" >/dev/null 2>&1 || true
}

reset_app_data() {
  log "Resetting smoke app data at ${USER_DATA_DIR}"
  rm -rf "${USER_DATA_DIR}"
}

click_button() {
  local proc_name="$1"
  local button_name="$2"
  osascript <<APPLESCRIPT >/dev/null
tell application "System Events"
  tell process "${proc_name}"
    set frontmost to true
    repeat with w in windows
      try
        click (first button of w whose name is "${button_name}")
        return
      end try
    end repeat
  end tell
end tell
APPLESCRIPT
}

wait_for_button() {
  local proc_name="$1"
  local button_name="$2"
  local timeout_sec="$3"
  local deadline=$((SECONDS + timeout_sec))
  local result=""

  while (( SECONDS < deadline )); do
    result="$(osascript <<APPLESCRIPT 2>/dev/null || true
tell application "System Events"
  tell process "${proc_name}"
    repeat with w in windows
      try
        first button of w whose name is "${button_name}"
        return true
      end try
    end repeat
  end tell
end tell
return false
APPLESCRIPT
)"
    if [[ "$result" == "true" ]]; then
      return 0
    fi

    sleep 0.5
  done

  return 1
}

click_onboarding_path() {
  local proc_name="$1"

  wait_for_button "$proc_name" "Get Started" 30 || fail "Timed out waiting for Get Started"
  click_button "$proc_name" "Get Started"
  sleep 0.5

  wait_for_button "$proc_name" "Next" 10 || fail "Timed out waiting for first Next button"
  click_button "$proc_name" "Next"
  sleep 0.5
  wait_for_button "$proc_name" "Next" 10 || fail "Timed out waiting for second Next button"
  click_button "$proc_name" "Next"
  sleep 0.5
  wait_for_button "$proc_name" "Next" 10 || fail "Timed out waiting for third Next button"
  click_button "$proc_name" "Next"
  sleep 0.5

  wait_for_button "$proc_name" "Enable Microphone" 15 || fail "Timed out waiting for Enable Microphone"
  click_button "$proc_name" "Enable Microphone"
}

open_microphone_settings() {
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone" >/dev/null 2>&1 || true
}

main() {
  require_cmd osascript
  require_cmd sqlite3
  require_cmd tccutil

  local resolved_bundle
  resolved_bundle="$(find_app_bundle)"
  local executable="${resolved_bundle}/Contents/MacOS/AutoDoc"
  [[ -x "$executable" ]] || fail "App executable not found: $executable"

  local db_path
  db_path="$(resolve_tcc_db)"

  log "Using app bundle: ${resolved_bundle}"
  log "Using TCC database: ${db_path}"
  log "Checking service ${SERVICE} for client ${BUNDLE_ID}"

  stop_autodoc
  if [[ "$RESET_TCC" == "1" ]]; then
    reset_tcc
  fi
  if [[ "$RESET_APP_DATA" == "1" ]]; then
    reset_app_data
  fi

  local before_row
  before_row="$(lookup_tcc_row "$db_path" || true)"
  log "TCC row before launch: ${before_row:-<none>}"

  AUTODOC_TEST_USER_DATA_DIR="${USER_DATA_DIR}" "$executable" --reset-local-data >/dev/null 2>&1 &
  local app_pid=$!
  trap 'kill "${app_pid}" 2>/dev/null || true; stop_autodoc' EXIT

  click_onboarding_path "AutoDoc"

  local deadline=$((SECONDS + WAIT_TIMEOUT_SEC))
  local after_row=""
  while (( SECONDS < deadline )); do
    after_row="$(lookup_tcc_row "$db_path" || true)"
    if [[ -n "$after_row" ]]; then
      break
    fi
    sleep 0.5
  done

  if [[ "$OPEN_SETTINGS" == "1" ]]; then
    open_microphone_settings
  fi

  if [[ -n "$after_row" ]]; then
    log "TCC row after clicking Enable Microphone: ${after_row}"
    log "PASS: AutoDoc registered with macOS microphone privacy state."
    exit 0
  fi

  log "TCC row after clicking Enable Microphone: <none>"
  fail "AutoDoc did not register in the microphone TCC database within ${WAIT_TIMEOUT_SEC}s."
}

main "$@"
