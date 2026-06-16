#!/usr/bin/env bash
# Verifies that the macOS update zip extracts to a code-sign-valid app bundle.

set -euo pipefail

ARTIFACT_DIR="${1:-dist}"
APP_NAME="${AUTODOC_MAC_APP_NAME:-AutoDoc.app}"

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

verify_app_signature() {
  local app_path="$1"
  [[ -d "$app_path" ]] || die "Missing app bundle: ${app_path}"
  codesign --verify --deep --strict --verbose=4 "$app_path"
}

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
verify_app_signature "$extracted_app"

detached_signature_count="$(
  xattr -lr "$extracted_app" 2>/dev/null | grep -c 'com.apple.cs.CodeSignature' || true
)"
echo "[verify-macos-update] Extracted app detached signature xattrs: ${detached_signature_count}"
echo "[verify-macos-update] OK"
