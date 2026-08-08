#!/usr/bin/env python3
"""抓取澳星出国（austargroup.com）官网公开展示的移民项目。

首页前置“云锁”浏览器校验，普通 HTTP 客户端只能取得跳转脚本。程序使用
Playwright 通过公开首页发现 /visa/ 与 /passport/ 两类详情页，顺序低频访问，
再从静态 HTML 模板中提取项目介绍、投资要求、优势、申请条件和办理流程。
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


BASE_URL = "https://www.austargroup.com"
HOME_URL = f"{BASE_URL}/"
COMPANY_NAME = "澳星集团（澳星出国）"
PROJECT_RE = re.compile(
    r"^/(?P<template>visa|passport)/info_(?P<id>\d+)\.html$"
)
INVESTMENT_KEYWORDS = (
    "投资",
    "买房",
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
    r"(?:USD|CAD|HKD|EUR|RMB|SGD|AED|¥|￥|US\$|C\$|€|£|\$)?\s*"
    r"\d+(?:[,.]\d+)?(?:\s*[-–—至或]\s*\d+(?:[,.]\d+)?)?\s*"
    r"(?:万|亿)?\s*(?:美元|美金|欧元|人民币|港元|港币|"
    r"加元|加币|澳元|纽币|新西兰元|日元|新币|新加坡元|"
    r"英镑|里拉|迪拉姆|泰铢|菲律宾比索|元)"
)
NUMBERED_SPLIT_RE = re.compile(
    r"(?:(?<=\s)|^)(?=(?:（\d{1,2}）|\(\d{1,2}\)|"
    r"\d{1,2}[、.)．）]|[a-zA-Z][.、]))"
)
PASSPORT_COUNTRIES = (
    "安提瓜和巴布达",
    "圣基茨和尼维斯",
    "圣基茨",
    "圣卢西亚",
    "多米尼克",
    "格林纳达",
    "瓦努阿图",
    "土耳其",
    "马耳他",
)
DUPLICATE_GROUPS = {
    ("passport", "3"): "saint_kitts_citizenship",
    ("visa", "95"): "saint_kitts_citizenship",
    ("passport", "8"): "turkey_citizenship",
    ("visa", "98"): "turkey_citizenship",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="抓取 austargroup.com 当前公开展示的移民项目"
    )
    parser.add_argument(
        "--output-dir",
        default="output/austargroup",
        help="输出目录，默认：output/austargroup",
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
        help="只抓前 N 个候选页面；0 表示全部",
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
        help="显示浏览器窗口；无头浏览器被防护拦截时使用",
    )
    parser.add_argument(
        "--chrome-path",
        help="指定 Chrome/Chromium 可执行文件",
    )
    parser.add_argument(
        "--fixture-dir",
        help="从 type_ID.html 和 manifest.json 读取离线页面样本",
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


def first(nodes: Iterable[etree._Element]) -> etree._Element | None:
    return next(iter(nodes), None)


def text_with_breaks(
    node: etree._Element | None,
    *,
    remove_links: bool = False,
) -> str:
    if node is None:
        return ""
    clone = copy.deepcopy(node)
    for removable in clone.xpath(
        ".//form|.//script|.//style|"
        './/*[contains(concat(" ", normalize-space(@class), " "), '
        '" data ")]'
    ):
        parent = removable.getparent()
        if parent is not None:
            parent.remove(removable)
    if remove_links:
        for anchor in clone.xpath(".//a"):
            parent = anchor.getparent()
            if parent is not None:
                parent.remove(anchor)
    for br in clone.xpath(".//br"):
        br.tail = "\n" + (br.tail or "")
    for block in clone.xpath(".//p|.//li|.//div|.//h1|.//h3|.//h4"):
        block.tail = "\n" + (block.tail or "")
    return normalize_text(clone.text_content())


def parse_document(data: bytes | str) -> html.HtmlElement:
    parser = html.HTMLParser(recover=True)
    return html.fromstring(data, parser=parser, base_url=BASE_URL)


def normalize_project_url(value: str) -> str | None:
    url = urljoin(BASE_URL, value.strip())
    parsed = urlparse(url)
    if parsed.netloc.lower() not in {
        "austargroup.com",
        "www.austargroup.com",
    }:
        return None
    if not PROJECT_RE.fullmatch(parsed.path):
        return None
    return f"{BASE_URL}{parsed.path}"


def match_project(url: str) -> re.Match[str] | None:
    return PROJECT_RE.fullmatch(urlparse(url).path)


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


def node_items(node: etree._Element | None) -> list[str]:
    if node is None:
        return []
    list_nodes = node.xpath(".//li")
    if list_nodes:
        values = [text_with_breaks(item) for item in list_nodes]
        items = split_items(values)
        if items:
            return items
    paragraphs = [
        text_with_breaks(item)
        for item in node.xpath(".//p")
        if one_line(text_with_breaks(item))
    ]
    if paragraphs:
        return split_items(paragraphs)
    return split_items([text_with_breaks(node)])


def image_urls(node: etree._Element | None) -> list[str]:
    if node is None:
        return []
    result: list[str] = []
    for src in node.xpath(".//img/@src"):
        url = urljoin(BASE_URL, src.strip()).replace("http://", "https://", 1)
        if url not in result:
            result.append(url)
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


def money_sentences(values: Iterable[str]) -> list[str]:
    result: list[str] = []
    extra_keywords = (
        "净资产",
        "资产证明",
        "资金证明",
        "年收入",
        "营业额",
        "注册资本",
        "投资款",
        "申请费",
        "服务费",
        "管理费",
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


def infer_identity_type(project_name: str, source: str) -> str:
    text = f"{project_name} {source}"
    if re.search(r"护照|公民|入籍", text):
        return "公民身份"
    if re.search(r"永居|永久居留|绿卡", text):
        return "永久居留"
    if re.search(r"签证|工作准证|EP|高才|居留", text, re.IGNORECASE):
        return "签证/居留身份"
    return "居留身份"


def introduction_cleanup(value: str) -> str:
    result = normalize_text(value)
    result = re.split(
        r"(?:相关)?成功案[例列]|相关资讯|相关阅读",
        result,
        maxsplit=1,
    )[0]
    return result.strip()


def website_status_note(project_name: str, introduction: str) -> str:
    if "已暂停" in project_name:
        return "项目页标题明确标注“已暂停”。"
    if project_name == "爱尔兰投资移民":
        return (
            "官网首页说明爱尔兰IIP结束不影响现有项目或已获批申请人，"
            "并称仍有少量名额；仅按官网展示记录。"
        )
    text = one_line(introduction)
    if "爱尔兰" in project_name and (
        "项目的结束" in text or "计划的结束" in text or "关停" in text
    ):
        return (
            "官网说明爱尔兰IIP结束不影响现有项目或已获批申请人，"
            "并称仍有少量名额；仅按官网展示记录。"
        )
    return ""


def process_record(
    process_node: etree._Element | None,
    project_name: str,
) -> tuple[str, str, list[str], list[dict[str, Any]]]:
    if process_node is None:
        return "missing", "", [], []
    images = image_urls(process_node)
    steps: list[dict[str, Any]] = []
    for item in process_node.xpath(".//ol//li"):
        number = one_line(
            item.xpath("string(.//*[contains(@class,'top')]//span[1])")
        )
        stage = one_line(
            item.xpath(
                "string(.//*[contains(concat(' ',normalize-space(@class),' '),"
                "' bt ')][1])"
            )
        )
        detail_node = first(item.xpath("./p"))
        details = one_line(text_with_breaks(detail_node))
        if not stage and not details:
            continue
        steps.append(
            {
                "number": len(steps) + 1,
                "source_number": number,
                "stage": stage or details[:100],
                "details": details or stage,
                "raw_text": one_line(text_with_breaks(item)),
            }
        )
    if steps:
        lines: list[str] = []
        for step in steps:
            number_label = step["source_number"] or (
                f"第{step['number']}步"
            )
            detail = (
                ""
                if step["details"] == step["stage"]
                else step["details"]
            )
            lines.append(
                f"{number_label} {step['stage']} {detail}".strip()
            )
        text = "\n".join(lines)
        return "html_text", text, images, steps

    raw_text = text_with_breaks(process_node)
    noise = (
        "移居流程",
        "移民流程",
        "Immigration requirements",
        f"{project_name}申请流程",
        "温馨提示：",
        "温馨提醒：",
        "以上流程时间为按过往经验预估，以相关机构实际审理时间为准",
        "·",
    )
    meaningful = raw_text
    for value in noise:
        meaningful = meaningful.replace(value, "")
    meaningful = one_line(meaningful).strip("：:，,。. ")
    if meaningful in {"[]", "[ ]"}:
        meaningful = ""
    if images:
        return "image_only", "", images, []
    if meaningful:
        items = split_items([meaningful])
        generated = [
            {
                "number": index,
                "source_number": "",
                "stage": item[:100],
                "details": item,
                "raw_text": item,
            }
            for index, item in enumerate(items, start=1)
        ]
        return "html_text", meaningful, images, generated
    return "missing", "", images, []


def passport_country(project_name: str) -> str:
    for country in PASSPORT_COUNTRIES:
        if project_name.startswith(country):
            return (
                "圣基茨和尼维斯"
                if country == "圣基茨"
                else country
            )
    return ""


def passport_sections(
    base: etree._Element,
) -> dict[str, etree._Element]:
    result: dict[str, etree._Element] = {}
    con = first(
        base.xpath(
            './/div[contains(concat(" ",normalize-space(@class)," "),'
            '" con_div ")]'
        )
    )
    if con is None:
        return result
    for heading in con.xpath(
        './div[contains(concat(" ",normalize-space(@class)," ")," bt ")]'
    ):
        label = one_line(heading.text_content())
        candidates = heading.xpath(
            'following-sibling::div['
            'not(contains(concat(" ",normalize-space(@class)," ")," yw "))][1]'
        )
        if candidates:
            result[label] = candidates[0]
    return result


def scrape_visa(
    document: html.HtmlElement,
    requested_url: str,
    navigation_label: str,
) -> dict[str, Any]:
    base = first(
        document.xpath(
            '//div[contains(concat(" ",normalize-space(@class)," "),'
            '" guo_visax ")]//div['
            'contains(concat(" ",normalize-space(@class)," ")," left ")][1]'
        )
    )
    if base is None:
        raise ValueError("未找到签证项目详情模板")
    title_node = first(
        base.xpath(
            './/div[contains(concat(" ",normalize-space(@class)," "),'
            '" text_show ")]//h1[1]'
        )
    )
    project_name = one_line(text_with_breaks(title_node))
    if not project_name:
        raise ValueError("项目名称为空")
    breadcrumb = first(
        document.xpath(
            '//div[contains(concat(" ",normalize-space(@class)," "),'
            '" guo_bread ")]'
        )
    )
    breadcrumb_links = (
        [one_line(link.text_content()) for link in breadcrumb.xpath(".//a")]
        if breadcrumb is not None
        else []
    )
    category = breadcrumb_links[-1] if breadcrumb_links else ""
    if category == "中国香港地区":
        category = "中国香港"

    intro_node = first(
        base.xpath(
            './/div[contains(concat(" ",normalize-space(@class)," "),'
            '" text_show ")]//div['
            'contains(concat(" ",normalize-space(@class)," ")," show ")]'
            '//div[contains(concat(" ",normalize-space(@class)," ")," t ")][1]'
        )
    )
    advantage_node = first(
        base.xpath(
            './/*[@id="lbjs"]//*[contains('
            'concat(" ",normalize-space(@class)," ")," text ")][1]'
        )
    )
    condition_node = first(
        base.xpath(
            './/*[@id="ymyq"]//*[contains('
            'concat(" ",normalize-space(@class)," ")," text ")][1]'
        )
    )
    process_node = first(base.xpath('.//*[@id="ymlc"]'))

    introduction = introduction_cleanup(text_with_breaks(intro_node))
    advantages = node_items(advantage_node)
    conditions = node_items(condition_node)
    process_type, process_text, process_images, steps = process_record(
        process_node, project_name
    )
    raw_sections = {
        "项目介绍": introduction,
        "项目优势": text_with_breaks(advantage_node),
        "申请条件": text_with_breaks(condition_node),
        "申请流程": process_text,
    }
    section_images = {
        "项目介绍": image_urls(intro_node),
        "项目优势": image_urls(advantage_node),
        "申请条件": image_urls(condition_node),
        "申请流程": process_images,
    }
    return build_record(
        requested_url=requested_url,
        navigation_label=navigation_label,
        template="visa",
        project_name=project_name,
        category=category,
        introduction=introduction,
        advantages=advantages,
        conditions=conditions,
        process_type=process_type,
        process_text=process_text,
        process_images=process_images,
        steps=steps,
        raw_sections=raw_sections,
        section_images=section_images,
    )


def scrape_passport(
    document: html.HtmlElement,
    requested_url: str,
    navigation_label: str,
) -> dict[str, Any]:
    base = first(
        document.xpath(
            '//div[contains(concat(" ",normalize-space(@class)," "),'
            '" lsxxy_div ")]//div['
            'contains(concat(" ",normalize-space(@class)," ")," container ")][1]'
        )
    )
    if base is None:
        raise ValueError("未找到入籍项目详情模板")
    title_node = first(base.xpath("./h1[1]"))
    project_name = one_line(text_with_breaks(title_node))
    if not project_name:
        raise ValueError("项目名称为空")
    sections = passport_sections(base)
    advantage_node = sections.get("项目优势")
    condition_node = sections.get("申请条件")
    process_node = sections.get("移民流程")
    if process_node is None:
        process_node = sections.get("申请流程")
    advantages = node_items(advantage_node)
    conditions = node_items(condition_node)
    introduction = advantages[0] if advantages else ""
    process_type, process_text, process_images, steps = process_record(
        process_node, project_name
    )
    raw_sections = {
        "项目介绍": introduction,
        "项目优势": text_with_breaks(advantage_node),
        "申请条件": text_with_breaks(condition_node),
        "申请流程": process_text,
    }
    section_images = {
        "项目介绍": [],
        "项目优势": image_urls(advantage_node),
        "申请条件": image_urls(condition_node),
        "申请流程": process_images,
    }
    return build_record(
        requested_url=requested_url,
        navigation_label=navigation_label,
        template="passport",
        project_name=project_name,
        category=passport_country(project_name),
        introduction=introduction,
        advantages=advantages,
        conditions=conditions,
        process_type=process_type,
        process_text=process_text,
        process_images=process_images,
        steps=steps,
        raw_sections=raw_sections,
        section_images=section_images,
    )


def build_record(
    *,
    requested_url: str,
    navigation_label: str,
    template: str,
    project_name: str,
    category: str,
    introduction: str,
    advantages: list[str],
    conditions: list[str],
    process_type: str,
    process_text: str,
    process_images: list[str],
    steps: list[dict[str, Any]],
    raw_sections: dict[str, str],
    section_images: dict[str, list[str]],
) -> dict[str, Any]:
    source_values = [introduction, *advantages, *conditions]
    combined = " ".join(source_values)
    investment_requirements = positive_investment_sentences(
        [introduction, *conditions]
    )
    financial_requirements = money_sentences(
        [introduction, *conditions, *investment_requirements]
    )
    investment_amount_candidates = [
        sentence
        for sentence in financial_requirements
        if any(keyword in sentence for keyword in INVESTMENT_KEYWORDS)
    ]
    explicitly_non_investment = bool(
        re.search(
            r"国家创新签证|EB-1A|NIW|技术移民|人才签证|"
            r"高才计划|ONE PASS|绿名单|6分制|家庭团聚|非盈利",
            project_name,
            re.IGNORECASE,
        )
    )
    is_investment = not explicitly_non_investment and (
        any(keyword in project_name for keyword in INVESTMENT_KEYWORDS)
        or bool(investment_requirements)
        or any(keyword in project_name for keyword in ("创业", "企业家"))
    )
    fees = relevant_sentences(
        [introduction, *conditions],
        ("费用", "申请费", "服务费", "管理费", "律师费"),
    )
    residence = relevant_sentences(
        [introduction, *advantages, *conditions],
        ("居住", "移民监", "登陆", "入境", "续签", "停留"),
    )
    match = match_project(requested_url)
    project_id = match.group("id") if match else ""
    duplicate_group = DUPLICATE_GROUPS.get((template, project_id), "")
    if process_type == "image_only":
        process_summary = "官网办理流程仅以图片形式发布，已保留原图链接。"
    elif process_type == "html_text":
        process_summary = one_line(process_text)
    else:
        process_summary = ""
    return {
        "scrape_status": "ok",
        "company_name": COMPANY_NAME,
        "source_domain": "austargroup.com",
        "project_name": project_name,
        "navigation_label": navigation_label,
        "category": category,
        "project_id": project_id,
        "page_template": template,
        "duplicate_group": duplicate_group,
        "website_status_note": website_status_note(
            project_name, introduction
        ),
        "is_investment_project": is_investment,
        "source_url": requested_url,
        "requested_url": requested_url,
        "introduction_summary": one_line(introduction)[:240],
        "introduction": introduction,
        "investment_amount": "；".join(
            investment_amount_candidates[:4]
        ),
        "investment_requirements": investment_requirements,
        "financial_requirements": financial_requirements,
        "fees": fees,
        "advantages": advantages,
        "application_conditions": conditions,
        "process_summary": process_summary,
        "process_source_type": process_type,
        "process_text": process_text,
        "process_image_urls": process_images,
        "application_process": steps,
        "handling_process": steps,
        "identity_type": infer_identity_type(project_name, combined),
        "residence_requirement": "；".join(residence),
        "raw_sections": raw_sections,
        "section_image_urls": section_images,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
    }


def scrape_project(
    data: bytes | str,
    requested_url: str,
    navigation_label: str,
) -> dict[str, Any]:
    match = match_project(requested_url)
    if match is None:
        raise ValueError("不是支持的项目网址")
    document = parse_document(data)
    if match.group("template") == "passport":
        return scrape_passport(document, requested_url, navigation_label)
    return scrape_visa(document, requested_url, navigation_label)


def deduplicate_records(
    records: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    unique: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    for record in records:
        group = record.get("duplicate_group")
        if group:
            grouped[group].append(record)
        else:
            unique.append(record)
    for group, items in grouped.items():
        items.sort(
            key=lambda item: (
                item.get("page_template") != "visa",
                -len(item.get("process_text", "")),
                item.get("source_url", ""),
            )
        )
        chosen = items[0]
        chosen["duplicate_source_urls"] = [
            item["source_url"] for item in items[1:]
        ]
        unique.append(chosen)
        for duplicate in items[1:]:
            excluded.append(
                {
                    "scrape_status": "excluded_duplicate",
                    "exclusion_reason": (
                        "与另一公开入口展示同一项目，保留内容更完整的"
                        f"{chosen['page_template']}模板页面"
                    ),
                    "project_name": duplicate["project_name"],
                    "source_url": duplicate["source_url"],
                    "kept_source_url": chosen["source_url"],
                    "duplicate_group": group,
                }
            )
    unique.sort(
        key=lambda item: (
            item.get("category", ""),
            item.get("project_name", ""),
        )
    )
    return unique, excluded


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
    for _ in range(20):
        content = page.content()
        if re.search(expected_pattern, content):
            return content
        page.wait_for_timeout(1000)
    raise RuntimeError("浏览器校验未通过或页面模板未加载")


def live_pages(
    args: argparse.Namespace,
) -> tuple[list[tuple[str, str, str]], list[str]]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise RuntimeError(
            "缺少 Playwright，请先执行：pip install -r requirements.txt"
        ) from exc

    explicit: list[str] = []
    for value in args.urls or []:
        url = normalize_project_url(value)
        if url and url not in explicit:
            explicit.append(url)

    pages: list[tuple[str, str, str]] = []
    candidates: list[str] = []
    navigation_labels: dict[str, str] = {}
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
        if explicit:
            candidates = explicit
        else:
            page.goto(HOME_URL, wait_until="domcontentloaded", timeout=60_000)
            homepage = wait_for_real_page(
                page, r"/(?:visa|passport)/info_\d+\.html"
            )
            document = parse_document(homepage)
            for anchor in document.xpath("//a[@href]"):
                url = normalize_project_url(anchor.get("href", ""))
                if not url:
                    continue
                label = one_line(anchor.text_content())
                old = navigation_labels.get(url, "")
                if label not in {"查看详情", "免费评估"} and len(label) > len(old):
                    navigation_labels[url] = label
                if url not in candidates:
                    candidates.append(url)
        if args.limit > 0:
            candidates = candidates[: args.limit]
        for index, url in enumerate(candidates, start=1):
            print(f"[{index}/{len(candidates)}] {url}", flush=True)
            page.goto(url, wait_until="domcontentloaded", timeout=60_000)
            content = wait_for_real_page(
                page, r"guo_visax|lsxxy_div"
            )
            pages.append(
                (url, content, navigation_labels.get(url, ""))
            )
            if args.delay > 0 and index < len(candidates):
                time.sleep(args.delay)
        context.close()
        browser.close()
    return pages, candidates


def fixture_pages(
    directory: Path,
    limit: int,
) -> tuple[list[tuple[str, bytes, str]], list[str]]:
    manifest_path = directory / "manifest.json"
    manifest: list[dict[str, str]] = []
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    else:
        for path in sorted(directory.glob("*.html")):
            match = re.fullmatch(r"(visa|passport)_(\d+)", path.stem)
            if match:
                manifest.append(
                    {
                        "url": (
                            f"{BASE_URL}/{match.group(1)}/"
                            f"info_{match.group(2)}.html"
                        ),
                        "navigation_label": "",
                    }
                )
    pages: list[tuple[str, bytes, str]] = []
    candidates: list[str] = []
    for item in manifest:
        url = normalize_project_url(item.get("url", ""))
        if not url:
            continue
        match = match_project(url)
        assert match is not None
        path = directory / (
            f"{match.group('template')}_{match.group('id')}.html"
        )
        candidates.append(url)
        if path.exists():
            pages.append(
                (
                    url,
                    path.read_bytes(),
                    item.get("navigation_label", ""),
                )
            )
        if limit > 0 and len(candidates) >= limit:
            break
    return pages, candidates


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
        "project_id",
        "page_template",
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
        "duplicate_source_urls",
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
        "# 澳星出国官网项目清单",
        "",
        f"共采集并去重得到 {len(records)} 个官网当前展示项目。",
        "",
    ]
    for category, items in sorted(grouped.items()):
        lines.extend([f"## {category}（{len(items)}）", ""])
        for item in items:
            notes: list[str] = []
            if item["process_source_type"] == "image_only":
                notes.append("流程为图片")
            elif item["process_source_type"] == "missing":
                notes.append("官网未公开流程")
            if item.get("website_status_note"):
                notes.append(item["website_status_note"])
            suffix = f"（{'；'.join(notes)}）" if notes else ""
            lines.append(
                f"- [{item['project_name']}]({item['source_url']}){suffix}"
            )
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def write_summary(
    path: Path,
    records: list[dict[str, Any]],
    candidates: list[str],
    excluded: list[dict[str, Any]],
    errors: list[dict[str, Any]],
) -> None:
    categories: dict[str, int] = defaultdict(int)
    for record in records:
        categories[record.get("category") or "未分类"] += 1
    summary = {
        "company_name": COMPANY_NAME,
        "source": BASE_URL,
        "candidate_url_count": len(candidates),
        "record_count_after_deduplication": len(records),
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
        "website_status_notes": [
            {
                "project_name": record["project_name"],
                "source_url": record["source_url"],
                "note": record["website_status_note"],
            }
            for record in records
            if record.get("website_status_note")
        ],
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
        "excluded_duplicate_records": excluded,
        "error_records": errors,
        "notes": [
            "首页前置云锁浏览器校验，普通 HTTP 请求无法直接采集。",
            "robots.txt 仅包含 User-agent: *，未声明 Disallow。",
            "只采集当前首页直接链接的公开 visa/passport 项目详情页。",
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
        pages, candidates = fixture_pages(
            Path(args.fixture_dir).expanduser().resolve(),
            args.limit,
        )
        print(
            f"离线读取 {len(pages)}/{len(candidates)} 个候选详情页"
        )
    else:
        pages, candidates = live_pages(args)
        print(f"发现 {len(candidates)} 个候选详情页")

    parsed: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for url, data, navigation_label in pages:
        try:
            record = scrape_project(data, url, navigation_label)
            parsed.append(record)
        except Exception as exc:
            record = {
                "scrape_status": "error",
                "error": str(exc),
                "source_url": url,
                "navigation_label": navigation_label,
            }
            errors.append(record)
        print(
            f"  {record.get('scrape_status')}: "
            f"{record.get('project_name') or url}",
            flush=True,
        )

    records, excluded = deduplicate_records(parsed)
    write_json(output_dir / "austargroup_projects.json", records)
    write_csv(output_dir / "austargroup_projects.csv", records)
    write_overview(output_dir / "austargroup_projects_overview.md", records)
    write_summary(
        output_dir / "summary.json",
        records,
        candidates,
        excluded,
        errors,
    )
    print(
        f"完成：候选 {len(candidates)}；去重后项目 {len(records)}；"
        f"重复入口 {len(excluded)}；错误 {len(errors)}"
    )
    print(f"输出目录：{output_dir}")
    return 0 if records else 1


if __name__ == "__main__":
    raise SystemExit(main())
