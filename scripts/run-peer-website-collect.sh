#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
COLLECTOR_ROOT="${PROJECT_ROOT}/collectors/peer-web"
VENV_ROOT="${PEER_WEBSITE_VENV_PATH:-${PROJECT_ROOT}/.venv-peer-web}"
PYTHON_BIN="${VENV_ROOT}/bin/python"
PLAYWRIGHT_ROOT="${PLAYWRIGHT_BROWSERS_PATH:-${PROJECT_ROOT}/.cache/ms-playwright}"
LOCK_FILE="${PEER_WEBSITE_LOCK_FILE:-${PROJECT_ROOT}/var/peer-web/collector.lock}"
IMPORT_MODE="${PEER_WEBSITE_IMPORT_MODE:-write}"

if [[ "${1:-}" == "write" || "${1:-}" == "dry-run" || "${1:-}" == "none" ]]; then
  IMPORT_MODE="$1"
  shift
fi

if [[ ! -x "${PYTHON_BIN}" ]]; then
  echo "Python 环境不存在：${PYTHON_BIN}" >&2
  echo "请先按 collectors/peer-web/README.md 安装采集器依赖。" >&2
  exit 1
fi

if ! command -v flock >/dev/null 2>&1; then
  echo "服务器缺少 flock，无法安全防止定时任务重入。" >&2
  exit 1
fi

mkdir -p "$(dirname -- "${LOCK_FILE}")" "${PLAYWRIGHT_ROOT}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_ROOT}"

exec flock -n -E 75 "${LOCK_FILE}" \
  "${PYTHON_BIN}" "${COLLECTOR_ROOT}/peer_website_runner.py" \
  --import-mode "${IMPORT_MODE}" "$@"
