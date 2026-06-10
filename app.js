const maxFilterChips = 18;
const filterViews = ["home", "all"];
const toolbarViews = ["home", "all"];
const filterCategoryStorageKey = "yiminHot.filterCategory";

function buildSnapshots(items) {
  const countryMap = {};
  for (const item of items) {
    const key = item.country || "其他";
    if (!countryMap[key]) countryMap[key] = [];
    countryMap[key].push(item);
  }

  const countryNames = { "美国": "美国 EB-5/职业移民", "加拿大": "加拿大 EE/PNP", "澳新": "澳新技术路径", "英国": "英国工签/担保", "欧洲": "欧洲投资居留" };
  const topCountries = Object.entries(countryMap)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 4);

  if (!topCountries.length) {
    return [{ title: "暂无数据", text: "等待信源抓取后自动生成项目快照。" }];
  }

  return topCountries.map(([country, articles]) => {
    const tags = [...new Set(articles.flatMap((a) => a.tags || []))].slice(0, 4);
    const topCategories = [...new Set(articles.map((a) => a.category))].slice(0, 3);
    const label = countryNames[country] || country;
    return {
      title: label,
      text: topCategories.join("、") + (tags.length ? "、相关话题：" + tags.join("、") : "") + `。共 ${articles.length} 条动态。`,
    };
  });
}

function buildRadarItems(items) {
  const keywordRules = [
    { title: "排期风险", keywords: ["排期", "visa bulletin", "priority date", "等待", "排期"], label: "高" },
    { title: "资金合规", keywords: ["资金", "investor", "投资", "source of funds", "合规"], label: "高" },
    { title: "雇主依赖", keywords: ["employer", "employer", "担保", "sponsor", "雇主", "lmia"], label: "中" },
    { title: "材料周期", keywords: ["材料", "document", "认证", "评估", "语言"], label: "中" },
    { title: "政策变动", keywords: ["policy", "政策", "rule", "regulation", "fee", "新规"], label: "中" },
    { title: "签证动态", keywords: ["visa", "签证", "permit", "工签", "绿卡"], label: "低" },
  ];

  return keywordRules.map((rule) => {
    const matched = items.filter((item) => {
      const text = `${item.title} ${item.summary} ${(item.tags || []).join(" ")}`.toLowerCase();
      return rule.keywords.some((kw) => text.includes(kw));
    });
    const count = matched.length;
    const baseValue = rule.label === "高" ? 75 : rule.label === "中" ? 55 : 40;
    const value = Math.min(99, Math.max(30, baseValue + count * 3));
    const riskLevel = value >= 75 ? "high" : value >= 55 ? "medium" : "low";
    const riskText = value >= 75 ? "高" : value >= 55 ? "中" : "低";
    const countries = [...new Set(matched.map((m) => m.country).filter(Boolean))].slice(0, 3).join("、");

    return {
      title: rule.title,
      keywords: rule.keywords,
      matched,
      risk: riskLevel,
      riskText,
      value,
      count,
      text: count > 0
        ? `${countries || "多个国家"}相关动态 ${count} 条，需要关注最新变化。`
        : "近期暂无明显风险信号，保持关注即可。",
    };
  });
}

const state = {
  view: "home",
  category: "全部",
  query: "",
  items: [],
  radarDetail: null,
  marketReportData: null,
  marketLoading: false,
  marketError: "",
  marketHistory: [],
  marketDate: null,
  sourceStatus: [],
  dailyReport: null,
  dailyLoading: false,
  dailyHistory: [],
  dailyDate: null,
  ssoStats: null,
  ssoStatsLoading: false,
  ssoStatsError: "",
  feedbackItems: [],
  feedbackLoading: false,
  feedbackError: "",
  feedbackStatus: "all",
  ssoUserName: sessionStorage.getItem("yiminSsoUserName") || "",
  ssoUserId: sessionStorage.getItem("yiminSsoUserId") || "",
  liveMeta: {
    mode: "idle",
    text: "等待真实信源数据",
  },
  fetchRun: null,
  user: null,
};

const authViews = ["market", "sources", "review", "sso-stats", "feedback-review", "about"];
const views = ["home", "all", "daily", "market", "radar", "feedback", "login", "sources", "review", "sso-stats", "feedback-review", "about", "changelog"];

