#!/usr/bin/env python3
"""抓取桉侨移民官网公开展示的移民项目详情。

数据入口：
1. sitemap.xml 中的简体中文 /detail/ 页面；
2. 当前前端 JavaScript 包中出现的 /detail/ 路由（用于补充 Sitemap 漏项）。

页面是 Vue 单页应用，因此详情字段使用 Playwright 渲染后提取。
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

from playwright.sync_api import (
    Browser,
    BrowserContext,
    Page,
    Route,
    sync_playwright,
)


BASE_URL = "https://www.aqyimin.com"
SITEMAP_URL = f"{BASE_URL}/sitemap.xml"
DEFAULT_CHROME_PATHS = (
    Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    Path("/Applications/Chromium.app/Contents/MacOS/Chromium"),
    Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
)
USER_AGENT = (
    "AqyiminPublicProjectResearch/1.0 "
    "(public pages only; low-frequency; contact: local research script)"
)
REPLACED_DETAIL_ROUTES = {
    # 官网 Sitemap 当前保留了空白旧地址，但前端实际项目地址为 jpnoperate。
    "pnoperate": "jpnoperate",
}


EXTRACT_PROJECT_JS = r"""
() => {
  const clean = (value) =>
    (value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const all = (root, selector) => Array.from(root.querySelectorAll(selector));
  const exactLeaf = (root, text) =>
    all(root, "*").find(
      (el) =>
        clean(el.textContent) === text &&
        !Array.from(el.children).some(
          (child) => clean(child.textContent) === text
        )
    );
  const directListItems = (root) => {
    if (!root) return [];
    const list = all(root, "ol, ul").find((candidate) =>
      Array.from(candidate.children).some((child) => child.tagName === "LI")
    );
    if (!list) return [];
    return Array.from(list.children)
      .filter((child) => child.tagName === "LI")
      .map((child) => clean(child.innerText))
      .filter(Boolean);
  };

  const mainCandidates = all(document, "div.flex.flex-col.w-full");
  const main = mainCandidates.sort(
    (a, b) => clean(b.innerText).length - clean(a.innerText).length
  )[0];

  if (!main) {
    return {
      scrape_status: "error",
      error: "未找到项目详情主容器",
      source_url: location.href,
    };
  }

  const directBlocks = Array.from(main.children);
  const breadcrumb = all(main, ".el-breadcrumb__item")
    .map((el) => clean(el.innerText))
    .filter(Boolean);

  const introBlock =
    directBlocks.find((block, index) => {
      if (index === 0) return false;
      const first = block.children && block.children[0];
      const text = clean(first && first.innerText);
      return (
        text &&
        !/优势|申请条件|申请流程|办理流程|为何选择/.test(text)
      );
    }) || directBlocks[1];

  const projectName =
    clean(introBlock && introBlock.children[0] && introBlock.children[0].innerText) ||
    breadcrumb[breadcrumb.length - 1] ||
    "";

  let introduction = "";
  if (introBlock) {
    const introCandidates = all(introBlock, "div").filter((el) => {
      const cls = String(el.className || "");
      const text = clean(el.innerText);
      return (
        cls.includes("w-[60%]") &&
        text.length >= 20 &&
        !text.startsWith("项目优势") &&
        !text.startsWith("申请条件")
      );
    });
    const introNode = introCandidates.sort(
      (a, b) => clean(a.innerText).length - clean(b.innerText).length
    )[0];
    if (introNode) {
      const clone = introNode.cloneNode(true);
      all(clone, "*").forEach((el) => {
        const text = clean(el.textContent);
        if (
          text === "自动在线评估" ||
          text === "加微信咨询" ||
          text === "在线评估"
        ) {
          el.remove();
        }
      });
      introduction = clean(clone.innerText)
        .replace(/自动在线评估/g, "")
        .replace(/加微信咨询/g, "")
        .trim();
    }
  }

  const advantagesLabel = exactLeaf(main, "项目优势");
  const advantagesBox = advantagesLabel && advantagesLabel.parentElement;
  const advantageItems = directListItems(advantagesBox);
  const advantagesText =
    advantagesBox && advantagesBox.children[1]
      ? clean(advantagesBox.children[1].innerText)
      : "";

  const conditionsLabel = exactLeaf(main, "申请条件");
  const conditionsBox = conditionsLabel && conditionsLabel.parentElement;
  const conditionItems = directListItems(conditionsBox);
  const conditionsText =
    conditionsBox && conditionsBox.children[1]
      ? clean(conditionsBox.children[1].innerText)
      : "";

  let processSection = null;
  let processSourceLabel = "";
  for (const block of directBlocks) {
    const heading = clean(block.children && block.children[0] && block.children[0].innerText);
    if (/申请流程|办理流程/.test(heading)) {
      processSection = block;
      processSourceLabel = heading;
      break;
    }
  }

  const processSummaryCandidates = processSection
    ? all(processSection, "div").filter((el) =>
        /^申请步骤共|^办理步骤共|^流程共/.test(clean(el.innerText))
      )
    : [];
  const processSummaryNode = processSummaryCandidates.sort(
    (a, b) => clean(a.innerText).length - clean(b.innerText).length
  )[0];
  const processSummary = clean(processSummaryNode && processSummaryNode.innerText);

  const processSteps = processSection
    ? all(processSection, ".el-step").map((step, index) => {
        const number = clean(
          (step.querySelector(".el-step__icon") || {}).innerText
        ) || String(index + 1);
        const stepLabel = clean(
          (step.querySelector(".el-step__title") || {}).innerText
        );
        const description = clean(
          (step.querySelector(".el-step__description") || {}).innerText
        );
        const lines = description.split(/\n+/).map(clean).filter(Boolean);
        return {
          number,
          step_label: stepLabel,
          stage: lines.length > 1 ? lines[0] : "",
          details: lines.length > 1 ? lines.slice(1).join("；") : description,
          raw_text: clean(step.innerText),
        };
      })
    : [];

  const sectionTexts = {};
  for (const block of directBlocks) {
    const heading = clean(block.children && block.children[0] && block.children[0].innerText);
    if (heading && /优势|申请条件|申请流程|办理流程|为何选择/.test(heading)) {
      sectionTexts[heading] = clean(block.innerText);
    }
  }

  const serviceBlock = directBlocks.find((block) => {
    const heading = clean(block.children && block.children[0] && block.children[0].innerText);
    return /为何选择/.test(heading);
  });
  const serviceFeatures = serviceBlock
    ? clean(serviceBlock.innerText)
    : "";

  const imageUrls = Array.from(
    new Set(
      all(main, "img")
        .map((img) => img.currentSrc || img.src || "")
        .filter(Boolean)
    )
  );

  return {
    scrape_status: projectName ? "ok" : "error",
    error: projectName ? "" : "项目名称为空",
    source_url: location.href,
    project_slug: location.pathname.split("/").filter(Boolean).pop() || "",
    category: breadcrumb.length >= 2 ? breadcrumb[breadcrumb.length - 2] : "",
    project_name: projectName,
    breadcrumb,
    introduction,
    advantages: advantageItems,
    advantages_text: advantagesText,
    application_conditions: conditionItems,
    application_conditions_text: conditionsText,
    process_source_label: processSourceLabel,
    process_summary: processSummary,
    application_process: processSteps,
    handling_process: processSteps,
    service_features: serviceFeatures,
    image_urls: imageUrls,
    raw_section_texts: sectionTexts,
  };
}
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="抓取 aqyimin.com 公开展示的简体中文移民项目"
    )
    parser.add_argument(
        "--output-dir",
        default="output",
        help="输出目录，默认：output",
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
        help="只抓指定项目 URL；可重复传入",
    )
    parser.add_argument(
        "--headful",
        action="store_true",
        help="显示浏览器窗口，默认使用无头模式",
    )
    parser.add_argument(
        "--chrome-path",
        help="Chrome/Chromium 可执行文件路径；默认自动检测",
    )
    return parser.parse_args()


