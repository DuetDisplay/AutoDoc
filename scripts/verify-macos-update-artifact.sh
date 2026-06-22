#!/usr/bin/env bash
# Verifies macOS release artifacts:
#   * the update zip extracts to a code-sign-valid app bundle (auto-update path)
#   * the DMG mounts to a code-sign-valid app bundle (manual install path)
#   * the bundled MLX/Python runtime carries the JIT entitlements and can be
#     imported without a Hardened Runtime SIGKILL (transcription setup path)

set -euo pipefail

ARTIFACT_DIR="${1:-dist}"
APP_NAME="${AUTODOC_MAC_APP_NAME:-AutoDoc.app}"
MAC_ENTITLEMENTS_FILE="${AUTODOC_MAC_ENTITLEMENTS_FILE:-build/entitlements.mac.plist}"
# Set to 0 to skip the runtime import probe (e.g. on hosts without the runtime).
RUNTIME_PROBE="${AUTODOC_MAC_RUNTIME_PROBE:-1}"

die() {
  echo "FATAL: $*" >&2
  exit 1
}

find_update_zip() {
  local latest_yml="${ARTIFACT_DIR}/latest-mac.yml"
  local path_value=""

  if [[ -f "$latest_yml" ]]; then
    path_value="$(awk '/^path: / { print substr($0, 7); exit }' "$latest_yml")"
    if [[ -n "$path_value" && -f "${ARTIFACT_DIR}/${path_value}" ]]; then
      printf '%s\n' "${ARTIFACT_DIR}/${path_value}"
      return 0
    fi
  fi

  find "$ARTIFACT_DIR" -maxdepth 1 -name '*-mac.zip' -type f | sort | head -1
}

find_dmg() {
  find "$ARTIFACT_DIR" -maxdepth 1 -name '*.dmg' -type f | sort | head -1
}

verify_app_signature() {
  local app_path="$1"
  [[ -d "$app_path" ]] || die "Missing app bundle: ${app_path}"
  codesign --verify --deep --strict --verbose=4 "$app_path"
}

# Confirms the bundled MLX/Python runtime is signed with the JIT entitlements and
# survives an actual import. This is the only check that catches the Hardened
# Runtime "Code Signature Invalid" SIGKILL that breaks transcription setup —
# codesign --verify reports the signature as valid even when allow-jit is absent.
verify_app_runtime() {
  local app_path="$1"

  if [[ "$RUNTIME_PROBE" != "1" ]]; then
    echo "[verify-macos-update] Runtime probe disabled (AUTODOC_MAC_RUNTIME_PROBE=${RUNTIME_PROBE})"
    return 0
  fi

  local runtime_root
  runtime_root="$(/bin/ls -d "${app_path}/Contents/Resources/mlx-python-runtime/"*/ 2>/dev/null | head -1 || true)"
  [[ -n "$runtime_root" ]] || die "Bundled MLX runtime missing under ${app_path}/Contents/Resources/mlx-python-runtime"

  local python_bin="${runtime_root}python/bin/python3"
  [[ -e "$python_bin" ]] || die "Bundled MLX runtime python missing: ${python_bin}"

  local entitlements
  entitlements="$(codesign -d --entitlements - "$python_bin" 2>/dev/null || true)"
  if ! grep -q 'com.apple.security.cs.allow-jit' <<<"$entitlements"; then
    die "Bundled python3 is missing com.apple.security.cs.allow-jit; MLX will be SIGKILLed (Code Signature Invalid) at runtime. Fix afterPack runtime signing."
  fi

  set +e
  local probe_output
  probe_output="$(PYTHONDONTWRITEBYTECODE=1 "$python_bin" -c 'import mlx_whisper; print("mlx_whisper import OK")' 2>&1)"
  local probe_rc=$?
  set -e

  if [[ "$probe_rc" != "0" ]]; then
    echo "$probe_output" >&2
    if [[ "$probe_rc" == "137" ]]; then
      die "Bundled MLX runtime was SIGKILLed (137) importing mlx_whisper — Hardened Runtime rejected JIT memory because the bundled python is missing allow-jit/allow-unsigned-executable-memory entitlements."
    fi
    die "Bundled MLX runtime failed to import mlx_whisper (exit ${probe_rc})."
  fi

  echo "[verify-macos-update] Runtime import probe OK (${python_bin})"
}