const filterStrip = document.querySelector("#filterStrip");
const featuredFeed = document.querySelector("#featuredFeed");
const allFeed = document.querySelector("#allFeed");
const snapshotList = document.querySelector("#snapshotList");
const radarGrid = document.querySelector("#radarGrid");
const searchInput = document.querySelector("#searchInput");
const homeCount = document.querySelector("#homeCount");
const allCount = document.querySelector("#allCount");
const dailyReport = document.querySelector("#dailyReport");
const marketReport = document.querySelector("#marketReport");
const ssoStatsReport = document.querySelector("#ssoStatsReport");
const feedbackReviewList = document.querySelector("#feedbackReviewList");
const feedbackReviewFilters = document.querySelector("#feedbackReviewFilters");
const monitorStatus = document.querySelector("#monitorStatus");
const sourceHealth = document.querySelector("#sourceHealth");
const refreshNews = document.querySelector("#refreshNews");
const toolbar = document.querySelector(".toolbar");
let fetchRunPollTimer = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function getShanghaiDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function safeUrl(value) {
  if (!value) {
    return "";
  }

  try {
    const url = new URL(value, window.location.href);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function linkifyPlainUrls(root) {
  if (!root) {
    return;
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!/https?:\/\//i.test(node.nodeValue || "")) {
        return NodeFilter.FILTER_REJECT;
      }
      if (node.parentElement?.closest("a, button, script, style")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes = [];
  while (walker.nextNode()) {
    textNodes.push(walker.currentNode);
  }

  const urlPattern = /https?:\/\/[^\s<>"']+/gi;
  textNodes.forEach((node) => {
    const text = node.nodeValue || "";
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let changed = false;

    text.replace(urlPattern, (rawUrl, index) => {
      const trailing = rawUrl.match(/[),，。；;!！?？、\]】）]+$/)?.[0] || "";
      const href = rawUrl.slice(0, rawUrl.length - trailing.length);
      const safeHref = safeUrl(href);

      fragment.appendChild(document.createTextNode(text.slice(lastIndex, index)));
      if (safeHref) {
        const link = document.createElement("a");
        link.href = safeHref;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = href;
        fragment.appendChild(link);
        changed = true;
      } else {
        fragment.appendChild(document.createTextNode(rawUrl));
      }
      if (trailing) {
        fragment.appendChild(document.createTextNode(trailing));
      }
      lastIndex = index + rawUrl.length;
      return rawUrl;
    });

    if (!changed) {
      return;
    }

    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    node.parentNode?.replaceChild(fragment, node);
  });
}

function matchesItem(item) {
  const itemLabels = getItemFilterLabels(item);
  const inCategory =
    state.category === "全部" ||
    itemLabels.includes(state.category);

  const query = state.query.trim().toLowerCase();
  const inQuery =
    !query ||
    [item.title, item.summary, item.source, item.country, item.category, ...(item.tags || [])]
      .join(" ")
      .toLowerCase()
      .includes(query);

  return inCategory && inQuery;
}

function filteredItems() {
  return state.items.filter(matchesItem).sort((a, b) => b.heat - a.heat);
}

function looksLikeGarbledText(value) {
  const text = String(value || "");
  if (!text) return false;
  if (/[�]/.test(text)) return true;
  if (/%[0-9a-f]{2}/i.test(text)) return true;
  if (/[ÃÂ]|â[€\u0080-\u00bf]/.test(text)) return true;

  const mojibakeChars = text.match(/[æçåäèêëìíîïðñòóôõöùúûüýÿ]/g) || [];
  return mojibakeChars.length >= 2 && !/[\u4e00-\u9fff]/.test(text);
}

function cleanFilterLabel(label) {
  const text = String(label || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text || text === "全部") {
    return "";
  }

  if (text.length > 24 || /^https?:\/\//i.test(text) || looksLikeGarbledText(text)) {
    return "";
  }

  if (!/^[\p{L}\p{N}][\p{L}\p{N}\s/&+().·-]{0,23}$/u.test(text)) {
    return "";
  }

  return text;
}

function getItemFilterLabels(item) {
  return [item.country, item.category, ...(item.tags || [])]
    .map(cleanFilterLabel)
    .filter(Boolean);
}

function saveFilterCategory() {
  try {
    sessionStorage.setItem(filterCategoryStorageKey, state.category);
  } catch {
    // ignore storage errors
  }
}

function setCategory(category) {
  const raw = String(category || "").trim();
  const cleaned = cleanFilterLabel(raw);
  state.category = raw === "全部" || !cleaned ? "全部" : cleaned;
  saveFilterCategory();
}

function restoreFilterCategory() {
  try {
    const savedCategory = sessionStorage.getItem(filterCategoryStorageKey);
    if (savedCategory) {
      setCategory(savedCategory);
    }
  } catch {
    // ignore storage errors
  }
}

function getDynamicCategories() {
  const categoryMap = new Map();

  function addCategory(label, item) {
    const name = cleanFilterLabel(label);
    if (!name) {
      return;
    }

    const current = categoryMap.get(name) || { name, count: 0, heat: 0 };
    current.count += 1;
    current.heat += Number(item.heat || 0);
    categoryMap.set(name, current);
  }

  state.items.forEach((item) => {
    getItemFilterLabels(item).forEach((label) => addCategory(label, item));
  });

  const dynamicCategories = [...categoryMap.values()]
    .sort((a, b) => b.count - a.count || b.heat - a.heat || a.name.localeCompare(b.name, "zh-Hans-CN"))
    .slice(0, maxFilterChips)
    .map((item) => item.name);

  if (state.category !== "全部") {
    const currentCategory = cleanFilterLabel(state.category);
    if (!currentCategory) {
      state.category = "全部";
      saveFilterCategory();
    } else if (!dynamicCategories.includes(currentCategory)) {
      dynamicCategories.push(currentCategory);
    }
  }

  return ["全部", ...dynamicCategories];
}

function renderFilters() {
  const showToolbar = toolbarViews.includes(state.view);
  if (toolbar) {
    toolbar.hidden = !showToolbar;
  }
  if (refreshNews && state.user) {
    refreshNews.hidden = !showToolbar;
  }

  if (!showToolbar) {
    filterStrip.hidden = true;
    return;
  }

  if (!filterViews.includes(state.view)) {
    filterStrip.hidden = true;
    toolbar?.classList.add("filters-hidden");
    return;
  }

  filterStrip.hidden = false;
  toolbar?.classList.remove("filters-hidden");
  filterStrip.innerHTML = getDynamicCategories()
    .map(
      (category) => `
        <button class="chip ${state.category === category ? "active" : ""}" type="button" data-category="${category}">
          ${escapeHtml(category)}
        </button>
      `,
    )
    .join("");
}

function renderFeed(container, items) {
  if (!items.length) {
    container.innerHTML = '<div class="empty">没有匹配的热点，换个关键词试试。</div>';
    return;
  }

  container.innerHTML = items
    .map((item) => {
      const url = safeUrl(item.url);
      const image = safeUrl(item.image);
      const title = escapeHtml(item.title);
      const cardContent = `
          <div class="thumb">
            <img src="${escapeAttr(image)}" alt="${escapeAttr(`${item.country}${item.category}相关图片`)}" loading="lazy" />
          </div>
          <div class="news-body">
            <div class="meta-row">
              <span class="source-dot" aria-hidden="true"></span>
              <span>${escapeHtml(item.source)}</span>
              <span>${escapeHtml(item.time)}</span>
              <span class="priority">HOT ${escapeHtml(item.heat)}</span>
            </div>
            <h3>${title}</h3>
            <p>${escapeHtml(item.summary)}</p>
            <div class="tag-row">
              <span class="tag impact">${escapeHtml(item.impact)}</span>
              ${(item.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
            </div>
          </div>
      `;

      if (url) {
        return `
          <article class="news-card">
            <a class="news-card-link" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" aria-label="打开原文：${escapeAttr(item.title)}">
              ${cardContent}
            </a>
          </article>
        `;
      }

      return `
        <article class="news-card">
          <div class="news-card-link inert-card">${cardContent}</div>
        </article>
      `;
    })
    .join("");
}

function renderSnapshots() {
  const items = buildSnapshots(state.items);
  if (!items.length) {
    snapshotList.innerHTML = '<div class="empty">暂无真实热点快照，等待信源抓取入库。</div>';
    return;
  }

  snapshotList.innerHTML = items
    .map(
      (item) => `
        <article class="snapshot-item">
          <strong>${escapeHtml(item.title)}</strong>
          <p>${escapeHtml(item.text)}</p>
        </article>
      `,
    )
    .join("");
}

function renderDaily() {
  const historyHtml = state.dailyHistory.length > 0
    ? `<div class="daily-history">
        <h3>历史日报</h3>
        <ul class="daily-history-list">
          ${state.dailyHistory
            .map((h) => {
              const isCurrent = state.dailyDate === h.date || (!state.dailyDate && h.date === getShanghaiDateString());
              return `<li>
              <button class="daily-history-item${isCurrent ? " active" : ""}" data-daily-date="${h.date}">
                <span class="daily-history-date">${h.date}</span>
                <span class="daily-history-count">${h.sourceItemCount || 0} 条</span>
              </button>
            </li>`;
            })
            .join("")}
        </ul>
      </div>`
    : "";

  if (state.dailyReport?.html) {
    const windowText = state.dailyReport.windowLabel ? ` · ${escapeHtml(state.dailyReport.windowLabel)}` : "";
    dailyReport.innerHTML = `
      <div class="daily-layout">
        <div class="daily-main">
          <div class="daily-meta">
            <strong>${escapeHtml(state.dailyReport.title || "移民热点日报")}</strong>
            <span>${escapeHtml(state.dailyReport.model || "AI")} · ${escapeHtml(state.dailyReport.sourceItemCount || 0)} 条资讯${windowText}</span>
          </div>
          ${state.dailyReport.html}
        </div>
        ${historyHtml}
      </div>
    `;
    linkifyPlainUrls(dailyReport.querySelector(".daily-main"));
    return;
  }

  if (state.dailyLoading) {
    dailyReport.innerHTML = `
      <div class="daily-layout">
        <div class="daily-main">
          <div class="empty">DeepSeek 正在生成日报...</div>
        </div>
        ${historyHtml}
      </div>
    `;
    return;
  }

  dailyReport.innerHTML = `
    <div class="daily-layout">
      <div class="daily-main">
        <div class="empty">暂无已生成日报。请点击刷新或访问日报接口生成，页面不会再展示演示内容。</div>
      </div>
      ${historyHtml}
    </div>
  `;
}

function renderMaterialCard(material, index, mode = "full") {
  const url = safeUrl(material.url);
  const channels = Array.isArray(material.channels) ? material.channels : [];
  const ageText = Number.isFinite(Number(material.ageHours)) && Number(material.ageHours) <= 120
    ? `${Math.round(Number(material.ageHours))} 小时前`
    : "较早发布";
  const actionLabel = {
    useful: "已标记有用",
    useless: "已标记没用",
    used: "已采用",
    later: "稍后看",
  }[material.action];

  return `
    <article class="market-card ${material.action ? "has-feedback" : ""}">
      <div class="market-card-top">
        <span class="market-index">${index + 1}</span>
        <span class="market-score">素材分 ${material.marketScore}</span>
        <span class="market-status">${escapeHtml(material.freshnessType)}</span>
        ${actionLabel ? `<span class="market-status muted-status">${actionLabel}</span>` : ""}
      </div>
      <h3>${escapeHtml(material.recommendedTitle)}</h3>
      <p class="market-original">${escapeHtml(material.title)}</p>
      <div class="market-meta">
        <span>${escapeHtml(material.source)}</span>
        <span>${escapeHtml(material.projectName)}</span>
        <span>${ageText}</span>
      </div>
      <div class="market-channel-row">
        ${channels.map((channel) => `<span class="tag impact">${escapeHtml(channel)}</span>`).join("")}
      </div>
      ${
        mode === "full"
          ? `
            <dl class="market-fields">
              <div><dt>推荐角度</dt><dd>${escapeHtml(material.angle)}</dd></div>
              <div><dt>客户影响</dt><dd>${escapeHtml(material.customerImpact)}</dd></div>
              <div><dt>销售话术</dt><dd>${escapeHtml(material.salesTalk)}</dd></div>
              <div><dt>风险提醒</dt><dd>${escapeHtml(material.riskNote)}</dd></div>
            </dl>
          `
          : `<p class="market-lite">${escapeHtml(material.angle)}</p>`
      }
      <div class="market-actions">
        ${url ? `<a class="ghost-button compact" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">原文</a>` : ""}
        <button class="ghost-button compact" data-market-action="useful" data-id="${escapeAttr(material.id)}" type="button">有用</button>
        <button class="ghost-button compact" data-market-action="later" data-id="${escapeAttr(material.id)}" type="button">稍后看</button>
        <button class="ghost-button compact" data-market-action="used" data-id="${escapeAttr(material.id)}" type="button">已采用</button>
        <button class="ghost-button compact" data-market-action="useless" data-id="${escapeAttr(material.id)}" type="button">没用</button>
      </div>
    </article>
  `;
}

function renderMarketSection(title, desc, items, mode = "full") {
  return `
    <section class="market-section">
      <div class="market-section-head">
        <h2>${escapeHtml(title)}</h2>
        <span>${items.length} 条</span>
      </div>
      <p>${escapeHtml(desc)}</p>
      ${
        items.length
          ? `<div class="market-card-list">${items.map((item, index) => renderMaterialCard(item, index, mode)).join("")}</div>`
          : '<div class="empty">暂无匹配素材。</div>'
      }
    </section>
  `;
}

function renderNoUpdateProjects(projects) {
  return `
    <section class="market-section">
      <div class="market-section-head">
        <h2>今日无新增项目</h2>
        <span>${projects.length} 个</span>
      </div>
      <p>这些重点项目今天没有发现新的有效信息，市场部不必硬包装成今日热点。</p>
      <div class="no-update-grid">
        ${
          projects.length
            ? projects
                .map((project) => {
                  const latestDate = project.latest ? new Date(project.latest) : null;
                  const latest = latestDate && !Number.isNaN(latestDate.getTime())
                    ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(latestDate)
                    : "暂无";
                  return `
                    <article class="no-update-item">
                      <strong>${escapeHtml(project.name)}</strong>
                      <span>最近有效更新：${escapeHtml(latest)}</span>
                      <p>建议动作：今日不单独发新热点，可使用常青科普或等待新政策变化。</p>
                    </article>
                  `;
                })
                .join("")
            : '<div class="empty">重点项目今天都有新增或延续素材。</div>'
        }
      </div>
    </section>
  `;
}

function renderMarketHistory() {
  if (!state.marketHistory.length) {
    return "";
  }

  return `<div class="daily-history">
    <h3>历史素材</h3>
    <ul class="daily-history-list">
      ${state.marketHistory
        .map((h) => {
          const isCurrent = state.marketDate === h.date || (!state.marketDate && state.marketReportData?.date === h.date);
          return `<li>
            <button class="daily-history-item${isCurrent ? " active" : ""}" data-market-date="${h.date}">
              <span class="daily-history-date">${h.date}</span>
              <span class="daily-history-count">${h.usable || 0} 可发 · ${h.todayNew || 0} 新增</span>
            </button>
          </li>`;
        })
        .join("")}
    </ul>
  </div>`;
}

function renderMarketShell(content) {
  return `
    <div class="daily-layout">
      <div class="daily-main">
        ${content}
      </div>
      ${renderMarketHistory()}
    </div>
  `;
}

function renderMarket() {
  if (!marketReport) return;
  if (state.marketLoading) {
    marketReport.innerHTML = renderMarketShell('<div class="empty">正在从数据库生成市场素材...</div>');
    return;
  }
  if (state.marketError) {
    marketReport.innerHTML = renderMarketShell(`<div class="empty">${escapeHtml(state.marketError)}</div>`);
    return;
  }
  if (!state.marketReportData) {
    marketReport.innerHTML = renderMarketShell('<div class="empty">暂无真实市场素材。请先抓取信源数据，系统不会展示演示素材。</div>');
    return;
  }

  const report = state.marketReportData;
  const summary = report.summary || {};
  const reportDate = report.date ? new Date(`${report.date}T00:00:00`) : new Date();
  const dateText = `${reportDate.getFullYear()}.${String(reportDate.getMonth() + 1).padStart(2, "0")}.${String(reportDate.getDate()).padStart(2, "0")}`;

  marketReport.innerHTML = renderMarketShell(`
    <div class="market-summary">
      <div>
        <span class="eyebrow">市场素材日报</span>
        <h2>${dateText}</h2>
        <p>
          今日新增 ${summary.todayNew || 0} 条，可发布 ${summary.usable || 0} 条，延续关注 ${summary.continuing || 0} 条，
          ${summary.noUpdate || 0} 个重点项目无新增，${summary.notRecommended || 0} 条不建议重复发布。
        </p>
      </div>
      <div class="market-summary-stats">
        <span><strong>${summary.todayNew || 0}</strong>今日新增</span>
        <span><strong>${summary.usable || 0}</strong>可发布</span>
        <span><strong>${summary.noUpdate || 0}</strong>无新增</span>
      </div>
    </div>

    <section class="market-section">
      <h2>AI 使用建议</h2>
      <p>
        市场部优先处理“今日新增素材”，把“延续关注”改成 FAQ、客户答疑或销售私聊。
        “今日无新增项目”不要硬写成新热点；已采用或超过 72 小时无新事实的素材建议降级复盘。
      </p>
    </section>

    ${renderMarketSection("一、今日新增素材", "24 小时内首次出现且具备传播价值的素材，适合优先发布。", report.todayNew || [], "full")}
    ${renderMarketSection("二、延续关注素材", "不是今天新增，但仍有客户沟通价值，适合做二次解读或销售答疑。", report.continuing || [], "full")}
    ${renderNoUpdateProjects(report.noUpdateProjects || [])}
    ${renderMarketSection("四、不建议重复发布", "这些内容已过新鲜期、已采用或市场分较低，今天不建议作为新热点重复发布。", report.notRecommended || [], "lite")}
  `);
}

function renderRadar() {
  if (state.radarDetail) {
    renderRadarDetail();
    return;
  }
  const radarItems = buildRadarItems(state.items);
  radarGrid.innerHTML = radarItems
    .map(
      (item, i) => `
        <article class="radar-card clickable" data-radar="${i}">
          <header>
            <h2>${item.title}</h2>
            <span class="risk ${item.risk}">${item.riskText}</span>
          </header>
          <p>${item.text}</p>
          <div class="radar-card-footer">
            <span class="radar-count">${item.count} 篇文章</span>
            <span class="radar-arrow">→</span>
          </div>
          <div class="meter" aria-label="${item.title}风险指数 ${item.value}">
            <span style="width: ${item.value}%"></span>
          </div>
        </article>
      `,
    )
    .join("");
}

function renderRadarDetail() {
  const rule = buildRadarItems(state.items).find((r) => r.title === state.radarDetail);
  if (!rule) {
    state.radarDetail = null;
    renderRadar();
    return;
  }
  radarGrid.innerHTML = `
    <div class="radar-detail">
      <button class="radar-back" id="radarBack">← 返回雷达</button>
      <div class="radar-detail-header">
        <h2>${rule.title}</h2>
        <span class="risk ${rule.risk}">${rule.riskText}</span>
      </div>
      <div class="radar-keywords">${rule.keywords.map((k) => `<span class="tag">${k}</span>`).join("")}</div>
      <p class="radar-detail-desc">${rule.text}</p>
      <div class="radar-feed" id="radarFeed"></div>
    </div>
  `;
  renderFeed(document.getElementById("radarFeed"), rule.matched);
}

function showRadarDetail(title) {
  state.radarDetail = title;
  renderRadar();
}

function hideRadarDetail() {
  state.radarDetail = null;
  renderRadar();
}

function renderCounts(items) {
  homeCount.textContent = `${Math.min(items.length, 5)} 条`;
  allCount.textContent = `${items.length} 条`;
}

function isFetchRunActive(run = state.fetchRun) {
  return run?.status === "running";
}

function formatFetchRunStatus(run) {
  if (!run) {
    return "";
  }
  const processed = Number(run.processedSourceCount || 0);
  const total = Number(run.sourceCount || 0);
  const progress = Number(run.progress || 0);
  const itemCount = Number(run.itemCount || 0);
  return `后台抓取中 ${processed}/${total} 个信源 · ${progress}% · 已入库 ${itemCount} 条`;
}

function renderStatus(items) {
  const healthySources = state.sourceStatus.filter((source) => source.ok).length;
  const failedSources = state.sourceStatus.length - healthySources;

  if (isFetchRunActive()) {
    monitorStatus.textContent = formatFetchRunStatus(state.fetchRun);
  } else if (state.liveMeta.mode === "live") {
    const count = state.liveMeta.todayArticleCount ?? items.length;
    monitorStatus.textContent = `今日监测 ${count} 条更新`;
  } else if (state.liveMeta.mode === "loading") {
    monitorStatus.textContent = "正在连接实时信源...";
  } else {
    monitorStatus.textContent = state.liveMeta.text;
  }

  if (refreshNews) {
    refreshNews.disabled = isFetchRunActive();
    refreshNews.textContent = isFetchRunActive() ? "抓取中" : "刷新";
  }

  if (!sourceHealth) {
    return;
  }

  if (!state.sourceStatus.length) {
    sourceHealth.innerHTML = '<div class="source-health-empty">启动本地服务后会显示信源健康状态。</div>';
    return;
  }

  sourceHealth.innerHTML = `
    <div class="source-health-summary">
      <strong>${healthySources}</strong> 个正常
      ${failedSources ? `<span>${failedSources} 个异常</span>` : "<span>全部在线</span>"}
    </div>
    <div class="source-health-list">
      ${state.sourceStatus
        .map(
          (source) => `
            <article class="source-health-item ${source.ok ? "ok" : "bad"}">
              <div>
                <strong>${escapeHtml(source.name)}</strong>
                <span>${escapeHtml(source.country)} · ${source.ok ? `${source.count} 条` : escapeHtml(source.error || "抓取失败")}</span>
              </div>
            </article>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderLead(items) {
  const el = document.querySelector("#leadStory");
  if (!el) return;

  const top = items[0];
  if (!top) {
    el.innerHTML = "暂无热点数据";
    return;
  }

  const image = safeUrl(top.image);
  const url = safeUrl(top.url);
  const inner = `
    <div class="lead-copy">
      <span class="hot-label">HOT ${top.heat}</span>
      <h2>${escapeHtml(top.title)}</h2>
      <p>${escapeHtml(top.summary)}</p>
    </div>
    <figure class="lead-media">
      ${image ? `<img src="${escapeAttr(image)}" alt="${escapeAttr(`${top.country}${top.category}相关图片`)}" />` : ""}
    </figure>
  `;

  if (url) {
    el.innerHTML = `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
  } else {
    el.innerHTML = inner;
  }
}

function renderStats(items) {
  const stats = state.liveMeta.todayStats;
  const statHigh = document.querySelector("#statHigh");
  const statCountries = document.querySelector("#statCountries");
  const statCategories = document.querySelector("#statCategories");

  if (stats) {
    if (statHigh) statHigh.textContent = stats.highCount;
    if (statCountries) statCountries.textContent = stats.countryCount;
    if (statCategories) statCategories.textContent = stats.categoryCount;
  } else {
    const highCount = items.filter((i) => i.heat >= 85).length;
    const countries = new Set(items.map((i) => i.country).filter(Boolean));
    const cats = new Set(items.map((i) => i.category).filter(Boolean));
    if (statHigh) statHigh.textContent = highCount;
    if (statCountries) statCountries.textContent = countries.size;
    if (statCategories) statCategories.textContent = cats.size;
  }
}

function renderSsoStats() {
  if (!ssoStatsReport) return;

  if (state.ssoStatsLoading) {
    ssoStatsReport.innerHTML = '<p class="form-note">正在加载访问统计...</p>';
    return;
  }

  if (state.ssoStatsError) {
    ssoStatsReport.innerHTML = `<p class="form-note">${escapeHtml(state.ssoStatsError)}</p>`;
    return;
  }

  const stats = state.ssoStats;
  if (!stats) {
    ssoStatsReport.innerHTML = '<p class="form-note">打开后会显示企业微信访问登记。</p>';
    return;
  }

  const summary = stats.summary || {};
  const daily = Array.isArray(stats.daily) ? stats.daily : [];
  const users = Array.isArray(stats.users) ? stats.users : [];
  const recent = Array.isArray(stats.recent) ? stats.recent : [];
  const pushStats = stats.push || {};
  const pushSummary = pushStats.summary || {};
  const pushDaily = Array.isArray(pushStats.daily) ? pushStats.daily : [];
  const pushTasks = Array.isArray(pushStats.tasks) ? pushStats.tasks : [];
  const pushRecent = Array.isArray(pushStats.recent) ? pushStats.recent : [];
  const pushRecentEvents = Array.isArray(pushStats.recentEvents) ? pushStats.recentEvents : [];
  const maxVisits = Math.max(1, ...daily.map((item) => Number(item.visits || 0)));
  const maxPushVisits = Math.max(1, ...pushDaily.map((item) => Number(item.visits || 0)));
  const pushVisitRate = Number(pushSummary.sentCount || 0) > 0
    ? Math.round((Number(pushSummary.visitedCount || 0) / Number(pushSummary.sentCount || 0)) * 100)
    : 0;

  ssoStatsReport.innerHTML = `
    <section class="sso-panel">
      <div class="sso-panel-head">
        <h2>SSO 加密入口</h2>
        <span>来自 URL 中的 sso_auth_code</span>
      </div>
    <div class="sso-summary-grid">
      <div class="sso-stat"><span>总访问</span><strong>${escapeHtml(summary.totalVisits || 0)}</strong></div>
      <div class="sso-stat"><span>访问人数</span><strong>${escapeHtml(summary.uniqueUsers || 0)}</strong></div>
      <div class="sso-stat"><span>今日访问</span><strong>${escapeHtml(summary.todayVisits || 0)}</strong></div>
      <div class="sso-stat"><span>今日人数</span><strong>${escapeHtml(summary.todayUsers || 0)}</strong></div>
    </div>
    </section>

    <section class="sso-panel">
      <div class="sso-panel-head">
        <h2>SSO 近 14 天趋势</h2>
        <span>${daily.length} 天有访问</span>
      </div>
      <div class="sso-trend-list">
        ${daily.length ? daily.map((item) => `
          <div class="sso-trend-row">
            <span>${escapeHtml(item.date)}</span>
            <div class="sso-trend-track"><i style="width:${Math.max(5, Math.round((Number(item.visits || 0) / maxVisits) * 100))}%"></i></div>
            <strong>${escapeHtml(item.visits || 0)} 次</strong>
            <em>${escapeHtml(item.users || 0)} 人</em>
          </div>
        `).join("") : '<p class="form-note">暂无趋势数据。</p>'}
      </div>
    </section>

    <section class="sso-panel">
      <div class="sso-panel-head">
        <h2>SSO 访问用户排行</h2>
        <span>按访问次数排序</span>
      </div>
      <div class="sso-user-list">
        ${users.length ? users.map((user) => `
          <div class="sso-user-row">
            <strong>${escapeHtml(user.userName)}</strong>
            <span>${user.userId ? `${escapeHtml(user.userId)} · ` : ""}${escapeHtml(user.visits || 0)} 次 · 最近 ${escapeHtml(user.lastVisitAt || "-")}</span>
          </div>
        `).join("") : '<p class="form-note">暂无用户数据。</p>'}
      </div>
    </section>

    <section class="sso-panel">
      <div class="sso-panel-head">
        <h2>SSO 最近访问明细</h2>
        <span>最近 100 条</span>
      </div>
      <div class="sso-table-wrap">
        <table class="sso-table">
          <thead>
            <tr><th>时间</th><th>姓名</th><th>UserID</th><th>入口</th><th>IP</th><th>设备</th></tr>
          </thead>
          <tbody>
            ${recent.length ? recent.map((row) => `
              <tr>
                <td>${escapeHtml(row.visitAt || "-")}</td>
                <td>${escapeHtml(row.userName || "-")}</td>
                <td>${escapeHtml(row.userId || "-")}</td>
                <td>${escapeHtml(row.route || "-")}</td>
                <td>${escapeHtml(row.clientIp || "-")}</td>
                <td title="${escapeAttr(row.userAgent || "")}">${escapeHtml(row.userAgent || "-")}</td>
              </tr>
            `).join("") : '<tr><td colspan="6">暂无访问明细。</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>

    <section class="sso-panel">
      <div class="sso-panel-head">
        <h2>日报链接点击概览</h2>
        <span>来自企业微信日报卡片 /d/:token</span>
      </div>
      <div class="sso-summary-grid">
        <div class="sso-stat"><span>推送批次</span><strong>${escapeHtml(pushSummary.taskCount || 0)}</strong></div>
        <div class="sso-stat"><span>已发送</span><strong>${escapeHtml(pushSummary.sentCount || 0)}</strong></div>
        <div class="sso-stat"><span>已点击</span><strong>${escapeHtml(pushSummary.visitedCount || 0)}</strong></div>
        <div class="sso-stat"><span>点击率</span><strong>${escapeHtml(pushVisitRate)}%</strong></div>
      </div>
    </section>

    <section class="sso-panel">
      <div class="sso-panel-head">
        <h2>日报链接近 14 天点击</h2>
        <span>今日 ${escapeHtml(pushSummary.todayVisits || 0)} 次 · ${escapeHtml(pushSummary.uniqueVisitors || 0)} 人点击过</span>
      </div>
      <div class="sso-trend-list">
        ${pushDaily.length ? pushDaily.map((item) => `
          <div class="sso-trend-row">
            <span>${escapeHtml(item.date)}</span>
            <div class="sso-trend-track"><i style="width:${Math.max(5, Math.round((Number(item.visits || 0) / maxPushVisits) * 100))}%"></i></div>
            <strong>${escapeHtml(item.visits || 0)} 次</strong>
            <em>${escapeHtml(item.users || 0)} 人</em>
          </div>
        `).join("") : '<p class="form-note">暂无日报链接点击数据。</p>'}
      </div>
    </section>

    <section class="sso-panel">
      <div class="sso-panel-head">
        <h2>最近推送批次</h2>
        <span>最近 30 个批次</span>
      </div>
      <div class="sso-table-wrap">
        <table class="sso-table">
          <thead>
            <tr><th>推送日</th><th>日报日</th><th>状态</th><th>目标</th><th>已发送</th><th>失败</th><th>已点击</th><th>点击率</th></tr>
          </thead>
          <tbody>
            ${pushTasks.length ? pushTasks.map((task) => {
              const taskRate = Number(task.sentCount || 0) > 0
                ? Math.round((Number(task.visitedCount || 0) / Number(task.sentCount || 0)) * 100)
                : 0;
              return `
                <tr>
                  <td>${escapeHtml(task.pushDate || "-")}</td>
                  <td>${escapeHtml(task.dailyDate || "-")}</td>
                  <td title="${escapeAttr(task.error || "")}">${escapeHtml(task.status || "-")}</td>
                  <td>${escapeHtml(task.totalCount || 0)}</td>
                  <td>${escapeHtml(task.sentCount || 0)}</td>
                  <td>${escapeHtml(task.failedCount || 0)}</td>
                  <td>${escapeHtml(task.visitedCount || 0)}</td>
                  <td>${escapeHtml(taskRate)}%</td>
                </tr>
              `;
            }).join("") : '<tr><td colspan="8">暂无推送批次。</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>

    <section class="sso-panel">
      <div class="sso-panel-head">
        <h2>最近日报链接点击</h2>
        <span>最近 100 条</span>
      </div>
      <div class="sso-table-wrap">
        <table class="sso-table">
          <thead>
            <tr><th>时间</th><th>姓名</th><th>UserID</th><th>日报日</th><th>推送日</th><th>IP</th></tr>
          </thead>
          <tbody>
            ${pushRecent.length ? pushRecent.map((row) => `
              <tr>
                <td>${escapeHtml(row.visitAt || "-")}</td>
                <td>${escapeHtml(row.username || "-")}</td>
                <td>${escapeHtml(row.userid || "-")}</td>
                <td>${escapeHtml(row.dailyDate || "-")}</td>
                <td>${escapeHtml(row.pushDate || "-")}</td>
                <td>${escapeHtml(row.visitIp || "-")}</td>
              </tr>
            `).join("") : '<tr><td colspan="6">暂无日报链接点击明细。</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>

    <section class="sso-panel">
      <div class="sso-panel-head">
        <h2>默认浏览器打开诊断</h2>
        <span>最近 120 条企业微信中转页事件</span>
      </div>
      <div class="sso-table-wrap">
        <table class="sso-table">
          <thead>
            <tr><th>时间</th><th>Token</th><th>事件</th><th>详情</th><th>IP</th><th>设备</th></tr>
          </thead>
          <tbody>
            ${pushRecentEvents.length ? pushRecentEvents.map((row) => `
              <tr>
                <td>${escapeHtml(row.createdAt || "-")}</td>
                <td>${escapeHtml(row.token || "-")}</td>
                <td>${escapeHtml(row.eventName || "-")}</td>
                <td title="${escapeAttr(row.eventDetail || "")}">${escapeHtml(row.eventDetail || "-")}</td>
                <td>${escapeHtml(row.clientIp || "-")}</td>
                <td title="${escapeAttr(row.userAgent || "")}">${escapeHtml(row.userAgent || "-")}</td>
              </tr>
            `).join("") : '<tr><td colspan="6">暂无默认浏览器打开诊断。</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function feedbackStatusLabel(status) {
  return {
    new: "待查看",
    reviewed: "已查看",
    resolved: "已处理",
    archived: "已归档",
  }[status] || "待查看";
}

function feedbackPriorityLabel(priority) {
  return {
    normal: "一般建议",
    high: "影响工作",
    urgent: "尽快处理",
  }[priority] || priority || "一般建议";
}

function renderFeedbackReview() {
  if (!feedbackReviewList || !feedbackReviewFilters) return;

  const statuses = [
    { key: "all", label: "全部" },
    { key: "new", label: "待查看" },
    { key: "reviewed", label: "已查看" },
    { key: "resolved", label: "已处理" },
    { key: "archived", label: "已归档" },
  ];
  feedbackReviewFilters.innerHTML = statuses.map((item) => `
    <button class="filter-chip${state.feedbackStatus === item.key ? " active" : ""}" data-feedback-status="${item.key}" type="button">
      ${escapeHtml(item.label)}
    </button>
  `).join("");

  if (state.feedbackLoading) {
    feedbackReviewList.innerHTML = '<p class="form-note">正在加载反馈意见...</p>';
    return;
  }

  if (state.feedbackError) {
    feedbackReviewList.innerHTML = `<p class="form-note">${escapeHtml(state.feedbackError)}</p>`;
    return;
  }

  const items = state.feedbackItems || [];
  if (!items.length) {
    feedbackReviewList.innerHTML = '<p class="form-note">暂无反馈意见。</p>';
    return;
  }

  feedbackReviewList.innerHTML = items.map((item) => `
    <article class="feedback-card ${escapeAttr(item.status || "new")}" data-feedback-id="${escapeAttr(item.id)}">
      <div class="feedback-card-head">
        <div>
          <strong>${escapeHtml(item.type || "页面反馈")}</strong>
          <span>${escapeHtml(item.module || "未指定页面")} · ${escapeHtml(feedbackPriorityLabel(item.priority))}</span>
        </div>
        <span class="feedback-status ${escapeAttr(item.status || "new")}">${escapeHtml(feedbackStatusLabel(item.status))}</span>
      </div>
      <p class="feedback-message">${escapeHtml(item.message || "")}</p>
      <div class="feedback-meta">
        <span>反馈人：${escapeHtml(item.createdBy || "未记录")}</span>
        ${item.contact ? `<span>联系方式：${escapeHtml(item.contact)}</span>` : ""}
        <span>提交时间：${escapeHtml(item.createdAt || "-")}</span>
      </div>
      <div class="feedback-review-actions">
        <select data-feedback-field="status" aria-label="处理状态">
          ${["new", "reviewed", "resolved", "archived"].map((status) => `
            <option value="${status}"${(item.status || "new") === status ? " selected" : ""}>${feedbackStatusLabel(status)}</option>
          `).join("")}
        </select>
        <input data-feedback-field="adminNote" value="${escapeAttr(item.adminNote || "")}" placeholder="处理备注" />
        <button class="ghost-button compact" data-feedback-action="save" data-id="${escapeAttr(item.id)}" type="button">保存</button>
      </div>
    </article>
  `).join("");
}

function renderContent() {
  const items = filteredItems();
  renderFilters();
  renderLead(items);
  renderStats(items);
  renderFeed(featuredFeed, items.slice(0, 5));
  renderFeed(allFeed, items);
  renderSnapshots();
  renderDaily();
  renderMarket();
  renderRadar();
  renderSsoStats();
  renderFeedbackReview();
  renderCounts(items);
  renderStatus(items);
}

function parseHashRoute(value = window.location.hash) {
  const raw = String(value || "").replace(/^#/, "");
  const queryIndex = raw.indexOf("?");
  const view = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : raw.slice(queryIndex);
  return {
    view: view || "home",
    query,
  };
}

function normalizeApiItem(item) {
  return {
    id: item.id,
    title: item.title || "未命名动态",
    summary: item.summary || "查看原文获取完整信息。",
    source: item.source || "未知信源",
    country: cleanFilterLabel(item.country) || "全球",
    category: cleanFilterLabel(item.category) || "政策",
    time: item.time || "刚刚",
    heat: Number(item.heat || 60),
    impact: item.impact || "中影响",
    tags: Array.isArray(item.tags) ? item.tags.map(cleanFilterLabel).filter(Boolean) : [],
    image: item.image || "",
    url: item.url || "",
    publishedAt: item.publishedAt || null,
    fetchedAt: item.fetchedAt || null,
  };
}

function stopFetchRunPolling() {
  if (fetchRunPollTimer) {
    clearTimeout(fetchRunPollTimer);
    fetchRunPollTimer = null;
  }
}

function scheduleFetchRunPolling(runId) {
  if (!runId || window.location.protocol === "file:") {
    return;
  }

  stopFetchRunPolling();

  const poll = async () => {
    try {
      const response = await fetch(`/api/fetch-runs/${runId}`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      state.fetchRun = data.run || null;

      if (isFetchRunActive(state.fetchRun)) {
        renderContent();
        fetchRunPollTimer = setTimeout(poll, 2500);
        return;
      }

      const finishedRun = state.fetchRun;
      state.fetchRun = null;
      state.liveMeta = {
        mode: finishedRun?.status === "failed" ? "error" : "live",
        text: finishedRun?.status === "failed"
          ? `后台抓取失败：${finishedRun.error || "未知错误"}`
          : `后台抓取完成：${finishedRun?.successSourceCount || 0} 个信源成功，新增/更新 ${finishedRun?.itemCount || 0} 条`,
      };
      renderContent();
      await loadLiveNews();
    } catch (error) {
      state.fetchRun = null;
      state.liveMeta = {
        mode: "error",
        text: "抓取进度查询失败",
        error: error instanceof Error ? error.message : String(error),
      };
      renderContent();
    }
  };

  fetchRunPollTimer = setTimeout(poll, 1200);
}

async function loadLiveNews({ refresh = false } = {}) {
  if (window.location.protocol === "file:") {
    renderContent();
    return;
  }

  state.liveMeta = {
    mode: "loading",
    text: "正在连接实时信源...",
  };
  renderContent();
  refreshNews.disabled = true;
  refreshNews.textContent = "刷新中";

  try {
    const response = await fetch(`/api/news${refresh ? "?refresh=1" : ""}`, {
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    state.fetchRun = data.fetchRun || null;
    if (Array.isArray(data.items) && data.items.length) {
      state.items = data.items.map(normalizeApiItem);
      state.sourceStatus = Array.isArray(data.sources) ? data.sources : [];
      state.liveMeta = {
        mode: data.refreshing ? "refreshing" : "live",
        text: data.refreshing ? "后台抓取任务已启动，当前先展示已有数据" : "实时数据",
        itemCount: data.itemCount,
        todayArticleCount: data.todayArticleCount,
        todayStats: data.todayStats || null,
        sourceCount: data.sourceCount,
        generatedAt: data.generatedAt,
      };
    } else {
      state.items = [];
      state.sourceStatus = Array.isArray(data.sources) ? data.sources : [];
      state.liveMeta = {
        mode: data.refreshing ? "refreshing" : "empty",
        text: data.refreshing ? "后台抓取任务已启动，暂无历史文章可展示" : "实时信源暂无真实返回",
      };
    }
    if (isFetchRunActive(state.fetchRun)) {
      scheduleFetchRunPolling(state.fetchRun.id);
    } else {
      stopFetchRunPolling();
    }
  } catch (error) {
    state.fetchRun = null;
    stopFetchRunPolling();
    state.items = [];
    state.liveMeta = {
      mode: "error",
      text: "实时信源连接失败，未加载演示数据",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    refreshNews.disabled = isFetchRunActive();
    refreshNews.textContent = isFetchRunActive() ? "抓取中" : "刷新";
    renderContent();
  }

  const dependentRefresh = refresh && !isFetchRunActive();
  if (state.view === "market") {
    loadMarketReport({ refresh: dependentRefresh });
  } else if (state.view === "daily") {
    loadDailyReport({ refresh: dependentRefresh });
  }
}

async function loadMarketReport({ refresh = false, date } = {}) {
  if (window.location.protocol === "file:") {
    return;
  }

  state.marketLoading = true;
  state.marketError = "";
  renderContent();

  try {
    const params = new URLSearchParams();
    if (refresh) params.set("refresh", "1");
    if (date) params.set("date", date);
    const qs = params.toString();
    const response = await fetch(`/api/market${qs ? `?${qs}` : ""}`, {
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    state.marketReportData = data.report || null;
    state.marketDate = data.report?.date || date || null;
    loadMarketHistory();
  } catch (error) {
    state.marketReportData = null;
    state.marketError = `市场素材加载失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    state.marketLoading = false;
    renderContent();
  }
}

async function loadMarketHistory() {
  if (window.location.protocol === "file:") return;
  try {
    const res = await fetch("/api/market/history");
    const data = await res.json();
    if (data.ok) {
      state.marketHistory = data.history || [];
      renderContent();
    }
  } catch { /* ignore */ }
}

async function loadDailyReport({ refresh = false, date } = {}) {
  if (window.location.protocol === "file:") {
    return;
  }

  state.dailyLoading = true;
  renderContent();

  try {
    const params = new URLSearchParams();
    if (refresh) params.set("refresh", "1");
    if (date) params.set("date", date);
    const qs = params.toString();
    const response = await fetch(`/api/daily${qs ? `?${qs}` : ""}`, {
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    state.dailyReport = data.report || null;
    state.dailyDate = date || null;
  } catch {
    state.dailyReport = null;
  } finally {
    state.dailyLoading = false;
    renderContent();
  }
}

async function loadDailyHistory() {
  if (window.location.protocol === "file:") return;
  try {
    const res = await fetch("/api/daily/history");
    const data = await res.json();
    if (data.ok) {
      state.dailyHistory = data.history || [];
      renderContent();
    }
  } catch { /* ignore */ }
}

async function loadChangelog() {
  const container = document.getElementById("changelog-timeline");
  if (!container || container.children.length > 0) return;
  if (window.location.protocol === "file:") {
    container.innerHTML = '<article><time>—</time><h2>离线模式</h2><p>需要连接服务器查看更新日志。</p></article>';
    return;
  }
  try {
    const res = await fetch("/api/changelog");
    const data = await res.json();
    if (!data.ok || !data.items || data.items.length === 0) {
      container.innerHTML = '<article><time>—</time><h2>暂无记录</h2><p>暂无更新日志。</p></article>';
      return;
    }
    let html = "";
    for (const item of data.items) {
      html += `<article>
        <time>${escapeHtml(item.log_date)}</time>
        <h2>${escapeHtml(item.title)}</h2>
        ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ""}
      </article>`;
    }
    container.innerHTML = html;
  } catch {
    container.innerHTML = '<article><time>—</time><h2>加载失败</h2><p>无法获取更新日志。</p></article>';
  }
}

async function loadSsoStats() {
  if (window.location.protocol === "file:") return;

  state.ssoStatsLoading = true;
  state.ssoStatsError = "";
  renderContent();

  try {
    const response = await fetch("/api/sso/stats", {
      headers: { accept: "application/json" },
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    state.ssoStats = data.stats || null;
  } catch (error) {
    state.ssoStats = null;
    state.ssoStatsError = `访问统计加载失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    state.ssoStatsLoading = false;
    renderContent();
  }
}

async function loadFeedbackReview() {
  if (window.location.protocol === "file:") return;

  state.feedbackLoading = true;
  state.feedbackError = "";
  renderContent();

  try {
    const params = new URLSearchParams();
    if (state.feedbackStatus && state.feedbackStatus !== "all") {
      params.set("status", state.feedbackStatus);
    }
    const qs = params.toString();
    const response = await fetch(`/api/feedback${qs ? `?${qs}` : ""}`, {
      headers: { accept: "application/json" },
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    state.feedbackItems = data.feedback || [];
  } catch (error) {
    state.feedbackItems = [];
    state.feedbackError = `反馈意见加载失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    state.feedbackLoading = false;
    renderContent();
  }
}

function getHashSearchParams() {
  return new URLSearchParams(parseHashRoute().query.replace(/^\?/, ""));
}

function removeHashParam(name) {
  const route = parseHashRoute();
  const params = new URLSearchParams(route.query.replace(/^\?/, ""));
  if (!params.has(name)) return;
  params.delete(name);
  const nextQuery = params.toString();
  const nextHash = `#${route.view}${nextQuery ? `?${nextQuery}` : ""}`;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${nextHash}`);
}

async function recordSsoVisitFromHash() {
  if (window.location.protocol === "file:") return;

  const params = getHashSearchParams();
  const ssoAuthCode = params.get("sso_auth_code");
  const ssoUserId = params.get("sso_user_id");
  if (!ssoAuthCode) return;

  const route = parseHashRoute().view;
  const dedupeKey = `ssoVisit.${ssoAuthCode}.${ssoUserId || ""}`;
  try {
    if (!sessionStorage.getItem(dedupeKey)) {
      const response = await fetch("/api/sso/visit", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          ssoAuthCode,
          ssoUserId,
          route,
          pageUrl: window.location.href,
        }),
      });
      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        if (data.userName) {
          state.ssoUserName = data.userName;
          sessionStorage.setItem("yiminSsoUserName", data.userName);
        }
        if (data.userId) {
          state.ssoUserId = data.userId;
          sessionStorage.setItem("yiminSsoUserId", data.userId);
        }
        sessionStorage.setItem(dedupeKey, "1");
      }
    }
  } catch {
    /* SSO logging should not block reading the page. */
  } finally {
    removeHashParam("sso_auth_code");
    removeHashParam("sso_user_id");
  }
}

async function loadSsoIdentity() {
  if (window.location.protocol === "file:") return;
  try {
    const response = await fetch("/api/sso/me", {
      headers: { accept: "application/json" },
    });
    const data = await response.json();
    if (!response.ok || !data.ok) return;
    if (data.userName) {
      state.ssoUserName = data.userName;
      sessionStorage.setItem("yiminSsoUserName", data.userName);
    }
    if (data.userId) {
      state.ssoUserId = data.userId;
      sessionStorage.setItem("yiminSsoUserId", data.userId);
    }
  } catch {
    /* Identity recovery should not block page rendering. */
  }
}

function setView(routeValue) {
  const route = parseHashRoute(routeValue);
  let viewName = route.view;
  const currentRoute = parseHashRoute();
  const routeQuery = route.query || currentRoute.query;

  if (!views.includes(viewName)) {
    viewName = "home";
  }

  if (authViews.includes(viewName) && !state.user) {
    viewName = "login";
  }

  state.view = viewName;
  state.radarDetail = null;
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("active", view.id === `view-${viewName}`);
  });
  document.querySelectorAll("[data-view]").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === viewName);
  });
  document.body.classList.remove("menu-open");
  const nextHash = `${viewName}${routeQuery}`;
  if (window.location.hash.replace(/^#/, "") !== nextHash) {
    window.location.hash = nextHash;
  }
  renderContent();

  if (viewName === "review") {
    loadSubmissions();
  }
  if (viewName === "daily") {
    loadDailyHistory();
    if (!state.dailyReport && !state.dailyLoading) {
      loadDailyReport();
    }
  }
  if (viewName === "market") {
    loadMarketHistory();
    if (!state.marketReportData && !state.marketLoading) {
      loadMarketReport();
    }
  }
  if (viewName === "sso-stats" && !state.ssoStatsLoading) {
    loadSsoStats();
  }
  if (viewName === "feedback-review" && !state.feedbackLoading) {
    loadFeedbackReview();
  }
  if (viewName === "changelog") {
    loadChangelog();
  }
}

async function loadSubmissions() {
  const container = document.querySelector("#reviewList");
  container.innerHTML = '<p class="form-note">加载中...</p>';
  try {
    const response = await fetch("/api/submissions");
    const data = await response.json();
    if (!data.ok) throw new Error(data.error);
    renderReview(data.submissions || []);
  } catch {
    container.innerHTML = '<p class="form-note">加载失败，请检查是否已登录。</p>';
  }
}

function renderReview(submissions) {
  const container = document.querySelector("#reviewList");
  if (submissions.length === 0) {
    container.innerHTML = '<p class="form-note">暂无信源提报。</p>';
    return;
  }

  const statusLabel = { pending: "待审核", accepted: "已通过", rejected: "已拒绝" };
  const statusClass = { pending: "badge-pending", accepted: "badge-accepted", rejected: "badge-rejected" };

  container.innerHTML = submissions.map((sub) => `
    <div class="review-card ${sub.status}" data-id="${sub.id}">
      <div class="review-header">
        <strong>${sub.name}</strong>
        <span class="review-badge ${statusClass[sub.status]}">${statusLabel[sub.status]}</span>
      </div>
      <div class="review-meta">
        <span>${sub.url}</span>
        ${sub.topic ? `<span>主题: ${sub.topic}</span>` : ""}
        <span>提交于 ${sub.created_at || "未知"}</span>
      </div>
      ${sub.status === "pending" ? `
        <div class="review-form">
          <label><span>信源类型</span>
            <select data-field="type">
              <option value="rss">RSS 订阅</option>
              <option value="website">网站源（Firecrawl）</option>
              <option value="html">HTML 抓取</option>
              <option value="json">JSON API</option>
            </select>
          </label>
          <label><span>国家</span>
            <input data-field="country" placeholder="美国 / 加拿大 / 英国 / 澳大利亚" />
          </label>
          <label><span>分类</span>
            <input data-field="category" placeholder="官方机构 / EB-5 / 排期" />
          </label>
          <label><span>优先级</span>
            <input data-field="priority" type="number" min="0" max="100" value="50" />
          </label>
          <div class="review-actions">
            <button class="primary-button" data-action="accept" data-id="${sub.id}" type="button">通过</button>
            <button class="ghost-button" data-action="reject" data-id="${sub.id}" type="button">拒绝</button>
          </div>
        </div>
      ` : ""}
    </div>
  `).join("");
}

document.addEventListener("click", async (event) => {
  const btn = event.target.closest("[data-action]");
  if (!btn) return;
  const id = btn.dataset.id;
  const card = btn.closest(".review-card");
  const action = btn.dataset.action;

  if (action === "accept") {
    const fields = {
      type: card.querySelector('[data-field="type"]')?.value || "rss",
      country: card.querySelector('[data-field="country"]')?.value || "",
      category: card.querySelector('[data-field="category"]')?.value || "",
      priority: card.querySelector('[data-field="priority"]')?.value || "50",
    };
    const res = await fetch(`/api/submissions/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "accepted", ...fields }),
    });
    const data = await res.json();
    if (data.ok) loadSubmissions();
  } else if (action === "reject") {
    const res = await fetch(`/api/submissions/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "rejected" }),
    });
    const data = await res.json();
    if (data.ok) loadSubmissions();
  }
});

document.addEventListener("click", async (event) => {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) {
    setView(viewButton.dataset.view);
    return;
  }

  const categoryButton = event.target.closest("[data-category]");
  if (categoryButton) {
    setCategory(categoryButton.dataset.category);
    renderContent();
    return;
  }

  const radarCard = event.target.closest(".radar-card.clickable");
  if (radarCard) {
    const radarItems = buildRadarItems(state.items);
    const idx = parseInt(radarCard.dataset.radar, 10);
    if (radarItems[idx]) showRadarDetail(radarItems[idx].title);
    return;
  }

  if (event.target.closest("#radarBack")) {
    hideRadarDetail();
    return;
  }

  const historyBtn = event.target.closest("[data-daily-date]");
  if (historyBtn) {
    const date = historyBtn.dataset.dailyDate;
    loadDailyReport({ date });
    return;
  }

  const marketHistoryBtn = event.target.closest("[data-market-date]");
  if (marketHistoryBtn) {
    const date = marketHistoryBtn.dataset.marketDate;
    loadMarketReport({ date });
    return;
  }

  const newsCard = event.target.closest(".news-card-link:not(.inert-card)");
  if (newsCard && newsCard.closest("#radarFeed") && !event.metaKey && !event.ctrlKey) {
    const article = newsCard.closest(".news-card");
    const url = newsCard.getAttribute("href");
    if (url) {
      showArticleModal(article, url);
      event.preventDefault();
    }
    return;
  }

  if (event.target.closest("#modalOverlay") || event.target.closest(".modal-close")) {
    closeArticleModal();
    return;
  }

  const marketAction = event.target.closest("[data-market-action]");
  if (marketAction) {
    const id = marketAction.dataset.id;
    if (id) {
      try {
        const response = await fetch("/api/market/feedback", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            articleHash: id,
            action: marketAction.dataset.marketAction,
            date: state.marketReportData?.date,
          }),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) {
          throw new Error(data.error || `HTTP ${response.status}`);
        }
        state.marketReportData = data.report || state.marketReportData;
        state.marketDate = data.report?.date || state.marketDate;
        state.marketError = "";
        loadMarketHistory();
      } catch (error) {
        state.marketError = `反馈保存失败：${error instanceof Error ? error.message : String(error)}`;
      }
      renderContent();
    }
    return;
  }

  const feedbackStatusButton = event.target.closest("[data-feedback-status]");
  if (feedbackStatusButton) {
    state.feedbackStatus = feedbackStatusButton.dataset.feedbackStatus || "all";
    loadFeedbackReview();
    return;
  }

  const feedbackAction = event.target.closest("[data-feedback-action]");
  if (feedbackAction) {
    const card = feedbackAction.closest("[data-feedback-id]");
    const id = feedbackAction.dataset.id || card?.dataset.feedbackId;
    if (!id || feedbackAction.dataset.feedbackAction !== "save") return;
    const status = card.querySelector('[data-feedback-field="status"]')?.value || "reviewed";
    const adminNote = card.querySelector('[data-feedback-field="adminNote"]')?.value || "";
    feedbackAction.disabled = true;
    try {
      const response = await fetch(`/api/feedback/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, adminNote }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      await loadFeedbackReview();
    } catch (error) {
      state.feedbackError = `反馈状态保存失败：${error instanceof Error ? error.message : String(error)}`;
      renderContent();
    } finally {
      feedbackAction.disabled = false;
    }
    return;
  }
});

