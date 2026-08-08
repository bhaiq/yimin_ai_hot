#!/usr/bin/env python3
"""抓取景鸿集团（ekimmigration.com）官网公开展示的移民项目。

该站点返回完整静态 HTML，不需要浏览器渲染。项目入口由首页导航与
sitemap.xml 合并发现；只访问 robots.txt 允许的项目详情页。
"""

from __future__ import annotations

import argparse
import copy
import csv
import json
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urljoin, urlparse

from lxml import etree, html


BASE_URL = "https://www.ekimmigration.com"
HOME_URL = f"{BASE_URL}/"
SITEMAP_URL = f"{BASE_URL}/sitemap.xml"
USER_AGENT = (
    "EKImmigrationPublicProjectResearch/1.0 "
    "(public project pages only; low-frequency)"
)
PROJECT_PATH_RE = re.compile(
    r"^/country/(?P<country>[A-Za-z_]+)/(?P<id>\d+)\.html$",
    re.IGNORECASE,
)
COUNTRY_NAMES = {
    "america": "美国",
    "australia": "澳洲",
    "canada": "加拿大",
    "cyprus": "塞浦路斯",
    "dominic": "多米尼克",
    "greece": "希腊",
    "hongkong": "中国香港",
    "hungary": "匈牙利",
    "ireland": "爱尔兰",
    "japan": "日本",
    "macao": "中国澳门",
    "malta": "马耳他",
    "newzealand": "新西兰",
    "portugal": "葡萄牙",
    "saint_lucia": "圣卢西亚",
    "saintkitts": "圣基茨",
    "singapore": "新加坡",
    "southkorea": "韩国",
    "turkey": "土耳其",
    "vanuatu": "瓦努阿图",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="抓取 ekimmigration.com 公开展示的移民项目"
    )
    parser.add_argument(
        "--output-dir",
        default="output/ekimmigration",
        help="输出目录，默认：output/ekimmigration",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.8,
        help="项目页面之间的等待秒数，默认：0.8",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="只抓前 N 个候选项目；0 表示全部",
    )
    parser.add_argument(
        "--url",
        action="append",
        dest="urls",
        help="只抓指定项目 URL；可重复传入",
    )
    return parser.parse_args()


def http_get(url: str, timeout: int = 30) -> tuple[bytes, str]:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read(), response.geturl()


