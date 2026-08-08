#!/usr/bin/env python3
"""抓取和中移民（welltrendvisa.com）官网公开展示的移民项目。

该站使用服务端生成的静态 HTML。项目分布在美国、加拿大、欧洲、护照移民、
亚非身份、大洋洲和香港七个栏目页；加拿大与香港提供详细选项卡，其他栏目
主要提供项目摘要卡片。程序只保存官网实际展示的字段，不把未公开字段当成
抓取失败。
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
from urllib.parse import urljoin

from lxml import etree, html


BASE_URL = "https://welltrendvisa.com"
COMPANY_NAME = "和中移民（WellTrend）"
USER_AGENT = (
    "WellTrendPublicProjectResearch/1.0 "
    "(public project pages only; low-frequency)"
)
SECTION_PAGES = {
    "mg": {"category": "美国", "fixture": "mg.html"},
    "jndymxzc": {"category": "加拿大", "fixture": "ca.html"},
    "ozymzhym": {"category": "欧洲", "fixture": "eu.html"},
    "hzymzhym": {
        "category": "护照移民",
        "fixture": "passport.html",
    },
    "yzym": {"category": "亚非", "fixture": "asia.html"},
    "dyzymzhym": {
        "category": "大洋洲",
        "fixture": "oceania.html",
    },
    "xgh5": {"category": "中国香港", "fixture": "hk.html"},
}
DETAIL_ROUTES = {"jndymxzc", "xgh5"}
CARD_ROUTES = set(SECTION_PAGES) - DETAIL_ROUTES
PROJECT_RELEVANT_LABELS = {
    "解读": "introduction",
    "项目简介": "introduction",
    "项目介绍": "introduction",
    "项目优势": "advantages",
    "申请条件": "conditions",
    "项目总体费用": "fees",
    "项目费用": "fees",
    "办理周期": "period",
    "审批周期": "period",
    "申请周期": "period",
    "身份延续": "identity_continuation",
    "申请流程": "process",
    "办理流程": "process",
    "移民流程": "process",
    "移居流程": "process",
}
EXCLUDED_CARD_WORDS = (
    "银行开户",
    "注册公司",
    "留学",
    "后续服务",
    "其它服务",
    "其他服务",
    "增值服务",
    "护照开户",
    "护照更名",
    "地址证明",
    "出生证明",
    "护照续期",
    "护照出行",
    "身份转化",
    "E-2签证指导",
    "持有瓦努阿图护照后",
)
COUNTRY_PREFIXES = (
    "安提瓜和巴布达",
    "圣基茨和尼维斯",
    "几内亚比绍",
    "北马其顿",
    "中国香港",
    "瓦努阿图",
    "格林纳达",
    "多米尼克",
    "圣卢西亚",
    "圣基茨",
    "马来西亚",
    "克罗地亚",
    "塞浦路斯",
    "保加利亚",
    "澳大利亚",
    "匈牙利",
    "新西兰",
    "土耳其",
    "马耳他",
    "西班牙",
    "葡萄牙",
    "爱尔兰",
    "巴拿马",
    "新加坡",
    "菲律宾",
    "阿联酋",
    "澳洲",
    "安提瓜",
    "迪拜",
    "香港",
    "美国",
    "加拿大",
    "希腊",
    "英国",
    "德国",
    "法国",
    "日本",
    "泰国",
    "韩国",
    "埃及",
    "黑山",
)
COUNTRY_ALIASES = {
    "香港": "中国香港",
    "澳洲": "澳大利亚",
    "圣基茨": "圣基茨和尼维斯",
    "安提瓜": "安提瓜和巴布达",
    "迪拜": "阿联酋",
}
PROJECT_NAME_ALIASES = {
    "土耳其护照入籍": "土耳其投资入籍计划",
    "马耳他护照入籍": "马耳他投资入籍计划",
}
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
    "创业",
    "企业家",
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="抓取 welltrendvisa.com 当前公开展示的移民项目"
    )
    parser.add_argument(
        "--output-dir",
        default="output/welltrendvisa",
        help="输出目录，默认：output/welltrendvisa",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.8,
        help="栏目页面之间的等待秒数，默认：0.8",
    )
    parser.add_argument(
        "--fixture-dir",
        help="从离线目录读取 mg.html、ca.html 等栏目样本",
    )
    parser.add_argument(
        "--route",
        action="append",
        help="只处理指定栏目路径；可重复传入",
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
    for block in clone.xpath(".//p|.//li|.//div"):
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
        "资产要求",
        "资产证明",
        "资金证明",
        "投资预算",
        "最低投资",
        "项目总体费用",
        "项目费用",
        "年收入",
        "营业额",
        "注册资本",
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


def infer_identity_type(project_name: str, source: str) -> str:
    text = f"{project_name} {source}"
    if re.search(r"护照|公民|入籍", text):
        return "公民身份"
    if re.search(r"永居|永久居民|永久居留|绿卡|枫叶卡", text):
        return "永久居留"
    if re.search(r"签证|工作准证|EP|高才|居留", text, re.IGNORECASE):
        return "签证/居留身份"
    return "居留身份"


def normalize_category(value: str, project_name: str) -> str:
    value = re.sub(r"(移民|移居)$", "", value).strip()
    if value in {"美洲", "美国地区"}:
        value = "美国"
    if value in {"欧洲", "护照", "护照移民", "亚非", "大洋洲"}:
        value = ""
    for prefix in COUNTRY_PREFIXES:
        if project_name.startswith(prefix):
            value = COUNTRY_ALIASES.get(prefix, prefix)
            break
    if value == "巴拿马亚":
        value = "巴拿马"
    return COUNTRY_ALIASES.get(value, value)


def status_note(project_name: str, source: str) -> str:
    text = one_line(f"{project_name} {source}")
    if (
        project_name == "加拿大超级签证"
        and "父母/祖父母团聚处于关停状态" in text
        and "超级签证的签发是正常" in text
    ):
        return (
            "官网说明父母/祖父母团聚项目处于关停状态，"
            "但超级签证签发正常。"
        )
    for keyword in ("已暂停", "关停状态", "已经关停", "已关闭"):
        if keyword in text:
            sentences = re.split(r"[。；;]", text)
            hit = next(
                (sentence for sentence in sentences if keyword in sentence),
                "",
            )
            return f"官网内容提及：{one_line(hit)[:220]}"
    return ""


def build_record(
    *,
    project_name: str,
    navigation_label: str,
    category: str,
    source_url: str,
    source_component_id: str,
    source_granularity: str,
    introduction: str,
    advantages: list[str],
    conditions: list[str],
    fees: list[str],
    period: str,
    process_text: str,
    process_steps: list[dict[str, Any]],
    extra_sections: dict[str, str],
) -> dict[str, Any]:
    combined = " ".join(
        [introduction, *advantages, *conditions, *fees, period]
    )
    investment_requirements = relevant_sentences(
        [introduction, *conditions],
        INVESTMENT_KEYWORDS,
    )
    financial_requirements = money_sentences(
        [introduction, *conditions, *fees, *investment_requirements]
    )
    amount_candidates = [
        sentence
        for sentence in financial_requirements
        if any(keyword in sentence for keyword in INVESTMENT_KEYWORDS)
        or "资产要求" in sentence
        or "投资预算" in sentence
    ]
    explicitly_non_investment = bool(
        re.search(
            r"EB-1A|NIW|L-1|团聚|技术移民|人才|高才|"
            r"ONE PASS|绿名单|非盈利|D7|欧盟蓝卡|工作准证",
            project_name,
            re.IGNORECASE,
        )
    )
    is_investment = not explicitly_non_investment and (
        any(keyword in project_name for keyword in INVESTMENT_KEYWORDS)
        or bool(investment_requirements)
    )
    if process_steps or process_text:
        process_type = "html_text"
        process_summary = one_line(process_text)
    elif period:
        process_type = "summary_only"
        process_summary = period
    else:
        process_type = "missing"
        process_summary = ""
    residence = relevant_sentences(
        [introduction, *advantages, *conditions],
        ("居住", "移民监", "登陆", "入境", "续签", "停留"),
    )
    return {
        "scrape_status": "ok",
        "company_name": COMPANY_NAME,
        "source_domain": "welltrendvisa.com",
        "project_name": project_name,
        "navigation_label": navigation_label,
        "category": category,
        "project_id": source_component_id,
        "source_granularity": source_granularity,
        "website_status_note": status_note(project_name, combined),
        "is_investment_project": is_investment,
        "source_url": source_url,
        "introduction_summary": one_line(introduction)[:240],
        "introduction": introduction,
        "investment_amount": "；".join(amount_candidates[:4]),
        "investment_requirements": investment_requirements,
        "financial_requirements": financial_requirements,
        "fees": fees,
        "advantages": advantages,
        "application_conditions": conditions,
        "process_summary": process_summary,
        "process_source_type": process_type,
        "process_text": process_text,
        "process_image_urls": [],
        "application_process": process_steps,
        "handling_process": process_steps,
        "identity_type": infer_identity_type(project_name, combined),
        "residence_requirement": "；".join(residence),
        "extra_sections": extra_sections,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
    }


def editable_blocks(node: etree._Element) -> list[str]:
    result: list[str] = []
    for block in node.xpath(
        './/div[contains(concat(" ",normalize-space(@class)," "),'
        '" editableContent ")]'
    ):
        text = one_line(text_with_breaks(block))
        if text:
            result.append(text)
    return result


def parse_labeled_blocks(
    blocks: list[str],
) -> tuple[dict[str, list[str]], list[str]]:
    sections: dict[str, list[str]] = defaultdict(list)
    unlabeled: list[str] = []
    current = ""
    for block in blocks:
        cleaned = one_line(block)
        label_text = cleaned.rstrip("：: ").strip()
        mapped = PROJECT_RELEVANT_LABELS.get(label_text)
        if mapped:
            current = mapped
            continue
        inline_matched = False
        for label, section in PROJECT_RELEVANT_LABELS.items():
            prefix_re = rf"^{re.escape(label)}[：:]\s*(.+)$"
            match = re.match(prefix_re, cleaned)
            if match:
                sections[section].append(match.group(1).strip())
                current = section
                inline_matched = True
                break
        if inline_matched:
            continue
        if current:
            sections[current].append(cleaned)
        else:
            unlabeled.append(cleaned)
    return dict(sections), unlabeled


def discover_detail_tabs(
    document: html.HtmlElement,
) -> list[etree._Element]:
    result: list[etree._Element] = []
    for widget in document.xpath(
        '//div[contains(concat(" ",normalize-space(@class)," "),'
        '" w-label ")]'
    ):
        if widget.xpath(
            './ul[contains(@class,"w-label-content")]/li'
            '//div[contains(concat(" ",normalize-space(@class)," "),'
            '" w-label ")]'
        ):
            continue
        tips = widget.xpath(
            './ul[contains(@class,"w-label-tips")]/li'
            '[contains(@class,"w-label-tips-item")]'
        )
        contents = widget.xpath(
            './ul[contains(@class,"w-label-content")]/li'
            '[contains(@class,"w-label-content-item")]'
        )
        if not tips or len(tips) != len(contents):
            continue
        content_text = " ".join(
            one_line(text_with_breaks(item)) for item in contents
        )
        if "解读：" in content_text or "项目简介：" in content_text:
            result.append(widget)
    return result


def detailed_records(
    document: html.HtmlElement,
    route: str,
    category: str,
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for widget in discover_detail_tabs(document):
        tips = widget.xpath(
            './ul[contains(@class,"w-label-tips")]/li'
            '[contains(@class,"w-label-tips-item")]'
        )
        contents = widget.xpath(
            './ul[contains(@class,"w-label-content")]/li'
            '[contains(@class,"w-label-content-item")]'
        )
        component_id = widget.get("id", "")
        for index, (tip, content) in enumerate(
            zip(tips, contents), start=1
        ):
            navigation_label = one_line(text_with_breaks(tip))
            project_name = navigation_label
            if category == "加拿大":
                if project_name.endswith("企业家移"):
                    project_name += "民"
                if not project_name.startswith("加拿大"):
                    project_name = f"加拿大{project_name}"
            elif category == "中国香港":
                if not project_name.startswith(("香港", "中国香港")):
                    project_name = f"香港{project_name}"
            blocks = editable_blocks(content)
            sections, unlabeled = parse_labeled_blocks(blocks)
            intro_parts = sections.get("introduction", [])
            introduction = normalize_text("\n".join(intro_parts))
            if not introduction and unlabeled:
                introduction = unlabeled[-1]
            advantages = split_items(sections.get("advantages", []))
            conditions = split_items(sections.get("conditions", []))
            fees = split_items(sections.get("fees", []))
            period = one_line("；".join(sections.get("period", [])))
            process_values = sections.get("process", [])
            process_items = split_items(process_values)
            process_steps = [
                {
                    "number": step,
                    "stage": item[:100],
                    "details": item,
                    "raw_text": item,
                }
                for step, item in enumerate(process_items, start=1)
            ]
            process_text = normalize_text("\n".join(process_values))
            extras = {
                key: normalize_text("\n".join(values))
                for key, values in sections.items()
                if key
                not in {
                    "introduction",
                    "advantages",
                    "conditions",
                    "fees",
                    "period",
                    "process",
                }
            }
            if unlabeled:
                extras["unlabeled_context"] = normalize_text(
                    "\n".join(unlabeled)
                )
            source_id = f"{component_id}-{index}"
            records.append(
                build_record(
                    project_name=project_name,
                    navigation_label=navigation_label,
                    category=category,
                    source_url=f"{BASE_URL}/{route}#{component_id}",
                    source_component_id=source_id,
                    source_granularity="detailed_tab",
                    introduction=introduction,
                    advantages=advantages,
                    conditions=conditions,
                    fees=fees,
                    period=period,
                    process_text=process_text,
                    process_steps=process_steps,
                    extra_sections=extras,
                )
            )
    return records


def closest_card_area(
    button: etree._Element,
) -> etree._Element | None:
    return first(button.xpath('ancestor::div[@ctype="area"][1]'))


def card_records(
    document: html.HtmlElement,
    route: str,
    default_category: str,
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    seen_components: set[str] = set()
    buttons = document.xpath(
        '//div[@ctype="button"]'
        '[.//*[contains(@class,"mw-txt") and normalize-space()="查看详情"]]'
    )
    for button in buttons:
        area = closest_card_area(button)
        if area is None:
            continue
        component_id = area.get("id", "")
        if not component_id or component_id in seen_components:
            continue
        seen_components.add(component_id)
        blocks = editable_blocks(area)
        if len(blocks) < 2:
            continue
        first_block, second_block = blocks[:2]
        project_name = ""
        raw_category = ""
        summary_blocks: list[str] = []
        if first_block.endswith(("移民", "移居")):
            raw_category = first_block
            project_name = second_block
            summary_blocks = blocks[2:]
        elif (
            any(
                keyword in first_block
                for keyword in (
                    "团聚",
                    "签证项目",
                    "永居项目",
                    "入籍项目",
                )
            )
            and second_block not in {"其它服务", "其他服务"}
        ):
            project_name = first_block
            raw_category = default_category
            summary_blocks = blocks[1:]
        if (
            not project_name
            or len(project_name) > 50
            or any(
                keyword in project_name
                for keyword in EXCLUDED_CARD_WORDS
            )
        ):
            continue
        if project_name.startswith("获得身份") and first_block == second_block:
            project_name = first_block
        if project_name == re.sub(r"(移民|移居)$", "", raw_category) + "移民":
            project_name = first_block
        project_name = PROJECT_NAME_ALIASES.get(
            project_name, project_name
        )
        category = normalize_category(raw_category, project_name)
        if route == "mg":
            category = "美国"
        if route == "yzym" and category == "中国香港":
            # 香港独立栏目提供更完整的同项目选项卡。
            continue
        introduction = normalize_text("\n".join(summary_blocks))
        records.append(
            build_record(
                project_name=project_name,
                navigation_label=project_name,
                category=category or default_category,
                source_url=f"{BASE_URL}/{route}#{component_id}",
                source_component_id=component_id,
                source_granularity="summary_card",
                introduction=introduction,
                advantages=[],
                conditions=[],
                fees=[],
                period="",
                process_text="",
                process_steps=[],
                extra_sections={
                    "card_category": first_block,
                    "card_summary": introduction,
                },
            )
        )
    return records


def deduplicate_records(
    records: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    selected: dict[tuple[str, str], dict[str, Any]] = {}
    excluded: list[dict[str, Any]] = []
    for record in records:
        key = (
            record.get("category", ""),
            one_line(record.get("project_name", "")),
        )
        old = selected.get(key)
        if old is None:
            selected[key] = record
            continue
        old_score = (
            old.get("source_granularity") == "detailed_tab",
            len(old.get("introduction", "")),
        )
        new_score = (
            record.get("source_granularity") == "detailed_tab",
            len(record.get("introduction", "")),
        )
        kept, duplicate = (
            (record, old) if new_score > old_score else (old, record)
        )
        selected[key] = kept
        excluded.append(
            {
                "scrape_status": "excluded_duplicate",
                "exclusion_reason": (
                    "同一栏目重复展示，保留信息更完整的项目单元"
                ),
                "project_name": duplicate["project_name"],
                "category": duplicate["category"],
                "source_url": duplicate["source_url"],
                "kept_source_url": kept["source_url"],
            }
        )
    result = list(selected.values())
    result.sort(
        key=lambda item: (
            item.get("category", ""),
            item.get("project_name", ""),
        )
    )
    return result, excluded


def read_pages(
    routes: list[str],
    fixture_dir: Path | None,
    delay: float,
) -> dict[str, bytes]:
    pages: dict[str, bytes] = {}
    for index, route in enumerate(routes, start=1):
        metadata = SECTION_PAGES[route]
        if fixture_dir is not None:
            path = fixture_dir / metadata["fixture"]
            pages[route] = path.read_bytes()
            print(f"[{index}/{len(routes)}] 离线读取 {path.name}")
        else:
            url = f"{BASE_URL}/{route}"
            print(f"[{index}/{len(routes)}] {url}", flush=True)
            pages[route] = http_get(url)
            if delay > 0 and index < len(routes):
                time.sleep(delay)
    return pages


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
        "application_process",
        "handling_process",
        "identity_type",
        "residence_requirement",
        "extra_sections",
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
        "# 和中移民官网项目清单",
        "",
        f"共采集并去重得到 {len(records)} 个官网当前展示项目。",
        "",
    ]
    for category, items in sorted(grouped.items()):
        lines.extend([f"## {category}（{len(items)}）", ""])
        for item in items:
            notes: list[str] = []
            if item["source_granularity"] == "summary_card":
                notes.append("官网仅提供项目卡片摘要")
            if item["process_source_type"] == "summary_only":
                notes.append("仅公开办理/审批周期")
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
    candidate_count: int,
    excluded: list[dict[str, Any]],
    routes: list[str],
) -> None:
    categories: dict[str, int] = defaultdict(int)
    for record in records:
        categories[record.get("category") or "未分类"] += 1
    summary = {
        "company_name": COMPANY_NAME,
        "source": BASE_URL,
        "section_pages": [f"{BASE_URL}/{route}" for route in routes],
        "candidate_unit_count": candidate_count,
        "record_count_after_deduplication": len(records),
        "detailed_tab_count": sum(
            1
            for record in records
            if record["source_granularity"] == "detailed_tab"
        ),
        "summary_card_count": sum(
            1
            for record in records
            if record["source_granularity"] == "summary_card"
        ),
        "investment_project_count": sum(
            1 for record in records if record["is_investment_project"]
        ),
        "html_process_count": sum(
            1
            for record in records
            if record["process_source_type"] == "html_text"
        ),
        "summary_only_process_count": sum(
            1
            for record in records
            if record["process_source_type"] == "summary_only"
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
        "notes": [
            "robots.txt 明确 Allow: /，程序只访问公开栏目页面。",
            "加拿大和香港项目来自详细选项卡；其他栏目仅提供项目摘要卡片。",
            "官网仍展示不代表相关政策当前开放，数据未作法律状态校验。",
        ],
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    write_json(path, summary)


def main() -> int:
    args = parse_args()
    routes = args.route or list(SECTION_PAGES)
    invalid = [route for route in routes if route not in SECTION_PAGES]
    if invalid:
        raise SystemExit(f"未知栏目：{', '.join(invalid)}")
    fixture_dir = (
        Path(args.fixture_dir).expanduser().resolve()
        if args.fixture_dir
        else None
    )
    pages = read_pages(routes, fixture_dir, args.delay)

    raw_records: list[dict[str, Any]] = []
    for route, data in pages.items():
        document = parse_document(data)
        category = SECTION_PAGES[route]["category"]
        if route in DETAIL_ROUTES:
            found = detailed_records(document, route, category)
        else:
            found = card_records(document, route, category)
        raw_records.extend(found)
        print(f"  {route}: 发现 {len(found)} 个项目展示单元")

    records, excluded = deduplicate_records(raw_records)
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    write_json(output_dir / "welltrendvisa_projects.json", records)
    write_csv(output_dir / "welltrendvisa_projects.csv", records)
    write_overview(
        output_dir / "welltrendvisa_projects_overview.md",
        records,
    )
    write_summary(
        output_dir / "summary.json",
        records,
        len(raw_records),
        excluded,
        routes,
    )
    print(
        f"完成：展示单元 {len(raw_records)}；去重后项目 {len(records)}；"
        f"重复单元 {len(excluded)}"
    )
    print(f"输出目录：{output_dir}")
    return 0 if records else 1


if __name__ == "__main__":
    raise SystemExit(main())
