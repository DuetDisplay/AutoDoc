#!/usr/bin/env bash
# Smoke tests for macOS auto-updater against a local generic feed.
#
# Prerequisites:
#   build-update-old-<STAMP> and build-update-new-<STAMP> with DMG + zip + .app
#   latest-mac.yml in the new build directory pointing at the new zip
#
# Environment:
#   AUTODOC_UPDATE_ARTIFACTS  Root dir containing build-update-* folders
#   AUTODOC_UPDATE_STAMP        Build stamp (default: 150900)
#   AUTODOC_UPDATE_FEED_PORT    Local feed port (default: 18765)
#   AUTODOC_UPDATE_PATCH_APP_UPDATE_YML  1 to rewrite app-update.yml after install
#   AUTODOC_SMOKE_VERBOSE       1 for extra logging

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

STAMP="${AUTODOC_UPDATE_STAMP:-150900}"
ARTIFACTS_ROOT="${AUTODOC_UPDATE_ARTIFACTS:-/Users/chris/Documents/AutoDoc-update-artifacts/${STAMP}}"
FEED_PORT="${AUTODOC_UPDATE_FEED_PORT:-18765}"
PATCH_APP_UPDATE_YML="${AUTODOC_UPDATE_PATCH_APP_UPDATE_YML:-0}"
VERBOSE="${AUTODOC_SMOKE_VERBOSE:-0}"

OLD_DIR="${ARTIFACTS_ROOT}/build-update-old-${STAMP}"
NEW_DIR="${ARTIFACTS_ROOT}/build-update-new-${STAMP}"
INSTALLED_APP="/Applications/AutoDoc.app"
USER_DATA_DIR="/tmp/autodoc-updater-smoke-${STAMP}"
LOG_DIR="/tmp/autodoc-updater-smoke-logs-${STAMP}"
FEED_PID=""

vlog() { [[ "$VERBOSE" == 1 ]] && echo "[smoke] $*" >&2 || true; }

die() { echo "FATAL: $*" >&2; exit 1; }

results=()
record() {
  local name="$1" ok="$2" detail="${3:-}"
  results+=("${name}|${ok}|${detail}")
  if [[ "$ok" == "1" ]]; then
    echo "[PASS] $name"
  else
    echo "[FAIL] $name"
  fi
  [[ -n "$detail" ]] && echo "       $detail"
  return 0
}

stop_feed() {
  if [[ -n "${FEED_PID:-}" ]] && kill -0 "$FEED_PID" 2>/dev/null; then
    kill "$FEED_PID" 2>/dev/null || true
    wait "$FEED_PID" 2>/dev/null || true
  fi
  FEED_PID=""
}

start_feed() {
  stop_feed
  mkdir -p "$LOG_DIR"
  (cd "$NEW_DIR" && python3 -m http.server "$FEED_PORT" --bind 127.0.0.1 >"${LOG_DIR}/feed.log" 2>&1) &
  FEED_PID=$!
  sleep 1
  curl -sfI "http://127.0.0.1:${FEED_PORT}/latest-mac.yml" >/dev/null \
    || die "Feed not reachable on port ${FEED_PORT}"
  vlog "Feed running (pid ${FEED_PID}) from ${NEW_DIR}"
}

stop_all_autodoc() {
  killall AutoDoc 2>/dev/null || true
  sleep 2
  killall -9 AutoDoc 2>/dev/null || true
  sleep 1
  rm -f "$HOME/Library/Application Support/autodoc/SingletonLock" 2>/dev/null || true
  rm -f "$HOME/Library/Application Support/autodoc/SingletonSocket" 2>/dev/null || true
  rm -f "$HOME/Library/Application Support/autodoc/SingletonCookie" 2>/dev/null || true
}

patch_generic_feed() {
  local app="$1"
  [[ -d "$app" ]] || die "Missing app bundle: $app"
  cat >"${app}/Contents/Resources/app-update.yml" <<EOF
provider: generic
url: http://127.0.0.1:${FEED_PORT}/
updaterCacheDirName: autodoc-updater
EOF
}

get_bundle_version() {
  local app="$1"
  /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${app}/Contents/Info.plist" 2>/dev/null || echo ""
}