def normalize_text(value: str | None) -> str:
    if not value:
        return ""
    value = value.replace("\xa0", " ").replace("\u3000", " ")
    value = re.sub(r"[ \t\r\f\v]+", " ", value)
    value = re.sub(r" *\n *", "\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def element_text(node: etree._Element | None) -> str:
    return normalize_text(node.text_content()) if node is not None else ""


def first(nodes: Iterable[etree._Element]) -> etree._Element | None:
    return next(iter(nodes), None)


def absolute_urls(values: Iterable[str]) -> list[str]:
    result: list[str] = []
    for value in values:
        url = urljoin(BASE_URL, value.strip())
        if url and url not in result:
            result.append(url)
    return result


def normalize_project_url(value: str) -> str | None:
    url = urljoin(BASE_URL, value.strip())
    parsed = urlparse(url)
    if parsed.netloc not in {"www.ekimmigration.com", "ekimmigration.com"}:
        return None
    match = PROJECT_PATH_RE.fullmatch(parsed.path)
    if not match:
        return None
    return f"{BASE_URL}{parsed.path}"


def parse_document(data: bytes) -> html.HtmlElement:
    parser = html.HTMLParser(encoding="utf-8", recover=True)
    return html.fromstring(data, parser=parser, base_url=BASE_URL)


def discover_from_homepage() -> tuple[list[str], bytes]:
    data, _ = http_get(HOME_URL)
    document = parse_document(data)
    urls: list[str] = []
    for href in document.xpath("//a/@href"):
        normalized = normalize_project_url(href)
        if normalized and normalized not in urls:
            urls.append(normalized)
    return urls, data


def discover_from_sitemap() -> list[str]:
    data, _ = http_get(SITEMAP_URL, timeout=60)
    root = ET.fromstring(data)
    urls: list[str] = []
    for loc in root.findall(".//{*}loc"):
        if not loc.text:
            continue
        normalized = normalize_project_url(loc.text)
        if normalized and normalized not in urls:
            urls.append(normalized)
    return urls


def discover_project_urls(
    explicit_urls: list[str] | None,
) -> tuple[list[str], dict[str, list[str]]]:
    if explicit_urls:
        urls = [normalize_project_url(url) for url in explicit_urls]
        valid = [url for url in urls if url]
        return valid, {url: ["explicit"] for url in valid}

    sources: dict[str, list[str]] = defaultdict(list)
    ordered: list[str] = []
    errors: list[str] = []
    discoverers = (
        ("homepage", lambda: discover_from_homepage()[0]),
        ("sitemap", discover_from_sitemap),
    )
    for label, discoverer in discoverers:
        try:
            for url in discoverer():
                if label not in sources[url]:
                    sources[url].append(label)
                if url not in ordered:
                    ordered.append(url)
        except Exception as exc:
            errors.append(f"{label}: {exc}")
    if not ordered:
        raise RuntimeError("未发现任何项目地址；" + "；".join(errors))
    if errors:
        print("发现阶段警告：" + "；".join(errors), file=sys.stderr)
    return ordered, dict(sources)


def clean_section_clone(
    section: etree._Element | None,
    remove_selectors: tuple[str, ...] = (
        './/*[contains(concat(" ", normalize-space(@class), " "), " dtlconttit ")]',
        './/*[contains(concat(" ", normalize-space(@class), " "), " myquestion ")]',
        ".//script",
        ".//style",
    ),
) -> etree._Element | None:
    if section is None:
        return None
    clone = copy.deepcopy(section)
    for selector in remove_selectors:
        for node in clone.xpath(selector):
            node.drop_tree()
    return clone


def extract_section_text(section: etree._Element | None) -> str:
    clone = clean_section_clone(section)
    return element_text(clone)


def extract_list_or_paragraphs(section: etree._Element | None) -> list[str]:
    if section is None:
        return []
    clone = clean_section_clone(section)
    if clone is None:
        return []

    items: list[str] = []
    li_nodes = clone.xpath(".//li[not(ancestor::li)]")
    for node in li_nodes:
        text = element_text(node)
        if text and "了解更详细" not in text and text not in items:
            items.append(text)
    if items:
        return items

    for node in clone.xpath(".//p"):
        text = element_text(node)
        if text and "咨询" not in text and text not in items:
            items.append(text)
    return items


def split_detail_item(value: str) -> tuple[str, str] | None:
    text = normalize_text(value).replace("\n", " ")
    match = re.match(r"([^：:]{2,12})[：:]\s*(.+)", text)
    if not match:
        return None
    return match.group(1).strip(), match.group(2).strip()


def extract_process_steps(section: etree._Element | None) -> list[dict[str, Any]]:
    if section is None:
        return []
    clone = clean_section_clone(section)
    if clone is None:
        return []

    candidate_nodes = clone.xpath(".//li[not(ancestor::li)]")
    if not candidate_nodes:
        candidate_nodes = clone.xpath(".//p[normalize-space()]")

    steps: list[dict[str, Any]] = []
    for node in candidate_nodes:
        text = element_text(node)
        if not text or text.startswith("以上流程仅供参考"):
            continue
        if node.xpath(".//img") and len(text) < 3:
            continue
        text = re.sub(r"^\s*(?:第?\s*\d+\s*[步、.．:]?|Step\s*\d+)\s*", "", text)
        text = normalize_text(text)
        if not text:
            continue
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        steps.append(
            {
                "number": len(steps) + 1,
                "stage": lines[0] if lines else text,
                "details": "；".join(lines[1:]) if len(lines) > 1 else text,
                "raw_text": text,
            }
        )
    return steps


def derive_investment_requirements(record: dict[str, Any]) -> list[str]:
    source = "。".join(
        [
            record.get("introduction", ""),
            record.get("application_conditions_text", ""),
            record.get("investment_amount", ""),
        ]
    )
    keywords = (
        "投资",
        "投入",
        "购房",
        "购买房产",
        "购买物业",
        "基金",
        "捐款",
        "定存",
        "注册公司",
        "创业",
        "无需投资",
    )
    result: list[str] = []
    for sentence in re.split(r"[。！？；;\n]+", source):
        sentence = normalize_text(sentence).strip(" ，,")
        if sentence and any(keyword in sentence for keyword in keywords):
            if sentence not in result:
                result.append(sentence)
    return result


def derive_financial_requirements(record: dict[str, Any]) -> list[str]:
    source = "。".join(
        [
            record.get("introduction", ""),
            record.get("application_conditions_text", ""),
            record.get("investment_amount", ""),
        ]
    )
    money_pattern = re.compile(
        r"\d+(?:\.\d+)?\s*(?:万|亿)?\s*"
        r"(?:美元|美金|欧元|欧|人民币|港元|港币|加元|加币|"
        r"澳元|日元|新币|英镑|元)"
    )
    keywords = (
        "资金证明",
        "资产证明",
        "存款证明",
        "净资产",
        "年收入",
        "营业额",
        "纳税",
        "注册资本",
        "投资额度",
        "投资金额",
    )
    result: list[str] = []
    for sentence in re.split(r"[。！？；;\n]+", source):
        sentence = normalize_text(sentence).strip(" ，,")
        if not sentence:
            continue
        if money_pattern.search(sentence) or any(keyword in sentence for keyword in keywords):
            if sentence not in result:
                result.append(sentence)
    return result


def scrape_project(
    data: bytes,
    requested_url: str,
    final_url: str,
    discovery_sources: list[str],
) -> dict[str, Any]:
    document = parse_document(data)
    main = first(
        document.xpath(
            '//div[contains(concat(" ", normalize-space(@class), " "), " dtlbg ")]'
        )
    )
    title_node = first(
        document.xpath(
            '//div[contains(concat(" ", normalize-space(@class), " "), " dtltoptit ")]/h1'
        )
    )
    project_name = element_text(title_node)

    if main is None or not project_name:
        return {
            "scrape_status": "error",
            "error": "未找到项目详情模板或项目名称",
            "requested_url": requested_url,
            "source_url": final_url,
            "discovery_sources": discovery_sources,
        }

    summary_node = first(
        document.xpath(
            '//div[contains(concat(" ", normalize-space(@class), " "), " dtltoptit ")]/p'
        )
    )
    details: dict[str, str] = {}
    detail_items = document.xpath(
        '//ul[contains(concat(" ", normalize-space(@class), " "), " dtldes ")]/li'
    )
    for node in detail_items:
        pair = split_detail_item(element_text(node))
        if pair:
            details[pair[0]] = pair[1]

    intro_section = first(document.xpath('//*[@id="1f"]'))
    advantages_section = first(document.xpath('//*[@id="2f"]'))
    conditions_section = first(document.xpath('//*[@id="3f"]'))
    process_section = first(document.xpath('//*[@id="4f"]'))
    faq_section = first(document.xpath('//*[@id="5f"]'))

    introduction = extract_section_text(intro_section)
    advantages = extract_list_or_paragraphs(advantages_section)
    conditions = extract_list_or_paragraphs(conditions_section)
    conditions_text = extract_section_text(conditions_section)
    process_text = extract_section_text(process_section)
    process_steps = extract_process_steps(process_section)
    process_images = (
        absolute_urls(process_section.xpath(".//img/@src"))
        if process_section is not None
        else []
    )
    faq_text = extract_section_text(faq_section)

    slug_match = PROJECT_PATH_RE.fullmatch(urlparse(final_url).path)
    country_slug = (
        slug_match.group("country").lower() if slug_match else ""
    )
    project_id = slug_match.group("id") if slug_match else ""

    section_images: list[str] = []
    for section in (
        intro_section,
        advantages_section,
        conditions_section,
        process_section,
    ):
        if section is not None:
            section_images.extend(section.xpath(".//img/@src"))
    top_images = document.xpath(
        '//div[contains(concat(" ", normalize-space(@class), " "), " dtltop ")]//img/@src'
    )

    investment_amount = (
        details.get("投资额度")
        or details.get("投资金额")
        or details.get("投资额")
        or ""
    )
    record: dict[str, Any] = {
        "company_name": "景鸿集团（景鸿移民）",
        "source_domain": "ekimmigration.com",
        "scrape_status": "ok",
        "error": "",
        "requested_url": requested_url,
        "source_url": final_url,
        "discovery_sources": discovery_sources,
        "project_id": project_id,
        "project_name": project_name,
        "category": COUNTRY_NAMES.get(country_slug, country_slug),
        "country_slug": country_slug,
        "introduction_summary": element_text(summary_node),
        "introduction": introduction,
        "recommendation_index": details.get("推荐指数", ""),
        "residence_requirement": details.get("居住要求", ""),
        "process_summary": details.get("办理周期", ""),
        "identity_type": details.get("身份类型", ""),
        "investment_amount": investment_amount,
        "investment_requirements": [],
        "financial_requirements": [],
        "advantages": advantages,
        "advantages_text": extract_section_text(advantages_section),
        "application_conditions": conditions,
        "application_conditions_text": conditions_text,
        "process_source_type": (
            "html_text"
            if process_steps or process_text
            else "image_only"
            if process_images
            else "missing"
        ),
        "process_text": process_text,
        "process_image_urls": process_images,
        "application_process": process_steps,
        "handling_process": process_steps,
        "faq_text": faq_text,
        "image_urls": absolute_urls([*top_images, *section_images]),
        "raw_details": details,
        "raw_section_texts": {
            "项目介绍": introduction,
            "项目优势": extract_section_text(advantages_section),
            "申请条件": conditions_text,
            "申请流程": process_text,
        },
        "scraped_at": datetime.now(timezone.utc).isoformat(),
    }
    record["investment_requirements"] = derive_investment_requirements(record)
    record["financial_requirements"] = derive_financial_requirements(record)
    record["is_investment_project"] = bool(
        re.search(
            r"投资|购房|房产|基金|存款|创业|商业|企业家|家族办公室",
            project_name,
        )
    )
    return record


def deduplicate_records(
    records: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    errors: list[dict[str, Any]] = []
    for record in records:
        if record.get("scrape_status") != "ok":
            errors.append(record)
            continue
        grouped[record["project_name"]].append(record)

    kept: list[dict[str, Any]] = []
    duplicates: list[dict[str, Any]] = []
    for project_name, candidates in grouped.items():
        ranked = sorted(
            candidates,
            key=lambda item: (
                "homepage" in item.get("discovery_sources", []),
                "sitemap" in item.get("discovery_sources", []),
                len(item.get("introduction", "")),
                int(item.get("project_id") or 0),
            ),
            reverse=True,
        )
        kept.append(ranked[0])
        for dropped in ranked[1:]:
            duplicates.append(
                {
                    "project_name": project_name,
                    "kept_url": ranked[0].get("source_url"),
                    "dropped_url": dropped.get("source_url"),
                }
            )

    order = {
        record.get("requested_url"): index for index, record in enumerate(records)
    }
    kept.sort(key=lambda item: order.get(item.get("requested_url"), 10**9))
    return kept, [*duplicates, *errors]


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def write_csv(path: Path, records: list[dict[str, Any]]) -> None:
    fields = [
        "company_name",
        "project_name",
        "category",
        "project_id",
        "is_investment_project",
        "source_url",
        "introduction_summary",
        "introduction",
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
        "recommendation_index",
        "scraped_at",
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for record in records:
            row: dict[str, Any] = {}
            for field in fields:
                value = record.get(field, "")
                if isinstance(value, (list, dict)):
                    value = json.dumps(value, ensure_ascii=False)
                row[field] = value
            writer.writerow(row)


def write_overview(path: Path, records: list[dict[str, Any]]) -> None:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        grouped[record.get("category") or "未分类"].append(record)
    lines = [
        "# 景鸿移民官网项目清单",
        "",
        f"共采集 {len(records)} 个有效项目，按官网国家/地区分类整理。",
        "",
    ]
    for category, items in sorted(grouped.items()):
        lines.extend([f"## {category}（{len(items)}）", ""])
        for item in items:
            lines.append(f"- [{item['project_name']}]({item['source_url']})")
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def write_summary(
    path: Path,
    records: list[dict[str, Any]],
    candidates: list[str],
    excluded: list[dict[str, Any]],
) -> None:
    categories: dict[str, int] = defaultdict(int)
    for record in records:
        categories[record.get("category") or "未分类"] += 1
    summary = {
        "company_name": "景鸿集团（景鸿移民）",
        "source": BASE_URL,
        "candidate_url_count": len(candidates),
        "record_count": len(records),
        "investment_project_count": sum(
            1 for record in records if record.get("is_investment_project")
        ),
        "html_process_count": sum(
            1
            for record in records
            if record.get("process_source_type") == "html_text"
        ),
        "image_only_process_count": sum(
            1
            for record in records
            if record.get("process_source_type") == "image_only"
        ),
        "missing_process_count": sum(
            1
            for record in records
            if record.get("process_source_type") == "missing"
        ),
        "categories": dict(sorted(categories.items())),
        "excluded_or_duplicate_records": excluded,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    write_json(path, summary)


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    candidates, source_map = discover_project_urls(args.urls)
    if args.limit > 0:
        candidates = candidates[: args.limit]
    print(f"发现 {len(candidates)} 个候选项目页面")

    raw_records: list[dict[str, Any]] = []
    for index, url in enumerate(candidates, start=1):
        print(f"[{index}/{len(candidates)}] {url}", flush=True)
        try:
            data, final_url = http_get(url)
            record = scrape_project(
                data,
                requested_url=url,
                final_url=final_url,
                discovery_sources=source_map.get(url, []),
            )
        except Exception as exc:
            record = {
                "scrape_status": "error",
                "error": str(exc),
                "requested_url": url,
                "source_url": url,
                "discovery_sources": source_map.get(url, []),
            }
        raw_records.append(record)
        print(
            f"  {record.get('scrape_status')}: "
            f"{record.get('project_name') or '(未识别)'}",
            flush=True,
        )
        if args.delay > 0 and index < len(candidates):
            time.sleep(args.delay)

    records, excluded = deduplicate_records(raw_records)
    json_path = output_dir / "ekimmigration_projects.json"
    csv_path = output_dir / "ekimmigration_projects.csv"
    overview_path = output_dir / "ekimmigration_projects_overview.md"
    summary_path = output_dir / "summary.json"
    write_json(json_path, records)
    write_csv(csv_path, records)
    write_overview(overview_path, records)
    write_summary(summary_path, records, candidates, excluded)

    print(f"完成：有效项目 {len(records)}/{len(candidates)}")
    print(f"JSON：{json_path}")
    print(f"CSV：{csv_path}")
    print(f"项目清单：{overview_path}")
    print(f"摘要：{summary_path}")
    return 0 if records else 1


if __name__ == "__main__":
    raise SystemExit(main())
