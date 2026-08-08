#!/usr/bin/env python3
"""抓取兆龙移民（zlglobal.net）官网当前导航展示的移民项目。

官网首页和多数专题页使用 GB2312/GBK 静态 HTML。项目由首页现行导航发现：
包括 /zt/ 专题页以及澳洲栏目的五个文章式项目页。程序按专题页和文章页两类
模板解析项目介绍、优势、条件及流程，并保留仅以图片发布的流程链接。
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


BASE_URL = "https://www.zlglobal.net"
HOME_URL = f"{BASE_URL}/"
COMPANY_NAME = "兆龙移民（兆龙出国）"
USER_AGENT = (
    "ZLGlobalPublicProjectResearch/1.0 "
    "(public project pages only; low-frequency)"
)
ARTICLE_PROJECT_RE = re.compile(
    r"/aus/zc/(?:20250514756|20250514758|20250514760|"
    r"20250514762|20250514764)\.html"
)
PROJECT_ALIASES = {
    "/zt/eb5/index.html": "美国EB-5投资移民",
    "/zt/eb1a_2/index.html": "美国EB-1A杰出人才移民",
    "/zt/niw2/index.html": "美国NIW国家利益豁免",
    "/zt/meiguoeb3/index.html": "美国EB-3技术移民",
    "/zt/ew3/index.html": "美国EW-3非技术移民",
    "/zt/eb2/index.html": "美国EB-2职业移民",
    "/zt/e2/index.html": "美国E-2投资者签证",
    "/zt/j1-visa/index.html": "美国J-1签证",
    "/zt/kstd/index.html": "美国快速绿卡通道",
    "/zt/aqyj/index.html": "加拿大阿省企业家移民",
    "/zt/sinp3/index.html": "加拿大萨省雇主担保移民",
    "/zt/kuisheng2/index.html": "加拿大魁省杰出人才移民",
    "/zt/rcip/index.html": "加拿大RCIP农村社区移民试点",
    "/zt/nbqyj/index.html": "加拿大NB省企业家移民",
    "/zt/aip/index.html": "加拿大大西洋四省雇主担保移民",
    "/zt/xila/index.html": "希腊购房移民",
    "/zt/met2/index.html": "马耳他永居移民",
    "/zt/ael/index.html": "爱尔兰投资移民",
    "/zt/xby/index.html": "西班牙投资移民",
    "/zt/yingguo": "英国全球人才签证",
    "/zt/aus/index.html": "澳洲186雇主担保移民",
    "/zt/aozhouniv/index.html": "澳洲NIV国家创新签证",
    "/zt/xinxilan2/index.html": "新西兰绿名单移民",
    "/zt/xxlliufenzhi/index.html": "新西兰六分制技术移民",
    "/zt/panama/index.html": "巴拿马投资移民",
    "/aus/zc/20250514756.html": "澳洲189独立技术移民",
    "/aus/zc/20250514758.html": "澳洲190州担保技术移民",
    "/aus/zc/20250514760.html": "澳洲491偏远地区州担保技术移民",
    "/aus/zc/20250514762.html": "澳洲482 SID雇主担保签证",
    "/aus/zc/20250514764.html": "澳洲494偏远地区雇主担保移民",
}
COUNTRY_PREFIXES = (
    ("加拿大", "加拿大"),
    ("新西兰", "新西兰"),
    ("西班牙", "西班牙"),
    ("爱尔兰", "爱尔兰"),
    ("马耳他", "马耳他"),
    ("巴拿马", "巴拿马"),
    ("澳大利亚", "澳大利亚"),
    ("澳洲", "澳大利亚"),
    ("美国", "美国"),
    ("英国", "英国"),
    ("希腊", "希腊"),
)
INTRO_CLASSES = (
    "xmgs_cont",
    "xmjs_cont",
    "xmjj_cont",
    "nbjs_lf",
    "fajj_cont",
    "zcjd_cont",
    "qzjs_left_c",
    "zcgs_cont",
    "js_cont",
    "xmgk_cont",
)
ADVANTAGE_CLASSES = (
    "xmys_cont",
    "youshi_cont",
    "hxys_cont",
    "lstd_cont",
    "yxxm_cont",
    "dtys_cont",
    "ysdb_cont",
)
CONDITION_CLASSES = (
    "sqyq_cont",
    "sqtj_cont",
    "shrq_cont",
    "bsyq_cont",
    "qzyq_cont",
    "jbyq_cont",
    "bltj",
    "tjyq_cont",
    "xmjs_tt2",
    "xmjs_tt3",
)
PROCESS_CLASSES = ("sqlc_cont", "bllc_cont", "gjlc_cont")
MONEY_RE = re.compile(
    r"(?:USD|CAD|AUD|HKD|EUR|RMB|NZD|¥|￥|US\$|C\$|"
    r"A\$|€|£|\$)?\s*\d+(?:[,.]\d+)?"
    r"(?:\s*[-–—至或]\s*\d+(?:[,.]\d+)?)?\s*"
    r"(?:万|亿)?\s*(?:美元|美金|欧元|人民币|港元|港币|"
    r"加元|加币|澳元|纽币|新西兰元|英镑|元)"
)
INVESTMENT_WORDS = (
    "投资",
    "购房",
    "买房",
    "房产",
    "基金",
    "捐款",
    "企业家",
    "创业",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="抓取 zlglobal.net 当前导航展示的移民项目"
    )
    parser.add_argument(
        "--output-dir",
        default="output/zlglobal",
        help="输出目录，默认：output/zlglobal",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.6,
        help="项目页之间等待秒数，默认：0.6",
    )
    parser.add_argument(
        "--limit",
        type=int,
        help="只处理前 N 个项目，用于验证",
    )
    parser.add_argument(
        "--fixture-dir",
        help="从离线样本目录读取 home.html 与详情页",
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
    for removable in clone.xpath(
        ".//script|.//style|.//form|.//noscript"
    ):
        parent = removable.getparent()
        if parent is not None:
            parent.remove(removable)
    for br in clone.xpath(".//br"):
        br.tail = "\n" + (br.tail or "")
    for block in clone.xpath(".//p|.//li|.//h1|.//h2|.//h3|.//h4"):
        block.tail = "\n" + (block.tail or "")
    return normalize_text(clone.text_content())


def detect_encoding(data: bytes) -> str:
    head = data[:2500].decode("ascii", "ignore").lower()
    match = re.search(r"charset\s*=\s*[\"']?([a-z0-9_-]+)", head)
    value = match.group(1) if match else ""
    if value in {"gb2312", "gbk", "gb18030"}:
        return "gb18030"
    return "utf-8"


def decode_html(data: bytes) -> str:
    return data.decode(detect_encoding(data), "replace")


def parse_document(data: bytes | str) -> html.HtmlElement:
    source = decode_html(data) if isinstance(data, bytes) else data
    return html.fromstring(
        source,
        parser=html.HTMLParser(recover=True),
        base_url=BASE_URL,
    )


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


def canonical_path(url: str) -> str:
    path = urlparse(url).path
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")
    return path


def fixture_name(url: str) -> str:
    path = canonical_path(url)
    if path == "/":
        return "home.html"
    if path.startswith("/zt/"):
        slug = path.removeprefix("/zt/").replace("/", "-")
        if slug.endswith("-index.html"):
            slug = slug[: -len("-index.html")]
        return f"topic-{slug}.html"
    match = re.fullmatch(r"/aus/zc/(\d+)\.html", path)
    if match:
        return f"article-{match.group(1)}.html"
    raise ValueError(f"无法生成样本文件名：{url}")


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


def is_project_path(path: str) -> bool:
    if path in PROJECT_ALIASES:
        return True
    return bool(ARTICLE_PROJECT_RE.fullmatch(path))


def discover_projects(data: bytes) -> list[dict[str, str]]:
    document = parse_document(data)
    selected: dict[str, dict[str, str]] = {}
    for link in document.xpath("//a[@href]"):
        url = urljoin(HOME_URL, link.get("href"))
        path = canonical_path(url)
        if not is_project_path(path):
            continue
        if path in selected:
            continue
        navigation_label = one_line(link.text_content())
        selected[path] = {
            "project_name": PROJECT_ALIASES.get(
                path, navigation_label
            ),
            "navigation_label": navigation_label,
            "source_url": urljoin(BASE_URL, path),
            "source_path": path,
        }
    return list(selected.values())


def country_from_name(project_name: str) -> str:
    for prefix, country in COUNTRY_PREFIXES:
        if project_name.startswith(prefix):
            return country
    return "未分类"


def project_type(project_name: str) -> str:
    if any(
        x in project_name
        for x in ("投资", "购房", "企业家", "马耳他永居")
    ):
        return "投资移民"
    if any(x in project_name for x in ("EB-1A", "NIW", "杰出人才", "NIV")):
        return "人才移民"
    if any(x in project_name for x in ("雇主担保", "EB-3", "EW-3")):
        return "雇主/职业移民"
    if any(x in project_name for x in ("技术移民", "绿名单", "六分制", "RCIP")):
        return "技术移民"
    if "签证" in project_name:
        return "签证项目"
    return "其他移民"


def class_nodes(
    document: html.HtmlElement,
    class_names: Iterable[str],
) -> list[etree._Element]:
    result: list[etree._Element] = []
    for class_name in class_names:
        result.extend(
            document.xpath(
                '//*[contains(concat(" ",normalize-space(@class)," "),'
                f'" {class_name} ")]'
            )
        )
    return result


def unique_strings(values: Iterable[str]) -> list[str]:
    result: list[str] = []
    for value in values:
        value = one_line(value).strip("■●•·-— ")
        if value and value not in result:
            result.append(value)
    return result


def section_items(node: etree._Element) -> list[str]:
    list_items = node.xpath(".//li[not(ancestor::li)]")
    if list_items:
        return unique_strings(text_with_breaks(item) for item in list_items)
    paragraphs = node.xpath(".//p[not(ancestor::p)]")
    if paragraphs:
        return unique_strings(text_with_breaks(item) for item in paragraphs)
    headings = node.xpath(".//h3|.//h4")
    values: list[str] = []
    for heading in headings:
        container = heading.getparent()
        text = one_line(text_with_breaks(container))
        if text and text not in values:
            values.append(text)
    if values:
        return values
    text = normalize_text(text_with_breaks(node))
    return unique_strings(text.splitlines())


def first_nonempty_section(
    document: html.HtmlElement,
    class_names: Iterable[str],
) -> str:
    for node in class_nodes(document, class_names):
        text = normalize_text(text_with_breaks(node))
        if len(one_line(text)) >= 30:
            return text
    return ""


def collect_section_items(
    document: html.HtmlElement,
    class_names: Iterable[str],
) -> list[str]:
    result: list[str] = []
    for node in class_nodes(document, class_names):
        for item in section_items(node):
            if item not in result:
                result.append(item)
    return result


def section_images(
    document: html.HtmlElement,
    class_names: Iterable[str],
    source_url: str,
) -> list[str]:
    result: list[str] = []
    for node in class_nodes(document, class_names):
        for image in node.xpath(".//img[@src]"):
            raw = image.get("src", "")
            lower = raw.lower()
            if any(x in lower for x in ("_til.", "title.", "ico")):
                continue
            url = urljoin(source_url, raw)
            if url not in result:
                result.append(url)
    return result


ARTICLE_LABELS = {
    "政策简介": "introduction",
    "项目简介": "introduction",
    "项目概述": "introduction",
    "核心优势": "advantages",
    "项目优势": "advantages",
    "申请要求": "conditions",
    "申请条件": "conditions",
    "适用人群": "conditions",
    "申请流程": "process",
    "办理流程": "process",
}


def article_sections(
    document: html.HtmlElement,
) -> dict[str, list[str]]:
    nodes = class_nodes(document, ("news_art_txt",))
    if not nodes:
        return {}
    text = text_with_breaks(nodes[0])
    sections: dict[str, list[str]] = defaultdict(list)
    current = ""
    for raw_line in text.splitlines():
        line = one_line(raw_line).strip()
        if not line:
            continue
        matched = False
        for label, section in ARTICLE_LABELS.items():
            if (
                line == label
                or line.startswith(f"{label}：")
                or line.startswith(f"{label}（")
                or line.startswith(f"{label}(")
            ):
                current = section
                remainder = line[len(label) :].lstrip("：: ")
                if remainder:
                    sections[current].append(remainder)
                matched = True
                break
        if matched:
            continue
        if line.startswith(("大国移民", "首选兆龙", "原文链接")):
            current = ""
        if current:
            sections[current].append(line)
    return dict(sections)


def split_numbered(values: Iterable[str]) -> list[str]:
    result: list[str] = []
    pattern = re.compile(r"(?=\d{1,2}[、.．）)])")
    for value in values:
        for line in normalize_text(value).splitlines():
            parts = [one_line(x) for x in pattern.split(line) if one_line(x)]
            for part in parts:
                part = part.strip("；; ")
                if part and part not in result:
                    result.append(part)
    return result


def fallback_introduction(document: html.HtmlElement) -> str:
    description = document.xpath(
        'string(//meta[translate(@name,"ABCDEFGHIJKLMNOPQRSTUVWXYZ",'
        '"abcdefghijklmnopqrstuvwxyz")="description"]/@content)'
    )
    if len(one_line(description)) >= 50:
        return one_line(description)
    for paragraph in document.xpath("//p"):
        text = normalize_text(text_with_breaks(paragraph))
        if len(one_line(text)) >= 80:
            return text
    title = one_line(document.xpath("string(//title)"))
    return title


def parse_topic_page(
    document: html.HtmlElement,
    source_url: str,
) -> dict[str, Any]:
    introduction = first_nonempty_section(document, INTRO_CLASSES)
    advantages = collect_section_items(
        document, ADVANTAGE_CLASSES
    )
    conditions = collect_section_items(
        document, CONDITION_CLASSES
    )
    process_nodes = class_nodes(document, PROCESS_CLASSES)
    process_items: list[str] = []
    for node in process_nodes:
        process_items.extend(section_items(node))
    process_items = unique_strings(process_items)
    process_images = section_images(
        document, PROCESS_CLASSES, source_url
    )
    if not introduction:
        introduction = fallback_introduction(document)
    if not advantages:
        advantages = collect_section_items(
            document, ("zlys_cont",)
        )
    path = canonical_path(source_url)
    if not advantages and path == "/zt/eb1a_2/index.html":
        advantages = relevant_sentences(
            [introduction],
            (
                "配额较多",
                "加速审理",
                "没有雇主",
                "不受行业",
                "全家一步到位",
            ),
        )
    if not advantages and path == "/zt/ew3/index.html":
        advantages = relevant_sentences(
            [introduction],
            (
                "要求低",
                "性价比高",
                "费用少",
                "申请时间合理",
                "工作灵活",
                "花小钱全家移民",
            ),
        )
    if not conditions and path == "/zt/ew3/index.html":
        conditions = relevant_sentences(
            [introduction],
            ("无特殊要求", "雇主愿意进行担保"),
        )
    return {
        "introduction": introduction,
        "advantages": advantages,
        "conditions": conditions,
        "process_items": process_items,
        "process_images": process_images,
        "source_granularity": "topic_page",
    }


def parse_article_page(
    document: html.HtmlElement,
    source_url: str,
) -> dict[str, Any]:
    sections = article_sections(document)
    introduction = normalize_text(
        "\n".join(sections.get("introduction", []))
    )
    if not introduction:
        introduction = fallback_introduction(document)
    advantages = split_numbered(sections.get("advantages", []))
    conditions = split_numbered(sections.get("conditions", []))
    process_items = split_numbered(sections.get("process", []))
    return {
        "introduction": introduction,
        "advantages": advantages,
        "conditions": conditions,
        "process_items": process_items,
        "process_images": [],
        "source_granularity": "article_detail",
    }


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
    extras = (
        "净资产",
        "资产要求",
        "投资要求",
        "投资金额",
        "投资门槛",
        "项目费用",
        "服务费",
    )
    for value in values:
        for sentence in re.split(r"[。；;\n]+", normalize_text(value)):
            sentence = one_line(sentence).strip("，, ")
            if (
                sentence
                and (MONEY_RE.search(sentence) or any(x in sentence for x in extras))
                and sentence not in result
            ):
                result.append(sentence)
    return result


def infer_identity_type(project_name: str, source: str) -> str:
    text = f"{project_name} {source}"
    if re.search(r"护照|公民|入籍", text):
        return "公民身份"
    if re.search(r"永居|永久居民|永久居留|绿卡|PR|枫叶卡", text):
        return "永久居留"
    if re.search(r"签证|工签|居留", text):
        return "签证/居留身份"
    return "居留身份"


def status_note(source: str) -> str:
    text = one_line(source)
    for keyword in ("已暂停", "暂停接受", "停止接受", "已关闭", "关停"):
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


def process_steps(items: list[str]) -> list[dict[str, Any]]:
    return [
        {
            "number": index,
            "stage": item[:100],
            "details": item,
            "raw_text": item,
        }
        for index, item in enumerate(items, start=1)
    ]


def build_record(
    item: dict[str, str],
    data: bytes | None,
    error: str = "",
) -> dict[str, Any]:
    name = item["project_name"]
    source_url = item["source_url"]
    parsed: dict[str, Any] = {
        "introduction": name,
        "advantages": [],
        "conditions": [],
        "process_items": [],
        "process_images": [],
        "source_granularity": "navigation_only",
    }
    if data:
        document = parse_document(data)
        if ARTICLE_PROJECT_RE.fullmatch(canonical_path(source_url)):
            parsed = parse_article_page(document, source_url)
        else:
            parsed = parse_topic_page(document, source_url)
    introduction = parsed["introduction"]
    advantages = parsed["advantages"]
    conditions = split_numbered(parsed["conditions"])
    process_items = split_numbered(parsed["process_items"])
    process_images = parsed["process_images"]
    all_text = [introduction, *advantages, *conditions, *process_items]
    investment_requirements = relevant_sentences(
        [introduction, *conditions], INVESTMENT_WORDS
    )
    financial_requirements = money_sentences(all_text)
    investment_amounts = [
        value
        for value in financial_requirements
        if any(word in value for word in INVESTMENT_WORDS)
        or "资产" in value
    ]
    steps = process_steps(process_items)
    if steps:
        process_type = "html_text"
        process_summary = "；".join(process_items)
    elif process_images:
        process_type = "image_only"
        process_summary = "官网申请/办理流程以图片形式发布。"
    else:
        process_type = "missing"
        process_summary = ""
    combined = " ".join(all_text)
    residence = relevant_sentences(
        [introduction, *advantages, *conditions],
        ("居住", "移民监", "登陆", "入境", "续签", "停留"),
    )
    ptype = project_type(name)
    is_investment = ptype == "投资移民"
    return {
        "scrape_status": "ok",
        "detail_fetch_status": "failed" if error else "ok",
        "detail_fetch_error": error,
        "company_name": COMPANY_NAME,
        "source_domain": "zlglobal.net",
        "project_name": name,
        "navigation_label": item["navigation_label"],
        "category": country_from_name(name),
        "project_type": ptype,
        "project_id": fixture_name(source_url).removesuffix(".html"),
        "source_granularity": parsed["source_granularity"],
        "website_status_note": status_note(combined),
        "is_investment_project": is_investment,
        "source_url": source_url,
        "introduction_summary": one_line(introduction)[:240],
        "introduction": introduction,
        "investment_amount": "；".join(investment_amounts[:4]),
        "investment_requirements": investment_requirements,
        "financial_requirements": financial_requirements,
        "fees": [],
        "advantages": advantages,
        "application_conditions": conditions,
        "process_summary": one_line(process_summary),
        "process_source_type": process_type,
        "process_text": normalize_text("\n".join(process_items)),
        "process_image_urls": process_images,
        "application_process": steps,
        "handling_process": steps,
        "identity_type": infer_identity_type(name, combined),
        "residence_requirement": "；".join(residence),
        "extra_sections": {
            "encoding": detect_encoding(data) if data else "",
            "robots_note": (
                "流程图片仅保留原始链接；不下载 robots.txt "
                "禁止的 /uploads 资源。"
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
        "navigation_label",
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
        "# 兆龙移民官网项目清单",
        "",
        f"当前首页导航共展示 {len(records)} 个项目入口。",
        "",
    ]
    for category, items in sorted(grouped.items()):
        lines.extend([f"## {category}（{len(items)}）", ""])
        for item in items:
            notes = [item["project_type"]]
            if item["process_source_type"] == "image_only":
                notes.append("流程为图片")
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
        "discovery_page": HOME_URL,
        "navigation_project_count": len(records),
        "topic_page_count": sum(
            x["source_granularity"] == "topic_page" for x in records
        ),
        "article_detail_count": sum(
            x["source_granularity"] == "article_detail"
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
            "以官网首页当前可见项目导航为发现口径，未把资讯和成功案例计为项目。",
            "sitemap 内容较旧，未用于替代当前导航项目清单。",
            "官网使用 GB2312/GBK 静态 HTML，无需浏览器渲染。",
            "robots.txt 禁止 /uploads；程序只保留相关图片链接，不下载该目录资源。",
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
    home_data = read_url(HOME_URL, fixture_dir, save_dir)
    items = discover_projects(home_data)
    if args.limit is not None:
        items = items[: max(args.limit, 0)]
    print(f"首页当前导航发现 {len(items)} 个项目入口")

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
    write_json(output_dir / "zlglobal_projects.json", records)
    write_csv(output_dir / "zlglobal_projects.csv", records)
    write_overview(
        output_dir / "zlglobal_projects_overview.md",
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
