#!/usr/bin/env python3
"""抓取世贸通移民（worldwayhk.com）官网公开展示的移民项目。

该站前置阿里云浏览器校验，普通 HTTP 客户端只会取得验证脚本。因此程序使用
Playwright 访问公开的国家入口页和项目详情页，并以低频顺序采集。流程若只以
图片发布，程序保留图片链接并标记为 image_only，不自动下载或 OCR。
"""

from __future__ import annotations

import argparse
import copy
import csv
import json
import re
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urljoin, urlparse

from lxml import etree, html


BASE_URL = "https://www.worldwayhk.com"
HOME_URL = f"{BASE_URL}/"
COMPANY_NAME = "世贸通集团（世贸通移民）"
PROJECT_RE = re.compile(r"^/newproject(?P<id>\d+)\.html$")
COUNTRY_RE = re.compile(r"^/country/(?P<slug>[a-z]+)\.html$")
COUNTRY_NAMES = {
    "us": "美国",
    "ca": "加拿大",
    "pa": "巴拿马",
    "pt": "葡萄牙",
    "mt": "马耳他",
    "cy": "塞浦路斯",
    "gr": "希腊",
    "hu": "匈牙利",
    "tr": "土耳其",
    "es": "西班牙",
    "ie": "爱尔兰",
    "nr": "瑙鲁",
    "lc": "圣卢西亚",
    "kn": "圣基茨和尼维斯",
    "st": "圣多美和普林西比",
    "vu": "瓦努阿图",
    "dm": "多米尼克",
    "ag": "安提瓜和巴布达",
    "gd": "格林纳达",
    "hk": "中国香港",
    "jp": "日本",
    "kr": "韩国",
    "au": "澳大利亚",
}
INVESTMENT_KEYWORDS = (
    "投资",
    "购房",
    "房产",
    "基金",
    "捐款",
    "捐赠",
    "存款",
    "资本",
    "国债",
    "债券",
)
MONEY_RE = re.compile(
    r"(?:USD|CAD|HKD|EUR|RMB|¥|￥|US\$|C\$|€|£|\$)?\s*"
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
        description="抓取 worldwayhk.com 当前公开展示的移民项目"
    )
    parser.add_argument(
        "--output-dir",
        default="output/worldwayhk",
        help="输出目录，默认：output/worldwayhk",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.8,
        help="页面之间的等待秒数，默认：0.8",
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
        "--headed",
        action="store_true",
        help="显示浏览器窗口；防护拦截无头浏览器时使用",
    )
    parser.add_argument(
        "--chrome-path",
        help="指定 Chrome/Chromium 可执行文件",
    )
    parser.add_argument(
        "--fixture-dir",
        help="从目录中的项目 ID.html 读取样本，用于离线解析",
    )
    parser.add_argument(
        "--country-fixture-dir",
        help="从目录中的国家 slug.html 恢复项目所属国家",
    )
    return parser.parse_args()


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


def element_text_with_breaks(node: etree._Element | None) -> str:
    if node is None:
        return ""
    clone = copy.deepcopy(node)
    for removable in clone.xpath(
        './/*[contains(concat(" ", normalize-space(@class), " "), '
        '" editorial-cta ")]'
    ):
        parent = removable.getparent()
        if parent is not None:
            parent.remove(removable)
    for br in clone.xpath(".//br"):
        br.tail = "\n" + (br.tail or "")
    for block in clone.xpath(".//p|.//li|.//div|.//h3|.//h4"):
        block.tail = "\n" + (block.tail or "")
    return normalize_text(clone.text_content())


def parse_document(data: bytes | str) -> html.HtmlElement:
    parser = html.HTMLParser(recover=True)
    return html.fromstring(data, parser=parser, base_url=BASE_URL)


def normalize_project_url(value: str) -> str | None:
    url = urljoin(BASE_URL, value.strip())
    parsed = urlparse(url)
    if parsed.netloc.lower() not in {
        "worldwayhk.com",
        "www.worldwayhk.com",
    }:
        return None
    if not PROJECT_RE.fullmatch(parsed.path):
        return None
    return f"{BASE_URL}{parsed.path}"


