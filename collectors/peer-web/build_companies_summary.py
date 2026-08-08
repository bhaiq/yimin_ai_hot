#!/usr/bin/env python3
"""合并当前已采集的移民公司项目数据。"""

from __future__ import annotations

import csv
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT / "output"
SOURCE_FILES = (
    {
        "path": OUTPUT_DIR / "aqyimin_projects.json",
        "company_name": "桉侨移民",
        "source_domain": "aqyimin.com",
        "default_process_source_type": "html_text",
    },
    {
        "path": OUTPUT_DIR
        / "ekimmigration"
        / "ekimmigration_projects.json",
        "company_name": "景鸿集团（景鸿移民）",
        "source_domain": "ekimmigration.com",
        "default_process_source_type": "image_only",
    },
    {
        "path": OUTPUT_DIR
        / "iqiaowai"
        / "iqiaowai_projects.json",
        "company_name": "侨外出国（侨外移民）",
        "source_domain": "iqiaowai.com",
        "default_process_source_type": "missing",
    },
    {
        "path": OUTPUT_DIR
        / "visa800"
        / "visa800_projects.json",
        "company_name": "亨瑞集团（亨瑞移民）",
        "source_domain": "visa800.com",
        "default_process_source_type": "missing",
    },
    {
        "path": OUTPUT_DIR
        / "worldwayhk"
        / "worldwayhk_projects.json",
        "company_name": "世贸通集团（世贸通移民）",
        "source_domain": "worldwayhk.com",
        "default_process_source_type": "missing",
    },
    {
        "path": OUTPUT_DIR
        / "austargroup"
        / "austargroup_projects.json",
        "company_name": "澳星集团（澳星出国）",
        "source_domain": "austargroup.com",
        "default_process_source_type": "missing",
    },
    {
        "path": OUTPUT_DIR
        / "welltrendvisa"
        / "welltrendvisa_projects.json",
        "company_name": "和中移民（WellTrend）",
        "source_domain": "welltrendvisa.com",
        "default_process_source_type": "missing",
    },
    {
        "path": OUTPUT_DIR
        / "wailianvisa"
        / "wailianvisa_projects.json",
        "company_name": "外联出国（外联移民）",
        "source_domain": "wailianvisa.com",
        "default_process_source_type": "missing",
    },
    {
        "path": OUTPUT_DIR
        / "zlglobal"
        / "zlglobal_projects.json",
        "company_name": "兆龙移民（兆龙出国）",
        "source_domain": "zlglobal.net",
        "default_process_source_type": "missing",
    },
)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def normalize_record(
    record: dict[str, Any],
    company_name: str,
    source_domain: str,
    default_process_source_type: str,
) -> dict[str, Any]:
    return {
        "company_name": record.get("company_name") or company_name,
        "source_domain": record.get("source_domain") or source_domain,
        "project_name": record.get("project_name", ""),
        "category": record.get("category", ""),
        "source_url": record.get("source_url")
        or record.get("requested_url", ""),
        "website_status_note": record.get("website_status_note", ""),
        "introduction_summary": record.get("introduction_summary", ""),
        "introduction": record.get("introduction", ""),
        "is_investment_project": bool(
            record.get("is_investment_project")
        ),
        "investment_amount": record.get("investment_amount", ""),
        "investment_requirements": record.get(
            "investment_requirements", []
        ),
        "financial_requirements": record.get(
            "financial_requirements", []
        ),
        "advantages": record.get("advantages", []),
        "application_conditions": record.get(
            "application_conditions", []
        ),
        "process_summary": record.get("process_summary", ""),
        "process_source_type": record.get("process_source_type")
        or default_process_source_type,
        "process_text": record.get("process_text", ""),
        "process_image_urls": record.get("process_image_urls", []),
        "application_process": record.get("application_process", []),
        "handling_process": record.get("handling_process", []),
        "identity_type": record.get("identity_type", ""),
        "residence_requirement": record.get(
            "residence_requirement", ""
        ),
        "scraped_at": record.get("scraped_at", ""),
    }


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def write_csv(path: Path, records: list[dict[str, Any]]) -> None:
    fields = [
        "company_name",
        "source_domain",
        "project_name",
        "category",
        "source_url",
        "website_status_note",
        "introduction_summary",
        "introduction",
        "is_investment_project",
        "investment_amount",
        "investment_requirements",
        "financial_requirements",
        "advantages",
        "application_conditions",
        "process_summary",
        "process_source_type",
        "process_text",
        "process_image_urls",
        "application_process",
        "handling_process",
        "identity_type",
        "residence_requirement",
        "scraped_at",
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for record in records:
            row: dict[str, Any] = {}
            for field in fields:
                value = record.get(field, "")
                if isinstance(value, (list, dict)):
                    value = json.dumps(value, ensure_ascii=False)
                row[field] = value
            writer.writerow(row)


def write_overview(
    path: Path,
    records: list[dict[str, Any]],
) -> None:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        grouped[record["company_name"]].append(record)
    lines = [
        "# 移民公司官网项目汇总",
        "",
        f"当前共收录 {len(grouped)} 家公司、{len(records)} 个官网项目。",
        "",
    ]
    for company_name, items in grouped.items():
        lines.extend([f"## {company_name}（{len(items)}）", ""])
        categories: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for item in items:
            categories[item.get("category") or "未分类"].append(item)
        for category, category_items in sorted(categories.items()):
            lines.extend([f"### {category}（{len(category_items)}）", ""])
            for item in category_items:
                lines.append(
                    f"- [{item['project_name']}]({item['source_url']})"
                )
            lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def build() -> tuple[list[dict[str, Any]], dict[str, Any]]:
    combined: list[dict[str, Any]] = []
    companies: list[dict[str, Any]] = []
    for source in SOURCE_FILES:
        path = source["path"]
        if not path.exists():
            continue
        source_records = read_json(path)
        normalized = [
            normalize_record(
                record,
                source["company_name"],
                source["source_domain"],
                source["default_process_source_type"],
            )
            for record in source_records
            if record.get("scrape_status", "ok") == "ok"
        ]
        combined.extend(normalized)
        companies.append(
            {
                "company_name": source["company_name"],
                "source_domain": source["source_domain"],
                "project_count": len(normalized),
                "investment_project_count": sum(
                    1
                    for record in normalized
                    if record.get("is_investment_project")
                ),
                "html_process_count": sum(
                    1
                    for record in normalized
                    if record.get("process_source_type") == "html_text"
                ),
                "image_only_process_count": sum(
                    1
                    for record in normalized
                    if record.get("process_source_type") == "image_only"
                ),
                "summary_only_process_count": sum(
                    1
                    for record in normalized
                    if record.get("process_source_type") == "summary_only"
                ),
                "missing_process_count": sum(
                    1
                    for record in normalized
                    if record.get("process_source_type") == "missing"
                ),
            }
        )
    summary = {
        "company_count": len(companies),
        "project_count": len(combined),
        "companies": companies,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    return combined, summary


def main() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    combined, summary = build()
    write_json(OUTPUT_DIR / "all_companies_projects.json", combined)
    write_csv(OUTPUT_DIR / "all_companies_projects.csv", combined)
    write_json(OUTPUT_DIR / "companies_summary.json", summary)
    write_overview(OUTPUT_DIR / "all_companies_overview.md", combined)
    print(
        f"已汇总 {summary['company_count']} 家公司、"
        f"{summary['project_count']} 个项目"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
