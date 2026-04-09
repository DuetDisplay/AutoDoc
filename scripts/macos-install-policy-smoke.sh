#!/usr/bin/env bash
# Smoke checks for macOS installed-copy policy (/Applications vs loose .app).

set -euo pipefail

# Build artifacts (adjust stamp to match your output folders):
#   npx electron-vite build
#   npx electron-builder --mac dmg --publish never \
#     "-c.extraMetadata.version=0.1.7" "-c.directories.output=build-017-<STAMP>"
#   npx electron-builder --mac dmg --publish never \
#     "-c.extraMetadata.version=0.1.8" "-c.directories.output=build-018-<STAMP>"
# Loose copies need a .app bundle outside /Applications — from a dir build:
#   npx electron-builder --mac dir --publish never \
#     "-c.extraMetadata.version=0.1.7" "-c.directories.output=build-017-<STAMP>-dir"
#   npx electron-builder --mac dir --publish never \
#     "-c.extraMetadata.version=0.1.8" "-c.directories.output=build-018-<STAMP>-dir"
#
# Optional env:
#   AUTODOC_SMOKE_STAMP   suffix for build folders (default: 165235)
#   AUTODOC_LOOSE_SUFFIX  if set, loose apps live in build-017-${AUTODOC_LOOSE_SUFFIX} instead of AUTODOC_SMOKE_STAMP

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
STAMP="${AUTODOC_SMOKE_STAMP:-165235}"
LOOSE_STAMP="${AUTODOC_LOOSE_SUFFIX:-$STAMP}"

APP_NAME="AutoDoc.app"
INSTALLED_APP="/Applications/${APP_NAME}"

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
}

die() { echo "FATAL: $*" >&2; exit 1; }

assert_file() {
  [[ -e "$1" ]] || die "Missing $2: $1"
}

# --- macOS dialog titles (see promptForInstalledCopyReplacement in application-install.ts) ---
send_dialog() {
  local choice="${1:-Accept}"
  local timeout_sec="${2:-90}"
  local deadline=$((SECONDS + timeout_sec))
  while (( SECONDS < deadline )); do
    local out=1
    if [[ "$choice" == "Accept" ]]; then
      out=$(osascript <<'APPLESCRIPT' 2>/dev/null || echo "0"
tell application "System Events"
  repeat with proc in (every process whose name is "AutoDoc")
    repeat with w in every window of proc
      set wt to name of w as string
      if wt contains "Applications Copy" then
        set frontmost of proc to true
        try
          click button 1 of w
        on error
          keystroke return
        end try
        return "1"
      end if
    end repeat
  end repeat
end tell
return "0"
APPLESCRIPT
)
    else
      out=$(osascript <<'APPLESCRIPT' 2>/dev/null || echo "0"
tell application "System Events"
  repeat with proc in (every process whose name is "AutoDoc")
    repeat with w in every window of proc
      set wt to name of w as string
      if wt contains "Applications Copy" then
        set frontmost of proc to true
        try
          click button "Quit" of w
        on error
          key code 53
        end try
        return "1"
      end if
    end repeat
  end repeat
end tell
return "0"
APPLESCRIPT
)
    fi
    if [[ "$out" == "1" ]]; then
      sleep 0.8
      return 0
    fi
    sleep 0.4
  done
  return 1
}

send_dialog_quiet() {
  send_dialog "$1" "${2:-4}" 2>/dev/null || return 1
}

stop_all_autodoc() {
  killall AutoDoc 2>/dev/null || true
  sleep 2
}

# Main Electron binary per running .app (helpers use "AutoDoc Helper" paths).
count_instance_roots() {
  local n
  n=$(ps -ax -o args= 2>/dev/null | grep -E -c '[A]utoDoc\.app/Contents/MacOS/AutoDoc' || true)
  echo "$n"
}

wait_instance_count() {
  local expected="$1" timeout_sec="${2:-90}"
  local deadline=$((SECONDS + timeout_sec))
  while (( SECONDS < deadline )); do
    local got
    got="$(count_instance_roots)"
    [[ "$got" -eq "$expected" ]] && return 0
    sleep 0.5
  done
  die "Expected ${expected} instance(s), got $(count_instance_roots) after ${timeout_sec}s"
}

