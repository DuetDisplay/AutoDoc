#!/usr/bin/env bash
# INTERNAL-ONLY: uploads a file to the AutoDoc Internal update feed via the
# autodoc-internal-updates-uploader worker (see scripts/internal-update-feed-worker).
# CI has no R2 API token, so uploads go through the worker's bearer-token endpoint.
#
# Usage: upload-internal-feed.sh <local-file> <key> [content-type]
#   e.g. upload-internal-feed.sh dist/internal.yml windows/internal.yml text/yaml
#
# Requires: UPLOAD_URL (worker base URL) and UPLOAD_TOKEN env vars.
# Files larger than PART_THRESHOLD bytes use the worker's multipart endpoints,
# because Workers reject request bodies over ~100 MB.

set -euo pipefail

FILE="${1:?usage: upload-internal-feed.sh <file> <key> [content-type]}"
KEY="${2:?missing destination key (e.g. windows/foo.exe)}"
CONTENT_TYPE="${3:-application/octet-stream}"

: "${UPLOAD_URL:?UPLOAD_URL env var is required}"
: "${UPLOAD_TOKEN:?UPLOAD_TOKEN env var is required}"

PART_THRESHOLD=$((90 * 1024 * 1024))
PART_SIZE=$((80 * 1024 * 1024))

[[ -f "$FILE" ]] || { echo "FATAL: no such file: $FILE" >&2; exit 1; }

auth=(-H "Authorization: Bearer $UPLOAD_TOKEN")
size=$(wc -c < "$FILE" | tr -d ' ')

curl_json() {
  local out
  out=$(curl -fsS --retry 3 --retry-delay 5 "$@") || { echo "FATAL: upload request failed" >&2; exit 1; }
  printf '%s' "$out"
}

if [ "$size" -le "$PART_THRESHOLD" ]; then
  echo "Uploading $FILE -> $KEY ($size bytes, single PUT)"
  curl_json "${auth[@]}" -X PUT --data-binary "@$FILE" \
    -H "Content-Type: $CONTENT_TYPE" \
    "$UPLOAD_URL/$KEY" > /dev/null
  echo "OK: $KEY"
  exit 0
fi

echo "Uploading $FILE -> $KEY ($size bytes, multipart)"
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
split -b "$PART_SIZE" "$FILE" "$workdir/part-"

create_resp=$(curl_json "${auth[@]}" -X POST \
  "$UPLOAD_URL/mpu/create?key=$KEY&contentType=$CONTENT_TYPE")
upload_id=$(printf '%s' "$create_resp" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.parse(d).uploadId))")

parts_json="["
part_number=1
for part in "$workdir"/part-*; do
  echo "  part $part_number ($(wc -c < "$part" | tr -d ' ') bytes)"
  part_resp=$(curl_json "${auth[@]}" -X PUT --data-binary "@$part" \
    "$UPLOAD_URL/mpu/part?key=$KEY&uploadId=$upload_id&partNumber=$part_number")
  etag=$(printf '%s' "$part_resp" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.parse(d).etag))")
  [ "$part_number" -gt 1 ] && parts_json+=","
  parts_json+="{\"partNumber\":$part_number,\"etag\":\"$etag\"}"
  part_number=$((part_number + 1))
done
parts_json+="]"

curl_json "${auth[@]}" -X POST -H 'Content-Type: application/json' \
  --data "$parts_json" \
  "$UPLOAD_URL/mpu/complete?key=$KEY&uploadId=$upload_id" > /dev/null
echo "OK: $KEY ($((part_number - 1)) parts)"
