#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# Smoke tests for macOS installed-copy policy.
# Verifies single instance, same-version redirect, upgrade/downgrade
# prompts, and quit behavior — the /Applications equivalent of the
# Windows install-policy smoke tests.
#
# ── Prerequisites ─────────────────────────────────────────────────────────
#
# You need two local builds with different version numbers.  Pick the
# current version from package.json (the "newer" one) and one version
# below it (the "older" one).  For example if package.json says 0.1.8:
#
#   STAMP=$(date +%H%M%S)          # e.g. "142305"
#
#   npx electron-vite build        # compile JS once
#
#   # Older version (0.1.7) — DMG for install, dir for loose copy
#   npx electron-builder --mac dmg --publish never \
#     "-c.extraMetadata.version=0.1.7" "-c.directories.output=build-older-$STAMP"
#   npx electron-builder --mac dir --publish never \
#     "-c.extraMetadata.version=0.1.7" "-c.directories.output=build-older-$STAMP-dir"
#
#   # Newer / current version (0.1.8) — DMG for install, dir for loose copy
#   npx electron-builder --mac dmg --publish never \
#     "-c.extraMetadata.version=0.1.8" "-c.directories.output=build-newer-$STAMP"
#   npx electron-builder --mac dir --publish never \
#     "-c.extraMetadata.version=0.1.8" "-c.directories.output=build-newer-$STAMP-dir"
#
# Then run:
#   AUTODOC_SMOKE_STAMP=$STAMP bash scripts/macos-install-policy-smoke.sh
#
# On some volumes (exFAT / network sync), electron-builder may need:
#   AUTODOC_DISABLE_ASAR_INTEGRITY=1
# and unsigned local smoke builds:
#   CSC_IDENTITY_AUTO_DISCOVERY=false … -c.mac.identity=null
# Remove AppleDouble junk before packaging: find node_modules/electron/dist -name '._*' -delete
#
# ── Environment variables ─────────────────────────────────────────────────
#
#   AUTODOC_SMOKE_STAMP   Build folder suffix (required — no default)
#   AUTODOC_SMOKE_OLDER   Older version string  (default: package.json patch - 1)
#   AUTODOC_SMOKE_NEWER   Newer version string  (default: package.json version)
#   AUTODOC_SMOKE_VERBOSE Set to 1 for timestamps, ps snapshots, dialog poll logs,
#                         Accessibility button/window dumps, and osascript stderr.
#                         Set to 2 to also enable bash xtrace (set -x).
#
# The script expects under the repo root:
#   build-older-<STAMP>/autodoc-<OLDER>.dmg               (installer)
#   build-newer-<STAMP>/autodoc-<NEWER>.dmg               (installer)
#   build-older-<STAMP>[-dir]/<arch>/AutoDoc.app           (loose copy)
#   build-newer-<STAMP>[-dir]/<arch>/AutoDoc.app           (loose copy)
#
# On exit, build-older-<STAMP>, build-newer-<STAMP>, and optional *-dir
# counterparts under the repo are deleted.
# ──────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

VERBOSE="${AUTODOC_SMOKE_VERBOSE:-0}"
export AUTODOC_SMOKE_VERBOSE
[[ "$VERBOSE" == 2 ]] && set -x
TRACE_FILE="${AUTODOC_INSTALL_POLICY_TRACE_FILE:-/tmp/autodoc-install-policy.log}"

smoke_ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }

vlog() {
  [[ "$VERBOSE" == 1 ]] || [[ "$VERBOSE" == 2 ]] || return 0
  printf '[%s][smoke] %s\n' "$(smoke_ts)" "$*" >&2
}

verbose() { [[ "$VERBOSE" == 1 ]] || [[ "$VERBOSE" == 2 ]]; }

# Printed on every [FAIL] even when VERBOSE=0 so logs stay actionable in CI.
smoke_fail_context() {
  local reason="${1:-}"
  echo "       --- fail context: $reason ---" >&2
  ps -ax -o pid=,etime=,args= 2>/dev/null | grep -E '[A]utoDoc\.app/Contents/MacOS/AutoDoc' || echo "       (no main AutoDoc processes)" >&2
  echo "       installed bundle present: $([[ -d "$INSTALLED_APP" ]] && echo yes || echo no)" >&2
  [[ -f "${INSTALLED_APP}/Contents/Resources/app.asar" ]] && echo "       installed asar version: $(get_installed_version)" >&2 || true
  if [[ -f "$TRACE_FILE" ]]; then
    echo "       install-policy trace tail ($TRACE_FILE):" >&2
    tail -n 30 "$TRACE_FILE" >&2 || true
  fi
}

