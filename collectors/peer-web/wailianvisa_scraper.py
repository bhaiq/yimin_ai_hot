#!/usr/bin/env python3
"""抓取外联出国（wailianvisa.com）官网当前项目目录及详情。

项目发现以当前公开的 /projects 总目录为准。普通项目页是服务端生成的静态
HTML；部分重点项目使用图片型专题页。程序只访问 robots.txt 未禁止的无查询
参数页面，并保留官网以图片发布的流程、费用或专题内容链接，不做 OCR。
"""

from __future__ import annotations

import argparse
import copy
import csv
import json
import re
import time
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urljoin, urlparse

from lxml import etree, html


BASE_URL = "https://www.wailianvisa.com"
CATALOG_URL = f"{BASE_URL}/projects"
COMPANY_NAME = "外联出国（外联移民）"
USER_AGENT = (
    "WailianVisaPublicProjectResearch/1.0 "
    "(public project pages only; low-frequency)"
)
ALLOWED_SPECIALS = {
    "/specials/eb1a",
    "/specials/greece",
    "/specials/malta",
    "/specials/usaEtwoVisa",
}
COUNTRY_PREFIXES = (
    ("中国香港", "中国香港"),
    ("加拿大", "加拿大"),
    ("新加坡", "新加坡"),
    ("葡萄牙", "葡萄牙"),
    ("匈牙利", "匈牙利"),
    ("马耳他", "马耳他"),
    ("西班牙", "西班牙"),
    ("爱尔兰", "爱尔兰"),
    ("澳大利亚", "澳大利亚"),
    ("澳洲", "澳大利亚"),
    ("美国", "美国"),
    ("英国", "英国"),
    ("希腊", "希腊"),
    ("香港", "中国香港"),
    ("日本", "日本"),
)
MONEY_RE = re.compile(
    r"(?:USD|CAD|AUD|HKD|EUR|RMB|SGD|JPY|¥|￥|US\$|C\$|"
    r"A\$|€|£|\$)?\s*\d+(?:[,.]\d+)?"
    r"(?:\s*[-–—至或]\s*\d+(?:[,.]\d+)?)?\s*"
    r"(?:万|亿)?\s*(?:美元|美金|欧元|人民币|港元|港币|"
    r"加元|加币|澳元|日元|新币|新加坡元|英镑|元)"
)
INVESTMENT_WORDS = (
    "投资",
    "基金",
    "捐款",
    "捐赠",
    "购房",
    "买房",
    "房产",
    "创业",
    "企业家",
    "注册公司",
)
PROCESS_LABELS = ("申请流程", "办理流程", "移民流程")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="抓取 wailianvisa.com 当前项目总目录及详情"
    )
    parser.add_argument(
        "--output-dir",
        default="output/wailianvisa",
        help="输出目录，默认：output/wailianvisa",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.6,
        help="详情页之间等待秒数，默认：0.6",
    )
    parser.add_argument(
        "--limit",
        type=int,
        help="只处理前 N 个项目，用于验证",
    )
    parser.add_argument(
        "--fixture-dir",
        help="从离线样本目录读取 catalog.html 与详情页",
    )
    parser.add_argument(
        "--save-fixtures",
        help="联网抓取时保存原始 HTML 到指定目录",
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


def text_with_breaks(node: etree._Element | None) -> str:
    if node is None:
        return ""
    clone = copy.deepcopy(node)
    for removable in clone.xpath(".//script|.//style|.//form"):
        parent = removable.getparent()
        if parent is not None:
            parent.remove(removable)
    for br in clone.xpath(".//br"):
        br.tail = "\n" + (br.tail or "")
    for block in clone.xpath(".//p|.//li"):
        block.tail = "\n" + (block.tail or "")
    return normalize_text(clone.text_content())


def parse_document(data: bytes | str) -> html.HtmlElement:
    parser = html.HTMLParser(recover=True)
    return html.fromstring(data, parser=parser, base_url=BASE_URL)


def http_get(url: str, timeout: int = 60) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def fixture_name(url: str) -> str:
    path = urlparse(url).path.rstrip("/")
    if path == "/projects":
        return "catalog.html"
    match = re.fullmatch(r"/projects/(\d+)\.html", path)
    if match:
        return f"project-{match.group(1)}.html"
    if path.startswith("/specials/"):
        return f"special-{path.rsplit('/', 1)[-1]}.html"
    raise ValueError(f"无法为网址生成样本名：{url}")


def read_url(
    url: str,
    fixture_dir: Path | None,
    save_dir: Path | None,
) -> bytes:
    name = fixture_name(url)
    if fixture_dir is not None:
        return (fixture_dir / name).read_bytes()
    data = http_get(url)
    if save_dir is not None:
        save_dir.mkdir(parents=True, exist_ok=True)
        (save_dir / name).write_bytes(data)
    return data


def is_project_url(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.netloc not in {"www.wailianvisa.com", "wailianvisa.com"}:
        return False
    if re.fullmatch(r"/projects/\d+\.html", parsed.path):
        return True
    return parsed.path.rstrip("/") in ALLOWED_SPECIALS


def discover_catalog(data: bytes) -> list[dict[str, str]]:
    document = parse_document(data)
    items: list[dict[str, str]] = []
    seen: set[str] = set()
    for card in document.xpath(
        '//li[.//span[contains(concat(" ",normalize-space(@class)," "),'
        '" project-item-title ")]]'
    ):
        links = card.xpath(
            './/span[contains(concat(" ",normalize-space(@class)," "),'
            '" project-item-title ")]//a[@href][1]'
        )
        if not links:
            continue
        link = links[0]
        url = urljoin(BASE_URL, link.get("href"))
        if not is_project_url(url) or url in seen:
            continue
        seen.add(url)
        project_name = one_line(link.get("title") or link.text_content())
        project_type = one_line(
            card.xpath(
                'string(.//div[contains(concat(" ",normalize-space(@class),'
                '" ")," com-icon-flag ")])'
            )
        )
        summary = one_line(
            card.xpath(
                'string(.//p[contains(concat(" ",normalize-space(@class),'
                '" ")," com-line ")])'
            )
        )
        items.append(
            {
                "project_name": project_name,
                "project_type": project_type,
                "catalog_summary": summary,
                "source_url": url,
            }
        )
    return items


def country_from_name(project_name: str) -> str:
    for prefix, country in COUNTRY_PREFIXES:
        if project_name.startswith(prefix):
            return country
    return "未分类"


def first_heading(
    document: html.HtmlElement,
    labels: Iterable[str],
) -> etree._Element | None:
    wanted = tuple(labels)
    for heading in document.xpath(
        "//*[self::h2 or self::h3 or self::h4 or self::h5]"
    ):
        text = one_line(heading.text_content())
        if any(
            text == label
            or text.startswith(f"{label}（")
            or text.startswith(f"{label}(")
            or text.startswith(f"{label}：")
            for label in wanted
        ):
            return heading
    return None


def section_images(
    heading: etree._Element | None,
    base_url: str,
) -> list[str]:
    if heading is None:
        return []
    result: list[str] = []
    for image in heading.getparent().xpath(".//img[@src]"):
        url = urljoin(base_url, image.get("src"))
        if url not in result:
            result.append(url)
    return result


def introduction_from_page(document: html.HtmlElement) -> str:
    heading = first_heading(document, ("项目简介",))
    if heading is None:
        return ""
    paragraphs = heading.xpath("following-sibling::p[1]")
    if paragraphs:
        return normalize_text(text_with_breaks(paragraphs[0]))
    parent = copy.deepcopy(heading.getparent())
    for child in parent.xpath(
        './/h4|.//img|.//*[contains(@class,"swiper")]'
    ):
        child_parent = child.getparent()
        if child_parent is not None:
            child_parent.remove(child)
    return normalize_text(text_with_breaks(parent))


def advantages_from_page(document: html.HtmlElement) -> list[str]:
    heading = first_heading(document, ("项目优势",))
    if heading is None:
        return []
    result: list[str] = []
    for number in heading.getparent().xpath(
        './/div[contains(concat(" ",normalize-space(@class)," "),'
        '" project-adv ")]'
    ):
        container = copy.deepcopy(number.getparent())
        number_nodes = container.xpath(
            './/div[contains(concat(" ",normalize-space(@class)," "),'
            '" project-adv ")]'
        )
        for node in number_nodes:
            parent = node.getparent()
            if parent is not None:
                parent.remove(node)
        text = one_line(text_with_breaks(container))
        if text and text not in result:
            result.append(text)
    return result


def conditions_from_page(document: html.HtmlElement) -> list[str]:
    heading = first_heading(document, ("申请条件",))
    if heading is None:
        heading = first_heading(
            document, ("申请资格", "适用人群", "特殊要求")
        )
    if heading is None:
        return []
    result: list[str] = []
    for node in heading.getparent().xpath(
        './/*[contains(concat(" ",normalize-space(@class)," "),'
        '" project-adv-wd ")]'
    ):
        text = one_line(text_with_breaks(node))
        if text and text not in result:
            result.append(text)
    if result:
        return result
    container = heading.getparent()
    candidates = container.xpath(
        ".//li[not(.//li)] | .//p[not(ancestor::li)]"
    )
    for node in candidates:
        text = one_line(text_with_breaks(node)).strip("•· ")
        if (
            text
            and text != one_line(heading.text_content())
            and text not in result
        ):
            result.append(text)
    return result


def plain_section_text(heading: etree._Element | None) -> str:
    if heading is None:
        return ""
    container = copy.deepcopy(heading.getparent())
    for node in container.xpath(".//h2|.//h3|.//h4|.//h5|.//img|.//a"):
        parent = node.getparent()
        if parent is not None:
            parent.remove(node)
    values: list[str] = []
    for line in normalize_text(text_with_breaks(container)).splitlines():
        line = one_line(line)
        if line and not re.fullmatch(r"\d{1,2}", line):
            values.append(line)
    return normalize_text("\n".join(values))


def split_steps(value: str) -> list[dict[str, Any]]:
    lines = [
        one_line(line).strip("；; ")
        for line in normalize_text(value).splitlines()
        if one_line(line)
    ]
    return [
        {
            "number": index,
            "stage": line[:100],
            "details": line,
            "raw_text": line,
        }
        for index, line in enumerate(lines, start=1)
    ]


def relevant_sentences(
    values: Iterable[str],
    keywords: tuple[str, ...],
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
    extra = (
        "净资产",
        "资产要求",
        "资金要求",
        "投资额",
        "项目费用",
        "服务费",
        "费用",
    )
    for value in values:
        for sentence in re.split(r"[。；;\n]+", normalize_text(value)):
            sentence = one_line(sentence).strip("，, ")
            if (
                sentence
                and (MONEY_RE.search(sentence) or any(x in sentence for x in extra))
                and sentence not in result
            ):
                result.append(sentence)
    return result


def infer_identity_type(project_name: str, source: str) -> str:
    text = f"{project_name} {source}"
    if re.search(r"护照|公民|入籍", text):
        return "公民身份"
    if re.search(r"永居|永久居民|永久居留|绿卡|枫叶卡", text):
        return "永久居留"
    if re.search(r"签证|工签|工作准证|EP|高才", text, re.IGNORECASE):
        return "签证/居留身份"
    return "居留身份"


def status_note(source: str) -> str:
    text = one_line(source)
    for keyword in ("已暂停", "停止接受", "不再接受", "已关闭", "关停"):
        if keyword not in text:
            continue
        sentence = next(
            (
                item
                for item in re.split(r"[。；;]", text)
                if keyword in item
            ),
            text,
        )
        return f"官网内容提及：{one_line(sentence)[:220]}"
    return ""


def special_content_images(
    document: html.HtmlElement,
    source_url: str,
) -> list[str]:
    result: list[str] = []
    for image in document.xpath("//img[@src]"):
        raw = image.get("src", "")
        if (
            "/PMarketing/Article/" not in raw
            and "/subject/" not in raw
        ):
            continue
        url = urljoin(source_url, raw)
        if url not in result:
            result.append(url)
    return result


def build_record(
    item: dict[str, str],
    data: bytes | None,
    error: str = "",
) -> dict[str, Any]:
    name = item["project_name"]
    category = country_from_name(name)
    source_url = item["source_url"]
    summary = item["catalog_summary"]
    project_type = item["project_type"]
    is_special = urlparse(source_url).path.rstrip("/") in ALLOWED_SPECIALS

    introduction = summary
    advantages: list[str] = []
    conditions: list[str] = []
    fees: list[str] = []
    fee_image_urls: list[str] = []
    process_text = ""
    process_image_urls: list[str] = []
    content_images: list[str] = []
    source_granularity = "catalog_summary"

    if data:
        document = parse_document(data)
        if is_special:
            content_images = special_content_images(document, source_url)
            process_image_urls = list(content_images)
            source_granularity = "image_special_page"
        else:
            page_intro = introduction_from_page(document)
            introduction = page_intro or summary
            advantages = advantages_from_page(document)
            conditions = conditions_from_page(document)
            process_heading = first_heading(document, PROCESS_LABELS)
            process_text = plain_section_text(process_heading)
            process_image_urls = section_images(
                process_heading, source_url
            )
            fee_heading = first_heading(
                document, ("申请费用", "项目费用")
            )
            fee_text = plain_section_text(fee_heading)
            fees = [
                one_line(line)
                for line in normalize_text(fee_text).splitlines()
                if one_line(line)
            ]
            fee_image_urls = section_images(fee_heading, source_url)
            source_granularity = "standard_detail"

    source_values = [
        introduction,
        summary,
        *advantages,
        *conditions,
        *fees,
    ]
    investment_requirements = relevant_sentences(
        [introduction, summary, *conditions],
        INVESTMENT_WORDS,
    )
    financial_requirements = money_sentences(source_values)
    investment_amounts = [
        value
        for value in financial_requirements
        if any(word in value for word in INVESTMENT_WORDS)
        or "资产" in value
    ]
    is_investment = project_type in {"投资移民", "海外投资"} or any(
        word in name for word in INVESTMENT_WORDS
    )
    process_steps = split_steps(process_text)
    if process_steps:
        process_type = "html_text"
        process_summary = one_line(process_text)
    elif process_image_urls:
        process_type = "image_only"
        process_summary = (
            "官网专题内容以图片形式发布，可能包含流程信息。"
            if is_special
            else "官网申请流程以图片形式发布。"
        )
    else:
        process_type = "missing"
        process_summary = ""
    residence = relevant_sentences(
        [introduction, summary, *advantages, *conditions],
        ("居住", "移民监", "登陆", "入境", "续签", "停留"),
    )
    combined = " ".join(source_values)
    project_id = (
        re.search(r"/projects/(\d+)\.html", source_url).group(1)
        if "/projects/" in source_url
        else urlparse(source_url).path.rsplit("/", 1)[-1]
    )
    return {
        "scrape_status": "ok",
        "detail_fetch_status": "failed" if error else "ok",
        "detail_fetch_error": error,
        "company_name": COMPANY_NAME,
        "source_domain": "wailianvisa.com",
        "project_name": name,
        "navigation_label": name,
        "category": category,
        "project_type": project_type,
        "project_id": project_id,
        "source_granularity": source_granularity,
        "website_status_note": status_note(combined),
        "is_investment_project": is_investment,
        "source_url": source_url,
        "introduction_summary": one_line(introduction)[:240],
        "introduction": introduction,
        "investment_amount": "；".join(investment_amounts[:4]),
        "investment_requirements": investment_requirements,
        "financial_requirements": financial_requirements,
        "fees": fees,
        "fee_image_urls": fee_image_urls,
        "advantages": advantages,
        "application_conditions": conditions,
        "process_summary": process_summary,
        "process_source_type": process_type,
        "process_text": process_text,
        "process_image_urls": process_image_urls,
        "application_process": process_steps,
        "handling_process": process_steps,
        "identity_type": infer_identity_type(name, combined),
        "residence_requirement": "；".join(residence),
        "extra_sections": {
            "catalog_summary": summary,
            "special_page_content_image_urls": content_images,
            "image_content_note": (
                "专题页主体内容以图片形式发布，未自动 OCR。"
                if is_special
                else ""
            ),
        },
        "scraped_at": datetime.now(timezone.utc).isoformat(),
    }


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
        "project_type",
        "project_id",
        "source_granularity",
        "website_status_note",
        "is_investment_project",
        "source_url",
        "introduction_summary",
        "introduction",
        "investment_amount",
        "investment_requirements",
        "financial_requirements",
        "fees",
        "fee_image_urls",
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
        "extra_sections",
        "detail_fetch_status",
        "detail_fetch_error",
        "scraped_at",
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(
            handle, fieldnames=fields, extrasaction="ignore"
        )
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
        grouped[record["category"]].append(record)
    lines = [
        "# 外联出国官网项目清单",
        "",
        f"当前项目总目录共展示 {len(records)} 个项目。",
        "",
    ]
    for category, items in sorted(grouped.items()):
        lines.extend([f"## {category}（{len(items)}）", ""])
        for item in sorted(items, key=lambda row: row["project_name"]):
            notes = [item["project_type"]]
            if item["source_granularity"] == "image_special_page":
                notes.append("图片型专题页")
            if item["process_source_type"] == "image_only":
                notes.append("流程/专题内容为图片")
            elif item["process_source_type"] == "missing":
                notes.append("官网未公开流程")
            if item.get("website_status_note"):
                notes.append(item["website_status_note"])
            lines.append(
                f"- [{item['project_name']}]({item['source_url']})"
                f"（{'；'.join(notes)}）"
            )
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def write_summary(
    path: Path,
    records: list[dict[str, Any]],
    failures: list[dict[str, str]],
) -> None:
    categories: dict[str, int] = defaultdict(int)
    project_types: dict[str, int] = defaultdict(int)
    for record in records:
        categories[record["category"]] += 1
        project_types[record["project_type"]] += 1
    summary = {
        "company_name": COMPANY_NAME,
        "source": BASE_URL,
        "catalog_url": CATALOG_URL,
        "catalog_project_count": len(records),
        "standard_detail_count": sum(
            x["source_granularity"] == "standard_detail"
            for x in records
        ),
        "image_special_page_count": sum(
            x["source_granularity"] == "image_special_page"
            for x in records
        ),
        "investment_project_count": sum(
            x["is_investment_project"] for x in records
        ),
        "html_process_count": sum(
            x["process_source_type"] == "html_text" for x in records
        ),
        "image_only_process_count": sum(
            x["process_source_type"] == "image_only" for x in records
        ),
        "missing_process_count": sum(
            x["process_source_type"] == "missing" for x in records
        ),
        "categories": dict(sorted(categories.items())),
        "project_types": dict(sorted(project_types.items())),
        "detail_fetch_failures": failures,
        "website_status_notes": [
            {
                "project_name": x["project_name"],
                "source_url": x["source_url"],
                "note": x["website_status_note"],
            }
            for x in records
            if x.get("website_status_note")
        ],
        "missing_by_field": {
            "introduction": [
                x["project_name"] for x in records if not x["introduction"]
            ],
            "advantages": [
                x["project_name"] for x in records if not x["advantages"]
            ],
            "application_conditions": [
                x["project_name"]
                for x in records
                if not x["application_conditions"]
            ],
            "application_or_handling_process": [
                x["project_name"]
                for x in records
                if x["process_source_type"] == "missing"
            ],
        },
        "notes": [
            "项目发现以当前 /projects 总目录为准；sitemap 未覆盖部分新项目。",
            "robots.txt 禁止查询参数页面，程序只访问无查询参数的公开目录和详情页。",
            "普通详情页的申请流程、费用经常以图片发布；图片链接保留但不自动 OCR。",
            "四个重点项目为图片型专题页，文本字段以项目总目录摘要为保底。",
            "官网仍展示不代表相关政策当前开放，数据未作法律状态校验。",
        ],
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    write_json(path, summary)


def main() -> int:
    args = parse_args()
    fixture_dir = (
        Path(args.fixture_dir).expanduser().resolve()
        if args.fixture_dir
        else None
    )
    save_dir = (
        Path(args.save_fixtures).expanduser().resolve()
        if args.save_fixtures
        else None
    )
    catalog_data = read_url(
        CATALOG_URL, fixture_dir, save_dir
    )
    items = discover_catalog(catalog_data)
    if args.limit is not None:
        items = items[: max(args.limit, 0)]
    print(f"项目总目录发现 {len(items)} 个项目")

    records: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    for index, item in enumerate(items, start=1):
        print(
            f"[{index}/{len(items)}] {item['project_name']}",
            flush=True,
        )
        data: bytes | None = None
        error = ""
        try:
            data = read_url(
                item["source_url"], fixture_dir, save_dir
            )
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            failures.append(
                {
                    "project_name": item["project_name"],
                    "source_url": item["source_url"],
                    "error": error,
                }
            )
        records.append(build_record(item, data, error))
        if (
            fixture_dir is None
            and args.delay > 0
            and index < len(items)
        ):
            time.sleep(args.delay)

    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    write_json(output_dir / "wailianvisa_projects.json", records)
    write_csv(output_dir / "wailianvisa_projects.csv", records)
    write_overview(
        output_dir / "wailianvisa_projects_overview.md",
        records,
    )
    write_summary(output_dir / "summary.json", records, failures)
    print(
        f"完成：项目 {len(records)}；详情失败 {len(failures)}；"
        f"输出目录 {output_dir}"
    )
    return 0 if records and not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
