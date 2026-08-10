#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${PEER_DAILY_BASE_URL:-http://127.0.0.1:4173}"
REPORT_DATE="${PEER_DAILY_REPORT_DATE:-$(TZ=Asia/Shanghai date +%F)}"
FORCE_GENERATE="${PEER_DAILY_FORCE_GENERATE:-0}"
DRY_RUN="${PEER_DAILY_DRY_RUN:-0}"
POLL_SECONDS="${PEER_DAILY_POLL_SECONDS:-5}"
MAX_POLLS="${PEER_DAILY_MAX_POLLS:-120}"

json_value() {
  node -e '
    const payload = JSON.parse(process.argv[1]);
    const path = process.argv[2].split(".");
    let value = payload;
    for (const key of path) value = value?.[key];
    if (value !== undefined && value !== null) process.stdout.write(String(value));
  ' "$1" "$2"
}

generate_body="{\"date\":\"${REPORT_DATE}\",\"force\":$([ "$FORCE_GENERATE" = "1" ] && printf true || printf false)}"
generate_response="$(curl --fail-with-body --silent --show-error \
  -X POST "${BASE_URL}/api/peer-monitor/daily/generate" \
  -H 'content-type: application/json' \
  --data "$generate_body")"

run_key="$(json_value "$generate_response" 'run.runKey')"
if [ -n "$run_key" ]; then
  poll_count=0
  while [ "$poll_count" -lt "$MAX_POLLS" ]; do
    run_response="$(curl --fail-with-body --silent --show-error \
      "${BASE_URL}/api/peer-monitor/daily/runs/${run_key}")"
    run_status="$(json_value "$run_response" 'run.status')"
    if [ "$run_status" = "completed" ]; then
      break
    fi
    if [ "$run_status" = "failed" ]; then
      run_error="$(json_value "$run_response" 'run.error')"
      printf '同行日报生成失败：%s\n' "$run_error" >&2
      exit 1
    fi
    poll_count=$((poll_count + 1))
    sleep "$POLL_SECONDS"
  done
  if [ "${run_status:-}" != "completed" ]; then
    printf '同行日报生成轮询超时：runKey=%s\n' "$run_key" >&2
    exit 1
  fi
fi

push_body="{\"date\":\"${REPORT_DATE}\",\"dryRun\":$([ "$DRY_RUN" = "1" ] && printf true || printf false)}"
push_response="$(curl --fail-with-body --silent --show-error \
  -X POST "${BASE_URL}/api/peer-monitor/daily/push" \
  -H 'content-type: application/json' \
  --data "$push_body")"

printf '%s\n' "$push_response"