# Main AutoDoc binary processes only (matches count_instance_roots / test expectations).
dump_autodoc_ps() {
  local label="${1:-state}"
  vlog "─── ps snapshot: $label ───"
  ps -ax -o pid=,ppid=,user=,etime=,args= 2>/dev/null \
    | grep -E '[A]utoDoc\.app/Contents/MacOS/AutoDoc' \
    || vlog "(no main AutoDoc.app/Contents/MacOS/AutoDoc lines)"
  vlog "main-root count (policy test metric): $(count_instance_roots)"
}

# All AutoDoc-related lines (helpers, GPU) for diagnosing duplicate instances.
dump_autodoc_ps_wide() {
  local label="${1:-state-wide}"
  vlog "─── ps snapshot (wide): $label ───"
  ps -ax -o pid=,ppid=,etime=,args= 2>/dev/null \
    | grep -iE 'AutoDoc\.app|AutoDoc Helper' \
    || vlog "(no AutoDoc lines)"
}

_ui_accessibility_dump_collect() {
  osascript <<'APPLESCRIPT'
set report to ""
set nl to ASCII character 10
tell application "System Events"
  set procNames to {"AutoDoc"}
  repeat with procName in procNames
    try
      tell (first process whose name is procName)
        set report to report & "process: " & procName & nl
        repeat with w in (every window)
          set report to report & "  window: " & (name of w as string) & nl
          try
            repeat with s in (every sheet of w)
              set report to report & "    sheet buttons:" & nl
              repeat with b in (every button of s)
                set report to report & "      [" & (name of b as string) & "]" & nl
              end repeat
            end repeat
          end try
          try
            repeat with b in (every button of w)
              set report to report & "    win-button: [" & (name of b as string) & "]" & nl
            end repeat
          end try
        end repeat
      end tell
    on error errMsg number errNum
      set report to report & "process " & procName & " err " & errNum & ": " & errMsg & nl
    end try
  end repeat
end tell
return report
APPLESCRIPT
}

# Lists windows, sheets, and button AX titles. force=1 prints even if VERBOSE is off.
dump_ui_accessibility() {
  local force="${1:-0}"
  [[ "$force" == 1 ]] || verbose || return 0
  local ui_out hdr
  hdr="─── Accessibility: windows / sheets / buttons (AutoDoc, Electron) ───"
  if [[ "$force" == 1 ]]; then
    printf '[%s][smoke] %s\n' "$(smoke_ts)" "$hdr" >&2
  else
    vlog "$hdr"
  fi
  if ! ui_out=$(_ui_accessibility_dump_collect 2>&1); then
    if [[ "$force" == 1 ]]; then
      echo "[smoke] Accessibility dump failed: $ui_out" >&2
    else
      vlog "Accessibility dump failed: $ui_out"
    fi
    return 0
  fi
  while IFS= read -r line; do
    if [[ "$force" == 1 ]]; then
      printf '[%s][smoke]   %s\n' "$(smoke_ts)" "$line" >&2
    else
      vlog "  $line"
    fi
  done <<< "$ui_out"
}

smoke_step() {
  vlog "▶ $*"
}

# ─── Resolve versions ─────────────────────────────────────────────────────

STAMP="${AUTODOC_SMOKE_STAMP:-}"
if [[ -z "$STAMP" ]]; then
  echo "Error: set AUTODOC_SMOKE_STAMP to the suffix of your build-older-* / build-newer-* folders." >&2
  exit 1
fi

remove_smoke_build_artifacts() {
  [[ -n "${STAMP:-}" ]] || return 0
  local d
  for d in \
    "${REPO_ROOT}/build-older-${STAMP}" \
    "${REPO_ROOT}/build-newer-${STAMP}" \
    "${REPO_ROOT}/build-older-${STAMP}-dir" \
    "${REPO_ROOT}/build-newer-${STAMP}-dir"
  do
    if [[ -L "$d" ]]; then
      rm -f "$d"
      echo "Removed smoke symlink: $d" >&2
    elif [[ -d "$d" ]]; then
      rm -rf "$d"
      echo "Removed smoke build: $d" >&2
    fi
  done
}
cleanup_trace_env() {
  launchctl unsetenv AUTODOC_INSTALL_POLICY_TRACE >/dev/null 2>&1 || true
  launchctl unsetenv AUTODOC_INSTALL_POLICY_TRACE_FILE >/dev/null 2>&1 || true
  launchctl unsetenv AUTODOC_TEST_USER_DATA_DIR >/dev/null 2>&1 || true
}
on_exit_cleanup() {
  remove_smoke_build_artifacts
  cleanup_trace_env
}
trap on_exit_cleanup EXIT