def http_get(url: str, timeout: int = 30) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def normalize_project_url(value: str) -> str | None:
    url = urljoin(BASE_URL, value.strip())
    parsed = urlparse(url)
    if parsed.netloc not in {"www.aqyimin.com", "aqyimin.com"}:
        return None
    if not re.fullmatch(r"/detail/[A-Za-z0-9_-]+/?", parsed.path):
        return None
    slug = parsed.path.rstrip("/").split("/")[-1]
    return f"{BASE_URL}/detail/{slug}"


def discover_from_sitemap() -> list[str]:
    xml_data = http_get(SITEMAP_URL)
    root = ET.fromstring(xml_data)
    urls: list[str] = []
    for node in root.findall(".//{*}loc"):
        if not node.text:
            continue
        normalized = normalize_project_url(node.text)
        if normalized and normalized not in urls:
            urls.append(normalized)
    return urls


def discover_from_bundle() -> list[str]:
    home = http_get(f"{BASE_URL}/").decode("utf-8", errors="replace")
    match = re.search(
        r'<script[^>]+type=["\']module["\'][^>]+src=["\']([^"\']+)',
        home,
        re.IGNORECASE,
    )
    if not match:
        match = re.search(
            r'<script[^>]+src=["\']([^"\']+\.js)["\']',
            home,
            re.IGNORECASE,
        )
    if not match:
        return []
    bundle_url = urljoin(BASE_URL, match.group(1))
    bundle = http_get(bundle_url, timeout=60).decode("utf-8", errors="replace")
    urls: list[str] = []
    for path in re.findall(r'["\'](/detail/[A-Za-z0-9_-]+)["\']', bundle):
        normalized = normalize_project_url(path)
        if normalized and normalized not in urls:
            urls.append(normalized)
    return urls