verify_app_entitlements() {
  local app_path="$1"
  local output

  output="$(codesign -d --entitlements - "$app_path" 2>&1 || true)"
  if grep -qi 'invalid entitlements blob' <<<"$output"; then
    die "Extracted app has an invalid entitlements blob; ensure mac.entitlements points to ${MAC_ENTITLEMENTS_FILE}."
  fi
  # The microphone is gated by the Hardened Runtime audio-input entitlement.
  # Without it macOS auto-denies askForMediaAccess (no prompt) and AutoDoc never
  # appears in Privacy > Microphone, so recordings capture no audio. Screen
  # recording uses a different TCC path and is unaffected, which makes this easy
  # to miss. Fail the build if it is ever dropped again.
  if ! grep -q 'com.apple.security.device.audio-input' <<<"$output"; then
    die "App is missing com.apple.security.device.audio-input; microphone access will be denied at runtime. Restore it in ${MAC_ENTITLEMENTS_FILE}."
  fi
}

verify_entitlement_config() {
  [[ -f "$MAC_ENTITLEMENTS_FILE" ]] || return 0

  # com.apple.security.device.audio-input is the Hardened Runtime entitlement
  # that authorizes microphone access for our Developer ID app. It is valid for
  # notarized Developer ID builds (shipped in v0.1.21–v0.1.46 with working mics).
  # It was removed in error chasing a misdiagnosed "invalid signature" report,
  # which silently broke microphone capture. Require it so it cannot regress.
  if ! /usr/libexec/PlistBuddy \
    -c 'Print :com.apple.security.device.audio-input' \
    "$MAC_ENTITLEMENTS_FILE" >/dev/null 2>&1; then
    die "${MAC_ENTITLEMENTS_FILE} is missing com.apple.security.device.audio-input; microphone access will be denied at runtime. Restore it."
  fi
}

verify_entitlement_config

zip_path="$(find_update_zip)"
[[ -n "$zip_path" ]] || die "No macOS update zip found in ${ARTIFACT_DIR}"

echo "[verify-macos-update] Verifying update zip: ${zip_path}"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/autodoc-mac-update-verify.XXXXXX")"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

ditto -x -k "$zip_path" "$tmp_dir"

extracted_app="${tmp_dir}/${APP_NAME}"
verify_app_entitlements "$extracted_app"
verify_app_signature "$extracted_app"
verify_app_runtime "$extracted_app"

detached_signature_count="$(
  xattr -lr "$extracted_app" 2>/dev/null | grep -c 'com.apple.cs.CodeSignature' || true
)"
echo "[verify-macos-update] Extracted app detached signature xattrs: ${detached_signature_count}"
echo "[verify-macos-update] Update zip OK"

# Verify the DMG (the artifact users actually install) the same way — mount it,
# then check signature, entitlements, and the bundled runtime on the app inside.
dmg_path="$(find_dmg)"
if [[ -n "$dmg_path" ]]; then
  echo "[verify-macos-update] Verifying DMG: ${dmg_path}"
  dmg_mnt="$(mktemp -d "${TMPDIR:-/tmp}/autodoc-mac-dmg-verify.XXXXXX")"
  detach_dmg() {
    hdiutil detach -quiet "$dmg_mnt" >/dev/null 2>&1 || hdiutil detach "$dmg_mnt" >/dev/null 2>&1 || true
    rmdir "$dmg_mnt" 2>/dev/null || true
  }
  trap 'detach_dmg; cleanup' EXIT
  hdiutil attach -nobrowse -quiet -mountpoint "$dmg_mnt" "$dmg_path"

  dmg_app="${dmg_mnt}/${APP_NAME}"
  dmg_rc=0
  (
    verify_app_entitlements "$dmg_app"
    verify_app_signature "$dmg_app"
    verify_app_runtime "$dmg_app"
  ) || dmg_rc=$?

  detach_dmg
  trap cleanup EXIT
  [[ "$dmg_rc" == "0" ]] || die "DMG verification failed for ${dmg_path}"
  echo "[verify-macos-update] DMG OK"
else
  echo "[verify-macos-update] No DMG found in ${ARTIFACT_DIR}; skipping DMG verification"
fi

echo "[verify-macos-update] OK"