pkg_version() { node -e "process.stdout.write(require('${REPO_ROOT}/package.json').version)"; }

prev_patch() {
  local v="$1"
  local major minor patch
  IFS='.' read -r major minor patch <<< "$v"
  if [[ -z "$patch" || "$patch" -le 0 ]]; then
    echo "Error: cannot derive previous patch from version '$v' — set AUTODOC_SMOKE_OLDER explicitly." >&2
    exit 1
  fi
  echo "${major}.${minor}.$((patch - 1))"
}

NEWER="${AUTODOC_SMOKE_NEWER:-$(pkg_version)}"
OLDER="${AUTODOC_SMOKE_OLDER:-$(prev_patch "$NEWER")}"

echo "Smoke test: older=$OLDER  newer=$NEWER  stamp=$STAMP"
[[ "$VERBOSE" != 0 ]] && echo "Verbose: AUTODOC_SMOKE_VERBOSE=$VERBOSE (1=timestamps/ps/ui, 2=+ bash xtrace)" >&2
rm -f "$TRACE_FILE" 2>/dev/null || true
launchctl setenv AUTODOC_INSTALL_POLICY_TRACE "1" >/dev/null 2>&1 || true
launchctl setenv AUTODOC_INSTALL_POLICY_TRACE_FILE "$TRACE_FILE" >/dev/null 2>&1 || true
vlog "Install-policy trace file: $TRACE_FILE"

# ─── Paths ─────────────────────────────────────────────────────────────────

APP_NAME="AutoDoc.app"
INSTALLED_APP="/Applications/${APP_NAME}"
USER_DATA_DIR="/tmp/autodoc-smoke-user-data-${STAMP}"
USER_DATA_MARKER="${USER_DATA_DIR}/models/uninstall-smoke-marker.bin"

DMG_OLDER="${REPO_ROOT}/build-older-${STAMP}/autodoc-${OLDER}.dmg"
DMG_NEWER="${REPO_ROOT}/build-newer-${STAMP}/autodoc-${NEWER}.dmg"

resolve_loose_bundle() {
  local root="$1"
  [[ -d "$root" ]] || return 1
  local sub p
  for sub in mac-arm64 mac-universal mac darwin arm64 x64; do
    p="${root}/${sub}/${APP_NAME}"
    [[ -d "$p" ]] && { echo "$p"; return 0; }
    p="${root}/${sub}/Electron.app"
    [[ -d "$p" ]] && { echo "$p"; return 0; }
  done
  return 1
}

find_loose_app() {
  local tag="$1"
  local root app
  for root in "${REPO_ROOT}/build-${tag}-${STAMP}-dir" "${REPO_ROOT}/build-${tag}-${STAMP}"; do
    app="$(resolve_loose_bundle "$root" 2>/dev/null || true)"
    [[ -n "$app" ]] && { echo "$app"; return 0; }
  done
  return 1
}

LOOSE_OLDER="$(find_loose_app older)" || { echo "Error: no loose $OLDER .app — run electron-builder --mac dir into build-older-${STAMP}[-dir]" >&2; exit 1; }
LOOSE_NEWER="$(find_loose_app newer)" || { echo "Error: no loose $NEWER .app — run electron-builder --mac dir into build-newer-${STAMP}[-dir]" >&2; exit 1; }

die() { echo "FATAL: $*" >&2; exit 1; }
assert_file() { [[ -e "$1" ]] || die "Missing $2: $1"; }

cleanup_appledouble() {
  local root="$1"
  [[ -e "$root" ]] || return 0
  find "$root" -name '._*' -delete 2>/dev/null || true
}

rewrite_plist_value() {
  local plist="$1" key="$2" value="$3"
  /usr/libexec/PlistBuddy -c "Set :${key} ${value}" "$plist" >/dev/null 2>&1 \
    || /usr/libexec/PlistBuddy -c "Add :${key} string ${value}" "$plist" >/dev/null 2>&1
}