def discover_project_urls(explicit_urls: list[str] | None) -> list[str]:
    if explicit_urls:
        normalized = [normalize_project_url(url) for url in explicit_urls]
        return [url for url in normalized if url]

    urls: list[str] = []
    discovery_errors: list[str] = []
    for label, discoverer in (
        ("sitemap", discover_from_sitemap),
        ("前端路由", discover_from_bundle),
    ):
        try:
            for url in discoverer():
                if url not in urls:
                    urls.append(url)
        except Exception as exc:  # 保留另一种发现方式继续运行
            discovery_errors.append(f"{label}: {exc}")

    if not urls:
        raise RuntimeError(
            "未发现任何项目 URL；" + "；".join(discovery_errors)
        )
    for old_slug, new_slug in REPLACED_DETAIL_ROUTES.items():
        old_url = f"{BASE_URL}/detail/{old_slug}"
        new_url = f"{BASE_URL}/detail/{new_slug}"
        if old_url in urls and new_url in urls:
            urls.remove(old_url)
    if discovery_errors:
        print("发现阶段警告：" + "；".join(discovery_errors), file=sys.stderr)
    return urls


def detect_chrome_path(explicit_path: str | None) -> str | None:
    if explicit_path:
        path = Path(explicit_path).expanduser()
        if not path.is_file():
            raise FileNotFoundError(f"浏览器不存在：{path}")
        return str(path)
    for path in DEFAULT_CHROME_PATHS:
        if path.is_file():
            return str(path)
    return None


def should_block(route: Route) -> None:
    request = route.request
    parsed = urlparse(request.url)
    blocked_hosts = {
        "www.googletagmanager.com",
        "googleads.g.doubleclick.net",
        "www.google-analytics.com",
        "lf1-cdn-tos.bytegoofy.com",
    }
    if request.resource_type in {"image", "media", "font"}:
        route.abort()
    elif parsed.netloc in blocked_hosts:
        route.abort()
    else:
        route.continue_()


def split_condition_text(text: str) -> list[str]:
    parts = re.split(r"[；;\n]+", text)
    return [part.strip(" \t\r\n、。") for part in parts if part.strip(" \t\r\n、。")]