get_installed_version() {
  local asar="${INSTALLED_APP}/Contents/Resources/app.asar"
  [[ -f "$asar" ]] || { echo ""; return 0; }
  (cd "$REPO_ROOT" && node -e "
const asar = require('@electron/asar');
const buf = asar.extractFile(process.argv[1], 'package.json');
const j = JSON.parse(buf.toString());
process.stdout.write(j.version || '');
" "$asar" 2>/dev/null) || echo ""
}

install_from_dmg() {
  local dmg="$1"
  local mnt
  mnt="$(mktemp -d /tmp/autodoc-smoke-mnt.XXXXXX)"
  hdiutil attach -nobrowse -quiet -mountpoint "$mnt" "$dmg"
  ditto "${mnt}/${APP_NAME}" "$INSTALLED_APP"
  hdiutil detach -quiet "$mnt"
  rmdir "$mnt" 2>/dev/null || true
}

uninstall_installed() {
  rm -rf "$INSTALLED_APP"
  sleep 1
}

resolve_loose_bundle() {
  local root="$1"
  local sub p
  for sub in mac-arm64 mac-universal mac darwin arm64 x64; do
    p="${root}/${sub}/${APP_NAME}"
    if [[ -d "$p" ]]; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

find_loose_app() {
  local tag="$1"
  local root app
  for root in "${REPO_ROOT}/build-${tag}-${LOOSE_STAMP}-dir" "${REPO_ROOT}/build-${tag}-${LOOSE_STAMP}"; do
    app="$(resolve_loose_bundle "$root" 2>/dev/null || true)"
    [[ -n "$app" ]] && { echo "$app"; return 0; }
  done
  return 1
}

# --- Paths: DMGs from --mac dmg; loose bundles from --mac dir in the same or parallel *-dir output tree ---
DMG017="${REPO_ROOT}/build-017-${STAMP}/autodoc-0.1.7.dmg"
DMG018="${REPO_ROOT}/build-018-${STAMP}/autodoc-0.1.8.dmg"

LOOSE017_APP="$(find_loose_app 017)" || die "No loose 0.1.7 .app — add electron-builder --mac dir output under build-017-${LOOSE_STAMP} or build-017-${LOOSE_STAMP}-dir"
LOOSE018_APP="$(find_loose_app 018)" || die "No loose 0.1.8 .app — add electron-builder --mac dir output under build-018-${LOOSE_STAMP} or build-018-${LOOSE_STAMP}-dir"

assert_file "$DMG017" "0.1.7 dmg"
assert_file "$DMG018" "0.1.8 dmg"
assert_file "$LOOSE017_APP/Contents/MacOS/AutoDoc" "0.1.7 loose app"
assert_file "$LOOSE018_APP/Contents/MacOS/AutoDoc" "0.1.8 loose app"

echo ""
echo "=== Cleanup ==="
stop_all_autodoc
uninstall_installed

echo ""
echo "=== 1) Install 0.1.8, launch installed — opens normally ==="
install_from_dmg "$DMG018"
open "$INSTALLED_APP"
sleep 6
c=$(count_instance_roots)
record "1 installed launch" "$( [[ "$c" -eq 1 ]] && echo 1 || echo 0 )" "instances: $c"
stop_all_autodoc

echo ""
echo "=== 2) Launch installed twice — single instance ==="
open "$INSTALLED_APP"
sleep 6
open "$INSTALLED_APP"
sleep 4
c2=$(count_instance_roots)
record "2 single instance" "$( [[ "$c2" -eq 1 ]] && echo 1 || echo 0 )" "instances: $c2"
stop_all_autodoc

echo ""
echo "=== 3a) Same-version loose cold — redirects to /Applications, no dialog ==="
open "$LOOSE018_APP"
sleep 12
dlg=0
send_dialog_quiet Accept 3 && dlg=1 || true
c3=$(count_instance_roots)
running_apps=false
if [[ "$c3" -ge 1 ]] && ps -ax -o args= | grep -q "[/]Applications[/]AutoDoc.app/Contents/MacOS/AutoDoc"; then
  running_apps=true
fi
stop_all_autodoc
ok3a=0
[[ "$dlg" -eq 0 && "$c3" -eq 1 && "$running_apps" == "true" ]] && ok3a=1
record "3a same-ver loose cold redirect" "$ok3a" "dialog detected: $dlg, instances: $c3, from /Applications: $running_apps"

echo ""
echo "=== 3b) Same-version loose while running — focus, no dialog ==="
open "$INSTALLED_APP"
sleep 6
open "$LOOSE018_APP"
sleep 6
dlg3b=0
send_dialog_quiet Accept 4 && dlg3b=1 || true
c3b=$(count_instance_roots)
stop_all_autodoc
record "3b same-ver loose warm" "$( [[ $dlg3b -eq 0 && $c3b -eq 1 ]] && echo 1 || echo 0 )" "dialog: $dlg3b, instances: $c3b"

echo ""
echo "=== 4) Upgrade: install 0.1.7, loose 0.1.8 cold — accept ==="
uninstall_installed
install_from_dmg "$DMG017"
v_pre="$(get_installed_version)"
open "$LOOSE018_APP"
sleep 12
send_dialog Accept 90 || die "Upgrade dialog not found"
wait_instance_count 1 120
sleep 8
v_post="$(get_installed_version)"
stop_all_autodoc
record "4 upgrade cold accept" "$( [[ "$v_post" == "0.1.8" ]] && echo 1 || echo 0 )" "version: $v_pre -> $v_post"

echo ""
echo "=== 5) Downgrade: install 0.1.8, loose 0.1.7 cold — accept ==="
uninstall_installed
install_from_dmg "$DMG018"
v_pre5="$(get_installed_version)"
open "$LOOSE017_APP"
sleep 12
send_dialog Accept 90 || die "Downgrade dialog not found"
wait_instance_count 1 120
sleep 8
v_post5="$(get_installed_version)"
stop_all_autodoc
record "5 downgrade cold accept" "$( [[ "$v_post5" == "0.1.7" ]] && echo 1 || echo 0 )" "version: $v_pre5 -> $v_post5"

echo ""
echo "=== 6) Upgrade warm: 0.1.7 running + loose 0.1.8 — accept ==="
uninstall_installed
install_from_dmg "$DMG017"
open "$INSTALLED_APP"
sleep 8
open "$LOOSE018_APP"
sleep 10
send_dialog Accept 90 || die "Upgrade warm dialog not found"
wait_instance_count 1 120
sleep 8
v6="$(get_installed_version)"
stop_all_autodoc
record "6 upgrade warm accept" "$( [[ "$v6" == "0.1.8" ]] && echo 1 || echo 0 )" "version: $v6"

echo ""
echo "=== 7) Downgrade warm: 0.1.8 running + loose 0.1.7 — accept ==="
uninstall_installed
install_from_dmg "$DMG018"
open "$INSTALLED_APP"
sleep 8
open "$LOOSE017_APP"
sleep 10
send_dialog Accept 90 || die "Downgrade warm dialog not found"
wait_instance_count 1 120
sleep 8
v7="$(get_installed_version)"
stop_all_autodoc
record "7 downgrade warm accept" "$( [[ "$v7" == "0.1.7" ]] && echo 1 || echo 0 )" "version: $v7"

echo ""
echo "=== 8) Upgrade quit — /Applications unchanged, loose exits ==="
uninstall_installed
install_from_dmg "$DMG017"
v8pre="$(get_installed_version)"
"$LOOSE018_APP/Contents/MacOS/AutoDoc" &
p8=$!
sleep 10
send_dialog Quit 90 || die "Upgrade quit dialog not found"
sleep 6
v8post="$(get_installed_version)"
alive=0
kill -0 "$p8" 2>/dev/null && alive=1 || true
n8=$(count_instance_roots)
stop_all_autodoc
record "8 upgrade quit" "$( [[ "$v8post" == "$v8pre" && $alive -eq 0 && $n8 -eq 0 ]] && echo 1 || echo 0 )" \
  "version: $v8pre -> $v8post, loose alive: $alive, instances: $n8"

echo ""
echo "=== 9) Downgrade quit — /Applications unchanged, loose exits ==="
uninstall_installed
install_from_dmg "$DMG018"
v9pre="$(get_installed_version)"
"$LOOSE017_APP/Contents/MacOS/AutoDoc" &
p9=$!
sleep 10
send_dialog Quit 90 || die "Downgrade quit dialog not found"
sleep 6
v9post="$(get_installed_version)"
alive9=0
kill -0 "$p9" 2>/dev/null && alive9=1 || true
n9=$(count_instance_roots)
stop_all_autodoc
record "9 downgrade quit" "$( [[ "$v9post" == "$v9pre" && $alive9 -eq 0 && $n9 -eq 0 ]] && echo 1 || echo 0 )" \
  "version: $v9pre -> $v9post, loose alive: $alive9, instances: $n9"

echo ""
echo "=== Final cleanup ==="
stop_all_autodoc
uninstall_installed || true

echo ""
echo "=== Summary ==="
failed=0
for row in "${results[@]}"; do
  IFS='|' read -r n ok d <<<"$row"
  printf '%-35s %s %s\n' "$n" "$( [[ "$ok" == 1 ]] && echo OK || echo FAIL )" "$d"
  [[ "$ok" != "1" ]] && failed=$((failed + 1)) || true
done

echo ""
echo "Result: $((${#results[@]} - failed))/${#results[@]} passed"
[[ "$failed" -eq 0 ]]