get_asar_version() {
  local asar="$1/Contents/Resources/app.asar"
  [[ -f "$asar" ]] || { echo ""; return 0; }
  (cd "$REPO_ROOT" && node -e "
const asar = require('@electron/asar');
const buf = asar.extractFile(process.argv[1], 'package.json');
process.stdout.write(JSON.parse(buf.toString()).version || '');
" "$asar" 2>/dev/null) || echo ""
}

install_from_dmg() {
  local dmg="$1"
  local mnt app_name="AutoDoc.app"
  mnt="$(mktemp -d /tmp/autodoc-updater-mnt.XXXXXX)"
  hdiutil attach -nobrowse -quiet -mountpoint "$mnt" "$dmg"
  rm -rf "$INSTALLED_APP"
  ditto "${mnt}/${app_name}" "$INSTALLED_APP"
  hdiutil detach -quiet "$mnt"
  rmdir "$mnt" 2>/dev/null || true
}

install_old_build() {
  local dmg="${OLD_DIR}/autodoc-0.1.23.dmg"
  local loose="${OLD_DIR}/mac-arm64/AutoDoc.app"
  if [[ -f "$dmg" ]]; then
    install_from_dmg "$dmg"
  elif [[ -d "$loose" ]]; then
    rm -rf "$INSTALLED_APP"
    ditto "$loose" "$INSTALLED_APP"
  else
    die "No old install artifact in ${OLD_DIR}"
  fi
  if [[ "$PATCH_APP_UPDATE_YML" == "1" ]]; then
    patch_generic_feed "$INSTALLED_APP"
  fi
}

feed_head_ok() {
  local url="$1"
  local status
  status=$(curl -sI --max-time 30 "$url" | head -1 || true)
  [[ "$status" == *"200"* ]]
}

seed_user_data() {
  rm -rf "$USER_DATA_DIR"
  mkdir -p "${USER_DATA_DIR}/recordings/legacy-meeting"
  mkdir -p "${USER_DATA_DIR}/recordings/current-meeting"
  printf 'legacy audio' > "${USER_DATA_DIR}/recordings/legacy-meeting/audio.webm"
  printf 'mic' > "${USER_DATA_DIR}/recordings/current-meeting/mic.webm"
  printf 'system' > "${USER_DATA_DIR}/recordings/current-meeting/system.webm"
  printf 'screen' > "${USER_DATA_DIR}/recordings/current-meeting/screen.webm"
  cat > "${USER_DATA_DIR}/recordings/current-meeting/metadata.json" <<'JSON'
{"id":"current-meeting","title":"Smoke Test Meeting","createdAt":"2026-06-01T12:00:00.000Z"}
JSON
  cat > "${USER_DATA_DIR}/recordings/current-meeting/transcript.json" <<'JSON'
{"segments":[{"startMs":0,"endMs":1000,"text":"update verification transcript","speakerId":"speaker-1"}]}
JSON
  cat > "${USER_DATA_DIR}/recordings/current-meeting/segments.json" <<'JSON'
[{"startMs":0,"endMs":1000,"title":"Intro"}]
JSON
  cat > "${USER_DATA_DIR}/recordings/current-meeting/speakers.json" <<'JSON'
{"speaker-1":{"label":"Alice"}}
JSON
  printf 'autodoc-updater-smoke-marker' > "${USER_DATA_DIR}/updater-smoke-marker.txt"
}

set_test_env() {
  launchctl setenv AUTODOC_TEST_MODE 1 >/dev/null 2>&1 || true
  launchctl setenv AUTODOC_TEST_USER_DATA_DIR "$USER_DATA_DIR" >/dev/null 2>&1 || true
  launchctl setenv AUTODOC_UPDATE_FEED_URL "http://127.0.0.1:${FEED_PORT}/" >/dev/null 2>&1 || true
  launchctl setenv AUTODOC_UPDATE_QUIT_AND_INSTALL_ON_DOWNLOAD 1 >/dev/null 2>&1 || true
}

clear_test_env() {
  launchctl unsetenv AUTODOC_TEST_MODE >/dev/null 2>&1 || true
  launchctl unsetenv AUTODOC_TEST_USER_DATA_DIR >/dev/null 2>&1 || true
  launchctl unsetenv AUTODOC_UPDATE_FEED_URL >/dev/null 2>&1 || true
  launchctl unsetenv AUTODOC_UPDATE_QUIT_AND_INSTALL_ON_DOWNLOAD >/dev/null 2>&1 || true
}

wait_for_log() {
  local file="$1" pattern="$2" timeout_sec="${3:-180}"
  local deadline=$((SECONDS + timeout_sec))
  while (( SECONDS < deadline )); do
    if [[ -f "$file" ]] && grep -qE "$pattern" "$file" 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

wait_for_version() {
  local expected="$1" timeout_sec="${2:-120}"
  local deadline=$((SECONDS + timeout_sec)) ver=""
  while (( SECONDS < deadline )); do
    ver="$(get_asar_version "$INSTALLED_APP")"
    [[ "$ver" == "$expected" ]] && { echo "$ver"; return 0; }
    sleep 2
  done
  echo "$(get_asar_version "$INSTALLED_APP")"
  return 1
}

wait_for_process_exit() {
  local pid="$1" timeout_sec="${2:-90}"
  local deadline=$((SECONDS + timeout_sec))
  while (( SECONDS < deadline )); do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

launch_installed() {
  local log_file="$1"
  set_test_env
  AUTODOC_TEST_MODE=1 \
  AUTODOC_TEST_USER_DATA_DIR="$USER_DATA_DIR" \
  AUTODOC_UPDATE_FEED_URL="http://127.0.0.1:${FEED_PORT}/" \
  AUTODOC_UPDATE_QUIT_AND_INSTALL_ON_DOWNLOAD=1 \
  "$INSTALLED_APP/Contents/MacOS/AutoDoc" >"$log_file" 2>&1 &
  echo $!
}

cleanup() {
  stop_feed
  stop_all_autodoc
  clear_test_env
}
trap cleanup EXIT

[[ -d "$OLD_DIR" ]] || die "Missing ${OLD_DIR}"
[[ -d "$NEW_DIR" ]] || die "Missing ${NEW_DIR}"
[[ -f "${NEW_DIR}/latest-mac.yml" ]] || die "Missing latest-mac.yml in ${NEW_DIR}"

echo "Updater smoke: stamp=${STAMP} feed=http://127.0.0.1:${FEED_PORT}/"
echo "Artifacts: ${ARTIFACTS_ROOT}"

echo ""
echo "=== 0) Feed HTTP checks ==="
start_feed
feed_head_ok "http://127.0.0.1:${FEED_PORT}/latest-mac.yml" && ok_feed_meta=1 || ok_feed_meta=0
feed_head_ok "http://127.0.0.1:${FEED_PORT}/AutoDoc-0.1.24-arm64-mac.zip" && ok_feed_zip=1 || ok_feed_zip=0
record "0a latest-mac.yml reachable" "$ok_feed_meta"
record "0b update zip reachable" "$ok_feed_zip"

echo ""
echo "=== 1) Automatic update (launch, download, quit, relaunch) ==="
stop_all_autodoc
install_old_build
seed_user_data
v_pre="$(get_asar_version "$INSTALLED_APP")"
log_auto="${LOG_DIR}/automatic.log"
pid="$(launch_installed "$log_auto")"
vlog "Launched pid ${pid}, waiting for update download..."
if wait_for_log "$log_auto" 'Auto-updater smoke install: update downloaded|update-downloaded|Update has been downloaded|downloaded update' 240; then
  ok_download=1
else
  # electron-updater may not log clearly; also check cache dir growth
  cache_dir="$HOME/Library/Caches/autodoc-updater"
  if [[ -d "$cache_dir" ]] && find "$cache_dir" -name '*.zip' -newer "$log_auto" 2>/dev/null | grep -q .; then
    ok_download=1
  else
    ok_download=0
  fi
fi
if [[ "$ok_download" == "1" ]]; then
  wait_for_process_exit "$pid" 90 || kill "$pid" 2>/dev/null || killall AutoDoc 2>/dev/null || true
else
  kill "$pid" 2>/dev/null || killall AutoDoc 2>/dev/null || true
fi
sleep 3
stop_all_autodoc
sleep 5
# Relaunch after quit-install
log_relaunch="${LOG_DIR}/automatic-relaunch.log"
pid2="$(launch_installed "$log_relaunch")"
sleep 15
kill "$pid2" 2>/dev/null || killall AutoDoc 2>/dev/null || true
sleep 2
v_post="$(wait_for_version "0.1.24" 30 || true)"
ok_auto=0
[[ "$v_post" == "0.1.24" ]] && ok_auto=1
record "1 automatic update to 0.1.24" "$ok_auto" "version: ${v_pre} -> ${v_post}, download_detected=${ok_download}"
stop_all_autodoc

echo ""
echo "=== 2) Manual update path (reinstall old, check, install on quit) ==="
install_old_build
# Preserve seeded data marker through update
seed_user_data
marker_before="$USER_DATA_DIR/updater-smoke-marker.txt"
log_manual="${LOG_DIR}/manual.log"
pid3="$(launch_installed "$log_manual")"
sleep 8
# Trigger explicit check via AppleScript is brittle; rely on launch check + IPC not available.
# Wait for download again after fresh install.
wait_for_log "$log_manual" 'Auto-updater smoke install: update downloaded|update-downloaded|Update has been downloaded|downloaded update' 240 || true
wait_for_process_exit "$pid3" 90 || kill "$pid3" 2>/dev/null || killall AutoDoc 2>/dev/null || true
sleep 8
stop_all_autodoc
sleep 3
v_manual="$(wait_for_version "0.1.24" 60 || true)"
ok_manual=0
[[ "$v_manual" == "0.1.24" ]] && ok_manual=1
marker_after=0
[[ -f "$marker_before" ]] && marker_after=1
record "2 manual/quit install to 0.1.24" "$ok_manual" "installed version=${v_manual}, userDataMarker=${marker_after}"

echo ""
echo "=== 3) Post-update user data preserved ==="
ok_data=0
[[ -f "${USER_DATA_DIR}/recordings/legacy-meeting/audio.webm" \
   && -f "${USER_DATA_DIR}/recordings/current-meeting/transcript.json" \
   && -f "${USER_DATA_DIR}/updater-smoke-marker.txt" ]] && ok_data=1
record "3 user data survived update" "$ok_data" "userDataDir=${USER_DATA_DIR}"

echo ""
echo "=== Summary ==="
failed=0
for row in "${results[@]}"; do
  IFS='|' read -r n ok d <<< "$row"
  printf '%-40s %s %s\n' "$n" "$( [[ "$ok" == 1 ]] && echo OK || echo FAIL )" "$d"
  [[ "$ok" != "1" ]] && failed=$((failed + 1)) || true
done
echo ""
echo "Result: $((${#results[@]} - failed))/${#results[@]} passed"
echo "Logs: ${LOG_DIR}"
[[ "$failed" -eq 0 ]]
