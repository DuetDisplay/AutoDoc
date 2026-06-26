#!/usr/bin/env bash

set -euo pipefail

BUNDLE_ID="${AUTODOC_QA_RESET_BUNDLE_ID:-com.kairos.autodoc}"
INCLUDE_DEV=0
MODE="run"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/macOSFullUninstall.sh
  bash scripts/macOSFullUninstall.sh --check
  bash scripts/macOSFullUninstall.sh --run

Options:
  --check        Report whether this macOS user account is clean for fresh AutoDoc QA.
  --run          Stop AutoDoc/Ollama, remove AutoDoc app/data, reset macOS permissions,
                 and then verify the machine is clean.
  --include-dev  Also remove the local dev userData folder:
                 ~/Library/Application Support/AutoDoc Dev
EOF
}

log() {
  printf '[qa-reset] %s\n' "$*"
}

success() {
  printf '\033[32m[qa-reset] %s\033[0m\n' "$*"
}

warn() {
  printf '[qa-reset] WARN: %s\n' "$*" >&2
}

fail() {
  printf '\033[31m[qa-reset] ERROR: %s\033[0m\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)
      MODE="check"
      shift
      ;;
    --run)
      MODE="run"
      shift
      ;;
    --include-dev)
      INCLUDE_DEV=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      fail "Unknown argument: $1"
      ;;
  esac
done

get_target_paths() {
  local paths=(
    "$HOME/Library/Application Support/AutoDoc"
    "$HOME/Library/Application Support/autodoc"
    "$HOME/Library/Application Support/Autodoc"
    "$HOME/AutoDoc"
    "$HOME/Applications/AutoDoc.app"
    "/Applications/AutoDoc.app"
  )

  if [[ "$INCLUDE_DEV" == "1" ]]; then
    paths+=("$HOME/Library/Application Support/AutoDoc Dev")
  fi

  printf '%s\n' "${paths[@]}"
}

list_existing_targets() {
  local path
  while IFS= read -r path; do
    [[ -e "$path" ]] && printf '%s\n' "$path"
  done < <(get_target_paths)
}

process_running() {
  pgrep -x "AutoDoc" >/dev/null 2>&1 || pgrep -x "ollama" >/dev/null 2>&1
}

print_running_processes() {
  ps -ax -o pid=,comm= | awk '
    $2 ~ /\/AutoDoc$/ || $2 ~ /\/ollama$/ || $2 == "AutoDoc" || $2 == "ollama" {
      print
    }
  '
}

tcc_db_path() {
  printf '%s\n' "$HOME/Library/Application Support/com.apple.TCC/TCC.db"
}

tcc_count() {
  local service="$1"
  local db_path
  db_path="$(tcc_db_path)"

  if ! command -v sqlite3 >/dev/null 2>&1; then
    printf 'unknown\n'
    return 0
  fi

  if [[ ! -f "$db_path" ]]; then
    printf 'unknown\n'
    return 0
  fi

  sqlite3 -readonly -noheader "$db_path" \
    "SELECT COUNT(*) FROM access WHERE service='${service}' AND client='${BUNDLE_ID}';" 2>/dev/null \
    || printf 'unknown\n'
}

report_state() {
  local clean=0
  local existing=()
  local line

  while IFS= read -r line; do
    [[ -n "$line" ]] && existing+=("$line")
  done < <(list_existing_targets)

  log "Bundle ID: ${BUNDLE_ID}"

  if process_running; then
    clean=1
    log "Running processes:"
    print_running_processes || true
  else
    log "Running processes: none"
  fi

  if [[ "${#existing[@]}" -gt 0 ]]; then
    clean=1
    log "Existing reset targets:"
    printf '%s\n' "${existing[@]}"
  else
    log "Existing reset targets: none"
  fi

  local mic_count screen_count
  mic_count="$(tcc_count 'kTCCServiceMicrophone')"
  screen_count="$(tcc_count 'kTCCServiceScreenCapture')"

  if [[ "$mic_count" == "unknown" || "$screen_count" == "unknown" ]]; then
    warn "Could not verify TCC rows with sqlite3; permission reset status is unknown."
  else
    log "TCC rows: microphone=${mic_count} screen=${screen_count}"
    if [[ "$mic_count" != "0" || "$screen_count" != "0" ]]; then
      clean=1
    fi
  fi

  return "$clean"
}

stop_processes() {
  log "Stopping AutoDoc and Ollama if running"
  osascript -e 'quit app "AutoDoc"' >/dev/null 2>&1 || true
  pkill -x "AutoDoc" >/dev/null 2>&1 || true
  pkill -x "ollama" >/dev/null 2>&1 || true
  sleep 1

  if process_running; then
    warn "Processes still running after initial stop attempt; escalating"
    pkill -9 -x "AutoDoc" >/dev/null 2>&1 || true
    pkill -9 -x "ollama" >/dev/null 2>&1 || true
    sleep 1
  fi
}

move_target_to_staging() {
  local target="$1"
  local staging_dir="$2"
  local base_name
  base_name="$(basename "$target")"
  local staged_path="${staging_dir}/${base_name}"

  if [[ ! -e "$target" ]]; then
    return 0
  fi

  log "Staging $target"
  if mv "$target" "$staged_path" 2>/dev/null; then
    return 0
  fi

  if sudo mv "$target" "$staged_path" 2>/dev/null; then
    return 0
  fi

  fail "Failed to move $target into staging"
}

remove_targets() {
  local staging_dir
  staging_dir="$(mktemp -d "/tmp/autodoc-qa-reset.XXXXXX")"
  trap 'rm -rf "$staging_dir" >/dev/null 2>&1 || true' EXIT

  log "Using staging dir $staging_dir"

  local target
  while IFS= read -r target; do
    move_target_to_staging "$target" "$staging_dir"
  done < <(get_target_paths)

  log "Deleting staged content"
  rm -rf "$staging_dir" >/dev/null 2>&1 || true
  trap - EXIT
}

reset_tcc() {
  log "Resetting macOS privacy permissions for ${BUNDLE_ID}"
  tccutil reset Microphone "$BUNDLE_ID" >/dev/null 2>&1 || true
  tccutil reset ScreenCapture "$BUNDLE_ID" >/dev/null 2>&1 || true
}

run_reset() {
  stop_processes
  remove_targets
  reset_tcc

  if report_state; then
    success "Machine is clean for fresh AutoDoc QA."
    exit 0
  fi

  fail "Reset completed with leftover state. See report above."
}

if [[ "$MODE" == "run" ]]; then
  run_reset
fi

if report_state; then
  success "Machine is clean for fresh AutoDoc QA."
  exit 0
fi

printf '\033[31m[qa-reset] Machine is NOT clean for fresh AutoDoc QA.\033[0m\n'
exit 1
