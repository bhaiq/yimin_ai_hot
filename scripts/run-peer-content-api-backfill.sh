#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${PEER_CONTENT_BASE_URL:-http://127.0.0.1:4173}"
ARTICLE_LIMIT="${PEER_CONTENT_LIMIT:-20}"
RETRY_FAILED="${PEER_CONTENT_RETRY_FAILED:-0}"
POLL_SECONDS="${PEER_CONTENT_POLL_SECONDS:-5}"
MAX_POLLS="${PEER_CONTENT_MAX_POLLS:-360}"
CRON_TOKEN="${PEER_DISCOVERY_CRON_TOKEN:-}"

case "$ARTICLE_LIMIT" in
  ''|*[!0-9]*)
    printf 'PEER_CONTENT_LIMIT 必须是正整数\n' >&2
    exit 2
    ;;
esac
if [ "$ARTICLE_LIMIT" -lt 1 ] || [ "$ARTICLE_LIMIT" -gt 50 ]; then
  printf 'PEER_CONTENT_LIMIT 必须在 1 到 50 之间\n' >&2
  exit 2
fi

json_value() {
  node -e '
    const payload = JSON.parse(process.argv[1]);
    const path = process.argv[2].split(".");
    let value = payload;
    for (const key of path) value = value?.[key];
    if (value !== undefined && value !== null) process.stdout.write(String(value));
  ' "$1" "$2"
}

curl_json() {
  local response_file http_status curl_status response_body
  response_file="$(mktemp "${TMPDIR:-/tmp}/peer-content-curl.XXXXXX")"

  set +e
  http_status="$(curl --silent --show-error \
    --output "$response_file" \
    --write-out '%{http_code}' \
    "$@")"
  curl_status=$?
  set -e

  response_body="$(cat "$response_file")"
  rm -f "$response_file"
  if [ "$curl_status" -ne 0 ]; then
    [ -z "$response_body" ] || printf '%s\n' "$response_body" >&2
    return "$curl_status"
  fi
  case "$http_status" in
    2??)
      printf '%s' "$response_body"
      ;;
    *)
      printf '公众号正文补全接口返回 HTTP %s' "$http_status" >&2
      [ -z "$response_body" ] || printf '：%s' "$response_body" >&2
      printf '\n' >&2
      return 22
      ;;
  esac
}

auth_args=()
if [ -n "$CRON_TOKEN" ]; then
  auth_args=(-H "Authorization: Bearer ${CRON_TOKEN}")
fi

request_body="{\"limit\":${ARTICLE_LIMIT},\"retryFailed\":$([ "$RETRY_FAILED" = "1" ] && printf true || printf false)}"
start_response="$(curl_json \
  -X POST "${BASE_URL}/api/peer-monitor/wechat/content-backfill" \
  -H 'content-type: application/json' \
  "${auth_args[@]}" \
  --data "$request_body")"

run_key="$(json_value "$start_response" 'run.runKey')"
run_status="$(json_value "$start_response" 'run.status')"
if [ -z "$run_key" ]; then
  printf '公众号正文补全接口未返回 runKey：%s\n' "$start_response" >&2
  exit 1
fi

run_response="$start_response"
poll_count=0
while [ "$run_status" = "running" ] && [ "$poll_count" -lt "$MAX_POLLS" ]; do
  sleep "$POLL_SECONDS"
  run_response="$(curl_json \
    "${BASE_URL}/api/peer-monitor/wechat/content-runs/${run_key}" \
    "${auth_args[@]}")"
  run_status="$(json_value "$run_response" 'run.status')"
  poll_count=$((poll_count + 1))
done

if [ "$run_status" = "running" ]; then
  printf '公众号正文补全轮询超时：runKey=%s\n' "$run_key" >&2
  exit 1
fi

printf '%s\n' "$run_response"
if [ "$run_status" != "completed" ]; then
  run_error="$(json_value "$run_response" 'run.error')"
  printf '公众号正文补全未完全成功：status=%s error=%s\n' "$run_status" "$run_error" >&2
  exit 1
fi