def normalize_country_url(value: str) -> str | None:
    url = urljoin(BASE_URL, value.strip())
    parsed = urlparse(url)
    if parsed.netloc.lower() not in {
        "worldwayhk.com",
        "www.worldwayhk.com",
    }:
        return None
    if not COUNTRY_RE.fullmatch(parsed.path):
        return None
    return f"{BASE_URL}{parsed.path}"


def project_id(url: str) -> str:
    match = PROJECT_RE.fullmatch(urlparse(url).path)
    return match.group("id") if match else ""


def split_items(values: Iterable[str]) -> list[str]:
    result: list[str] = []
    for value in values:
        text = normalize_text(value)
        if not text:
            continue
        pieces: list[str] = []
        for line in text.splitlines():
            line = one_line(line).strip("；; ")
            if not line:
                continue
            chunks = [
                one_line(part).strip("；; ")
                for part in NUMBERED_SPLIT_RE.split(line)
                if one_line(part)
            ]
            pieces.extend(chunks or [line])
        if not pieces:
            pieces = [one_line(text)]
        for piece in pieces:
            if piece and piece not in result:
                result.append(piece)
    return result


def section_items(node: etree._Element | None) -> list[str]:
    if node is None:
        return []
    list_nodes = node.xpath(".//li")
    if list_nodes:
        values = [element_text_with_breaks(item) for item in list_nodes]
        items = split_items(values)
        if items:
            return items
    return split_items([element_text_with_breaks(node)])


def extract_sections(
    document: html.HtmlElement,
) -> tuple[dict[str, str], dict[str, list[str]], dict[str, list[str]]]:
    texts: dict[str, str] = {}
    items: dict[str, list[str]] = {}
    images: dict[str, list[str]] = {}
    articles = document.xpath(
        '//article[contains(concat(" ", normalize-space(@class), " "), '
        '" editorial-section-item ")]'
    )
    for article in articles:
        title_nodes = article.xpath(
            './/*[contains(concat(" ", normalize-space(@class), " "), '
            '" section-title ")]'
        )
        body_nodes = article.xpath(
            './/*[contains(concat(" ", normalize-space(@class), " "), '
            '" editorial-body ")]'
        )
        if not title_nodes or not body_nodes:
            continue
        label = one_line(title_nodes[0].text_content()).strip("：: ")
        label = re.sub(r"^\d{1,2}\s*", "", label)
        body = body_nodes[0]
        text = element_text_with_breaks(body)
        image_urls: list[str] = []
        for src in body.xpath(".//img/@src"):
            url = urljoin(BASE_URL, src.strip())
            if url and url not in image_urls:
                image_urls.append(url)
        texts[label] = text
        items[label] = section_items(body)
        images[label] = image_urls
    return texts, items, images


def title_from_document(document: html.HtmlElement) -> str:
    value = one_line(document.xpath("string(//title)"))
    value = re.sub(r"\s*[-_|]\s*世贸通移民.*$", "", value)
    return value.strip()


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
    extra_keywords = (
        "净资产",
        "资产证明",
        "资金证明",
        "定居资金",
        "年收入",
        "营业额",
        "注册资本",
        "投资款",
        "申请费",
        "服务费",
        "费用",
    )
    for value in values:
        for sentence in re.split(r"[。；;\n]+", normalize_text(value)):
            sentence = one_line(sentence).strip("，, ")
            if (
                sentence
                and (
                    MONEY_RE.search(sentence)
                    or any(keyword in sentence for keyword in extra_keywords)
                )
                and sentence not in result
            ):
                result.append(sentence)
    return result


def positive_investment_sentences(values: Iterable[str]) -> list[str]:
    candidates = relevant_sentences(values, INVESTMENT_KEYWORDS)
    negative_re = re.compile(
        r"(?:无需|无须|不用|不需要|没有|免于|关闭|取消)"
        r"[^。；;，,]{0,12}(?:投资|购房|存款|捐款|基金)|"
        r"(?:投资|购房|存款|捐款|基金)"
        r"[^。；;，,]{0,12}(?:无需|无须|关闭|取消)"
    )
    return [
        sentence
        for sentence in candidates
        if not negative_re.search(sentence)
    ]


