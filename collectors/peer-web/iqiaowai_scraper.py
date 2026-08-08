#!/usr/bin/env python3
"""抓取侨外出国（iqiaowai.com）官网当前公开展示的移民项目。

网站主体为静态 HTML。部分国家入口页同时包含多个项目，本程序会按页内
选项卡拆分；“热门海外身份”目录中的公开“了解更多”专题页也会继续跟进。
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import parse_qs, urljoin, urlparse, urlunparse

from lxml import etree, html


BASE_URL = "https://www.iqiaowai.com"
HOME_URL = f"{BASE_URL}/"
USER_AGENT = (
    "IQiaowaiPublicProjectResearch/1.0 "
    "(public project pages only; low-frequency)"
)
MAIN_PAGE_RE = re.compile(r"^/plus/view\.php$", re.IGNORECASE)
BLOCK_CLASS_XPATH = (
    'contains(concat(" ", normalize-space(@class), " "), " {name} ")'
)
FIXTURE_URLS = {
    "43733": f"{BASE_URL}/plus/view.php?aid=43733",
    "43735": f"{BASE_URL}/plus/view.php?aid=43735",
    "45240": f"{BASE_URL}/plus/view.php?aid=45240",
    "45241": f"{BASE_URL}/plus/view.php?aid=45241",
    "45242": f"{BASE_URL}/plus/view.php?aid=45242",
    "45243": f"{BASE_URL}/plus/view.php?aid=45243",
    "45262": f"{BASE_URL}/plus/view.php?aid=45262",
    "45264": f"{BASE_URL}/plus/view.php?aid=45264",
    "45265": f"{BASE_URL}/plus/view.php?aid=45265",
    "45266": f"{BASE_URL}/plus/view.php?aid=45266",
    "45267": f"{BASE_URL}/plus/view.php?aid=45267",
    "46682": f"{BASE_URL}/plus/view.php?aid=46682",
    "detail-antigua": f"{BASE_URL}/antigua/index.html",
    "detail-dominic": f"{BASE_URL}/zhuanti/dominic171204/",
    "detail-grenada": f"{BASE_URL}/grenada/index.html",
    "detail-malta": f"{BASE_URL}/malta/",
    "detail-northmacedonia": f"{BASE_URL}/northmacedonia/",
    "detail-saintkitts": f"{BASE_URL}/saintkitts/",
    "detail-saintlucia": f"{BASE_URL}/zhuanti/saintlucia180117/",
    "detail-turkey": f"{BASE_URL}/turkey/",
    "detail-vanuatu": f"{BASE_URL}/zhuanti/vanuatu180327/",
}
MAIN_AID_CATEGORIES = {
    "45240": "中国香港",
    "45241": "马耳他",
    "45242": "新西兰",
    "45243": "日本",
    "45262": "葡萄牙",
    "45264": "美国",
    "45265": "希腊",
    "45266": "美国",
    "45267": "美国",
    "46682": "匈牙利",
}
PATH_CATEGORIES = (
    ("vanuatu", "瓦努阿图"),
    ("dominic", "多米尼克"),
    ("saintkitts", "圣基茨和尼维斯"),
    ("saintlucia", "圣卢西亚"),
    ("turkey", "土耳其"),
    ("malta", "马耳他"),
    ("antigua", "安提瓜和巴布达"),
    ("grenada", "格林纳达"),
    ("northmacedonia", "北马其顿"),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="抓取 iqiaowai.com 当前公开展示的移民项目"
    )
    parser.add_argument(
        "--output-dir",
        default="output/iqiaowai",
        help="输出目录，默认：output/iqiaowai",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.8,
        help="页面请求之间的等待秒数，默认：0.8",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="只抓前 N 个首页入口；0 表示全部",
    )
    parser.add_argument(
        "--url",
        action="append",
        dest="urls",
        help="只抓指定网址；可重复传入",
    )
    parser.add_argument(
        "--fixture-dir",
        help="从已下载的 HTML 目录读取，用于离线测试",
    )
    return parser.parse_args()


def http_get(url: str, timeout: int = 40) -> tuple[bytes, str]:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
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


def one_line(value: str | None) -> str:
    return re.sub(r"\s+", " ", normalize_text(value))


def element_text(node: etree._Element | None) -> str:
    return normalize_text(node.text_content()) if node is not None else ""


def first(nodes: Iterable[etree._Element]) -> etree._Element | None:
    return next(iter(nodes), None)


def parse_document(data: bytes) -> html.HtmlElement:
    parser = html.HTMLParser(encoding="utf-8", recover=True)
    return html.fromstring(data, parser=parser, base_url=BASE_URL)


def normalize_public_url(value: str) -> str | None:
    url = urljoin(BASE_URL, value.strip())
    parsed = urlparse(url)
    if parsed.netloc.lower() not in {
        "iqiaowai.com",
        "www.iqiaowai.com",
    }:
        return None
    if parsed.path.startswith("/sn/"):
        return None
    return urlunparse(
        ("https", "www.iqiaowai.com", parsed.path or "/", "", parsed.query, "")
    )


def aid_from_url(url: str) -> str:
    parsed = urlparse(url)
    if not MAIN_PAGE_RE.fullmatch(parsed.path):
        return ""
    values = parse_qs(parsed.query).get("aid", [])
    return values[0] if values and values[0].isdigit() else ""


def category_from_url(url: str, document: html.HtmlElement | None = None) -> str:
    aid = aid_from_url(url)
    if aid in MAIN_AID_CATEGORIES:
        return MAIN_AID_CATEGORIES[aid]
    path = urlparse(url).path.lower()
    for hint, category in PATH_CATEGORIES:
        if hint in path:
            return category
    if document is not None:
        heading = first(document.xpath('//*[@id="qw-2019-project"]//h1 | '
                                       '//*[@id="qw-2019-project"]//h3'))
        value = one_line(element_text(heading))
        value = re.sub(r"^(?:侨外|移民)", "", value)
        value = re.sub(r"(?:身份怎么拿|移民)$", "", value)
        if value:
            return value
    return "未分类"


def discover_main_urls(explicit_urls: list[str] | None) -> list[str]:
    if explicit_urls:
        result: list[str] = []
        for value in explicit_urls:
            normalized = normalize_public_url(value)
            if normalized and normalized not in result:
                result.append(normalized)
        return result

    data, _ = http_get(HOME_URL)
    document = parse_document(data)
    result: list[str] = []
    for href in document.xpath("//a/@href"):
        normalized = normalize_public_url(href)
        if not normalized:
            continue
        aid = aid_from_url(normalized)
        if aid and normalized not in result:
            result.append(normalized)
    if not result:
        raise RuntimeError("首页未发现任何 /plus/view.php?aid=... 项目入口")
    return result


def class_xpath(name: str) -> str:
    return BLOCK_CLASS_XPATH.format(name=name)


def clean_label(value: str) -> str:
    value = one_line(value).strip("：: ")
    return value


def add_field(
    fields: dict[str, list[str]], label: str, values: Iterable[str]
) -> None:
    label = clean_label(label)
    if not label or label in {"在线咨询", "查看详情", "免费在线评估"}:
        return
    bucket = fields.setdefault(label, [])
    for value in values:
        text = normalize_text(value)
        if text and text not in bucket:
            bucket.append(text)


def extract_dt_fields(container: etree._Element) -> dict[str, list[str]]:
    fields: dict[str, list[str]] = {}
    label = ""
    for node in container.xpath(".//dt | .//dd"):
        text = element_text(node)
        if node.tag.lower() == "dt":
            label = clean_label(text)
            if label:
                fields.setdefault(label, [])
        elif label and text and text not in fields[label]:
            fields[label].append(text)
    return {key: values for key, values in fields.items() if values}


def extract_key_fields(container: etree._Element) -> dict[str, list[str]]:
    fields: dict[str, list[str]] = {}
    keys = container.xpath(f'.//*[{class_xpath("key")}]')
    for key in keys:
        value = key.getnext()
        if value is None:
            continue
        add_field(fields, element_text(key), [element_text(value)])
    return fields


def merge_fields(
    *sources: dict[str, list[str]],
) -> dict[str, list[str]]:
    merged: dict[str, list[str]] = {}
    for source in sources:
        for label, values in source.items():
            add_field(merged, label, values)
    return merged


def field_values(
    fields: dict[str, list[str]],
    *,
    contains: tuple[str, ...] = (),
    exact: tuple[str, ...] = (),
) -> list[str]:
    result: list[str] = []
    for label, values in fields.items():
        if label in exact or any(token in label for token in contains):
            for value in values:
                if value not in result:
                    result.append(value)
    return result


NUMBERED_SPLIT_RE = re.compile(
    r"(?:(?<=\s)|^)(?=(?:（\d{1,2}）|\(\d{1,2}\)|"
    r"\d{1,2}[、.)．）]))"
)


def split_items(values: Iterable[str]) -> list[str]:
    result: list[str] = []
    for value in values:
        text = normalize_text(value)
        if not text:
            continue
        chunks = [one_line(chunk) for chunk in NUMBERED_SPLIT_RE.split(text)]
        chunks = [chunk for chunk in chunks if chunk]
        if len(chunks) == 1 and "\n" in text:
            chunks = [one_line(chunk) for chunk in text.splitlines() if one_line(chunk)]
        for chunk in chunks:
            if chunk not in result:
                result.append(chunk)
    return result


def process_steps(values: Iterable[str]) -> list[dict[str, Any]]:
    raw_values = list(values)
    pieces: list[str] = []
    for value in raw_values:
        if "→" in value:
            pieces.extend(one_line(part) for part in value.split("→"))
        else:
            pieces.extend(split_items([value]))
    result: list[dict[str, Any]] = []
    for piece in pieces:
        piece = one_line(piece)
        piece = re.sub(
            r"^(?:（\d+）|\(\d+\)|\d+[、.)．）])\s*", "", piece
        )
        if not piece:
            continue
        result.append(
            {
                "number": len(result) + 1,
                "stage": piece[:80],
                "details": piece,
                "raw_text": piece,
            }
        )
    return result


MONEY_RE = re.compile(
    r"(?:¥|￥|\$)?\s*\d+(?:[,.]\d+)?\s*(?:万|亿|W|w)?\s*"
    r"(?:美元|美金|欧元|欧|人民币|港元|港币|纽币|日元|元)"
)


def derive_financial_requirements(texts: Iterable[str]) -> list[str]:
    result: list[str] = []
    keywords = (
        "净资产",
        "流动资金",
        "资产证明",
        "注册资本",
        "年收入",
        "费用",
        "投资额",
        "投资金额",
        "捐款",
        "购房",
        "存入",
    )
    for text in texts:
        for sentence in re.split(r"[。；;\n]+", normalize_text(text)):
            sentence = one_line(sentence).strip("，, ")
            if (
                sentence
                and (MONEY_RE.search(sentence) or any(k in sentence for k in keywords))
                and sentence not in result
            ):
                result.append(sentence)
    return result


def infer_identity_type(project_name: str, fields: dict[str, list[str]]) -> str:
    source = project_name + " " + " ".join(
        value for values in fields.values() for value in values
    )
    if re.search(r"护照|公民|入籍", source):
        return "公民身份"
    if re.search(r"永居|永久居留|绿卡", source):
        return "永久居留"
    if re.search(r"签证|工签|高才通|优才", source):
        return "签证/居留身份"
    return "居留身份"


def qualify_project_name(category: str, value: str) -> str:
    name = one_line(value)
    name = re.sub(r"^侨外", "", name)
    name = re.sub(r"\s+(?:预计|捐款|占用资金).*$", "", name)
    aliases = {
        "中国香港": ("香港",),
        "安提瓜和巴布达": ("安提瓜",),
        "圣基茨和尼维斯": ("圣基茨",),
    }
    already_qualified = category in name or any(
        alias in name for alias in aliases.get(category, ())
    )
    prefix = "香港" if category == "中国香港" else category
    if category not in {"未分类", "全球公民身份"} and not already_qualified:
        name = f"{prefix}{name}"
    return name


def build_record(
    *,
    project_name: str,
    category: str,
    source_url: str,
    fields: dict[str, list[str]],
    project_index: int,
    page_title: str = "",
    process_image_urls: list[str] | None = None,
) -> dict[str, Any]:
    project_name = qualify_project_name(category, project_name)
    intro_values = field_values(
        fields,
        contains=("项目简介", "项目介绍", "政策解读"),
        exact=("解读",),
    )
    advantage_values: list[str] = []
    for label, values in fields.items():
        if "优势" in label and "侨外优势" not in label:
            advantage_values.extend(
                value for value in values if value not in advantage_values
            )
    condition_values = field_values(
        fields,
        contains=("申请条件", "申办条件", "申请要求", "主申请人条件"),
    )
    if not condition_values:
        condition_values = field_values(fields, exact=("主申请人",))
    if not condition_values:
        condition_values = field_values(fields, contains=("投资要求",))
    application_flow = field_values(
        fields, contains=("申请流程", "捐款申请流程")
    )
    handling_flow = field_values(fields, contains=("办理流程",))
    cycle_values = field_values(
        fields, contains=("办理周期", "审批周期", "整体周期", "投资周期")
    )
    investment_values = field_values(
        fields,
        contains=(
            "投资额",
            "投资金额",
            "投资要求",
            "投资方式",
            "总体费用",
            "项目总体费用",
        ),
        exact=("费用", "费 用"),
    )
    direct_investment_values = field_values(
        fields,
        contains=("投资额", "投资金额", "投资要求", "投资方式"),
    )
    investment_requirements = split_items(direct_investment_values)
    searchable_conditions = split_items(condition_values)
    for item in searchable_conditions:
        if re.search(r"投资|捐款|购房|基金|存入|注册资本", item):
            if item not in investment_requirements:
                investment_requirements.append(item)

    advantages = split_items(advantage_values)
    conditions = split_items(condition_values)
    application_steps = process_steps(application_flow)
    handling_steps = process_steps(handling_flow)
    all_flow = [*application_flow, *handling_flow]
    images = process_image_urls or []
    process_type = (
        "html_text"
        if all_flow
        else "image_only"
        if images
        else "summary_only"
        if cycle_values
        else "missing"
    )
    intro = "\n".join(intro_values)
    finance_source = [
        *investment_values,
        *condition_values,
        *intro_values,
        *advantage_values,
    ]
    financial_requirements = derive_financial_requirements(finance_source)
    investment_amount = "；".join(
        requirement
        for requirement in financial_requirements
        if MONEY_RE.search(requirement)
    )
    if not investment_amount:
        investment_amount = "；".join(investment_values)
    all_field_values = [
        value for values in fields.values() for value in values
    ]
    for value in all_field_values:
        for sentence in re.split(r"[。；;\n]+", normalize_text(value)):
            sentence = one_line(sentence).strip("，, ")
            if (
                sentence
                and re.search(r"投资|捐款|捐献|购房|基金|存款|注册资本", sentence)
                and sentence not in investment_requirements
            ):
                investment_requirements.append(sentence)
    raw_text = " ".join(
        value for values in fields.values() for value in values
    )
    is_investment = bool(
        re.search(r"投资|购房|基金|捐款|捐献|国债|存款", project_name)
        or investment_requirements
        or re.search(r"投资入籍|注册资本", raw_text)
    )
    return {
        "company_name": "侨外出国（侨外移民）",
        "source_domain": "iqiaowai.com",
        "scrape_status": "ok",
        "error": "",
        "source_url": source_url,
        "requested_url": source_url,
        "page_title": page_title,
        "project_id": (
            f"{aid_from_url(source_url)}-{project_index}"
            if aid_from_url(source_url)
            else f"{urlparse(source_url).path.strip('/').replace('/', '-')}"
            f"-{project_index}"
        ),
        "project_name": project_name,
        "category": category,
        "introduction_summary": one_line(intro)[:180],
        "introduction": intro,
        "is_investment_project": is_investment,
        "investment_amount": investment_amount,
        "investment_requirements": investment_requirements,
        "financial_requirements": financial_requirements,
        "advantages": advantages,
        "advantages_text": "\n".join(advantage_values),
        "application_conditions": conditions,
        "application_conditions_text": "\n".join(condition_values),
        "process_summary": "；".join(cycle_values),
        "process_source_type": process_type,
        "process_text": "\n".join(all_flow),
        "process_image_urls": images,
        "application_process": application_steps,
        "handling_process": handling_steps or application_steps,
        "identity_type": infer_identity_type(project_name, fields),
        "residence_requirement": "",
        "raw_fields": fields,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
    }


def page_title(document: html.HtmlElement) -> str:
    return one_line(" ".join(document.xpath("//title/text()")))


def extract_tabbed_records(
    document: html.HtmlElement, source_url: str, category: str
) -> list[dict[str, Any]]:
    names = [
        element_text(node)
        for node in document.xpath(
            f'//*[ {class_xpath("tab_ul1dmg")} ]//li'
        )
    ]
    panels = document.xpath(f'//*[ {class_xpath("xxknrdmg")} ]')
    if not names or len(names) != len(panels):
        return []
    return [
        build_record(
            project_name=name,
            category=category,
            source_url=source_url,
            fields=merge_fields(
                extract_dt_fields(panel), extract_key_fields(panel)
            ),
            project_index=index,
            page_title=page_title(document),
        )
        for index, (name, panel) in enumerate(zip(names, panels), start=1)
    ]


def extract_qwrndd_records(
    document: html.HtmlElement, source_url: str, category: str
) -> list[dict[str, Any]]:
    qwrndd_nodes = document.xpath(f'//*[ {class_xpath("qwrndd")} ]')
    if not qwrndd_nodes:
        return []
    container = qwrndd_nodes[0]
    panels = container.xpath(f'.//*[ {class_xpath("rbqz1")} ]')
    if not panels:
        return []
    nav = first(
        container.xpath(f'.//*[ {class_xpath("qwrndd_nav")} ]')
    )
    names: list[str] = []
    if nav is not None:
        names = [
            one_line(element_text(node))
            for node in nav.xpath(f'.//*[ {class_xpath("name")} ]')
            if one_line(element_text(node))
        ]
        if not names:
            children = [node for node in nav if isinstance(node.tag, str)]
            names = [
                one_line(element_text(node))
                for node in children
                if one_line(element_text(node))
            ]
        if not names and element_text(nav):
            names = [one_line(element_text(nav))]
    if not names:
        return []

    # 被 HTML 注释隐藏的旧选项仍可能留下内容面板，只处理当前可见名称对应面板。
    panels = panels[: len(names)]
    records: list[dict[str, Any]] = []
    for index, (name, panel) in enumerate(zip(names, panels), start=1):
        records.append(
            build_record(
                project_name=name,
                category=category,
                source_url=source_url,
                fields=merge_fields(
                    extract_dt_fields(panel), extract_key_fields(panel)
                ),
                project_index=index,
                page_title=page_title(document),
            )
        )
    return records


def extract_new_zealand_records(
    document: html.HtmlElement, source_url: str
) -> list[dict[str, Any]]:
    containers = document.xpath(f'//*[ {class_xpath("qw-new-project")} ]')
    if not containers:
        return []
    container = containers[0]
    category_names = [
        one_line(element_text(node))
        for node in container.xpath(f'./*[ {class_xpath("hd")} ]//li')
    ]
    category_panels = container.xpath(
        f'.//*[ {class_xpath("qw-ca-box")} ]'
    )
    records: list[dict[str, Any]] = []
    index = 0
    for group_name, group in zip(category_names, category_panels):
        names = [
            one_line(element_text(node))
            for node in group.xpath(
                f'./*[ {class_xpath("types")} ]//li'
            )
        ]
        panels = group.xpath(
            f'./*[ {class_xpath("details")} ]'
            f'/*[ {class_xpath("item")} ]'
        )
        for name, panel in zip(names, panels):
            index += 1
            fields = merge_fields(
                extract_key_fields(panel), extract_dt_fields(panel)
            )
            add_field(fields, "项目类别", [group_name])
            records.append(
                build_record(
                    project_name=name,
                    category="新西兰",
                    source_url=source_url,
                    fields=fields,
                    project_index=index,
                    page_title=page_title(document),
                )
            )
    return records


def extract_single_key_record(
    document: html.HtmlElement, source_url: str, category: str
) -> list[dict[str, Any]]:
    boxes = document.xpath(
        f'//*[@id="qw-2019-project"]//*[ {class_xpath("qw-tk-box")} ]'
    )
    if not boxes:
        return []
    box = boxes[0]
    heading = first(
        document.xpath(
            f'//*[@id="qw-2019-project"]//*[ {class_xpath("hd")} ]'
        )
    )
    name = element_text(heading) or f"{category}身份项目"
    return [
        build_record(
            project_name=name,
            category=category,
            source_url=source_url,
            fields=merge_fields(
                extract_key_fields(box), extract_dt_fields(box)
            ),
            project_index=1,
            page_title=page_title(document),
        )
    ]


def extract_japan_records(
    document: html.HtmlElement, source_url: str
) -> list[dict[str, Any]]:
    table = first(document.xpath('//*[@id="part_2"]//table'))
    if table is None:
        return []
    rows = table.xpath(".//tr")
    if not rows:
        return []
    heading_cells = rows[0].xpath("./th|./td")
    names = [
        re.sub(r"^侨外(?:首推|独家)", "", one_line(element_text(cell)))
        for cell in heading_cells[1:]
    ]
    columns: list[dict[str, list[str]]] = [defaultdict(list) for _ in names]
    for row in rows[1:]:
        cells = row.xpath("./th|./td")
        if len(cells) < len(names) + 1:
            continue
        label = clean_label(element_text(cells[0]))
        for index, cell in enumerate(cells[1 : len(names) + 1]):
            add_field(columns[index], label, [element_text(cell)])

    advantage_nodes = document.xpath(
        '//*[@id="part_1"]//*[contains(concat(" ", normalize-space(@class), " "), " stit ")]'
    )
    advantages: list[str] = []
    for node in advantage_nodes:
        value = node.getnext()
        if value is not None:
            advantages.append(
                f"{one_line(element_text(node))}：{one_line(element_text(value))}"
            )
    all_conditions = [
        one_line(element_text(node))
        for node in document.xpath(
            '//*[@id="part_1"]//p[contains(concat(" ", normalize-space(@class), " "), " con ")]'
        )
    ]
    conditions = all_conditions[len(advantages) :]
    records: list[dict[str, Any]] = []
    for index, (name, fields) in enumerate(zip(names, columns), start=1):
        add_field(fields, "项目优势", advantages)
        add_field(fields, "申请条件", conditions)
        suitable = field_values(fields, exact=("适合人群",))
        if suitable:
            add_field(fields, "项目介绍", suitable)
        records.append(
            build_record(
                project_name=name,
                category="日本",
                source_url=source_url,
                fields=dict(fields),
                project_index=index,
                page_title=page_title(document),
            )
        )
    return records


def extract_vanuatu_record(
    document: html.HtmlElement, source_url: str
) -> list[dict[str, Any]]:
    intro = first(document.xpath('//*[@id="part_dy"]'))
    conditions = first(document.xpath('//*[@id="part_1"]'))
    process = first(document.xpath('//*[@id="part_2"]'))
    advantages = first(document.xpath('//*[@id="part_3"]'))
    if intro is None or conditions is None:
        return []
    condition_values = [
        one_line(element_text(node))
        for node in conditions.xpath(f'.//*[ {class_xpath("item")} ]')
    ] or [element_text(conditions)]
    next_box = first(
        conditions.xpath(
            f'following-sibling::*[ {class_xpath("box3")} ][1]'
        )
    )
    if next_box is not None:
        condition_values.append(element_text(next_box))
    advantage_values = (
        [
            one_line(element_text(node))
            for node in advantages.xpath(f'.//*[ {class_xpath("item")} ]')
        ]
        if advantages is not None
        else []
    )
    fields: dict[str, list[str]] = {}
    add_field(fields, "项目介绍", [element_text(intro)])
    add_field(fields, "申请条件", condition_values)
    if process is not None:
        process_body = first(
            process.xpath(f'./*[ {class_xpath("bodydiv")} ][1]')
        )
        add_field(
            fields,
            "办理流程",
            [element_text(process_body if process_body is not None else process)],
        )
    add_field(fields, "项目优势", advantage_values)
    return [
        build_record(
            project_name="瓦努阿图捐献入籍项目",
            category="瓦努阿图",
            source_url=source_url,
            fields=fields,
            project_index=1,
            page_title=page_title(document),
        )
    ]


def extract_saint_lucia_record(
    document: html.HtmlElement, source_url: str
) -> list[dict[str, Any]]:
    intro = first(document.xpath('//*[@id="part_1"]'))
    conditions = first(document.xpath('//*[@id="part_2"]'))
    advantages = first(document.xpath('//*[@id="part_3"]'))
    if intro is None or advantages is None:
        return []
    fields: dict[str, list[str]] = {}
    add_field(fields, "项目介绍", [element_text(intro)])
    if conditions is not None:
        add_field(fields, "申请条件", [element_text(conditions)])
    add_field(fields, "项目优势", [element_text(advantages)])
    return [
        build_record(
            project_name="圣卢西亚投资入籍项目",
            category="圣卢西亚",
            source_url=source_url,
            fields=fields,
            project_index=1,
            page_title=page_title(document),
        )
    ]


def collect_passport_detail_urls(document: html.HtmlElement) -> list[str]:
    result: list[str] = []
    sections = document.xpath('//*[@id="part_4"]')
    if not sections:
        return result
    for href in sections[0].xpath(
        f'.//*[ {class_xpath("item")} ]'
        f'//a[ {class_xpath("btn")} ]/@href'
    ):
        normalized = normalize_public_url(href)
        if normalized and normalized not in result:
            result.append(normalized)
    return result


def extract_records(
    data: bytes, source_url: str
) -> tuple[list[dict[str, Any]], list[str]]:
    document = parse_document(data)
    aid = aid_from_url(source_url)
    if aid == "43733":
        return [], collect_passport_detail_urls(document)
    if aid == "43735":
        return [], []

    path = urlparse(source_url).path.lower()
    if "vanuatu180327" in path:
        return extract_vanuatu_record(document, source_url), []
    if "saintlucia180117" in path:
        return extract_saint_lucia_record(document, source_url), []
    if aid == "45243":
        return extract_japan_records(document, source_url), []

    category = category_from_url(source_url, document)
    records = extract_new_zealand_records(document, source_url)
    if not records:
        records = extract_tabbed_records(document, source_url, category)
    if not records:
        records = extract_qwrndd_records(document, source_url, category)
    if not records:
        records = extract_single_key_record(document, source_url, category)
    return records, []


def record_score(record: dict[str, Any]) -> tuple[int, int]:
    populated = sum(
        bool(record.get(field))
        for field in (
            "introduction",
            "advantages",
            "application_conditions",
            "investment_requirements",
            "process_text",
            "process_summary",
        )
    )
    volume = sum(
        len(json.dumps(record.get(field), ensure_ascii=False))
        for field in (
            "introduction",
            "advantages",
            "application_conditions",
            "investment_requirements",
            "process_text",
        )
    )
    return populated, volume


def deduplicate_records(
    records: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        key_name = re.sub(r"[\s（）()\\-—_]+", "", record["project_name"]).lower()
        groups[(record.get("category", ""), key_name)].append(record)

    kept: list[dict[str, Any]] = []
    duplicates: list[dict[str, str]] = []
    for candidates in groups.values():
        ranked = sorted(candidates, key=record_score, reverse=True)
        kept.append(ranked[0])
        for dropped in ranked[1:]:
            duplicates.append(
                {
                    "project_name": ranked[0]["project_name"],
                    "kept_url": ranked[0]["source_url"],
                    "dropped_url": dropped["source_url"],
                }
            )
    kept.sort(key=lambda item: item.get("_order", 10**9))
    for record in kept:
        record.pop("_order", None)
    return kept, duplicates


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
        "# 侨外移民官网项目清单",
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
    visited_urls: list[str],
    duplicates: list[dict[str, str]],
    errors: list[dict[str, str]],
) -> None:
    categories: dict[str, int] = defaultdict(int)
    for record in records:
        categories[record.get("category") or "未分类"] += 1
    missing_by_field = {
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
    }
    summary = {
        "company_name": "侨外出国（侨外移民）",
        "source": BASE_URL,
        "visited_url_count": len(visited_urls),
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
        "summary_only_process_count": sum(
            1
            for record in records
            if record.get("process_source_type") == "summary_only"
        ),
        "missing_process_count": sum(
            1
            for record in records
            if record.get("process_source_type") == "missing"
        ),
        "categories": dict(sorted(categories.items())),
        "missing_by_field": missing_by_field,
        "duplicate_records": duplicates,
        "errors": errors,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    write_json(path, summary)


def fixture_documents(directory: Path) -> list[tuple[str, bytes, str]]:
    documents: list[tuple[str, bytes, str]] = []
    for stem, url in FIXTURE_URLS.items():
        path = directory / f"{stem}.html"
        if path.exists():
            documents.append((url, path.read_bytes(), url))
    return documents


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    errors: list[dict[str, str]] = []
    raw_records: list[dict[str, Any]] = []
    visited_urls: list[str] = []
    order = 0

    if args.fixture_dir:
        pages = fixture_documents(Path(args.fixture_dir).expanduser().resolve())
        print(f"离线读取 {len(pages)} 个 HTML 页面")
        for source_url, data, final_url in pages:
            visited_urls.append(source_url)
            try:
                records, _ = extract_records(data, final_url)
                for record in records:
                    record["_order"] = order
                    order += 1
                    raw_records.append(record)
                print(f"  {source_url}: {len(records)} 个项目")
            except Exception as exc:
                errors.append({"url": source_url, "error": str(exc)})
    else:
        main_urls = discover_main_urls(args.urls)
        if args.limit > 0:
            main_urls = main_urls[: args.limit]
        print(f"发现 {len(main_urls)} 个当前项目入口")
        child_urls: list[str] = []
        for index, url in enumerate(main_urls, start=1):
            print(f"[入口 {index}/{len(main_urls)}] {url}", flush=True)
            visited_urls.append(url)
            try:
                data, final_url = http_get(url)
                records, discovered_children = extract_records(data, url)
                for child_url in discovered_children:
                    if child_url not in child_urls:
                        child_urls.append(child_url)
                for record in records:
                    record["source_url"] = url
                    record["requested_url"] = url
                    record["_order"] = order
                    order += 1
                    raw_records.append(record)
                print(f"  拆分出 {len(records)} 个项目", flush=True)
            except Exception as exc:
                errors.append({"url": url, "error": str(exc)})
                print(f"  error: {exc}", file=sys.stderr)
            if args.delay > 0 and index < len(main_urls):
                time.sleep(args.delay)

        for index, url in enumerate(child_urls, start=1):
            print(f"[专题 {index}/{len(child_urls)}] {url}", flush=True)
            visited_urls.append(url)
            try:
                data, final_url = http_get(url)
                records, _ = extract_records(data, final_url)
                for record in records:
                    record["source_url"] = final_url
                    record["requested_url"] = url
                    record["_order"] = order
                    order += 1
                    raw_records.append(record)
                print(f"  拆分出 {len(records)} 个项目", flush=True)
            except Exception as exc:
                errors.append({"url": url, "error": str(exc)})
                print(f"  error: {exc}", file=sys.stderr)
            if args.delay > 0 and index < len(child_urls):
                time.sleep(args.delay)

    records, duplicates = deduplicate_records(raw_records)
    write_json(output_dir / "iqiaowai_projects.json", records)
    write_csv(output_dir / "iqiaowai_projects.csv", records)
    write_overview(output_dir / "iqiaowai_projects_overview.md", records)
    write_summary(
        output_dir / "summary.json",
        records,
        visited_urls,
        duplicates,
        errors,
    )
    print(
        f"完成：{len(records)} 个有效项目；"
        f"去重 {len(duplicates)} 条；错误 {len(errors)} 个"
    )
    print(f"输出目录：{output_dir}")
    return 0 if records else 1


if __name__ == "__main__":
    raise SystemExit(main())