normalize_asar_package_json() {
  local bundle_path="$1" version="$2"
  local asar_path tmp_asan_root
  asar_path="${bundle_path}/Contents/Resources/app.asar"
  [[ -f "$asar_path" ]] || die "Missing app.asar in loose bundle: $bundle_path"

  tmp_asan_root="$(mktemp -d /tmp/autodoc-smoke-asar.XXXXXX)"
  (cd "$REPO_ROOT" && node - <<'NODE' "$asar_path" "$tmp_asan_root" "$version"
const asar = require('@electron/asar');
const fs = require('node:fs');
const path = require('node:path');

const asarPath = process.argv[2];
const tmpRoot = process.argv[3];
const version = process.argv[4];
const extractedDir = path.join(tmpRoot, 'app');
const rewrittenAsarPath = `${asarPath}.tmp`;

asar.extractAll(asarPath, extractedDir);

const packageJsonPath = path.join(extractedDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
pkg.name = 'autodoc';
pkg.productName = 'AutoDoc';
pkg.version = version;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);

Promise.resolve(asar.createPackage(extractedDir, rewrittenAsarPath))
  .then(() => {
    fs.renameSync(rewrittenAsarPath, asarPath);
  })
  .catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
  });
NODE
  ) || die "Failed to normalize app.asar package metadata for: $bundle_path"
  rm -rf "$tmp_asan_root"
}

normalize_loose_bundle() {
  local bundle_path="$1" version="$2"
  cleanup_appledouble "$bundle_path"

  if [[ "$(basename "$bundle_path")" == "$APP_NAME" && -x "$bundle_path/Contents/MacOS/AutoDoc" ]]; then
    echo "$bundle_path"
    return 0
  fi

  local parent_dir normalized_bundle plist macos_dir
  parent_dir="$(dirname "$bundle_path")"
  normalized_bundle="${parent_dir}/${APP_NAME}"
  plist="${bundle_path}/Contents/Info.plist"
  macos_dir="${bundle_path}/Contents/MacOS"

  [[ -f "$plist" ]] || die "Missing Info.plist in loose bundle: $bundle_path"
  [[ -d "$macos_dir" ]] || die "Missing MacOS directory in loose bundle: $bundle_path"

  if [[ "$bundle_path" != "$normalized_bundle" ]]; then
    rm -rf "$normalized_bundle"
    mv "$bundle_path" "$normalized_bundle"
    bundle_path="$normalized_bundle"
    plist="${bundle_path}/Contents/Info.plist"
    macos_dir="${bundle_path}/Contents/MacOS"
  fi

  if [[ ! -e "${macos_dir}/AutoDoc" ]]; then
    if [[ -e "${macos_dir}/Electron" ]]; then
      cp "${macos_dir}/Electron" "${macos_dir}/AutoDoc"
      chmod +x "${macos_dir}/AutoDoc"
    else
      die "Missing Electron executable in loose bundle: $bundle_path"
    fi
  fi

  rewrite_plist_value "$plist" CFBundleDisplayName "AutoDoc"
  rewrite_plist_value "$plist" CFBundleName "AutoDoc"
  rewrite_plist_value "$plist" CFBundleExecutable "AutoDoc"
  rewrite_plist_value "$plist" CFBundleIdentifier "com.kairos.autodoc"
  rewrite_plist_value "$plist" CFBundleShortVersionString "$version"
  rewrite_plist_value "$plist" CFBundleVersion "$version"
  normalize_asar_package_json "$bundle_path" "$version"

  echo "$bundle_path"
}

LOOSE_OLDER="$(normalize_loose_bundle "$LOOSE_OLDER" "$OLDER")"
LOOSE_NEWER="$(normalize_loose_bundle "$LOOSE_NEWER" "$NEWER")"

assert_file "$LOOSE_OLDER/Contents/MacOS/AutoDoc" "$OLDER loose app"
assert_file "$LOOSE_NEWER/Contents/MacOS/AutoDoc" "$NEWER loose app"

vlog "Resolved paths: INSTALLED_APP=$INSTALLED_APP"
vlog "LOOSE_OLDER=$LOOSE_OLDER"
vlog "LOOSE_NEWER=$LOOSE_NEWER"
[[ -f "$DMG_OLDER" ]] && vlog "DMG_OLDER ok: $DMG_OLDER" || vlog "DMG_OLDER missing (install_smoke_copy will use loose bundle): $DMG_OLDER"
[[ -f "$DMG_NEWER" ]] && vlog "DMG_NEWER ok: $DMG_NEWER" || vlog "DMG_NEWER missing: $DMG_NEWER"
launchctl setenv AUTODOC_TEST_USER_DATA_DIR "$USER_DATA_DIR" >/dev/null 2>&1 || true
vlog "Smoke userData path: $USER_DATA_DIR"

# ─── Helpers ───────────────────────────────────────────────────────────────

results=()