def process_steps(values: Iterable[str]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for piece in split_items(values):
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


def infer_identity_type(project_name: str, source: str) -> str:
    text = f"{project_name} {source}"
    if re.search(r"护照|公民|入籍", text):
        return "公民身份"
    if re.search(r"永居|永久居留|绿卡|枫叶卡", text):
        return "永久居留"
    if re.search(r"签证|高才|居留许可", text):
        return "签证/居留身份"
    return "居留身份"


def find_section(
    values: dict[str, Any], labels: tuple[str, ...]
) -> Any:
    for label in labels:
        if label in values:
            return values[label]
    return "" if values and isinstance(next(iter(values.values())), str) else []


def scrape_project(
    data: bytes | str,
    requested_url: str,
    category: str,
    discovery_sources: list[str],
) -> dict[str, Any]:
    document = parse_document(data)
    name = title_from_document(document)
    texts, item_map, image_map = extract_sections(document)
    required = {"项目简介", "项目优势", "申请条件", "申请流程"}
    present = required.intersection(texts)
    if len(present) < 3:
        return {
            "scrape_status": "excluded",
            "exclusion_reason": "公开页面不是当前统一项目模板",
            "project_name": name,
            "category": category,
            "requested_url": requested_url,
            "source_url": requested_url,
            "section_titles": list(texts),
            "discovery_sources": discovery_sources,
        }

    introduction = find_section(texts, ("项目简介", "项目介绍"))
    advantages = find_section(item_map, ("项目优势", "优势"))
    conditions = find_section(item_map, ("申请条件",))
    process_text = find_section(texts, ("申请流程", "办理流程"))
    process_images = find_section(image_map, ("申请流程", "办理流程"))
    service_features = find_section(
        item_map, ("世贸通专业加持", "世贸通优势")
    )
    country_intro = find_section(texts, ("国家介绍", "地区介绍"))

    if one_line(process_text) == one_line(name):
        process_text = ""
    application_process = process_steps([process_text]) if process_text else []
    if process_text:
        process_source_type = "html_text"
        process_summary = one_line(process_text)
    elif process_images:
        process_source_type = "image_only"
        process_summary = "官网申请流程仅以图片形式发布，已保留原图链接。"
    else:
        process_source_type = "missing"
        process_summary = ""

    source_values = [
        introduction,
        *advantages,
        *conditions,
        process_text,
    ]
    combined = " ".join(source_values)
    investment_requirements = positive_investment_sentences(
        [introduction, *conditions],
    )
    financial_requirements = money_sentences(
        [introduction, *conditions, *investment_requirements]
    )
    title_has_investment = any(
        keyword in name for keyword in INVESTMENT_KEYWORDS
    )
    business_management_route = "经营管理" in name
    explicitly_non_investment_route = bool(
        re.search(
            r"高才通|EB-1A|NIW|非盈利居留|国家创新签证",
            name,
            re.IGNORECASE,
        )
    )
    is_investment = not explicitly_non_investment_route and (
        title_has_investment
        or business_management_route
        or bool(investment_requirements)
    )
    investment_amount_candidates = [
        sentence
        for sentence in financial_requirements
        if any(keyword in sentence for keyword in INVESTMENT_KEYWORDS)
    ]
    investment_amount = "；".join(investment_amount_candidates[:4])
    fees = relevant_sentences(
        [introduction, *conditions],
        ("费用", "申请费", "服务费", "管理费", "律师费"),
    )
    residence_values = relevant_sentences(
        [introduction, *advantages, *conditions],
        ("居住", "移民监", "登陆", "入境", "续签", "停留"),
    )
    residence_requirement = "；".join(residence_values)
    timestamp = datetime.now(timezone.utc).isoformat()

    return {
        "scrape_status": "ok",
        "company_name": COMPANY_NAME,
        "source_domain": "worldwayhk.com",
        "project_name": name,
        "category": category,
        "project_id": project_id(requested_url),
        "is_investment_project": is_investment,
        "source_url": requested_url,
        "requested_url": requested_url,
        "introduction_summary": one_line(introduction)[:240],
        "introduction": introduction,
        "country_or_region_introduction": country_intro,
        "investment_amount": investment_amount,
        "investment_requirements": investment_requirements,
        "financial_requirements": financial_requirements,
        "fees": fees,
        "advantages": advantages,
        "application_conditions": conditions,
        "process_summary": process_summary,
        "process_source_type": process_source_type,
        "process_text": process_text,
        "process_image_urls": process_images,
        "application_process": application_process,
        "handling_process": application_process,
        "identity_type": infer_identity_type(name, combined),
        "residence_requirement": residence_requirement,
        "service_features": service_features,
        "raw_sections": texts,
        "raw_section_items": item_map,
        "section_image_urls": image_map,
        "discovery_sources": discovery_sources,
        "scraped_at": timestamp,
    }


def resolve_chrome_path(value: str | None) -> str | None:
    if value:
        path = Path(value).expanduser()
        if not path.exists():
            raise FileNotFoundError(f"浏览器不存在：{path}")
        return str(path)
    candidates = (
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    )
    for candidate in candidates:
        if Path(candidate).exists():
            return candidate
    return None


def wait_for_real_page(page: Any, expected_pattern: str) -> str:
    for _ in range(15):
        content = page.content()
        if re.search(expected_pattern, content):
            return content
        page.wait_for_timeout(1000)
    raise RuntimeError("浏览器校验未通过或页面模板未加载")


def live_pages(
    args: argparse.Namespace,
) -> tuple[list[tuple[str, str, str, list[str]]], list[str]]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise RuntimeError(
            "缺少 Playwright，请先执行：pip install -r requirements.txt"
        ) from exc

    explicit = []
    for value in args.urls or []:
        normalized = normalize_project_url(value)
        if normalized and normalized not in explicit:
            explicit.append(normalized)

    results: list[tuple[str, str, str, list[str]]] = []
    candidates: list[str] = []
    with sync_playwright() as playwright:
        launch_options: dict[str, Any] = {"headless": not args.headed}
        executable = resolve_chrome_path(args.chrome_path)
        if executable:
            launch_options["executable_path"] = executable
        browser = playwright.chromium.launch(**launch_options)
        context = browser.new_context(
            locale="zh-CN",
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/138.0.0.0 Safari/537.36"
            ),
        )
        page = context.new_page()
        category_map: dict[str, str] = {}
        source_map: dict[str, list[str]] = defaultdict(list)
        if explicit:
            candidates = explicit
        else:
            page.goto(HOME_URL, wait_until="domcontentloaded", timeout=60_000)
            homepage = wait_for_real_page(page, r"/country/[a-z]+\.html")
            home_document = parse_document(homepage)
            country_urls: list[str] = []
            for href in home_document.xpath("//a/@href"):
                url = normalize_country_url(href)
                if url and url not in country_urls:
                    country_urls.append(url)
            for index, country_url in enumerate(country_urls, start=1):
                print(
                    f"[国家 {index}/{len(country_urls)}] {country_url}",
                    flush=True,
                )
                page.goto(
                    country_url,
                    wait_until="domcontentloaded",
                    timeout=60_000,
                )
                content = wait_for_real_page(page, r"/newproject\d+\.html")
                document = parse_document(content)
                match = COUNTRY_RE.fullmatch(urlparse(country_url).path)
                slug = match.group("slug") if match else ""
                category = COUNTRY_NAMES.get(slug, slug)
                for href in document.xpath("//a/@href"):
                    project_url = normalize_project_url(href)
                    if not project_url:
                        continue
                    category_map.setdefault(project_url, category)
                    if country_url not in source_map[project_url]:
                        source_map[project_url].append(country_url)
                    if project_url not in candidates:
                        candidates.append(project_url)
                if args.delay > 0 and index < len(country_urls):
                    time.sleep(args.delay)

        if args.limit > 0:
            candidates = candidates[: args.limit]
        for index, url in enumerate(candidates, start=1):
            print(f"[项目 {index}/{len(candidates)}] {url}", flush=True)
            page.goto(url, wait_until="domcontentloaded", timeout=60_000)
            content = wait_for_real_page(
                page, r"editorial-section-item|section-title"
            )
            results.append(
                (
                    url,
                    content,
                    category_map.get(url, ""),
                    source_map.get(url, ["explicit"]),
                )
            )
            if args.delay > 0 and index < len(candidates):
                time.sleep(args.delay)
        context.close()
        browser.close()
    return results, candidates