searchInput.addEventListener("input", (event) => {
  state.query = event.target.value;
  renderContent();
});

refreshNews.addEventListener("click", () => {
  loadLiveNews({ refresh: true });
});

document.querySelector("#refreshSsoStats")?.addEventListener("click", () => {
  loadSsoStats();
});

document.querySelector("#refreshFeedbackReview")?.addEventListener("click", () => {
  loadFeedbackReview();
});

document.querySelector("#menuToggle").addEventListener("click", () => {
  document.body.classList.toggle("menu-open");
});

document.querySelector("#copyDaily").addEventListener("click", async () => {
  const text = dailyReport.innerText.trim();
  try {
    await navigator.clipboard.writeText(text);
    document.querySelector("#copyDaily").textContent = "已复制";
    setTimeout(() => {
      document.querySelector("#copyDaily").textContent = "复制日报";
    }, 1400);
  } catch {
    document.querySelector("#copyDaily").textContent = "复制失败";
  }
});

document.querySelector("#copyMarket").addEventListener("click", async () => {
  const text = marketReport.innerText.trim();
  try {
    await navigator.clipboard.writeText(text);
    document.querySelector("#copyMarket").textContent = "已复制";
    setTimeout(() => {
      document.querySelector("#copyMarket").textContent = "复制素材";
    }, 1400);
  } catch {
    document.querySelector("#copyMarket").textContent = "复制失败";
  }
});