def derive_investment_requirements(record: dict[str, Any]) -> list[str]:
    source = "。".join(
        [
            record.get("introduction", ""),
            record.get("application_conditions_text", ""),
        ]
    )
    sentences = re.split(r"[。！？；;\n]+", source)
    method_keywords = (
        "投资",
        "投入",
        "购房",
        "购买房产",
        "购买物业",
        "银行定存",
        "定期存款",
        "捐款",
        "基金投资",
        "基金",
        "投资金额",
        "投资额",
        "投资方式",
        "无需投资",
        "注册公司",
    )
    requirements: list[str] = []
    for sentence in sentences:
        sentence = re.sub(r"\s+", " ", sentence).strip(" ，,")
        if not sentence:
            continue
        if any(keyword in sentence for keyword in method_keywords):
            if sentence not in requirements:
                requirements.append(sentence)
    return requirements


def derive_financial_requirements(record: dict[str, Any]) -> list[str]:
    source = "。".join(
        [
            record.get("introduction", ""),
            record.get("application_conditions_text", ""),
        ]
    )
    sentences = re.split(r"[。！？；;\n]+", source)
    money_pattern = re.compile(
        r"\d+(?:\.\d+)?\s*(?:万|亿)?\s*"
        r"(?:美元|美金|欧元|欧|人民币|港币|日元|新币|英镑|元)"
    )
    financial_keywords = (
        "资金证明",
        "资产证明",
        "存款证明",
        "年收入",
        "营业额",
        "纳税",
        "注册资本",
        "费用",
    )
    requirements: list[str] = []
    for sentence in sentences:
        sentence = re.sub(r"\s+", " ", sentence).strip(" ，,")
        if not sentence:
            continue
        if money_pattern.search(sentence) or any(
            keyword in sentence for keyword in financial_keywords
        ):
            if sentence not in requirements:
                requirements.append(sentence)
    return requirements


def enhance_record(record: dict[str, Any], requested_url: str) -> dict[str, Any]:
    record["requested_url"] = requested_url
    record["scraped_at"] = datetime.now(timezone.utc).isoformat()
    if (
        not record.get("application_conditions")
        and record.get("application_conditions_text")
    ):
        record["application_conditions"] = split_condition_text(
            record["application_conditions_text"]
        )
    if not record.get("advantages") and record.get("advantages_text"):
        record["advantages"] = [record["advantages_text"]]

    record["investment_requirements"] = derive_investment_requirements(record)
    record["financial_requirements"] = derive_financial_requirements(record)
    project_name = record.get("project_name", "")
    record["is_investment_project"] = bool(
        re.search(
            r"投资|购房|房产|基金|存款模式|第二家园|黄金签证|创业居留",
            project_name,
        )
    )
    return record


def scrape_project(page: Page, url: str) -> dict[str, Any]:
    last_error: Exception | None = None
    for attempt in range(2):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=45_000)
            page.wait_for_selector(
                "div.flex.flex-col.w-full",
                state="attached",
                timeout=20_000,
            )
            record = page.evaluate(EXTRACT_PROJECT_JS)
            return enhance_record(record, url)
        except Exception as exc:
            last_error = exc
            if attempt == 0:
                continue

    return enhance_record(
        {
            "scrape_status": "error",
            "error": str(last_error) if last_error else "未知错误",
            "source_url": page.url,
            "project_slug": url.rstrip("/").split("/")[-1],
            "category": "",
            "project_name": "",
            "breadcrumb": [],
            "introduction": "",
            "advantages": [],
            "advantages_text": "",
            "application_conditions": [],
            "application_conditions_text": "",
            "process_source_label": "",
            "process_summary": "",
            "application_process": [],
            "handling_process": [],
            "service_features": "",
            "image_urls": [],
            "raw_section_texts": {},
        },
        url,
    )


def launch_browser(playwright: Any, chrome_path: str | None, headless: bool) -> Browser:
    kwargs: dict[str, Any] = {
        "headless": headless,
        "args": [
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-sync",
        ],
    }
    if chrome_path:
        kwargs["executable_path"] = chrome_path
    return playwright.chromium.launch(**kwargs)