record() {
  local name="$1" ok="$2" detail="${3:-}"
  results+=("${name}|${ok}|${detail}")
  if [[ "$ok" == "1" ]]; then
    echo "[PASS] $name"
  else
    echo "[FAIL] $name"
    smoke_fail_context "$name"
    dump_ui_accessibility 1
  fi
  [[ -n "$detail" ]] && echo "       $detail"
}

stop_all_autodoc() {
  killall AutoDoc 2>/dev/null || true
  sleep 2
  killall -9 AutoDoc 2>/dev/null || true
  sleep 1
  # Remove stale Electron single-instance lock so the next launch acquires a fresh lock
  rm -f "$HOME/Library/Application Support/autodoc/SingletonLock" 2>/dev/null || true
  rm -f "$HOME/Library/Application Support/autodoc/SingletonSocket" 2>/dev/null || true
  rm -f "$HOME/Library/Application Support/autodoc/SingletonCookie" 2>/dev/null || true
}

# Unsigned/adhoc local builds often fail to start via `open`; fall back to the binary.
launch_app_bundle() {
  local bundle="$1"
  local wait_sec="${2:-15}"
  local exe="${bundle}/Contents/MacOS/AutoDoc"
  [[ -x "$exe" ]] || die "Missing executable: $exe"
  open "$bundle" >/dev/null 2>&1 || true
  local deadline=$((SECONDS + wait_sec))
  while (( SECONDS < deadline )); do
    if [[ "$(count_instance_roots)" -gt 0 ]]; then
      vlog "launch_app_bundle: started via open ($bundle)"
      return 0
    fi
    sleep 1
  done
  vlog "launch_app_bundle: open did not start AutoDoc; launching binary directly"
  "$exe" >/dev/null 2>&1 &
  deadline=$((SECONDS + wait_sec))
  while (( SECONDS < deadline )); do
    if [[ "$(count_instance_roots)" -gt 0 ]]; then
      vlog "launch_app_bundle: started via binary ($bundle)"
      return 0
    fi
    sleep 1
  done
  vlog "launch_app_bundle: no AutoDoc main process after ${wait_sec}s (open + binary)"
}

count_instance_roots() {
  local n
  n=$(ps -ax -o args= 2>/dev/null | grep -E -c '[A]utoDoc\.app/Contents/MacOS/AutoDoc' || true)
  echo "$n"
}

count_apps_roots() {
  local n
  n=$(ps -ax -o args= 2>/dev/null | grep -E -c '[/]Applications[/]AutoDoc\.app/Contents/MacOS/AutoDoc' || true)
  echo "$n"
}

count_non_apps_roots() {
  local n
  n=$(ps -ax -o args= 2>/dev/null | grep -E '[A]utoDoc\.app/Contents/MacOS/AutoDoc' | grep -E -v '[/]Applications[/]AutoDoc\.app/Contents/MacOS/AutoDoc' | wc -l | tr -d ' ')
  echo "$n"
}

wait_instance_count() {
  local expected="$1" timeout_sec="${2:-90}"
  local deadline=$((SECONDS + timeout_sec))
  local got
  while (( SECONDS < deadline )); do
    got=$(count_instance_roots)
    [[ "$got" -eq "$expected" ]] && {
      vlog "wait_instance_count: ok ($got main root(s), ${timeout_sec}s budget)"
      return 0
    }
    vlog "wait_instance_count: want $expected, have $got (deadline in $((deadline - SECONDS))s)"
    sleep 0.5
  done
  got=$(count_instance_roots)
  dump_autodoc_ps_wide "wait_instance_count timeout"
  die "Expected ${expected} instance(s), got ${got} after ${timeout_sec}s"
}

wait_apps_only_single_instance() {
  local timeout_sec="${1:-45}"
  local deadline=$((SECONDS + timeout_sec))
  local total apps non_apps
  while (( SECONDS < deadline )); do
    total="$(count_instance_roots)"
    apps="$(count_apps_roots)"
    non_apps="$(count_non_apps_roots)"
    if [[ "$total" -eq 1 && "$apps" -eq 1 && "$non_apps" -eq 0 ]]; then
      vlog "wait_apps_only_single_instance: settled"
      return 0
    fi
    vlog "wait_apps_only_single_instance: total=$total apps=$apps non_apps=$non_apps (remaining $((deadline - SECONDS))s)"
    sleep 1
  done
  return 1
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
  smoke_step "hdiutil attach $dmg -> $mnt"
  if verbose; then
    hdiutil attach -nobrowse -mountpoint "$mnt" "$dmg" >&2
  else
    hdiutil attach -nobrowse -quiet -mountpoint "$mnt" "$dmg"
  fi
  smoke_step "ditto $mnt/$APP_NAME -> $INSTALLED_APP"
  ditto "${mnt}/${APP_NAME}" "$INSTALLED_APP"
  smoke_step "hdiutil detach $mnt"
  if verbose; then
    hdiutil detach "$mnt" >&2
  else
    hdiutil detach -quiet "$mnt"
  fi
  rmdir "$mnt" 2>/dev/null || true
}

