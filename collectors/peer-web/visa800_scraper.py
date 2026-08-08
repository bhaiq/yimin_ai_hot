#!/usr/bin/env python3
"""抓取亨瑞移民（visa800.com）官网公开展示的移民项目。

该站使用服务端生成的 GB2312/GBK HTML，不需要浏览器渲染。服务器目前会
对正常页面返回 HTTP 500，但响应正文仍是完整官网页面；程序只在正文通过
项目模板校验后才接受这类响应。
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urljoin, urlparse

from lxml import etree, html


BASE_URL = "https://www.visa800.com"
HOME_URL = f"{BASE_URL}/"
PROJECT_INDEX_URL = f"{BASE_URL}/ymxm/"
USER_AGENT = (
    "Visa800PublicProjectResearch/1.0 "
    "(public project pages only; low-frequency)"
)
PROJECT_PATH_RE = re.compile(
    r"^/ymxm/(?P<category>[a-z0-9_]+)/(?P<id>\d+)\.html$",
    re.IGNORECASE,
)
CATEGORY_NAMES = {
    "mg": "美国",
    "bnm": "巴拿马",
    "jnd": "加拿大",
    "aodaliya": "澳大利亚",
    "wanuatu": "瓦努阿图",
    "xinxilan": "新西兰",
    "antigua": "安提瓜和巴布达",
    "duominike": "多米尼克",
    "gelinnada": "格林纳达",
    "shengjici": "圣基茨和尼维斯",
    "shengluxiya": "圣卢西亚",
    "xila": "希腊",
    "tuerqi": "土耳其",
    "gljy": "格鲁吉亚",
    "pty": "葡萄牙",
    "maerta": "马耳他",
    "yingguo": "英国",
    "aierlan": "爱尔兰",
    "xby": "西班牙",
    "xg": "中国香港",
    "tg": "泰国",
    "xinjiapo": "新加坡",
    "mlxy": "马来西亚",
    "flb": "菲律宾",
}
MONEY_RE = re.compile(
    r"(?:USD|CAD|HKD|EUR|RMB|¥|￥|\$)?\s*"
    r"\d+(?:[,.]\d+)?(?:\s*[-–—至或]\s*\d+(?:[,.]\d+)?)?\s*"
    r"(?:万|亿)?\s*(?:美元|美金|欧元|人民币|港元|港币|"
    r"加元|加币|澳元|纽币|日元|新币|英镑|里拉|元)"
)
NUMBERED_SPLIT_RE = re.compile(
    r"(?:(?<=\s)|^)(?=(?:（\d{1,2}）|\(\d{1,2}\)|"
    r"\d{1,2}[、.)．）]))"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="抓取 visa800.com 当前公开展示的移民项目"
    )
    parser.add_argument(
        "--output-dir",
        default="output/visa800",
        help="输出目录，默认：output/visa800",
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
        help="只抓前 N 个项目；0 表示全部",
    )
    parser.add_argument(
        "--url",
        action="append",
        dest="urls",
        help="只抓指定项目网址；可重复传入",
    )
    parser.add_argument(
        "--fixture-dir",
        help="从目录中的 ID.html 读取样本，用于离线测试",
    )
    return parser.parse_args()


def http_get(url: str, timeout: int = 45) -> tuple[bytes, str, int]:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read(), response.geturl(), response.status
    except urllib.error.HTTPError as exc:
        data = exc.read()
        # 站点当前由 IIS/WAF 返回 500，但缓存正文是完整官网页面。
        if exc.code == 500 and len(data) > 10_000:
            return data, exc.geturl(), exc.code
        raise


def normalize_text(value: str | None) -> str:
    if not value:
        return ""
    value = value.replace("\xa0", " ").replace("\u3000", " ")
    value = re.sub(r"[ \t\r\f\v]+", " ", value)
    value = re.sub(r" *\n *", "\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def one_line(value: str | None) -> str:
    return re.sub(r"\s+", " ", normalize_text(value))


def element_text(node: etree._Element | None) -> str:
    return normalize_text(node.text_content()) if node is not None else ""


def first(nodes: Iterable[etree._Element]) -> etree._Element | None:
    return next(iter(nodes), None)


def parse_document(data: bytes) -> html.HtmlElement:
    parser = html.HTMLParser(recover=True)
    return html.fromstring(data, parser=parser, base_url=BASE_URL)


def normalize_project_url(value: str) -> str | None:
    url = urljoin(BASE_URL, value.strip())
    parsed = urlparse(url)
    if parsed.netloc.lower() not in {"visa800.com", "www.visa800.com"}:
        return None
    match = PROJECT_PATH_RE.fullmatch(parsed.path)
    if not match:
        return None
    return f"{BASE_URL}{parsed.path}"


def discover_project_urls(
    explicit_urls: list[str] | None,
) -> tuple[list[str], dict[str, list[str]]]:
    if explicit_urls:
        result = [
            normalized
            for value in explicit_urls
            if (normalized := normalize_project_url(value))
        ]
        return list(dict.fromkeys(result)), {
            url: ["explicit"] for url in result
        }

    sources: dict[str, list[str]] = defaultdict(list)
    ordered: list[str] = []
    errors: list[str] = []
    for label, url in (("homepage", HOME_URL), ("project_index", PROJECT_INDEX_URL)):
        try:
            data, _, _ = http_get(url)
            document = parse_document(data)
            for href in document.xpath("//a/@href"):
                normalized = normalize_project_url(href)
                if not normalized:
                    continue
                if label not in sources[normalized]:
                    sources[normalized].append(label)
                if normalized not in ordered:
                    ordered.append(normalized)
        except Exception as exc:
            errors.append(f"{label}: {exc}")
    if not ordered:
        raise RuntimeError("未发现项目网址；" + "；".join(errors))
    if errors:
        print("发现阶段警告：" + "；".join(errors), file=sys.stderr)
    return ordered, dict(sources)


def project_match(url: str) -> re.Match[str] | None:
    return PROJECT_PATH_RE.fullmatch(urlparse(url).path)


def project_body(document: html.HtmlElement) -> etree._Element | None:
    sections = document.xpath(
        '//section[contains(concat(" ", normalize-space(@class), " "), '
        '" ymxm_xq_body ")]'
    )
    if not sections:
        return None
    candidates = sections[0].xpath(
        './/div[contains(concat(" ", normalize-space(@class), " "), '
        '" col-lg-9 ")][.//h2]'
    )
    return first(candidates)


def extract_sections(
    body: etree._Element,
) -> tuple[dict[str, str], dict[str, list[str]]]:
    texts: dict[str, str] = {}
    items: dict[str, list[str]] = {}
    children = [node for node in body if isinstance(node.tag, str)]
    for index, node in enumerate(children):
        if node.tag.lower() != "h2":
            continue
        label = one_line(element_text(node)).strip("：: ")
        if index + 1 >= len(children):
            continue
        content = children[index + 1]
        if content.tag.lower() == "h2":
            continue
        text = element_text(content)
        if not text:
            continue
        texts[label] = text
        block_items: list[str] = []
        block_nodes = [
            child for child in content if isinstance(child.tag, str)
        ]
        for child in block_nodes:
            value = one_line(element_text(child))
            if value and value not in block_items:
                block_items.append(value)
        items[label] = block_items or [one_line(text)]
    return texts, items


def split_numbered(
    values: Iterable[str], *, deduplicate: bool = True
) -> list[str]:
    result: list[str] = []
    for value in values:
        text = normalize_text(value)
        if not text:
            continue
        chunks = [one_line(part) for part in NUMBERED_SPLIT_RE.split(text)]
        chunks = [chunk for chunk in chunks if chunk]
        if len(chunks) == 1 and "\n" in text:
            chunks = [
                one_line(part) for part in text.splitlines() if one_line(part)
            ]
        for chunk in chunks:
            chunk = chunk.strip("；; ")
            if chunk and (not deduplicate or chunk not in result):
                result.append(chunk)
    return result


def process_steps(values: Iterable[str]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    prepared: list[str] = []
    flow_heading_re = re.compile(
        r"(?<!^)(?=(?:中国境内|美国境内|境外|捐赠|购房|"
        r"房产|基金)申请流程：)"
    )
    for value in values:
        prepared.extend(
            part for part in flow_heading_re.sub("\n", value).splitlines()
            if one_line(part)
        )
    for piece in split_numbered(prepared, deduplicate=False):
        cleaned = re.sub(
            r"^(?:（\d+）|\(\d+\)|\d+[、.)．）])\s*", "", piece
        )
        cleaned = one_line(cleaned)
        if not cleaned:
            continue
        result.append(
            {
                "number": len(result) + 1,
                "stage": cleaned[:100],
                "details": cleaned,
                "raw_text": piece,
            }
        )
    return result


def relevant_sentences(
    values: Iterable[str], keywords: tuple[str, ...]
) -> list[str]:
    result: list[str] = []
    for value in values:
        for sentence in re.split(r"[。；;\n]+", normalize_text(value)):
            sentence = one_line(sentence).strip("，, ")
            if (
                sentence
                and any(keyword in sentence for keyword in keywords)
                and sentence not in result
            ):
                result.append(sentence)
    return result


def money_sentences(values: Iterable[str]) -> list[str]:
    result: list[str] = []
    keywords = (
        "净资产",
        "资产证明",
        "资金证明",
        "注册资本",
        "年收入",
        "营业额",
        "投资款",
        "服务费",
        "申请费",
        "签证费",
        "律师费",
        "费用",
    )
    for value in values:
        for sentence in re.split(r"[。；;\n]+", normalize_text(value)):
            sentence = one_line(sentence).strip("，, ")
            if (
                sentence
                and (MONEY_RE.search(sentence) or any(k in sentence for k in keywords))
                and sentence not in result
            ):
                result.append(sentence)
    return result


def infer_identity_type(project_name: str, source: str) -> str:
    text = project_name + " " + source
    if re.search(r"护照|公民|入籍", text):
        return "公民身份"
    if re.search(r"永居|永久居留|绿卡", text):
        return "永久居留"
    if re.search(r"签证|工签|优才|高才", text):
        return "签证/居留身份"
    return "居留身份"


def scrape_project(
    data: bytes,
    requested_url: str,
    final_url: str,
    http_status: int,
    discovery_sources: list[str],
) -> dict[str, Any]:
    document = parse_document(data)
    body = project_body(document)
    top = first(
        document.xpath(
            '//section[contains(concat(" ", normalize-space(@class), " "), '
            '" ymxm_xq_top ")]'
        )
    )
    title_node = (
        first(top.xpath(".//h2")) if top is not None else None
    )
    project_name = one_line(element_text(title_node))
    if body is None or not project_name:
        return {
            "scrape_status": "error",
            "error": "响应正文未通过项目模板校验",
            "requested_url": requested_url,
            "source_url": final_url,
            "http_status": http_status,
            "discovery_sources": discovery_sources,
        }

    texts, section_items = extract_sections(body)
    required_labels = {"项目介绍", "申请条件", "申请流程"}
    if not required_labels.intersection(texts):
        return {
            "scrape_status": "error",
            "error": "未找到项目介绍、申请条件或申请流程",
            "requested_url": requested_url,
            "source_url": final_url,
            "http_status": http_status,
            "discovery_sources": discovery_sources,
        }

    match = project_match(requested_url) or project_match(final_url)
    category_slug = match.group("category").lower() if match else ""
    project_id = match.group("id") if match else ""
    breadcrumb = ""
    if top is not None:
        breadcrumb_node = first(top.xpath(".//h3"))
        breadcrumb = one_line(element_text(breadcrumb_node))
    breadcrumb_parts = [
        part.strip() for part in breadcrumb.split(">") if part.strip()
    ]
    category = CATEGORY_NAMES.get(category_slug, category_slug)
    if not category and len(breadcrumb_parts) >= 2:
        breadcrumb_category = breadcrumb_parts[-2]
        if breadcrumb_category and breadcrumb_category != "移民项目":
            category = (
                "中国香港"
                if breadcrumb_category in {"香港", "香港地区"}
                else breadcrumb_category
            )

    summary = ""
    if top is not None:
        summary_node = first(top.xpath(".//p"))
        summary = one_line(element_text(summary_node))
    introduction = texts.get("项目介绍", "")
    condition_values = split_numbered([texts.get("申请条件", "")])
    process_text = texts.get("申请流程", "")
    process = process_steps([process_text])
    advantages = split_numbered([texts.get("项目优势", "")])
    fees = split_numbered([texts.get("费用详情", "")])
    service_features = texts.get("亨瑞优势", "")

    process_summary_values = relevant_sentences(
        [process_text, introduction], ("办理周期", "审理周期", "整体周期")
    )
    investment_requirements = relevant_sentences(
        [
            introduction,
            texts.get("申请条件", ""),
            texts.get("费用详情", ""),
            texts.get("项目优势", ""),
        ],
        (
            "投资",
            "购房",
            "购买房产",
            "基金",
            "捐款",
            "存款",
            "定存",
            "注册资本",
            "创办企业",
            "建立生意",
        ),
    )
    financial_requirements = money_sentences(
        [
            texts.get("申请条件", ""),
            texts.get("费用详情", ""),
            *investment_requirements,
        ]
    )
    investment_amount_candidates = [
        sentence
        for sentence in investment_requirements
        if MONEY_RE.search(sentence)
    ]
    investment_amount = "；".join(investment_amount_candidates[:6])
    full_source = " ".join(texts.values())
    is_investment = bool(
        re.search(r"投资|购房|基金|捐赠|捐款|存款|企业家|创业", project_name)
        or investment_amount_candidates
    )
    residence_values = relevant_sentences(
        [
            texts.get("申请条件", ""),
            texts.get("项目优势", ""),
            introduction,
        ],
        ("居住要求", "移民监", "居住在", "居住时间"),
    )
    image_urls = []
    for src in body.xpath(".//img/@src"):
        value = urljoin(BASE_URL, src)
        if value not in image_urls:
            image_urls.append(value)

    return {
        "company_name": "亨瑞集团（亨瑞移民）",
        "source_domain": "visa800.com",
        "scrape_status": "ok",
        "error": "",
        "requested_url": requested_url,
        "source_url": final_url,
        "http_status": http_status,
        "discovery_sources": discovery_sources,
        "project_id": project_id,
        "project_name": project_name,
        "category": category,
        "category_slug": category_slug,
        "breadcrumb": breadcrumb_parts,
        "introduction_summary": summary,
        "introduction": introduction,
        "is_investment_project": is_investment,
        "investment_amount": investment_amount,
        "investment_requirements": investment_requirements,
        "financial_requirements": financial_requirements,
        "fees": fees,
        "advantages": advantages,
        "advantages_text": texts.get("项目优势", ""),
        "application_conditions": condition_values,
        "application_conditions_text": texts.get("申请条件", ""),
        "process_summary": "；".join(process_summary_values),
        "process_source_type": "html_text" if process_text else "missing",
        "process_text": process_text,
        "process_image_urls": [],
        "application_process": process,
        "handling_process": process,
        "identity_type": infer_identity_type(project_name, full_source),
        "residence_requirement": "；".join(residence_values),
        "service_features": service_features,
        "image_urls": image_urls,
        "raw_sections": texts,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
    }


def deduplicate_records(
    records: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    seen: dict[str, dict[str, Any]] = {}
    excluded: list[dict[str, Any]] = []
    for record in records:
        if record.get("scrape_status") != "ok":
            excluded.append(record)
            continue
        key = record.get("project_id") or record["project_name"]
        if key in seen:
            excluded.append(
                {
                    "project_name": record["project_name"],
                    "kept_url": seen[key]["source_url"],
                    "dropped_url": record["source_url"],
                }
            )
            continue
        seen[key] = record
    return list(seen.values()), excluded


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
        "fees",
        "advantages",
        "application_conditions",
        "process_summary",
        "process_source_type",
        "process_text",
        "application_process",
        "handling_process",
        "identity_type",
        "residence_requirement",
        "service_features",
        "http_status",
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
        "# 亨瑞移民官网项目清单",
        "",
        f"共采集 {len(records)} 个有效项目，并按官网国家/地区整理。",
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
        "company_name": "亨瑞集团（亨瑞移民）",
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
        "missing_process_count": sum(
            1
            for record in records
            if record.get("process_source_type") == "missing"
        ),
        "http_500_with_valid_project_body_count": sum(
            1 for record in records if record.get("http_status") == 500
        ),
        "categories": dict(sorted(categories.items())),
        "missing_by_field": {
            "introduction": [
                record["project_name"]
                for record in records
                if not record.get("introduction")
            ],
            "advantages": [
                record["project_name"]
                for record in records
                if not record.get("advantages")
            ],
            "application_conditions": [
                record["project_name"]
                for record in records
                if not record.get("application_conditions")
            ],
            "application_or_handling_process": [
                record["project_name"]
                for record in records
                if not record.get("process_text")
            ],
        },
        "excluded_or_error_records": excluded,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    write_json(path, summary)


def fixture_pages(
    directory: Path,
) -> list[tuple[str, bytes, str, int, list[str]]]:
    pages: list[tuple[str, bytes, str, int, list[str]]] = []
    for path in sorted(directory.glob("*.html")):
        if not path.stem.isdigit():
            continue
        data = path.read_bytes()
        document = parse_document(data)
        breadcrumb = one_line(
            element_text(
                first(
                    document.xpath(
                        '//section[contains(concat(" ", normalize-space(@class), '
                        '" "), " ymxm_xq_top ")]//h3'
                    )
                )
            )
        )
        category_slug = ""
        for slug, category in CATEGORY_NAMES.items():
            if category in breadcrumb or (
                category == "中国香港" and "香港" in breadcrumb
            ):
                category_slug = slug
                break
        url = f"{BASE_URL}/ymxm/{category_slug or 'fixture'}/{path.stem}.html"
        pages.append((url, data, url, 500, ["fixture"]))
    return pages


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.fixture_dir:
        pages = fixture_pages(Path(args.fixture_dir).expanduser().resolve())
        candidates = [page[0] for page in pages]
        print(f"离线读取 {len(pages)} 个项目样本")
    else:
        candidates, source_map = discover_project_urls(args.urls)
        if args.limit > 0:
            candidates = candidates[: args.limit]
        pages = []
        print(f"发现 {len(candidates)} 个当前公开项目")

    raw_records: list[dict[str, Any]] = []
    if args.fixture_dir:
        for url, data, final_url, status, sources in pages:
            raw_records.append(
                scrape_project(data, url, final_url, status, sources)
            )
    else:
        for index, url in enumerate(candidates, start=1):
            print(f"[{index}/{len(candidates)}] {url}", flush=True)
            try:
                data, final_url, status = http_get(url)
                record = scrape_project(
                    data,
                    requested_url=url,
                    final_url=final_url,
                    http_status=status,
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
    write_json(output_dir / "visa800_projects.json", records)
    write_csv(output_dir / "visa800_projects.csv", records)
    write_overview(output_dir / "visa800_projects_overview.md", records)
    write_summary(
        output_dir / "summary.json",
        records,
        candidates,
        excluded,
    )
    print(
        f"完成：有效项目 {len(records)}/{len(candidates)}；"
        f"排除或错误 {len(excluded)}"
    )
    print(f"输出目录：{output_dir}")
    return 0 if records else 1


if __name__ == "__main__":
    raise SystemExit(main())
