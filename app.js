const categories = ["全部", "美国", "加拿大", "英国", "澳新", "欧洲", "EB-5", "排期", "签证", "投资", "雇主担保", "官方"];

const demoNewsItems = [
  {
    id: 1,
    title: "EB-5 投资移民进入高频问询期，区域中心、资金路径和排期成为核心问题",
    summary:
      "客户关注点从单纯项目收益转向资金证明、I-526E 周期和排期风险，顾问需要准备更细的节点解释。",
    source: "项目快照",
    country: "美国",
    category: "EB-5",
    time: "09:20",
    heat: 97,
    impact: "高影响",
    tags: ["美国", "EB-5", "投资"],
    image:
      "https://images.unsplash.com/photo-1554224155-6726b3ff858f?auto=format&fit=crop&w=360&q=80",
  },
  {
    id: 2,
    title: "职业移民排期解读需求上升，亲属移民和职业移民咨询需分流",
    summary:
      "排期信息会直接影响签约预期，建议销售页面加入“排期解释”和“适配人群”两个固定模块。",
    source: "Visa Bulletin",
    country: "美国",
    category: "排期",
    time: "10:05",
    heat: 91,
    impact: "高影响",
    tags: ["美国", "排期", "职业移民"],
    image:
      "https://images.unsplash.com/photo-1464037866556-6812c9d1c72e?auto=format&fit=crop&w=360&q=80",
  },
  {
    id: 3,
    title: "加拿大快速通道客户更关心邀请节奏，省提名仍是转化关键点",
    summary:
      "高分候选人倾向等待邀请，分数边缘客户更需要省提名路径和雇主资源解释。",
    source: "IRCC Watch",
    country: "加拿大",
    category: "雇主担保",
    time: "11:10",
    heat: 86,
    impact: "中影响",
    tags: ["加拿大", "EE", "省提名"],
    image:
      "https://images.unsplash.com/photo-1523240795612-9a054b0db644?auto=format&fit=crop&w=360&q=80",
  },
  {
    id: 4,
    title: "澳大利亚技术移民咨询回暖，职业评估和英语成绩成为前置筛选门槛",
    summary:
      "文案团队可把职业清单、州担保要求和英语成绩拆成三段检查表，提高初筛效率。",
    source: "Home Affairs",
    country: "澳新",
    category: "签证",
    time: "12:30",
    heat: 78,
    impact: "中影响",
    tags: ["澳新", "技术移民", "签证"],
    image:
      "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=360&q=80",
  },
  {
    id: 5,
    title: "欧洲黄金签证进入合规叙事阶段，税务居民和资产来源说明变得更重要",
    summary:
      "投资移民页面不宜只强调身份获取，应同步呈现居住要求、税务影响和续签条件。",
    source: "EU Policy Notes",
    country: "欧洲",
    category: "投资",
    time: "14:05",
    heat: 74,
    impact: "中影响",
    tags: ["欧洲", "投资", "合规"],
    image:
      "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=360&q=80",
  },
  {
    id: 6,
    title: "美国身份规划客户开始比较 EB-1、NIW 与 EB-5 的组合路径",
    summary:
      "高净值客户更愿意同时评估人才类和投资类路径，咨询话术需要从单项目介绍转为方案组合。",
    source: "顾问观察",
    country: "美国",
    category: "签证",
    time: "15:45",
    heat: 82,
    impact: "高影响",
    tags: ["美国", "NIW", "EB-1", "EB-5"],
    image:
      "https://images.unsplash.com/photo-1521791136064-7986c2920216?auto=format&fit=crop&w=360&q=80",
  },
  {
    id: 7,
    title: "新西兰投资和创业相关咨询回升，资金来源解释仍是成交前风险点",
    summary:
      "建议把资金来源、商业背景和登陆后经营安排提前形成材料清单。",
    source: "NZ Immigration",
    country: "澳新",
    category: "投资",
    time: "16:20",
    heat: 68,
    impact: "低影响",
    tags: ["澳新", "投资", "创业"],
    image:
      "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=360&q=80",
  },
];

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
      risk: riskLevel,
      riskText,
      value,
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
  items: demoNewsItems,
  sourceStatus: [],
  dailyReport: null,
  dailyLoading: false,
  liveMeta: {
    mode: "demo",
    text: "演示数据 · 启动服务后自动抓取",
  },
  user: null,
};

const authViews = ["sources", "about", "changelog", "feedback"];
const views = ["home", "all", "daily", "radar", "login", "sources", "about", "changelog", "feedback"];