install_from_bundle() {
  local bundle="$1"
  cleanup_appledouble "$bundle"
  rm -rf "$INSTALLED_APP"
  ditto "$bundle" "$INSTALLED_APP"
}

install_smoke_copy() {
  local dmg="$1" bundle="$2"
  if [[ -f "$dmg" ]]; then
    install_from_dmg "$dmg"
  else
    echo "Note: ${dmg##*/} missing; installing from loose bundle copy instead."
    install_from_bundle "$bundle"
  fi
}

uninstall_installed() {
  rm -rf "$INSTALLED_APP"
  sleep 1
}

seed_smoke_local_data() {
  mkdir -p "$(dirname "$USER_DATA_MARKER")"
  mkdir -p "${USER_DATA_DIR}/recordings/meeting-1"
  printf 'autodoc smoke marker' > "$USER_DATA_MARKER"
  printf 'recording marker' > "${USER_DATA_DIR}/recordings/meeting-1/audio.webm"
}

clear_smoke_local_data() {
  rm -rf "$USER_DATA_DIR"
}

# Clicks install-policy message boxes from the main process. Electron often leaves the
# sheet title empty or uses wording that does not include "Applications Copy", so we
# match affirmative button labels (see application-install.ts) and fall back to title heuristics.
send_dialog() {
  local choice="${1:-Accept}"
  local timeout_sec="${2:-90}"
  local poll=0
  local deadline=$((SECONDS + timeout_sec))
  local as_err
  while (( SECONDS < deadline )); do
    poll=$((poll + 1))
    if verbose && { [[ "$poll" -le 3 ]] || [[ $((poll % 12)) -eq 0 ]] || [[ $((deadline - SECONDS)) -le 8 ]]; }; then
      vlog "send_dialog: poll #$poll choice=$choice (remaining ~$((deadline - SECONDS))s)"
    fi
    local out="0"
    as_err="$(mktemp "${TMPDIR:-/tmp}/autodoc-smoke-as.XXXXXX")"
    if [[ "$choice" == "Accept" ]]; then
      out=$(osascript <<'APPLESCRIPT' 2>"$as_err" || echo "0"
tell application "System Events"
  set procNames to {"AutoDoc", "electron", "Electron"}
  repeat with procName in procNames
    try
      set matchingProcs to every process whose name is procName
      repeat with proc in matchingProcs
        try
          tell proc
            set frontmost to true
            repeat with w in (every window)
              try
                repeat with s in (every sheet of w)
                  try
                    repeat with btnLabel in {"Upgrade in Applications", "Downgrade in Applications", "Replace in Applications"}
                      try
                        click (first button of s whose name is btnLabel)
                        return "1"
                      end try
                    end repeat
                  end try
                  try
                    if (count of buttons of s) is 2 then
                      click button 1 of s
                      return "1"
                    end if
                  end try
                end repeat
              end try
              try
                repeat with btnLabel in {"Upgrade in Applications", "Downgrade in Applications", "Replace in Applications"}
                  try
                    click (first button of w whose name is btnLabel)
                    return "1"
                  end try
                end repeat
              end try
              try
                set wt to name of w as string
                if wt contains "Applications Copy" or wt contains "/Applications" or wt contains "Upgrade Applications" or wt contains "Downgrade Applications" then
                  try
                    click button 1 of w
                  on error
                    keystroke return
                  end try
                  return "1"
                end if
              end try
              try
                repeat with t in (every static text of w)
                  try
                    set tx to value of t as string
                    if tx contains "/Applications" and tx contains "AutoDoc" then
                      if (count of buttons of w) is greater than 1 then
                        click button 1 of w
                        return "1"
                      end if
                    end if
                  end try
                end repeat
              end try
            end repeat
          end tell
        end try
      end repeat
    end try
  end repeat
end tell
return "0"
APPLESCRIPT
)
    else
      out=$(osascript <<'APPLESCRIPT' 2>"$as_err" || echo "0"
tell application "System Events"
  set procNames to {"AutoDoc", "electron", "Electron"}
  repeat with procName in procNames
    try
      set matchingProcs to every process whose name is procName
      repeat with proc in matchingProcs
        try
          tell proc
            set frontmost to true
            repeat with w in (every window)
              try
                repeat with s in (every sheet of w)
                  try
                    click (first button of s whose name is "Quit")
                    return "1"
                  end try
                  try
                    set bc to count of buttons of s
                    if bc is 2 then
                      click button bc of s
                      return "1"
                    end if
                  end try
                end repeat
              end try
              try
                click (first button of w whose name is "Quit")
                return "1"
              end try
              try
                set wt to name of w as string
                if wt contains "Applications Copy" or wt contains "/Applications" or wt contains "Upgrade Applications" or wt contains "Downgrade Applications" then
                  try
                    click button "Quit" of w
                  on error
                    key code 53
                  end try
                  return "1"
                end if
              end try
              try
                if (count of buttons of w) is 2 then
                  click button 2 of w
                  return "1"
                end if
              end try
            end repeat
          end tell
        end try
      end repeat
    end try
  end repeat
end tell
return "0"
APPLESCRIPT
)
    fi
    if verbose && [[ -s "$as_err" ]]; then
      vlog "osascript stderr: $(tr '\n' ' ' < "$as_err")"
    fi
    rm -f "$as_err"
    if [[ "$out" == "1" ]]; then
      vlog "send_dialog: clicked successfully (poll #$poll)"
      sleep 0.8
      return 0
    fi
    sleep 0.4
  done
  printf '[%s][smoke] send_dialog: TIMEOUT after %ss choice=%s (set AUTODOC_SMOKE_VERBOSE=1 for poll trace)\n' "$(smoke_ts)" "$timeout_sec" "$choice" >&2
  dump_autodoc_ps_wide "send_dialog timeout"
  dump_ui_accessibility 1
  return 1
}