document.querySelector("#sourceForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = Object.fromEntries(new FormData(form).entries());

  if (window.location.protocol !== "file:") {
    try {
      const response = await fetch("/api/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      form.reset();
      document.querySelector("#sourceNote").textContent = "已提交到数据库，默认待审核不自动抓取。";
      return;
    } catch {
      document.querySelector("#sourceNote").textContent = "数据库提交失败，已保存到本地草稿。";
    }
  }

  const drafts = JSON.parse(localStorage.getItem("immigrationSources") || "[]");
  drafts.push({ ...formData, savedAt: new Date().toISOString() });
  localStorage.setItem("immigrationSources", JSON.stringify(drafts));
  form.reset();
});

document.querySelector("#feedbackForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = {
    ...Object.fromEntries(new FormData(form).entries()),
    createdBy: state.ssoUserName || state.user?.username || sessionStorage.getItem("yiminSsoUserName") || "",
    pageUrl: window.location.href,
  };

  if (window.location.protocol !== "file:") {
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      form.reset();
      document.querySelector("#feedbackNote").textContent = "已收到，感谢您的反馈。";
      return;
    } catch (err) {
      console.error("feedback submit error:", err);
      document.querySelector("#feedbackNote").textContent = "数据库提交失败，已保存到本地草稿。";
      const drafts = JSON.parse(localStorage.getItem("immigrationFeedback") || "[]");
      drafts.push({ ...formData, savedAt: new Date().toISOString() });
      localStorage.setItem("immigrationFeedback", JSON.stringify(drafts));
      form.reset();
      return;
    }
  }

  const drafts = JSON.parse(localStorage.getItem("immigrationFeedback") || "[]");
  drafts.push({ ...formData, savedAt: new Date().toISOString() });
  localStorage.setItem("immigrationFeedback", JSON.stringify(drafts));
  form.reset();
});