const filterStrip = document.querySelector("#filterStrip");
const featuredFeed = document.querySelector("#featuredFeed");
const allFeed = document.querySelector("#allFeed");
const snapshotList = document.querySelector("#snapshotList");
const radarGrid = document.querySelector("#radarGrid");
const searchInput = document.querySelector("#searchInput");
const homeCount = document.querySelector("#homeCount");
const allCount = document.querySelector("#allCount");
const dailyReport = document.querySelector("#dailyReport");
const monitorStatus = document.querySelector("#monitorStatus");
const sourceHealth = document.querySelector("#sourceHealth");
const refreshNews = document.querySelector("#refreshNews");

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

function matchesItem(item) {
  const inCategory =
    state.category === "全部" ||
    item.country === state.category ||
    item.category === state.category ||
    (item.tags || []).includes(state.category);

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

function renderFilters() {
  filterStrip.innerHTML = categories
    .map(
      (category) => `
        <button class="chip ${state.category === category ? "active" : ""}" type="button" data-category="${category}">
          ${category}
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
  if (state.dailyReport?.html) {
    dailyReport.innerHTML = `
      <div class="daily-meta">
        <strong>${escapeHtml(state.dailyReport.title || "移民热点日报")}</strong>
        <span>${escapeHtml(state.dailyReport.model || "AI")} · ${escapeHtml(state.dailyReport.sourceItemCount || 0)} 条来源</span>
      </div>
      ${state.dailyReport.html}
    `;
    return;
  }

  if (state.dailyLoading) {
    dailyReport.innerHTML = '<div class="empty">DeepSeek 正在生成今日移民日报...</div>';
    return;
  }

  const topItems = filteredItems().slice(0, 5);
  const countries = [...new Set(state.items.map((item) => item.country).filter(Boolean))].slice(0, 4);
  const keyCategories = [...new Set(topItems.map((item) => item.category).filter(Boolean))].slice(0, 4);
  const sourceText =
    state.liveMeta.mode === "live"
      ? `本简报基于 ${state.liveMeta.itemCount} 条实时抓取信息，来自 ${state.liveMeta.sourceCount} 个信源。`
      : "本简报当前使用内置演示数据；通过本地服务打开后会自动切换为实时信源。";

  dailyReport.innerHTML = `
    <h2>一、今日总结</h2>
    <p>
      ${escapeHtml(sourceText)} 今日关注区域包括 <strong>${escapeHtml(countries.join("、") || "美国、加拿大")}</strong>，重点主题集中在 ${escapeHtml(keyCategories.join("、") || "EB-5、排期、签证")}。
    </p>
    <h2>二、重要信息</h2>
    <ul>
      <li><strong>EB-5</strong>：资金路径、区域中心和排期仍是高频问题，适合制作单独 FAQ。</li>
      <li><strong>排期</strong>：任何职业移民方案都应同步解释等待周期，避免客户预期偏差。</li>
      <li><strong>雇主担保</strong>：加拿大和澳洲客户更依赖雇主资质、职位匹配和材料周期。</li>
    </ul>
    <h2>三、按主题整理</h2>
    <ol>
      ${topItems
        .map((item) => {
          const url = safeUrl(item.url);
          const title = url
            ? `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>`
            : `<strong>${escapeHtml(item.title)}</strong>`;
          return `<li>${title}：${escapeHtml(item.summary)}</li>`;
        })
        .join("")}
    </ol>
    <h2>四、建议关注</h2>
    <p>
      建议项目经理优先更新 EB-5、美国排期、加拿大省提名和澳洲职业评估相关页面；销售团队同步准备排期解释话术和材料清单。
    </p>
  `;
}

function renderRadar() {
  const radarItems = buildRadarItems(state.items);
  radarGrid.innerHTML = radarItems
    .map(
      (item) => `
        <article class="radar-card">
          <header>
            <h2>${item.title}</h2>
            <span class="risk ${item.risk}">${item.riskText}</span>
          </header>
          <p>${item.text}</p>
          <div class="meter" aria-label="${item.title}风险指数 ${item.value}">
            <span style="width: ${item.value}%"></span>
          </div>
        </article>
      `,
    )
    .join("");
}

function renderCounts(items) {
  homeCount.textContent = `${Math.min(items.length, 5)} 条`;
  allCount.textContent = `${items.length} 条`;
}

function renderStatus(items) {
  const healthySources = state.sourceStatus.filter((source) => source.ok).length;
  const failedSources = state.sourceStatus.length - healthySources;

  if (state.liveMeta.mode === "live") {
    monitorStatus.textContent = `${items.length} 条更新 · ${healthySources}/${state.sourceStatus.length} 个信源在线`;
  } else if (state.liveMeta.mode === "loading") {
    monitorStatus.textContent = "正在连接实时信源...";
  } else {
    monitorStatus.textContent = state.liveMeta.text;
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
  const highCount = items.filter((i) => i.heat >= 85).length;
  const countries = new Set(items.map((i) => i.country).filter(Boolean));
  const cats = new Set(items.map((i) => i.category).filter(Boolean));

  const statHigh = document.querySelector("#statHigh");
  const statCountries = document.querySelector("#statCountries");
  const statCategories = document.querySelector("#statCategories");

  if (statHigh) statHigh.textContent = highCount;
  if (statCountries) statCountries.textContent = countries.size;
  if (statCategories) statCategories.textContent = cats.size;
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
  renderRadar();
  renderCounts(items);
  renderStatus(items);
}

function normalizeApiItem(item) {
  return {
    id: item.id,
    title: item.title || "未命名动态",
    summary: item.summary || "查看原文获取完整信息。",
    source: item.source || "未知信源",
    country: item.country || "全球",
    category: item.category || "政策",
    time: item.time || "刚刚",
    heat: Number(item.heat || 60),
    impact: item.impact || "中影响",
    tags: Array.isArray(item.tags) ? item.tags : [],
    image:
      item.image ||
      "https://images.unsplash.com/photo-1521791136064-7986c2920216?auto=format&fit=crop&w=360&q=80",
    url: item.url || "",
    publishedAt: item.publishedAt || null,
  };
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
    if (Array.isArray(data.items) && data.items.length) {
      state.items = data.items.map(normalizeApiItem);
      state.sourceStatus = Array.isArray(data.sources) ? data.sources : [];
      state.liveMeta = {
        mode: "live",
        text: "实时数据",
        itemCount: data.itemCount,
        sourceCount: data.sourceCount,
        generatedAt: data.generatedAt,
      };
    } else {
      state.sourceStatus = Array.isArray(data.sources) ? data.sources : [];
      state.liveMeta = {
        mode: "demo",
        text: "实时信源暂无返回，暂用演示数据",
      };
    }
  } catch (error) {
    state.liveMeta = {
      mode: "demo",
      text: `实时信源连接失败，暂用演示数据`,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    refreshNews.disabled = false;
    refreshNews.textContent = "刷新";
    renderContent();
  }

  loadDailyReport({ refresh });
}

async function loadDailyReport({ refresh = false } = {}) {
  if (window.location.protocol === "file:") {
    return;
  }

  state.dailyLoading = true;
  renderContent();

  try {
    const response = await fetch(`/api/daily${refresh ? "?refresh=1" : ""}`, {
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    state.dailyReport = data.report || null;
  } catch {
    state.dailyReport = null;
  } finally {
    state.dailyLoading = false;
    renderContent();
  }
}

function setView(viewName) {
  if (!views.includes(viewName)) {
    viewName = "home";
  }

  if (authViews.includes(viewName) && !state.user) {
    viewName = "login";
  }

  state.view = viewName;
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("active", view.id === `view-${viewName}`);
  });
  document.querySelectorAll("[data-view]").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === viewName);
  });
  document.body.classList.remove("menu-open");
  window.location.hash = viewName;
}

document.addEventListener("click", (event) => {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) {
    setView(viewButton.dataset.view);
    return;
  }

  const categoryButton = event.target.closest("[data-category]");
  if (categoryButton) {
    state.category = categoryButton.dataset.category;
    renderContent();
  }
});

searchInput.addEventListener("input", (event) => {
  state.query = event.target.value;
  renderContent();
});

refreshNews.addEventListener("click", () => {
  loadLiveNews({ refresh: true });
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
  const formData = Object.fromEntries(new FormData(form).entries());

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
      document.querySelector("#feedbackNote").textContent = "已保存到数据库。";
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
  const view = window.location.hash.replace("#", "");
  if (view) {
    setView(view);
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
    refreshNews.hidden = false;
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

const initialView = window.location.hash.replace("#", "") || "home";
renderContent();
checkAuth().then(() => {
  updateAuthUI();
  setView(initialView);
});
loadLiveNews();