send_dialog_quiet() {
  if verbose; then
    send_dialog "$1" "${2:-4}" || return 1
  else
    send_dialog "$1" "${2:-4}" 2>/dev/null || return 1
  fi
}

# ─── Tests ─────────────────────────────────────────────────────────────────

echo ""
echo "=== Cleanup ==="
stop_all_autodoc
uninstall_installed

echo ""
echo "=== 1) Install $NEWER, launch installed — opens normally ==="
install_smoke_copy "$DMG_NEWER" "$LOOSE_NEWER"
launch_app_bundle "$INSTALLED_APP"
c=$(count_instance_roots)
record "1 installed launch" "$( [[ "$c" -eq 1 ]] && echo 1 || echo 0 )" "instances: $c"
stop_all_autodoc

echo ""
echo "=== 2) Launch installed twice — single instance ==="
launch_app_bundle "$INSTALLED_APP"
launch_app_bundle "$INSTALLED_APP" 4
c2=$(count_instance_roots)
record "2 single instance" "$( [[ "$c2" -eq 1 ]] && echo 1 || echo 0 )" "instances: $c2"
stop_all_autodoc

echo ""
echo "=== 3a) Same-version loose cold — redirects to /Applications, no dialog ==="
launch_app_bundle "$LOOSE_NEWER" 12
dlg=0
send_dialog_quiet Accept 3 && dlg=1 || true
wait_apps_only_single_instance 45 || true
c3=$(count_instance_roots)
apps3=$(count_apps_roots)
non_apps3=$(count_non_apps_roots)
routing3="unsettled"
[[ "$c3" -eq 1 && "$apps3" -eq 1 && "$non_apps3" -eq 0 ]] && routing3="apps-only"
stop_all_autodoc
ok3a=0
[[ "$dlg" -eq 0 && "$routing3" == "apps-only" ]] && ok3a=1
record "3a same-ver loose cold redirect" "$ok3a" "dialog detected: $dlg, instances=$c3 apps=$apps3 non_apps=$non_apps3 routing=$routing3"

echo ""
echo "=== 3b) Same-version loose while running — focus, no dialog ==="
launch_app_bundle "$INSTALLED_APP"
launch_app_bundle "$LOOSE_NEWER"
dlg3b=0
send_dialog_quiet Accept 4 && dlg3b=1 || true
wait_apps_only_single_instance 45 || true
c3b=$(count_instance_roots)
apps3b=$(count_apps_roots)
non_apps3b=$(count_non_apps_roots)
routing3b="unsettled"
[[ "$c3b" -eq 1 && "$apps3b" -eq 1 && "$non_apps3b" -eq 0 ]] && routing3b="apps-only"
stop_all_autodoc
record "3b same-ver loose warm" "$( [[ $dlg3b -eq 0 && "$routing3b" == "apps-only" ]] && echo 1 || echo 0 )" "dialog=$dlg3b instances=$c3b apps=$apps3b non_apps=$non_apps3b routing=$routing3b"