window.addEventListener("hashchange", () => {
  const route = window.location.hash.replace("#", "");
  if (route) {
    setView(route);
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    const overlay = document.getElementById("modalOverlay");
    if (overlay?.classList.contains("active")) {
      closeArticleModal();
    }
  }
});

function updateAuthUI() {
  const authSection = document.querySelector("[data-auth]");
  const loginBtn = document.querySelector("#sidebarAuth");
  const userArea = document.querySelector("#sidebarUser");
  if (state.user) {
    authSection.style.display = "";
    loginBtn.classList.add("hidden");
    userArea.classList.remove("hidden");
    refreshNews.hidden = !toolbarViews.includes(state.view);
    document.querySelector("#userName").textContent = state.user.username;
    document.querySelector("#userAvatar").textContent = state.user.username.charAt(0).toUpperCase();
  } else {
    authSection.style.display = "none";
    loginBtn.classList.remove("hidden");
    userArea.classList.add("hidden");
    refreshNews.hidden = true;
  }
}

document.querySelector("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = Object.fromEntries(new FormData(form).entries());
  const note = document.querySelector("#loginNote");

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(formData),
    });
    const data = await response.json();
    if (!response.ok) {
      note.textContent = data.error || "登录失败";
      return;
    }
    state.user = { username: data.username };
    form.reset();
    note.textContent = "";
    updateAuthUI();
    setView("home");
  } catch (err) {
    note.textContent = "网络错误：" + err.message;
  }
});