def fixture_category_map(directory: Path | None) -> dict[str, str]:
    result: dict[str, str] = {}
    if directory is None:
        return result
    for path in sorted(directory.glob("*.html")):
        slug = path.stem.lower()
        category = COUNTRY_NAMES.get(slug, slug)
        document = parse_document(path.read_bytes())
        for href in document.xpath("//a/@href"):
            url = normalize_project_url(href)
            if url:
                result.setdefault(url, category)
    return result


def fixture_pages(
    directory: Path,
    country_directory: Path | None,
    limit: int,
) -> tuple[list[tuple[str, bytes, str, list[str]]], list[str]]:
    category_map = fixture_category_map(country_directory)
    results: list[tuple[str, bytes, str, list[str]]] = []
    candidates: list[str] = []
    for path in sorted(directory.glob("*.html")):
        if not path.stem.isdigit():
            continue
        url = f"{BASE_URL}/newproject{path.stem}.html"
        candidates.append(url)
        sources = ["fixture"]
        if url in category_map:
            sources.append(f"country:{category_map[url]}")
        results.append(
            (url, path.read_bytes(), category_map.get(url, ""), sources)
        )
        if limit > 0 and len(results) >= limit:
            break
    return results, candidates


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
        "country_or_region_introduction",
        "investment_amount",
        "investment_requirements",
        "financial_requirements",
        "fees",
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
        "service_features",
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
        "# 世贸通移民官网项目清单",
        "",
        f"共采集 {len(records)} 个当前统一项目模板页面。",
        "",
    ]
    for category, items in sorted(grouped.items()):
        lines.extend([f"## {category}（{len(items)}）", ""])
        for item in items:
            process_note = (
                "（流程为图片）"
                if item["process_source_type"] == "image_only"
                else ""
            )
            lines.append(
                f"- [{item['project_name']}]({item['source_url']})"
                f"{process_note}"
            )
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
        "company_name": COMPANY_NAME,
        "source": BASE_URL,
        "candidate_url_count": len(candidates),
        "record_count": len(records),
        "investment_project_count": sum(
            1 for record in records if record["is_investment_project"]
        ),
        "html_process_count": sum(
            1
            for record in records
            if record["process_source_type"] == "html_text"
        ),
        "image_only_process_count": sum(
            1
            for record in records
            if record["process_source_type"] == "image_only"
        ),
        "missing_process_count": sum(
            1
            for record in records
            if record["process_source_type"] == "missing"
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
                if record.get("process_source_type") == "missing"
            ],
        },
        "excluded_or_error_records": excluded,
        "notes": [
            "站点前置浏览器 JavaScript 校验，普通 HTTP 请求无法直接采集。",
            "robots.txt 受同一前置校验影响无法读取；程序仅访问前台导航可达的公开国家页和项目页。",
            "图片流程仅保留公开图片链接，不自动下载或 OCR。",
        ],
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    write_json(path, summary)


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.fixture_dir:
        fixture_dir = Path(args.fixture_dir).expanduser().resolve()
        country_dir = (
            Path(args.country_fixture_dir).expanduser().resolve()
            if args.country_fixture_dir
            else None
        )
        pages, candidates = fixture_pages(
            fixture_dir, country_dir, args.limit
        )
        print(f"离线读取 {len(pages)} 个候选详情页")
    else:
        pages, candidates = live_pages(args)
        print(f"发现 {len(candidates)} 个候选详情页")

    records: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    for url, data, category, sources in pages:
        try:
            record = scrape_project(data, url, category, sources)
        except Exception as exc:
            record = {
                "scrape_status": "error",
                "error": str(exc),
                "requested_url": url,
                "source_url": url,
                "category": category,
                "discovery_sources": sources,
            }
        if record.get("scrape_status") == "ok":
            records.append(record)
        else:
            excluded.append(record)
        print(
            f"  {record.get('scrape_status')}: "
            f"{record.get('project_name') or url}",
            flush=True,
        )

    records.sort(
        key=lambda item: (
            item.get("category", ""),
            item.get("project_name", ""),
        )
    )
    write_json(output_dir / "worldwayhk_projects.json", records)
    write_csv(output_dir / "worldwayhk_projects.csv", records)
    write_overview(output_dir / "worldwayhk_projects_overview.md", records)
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
