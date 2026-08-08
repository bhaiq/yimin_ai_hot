#!/usr/bin/env python3
"""Run peer website collectors and submit a versioned snapshot to yimin_ai_hot."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import ProxyHandler, Request, build_opener, urlopen


SCHEMA_VERSION = "peer-website-snapshot/v1"
CHINA_TIMEZONE = timezone(timedelta(hours=8))
COLLECTOR_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = COLLECTOR_ROOT.parents[1]
PROXY_PREFLIGHT_TARGETS = (
    "https://www.gstatic.com/generate_204",
    "https://www.ekimmigration.com/robots.txt",
)
PROXY_ENVIRONMENT_KEYS = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "PEER_WEBSITE_EFFECTIVE_PROXY_URL",
)


@dataclass(frozen=True)
class CollectorDefinition:
    peer_code: str
    source_domain: str
    script_name: str
    output_name: str
    default_process_source_type: str = "missing"
    scope_project_id_by_url: bool = False


COLLECTORS = (
    CollectorDefinition(
        "peer-a", "aqyimin.com", "aqyimin_projects_scraper.py",
        "aqyimin_projects.json", "html_text",
    ),
    CollectorDefinition(
        "peer-b", "ekimmigration.com", "ekimmigration_scraper.py",
        "ekimmigration_projects.json", "image_only",
    ),
    CollectorDefinition(
        "peer-c", "iqiaowai.com", "iqiaowai_scraper.py",
        "iqiaowai_projects.json",
    ),
    CollectorDefinition(
        "peer-d", "visa800.com", "visa800_scraper.py",
        "visa800_projects.json",
    ),
    CollectorDefinition(
        "peer-e", "worldwayhk.com", "worldwayhk_scraper.py",
        "worldwayhk_projects.json",
    ),
    CollectorDefinition(
        "peer-f", "austargroup.com", "austargroup_scraper.py",
        "austargroup_projects.json",
    ),
    CollectorDefinition(
        "peer-g", "welltrendvisa.com", "welltrendvisa_scraper.py",
        "welltrendvisa_projects.json", "missing", True,
    ),
    CollectorDefinition(
        "peer-h", "wailianvisa.com", "wailianvisa_scraper.py",
        "wailianvisa_projects.json",
    ),
    CollectorDefinition(
        "peer-i", "zlglobal.net", "zlglobal_scraper.py",
        "zlglobal_projects.json",
    ),
)


def now_china() -> datetime:
    return datetime.now(CHINA_TIMEZONE)


def iso_seconds(value: datetime) -> str:
    return value.astimezone(CHINA_TIMEZONE).isoformat(timespec="seconds")


def safe_text(value: Any, max_length: int = 2_000) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    text = re.sub(
        r"(?i)(api[_-]?key|token|secret|password|cookie)\s*[:=]\s*[^\s,;]+",
        r"\1=[REDACTED]",
        text,
    )
    return text[:max_length]


def safe_identifier(value: Any) -> str:
    return safe_text(value, 512)


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def normalize_timestamp(value: Any, fallback: str) -> str:
    text = safe_text(value, 80)
    if not text:
        return fallback
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return fallback
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=CHINA_TIMEZONE)
    return parsed.isoformat(timespec="seconds")


def infer_process_source_type(
    record: dict[str, Any], default_value: str,
) -> str:
    explicit = safe_text(record.get("process_source_type"), 32)
    if explicit:
        return explicit
    if as_list(record.get("application_process")) or as_list(
        record.get("handling_process")
    ):
        return "html_text"
    if as_list(record.get("process_image_urls")):
        return "image_only"
    return default_value


def normalize_project(
    record: dict[str, Any],
    definition: CollectorDefinition,
    fallback_scraped_at: str,
) -> dict[str, Any]:
    source_project_id = (
        record.get("project_id")
        or record.get("project_slug")
        or ""
    )
    canonical_url = record.get("source_url") or record.get("requested_url") or ""
    if source_project_id and definition.scope_project_id_by_url:
        source_material = safe_text(canonical_url, 1_400)
        source_suffix = hashlib.sha256(
            source_material.encode("utf-8")
        ).hexdigest()[:12]
        source_project_id = f"{safe_identifier(source_project_id)[:498]}@{source_suffix}"
    introduction = record.get("introduction") or record.get("introduction_summary") or ""
    country = (
        record.get("country_or_region")
        or record.get("country")
        or record.get("category")
        or "其他"
    )
    return {
        "source_project_id": safe_identifier(source_project_id),
        "canonical_url": safe_text(canonical_url, 1_400),
        "project_name": safe_text(record.get("project_name"), 600),
        "country_or_region": safe_text(country, 120) or "其他",
        "category": safe_text(record.get("category"), 160),
        "website_status_note": safe_text(record.get("website_status_note"), 200_000),
        "introduction": safe_text(introduction, 200_000),
        "investment_amount": safe_text(record.get("investment_amount"), 200_000),
        "investment_requirements": as_list(record.get("investment_requirements")),
        "financial_requirements": as_list(record.get("financial_requirements")),
        "application_conditions": as_list(record.get("application_conditions")),
        "advantages": as_list(record.get("advantages")),
        "application_process": as_list(record.get("application_process")),
        "handling_process": as_list(record.get("handling_process")),
        "identity_type": safe_text(record.get("identity_type"), 160),
        "residence_requirement": safe_text(record.get("residence_requirement"), 200_000),
        "process_source_type": infer_process_source_type(
            record, definition.default_process_source_type
        ),
        "scraped_at": normalize_timestamp(
            record.get("scraped_at"), fallback_scraped_at
        ),
    }


def disambiguate_project_identities(
    projects: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for project in projects:
        source_project_id = safe_identifier(project.get("source_project_id"))
        if source_project_id:
            groups.setdefault(source_project_id, []).append(project)
    for source_project_id, group in groups.items():
        if len(group) < 2:
            continue
        for project in group:
            material = (
                f"{safe_text(project.get('canonical_url'), 1_400)}\n"
                f"{safe_text(project.get('project_name'), 600)}"
            )
            suffix = hashlib.sha256(material.encode("utf-8")).hexdigest()[:12]
            project["source_project_id"] = f"{source_project_id[:498]}@{suffix}"
    return projects


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def tail_text(path: Path, max_length: int = 4_000) -> str:
    if not path.exists():
        return ""
    with path.open("rb") as handle:
        handle.seek(0, os.SEEK_END)
        size = handle.tell()
        handle.seek(max(0, size - max_length * 2))
        data = handle.read()
    return data.decode("utf-8", errors="replace")[-max_length:].strip()


def stop_process_group(process: subprocess.Popen[Any]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=10)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def resolve_collector_proxy_url(definition: CollectorDefinition) -> str:
    peer_suffix = definition.peer_code.upper().replace("-", "_")
    peer_variable = f"PEER_WEBSITE_{peer_suffix}_PROXY_URL"
    proxy_url = str(
        os.environ.get(peer_variable)
        or os.environ.get("PEER_WEBSITE_PROXY_URL")
        or ""
    ).strip()
    if not proxy_url:
        return ""

    try:
        parsed = urlsplit(proxy_url)
        proxy_port = parsed.port
    except ValueError as error:
        raise ValueError("官网代理地址格式无效") from error
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
        or proxy_port is None
    ):
        raise ValueError("官网代理必须是带端口的本机 HTTP(S) 地址")
    return proxy_url


def build_collector_environment(
    definition: CollectorDefinition,
) -> tuple[dict[str, str], bool]:
    environment = {**os.environ, "PYTHONUNBUFFERED": "1"}
    for key in PROXY_ENVIRONMENT_KEYS:
        environment.pop(key, None)

    proxy_url = resolve_collector_proxy_url(definition)
    if not proxy_url:
        return environment, False

    environment.update({
        "HTTP_PROXY": proxy_url,
        "HTTPS_PROXY": proxy_url,
        "http_proxy": proxy_url,
        "https_proxy": proxy_url,
        "NO_PROXY": "127.0.0.1,localhost,::1",
        "no_proxy": "127.0.0.1,localhost,::1",
        "PEER_WEBSITE_EFFECTIVE_PROXY_URL": proxy_url,
    })
    return environment, True


def environment_flag(name: str) -> bool:
    return str(os.environ.get(name) or "").strip().lower() in {
        "1", "true", "yes", "on",
    }


def configured_proxy_urls(
    definitions: list[CollectorDefinition],
    require_proxy: bool,
) -> list[str]:
    proxy_urls = []
    missing = []
    for definition in definitions:
        proxy_url = resolve_collector_proxy_url(definition)
        if proxy_url:
            if proxy_url not in proxy_urls:
                proxy_urls.append(proxy_url)
        else:
            missing.append(definition.peer_code)
    if require_proxy and missing:
        raise ValueError(
            "官网任务要求强制代理，但以下采集器未配置代理："
            + ", ".join(missing)
        )
    return proxy_urls


def preflight_proxy(proxy_url: str, timeout_seconds: int = 20) -> None:
    opener = build_opener(ProxyHandler({"http": proxy_url, "https": proxy_url}))
    for target in PROXY_PREFLIGHT_TARGETS:
        request = Request(target, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with opener.open(request, timeout=timeout_seconds) as response:
                if 200 <= response.status < 500:
                    response.read(64)
                    return
        except (HTTPError, URLError, TimeoutError, OSError):
            continue
    raise RuntimeError("官网代理出口连通性预检失败；任务已停止，未回退直连")


def execute_collector(
    definition: CollectorDefinition,
    run_directory: Path,
    collector_version: str,
    timeout_seconds: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    collector_directory = run_directory / definition.peer_code
    collector_directory.mkdir(parents=True, exist_ok=True)
    output_path = collector_directory / definition.output_name
    log_path = collector_directory / "collector.log"
    command = [
        sys.executable,
        str(COLLECTOR_ROOT / definition.script_name),
        "--output-dir",
        str(collector_directory),
    ]
    started_at = now_china()
    return_code: int | None = None
    timed_out = False
    runtime_error = ""
    proxy_configured = False
    try:
        environment, proxy_configured = build_collector_environment(definition)
    except ValueError as error:
        runtime_error = safe_text(error)
    if not runtime_error:
        try:
            with log_path.open("w", encoding="utf-8") as log_handle:
                process = subprocess.Popen(
                    command,
                    cwd=COLLECTOR_ROOT,
                    env=environment,
                    stdout=log_handle,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
                try:
                    return_code = process.wait(timeout=timeout_seconds)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    stop_process_group(process)
                    return_code = process.returncode
        except OSError as error:
            runtime_error = safe_text(error)
    finished_at = now_china()

    raw_records: list[dict[str, Any]] = []
    output_error = ""
    if output_path.exists():
        try:
            loaded = read_json(output_path)
            if not isinstance(loaded, list):
                raise ValueError("采集结果顶层必须是数组")
            raw_records = [item for item in loaded if isinstance(item, dict)]
            if len(raw_records) != len(loaded):
                output_error = "采集结果包含非对象项目"
        except (OSError, ValueError, json.JSONDecodeError) as error:
            output_error = safe_text(error)
    else:
        output_error = "采集器未生成项目 JSON"

    candidate_records = [
        record for record in raw_records
        if safe_text(record.get("scrape_status") or "ok", 20).lower() == "ok"
    ]
    failed_records = [record for record in raw_records if record not in candidate_records]
    finished_at_text = iso_seconds(finished_at)
    projects = []
    invalid_success_errors = []
    for record in candidate_records:
        project = normalize_project(record, definition, finished_at_text)
        if not project["project_name"] or not project["canonical_url"]:
            invalid_success_errors.append(
                f"项目缺少名称或官网链接: {project['source_project_id'] or '(unknown)'}"
            )
            continue
        projects.append(project)
    disambiguate_project_identities(projects)
    record_errors = [
        safe_text(record.get("error"), 500)
        for record in failed_records
        if safe_text(record.get("error"), 500)
    ]
    errors = [
        message for message in (
            runtime_error,
            "采集器运行超时" if timed_out else "",
            f"采集器退出码 {return_code}" if return_code not in (0, None) else "",
            output_error,
            "；".join(record_errors[:5]),
            "；".join(invalid_success_errors[:5]),
        ) if message
    ]
    success_count = len(projects)
    failed_count = len(failed_records) + len(invalid_success_errors)
    if output_error:
        failed_count = max(1, failed_count)
    if runtime_error or timed_out or return_code not in (0, None):
        failed_count = max(1, failed_count)
    discovered_count = success_count + failed_count
    if success_count == 0:
        status = "failed"
        projects = []
        if not errors:
            errors.append("采集器没有生成有效项目")
    elif failed_count > 0:
        status = "partial"
    else:
        status = "completed"

    collector_payload = {
        "peer_code": definition.peer_code,
        "source_domain": definition.source_domain,
        "collector_version": collector_version,
        "status": status,
        "error": safe_text("；".join(errors)),
        "discovered_count": discovered_count,
        "success_count": success_count,
        "failed_count": failed_count,
        "projects": projects,
    }
    manifest = {
        **asdict(definition),
        "status": status,
        "return_code": return_code,
        "timed_out": timed_out,
        "proxy_configured": proxy_configured,
        "started_at": iso_seconds(started_at),
        "finished_at": finished_at_text,
        "duration_seconds": round((finished_at - started_at).total_seconds(), 3),
        "discovered_count": discovered_count,
        "success_count": success_count,
        "failed_count": failed_count,
        "output_file": str(output_path.relative_to(run_directory)),
        "log_file": str(log_path.relative_to(run_directory)),
        "error": collector_payload["error"],
        "log_tail": safe_text(tail_text(log_path)),
    }
    return collector_payload, manifest


def discover_collector_version(explicit: str = "") -> str:
    configured = safe_text(
        explicit or os.environ.get("PEER_WEBSITE_COLLECTOR_VERSION"), 160
    )
    if configured:
        return configured
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short=12", "HEAD"],
            cwd=REPOSITORY_ROOT,
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        version = safe_text(result.stdout, 40)
        if version:
            return version
    except (OSError, subprocess.SubprocessError):
        pass
    return "unversioned"


def generate_run_id(started_at: datetime) -> str:
    timestamp = started_at.strftime("%Y%m%dT%H%M%S%z")
    return f"web-{timestamp}-{secrets.token_hex(4)}"


def build_snapshot(
    run_id: str,
    started_at: datetime,
    finished_at: datetime,
    collectors: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "started_at": iso_seconds(started_at),
        "finished_at": iso_seconds(finished_at),
        "collectors": collectors,
    }


def post_snapshot(
    snapshot: dict[str, Any],
    base_url: str,
    import_mode: str,
    timeout_seconds: int,
) -> dict[str, Any]:
    query = urlencode({"dryRun": "1" if import_mode == "dry-run" else "0"})
    endpoint = (
        f"{base_url.rstrip('/')}/api/peer-monitor/website/import?{query}"
    )
    headers = {"Content-Type": "application/json"}
    token = safe_text(os.environ.get("PEER_DISCOVERY_CRON_TOKEN"), 2_000)
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(
        endpoint,
        data=json.dumps(snapshot, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            body = response.read().decode("utf-8")
            result = json.loads(body)
            return {"http_status": response.status, "response": result}
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"官网导入返回 HTTP {error.code}: {safe_text(body)}"
        ) from error
    except (URLError, TimeoutError, json.JSONDecodeError) as error:
        raise RuntimeError(f"官网导入请求失败: {safe_text(error)}") from error


def count_non_completed_import_collectors(import_result: dict[str, Any] | None) -> int:
    if not import_result:
        return 0
    response = import_result.get("response")
    if not isinstance(response, dict):
        return 1
    collectors = response.get("collectors")
    if not isinstance(collectors, list):
        return 0 if response.get("status") == "completed" else 1
    return sum(
        1 for collector in collectors
        if not isinstance(collector, dict) or collector.get("status") != "completed"
    )


def emit(event: str, **values: Any) -> None:
    print(json.dumps({
        "time": iso_seconds(now_china()),
        "event": event,
        **values,
    }, ensure_ascii=False), flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="逐站运行同行官网采集器并导入 yimin_ai_hot"
    )
    parser.add_argument(
        "--import-mode",
        choices=("write", "dry-run", "none"),
        default=os.environ.get("PEER_WEBSITE_IMPORT_MODE", "write"),
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("YIMIN_BASE_URL", "http://127.0.0.1:4173"),
    )
    parser.add_argument(
        "--output-root",
        default=os.environ.get(
            "PEER_WEBSITE_OUTPUT_ROOT",
            str(REPOSITORY_ROOT / "var" / "peer-web"),
        ),
    )
    parser.add_argument(
        "--collector-timeout",
        type=int,
        default=int(os.environ.get("PEER_WEBSITE_COLLECTOR_TIMEOUT_SECONDS", "2700")),
    )
    parser.add_argument(
        "--import-timeout",
        type=int,
        default=int(os.environ.get("PEER_WEBSITE_IMPORT_TIMEOUT_SECONDS", "300")),
    )
    parser.add_argument("--collector-version", default="")
    parser.add_argument("--run-id", default="")
    parser.add_argument(
        "--only",
        action="append",
        choices=tuple(definition.peer_code for definition in COLLECTORS),
        help="只运行指定同行；可重复传入",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.collector_timeout < 30 or args.import_timeout < 5:
        raise SystemExit("timeout 参数过小")
    started_at = now_china()
    run_id = args.run_id or generate_run_id(started_at)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:+-]{7,159}", run_id):
        raise SystemExit("run_id 格式无效")
    output_root = Path(args.output_root).expanduser().resolve()
    run_directory = output_root / "runs" / run_id
    run_directory.mkdir(parents=True, exist_ok=False)
    version = discover_collector_version(args.collector_version)
    selected = [
        definition for definition in COLLECTORS
        if not args.only or definition.peer_code in set(args.only)
    ]
    require_proxy = environment_flag("PEER_WEBSITE_REQUIRE_PROXY")
    try:
        proxy_urls = configured_proxy_urls(selected, require_proxy)
        for proxy_url in proxy_urls:
            preflight_proxy(proxy_url)
    except (ValueError, RuntimeError) as error:
        emit(
            "proxy_preflight_failed",
            run_id=run_id,
            require_proxy=require_proxy,
            error=safe_text(error),
        )
        return 1
    emit(
        "proxy_preflight_finished",
        run_id=run_id,
        require_proxy=require_proxy,
        proxied_collector_count=sum(
            1 for definition in selected
            if resolve_collector_proxy_url(definition)
        ),
    )
    emit(
        "run_started",
        run_id=run_id,
        import_mode=args.import_mode,
        collector_count=len(selected),
        collector_version=version,
    )

    collector_payloads: list[dict[str, Any]] = []
    manifests: list[dict[str, Any]] = []
    for index, definition in enumerate(selected, start=1):
        emit(
            "collector_started",
            run_id=run_id,
            peer_code=definition.peer_code,
            index=index,
            total=len(selected),
        )
        payload, manifest = execute_collector(
            definition,
            run_directory,
            version,
            args.collector_timeout,
        )
        collector_payloads.append(payload)
        manifests.append(manifest)
        emit(
            "collector_finished",
            run_id=run_id,
            peer_code=definition.peer_code,
            status=payload["status"],
            success_count=payload["success_count"],
            failed_count=payload["failed_count"],
            duration_seconds=manifest["duration_seconds"],
            error=payload["error"],
        )

    finished_at = now_china()
    snapshot = build_snapshot(
        run_id, started_at, finished_at, collector_payloads
    )
    snapshot_path = run_directory / "snapshot-v1.json"
    manifest_path = run_directory / "manifest.json"
    atomic_write_json(snapshot_path, snapshot)
    manifest = {
        "run_id": run_id,
        "schema_version": SCHEMA_VERSION,
        "started_at": iso_seconds(started_at),
        "finished_at": iso_seconds(finished_at),
        "collector_version": version,
        "import_mode": args.import_mode,
        "collectors": manifests,
    }
    atomic_write_json(manifest_path, manifest)

    import_result: dict[str, Any] | None = None
    import_error = ""
    if args.import_mode != "none":
        try:
            import_result = post_snapshot(
                snapshot,
                args.base_url,
                args.import_mode,
                args.import_timeout,
            )
            atomic_write_json(run_directory / "import-response.json", import_result)
            response_body = import_result.get("response") or {}
            if not response_body.get("ok"):
                raise RuntimeError(
                    safe_text(response_body.get("error") or "官网导入未成功")
                )
            emit(
                "import_finished",
                run_id=run_id,
                http_status=import_result.get("http_status"),
                status=response_body.get("status"),
                totals=response_body.get("totals"),
            )
        except RuntimeError as error:
            import_error = safe_text(error)
            emit("import_failed", run_id=run_id, error=import_error)

    local_non_completed = sum(
        1 for item in collector_payloads if item["status"] != "completed"
    )
    import_non_completed = count_non_completed_import_collectors(import_result)
    non_completed = max(local_non_completed, import_non_completed)
    latest = {
        "run_id": run_id,
        "run_directory": str(run_directory),
        "snapshot_file": str(snapshot_path),
        "manifest_file": str(manifest_path),
        "import_mode": args.import_mode,
        "import_error": import_error,
        "collector_count": len(collector_payloads),
        "local_non_completed_collector_count": local_non_completed,
        "import_non_completed_collector_count": import_non_completed,
        "non_completed_collector_count": non_completed,
        "finished_at": iso_seconds(now_china()),
    }
    atomic_write_json(output_root / "latest.json", latest)
    emit(
        "run_finished",
        run_id=run_id,
        non_completed_collector_count=non_completed,
        import_error=import_error,
        snapshot_file=str(snapshot_path),
    )
    if import_error:
        return 1
    if non_completed:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