def create_context(browser: Browser) -> BrowserContext:
    return browser.new_context(
        viewport={"width": 1440, "height": 900},
        locale="zh-CN",
        user_agent=USER_AGENT,
        service_workers="block",
    )


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def write_csv(path: Path, records: list[dict[str, Any]]) -> None:
    fields = [
        "project_name",
        "category",
        "project_slug",
        "is_investment_project",
        "source_url",
        "introduction",
        "investment_requirements",
        "financial_requirements",
        "advantages",
        "application_conditions",
        "process_summary",
        "application_process",
        "handling_process",
        "service_features",
        "image_urls",
        "scrape_status",
        "error",
        "scraped_at",
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for record in records:
            row = {}
            for field in fields:
                value = record.get(field, "")
                if isinstance(value, (list, dict)):
                    value = json.dumps(value, ensure_ascii=False)
                row[field] = value
            writer.writerow(row)


def write_summary(path: Path, records: list[dict[str, Any]], urls: list[str]) -> None:
    successful = [r for r in records if r.get("scrape_status") == "ok"]
    categories: dict[str, int] = {}
    for record in successful:
        category = record.get("category") or "未分类"
        categories[category] = categories.get(category, 0) + 1
    summary = {
        "source": BASE_URL,
        "discovered_url_count": len(urls),
        "record_count": len(records),
        "successful_count": len(successful),
        "failed_count": len(records) - len(successful),
        "investment_project_count": sum(
            1 for record in successful if record.get("is_investment_project")
        ),
        "categories": dict(sorted(categories.items())),
        "failed_urls": [
            {
                "url": record.get("requested_url"),
                "error": record.get("error"),
            }
            for record in records
            if record.get("scrape_status") != "ok"
        ],
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    write_json(path, summary)


def write_markdown_overview(path: Path, records: list[dict[str, Any]]) -> None:
    successful = [r for r in records if r.get("scrape_status") == "ok"]
    grouped: dict[str, list[dict[str, Any]]] = {}
    for record in successful:
        grouped.setdefault(record.get("category") or "未分类", []).append(record)

    lines = [
        "# 桉侨移民官网项目清单",
        "",
        f"共采集 {len(successful)} 个简体中文官网项目，按官网分类整理。",
        "",
    ]
    for category, items in sorted(grouped.items()):
        lines.extend([f"## {category}（{len(items)}）", ""])
        for item in items:
            name = item.get("project_name") or item.get("project_slug")
            url = item.get("source_url") or item.get("requested_url")
            lines.append(f"- [{name}]({url})")
        lines.append("")

    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    urls = discover_project_urls(args.urls)
    if args.limit > 0:
        urls = urls[: args.limit]
    print(f"发现 {len(urls)} 个候选项目页面")

    chrome_path = detect_chrome_path(args.chrome_path)
    records: list[dict[str, Any]] = []

    with sync_playwright() as playwright:
        browser = launch_browser(playwright, chrome_path, not args.headful)
        context = create_context(browser)
        page = context.new_page()
        page.route("**/*", should_block)
        try:
            for index, url in enumerate(urls, start=1):
                print(f"[{index}/{len(urls)}] {url}", flush=True)
                record = scrape_project(page, url)
                records.append(record)
                status = record.get("scrape_status")
                name = record.get("project_name") or "(未识别)"
                print(f"  {status}: {name}", flush=True)
                if args.delay > 0 and index < len(urls):
                    time.sleep(args.delay)
        finally:
            context.close()
            browser.close()

    json_path = output_dir / "aqyimin_projects.json"
    csv_path = output_dir / "aqyimin_projects.csv"
    summary_path = output_dir / "summary.json"
    overview_path = output_dir / "aqyimin_projects_overview.md"
    write_json(json_path, records)
    write_csv(csv_path, records)
    write_summary(summary_path, records, urls)
    write_markdown_overview(overview_path, records)

    successful_count = sum(1 for r in records if r.get("scrape_status") == "ok")
    print(f"完成：成功 {successful_count}/{len(records)}")
    print(f"JSON：{json_path}")
    print(f"CSV：{csv_path}")
    print(f"摘要：{summary_path}")
    print(f"项目清单：{overview_path}")
    return 0 if successful_count else 1


if __name__ == "__main__":
    raise SystemExit(main())