echo ""
echo "=== 4) Upgrade: install $OLDER, loose $NEWER cold — accept ==="
uninstall_installed
install_smoke_copy "$DMG_OLDER" "$LOOSE_OLDER"
v_pre="$(get_installed_version)"
launch_app_bundle "$LOOSE_NEWER" 12
send_dialog Accept 90 || die "Upgrade dialog not found"
wait_instance_count 1 120
sleep 8
v_post="$(get_installed_version)"
stop_all_autodoc
record "4 upgrade cold accept" "$( [[ "$v_post" == "$NEWER" ]] && echo 1 || echo 0 )" "version: $v_pre -> $v_post"

echo ""
echo "=== 5) Downgrade: install $NEWER, loose $OLDER cold — accept ==="
uninstall_installed
install_smoke_copy "$DMG_NEWER" "$LOOSE_NEWER"
v_pre5="$(get_installed_version)"
launch_app_bundle "$LOOSE_OLDER" 12
send_dialog Accept 90 || die "Downgrade dialog not found"
wait_instance_count 1 120
sleep 8
v_post5="$(get_installed_version)"
stop_all_autodoc
record "5 downgrade cold accept" "$( [[ "$v_post5" == "$OLDER" ]] && echo 1 || echo 0 )" "version: $v_pre5 -> $v_post5"

echo ""
echo "=== 6) Upgrade warm: $OLDER running + loose $NEWER — accept ==="
uninstall_installed
install_smoke_copy "$DMG_OLDER" "$LOOSE_OLDER"
launch_app_bundle "$INSTALLED_APP" 8
launch_app_bundle "$LOOSE_NEWER" 10
send_dialog Accept 90 || die "Upgrade warm dialog not found"
wait_instance_count 1 120
sleep 8
v6="$(get_installed_version)"
stop_all_autodoc
record "6 upgrade warm accept" "$( [[ "$v6" == "$NEWER" ]] && echo 1 || echo 0 )" "version: $v6"

echo ""
echo "=== 7) Downgrade warm: $NEWER running + loose $OLDER — accept ==="
uninstall_installed
install_smoke_copy "$DMG_NEWER" "$LOOSE_NEWER"
launch_app_bundle "$INSTALLED_APP" 8
launch_app_bundle "$LOOSE_OLDER" 10
send_dialog Accept 90 || die "Downgrade warm dialog not found"
wait_instance_count 1 120
sleep 8
v7="$(get_installed_version)"
stop_all_autodoc
record "7 downgrade warm accept" "$( [[ "$v7" == "$OLDER" ]] && echo 1 || echo 0 )" "version: $v7"

echo ""
echo "=== 8) Upgrade quit — /Applications unchanged, loose exits ==="
uninstall_installed
install_smoke_copy "$DMG_OLDER" "$LOOSE_OLDER"
v8pre="$(get_installed_version)"
"$LOOSE_NEWER/Contents/MacOS/AutoDoc" &
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
install_smoke_copy "$DMG_NEWER" "$LOOSE_NEWER"
v9pre="$(get_installed_version)"
"$LOOSE_OLDER/Contents/MacOS/AutoDoc" &
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
echo "=== 10) Removing AutoDoc.app leaves local data behind on macOS ==="
uninstall_installed
install_smoke_copy "$DMG_NEWER" "$LOOSE_NEWER"
seed_smoke_local_data
uninstall_installed
app_removed=0
data_marker_present=0
[[ ! -d "$INSTALLED_APP" ]] && app_removed=1
[[ -f "$USER_DATA_MARKER" ]] && data_marker_present=1
record "10 mac uninstall keeps local data" "$( [[ $app_removed -eq 1 && $data_marker_present -eq 1 ]] && echo 1 || echo 0 )" \
  "app removed: $app_removed, local data marker present: $data_marker_present"
clear_smoke_local_data

echo ""
echo "=== Final cleanup ==="
stop_all_autodoc
uninstall_installed || true
clear_smoke_local_data

echo ""
echo "=== Summary ==="
failed=0
for row in "${results[@]}"; do
  IFS='|' read -r n ok d <<< "$row"
  printf '%-35s %s %s\n' "$n" "$( [[ "$ok" == 1 ]] && echo OK || echo FAIL )" "$d"
  [[ "$ok" != "1" ]] && failed=$((failed + 1)) || true
done

echo ""
echo "Result: $((${#results[@]} - failed))/${#results[@]} passed"
[[ "$failed" -eq 0 ]]