document.querySelector("#logoutBtn").addEventListener("click", async () => {
  try {
    await fetch("/api/logout", { method: "POST" });
  } catch { /* ignore */ }
  state.user = null;
  updateAuthUI();
  setView("home");
});

async function checkAuth() {
  if (window.location.protocol === "file:") return;
  try {
    const res = await fetch("/api/me");
    const data = await res.json();
    if (data.loggedIn) {
      state.user = { username: data.username };
    }
  } catch { /* ignore */ }
}

const todayDate = document.querySelector("#todayDate");
if (todayDate) {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const iso = `${y}-${m}-${d}`;
  todayDate.setAttribute("datetime", iso);
  todayDate.textContent = `${y}.${m}.${d}`;
}

async function boot() {
  await recordSsoVisitFromHash();
  await loadSsoIdentity();
  const initialView = window.location.hash.replace("#", "") || "home";
  restoreFilterCategory();
  renderContent();
  await checkAuth();
  updateAuthUI();
  setView(initialView);
  loadLiveNews();
}

boot();

function showArticleModal(cardEl, url) {
  let overlay = document.getElementById("modalOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "modalOverlay";
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);
  }
  const title = cardEl.querySelector("h3")?.textContent || "";
  const summary = cardEl.querySelector(".news-body p")?.textContent || "";
  const source = cardEl.querySelector(".meta-row span:nth-child(2)")?.textContent || "";
  const time = cardEl.querySelector(".meta-row span:nth-child(3)")?.textContent || "";
  const heat = cardEl.querySelector(".priority")?.textContent || "";
  const impact = cardEl.querySelector(".tag.impact")?.textContent || "";
  const tags = [...cardEl.querySelectorAll(".tag-row .tag:not(.impact)")].map((t) => t.textContent);
  const image = cardEl.querySelector(".thumb img")?.src || "";

  overlay.innerHTML = `
    <div class="modal-content">
      <button class="modal-close">&times;</button>
      ${image ? `<img class="modal-image" src="${image}" alt="" />` : ""}
      <div class="modal-header">
        <h2>${escapeHtml(title)}</h2>
        <div class="modal-meta">
          <span>${escapeHtml(source)}</span>
          <span>${escapeHtml(time)}</span>
          ${heat ? `<span class="priority">${escapeHtml(heat)}</span>` : ""}
        </div>
        <div class="tag-row">
          ${impact ? `<span class="tag impact">${escapeHtml(impact)}</span>` : ""}
          ${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}
        </div>
      </div>
      <div class="modal-body">
        <p>${escapeHtml(summary)}</p>
      </div>
      <div class="modal-actions">
        <a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" class="modal-link">查看原文 →</a>
      </div>
    </div>
  `;
  overlay.classList.add("active");
  document.body.style.overflow = "hidden";
}

function closeArticleModal() {
  const overlay = document.getElementById("modalOverlay");
  if (overlay) {
    overlay.classList.remove("active");
  }
  document.body.style.overflow = "";
}
