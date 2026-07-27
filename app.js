const maxFilterChips = 18;
const filterViews = ["home", "all"];
const toolbarViews = ["home", "all"];
const filterCategoryStorageKey = "yiminHot.filterCategory";
const languageStorageKey = "yiminHot.language";
const supportedLanguages = new Set(["zh", "en"]);

const i18n = {
  zh: {
    "app.title": "移民热点 · Immigration Hot",
    "briefInfo.aria": "查看移民早报说明",
    "briefInfo.button": "说明",
    "briefInfo.closeAria": "关闭移民早报说明",
    "briefInfo.eyebrow": "使用说明",
    "briefInfo.title": "关于移民早报的说明",
    "briefInfo.intro": "「移民早报」是由系统辅助生成的移民政策信息简报。",
    "briefInfo.sourceText": "我们会持续采集来自政策官网、行业协会、知名律所等 {count} 个公开信息源的最新动态，并通过 AI 对内容进行去重、聚合、提取和整理，帮助大家快速了解每日重点政策变化。",
    "briefInfo.sourceTextLoading": "我们会持续采集来自政策官网、行业协会、知名律所等多个公开信息源的最新动态，并通过 AI 对内容进行去重、聚合、提取和整理，帮助大家快速了解每日重点政策变化。",
    "briefInfo.deliveryTime": "推送时间",
    "briefInfo.deliveryTimeValue": "每天早上 8:50",
    "briefInfo.deliveryMethod": "推送方式",
    "briefInfo.deliveryMethodValue": "通过「企业微信 - 移民早报」送达每个人眼前",
    "briefInfo.noticeTitle": "需要说明的是",
    "briefInfo.notice1": "内容来源于公开渠道，不是 AI 凭空生成；",
    "briefInfo.notice2": "AI 主要负责信息整理和摘要提炼，用于提升阅读效率；",
    "briefInfo.notice3": "具体业务判断仍需结合原文链接、官方文件和专业判断；",
    "briefInfo.notice4": "如涉及客户沟通、方案调整或重大政策解读，请以官方原文和业务负责人确认为准。",
    "briefInfo.gotIt": "我知道了",
    "nav.home": "精选热点",
    "nav.all": "全部动态",
    "nav.daily": "移民日报",
    "nav.radar": "政策雷达",
    "nav.feedback": "反馈建议",
    "nav.changelog": "更新日志",
    "nav.subscriptions": "我的关注",
    "nav.tools": "工具",
    "nav.market": "市场素材",
    "nav.sources": "信源提报",
    "nav.review": "信源审核",
    "nav.ssoStats": "访问统计",
    "nav.departmentSubscriptions": "部门关注",
    "nav.feedbackReview": "反馈意见查看",
    "nav.about": "关于本站",
    "nav.expand": "展开导航",
    "language.aria": "语言切换",
    "theme.dark": "深色",
    "theme.system": "跟随系统",
    "theme.light": "浅色",
    "theme.darkTitle": "使用深色主题",
    "theme.systemTitle": "跟随系统主题",
    "theme.lightTitle": "使用浅色主题",
    "common.login": "登录",
    "common.logout": "登出",
    "common.refresh": "刷新",
    "common.refreshing": "刷新中",
    "common.fetching": "抓取中",
    "common.loading": "加载中...",
    "common.all": "全部",
    "common.items": "条",
    "common.source": "信源",
    "common.sources": "信源",
    "common.global": "全球",
    "common.policy": "政策",
    "common.uncategorized": "未分类",
    "common.unknownSource": "未知信源",
    "common.untitledUpdate": "未命名动态",
    "common.readOriginal": "查看原文获取完整信息。",
    "common.viewOriginal": "查看原文 →",
    "common.justNow": "刚刚",
    "common.noData": "暂无数据",
    "common.noMatchingHotspots": "没有匹配的热点，换个关键词试试。",
    "search.placeholder": "搜索国家、项目、签证、机构...",
    "status.todayMonitor": "今日监测",
    "status.demo": "演示数据 · 启动服务后自动抓取",
    "status.connecting": "正在连接实时信源...",
    "status.live": "今日监测 {count} 条更新",
    "status.fetching": "后台抓取中 {processed}/{total} 个信源 · {progress}% · 已入库 {count} 条",
    "status.noHistory": "后台抓取任务已启动，暂无历史文章可展示",
    "status.noLive": "实时信源暂无真实返回",
    "home.eyebrow": "精选热点",
    "home.title": "今天值得移民顾问先看的动态",
    "home.brief": "今日速览",
    "home.highPriority": "条高优先级",
    "home.countries": "个国家/地区",
    "home.categories": "类客户影响",
    "home.liveHotspots": "实时热点",
    "home.snapshot": "项目快照",
    "home.noLead": "暂无热点数据",
    "home.noSnapshot": "暂无真实热点快照，等待信源抓取入库。",
    "home.snapshotWait": "等待信源抓取后自动生成项目快照。",
    "all.eyebrow": "全部动态",
    "all.title": "移民热点时间线",
    "radar.eyebrow": "政策雷达",
    "radar.title": "项目经理关注面板",
    "radar.risk.high": "高",
    "radar.risk.medium": "中",
    "radar.risk.low": "低",
    "radar.articleCount": "{count} 篇文章",
    "radar.back": "← 返回雷达",
    "radar.meterAria": "{title}风险指数 {value}",
    "radar.multipleMarkets": "多个国家",
    "radar.relatedText": "{markets}相关动态 {count} 条，需要关注最新变化。",
    "radar.noSignal": "近期暂无明显风险信号，保持关注即可。",
    "radar.rule.visaBulletin": "排期风险",
    "radar.rule.funds": "资金合规",
    "radar.rule.employer": "雇主依赖",
    "radar.rule.documents": "材料周期",
    "radar.rule.policy": "政策变动",
    "radar.rule.visa": "签证动态",
    "daily.eyebrow": "移民日报",
    "daily.title": "今日政策简报",
    "daily.manageSubscriptions": "管理我的关注",
    "daily.copy": "复制日报",
    "daily.copied": "已复制",
    "daily.copyFailed": "复制失败",
    "daily.history": "历史日报",
    "daily.public": "公共日报",
    "daily.department": "部门日报",
    "daily.departmentFocus": "{name} 部门重点",
    "daily.personal": "我的关注",
    "daily.defaultTitle": "移民热点日报",
    "daily.meta": "{model} · 全量 {sourceCount} 条{extra}",
    "daily.analyzedMeta": " · 相关 {relevantCount} 条 · 聚合 {eventCount} 个事件",
    "daily.generating": "正在加载日报...",
    "daily.empty": "暂无已生成日报。请点击刷新或访问日报接口生成，页面不会再展示演示内容。",
    "daily.perspectiveLabel": "日报视角",
    "subscriptions.eyebrow": "个性化日报",
    "subscriptions.title": "管理我的关注",
    "subscriptions.intro": "公共日报会照常发送。这里选择的信源会作为你的专属关注补充，不会额外为每个人重复生成整份 AI 日报。",
    "subscriptions.search": "搜索信源名称",
    "subscriptions.save": "保存关注",
    "subscriptions.count": "{count} 个已关注",
    "subscriptions.identifying": "正在识别企业微信身份...",
    "feedback.eyebrow": "反馈",
    "feedback.title": "感谢您的宝贵意见",
    "feedback.type": "反馈类型",
    "feedback.typeAccuracy": "内容准确性",
    "feedback.typeSource": "信息源补充",
    "feedback.typeExperience": "页面体验",
    "feedback.typeDaily": "日报质量",
    "feedback.typeWorkflow": "业务流程",
    "feedback.module": "相关页面",
    "feedback.moduleDaily": "移民日报",
    "feedback.moduleHome": "精选热点",
    "feedback.moduleAll": "全部动态",
    "feedback.moduleRadar": "政策雷达",
    "feedback.moduleMarket": "市场素材",
    "feedback.moduleOther": "其他",
    "feedback.priority": "优先级",
    "feedback.priorityNormal": "一般建议",
    "feedback.priorityHigh": "影响工作",
    "feedback.priorityUrgent": "需要尽快处理",
    "feedback.contact": "联系方式（选填）",
    "feedback.contactPlaceholder": "邮箱、电话或企业微信",
    "feedback.message": "具体说明",
    "feedback.messagePlaceholder": "请描述遇到的问题、希望补充的信息，或你认为更好用的方式。",
    "feedback.submit": "提交反馈",
    "feedback.reset": "清空",
    "feedback.note": "提交后我们会尽快查看。",
    "feedback.received": "已收到，感谢您的反馈。",
    "feedback.savedDraft": "数据库提交失败，已保存到本地草稿。",
  },
  en: {
    "app.title": "Immigration Hot",
    "briefInfo.aria": "View daily brief information",
    "briefInfo.button": "Info",
    "briefInfo.closeAria": "Close daily brief information",
    "briefInfo.eyebrow": "Guide",
    "briefInfo.title": "About Immigration Daily News",
    "briefInfo.intro": "Immigration Daily News is a system-assisted immigration policy brief.",
    "briefInfo.sourceText": "We continuously collect updates from {count} public sources, including policy websites, industry associations, and reputable law firms. AI helps deduplicate, cluster, extract, and organize the information so the team can quickly understand key policy changes.",
    "briefInfo.sourceTextLoading": "We continuously collect updates from public sources, including policy websites, industry associations, and reputable law firms. AI helps deduplicate, cluster, extract, and organize the information so the team can quickly understand key policy changes.",
    "briefInfo.deliveryTime": "Delivery Time",
    "briefInfo.deliveryTimeValue": "Every morning at 8:50",
    "briefInfo.deliveryMethod": "Delivery Method",
    "briefInfo.deliveryMethodValue": "Delivered through WeChat Work - Immigration Daily News",
    "briefInfo.noticeTitle": "Important Notes",
    "briefInfo.notice1": "Content comes from public sources and is not invented by AI.",
    "briefInfo.notice2": "AI is mainly used for organization and summarization to improve reading efficiency.",
    "briefInfo.notice3": "Business decisions should still be based on original links, official documents, and professional judgment.",
    "briefInfo.notice4": "For client communication, plan changes, or major policy interpretation, rely on official originals and confirmation from business owners.",
    "briefInfo.gotIt": "Got it",
    "nav.home": "Highlights",
    "nav.all": "All Updates",
    "nav.daily": "Daily Brief",
    "nav.radar": "Policy Radar",
    "nav.feedback": "Feedback",
    "nav.changelog": "Changelog",
    "nav.subscriptions": "My Sources",
    "nav.tools": "Tools",
    "nav.market": "Market Brief",
    "nav.sources": "Submit Source",
    "nav.review": "Source Review",
    "nav.ssoStats": "Access Stats",
    "nav.departmentSubscriptions": "Dept Sources",
    "nav.feedbackReview": "Feedback Review",
    "nav.about": "About",
    "nav.expand": "Open navigation",
    "language.aria": "Language switcher",
    "theme.dark": "Dark",
    "theme.system": "System",
    "theme.light": "Light",
    "theme.darkTitle": "Use dark theme",
    "theme.systemTitle": "Follow system theme",
    "theme.lightTitle": "Use light theme",
    "common.login": "Log In",
    "common.logout": "Log Out",
    "common.refresh": "Refresh",
    "common.refreshing": "Refreshing",
    "common.fetching": "Fetching",
    "common.loading": "Loading...",
    "common.all": "All",
    "common.items": "items",
    "common.source": "source",
    "common.sources": "sources",
    "common.global": "Global",
    "common.policy": "Policy",
    "common.uncategorized": "Uncategorized",
    "common.unknownSource": "Unknown source",
    "common.untitledUpdate": "Untitled update",
    "common.readOriginal": "Open the original article for full details.",
    "common.viewOriginal": "View Original →",
    "common.justNow": "Just now",
    "common.noData": "No data",
    "common.noMatchingHotspots": "No matching updates. Try another keyword.",
    "search.placeholder": "Search countries, programs, visas, agencies...",
    "status.todayMonitor": "Today",
    "status.demo": "Demo data · Start the service to fetch live sources",
    "status.connecting": "Connecting to live sources...",
    "status.live": "{count} updates monitored today",
    "status.fetching": "Fetching in background {processed}/{total} sources · {progress}% · {count} saved",
    "status.noHistory": "Background fetch started. No historical articles yet.",
    "status.noLive": "No live source results yet",
    "home.eyebrow": "Highlights",
    "home.title": "Updates immigration consultants should read first today",
    "home.brief": "At A Glance",
    "home.highPriority": "high priority",
    "home.countries": "countries/regions",
    "home.categories": "client impact areas",
    "home.liveHotspots": "Live Hotspots",
    "home.snapshot": "Program Snapshot",
    "home.noLead": "No hotspot data yet",
    "home.noSnapshot": "No live snapshot yet. Waiting for sources to be fetched.",
    "home.snapshotWait": "Program snapshots will appear after source data is fetched.",
    "all.eyebrow": "All Updates",
    "all.title": "Immigration Update Timeline",
    "radar.eyebrow": "Policy Radar",
    "radar.title": "Program Manager Watchlist",
    "radar.risk.high": "High",
    "radar.risk.medium": "Medium",
    "radar.risk.low": "Low",
    "radar.articleCount": "{count} {articleWord}",
    "radar.back": "← Back to Radar",
    "radar.meterAria": "{title} risk index {value}",
    "radar.multipleMarkets": "Multiple markets",
    "radar.relatedText": "{markets}: {count} related {updateWord}. Watch for the latest changes.",
    "radar.noSignal": "No clear risk signal recently. Keep monitoring.",
    "radar.rule.visaBulletin": "Visa Bulletin Risk",
    "radar.rule.funds": "Funds Compliance",
    "radar.rule.employer": "Employer Dependency",
    "radar.rule.documents": "Document Timeline",
    "radar.rule.policy": "Policy Change",
    "radar.rule.visa": "Visa Updates",
    "daily.eyebrow": "Daily Brief",
    "daily.title": "Today's Policy Brief",
    "daily.manageSubscriptions": "Manage My Sources",
    "daily.copy": "Copy Brief",
    "daily.copied": "Copied",
    "daily.copyFailed": "Copy Failed",
    "daily.history": "History",
    "daily.public": "Public Brief",
    "daily.department": "Department Brief",
    "daily.departmentFocus": "{name} Department Focus",
    "daily.personal": "My Sources",
    "daily.defaultTitle": "Immigration Daily News",
    "daily.meta": "{model} · {sourceCount} total items{extra}",
    "daily.analyzedMeta": " · {relevantCount} relevant · {eventCount} events",
    "daily.generating": "Loading daily brief...",
    "daily.empty": "No generated daily brief yet. Refresh or call the daily API to generate one.",
    "daily.perspectiveLabel": "Daily brief perspective",
    "subscriptions.eyebrow": "Personalized Brief",
    "subscriptions.title": "Manage My Sources",
    "subscriptions.intro": "The public daily brief will still be sent. Sources selected here become your personal supplement, without regenerating a full AI brief for every person.",
    "subscriptions.search": "Search source name",
    "subscriptions.save": "Save Sources",
    "subscriptions.count": "{count} followed",
    "subscriptions.identifying": "Identifying WeChat Work user...",
    "feedback.eyebrow": "Feedback",
    "feedback.title": "Thanks for Your Feedback",
    "feedback.type": "Feedback Type",
    "feedback.typeAccuracy": "Content Accuracy",
    "feedback.typeSource": "Source Suggestion",
    "feedback.typeExperience": "Page Experience",
    "feedback.typeDaily": "Daily Brief Quality",
    "feedback.typeWorkflow": "Workflow",
    "feedback.module": "Related Page",
    "feedback.moduleDaily": "Daily Brief",
    "feedback.moduleHome": "Highlights",
    "feedback.moduleAll": "All Updates",
    "feedback.moduleRadar": "Policy Radar",
    "feedback.moduleMarket": "Market Brief",
    "feedback.moduleOther": "Other",
    "feedback.priority": "Priority",
    "feedback.priorityNormal": "General Suggestion",
    "feedback.priorityHigh": "Work Impact",
    "feedback.priorityUrgent": "Needs Quick Attention",
    "feedback.contact": "Contact (optional)",
    "feedback.contactPlaceholder": "Email, phone, or WeChat Work",
    "feedback.message": "Details",
    "feedback.messagePlaceholder": "Describe the issue, source to add, or what would make this easier to use.",
    "feedback.submit": "Submit Feedback",
    "feedback.reset": "Clear",
    "feedback.note": "We will review your feedback as soon as possible.",
    "feedback.received": "Received. Thanks for your feedback.",
    "feedback.savedDraft": "Database submission failed. Saved as a local draft.",
  },
};

function getSavedLanguage() {
  try {
    const saved = localStorage.getItem(languageStorageKey);
    if (supportedLanguages.has(saved)) return saved;
  } catch {
    // ignore storage errors
  }
  return navigator.language?.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function t(key, params = {}) {
  const dictionary = i18n[state?.language || "zh"] || i18n.zh;
  const template = dictionary[key] || i18n.zh[key] || key;
  return String(template).replace(/\{(\w+)\}/g, (_match, name) => params[name] ?? "");
}

function translateCount(count) {
  return state.language === "en" ? `${count} ${t("common.items")}` : `${count} 条`;
}

function translateCategoryLabel(category) {
  if (category === "全部") return t("common.all");
  return state.language === "en" ? translateLabelToEnglish(category) || category : category;
}

const englishLabelFallbackMap = new Map([
  ["高影响", "High Impact"],
  ["中影响", "Medium Impact"],
  ["低影响", "Low Impact"],
  ["美国", "United States"],
  ["加拿大", "Canada"],
  ["英国", "United Kingdom"],
  ["欧盟", "European Union"],
  ["欧洲", "Europe"],
  ["希腊", "Greece"],
  ["西班牙", "Spain"],
  ["土耳其", "Turkey"],
  ["香港", "Hong Kong"],
  ["葡萄牙", "Portugal"],
  ["韩国", "South Korea"],
  ["日本", "Japan"],
  ["新加坡", "Singapore"],
  ["德国", "Germany"],
  ["法国", "France"],
  ["意大利", "Italy"],
  ["爱尔兰", "Ireland"],
  ["澳新", "Australia / New Zealand"],
  ["澳大利亚", "Australia"],
  ["新西兰", "New Zealand"],
  ["全球", "Global"],
  ["其他", "Other"],
  ["政策", "Policy"],
  ["签证", "Visa"],
  ["排期", "Visa Bulletin"],
  ["雇主担保", "Employer Sponsorship"],
  ["官方", "Official"],
  ["官方机构", "Official Agency"],
  ["投资", "Investment"],
  ["工签", "Work Permit"],
  ["留学", "Study Abroad"],
  ["韩国政策简报-法务部", "South Korea Policy Brief - Ministry of Justice"],
  ["EB-5", "EB-5"],
  ["NIW", "NIW"],
  ["EB-1", "EB-1"],
  ["EE", "Express Entry"],
  ["PNP", "PNP"],
]);

function translateLabelToEnglish(value) {
  const text = cleanFilterLabel(value);
  return text ? (englishLabelFallbackMap.get(text) || text) : "";
}

function applyStaticTranslations() {
  document.documentElement.lang = state.language === "en" ? "en" : "zh-CN";
  document.title = t("app.title");
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
    node.setAttribute("placeholder", t(node.dataset.i18nPlaceholder));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((node) => {
    node.setAttribute("title", t(node.dataset.i18nTitle));
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((node) => {
    node.setAttribute("aria-label", t(node.dataset.i18nAriaLabel));
  });
  document.querySelectorAll("[data-lang-option]").forEach((button) => {
    const active = button.dataset.langOption === state.language;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  renderBriefInfo();
}

function renderBriefInfo() {
  const intro = document.querySelector("#briefInfoIntro");
  const sourceText = document.querySelector("#briefInfoSourceText");
  if (intro) {
    intro.textContent = t("briefInfo.intro");
  }
  if (!sourceText) return;

  const count = Number(state?.sourceStats?.enabledCount || 0);
  const content = count > 0
    ? t("briefInfo.sourceText", { count })
    : t("briefInfo.sourceTextLoading");
  sourceText.textContent = content;
}

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
    return [{ title: t("common.noData"), text: t("home.snapshotWait") }];
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

function getRadarRules() {
  return [
    {
      key: "visa_bulletin",
      titleKey: "radar.rule.visaBulletin",
      keywords: ["排期", "visa bulletin", "priority date", "等待", "cut-off date", "final action date", "dates for filing"],
      displayKeywords: {
        zh: ["排期", "优先日", "等待时间"],
        en: ["Visa Bulletin", "Priority Date", "Cut-off Date"],
      },
      baseRisk: "high",
      legacyTitles: ["排期风险"],
    },
    {
      key: "funds_compliance",
      titleKey: "radar.rule.funds",
      keywords: ["资金", "investor", "投资", "source of funds", "合规", "funds", "investment"],
      displayKeywords: {
        zh: ["资金", "投资", "合规"],
        en: ["Funds", "Investment", "Source of Funds"],
      },
      baseRisk: "high",
      legacyTitles: ["资金合规"],
    },
    {
      key: "employer_dependency",
      titleKey: "radar.rule.employer",
      keywords: ["employer", "担保", "sponsor", "雇主", "lmia", "labor certification", "employment"],
      displayKeywords: {
        zh: ["雇主", "担保", "LMIA"],
        en: ["Employer", "Sponsor", "LMIA"],
      },
      baseRisk: "medium",
      legacyTitles: ["雇主依赖"],
    },
    {
      key: "document_timeline",
      titleKey: "radar.rule.documents",
      keywords: ["材料", "document", "认证", "评估", "语言", "credential", "assessment", "language test"],
      displayKeywords: {
        zh: ["材料", "认证", "语言"],
        en: ["Documents", "Credential Assessment", "Language Test"],
      },
      baseRisk: "medium",
      legacyTitles: ["材料周期"],
    },
    {
      key: "policy_change",
      titleKey: "radar.rule.policy",
      keywords: ["policy", "政策", "rule", "regulation", "fee", "新规", "guidance", "update"],
      displayKeywords: {
        zh: ["政策", "新规", "费用"],
        en: ["Policy", "Rule", "Fee"],
      },
      baseRisk: "medium",
      legacyTitles: ["政策变动"],
    },
    {
      key: "visa_updates",
      titleKey: "radar.rule.visa",
      keywords: ["visa", "签证", "permit", "工签", "绿卡", "work permit", "green card", "residence"],
      displayKeywords: {
        zh: ["签证", "工签", "绿卡"],
        en: ["Visa", "Work Permit", "Green Card"],
      },
      baseRisk: "low",
      legacyTitles: ["签证动态"],
    },
  ];
}

function getRadarSearchText(item) {
  return [
    item.title,
    item.summary,
    item.originalTitle,
    item.originalSummary,
    item.country,
    item.countryEn,
    item.category,
    item.categoryEn,
    item.impact,
    item.impactEn,
    ...(item.tags || []),
    ...(item.tagsEn || []),
  ]
    .join(" ")
    .toLowerCase();
}

function getRadarArticleCount(count) {
  return t("radar.articleCount", {
    count,
    articleWord: count === 1 ? "article" : "articles",
  });
}

function getRadarRelatedText(markets, count) {
  return t("radar.relatedText", {
    markets,
    count,
    updateWord: count === 1 ? "update" : "updates",
  });
}

function buildRadarItems(items) {
  return getRadarRules().map((rule) => {
    const matched = items.filter((item) => {
      const text = getRadarSearchText(item);
      return rule.keywords.some((kw) => text.includes(kw));
    });
    const count = matched.length;
    const baseValue = rule.baseRisk === "high" ? 75 : rule.baseRisk === "medium" ? 55 : 40;
    const value = Math.min(99, Math.max(30, baseValue + count * 3));
    const riskLevel = value >= 75 ? "high" : value >= 55 ? "medium" : "low";
    const marketSeparator = state.language === "en" ? ", " : "、";
    const markets = [...new Set(matched.map(getLocalizedCountry).filter(Boolean))]
      .slice(0, 3)
      .join(marketSeparator);

    return {
      key: rule.key,
      legacyTitles: rule.legacyTitles,
      title: t(rule.titleKey),
      keywords: rule.displayKeywords[state.language] || rule.displayKeywords.zh,
      matched,
      risk: riskLevel,
      riskText: t(`radar.risk.${riskLevel}`),
      value,
      count,
      text: count > 0
        ? getRadarRelatedText(markets || t("radar.multipleMarkets"), count)
        : t("radar.noSignal"),
    };
  });
}

const dailyPerspectiveStorageKey = "yiminDailyPerspective";
const dailyPerspectives = new Set(["public", "department", "personal"]);

function getSavedDailyPerspective() {
  try {
    const saved = localStorage.getItem(dailyPerspectiveStorageKey);
    return dailyPerspectives.has(saved) ? saved : "public";
  } catch {
    return "public";
  }
}

const state = {
  view: "home",
  language: getSavedLanguage(),
  category: "全部",
  query: "",
  items: [],
  radarDetail: null,
  marketReportData: null,
  marketLoading: false,
  marketError: "",
  marketHistory: [],
  marketDate: null,
  hAccess: false,
  hActor: null,
  hTopics: [],
  hTopic: null,
  hHistory: [],
  hDate: null,
  hTab: "today",
  hSelectedDraftId: null,
  hSelectedOutlineId: null,
  hEditingViewpointId: null,
  hGeneratingMode: null,
  hGenerationProgress: null,
  hSuiteFailedModes: [],
  hLoading: false,
  hLoadToken: 0,
  hTopicLoadToken: 0,
  hSaving: false,
  hError: "",
  hMessage: "",
  sourceStatus: [],
  dailyReport: null,
  dailyLoading: false,
  dailyHistory: [],
  dailyDate: null,
  dailyPerspective: getSavedDailyPerspective(),
  departmentDailyReports: [],
  departmentDailyLoading: false,
  departmentDailyLoaded: false,
  departmentDailyMissingSync: false,
  departmentDailyError: "",
  personalDaily: null,
  personalDailyLoading: false,
  personalDailyError: "",
  subscriptionSources: [],
  subscriptionSelectedIds: new Set(),
  subscriptionLoaded: false,
  subscriptionLoading: false,
  subscriptionSaving: false,
  subscriptionError: "",
  subscriptionSearch: "",
  subscriptionCountry: "",
  subscriptionCategory: "",
  subscriptionOnlySelected: false,
  departmentSubscriptions: [],
  departmentSubscriptionSources: [],
  departmentSubscriptionSelectedId: null,
  departmentSubscriptionSelectedSourceIds: new Set(),
  departmentSubscriptionSearch: "",
  departmentSubscriptionPickerQuery: "",
  departmentSubscriptionPickerOpen: false,
  departmentSubscriptionLoading: false,
  departmentSubscriptionSaving: false,
  departmentSubscriptionError: "",
  sourceDistributionSources: [],
  sourceDistributionLoading: false,
  sourceDistributionSavingId: null,
  sourceDistributionError: "",
  sourceDistributionSearch: "",
  ssoStats: null,
  ssoStatsLoading: false,
  ssoStatsError: "",
  feedbackItems: [],
  feedbackLoading: false,
  feedbackError: "",
  feedbackStatus: "all",
  ssoUserName: sessionStorage.getItem("yiminSsoUserName") || "",
  ssoUserId: sessionStorage.getItem("yiminSsoUserId") || "",
  ssoLocalTest: false,
  sourceStats: {
    enabledCount: null,
    totalCount: null,
    publicDailyCount: null,
  },
  liveMeta: {
    mode: "idle",
    text: "等待真实信源数据",
  },
  fetchRun: null,
  user: null,
};

const authViews = ["market", "sources", "review", "sso-stats", "department-subscriptions", "feedback-review", "about"];
const views = ["home", "all", "daily", "h-column", "subscriptions", "market", "radar", "feedback", "login", "sources", "review", "sso-stats", "department-subscriptions", "feedback-review", "about", "changelog"];

const filterStrip = document.querySelector("#filterStrip");
const featuredFeed = document.querySelector("#featuredFeed");
const allFeed = document.querySelector("#allFeed");
const snapshotList = document.querySelector("#snapshotList");
const radarGrid = document.querySelector("#radarGrid");
const searchInput = document.querySelector("#searchInput");
const homeCount = document.querySelector("#homeCount");
const allCount = document.querySelector("#allCount");
const dailyReport = document.querySelector("#dailyReport");
const hColumnApp = document.querySelector("#hColumnApp");
const hColumnDate = document.querySelector("#hColumnDate");
const subscriptionList = document.querySelector("#subscriptionList");
const subscriptionIdentity = document.querySelector("#subscriptionIdentity");
const subscriptionCount = document.querySelector("#subscriptionCount");
const subscriptionNote = document.querySelector("#subscriptionNote");
const departmentSubscriptionList = document.querySelector("#departmentSubscriptionList");
const departmentSubscriptionCount = document.querySelector("#departmentSubscriptionCount");
const departmentSubscriptionNote = document.querySelector("#departmentSubscriptionNote");
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

function removeReplacementCharacters(value) {
  return String(value ?? "")
    .replace(/(?:�|&amp;#65533;|&#65533;|\\ufffd)+/gi, "");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function markdownToPlainText(value) {
  return String(value ?? "")
    .replace(/```[\w-]*\n?/g, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~|`)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
    [
      item.title,
      item.summary,
      item.originalTitle,
      item.originalSummary,
      item.source,
      item.country,
      item.countryEn,
      item.category,
      item.categoryEn,
      item.impact,
      item.impactEn,
      ...(item.tags || []),
      ...(item.tagsEn || []),
    ]
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
  return [getLocalizedCountry(item), getLocalizedCategory(item), ...getLocalizedTags(item)]
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
  applyStaticTranslations();
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
          ${escapeHtml(translateCategoryLabel(category))}
        </button>
      `,
    )
    .join("");
}

function renderFeed(container, items) {
  if (!items.length) {
    container.innerHTML = `<div class="empty">${escapeHtml(t("common.noMatchingHotspots"))}</div>`;
    return;
  }

  container.innerHTML = items
    .map((item) => {
      const url = safeUrl(item.url);
      const image = safeUrl(item.image);
      const displayTitle = getLocalizedArticleTitle(item);
      const displaySummary = getLocalizedArticleSummary(item);
      const displaySource = getLocalizedSource(item);
      const displayImpact = getLocalizedImpact(item);
      const displayTags = getLocalizedTags(item);
      const title = escapeHtml(displayTitle);
      const cardContent = `
          <div class="thumb">
            <img src="${escapeAttr(image)}" alt="${escapeAttr(`${getLocalizedCountry(item)}${getLocalizedCategory(item)}相关图片`)}" loading="lazy" />
          </div>
          <div class="news-body">
            <div class="meta-row">
              <span class="source-dot" aria-hidden="true"></span>
              <span>${escapeHtml(displaySource)}</span>
              <span>${escapeHtml(item.time)}</span>
              <span class="priority">HOT ${escapeHtml(item.heat)}</span>
            </div>
            <h3>${title}</h3>
            <p>${escapeHtml(displaySummary)}</p>
            <div class="tag-row">
              <span class="tag impact">${escapeHtml(displayImpact)}</span>
              ${displayTags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
            </div>
          </div>
      `;

      if (url) {
        return `
          <article class="news-card">
            <a class="news-card-link" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" aria-label="打开原文：${escapeAttr(displayTitle)}">
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

function getLocalizedArticleTitle(item) {
  if (state.language === "en") {
    return item.originalTitle || item.title || t("common.untitledUpdate");
  }
  return item.title || item.originalTitle || t("common.untitledUpdate");
}

function getLocalizedArticleSummary(item) {
  if (state.language === "en") {
    return item.originalSummary || item.summary || t("common.readOriginal");
  }
  return item.summary || item.originalSummary || t("common.readOriginal");
}

function getLocalizedSource(item) {
  return state.language === "en"
    ? translateLabelToEnglish(item.source) || item.source || t("common.unknownSource")
    : item.source || t("common.unknownSource");
}

function getLocalizedCountry(item) {
  return state.language === "en"
    ? translateLabelToEnglish(item.countryEn) || translateLabelToEnglish(item.country) || t("common.global")
    : item.country || item.countryEn || t("common.global");
}

function getLocalizedCategory(item) {
  return state.language === "en"
    ? translateLabelToEnglish(item.categoryEn) || translateLabelToEnglish(item.category) || t("common.policy")
    : item.category || item.categoryEn || t("common.policy");
}

function getLocalizedImpact(item) {
  return state.language === "en"
    ? translateLabelToEnglish(item.impactEn) || translateLabelToEnglish(item.impact) || "Medium Impact"
    : item.impact || item.impactEn || "中影响";
}

function getLocalizedTags(item) {
  if (state.language === "en") {
    const tags = Array.isArray(item.tagsEn) && item.tagsEn.length ? item.tagsEn : item.tags;
    return [...new Set((Array.isArray(tags) ? tags : []).map(translateLabelToEnglish).filter(Boolean))];
  }
  return Array.isArray(item.tags) ? item.tags : [];
}

function renderSnapshots() {
  const items = buildSnapshots(state.items);
  if (!items.length) {
    snapshotList.innerHTML = `<div class="empty">${escapeHtml(t("home.noSnapshot"))}</div>`;
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

function renderDepartmentDaily() {
  if (!state.ssoUserId) {
    return `
      <section class="department-daily">
        <div class="department-daily-head">
          <div>
            <p class="eyebrow">直属部门重点</p>
            <h2>尚未识别企业微信身份</h2>
          </div>
        </div>
        <div class="department-daily-empty">从企业微信日报链接进入后，系统会按你的直属部门展示对应重点。</div>
      </section>
    `;
  }

  if (state.departmentDailyLoading) {
    return `
      <section class="department-daily">
        <div class="department-daily-head">
          <div>
            <p class="eyebrow">直属部门重点</p>
            <h2>正在读取部门日报...</h2>
          </div>
        </div>
        <div class="department-daily-empty">正在加载定时任务生成的部门重点。</div>
      </section>
    `;
  }

  if (state.departmentDailyError) {
    return `
      <section class="department-daily">
        <div class="department-daily-head">
          <div>
            <p class="eyebrow">直属部门重点</p>
            <h2>部门重点暂时不可用</h2>
          </div>
        </div>
        <div class="department-daily-empty">${escapeHtml(state.departmentDailyError)}</div>
      </section>
    `;
  }

  if (state.departmentDailyMissingSync) {
    return `
      <section class="department-daily">
        <div class="department-daily-head">
          <div>
            <p class="eyebrow">直属部门重点</p>
            <h2>尚未识别直属部门</h2>
          </div>
        </div>
        <div class="department-daily-empty">请先同步企业微信通讯录。部门名称和归属只使用数据库中的企业微信部门信息。</div>
      </section>
    `;
  }

  const reports = Array.isArray(state.departmentDailyReports)
    ? state.departmentDailyReports
    : [];
  if (!reports.length) {
    return `
      <section class="department-daily">
        <div class="department-daily-head">
          <div>
            <p class="eyebrow">直属部门重点</p>
            <h2>暂无部门日报</h2>
          </div>
        </div>
        <div class="department-daily-empty">所选日期暂无部门日报，请等待每日定时任务生成。</div>
      </section>
    `;
  }

  return `
    <section class="department-daily">
      <div class="department-daily-head">
        <div>
          <p class="eyebrow">直属部门重点</p>
          <h2>与你所在部门相关的今日解读</h2>
          <p>基于部门默认关注生成，不继承父部门配置。</p>
        </div>
      </div>
      <div class="department-daily-list">
        ${reports.map((report) => `
          <article class="department-daily-card${report.status === "empty" ? " empty-card" : ""}">
            <div class="department-daily-card-head">
              <div>
                <span class="department-name">${escapeHtml(removeReplacementCharacters(report.departmentName) || "未命名部门")}</span>
                <span>${escapeHtml(report.articleCount || 0)} 条动态 · ${escapeHtml(report.sourceCount || 0)} 个部门信源</span>
              </div>
              <span class="department-ai-badge">${report.status === "generated" ? "AI 部门解读" : report.status === "fallback" ? "规则降级" : "今日暂无"}</span>
            </div>
            <div class="department-daily-content">${removeReplacementCharacters(report.html)}</div>
            ${report.status !== "empty" ? '<p class="department-daily-disclaimer">内部辅助信息，请结合官方原文和业务负责人确认后再用于客户沟通。</p>' : ""}
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderPersonalDaily() {
  if (!state.ssoUserId) {
    return `
      <section class="personal-daily">
        <div class="personal-daily-head">
          <div>
            <h2>你的专属关注</h2>
            <p>公共日报之外，按你关注的信源补充当日动态。</p>
          </div>
        </div>
        <div class="personal-daily-empty">
          <p>从企业微信日报链接进入后，系统会识别你的 UserID，届时可以设置专属关注。</p>
          <button class="ghost-button compact" type="button" data-view="subscriptions">查看关注设置</button>
        </div>
      </section>
    `;
  }

  if (state.personalDailyLoading) {
    return `
      <section class="personal-daily">
        <div class="personal-daily-head">
          <div>
            <h2>你的专属关注</h2>
            <p>正在整理你关注信源的当日更新...</p>
          </div>
        </div>
      </section>
    `;
  }

  if (state.personalDailyError) {
    return `
      <section class="personal-daily">
        <div class="personal-daily-head"><div><h2>你的专属关注</h2></div></div>
        <div class="personal-daily-empty"><p>${escapeHtml(state.personalDailyError)}</p></div>
      </section>
    `;
  }

  const supplement = state.personalDaily;
  if (!supplement || Number(supplement.subscriptionCount || 0) === 0) {
    return `
      <section class="personal-daily">
        <div class="personal-daily-head">
          <div>
            <h2>你的专属关注</h2>
            <p>当前没有设置专门关注的信源，因此只展示公共日报。</p>
          </div>
        </div>
        <div class="personal-daily-empty">
          <p>选择常用的官方机构、国家或业务信源后，这里会自动补充相关更新。</p>
          <button class="ghost-button compact" type="button" data-view="subscriptions">管理我的关注</button>
        </div>
      </section>
    `;
  }

  const items = Array.isArray(supplement.items) ? supplement.items : [];
  const meta = `
    <div class="personal-daily-meta">
      <span>关注 ${escapeHtml(supplement.subscriptionCount || 0)} 个信源</span>
      <span>匹配 ${escapeHtml(supplement.matchedCount || 0)} 条</span>
      ${Number(supplement.publicCoveredCount || 0) > 0
        ? `<span>${escapeHtml(supplement.publicCoveredCount)} 条已纳入公共日报</span>`
        : ""}
      ${Number(supplement.hiddenCount || 0) > 0
        ? `<span>另有 ${escapeHtml(supplement.hiddenCount)} 条未展开</span>`
        : ""}
    </div>
  `;

  if (!items.length) {
    const message = Number(supplement.matchedCount || 0) > 0
      ? "你关注的信源今日有更新，但均已纳入上方公共日报，不再重复展示。"
      : "你关注的信源今日暂无新增。";
    return `
      <section class="personal-daily">
        <div class="personal-daily-head">
          <div>
            <h2>你的专属关注</h2>
            <p>${escapeHtml(state.ssoUserName || state.ssoUserId)} 的订阅补充</p>
          </div>
          <button class="ghost-button compact" type="button" data-view="subscriptions">调整关注</button>
        </div>
        ${meta}
        <div class="personal-daily-empty"><p>${message}</p></div>
      </section>
    `;
  }

  return `
    <section class="personal-daily">
      <div class="personal-daily-head">
        <div>
          <h2>你的专属关注</h2>
          <p>${escapeHtml(state.ssoUserName || state.ssoUserId)} 的订阅补充，已排除公共日报中明确引用的文章。</p>
        </div>
        <button class="ghost-button compact" type="button" data-view="subscriptions">调整关注</button>
      </div>
      ${meta}
      <div class="personal-daily-list">
        ${items.map((item) => {
          const url = safeUrl(item.url);
          const title = escapeHtml(item.title || "未命名动态");
          const source = getLocalizedSource(item);
          const country = getLocalizedCountry(item);
          const category = getLocalizedCategory(item);
          return `
            <article class="personal-daily-item">
              <div class="personal-daily-item-top">
                <span class="personal-source-badge">${escapeHtml(source)}</span>
                <span>${escapeHtml(country)} · ${escapeHtml(category)}</span>
                ${item.articleDate ? `<time>${escapeHtml(String(item.articleDate).slice(0, 10))}</time>` : ""}
              </div>
              <h3>${url
                ? `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${title}</a>`
                : title}</h3>
              ${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ""}
            </article>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function getFilteredSubscriptionSources() {
  const query = state.subscriptionSearch.trim().toLowerCase();
  return state.subscriptionSources.filter((source) => {
    const sourceId = Number(source.id);
    if (state.subscriptionOnlySelected && !state.subscriptionSelectedIds.has(sourceId)) return false;
    if (state.subscriptionCountry && source.country !== state.subscriptionCountry) return false;
    if (state.subscriptionCategory && source.category !== state.subscriptionCategory) return false;
    if (query) {
      const haystack = `${source.name} ${source.country} ${source.category} ${source.type}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function renderSubscriptionFilters() {
  const countrySelect = document.querySelector("#subscriptionCountry");
  const categorySelect = document.querySelector("#subscriptionCategory");
  if (!countrySelect || !categorySelect) return;

  const countries = [...new Set(state.subscriptionSources.map((source) => source.country).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
  const categories = [...new Set(state.subscriptionSources.map((source) => source.category).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "zh-CN"));

  countrySelect.innerHTML = `<option value="">${state.language === "en" ? "All countries/regions" : "全部国家/地区"}</option>`
    + countries.map((country) => `<option value="${escapeAttr(country)}">${escapeHtml(country)}</option>`).join("");
  categorySelect.innerHTML = `<option value="">${state.language === "en" ? "All categories" : "全部分类"}</option>`
    + categories.map((category) => `<option value="${escapeAttr(category)}">${escapeHtml(category)}</option>`).join("");
  countrySelect.value = state.subscriptionCountry;
  categorySelect.value = state.subscriptionCategory;
}

function renderSubscriptions() {
  if (!subscriptionList || !subscriptionIdentity || !subscriptionCount || !subscriptionNote) return;

  const selectedCount = state.subscriptionSelectedIds.size;
  subscriptionCount.textContent = t("subscriptions.count", { count: selectedCount });
  subscriptionIdentity.textContent = state.ssoUserId
    ? `${state.ssoUserName || "企业微信用户"} · ${state.ssoUserId}${state.ssoLocalTest ? " · 本地测试身份" : ""}`
    : t("subscriptions.identifying");

  if (!state.ssoUserId) {
    subscriptionList.innerHTML = `
      <div class="personal-daily-empty">
        <p>请从企业微信推送的日报链接进入。系统识别 UserID 后，才能保存个人关注配置。</p>
      </div>
    `;
    subscriptionNote.textContent = "姓名不能作为订阅身份，必须使用企业微信 UserID。";
    document.querySelector("#saveSubscriptions").disabled = true;
    return;
  }

  document.querySelector("#saveSubscriptions").disabled = state.subscriptionLoading || state.subscriptionSaving;

  if (state.subscriptionLoading) {
    subscriptionList.innerHTML = '<div class="empty">正在加载数据库中的信源...</div>';
    subscriptionNote.textContent = "正在读取你的关注配置。";
    return;
  }

  if (state.subscriptionError) {
    subscriptionList.innerHTML = `<div class="empty">${escapeHtml(state.subscriptionError)}</div>`;
    subscriptionNote.textContent = "加载失败，请稍后重试。";
    return;
  }

  renderSubscriptionFilters();
  const sources = getFilteredSubscriptionSources();
  if (!sources.length) {
    subscriptionList.innerHTML = '<div class="empty">没有符合当前筛选条件的信源。</div>';
  } else {
    subscriptionList.innerHTML = sources.map((source) => {
      const sourceId = Number(source.id);
      const checked = state.subscriptionSelectedIds.has(sourceId);
      const lastFetched = source.lastFetchedAt ? String(source.lastFetchedAt).slice(0, 10) : "尚未抓取";
      const originLabel = source.departmentDefault
        ? (source.personalStatus === "muted" ? "已取消部门默认" : "部门默认")
        : source.personalStatus === "subscribed"
          ? "个人新增"
          : "";
      return `
        <label class="subscription-source">
          <input type="checkbox" data-subscription-source="${sourceId}"${checked ? " checked" : ""}>
          <span>
            <strong>${escapeHtml(source.name || "未命名信源")}${originLabel ? ` <em class="subscription-origin">${escapeHtml(originLabel)}</em>` : ""}${source.publicDailyEnabled === false ? ' <em class="subscription-origin">部门专属</em>' : ""}</strong>
            <small>${escapeHtml(source.country || "全球")} · ${escapeHtml(source.category || "未分类")} · ${escapeHtml(source.articleCount || 0)} 条 · ${escapeHtml(lastFetched)}</small>
          </span>
        </label>
      `;
    }).join("");
  }

  subscriptionNote.textContent = state.subscriptionSaving
    ? "正在保存..."
    : "保存后，日报会增加“你的专属关注”补充；没有新增时不会调用 AI。";
}

function renderDepartmentSubscriptions() {
  if (!departmentSubscriptionList || !departmentSubscriptionCount || !departmentSubscriptionNote) return;
  const picker = document.querySelector("#departmentSubscriptionPicker");
  const select = document.querySelector("#departmentSubscriptionSelect");
  const options = document.querySelector("#departmentSubscriptionOptions");
  const saveButton = document.querySelector("#saveDepartmentSubscriptions");
  if (!picker || !select || !options || !saveButton) return;

  const departments = state.departmentSubscriptions;
  const selectedDepartment = departments.find(
    (department) => Number(department.id) === Number(state.departmentSubscriptionSelectedId),
  );
  const pickerQuery = state.departmentSubscriptionPickerQuery.trim().toLowerCase();
  const visibleDepartments = departments.filter((department) => {
    if (!pickerQuery) return true;
    return `${department.name || ""} ${department.id}`.toLowerCase().includes(pickerQuery);
  });
  const selectedLabel = selectedDepartment
    ? `${selectedDepartment.name || `部门 ${selectedDepartment.id}`}（${selectedDepartment.userCount || 0} 人）`
    : "";

  if (document.activeElement !== select || !state.departmentSubscriptionPickerOpen) {
    select.value = selectedLabel;
  }
  select.disabled = state.departmentSubscriptionLoading || !departments.length;
  select.placeholder = departments.length ? "搜索部门名称或 ID" : "暂无已同步部门";
  select.setAttribute("aria-expanded", String(state.departmentSubscriptionPickerOpen));
  options.hidden = !state.departmentSubscriptionPickerOpen;
  options.innerHTML = visibleDepartments.length
    ? visibleDepartments.map((department) => {
      const isSelected = Number(department.id) === Number(state.departmentSubscriptionSelectedId);
      return `
        <button
          class="department-picker-option${isSelected ? " selected" : ""}"
          type="button"
          role="option"
          aria-selected="${isSelected}"
          data-department-id="${department.id}"
        >
          <span>${escapeHtml(department.name || `部门 ${department.id}`)}</span>
          <small>${escapeHtml(department.userCount || 0)} 人 · ID ${escapeHtml(department.id)}</small>
        </button>
      `;
    }).join("")
    : '<div class="department-picker-empty">没有匹配的部门</div>';
  saveButton.disabled = (
    !state.departmentSubscriptionSelectedId
    || state.departmentSubscriptionLoading
    || state.departmentSubscriptionSaving
  );
  departmentSubscriptionCount.textContent =
    `${state.departmentSubscriptionSelectedSourceIds.size} 个默认关注`;

  if (state.departmentSubscriptionLoading) {
    departmentSubscriptionList.innerHTML = '<div class="empty">正在加载部门与信源...</div>';
    departmentSubscriptionNote.textContent = "部门和成员关系由独立的企业微信通讯录同步接口更新。";
    return;
  }
  if (state.departmentSubscriptionError) {
    departmentSubscriptionList.innerHTML =
      `<div class="empty">${escapeHtml(state.departmentSubscriptionError)}</div>`;
    departmentSubscriptionNote.textContent = "加载失败，请稍后重试。";
    return;
  }
  if (!departments.length) {
    departmentSubscriptionList.innerHTML =
      '<div class="empty">尚未发现部门。请先调用企业微信通讯录同步接口；本地可通过环境变量配置测试部门。</div>';
    departmentSubscriptionNote.textContent = "需要先同步企业微信部门数据。";
    return;
  }

  const query = state.departmentSubscriptionSearch.trim().toLowerCase();
  const sources = state.departmentSubscriptionSources.filter((source) => {
    if (!query) return true;
    return `${source.name} ${source.country} ${source.category} ${source.type}`
      .toLowerCase()
      .includes(query);
  });
  departmentSubscriptionList.innerHTML = sources.length
    ? sources.map((source) => {
      const sourceId = Number(source.id);
      const checked = state.departmentSubscriptionSelectedSourceIds.has(sourceId);
      return `
        <label class="subscription-source">
          <input type="checkbox" data-department-subscription-source="${sourceId}"${checked ? " checked" : ""}>
          <span>
            <strong>${escapeHtml(source.name || "未命名信源")}${source.publicDailyEnabled === false ? ' <em class="subscription-origin">仅订阅部门</em>' : ""}</strong>
            <small>${escapeHtml(source.country || "全球")} · ${escapeHtml(source.category || "未分类")}</small>
          </span>
        </label>
      `;
    }).join("")
    : '<div class="empty">没有符合搜索条件的信源。</div>';
  departmentSubscriptionNote.textContent = state.departmentSubscriptionSaving
    ? "正在保存..."
    : "保存后，部门成员下次打开日报或接收推送时立即按新配置计算。";
}

function renderDaily() {
  const historyHtml = state.dailyHistory.length > 0
    ? `<div class="daily-history">
        <h3>${escapeHtml(t("daily.history"))}</h3>
        <ul class="daily-history-list">
          ${state.dailyHistory
            .map((h) => {
              const isCurrent = state.dailyDate === h.date || (!state.dailyDate && h.date === getShanghaiDateString());
              return `<li>
              <button class="daily-history-item${isCurrent ? " active" : ""}" data-daily-date="${h.date}">
                <span class="daily-history-date">${h.date}</span>
                <span class="daily-history-count">${escapeHtml(translateCount(h.sourceItemCount || 0))}</span>
              </button>
            </li>`;
            })
            .join("")}
        </ul>
      </div>`
    : "";

  if (state.dailyReport?.html) {
    const windowText = state.dailyReport.windowLabel ? ` · ${escapeHtml(state.dailyReport.windowLabel)}` : "";
    const analyzedMeta = Number(state.dailyReport.eventCount || 0) > 0
      ? t("daily.analyzedMeta", {
        relevantCount: state.dailyReport.relevantItemCount || 0,
        eventCount: state.dailyReport.eventCount || 0,
      })
      : "";
    const reports = Array.isArray(state.departmentDailyReports)
      ? state.departmentDailyReports
      : [];
    const departmentNames = reports
      .map((report) => String(report.departmentName || "").trim())
      .filter(Boolean);
    const departmentLabel = departmentNames.length === 1
      ? t("daily.departmentFocus", { name: departmentNames[0] })
      : t("daily.department");
    const departmentCount = reports.reduce(
      (total, report) => total + Number(report.articleCount || 0),
      0,
    );
    const personalCount = Number(state.personalDaily?.matchedCount || 0);
    const activePerspective = dailyPerspectives.has(state.dailyPerspective)
      ? state.dailyPerspective
      : "public";
    const perspectiveContent = activePerspective === "department"
      ? renderDepartmentDaily()
      : activePerspective === "personal"
        ? renderPersonalDaily()
        : state.dailyReport.html;
    dailyReport.innerHTML = `
      <div class="daily-layout">
        <div class="daily-main">
          <div class="daily-meta">
            <strong>${escapeHtml(state.dailyReport.title || t("daily.defaultTitle"))}</strong>
            <span>${escapeHtml(t("daily.meta", {
              model: state.dailyReport.model || "AI",
              sourceCount: state.dailyReport.sourceItemCount || 0,
              extra: `${analyzedMeta}${windowText}`,
            }))}</span>
          </div>
          <div class="daily-perspective-nav" role="tablist" aria-label="${escapeAttr(t("daily.perspectiveLabel"))}">
            <button class="daily-perspective-tab${activePerspective === "public" ? " active" : ""}" type="button" role="tab" aria-selected="${activePerspective === "public"}" data-daily-perspective="public">
              <span>${escapeHtml(t("daily.public"))}</span>
              <small>${escapeHtml(state.dailyReport.relevantItemCount || state.dailyReport.sourceItemCount || 0)}</small>
            </button>
            <button class="daily-perspective-tab${activePerspective === "department" ? " active" : ""}" type="button" role="tab" aria-selected="${activePerspective === "department"}" data-daily-perspective="department" title="${escapeAttr(departmentLabel)}">
              <span>${escapeHtml(departmentLabel)}</span>
              <small>${state.departmentDailyLoading ? "…" : escapeHtml(departmentCount)}</small>
            </button>
            <button class="daily-perspective-tab${activePerspective === "personal" ? " active" : ""}" type="button" role="tab" aria-selected="${activePerspective === "personal"}" data-daily-perspective="personal">
              <span>${escapeHtml(t("daily.personal"))}</span>
              <small>${state.personalDailyLoading ? "…" : escapeHtml(personalCount)}</small>
            </button>
          </div>
          <div class="daily-perspective-panel" role="tabpanel" data-active-perspective="${activePerspective}">
            ${perspectiveContent}
          </div>
        </div>
        ${historyHtml}
      </div>
    `;
    linkifyPlainUrls(dailyReport.querySelector(".daily-perspective-panel"));
    return;
  }

  if (state.dailyLoading) {
    dailyReport.innerHTML = `
      <div class="daily-layout">
        <div class="daily-main">
          <div class="empty">${escapeHtml(t("daily.generating"))}</div>
        </div>
        ${historyHtml}
      </div>
    `;
    return;
  }

  dailyReport.innerHTML = `
    <div class="daily-layout">
      <div class="daily-main">
        <div class="empty">${escapeHtml(t("daily.empty"))}</div>
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
            <h2>${escapeHtml(item.title)}</h2>
            <span class="risk ${escapeAttr(item.risk)}">${escapeHtml(item.riskText)}</span>
          </header>
          <p>${escapeHtml(item.text)}</p>
          <div class="radar-card-footer">
            <span class="radar-count">${escapeHtml(getRadarArticleCount(item.count))}</span>
            <span class="radar-arrow">→</span>
          </div>
          <div class="meter" aria-label="${escapeAttr(t("radar.meterAria", { title: item.title, value: item.value }))}">
            <span style="width: ${item.value}%"></span>
          </div>
        </article>
      `,
    )
    .join("");
}

function renderRadarDetail() {
  const rule = buildRadarItems(state.items).find((r) =>
    r.key === state.radarDetail ||
    r.title === state.radarDetail ||
    (r.legacyTitles || []).includes(state.radarDetail),
  );
  if (!rule) {
    state.radarDetail = null;
    renderRadar();
    return;
  }
  radarGrid.innerHTML = `
    <div class="radar-detail">
      <button class="radar-back" id="radarBack">${escapeHtml(t("radar.back"))}</button>
      <div class="radar-detail-header">
        <h2>${escapeHtml(rule.title)}</h2>
        <span class="risk ${escapeAttr(rule.risk)}">${escapeHtml(rule.riskText)}</span>
      </div>
      <div class="radar-keywords">${rule.keywords.map((k) => `<span class="tag">${escapeHtml(k)}</span>`).join("")}</div>
      <p class="radar-detail-desc">${escapeHtml(rule.text)}</p>
      <div class="radar-feed" id="radarFeed"></div>
    </div>
  `;
  renderFeed(document.getElementById("radarFeed"), rule.matched);
}

function showRadarDetail(key) {
  state.radarDetail = key;
  renderRadar();
}

function hideRadarDetail() {
  state.radarDetail = null;
  renderRadar();
}

function renderCounts(items) {
  homeCount.textContent = translateCount(Math.min(items.length, 5));
  allCount.textContent = translateCount(items.length);
}

function isFetchRunActive(run = state.fetchRun) {
  return run?.status === "running";
}

function translateLiveMetaText(text) {
  const value = String(text || "");
  if (value === "等待真实信源数据") return t("status.demo");
  if (value === "正在连接实时信源...") return t("status.connecting");
  if (value === "后台抓取任务已启动，暂无历史文章可展示") return t("status.noHistory");
  if (value === "实时信源暂无真实返回") return t("status.noLive");
  return value;
}

function formatFetchRunStatus(run) {
  if (!run) {
    return "";
  }
  const processed = Number(run.processedSourceCount || 0);
  const total = Number(run.sourceCount || 0);
  const progress = Number(run.progress || 0);
  const itemCount = Number(run.itemCount || 0);
  return t("status.fetching", { processed, total, progress, count: itemCount });
}

function renderStatus(items) {
  const healthySources = state.sourceStatus.filter((source) => source.ok).length;
  const failedSources = state.sourceStatus.length - healthySources;

  if (isFetchRunActive()) {
    monitorStatus.textContent = formatFetchRunStatus(state.fetchRun);
  } else if (state.liveMeta.mode === "live") {
    const count = state.liveMeta.todayArticleCount ?? items.length;
    monitorStatus.textContent = t("status.live", { count });
  } else if (state.liveMeta.mode === "loading") {
    monitorStatus.textContent = t("status.connecting");
  } else {
    monitorStatus.textContent = translateLiveMetaText(state.liveMeta.text);
  }

  if (refreshNews) {
    refreshNews.disabled = isFetchRunActive();
    refreshNews.textContent = isFetchRunActive() ? t("common.fetching") : t("common.refresh");
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
    el.innerHTML = escapeHtml(t("home.noLead"));
    return;
  }

  const image = safeUrl(top.image);
  const url = safeUrl(top.url);
  const displayTitle = getLocalizedArticleTitle(top);
  const displaySummary = getLocalizedArticleSummary(top);
  const inner = `
    <div class="lead-copy">
      <span class="hot-label">HOT ${top.heat}</span>
      <h2>${escapeHtml(displayTitle)}</h2>
      <p>${escapeHtml(displaySummary)}</p>
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

const hReadinessLabels = {
  not_recommended: "暂不建议成稿",
  topic_only: "仅选题",
  outline_ready: "可生成大纲",
  needs_viewpoint: "待确认观点",
  needs_evidence: "待补事实",
  draft_ready: "事实观点已齐",
};

const hStatusLabels = {
  candidate: "待选择",
  selected: "值得写",
  later: "以后再说",
  rejected: "不写",
  archived: "已归档",
};

const hModeLabels = {
  outline: "内容大纲",
  wechat_article: "公众号文章",
  short_video: "H快评",
  run_and_talk_video: "H边跑边聊",
  deep_video: "H深聊",
};

const hSuiteModes = [
  "wechat_article",
  "short_video",
  "run_and_talk_video",
  "deep_video",
];

const hDraftStatusLabels = {
  generating: "生成中",
  drafted: "待审校",
  reviewing: "审校中",
  needs_revision: "需修改",
  ready_for_henry: "可进入本人审阅",
  henry_reviewed: "已审阅",
  approved: "已采用",
  rejected: "已放弃",
  failed: "生成失败",
};

const hDuplicateLabels = {
  unknown: "历史积累中",
  low: "低重复",
  medium: "中重复",
  high: "高重复",
};

const hPolicyStatusLabels = {
  effective: "已生效",
  announced: "已公布待生效",
  pending: "进行中",
  proposed: "拟议",
  media_report: "媒体报道",
  opinion: "观点",
  not_applicable: "非政策题",
};

const hConfirmationTypeLabels = {
  unconfirmed: "尚未确认",
  henry: "Henry 本人",
  authorized_editor: "授权成员",
  profile: "人物档案",
};

function hCheckChip(label, passed) {
  return `<span class="h-check ${passed ? "passed" : "missing"}" aria-label="${escapeAttr(label)}：${passed ? "已满足" : "未满足"}"><span aria-hidden="true">${passed ? "✓" : "·"}</span>${escapeHtml(label)}</span>`;
}

function renderHTopicCard(topic, compact = false) {
  const checks = topic.fourChecks || {};
  const selected = Number(state.hTopic?.id) === Number(topic.id);
  return `
    <article class="h-topic-card${selected ? " active" : ""}${compact ? " compact" : ""}" data-h-topic-card="${escapeAttr(topic.id)}">
      <button class="h-topic-open" type="button" data-h-open-topic="${escapeAttr(topic.id)}" aria-current="${selected ? "true" : "false"}">
        <span class="h-topic-card-top">
          <span class="h-status ${escapeAttr(topic.status)}">${escapeHtml(hStatusLabels[topic.status] || topic.status)}</span>
          <span class="h-readiness ${escapeAttr(topic.readiness)}">${escapeHtml(hReadinessLabels[topic.readiness] || topic.readiness)}</span>
        </span>
        <strong>${escapeHtml(topic.title)}</strong>
        ${compact ? "" : `<p>${escapeHtml(topic.eventSummary || topic.coreQuestion || "")}</p>`}
        <span class="h-topic-meta">
          <span>${escapeHtml(hModeLabels[topic.primaryMode] || topic.primaryMode)}</span>
          <span>${Number(topic.fullSourceCount || 0)}/${Number(topic.sourceCount || 0)} 全文</span>
          <span>${Number(topic.aLevelSourceCount || 0)} 个 A 级</span>
          <span>${Number(topic.draftCount || 0)} 份草稿</span>
          <span>${escapeHtml(hDuplicateLabels[topic.duplicateRisk?.level] || "重复待检查")}</span>
        </span>
      </button>
      ${compact ? "" : `
        <div class="h-checks">
          ${hCheckChip("有观点", checks.hasJudgment)}
          ${hCheckChip("有依据", checks.hasBasis)}
          ${hCheckChip("对读者有用", checks.useful)}
          ${hCheckChip("长期价值", checks.longTerm)}
        </div>
        <div class="h-topic-card-actions">
          <button class="primary-button compact" type="button" data-h-topic-status="selected" data-topic-id="${escapeAttr(topic.id)}">值得写</button>
          <button class="ghost-button compact" type="button" data-h-topic-status="later" data-topic-id="${escapeAttr(topic.id)}">以后再说</button>
          <button class="ghost-button compact danger" type="button" data-h-topic-status="rejected" data-topic-id="${escapeAttr(topic.id)}">不写</button>
        </div>
      `}
    </article>
  `;
}

function renderHSource(source) {
  const textPreview = String(source.extractedText || "").slice(0, 360);
  const sourceUrl = safeUrl(source.url);
  return `
    <article class="h-source-card">
      <div class="h-source-card-head">
        <div>
          <strong>${escapeHtml(source.title || source.sourceName || "未命名来源")}</strong>
          <span>${escapeHtml(source.sourceName || "来源待补")}</span>
        </div>
        <div class="h-source-badges">
          <span class="h-source-level level-${escapeAttr(source.sourceLevel)}">${escapeHtml(source.sourceLevel)}级</span>
          <span>${escapeHtml(source.contentStatus === "full" ? "完整原文" : source.contentStatus === "summary_only" ? "仅摘要" : "缺正文")}</span>
          <span>${escapeHtml(hPolicyStatusLabels[source.policyStatus] || "状态待确认")}</span>
          <span>${escapeHtml(source.verifiedAt ? "已核验" : "待核验")}</span>
        </div>
      </div>
      ${textPreview ? `<p>${escapeHtml(textPreview)}${String(source.extractedText || "").length > 360 ? "…" : ""}</p>` : ""}
      <div class="h-source-actions">
        ${sourceUrl ? `<a href="${escapeAttr(sourceUrl)}" target="_blank" rel="noopener noreferrer">查看原文</a>` : ""}
        <div>
          ${source.contentStatus === "full" && !source.verifiedAt
            ? `<button class="text-button" type="button" data-h-verify-source="${escapeAttr(source.id)}">标记已核验</button>`
            : ""}
          <button class="text-button danger" type="button" data-h-delete-source="${escapeAttr(source.id)}">移除</button>
        </div>
      </div>
    </article>
  `;
}

function renderHViewpoint(viewpoint) {
  const isEditing = Number(state.hEditingViewpointId) === Number(viewpoint.id);
  const viewpointText = viewpoint.editedText || viewpoint.rawText;
  return `
    <article class="h-viewpoint-card${viewpoint.isConfirmed ? " confirmed" : ""}">
      <div class="h-viewpoint-card-head">
        <span class="h-viewpoint-type">${escapeHtml(viewpoint.inputType === "profile" ? "已确认人物档案" : "本次观点")}</span>
        <strong>${escapeHtml(viewpoint.isConfirmed ? "已确认可用于成稿" : "尚未确认")}</strong>
      </div>
      ${isEditing ? `
        <form class="h-viewpoint-edit-form" data-h-viewpoint-edit-form data-viewpoint-id="${escapeAttr(viewpoint.id)}">
          <textarea name="editedText" rows="4" aria-label="编辑 Henry 观点">${escapeHtml(viewpointText)}</textarea>
          <div class="h-viewpoint-actions">
            <button class="primary-button compact" type="submit">保存观点</button>
            <button class="ghost-button compact" type="button" data-h-cancel-viewpoint>取消</button>
          </div>
        </form>
      ` : `<p>${escapeHtml(viewpointText)}</p>`}
      <div class="h-viewpoint-footer">
        <small>${escapeHtml(hConfirmationTypeLabels[viewpoint.confirmationType] || "尚未确认")}${viewpoint.confirmedBy && viewpoint.confirmationType !== "profile" ? ` · ${escapeHtml(viewpoint.confirmedBy)}` : ""}</small>
        ${isEditing ? "" : `
          <div class="h-viewpoint-actions">
            ${!viewpoint.isConfirmed
              ? `<button class="text-button" type="button" data-h-confirm-viewpoint="${escapeAttr(viewpoint.id)}">确认可用于成稿</button>`
              : ""}
            <button class="text-button" type="button" data-h-edit-viewpoint="${escapeAttr(viewpoint.id)}">编辑</button>
            <button class="text-button danger" type="button" data-h-delete-viewpoint="${escapeAttr(viewpoint.id)}">删除</button>
          </div>
        `}
      </div>
    </article>
  `;
}

function getHSelectedDraft(topic) {
  const drafts = Array.isArray(topic?.drafts) ? topic.drafts : [];
  return drafts.find((draft) => Number(draft.id) === Number(state.hSelectedDraftId))
    || drafts.find((draft) => draft.mode === "outline")
    || drafts[0]
    || null;
}

function getHSelectedOutline(topic) {
  const drafts = Array.isArray(topic?.drafts) ? topic.drafts : [];
  return drafts.find((draft) => (
    draft.mode === "outline"
    && Number(draft.id) === Number(state.hSelectedOutlineId)
  )) || drafts.find((draft) => draft.mode === "outline") || null;
}

function getHLatestModeDraft(topic, mode) {
  const drafts = Array.isArray(topic?.drafts) ? topic.drafts : [];
  return drafts.find((draft) => draft.mode === mode) || null;
}

function renderHChannelSuite(topic, sourceOutline, canGenerateSuite) {
  const failedModes = new Set(state.hSuiteFailedModes || []);
  return `
    <section class="h-channel-suite" aria-label="四渠道稿件">
      <div class="h-channel-suite-head">
        <div>
          <span>四渠道稿件</span>
          <strong>同一内容大纲，四种独立表达</strong>
        </div>
        <small>每个版本单独编辑、审校和采用</small>
      </div>
      <div class="h-channel-suite-grid">
        ${hSuiteModes.map((mode) => {
          const latestDraft = getHLatestModeDraft(topic, mode);
          const failed = failedModes.has(mode);
          return `
            <article class="h-channel-card${failed ? " failed" : ""}">
              <div>
                <span>${escapeHtml(hModeLabels[mode])}</span>
                <strong>${latestDraft ? `v${escapeHtml(latestDraft.versionNo)} · ${escapeHtml(hDraftStatusLabels[latestDraft.status] || latestDraft.status)}` : "待生成"}</strong>
              </div>
              ${failed ? '<small>本次生成失败，可单独重试</small>' : `<small>${latestDraft ? escapeHtml(latestDraft.title || "已生成稿件") : "尚无渠道版本"}</small>`}
              <div class="h-channel-card-actions">
                ${latestDraft
                  ? `<button class="ghost-button compact" type="button" data-h-select-draft="${escapeAttr(latestDraft.id)}" data-h-scroll-to-editor>打开</button>`
                  : ""}
                ${failed
                  ? `<button class="primary-button compact" type="button" data-h-generate-channel="${escapeAttr(mode)}" data-outline-id="${escapeAttr(sourceOutline?.id || "")}" data-topic-id="${escapeAttr(topic.id)}" ${!canGenerateSuite ? "disabled" : ""}>重试</button>`
                  : ""}
              </div>
            </article>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function renderHDraftEditor(topic) {
  const drafts = Array.isArray(topic.drafts) ? topic.drafts : [];
  const draft = getHSelectedDraft(topic);
  const sourceOutline = getHSelectedOutline(topic);
  if (!draft) {
    return '<div class="h-empty-card"><strong>还没有大纲</strong><p>先生成内容大纲；选中大纲后，可以在页面最下方一键生成四个渠道版本。</p></div>';
  }
  const review = draft.latestReview || null;
  const reviewUsable = Boolean(review && !review.isStale);
  const reviewNeedsRevision = Boolean(reviewUsable && (
    review.conclusion !== "ready_for_henry"
    || ["l1Status", "l2Status", "l3Status", "l4Status"]
      .some((key) => review[key] === "needs_revision")
    || (review.requiredActions || []).length
    || (review.issues || []).length
  ));
  return `
    <div class="h-draft-workspace" data-h-draft-editor-anchor tabindex="-1">
      <div class="h-draft-version-list" role="tablist" aria-label="草稿版本">
        ${drafts.map((item) => `
          <button class="${Number(item.id) === Number(draft.id) ? "active" : ""}${Number(item.id) === Number(sourceOutline?.id) ? " suite-source" : ""}" type="button" data-h-select-draft="${escapeAttr(item.id)}">
            <span>${escapeHtml(hModeLabels[item.mode] || item.mode)} · v${escapeHtml(item.versionNo)}</span>
            <small>${escapeHtml(hDraftStatusLabels[item.status] || item.status)}${Number(item.id) === Number(sourceOutline?.id) ? " · 生成依据" : ""}</small>
          </button>
        `).join("")}
      </div>
      <div class="h-draft-editor">
        <div class="h-draft-editor-head">
          <div>
            <span class="h-readiness ${escapeAttr(draft.status)}">${escapeHtml(hDraftStatusLabels[draft.status] || draft.status)}</span>
            <h3>${escapeHtml(draft.title || topic.title)}</h3>
            <p>${escapeHtml(draft.model)} · ${escapeHtml(draft.skillVersion)} · v${escapeHtml(draft.versionNo)}</p>
          </div>
          <div class="h-draft-actions">
            <button class="ghost-button compact" type="button" data-h-copy-draft="${escapeAttr(draft.id)}">复制 Markdown</button>
            <button class="ghost-button compact" type="button" data-h-copy-plain="${escapeAttr(draft.id)}">复制纯文本</button>
            <button class="ghost-button compact" type="button" data-h-export-draft="${escapeAttr(draft.id)}">导出内容包</button>
          </div>
        </div>
        <label class="h-editor-field">
          <span>标题</span>
          <input type="text" data-h-draft-title value="${escapeAttr(draft.title || "")}">
        </label>
        <label class="h-editor-field">
          <span>${draft.mode === "outline" ? "大纲内容" : "正文 / 口播"}</span>
          <textarea data-h-draft-content rows="22">${escapeHtml(draft.contentMarkdown || "")}</textarea>
        </label>
        <div class="h-draft-primary-actions">
          <button class="ghost-button" type="button" data-h-save-draft="${escapeAttr(draft.id)}">保存为新版本</button>
          ${draft.generationError
            ? `<button class="ghost-button" type="button" data-h-retry-draft="${escapeAttr(draft.id)}" data-h-mode="${escapeAttr(draft.mode)}">重试完整生成</button>`
            : ""}
          <button class="${reviewUsable ? "ghost-button" : "primary-button"}" type="button" data-h-review-draft="${escapeAttr(draft.id)}">${review?.isStale ? "重新运行四层审校" : "运行四层审校"}</button>
          ${reviewNeedsRevision
            ? `<button class="primary-button" type="button" data-h-generate-reviewed="${escapeAttr(draft.id)}" title="按最新四层审校意见生成新版本">${draft.mode === "outline" ? "按审校意见更新大纲" : "按审校意见重新生成"}</button>`
            : ""}
          ${draft.status === "ready_for_henry" && reviewUsable
            ? `<button class="ghost-button" type="button" data-h-mark-reviewed="${escapeAttr(draft.id)}">标记已审阅</button>`
            : ""}
          ${["ready_for_henry", "henry_reviewed"].includes(draft.status) && reviewUsable
            ? `<button class="primary-button" type="button" data-h-approve-draft="${escapeAttr(draft.id)}">最终采用</button>`
            : ""}
          ${["ready_for_henry", "henry_reviewed"].includes(draft.status)
            ? `<button class="ghost-button" type="button" data-h-return-draft="${escapeAttr(draft.id)}">退回修改</button>`
            : ""}
        </div>
        ${review ? `
          <section class="h-review-result ${escapeAttr(review.conclusion)}">
            <div class="h-review-head">
              <strong>${escapeHtml(review.conclusion === "ready_for_henry" ? "可进入本人审阅" : review.conclusion === "facts_required" ? "补充事实后审阅" : "暂不建议成稿")}</strong>
              <span>L1 ${escapeHtml(review.l1Status)} · L2 ${escapeHtml(review.l2Status)} · L3 ${escapeHtml(review.l3Status)} · L4 ${escapeHtml(review.l4Status)}</span>
            </div>
            ${review.isStale ? '<p class="h-inline-note">事实包或 Henry 观点在本次审校后发生了变化，这份审校已过期，请重新运行。</p>' : ""}
            ${(review.requiredActions || []).length ? `
              <h4>发布前必须处理</h4>
              <ul>${review.requiredActions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
            ` : ""}
            ${(review.issues || []).length ? `
              <h4>可验证问题</h4>
              <ul>${review.issues.map((item) => `<li><strong>${escapeHtml(item.layer || "")}</strong> ${escapeHtml(item.message || item)}</li>`).join("")}</ul>
            ` : ""}
          </section>
        ` : '<p class="h-inline-note">生成与审校是两个独立步骤。草稿通过审校前不能最终采用。</p>'}
      </div>
    </div>
  `;
}

function renderHTopicDetail(topic) {
  const sources = Array.isArray(topic.sources) ? topic.sources : [];
  const viewpoints = Array.isArray(topic.viewpoints) ? topic.viewpoints : [];
  const selectedOutline = getHSelectedOutline(topic);
  const hasOutline = (topic.drafts || []).some((draft) => draft.mode === "outline");
  const missingItems = Array.isArray(topic.missingItems) ? topic.missingItems : [];
  const isSelected = topic.status === "selected";
  const fullSourceCount = sources.filter((source) => source.contentStatus === "full").length;
  const pendingFetchCount = sources.filter((source) => source.url && source.contentStatus !== "full").length;
  const evidenceProgress = sources.length
    ? `${fullSourceCount}/${sources.length} 已补全文`
    : "暂无来源";
  const canGenerateSuite = Boolean(isSelected && selectedOutline);
  const suiteBlockReason = !isSelected
    ? "先在候选卡选择“值得写”。"
    : !hasOutline
      ? "先生成一个内容大纲。"
      : "";
  return `
    <section class="h-topic-detail">
      <div class="h-topic-detail-heading">
        <div>
          <span class="h-status ${escapeAttr(topic.status)}">${escapeHtml(hStatusLabels[topic.status] || topic.status)}</span>
          <span class="h-readiness ${escapeAttr(topic.readiness)}">${escapeHtml(hReadinessLabels[topic.readiness] || topic.readiness)}</span>
          <h2>${escapeHtml(topic.title)}</h2>
          <p>${escapeHtml(topic.coreQuestion || topic.eventSummary || "")}</p>
        </div>
        <button class="ghost-button compact h-mobile-back" type="button" data-h-close-topic>返回候选</button>
      </div>
      <div class="h-angle-card">
        <span>系统建议角度，不等于 Henry 已确认观点</span>
        <p>${escapeHtml(topic.suggestedAngle || "暂无建议角度")}</p>
        <small>目标读者：${escapeHtml(topic.targetAudience || "待明确")}</small>
      </div>
      <div class="h-duplicate-card ${escapeAttr(topic.duplicateRisk?.level || "unknown")}">
        <span>近 30 天重复风险</span>
        <strong>${escapeHtml(hDuplicateLabels[topic.duplicateRisk?.level] || "待检查")}</strong>
        <p>${escapeHtml(topic.duplicateRisk?.reason || "系统上线后开始积累历史。")}</p>
      </div>
      <details class="h-add-panel h-checks-panel">
        <summary>人工确认 H 四问</summary>
        <form data-h-checks-form data-topic-id="${escapeAttr(topic.id)}">
          <p class="h-inline-note">“有观点”和“有依据”由已确认观点及已核验事实自动计算；下面两项允许 H 专栏成员纠正系统判断。</p>
          <div class="h-checks-form-grid">
            <label class="h-confirm-check">
              <input name="useful" type="checkbox" value="1" ${topic.fourChecks?.useful ? "checked" : ""}>
              <span>对读者有用：能帮助缩小选择、识别风险或采取行动</span>
            </label>
            <label class="h-confirm-check">
              <input name="longTerm" type="checkbox" value="1" ${topic.fourChecks?.longTerm ? "checked" : ""}>
              <span>能回到长期价值：专业、合规、安全、公平或长期主义</span>
            </label>
          </div>
          <button class="ghost-button" type="submit">保存四问确认</button>
        </form>
      </details>
      ${missingItems.length ? `
        <div class="h-missing-card">
          <strong>当前缺口</strong>
          <ul>${missingItems.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        </div>
      ` : ""}

      <section class="h-detail-section">
        <div class="h-detail-section-head">
          <div><span>01</span><h3>事实包</h3><small class="h-section-progress">${escapeHtml(evidenceProgress)}</small></div>
          ${!isSelected
            ? `<span class="h-inline-note">${sources.length && fullSourceCount === sources.length ? "来源正文已齐，选择后直接继续" : "选择“值得写”后自动补全文"}</span>`
            : pendingFetchCount
              ? `<button class="ghost-button compact" type="button" data-h-fetch-evidence="${escapeAttr(topic.id)}">重试未补全文</button>`
              : `<span class="h-inline-note">${sources.length ? "正文已自动补全" : "暂无可抓取链接"}</span>`}
        </div>
        <div class="h-source-list">
          ${sources.length ? sources.map(renderHSource).join("") : '<div class="h-empty-card">暂无来源。</div>'}
        </div>
        <details class="h-add-panel">
          <summary>手动补充来源</summary>
          <form data-h-source-form data-topic-id="${escapeAttr(topic.id)}">
            <div class="h-form-grid">
              <label><span>来源名称</span><input name="sourceName" placeholder="如 USCIS"></label>
              <label><span>原文链接</span><input name="url" type="url" placeholder="https://"></label>
              <label><span>来源等级</span><select name="sourceLevel"><option value="A">A级 官方原文</option><option value="B">B级 权威媒体</option><option value="C" selected>C级 行业解读</option><option value="D">D级 未核验材料</option></select></label>
              <label><span>政策状态</span><select name="policyStatus"><option value="effective">已生效</option><option value="announced">已公布待生效</option><option value="pending">进行中</option><option value="proposed">拟议</option><option value="media_report" selected>媒体报道</option><option value="opinion">观点</option><option value="not_applicable">非政策题</option></select></label>
            </div>
            <label><span>标题</span><input name="title"></label>
            <label><span>完整原文或可核验材料</span><textarea name="extractedText" rows="7"></textarea></label>
            <label class="h-confirm-check"><input name="verified" type="checkbox" value="1"><span>已人工核验</span></label>
            <button class="ghost-button" type="submit">保存来源</button>
          </form>
        </details>
      </section>

      <section class="h-detail-section">
        <div class="h-detail-section-head">
          <div><span>02</span><h3>Henry 观点</h3></div>
        </div>
        <div class="h-viewpoint-list">
          ${viewpoints.length ? viewpoints.map(renderHViewpoint).join("") : '<div class="h-empty-card">尚无已确认观点。系统建议角度不会自动冒充本人观点。</div>'}
        </div>
        <form class="h-viewpoint-form" data-h-viewpoint-form data-topic-id="${escapeAttr(topic.id)}">
          <label>
            <span>补一句真实观点</span>
            <textarea name="rawText" rows="4" placeholder="这件事真正想表达什么？最担心客户误解哪一点？"></textarea>
          </label>
          <label class="h-confirm-check"><input name="confirm" type="checkbox" value="1" checked><span>确认可用于成稿</span></label>
          <button class="ghost-button" type="submit">保存观点</button>
        </form>
      </section>

      <section class="h-detail-section">
        <div class="h-detail-section-head">
          <div><span>03</span><h3>大纲与稿件编辑</h3></div>
          <span>${escapeHtml(hReadinessLabels[topic.readiness] || topic.readiness)}</span>
        </div>
        <div class="h-mode-actions">
          <button class="ghost-button" type="button" data-h-generate="outline" data-topic-id="${escapeAttr(topic.id)}" ${!isSelected ? "disabled" : ""}>${hasOutline ? "重新生成大纲" : "生成大纲"}</button>
        </div>
        ${renderHDraftEditor(topic)}
      </section>

      <section class="h-detail-section h-output-section">
        <div class="h-detail-section-head">
          <div><span>04</span><h3>内容产出</h3></div>
          <span>${selectedOutline ? `当前依据：大纲 v${escapeHtml(selectedOutline.versionNo)}` : "请选择大纲"}</span>
        </div>
        <div class="h-production-toolbar">
          <div class="h-mode-actions">
            <button class="primary-button" type="button" data-h-generate-suite="${escapeAttr(selectedOutline?.id || "")}" data-topic-id="${escapeAttr(topic.id)}" ${!canGenerateSuite ? "disabled" : ""}>一键生成整套稿件</button>
          </div>
          <details class="h-single-channel-menu">
            <summary>单独生成一个渠道</summary>
            <div>
              ${hSuiteModes.map((mode) => `
                <button class="ghost-button compact" type="button" data-h-generate-channel="${escapeAttr(mode)}" data-outline-id="${escapeAttr(selectedOutline?.id || "")}" data-topic-id="${escapeAttr(topic.id)}" ${!canGenerateSuite ? "disabled" : ""}>${escapeHtml(hModeLabels[mode])}</button>
              `).join("")}
            </div>
          </details>
        </div>
        ${suiteBlockReason
          ? `<p class="h-inline-note">${escapeHtml(suiteBlockReason)}</p>`
          : '<p class="h-inline-note">系统会按照当前选中的大纲，结合现有事实包和已确认观点生成四个渠道版本；生成后再分别审校。</p>'}
        ${renderHChannelSuite(topic, selectedOutline, canGenerateSuite)}
      </section>
    </section>
  `;
}

function renderHHistory() {
  if (!state.hHistory.length) {
    return '<div class="h-empty-card"><strong>尚无历史内容</strong><p>近30天重复检查将从系统上线后开始积累。</p></div>';
  }
  return `<div class="h-history-list">${state.hHistory.map((topic) => `
    <button type="button" data-h-open-topic="${escapeAttr(topic.id)}">
      <time>${escapeHtml(topic.date)}</time>
      <strong>${escapeHtml(topic.title)}</strong>
      <span>${escapeHtml(hStatusLabels[topic.status] || topic.status)} · ${escapeHtml(hReadinessLabels[topic.readiness] || topic.readiness)}</span>
    </button>
  `).join("")}</div>`;
}

const hGenerationProgressCopy = {
  outline: {
    title: "正在生成内容大纲",
    detail: "正在整理主轴、事实边界、Henry 观点和文章结构，请稍候。",
  },
  wechat_article: {
    title: "正在生成公众号文章",
    detail: "正在依据已核验事实和确认观点组织完整文章。",
  },
  short_video: {
    title: "正在生成 H 快评",
    detail: "正在把事实和观点整理成 60—120 秒口播。",
  },
  run_and_talk_video: {
    title: "正在生成 H 边跑边聊",
    detail: "正在组织适合边跑边聊的叙事节奏和口播结构。",
  },
  deep_video: {
    title: "正在生成 H 深聊",
    detail: "正在展开事实、观点、风险和长期价值。",
  },
  review: {
    title: "正在运行四层审校",
    detail: "正在核验事实、观点边界、内容结构和发布风险，请稍候。",
  },
  review_revision: {
    title: "正在生成修订稿",
    detail: "正在按最新审校意见修改当前稿件并生成新版本，旧版本会保留。",
  },
  candidate_refresh: {
    title: "正在刷新今日候选",
    detail: "正在重新分析公共日报、查重并筛选今日候选，请稍候。",
  },
  suite: {
    title: "正在生成四渠道稿件",
    detail: "公众号文章、H快评、H边跑边聊和H深聊正在并行生成。",
  },
};

function renderHGenerationProgress() {
  if (!state.hGeneratingMode) return "";
  const copy = hGenerationProgressCopy[state.hGeneratingMode] || {
    title: "正在生成内容",
    detail: "正在整理事实包和 Henry 观点，请稍候。",
  };
  const progress = state.hGenerationProgress;
  const progressPercent = progress?.total
    ? Math.round((Number(progress.completed || 0) / Number(progress.total)) * 100)
    : 0;
  return `
    <div class="h-generation-backdrop">
      <section
        class="h-generation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hGenerationTitle"
        aria-describedby="hGenerationDetail"
      >
        <span class="h-generation-spinner" aria-hidden="true"></span>
        <small>${progress?.total ? `AI 正在处理 · ${escapeHtml(progress.completed)}/${escapeHtml(progress.total)}` : "AI 正在处理"}</small>
        <strong id="hGenerationTitle">${escapeHtml(copy.title)}</strong>
        <p id="hGenerationDetail">${escapeHtml(progress?.label || copy.detail)}</p>
        ${progress?.total ? `
          <div
            class="h-generation-track"
            role="progressbar"
            aria-label="四渠道稿件生成进度"
            aria-valuemin="0"
            aria-valuemax="${escapeAttr(progress.total)}"
            aria-valuenow="${escapeAttr(progress.completed || 0)}"
          ><span style="width:${progressPercent}%"></span></div>
        ` : ""}
        <div class="h-generation-dots" aria-hidden="true"><span></span><span></span><span></span></div>
      </section>
    </div>
  `;
}

function setHColumnMarkup(markup) {
  const previousRailScrollTop = hColumnApp.querySelector(".h-topic-rail")?.scrollTop || 0;
  hColumnApp.innerHTML = markup;
  const nextRail = hColumnApp.querySelector(".h-topic-rail");
  if (nextRail) nextRail.scrollTop = previousRailScrollTop;

  const busy = state.hLoading || state.hSaving || Boolean(state.hGeneratingMode);
  hColumnApp.setAttribute("aria-busy", String(busy));
  if (busy) {
    hColumnApp.querySelectorAll("button, input, textarea, select").forEach((control) => {
      control.disabled = true;
    });
  }
  if (hColumnDate) hColumnDate.disabled = busy;
  const refreshButton = document.querySelector("#hColumnRefresh");
  if (refreshButton) refreshButton.disabled = busy;
}

function renderHColumn() {
  if (!hColumnApp) return;
  if (state.hTab === "confirm") state.hTab = "today";
  if (hColumnDate && state.hDate && hColumnDate.value !== state.hDate) {
    hColumnDate.value = state.hDate;
  }
  if (state.hLoading && !state.hTopics.length && !state.hTopic) {
    setHColumnMarkup('<div class="h-loading-card" role="status"><span class="h-pulse"></span><strong>正在准备今日候选</strong><p>系统会先做选题判断，不会为了凑数量强制生成文章。</p></div>');
    return;
  }
  if (state.hError && !state.hTopics.length && !state.hTopic) {
    setHColumnMarkup(`
      <div class="h-error-card" role="alert">
        <strong>H 专栏暂不可用</strong>
        <p>${escapeHtml(state.hError)}</p>
        <button class="ghost-button" type="button" data-h-retry>重试</button>
      </div>
    `);
    return;
  }

  const selectedCount = state.hTopics.filter((topic) => topic.status === "selected").length;
  const readyCount = state.hTopics.filter((topic) => topic.readiness === "draft_ready").length;
  const confirmCount = state.hTopics.filter((topic) => topic.readiness === "needs_viewpoint").length
    + state.hTopics.reduce((total, topic) => total + Number(topic.readyForHenryDraftCount || 0), 0);
  const filteredTopics = state.hTab === "confirm"
    ? state.hTopics.filter((topic) => (
      topic.readiness === "needs_viewpoint"
      || Number(topic.readyForHenryDraftCount || 0) > 0
    ))
    : state.hTopics;
  let body = "";
  if (state.hTab === "history") {
    body = renderHHistory();
  } else if (state.hTab === "drafts") {
    const withDrafts = state.hTopics.filter((topic) => Number(topic.draftCount || topic.drafts?.length || 0) > 0);
    body = withDrafts.length
      ? `<div class="h-column-grid${state.hTopic ? " has-detail" : ""}"><div class="h-topic-rail">${withDrafts.map((topic) => renderHTopicCard(topic, true)).join("")}</div>${state.hTopic ? renderHTopicDetail(state.hTopic) : '<div class="h-empty-card">选择一份草稿继续处理。</div>'}</div>`
      : '<div class="h-empty-card"><strong>草稿库为空</strong><p>从今日候选选择“值得写”后再生成内容。</p></div>';
  } else {
    body = filteredTopics.length
      ? `<div class="h-column-grid${state.hTopic ? " has-detail" : ""}"><div class="h-topic-rail">${filteredTopics.map((topic) => renderHTopicCard(topic)).join("")}</div>${state.hTopic ? renderHTopicDetail(state.hTopic) : '<div class="h-empty-card h-detail-placeholder"><strong>选择一个候选</strong><p>查看事实包、确认观点并生成内容。</p></div>'}</div>`
      : '<div class="h-empty-card"><strong>今天没有足够值得 Henry 专门成稿的题目</strong><p>系统没有为了凑数量生成内容。你可以刷新候选，或等待公共日报出现新的实质变化。</p></div>';
  }

  setHColumnMarkup(`
    <div class="h-overview">
      <div><span>今日候选</span><strong>${state.hTopics.length}</strong></div>
      <div><span>已选择</span><strong>${selectedCount}</strong></div>
      <div><span>资料已齐</span><strong>${readyCount}</strong></div>
      <div><span>待确认</span><strong>${confirmCount}</strong></div>
      <div class="h-actor-card">
        <span>H 专栏成员</span>
        <strong>${escapeHtml(state.hActor?.name || "未识别")}</strong>
      </div>
    </div>
    <div class="h-tabbar" role="tablist">
      <button class="${state.hTab === "today" ? "active" : ""}" type="button" role="tab" aria-selected="${state.hTab === "today"}" data-h-tab="today">今日候选</button>
      <button class="${state.hTab === "drafts" ? "active" : ""}" type="button" role="tab" aria-selected="${state.hTab === "drafts"}" data-h-tab="drafts">草稿库</button>
      <button class="${state.hTab === "history" ? "active" : ""}" type="button" role="tab" aria-selected="${state.hTab === "history"}" data-h-tab="history">历史</button>
    </div>
    ${state.hError ? `<div class="h-message h-error-message" role="alert"><span>${escapeHtml(state.hError)}</span><button class="text-button" type="button" data-h-dismiss-error>关闭</button></div>` : ""}
    ${state.hMessage ? `<div class="h-message" role="status">${escapeHtml(state.hMessage)}</div>` : ""}
    ${state.hSaving && !state.hGeneratingMode ? '<div class="h-saving-bar" role="status">正在处理，请稍候…</div>' : ""}
    ${body}
    ${renderHGenerationProgress()}
  `);
}

async function loadHColumn({ date, force = false } = {}) {
  if (window.location.protocol === "file:") return;
  state.hDate = date || state.hDate || getShanghaiDateString();
  const requestedDate = state.hDate;
  const loadToken = ++state.hLoadToken;
  state.hTopicLoadToken += 1;
  state.hLoading = true;
  state.hError = "";
  state.hMessage = "";
  renderHColumn();
  try {
    const params = new URLSearchParams({ date: requestedDate });
    if (force) params.set("sync", "1");
    const response = await fetch(`/api/h/topics?${params.toString()}`, {
      headers: { accept: "application/json" },
    });
    const data = await response.json();
    if (loadToken !== state.hLoadToken) return;
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    state.hActor = data.actor || state.hActor;
    state.hTopics = Array.isArray(data.topics) ? data.topics : [];
    if (response.status === 202 || data.running) {
      state.hMessage = "候选正在后台生成，稍后会自动刷新。";
      window.setTimeout(() => {
        if (state.view === "h-column" && state.hDate === requestedDate) {
          loadHColumn({ date: requestedDate, force: true });
        }
      }, 2500);
    }
    if (state.hTopic) {
      const stillVisible = state.hTopics.some((topic) => Number(topic.id) === Number(state.hTopic.id));
      if (!stillVisible) {
        state.hTopic = null;
        state.hSelectedDraftId = null;
        state.hSelectedOutlineId = null;
      }
    }
  } catch (error) {
    if (loadToken !== state.hLoadToken) return;
    state.hTopics = [];
    state.hTopic = null;
    state.hSelectedDraftId = null;
    state.hSelectedOutlineId = null;
    state.hError = error instanceof Error ? error.message : String(error);
  } finally {
    if (loadToken !== state.hLoadToken) return;
    state.hLoading = false;
    renderHColumn();
  }
}

async function loadHTopic(topicId) {
  const loadToken = ++state.hTopicLoadToken;
  state.hLoading = true;
  state.hError = "";
  renderHColumn();
  try {
    const response = await fetch(`/api/h/topics/${encodeURIComponent(topicId)}`, {
      headers: { accept: "application/json" },
    });
    const data = await response.json();
    if (loadToken !== state.hTopicLoadToken) return;
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    state.hActor = data.actor || state.hActor;
    state.hTopic = data.topic || null;
    state.hSelectedDraftId = getHSelectedDraft(state.hTopic)?.id || null;
    state.hSelectedOutlineId = getHSelectedOutline(state.hTopic)?.id || null;
    const index = state.hTopics.findIndex((topic) => Number(topic.id) === Number(topicId));
    if (index >= 0 && state.hTopic) {
      state.hTopics[index] = { ...state.hTopics[index], ...state.hTopic, draftCount: state.hTopic.drafts?.length || 0 };
    }
  } catch (error) {
    if (loadToken !== state.hTopicLoadToken) return;
    state.hError = error instanceof Error ? error.message : String(error);
  } finally {
    if (loadToken !== state.hTopicLoadToken) return;
    state.hLoading = false;
    renderHColumn();
  }
}

async function loadHHistory() {
  try {
    const response = await fetch("/api/h/topics/history", { headers: { accept: "application/json" } });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    state.hHistory = Array.isArray(data.topics) ? data.topics : [];
  } catch (error) {
    state.hError = error instanceof Error ? error.message : String(error);
  }
  renderHColumn();
}

async function withHGenerationProgress(mode, action, initialProgress = null) {
  const startedAt = Date.now();
  state.hGeneratingMode = mode || "content";
  state.hGenerationProgress = initialProgress;
  renderHColumn();
  try {
    return await action();
  } finally {
    const remaining = 650 - (Date.now() - startedAt);
    if (remaining > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, remaining));
    }
    state.hGeneratingMode = null;
    state.hGenerationProgress = null;
    renderHColumn();
  }
}

async function requestHChannelFromOutline(outlineDraftId, mode) {
  const response = await fetch(`/api/h/drafts/${encodeURIComponent(outlineDraftId)}/generate`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      mode,
      fromOutline: true,
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function hApiAction(url, options = {}, successMessage = "") {
  state.hSaving = true;
  state.hError = "";
  state.hMessage = "";
  renderHColumn();
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    state.hActor = data.actor || state.hActor;
    if (data.topic) {
      state.hTopic = data.topic;
      state.hSelectedDraftId = getHSelectedDraft(data.topic)?.id || state.hSelectedDraftId;
      state.hSelectedOutlineId = getHSelectedOutline(data.topic)?.id || state.hSelectedOutlineId;
      const index = state.hTopics.findIndex((topic) => Number(topic.id) === Number(data.topic.id));
      if (index >= 0) state.hTopics[index] = { ...state.hTopics[index], ...data.topic, draftCount: data.topic.drafts?.length || 0 };
    }
    if (data.draft) {
      state.hSelectedDraftId = data.draft.id;
      if (data.draft.mode === "outline") state.hSelectedOutlineId = data.draft.id;
      await loadHTopic(data.draft.topicId);
    }
    if (Array.isArray(data.topics)) state.hTopics = data.topics;
    state.hMessage = typeof successMessage === "function"
      ? successMessage(data)
      : successMessage;
    return data;
  } catch (error) {
    state.hError = error instanceof Error ? error.message : String(error);
    return null;
  } finally {
    state.hSaving = false;
    renderHColumn();
  }
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
  renderSubscriptions();
  renderDepartmentSubscriptions();
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
    title: item.title || t("common.untitledUpdate"),
    summary: item.summary || t("common.readOriginal"),
    originalTitle: item.originalTitle || item.title || "",
    originalSummary: item.originalSummary || "",
    translated: Boolean(item.translated),
    source: item.source || t("common.unknownSource"),
    country: cleanFilterLabel(item.country) || t("common.global"),
    countryEn: cleanFilterLabel(item.countryEn) || "",
    category: cleanFilterLabel(item.category) || t("common.policy"),
    categoryEn: cleanFilterLabel(item.categoryEn) || "",
    time: item.time || t("common.justNow"),
    heat: Number(item.heat || 60),
    impact: item.impact || "中影响",
    impactEn: item.impactEn || "",
    tags: Array.isArray(item.tags) ? item.tags.map(cleanFilterLabel).filter(Boolean) : [],
    tagsEn: Array.isArray(item.tagsEn) ? item.tagsEn.map(cleanFilterLabel).filter(Boolean) : [],
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

async function loadSourceStats() {
  if (window.location.protocol === "file:") {
    renderBriefInfo();
    return;
  }

  try {
    const response = await fetch("/api/sources/stats", {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    state.sourceStats = {
      enabledCount: Number(data.stats?.enabledCount || 0),
      totalCount: Number(data.stats?.totalCount || 0),
      publicDailyCount: Number(data.stats?.publicDailyCount || 0),
    };
  } catch (error) {
    console.warn("source stats load failed:", error);
  } finally {
    renderBriefInfo();
  }
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
  state.departmentDailyReports = [];
  state.departmentDailyLoaded = false;
  state.departmentDailyMissingSync = false;
  state.departmentDailyError = "";
  state.personalDaily = null;
  state.personalDailyError = "";
  renderContent();

  try {
    const params = new URLSearchParams();
    if (refresh) params.set("refresh", "1");
    if (date) params.set("date", date);
    if (state.language === "en") params.set("lang", "en");
    const qs = params.toString();
    const response = await fetch(`/api/daily${qs ? `?${qs}` : ""}`, {
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    state.dailyReport = data.report || null;
    state.dailyDate = data.report?.date || date || null;
  } catch {
    state.dailyReport = null;
  } finally {
    state.dailyLoading = false;
    renderContent();
  }

  if (state.ssoUserId && state.dailyReport) {
    loadDepartmentDaily({ date: state.dailyDate || date });
    loadPersonalDaily({ date: state.dailyDate || date });
  }
}

async function loadDepartmentDaily({ date } = {}) {
  if (window.location.protocol === "file:" || !state.ssoUserId) {
    state.departmentDailyReports = [];
    state.departmentDailyLoaded = false;
    state.departmentDailyMissingSync = false;
    state.departmentDailyError = "";
    renderContent();
    return;
  }

  state.departmentDailyLoading = true;
  state.departmentDailyError = "";
  renderContent();

  try {
    const params = new URLSearchParams();
    if (date) params.set("date", date);
    const qs = params.toString();
    const response = await fetch(`/api/daily/department${qs ? `?${qs}` : ""}`, {
      headers: { accept: "application/json" },
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    state.departmentDailyReports = Array.isArray(data.departments) ? data.departments : [];
    state.departmentDailyMissingSync = Boolean(data.missingDepartmentSync);
    state.departmentDailyLoaded = true;
  } catch (error) {
    state.departmentDailyReports = [];
    state.departmentDailyMissingSync = false;
    state.departmentDailyLoaded = false;
    state.departmentDailyError =
      `部门重点加载失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    state.departmentDailyLoading = false;
    renderContent();
  }
}

async function loadPersonalDaily({ date } = {}) {
  if (window.location.protocol === "file:" || !state.ssoUserId) {
    state.personalDaily = null;
    state.personalDailyError = "";
    renderContent();
    return;
  }

  state.personalDailyLoading = true;
  state.personalDailyError = "";
  renderContent();

  try {
    const params = new URLSearchParams();
    if (date) params.set("date", date);
    const qs = params.toString();
    const response = await fetch(`/api/daily/personal${qs ? `?${qs}` : ""}`, {
      headers: { accept: "application/json" },
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    state.personalDaily = data.supplement || null;
  } catch (error) {
    state.personalDaily = null;
    state.personalDailyError = `专属关注加载失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    state.personalDailyLoading = false;
    renderContent();
  }
}

async function loadSubscriptions() {
  if (window.location.protocol === "file:" || !state.ssoUserId) {
    renderContent();
    return;
  }

  state.subscriptionLoading = true;
  state.subscriptionError = "";
  renderContent();

  try {
    const response = await fetch("/api/subscriptions/me", {
      headers: { accept: "application/json" },
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    state.subscriptionSources = Array.isArray(data.sources) ? data.sources : [];
    state.subscriptionSelectedIds = new Set(
      (Array.isArray(data.subscribedSourceIds) ? data.subscribedSourceIds : [])
        .map(Number)
        .filter(Number.isFinite),
    );
    state.subscriptionLoaded = true;
  } catch (error) {
    state.subscriptionSources = [];
    state.subscriptionSelectedIds = new Set();
    state.subscriptionLoaded = false;
    state.subscriptionError = `关注配置加载失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    state.subscriptionLoading = false;
    renderContent();
  }
}

async function saveSubscriptions() {
  if (window.location.protocol === "file:" || !state.ssoUserId || state.subscriptionSaving) return;

  state.subscriptionSaving = true;
  state.subscriptionError = "";
  renderContent();

  try {
    const response = await fetch("/api/subscriptions/me", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        sourceIds: [...state.subscriptionSelectedIds],
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    state.subscriptionSources = Array.isArray(data.sources) ? data.sources : state.subscriptionSources;
    state.subscriptionSelectedIds = new Set(
      (Array.isArray(data.subscribedSourceIds) ? data.subscribedSourceIds : [])
        .map(Number)
        .filter(Number.isFinite),
    );
    state.subscriptionLoaded = true;
    subscriptionNote.textContent = `已保存 ${state.subscriptionSelectedIds.size} 个关注信源。`;
    await loadPersonalDaily({ date: state.dailyDate || undefined });
  } catch (error) {
    state.subscriptionError = `保存失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    state.subscriptionSaving = false;
    renderContent();
  }
}

function selectDepartmentSubscription(departmentIdValue) {
  const departmentId = Number(departmentIdValue);
  const department = state.departmentSubscriptions.find((item) => Number(item.id) === departmentId);
  state.departmentSubscriptionSelectedId = department ? departmentId : null;
  state.departmentSubscriptionPickerQuery = "";
  state.departmentSubscriptionPickerOpen = false;
  state.departmentSubscriptionSelectedSourceIds = new Set(
    (department?.sourceIds || []).map(Number).filter(Number.isFinite),
  );
}

async function loadDepartmentSubscriptions() {
  if (window.location.protocol === "file:" || state.departmentSubscriptionLoading) return;
  state.departmentSubscriptionLoading = true;
  state.departmentSubscriptionError = "";
  renderContent();

  try {
    const response = await fetch("/api/subscriptions/departments", {
      headers: { accept: "application/json" },
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    state.departmentSubscriptions = Array.isArray(data.departments) ? data.departments : [];
    state.departmentSubscriptionSources = Array.isArray(data.sources) ? data.sources : [];
    const selectedStillExists = state.departmentSubscriptions.some(
      (department) => Number(department.id) === Number(state.departmentSubscriptionSelectedId),
    );
    selectDepartmentSubscription(
      selectedStillExists
        ? state.departmentSubscriptionSelectedId
        : state.departmentSubscriptions[0]?.id,
    );
  } catch (error) {
    state.departmentSubscriptions = [];
    state.departmentSubscriptionSources = [];
    state.departmentSubscriptionError =
      `部门关注加载失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    state.departmentSubscriptionLoading = false;
    renderContent();
  }
}

async function saveDepartmentSubscriptions() {
  if (
    window.location.protocol === "file:"
    || !state.departmentSubscriptionSelectedId
    || state.departmentSubscriptionSaving
  ) return;

  state.departmentSubscriptionSaving = true;
  state.departmentSubscriptionError = "";
  renderContent();
  try {
    const response = await fetch("/api/subscriptions/departments", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        departmentId: state.departmentSubscriptionSelectedId,
        sourceIds: [...state.departmentSubscriptionSelectedSourceIds],
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    state.departmentSubscriptions = Array.isArray(data.departments) ? data.departments : [];
    state.departmentSubscriptionSources = Array.isArray(data.sources)
      ? data.sources
      : state.departmentSubscriptionSources;
    selectDepartmentSubscription(state.departmentSubscriptionSelectedId);
    departmentSubscriptionNote.textContent =
      `已保存 ${state.departmentSubscriptionSelectedSourceIds.size} 个部门默认关注。`;
    state.subscriptionLoaded = false;
    state.departmentDailyReports = [];
    state.departmentDailyLoaded = false;
    state.personalDaily = null;
  } catch (error) {
    state.departmentSubscriptionError =
      `部门关注保存失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    state.departmentSubscriptionSaving = false;
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
      const description = String(item.description || "").replace(/\\r\\n|\\n|\\r/g, "\n");
      html += `<article>
        <time>${escapeHtml(item.log_date)}</time>
        <h2>${escapeHtml(item.title)}</h2>
        ${description ? `<p>${escapeHtml(description)}</p>` : ""}
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
          state.ssoLocalTest = false;
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
      state.ssoLocalTest = Boolean(data.localTest);
      sessionStorage.setItem("yiminSsoUserId", data.userId);
    }
  } catch {
    /* Identity recovery should not block page rendering. */
  }
}

function updateHAccessUI() {
  const navItem = document.querySelector("[data-h-column-nav]");
  if (navItem) navItem.hidden = !state.hAccess;
}

async function loadHAccess() {
  state.hAccess = false;
  state.hActor = null;
  if (window.location.protocol !== "file:") {
    try {
      const response = await fetch("/api/h/me", {
        headers: { accept: "application/json" },
      });
      const data = await response.json();
      if (response.ok && data.ok && data.actor) {
        state.hAccess = true;
        state.hActor = data.actor;
      }
    } catch {
      /* H access fails closed when identity or the API is unavailable. */
    }
  }
  updateHAccessUI();
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
  if (viewName === "h-column" && !state.hAccess) {
    viewName = "home";
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
    } else if (state.ssoUserId) {
      if (!state.departmentDailyLoaded && !state.departmentDailyLoading) {
        loadDepartmentDaily({ date: state.dailyDate || undefined });
      }
      if (!state.personalDaily && !state.personalDailyLoading) {
        loadPersonalDaily({ date: state.dailyDate || undefined });
      }
    }
  }
  if (viewName === "h-column" && !state.hLoading) {
    loadHColumn({ date: state.hDate || getShanghaiDateString() });
  }
  if (viewName === "subscriptions" && !state.subscriptionLoaded && !state.subscriptionLoading) {
    loadSubscriptions();
  }
  if (viewName === "department-subscriptions" && !state.departmentSubscriptionLoading) {
    loadDepartmentSubscriptions();
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
  const distributionContainer = document.querySelector("#sourceDistributionList");
  container.innerHTML = '<p class="form-note">加载中...</p>';
  if (distributionContainer) {
    distributionContainer.innerHTML = '<p class="form-note">加载中...</p>';
  }
  state.sourceDistributionLoading = true;
  state.sourceDistributionError = "";
  try {
    const [submissionResponse, distributionResponse] = await Promise.all([
      fetch("/api/submissions"),
      fetch("/api/source-distribution"),
    ]);
    const [submissionData, distributionData] = await Promise.all([
      submissionResponse.json(),
      distributionResponse.json(),
    ]);
    if (!submissionResponse.ok || !submissionData.ok) {
      throw new Error(submissionData.error || `HTTP ${submissionResponse.status}`);
    }
    if (!distributionResponse.ok || !distributionData.ok) {
      throw new Error(distributionData.error || `HTTP ${distributionResponse.status}`);
    }
    state.sourceDistributionSources = Array.isArray(distributionData.sources)
      ? distributionData.sources
      : [];
    renderReview(submissionData.submissions || []);
  } catch (error) {
    state.sourceDistributionSources = [];
    state.sourceDistributionError = error instanceof Error ? error.message : String(error);
    container.innerHTML = '<p class="form-note">加载失败，请检查是否已登录。</p>';
  } finally {
    state.sourceDistributionLoading = false;
    renderSourceDistribution();
  }
}

function renderSourceDistribution() {
  const container = document.querySelector("#sourceDistributionList");
  const note = document.querySelector("#sourceDistributionNote");
  if (!container || !note) return;

  if (state.sourceDistributionLoading) {
    container.innerHTML = '<p class="form-note">正在加载信源发布范围...</p>';
    return;
  }
  if (state.sourceDistributionError) {
    container.innerHTML = `<div class="empty">${escapeHtml(state.sourceDistributionError)}</div>`;
    return;
  }

  const query = state.sourceDistributionSearch.trim().toLowerCase();
  const sources = state.sourceDistributionSources.filter((source) => {
    if (!query) return true;
    return `${source.name || ""} ${source.country || ""} ${source.category || ""}`
      .toLowerCase()
      .includes(query);
  });
  if (!sources.length) {
    container.innerHTML = '<div class="empty">没有符合条件的信源。</div>';
    return;
  }

  container.innerHTML = `<div class="source-distribution-list">${sources.map((source) => {
    const sourceId = Number(source.id);
    const isPublic = source.publicDailyEnabled !== false;
    const isSaving = Number(state.sourceDistributionSavingId) === sourceId;
    const updated = source.publicDailyUpdatedAt
      ? String(source.publicDailyUpdatedAt).replace("T", " ").slice(0, 16)
      : "尚未调整";
    return `
      <article class="source-distribution-card${isPublic ? " public" : " department-only"}" data-source-distribution-id="${sourceId}">
        <div class="source-distribution-card-head">
          <div>
            <strong>${escapeHtml(source.name || "未命名信源")}</strong>
            <small>${escapeHtml(source.country || "全球")} · ${escapeHtml(source.category || "未分类")} · ${escapeHtml(source.type || "rss")}</small>
          </div>
          <span class="source-scope-badge">${source.enabled === false ? "已停用" : isPublic ? "公共日报" : "仅订阅部门"}</span>
        </div>
        <div class="source-distribution-fields">
          <label>
            <span>发布范围</span>
            <select data-source-distribution-scope${isSaving ? " disabled" : ""}>
              <option value="public"${isPublic ? " selected" : ""}>公共日报</option>
              <option value="department"${isPublic ? "" : " selected"}>仅订阅部门</option>
            </select>
          </label>
          <label>
            <span>调整原因</span>
            <input data-source-distribution-reason maxlength="255" value="${escapeHtml(source.publicDailyExclusionReason || "")}" placeholder="切换为仅订阅部门时必填"${isSaving ? " disabled" : ""}>
          </label>
        </div>
        <div class="source-distribution-footer">
          <span>${escapeHtml(source.departmentCount || 0)} 个部门订阅 · ${escapeHtml(updated)}${source.publicDailyUpdatedBy ? ` · ${escapeHtml(source.publicDailyUpdatedBy)}` : ""}</span>
          <button class="ghost-button" data-action="save-source-distribution" data-id="${sourceId}" type="button"${isSaving ? " disabled" : ""}>${isSaving ? "保存中..." : "保存范围"}</button>
        </div>
      </article>
    `;
  }).join("")}</div>`;
}

async function saveSourceDistribution(card) {
  if (!card || state.sourceDistributionSavingId) return;
  const sourceId = Number(card.dataset.sourceDistributionId);
  const scope = card.querySelector("[data-source-distribution-scope]")?.value || "public";
  const reason = card.querySelector("[data-source-distribution-reason]")?.value.trim() || "";
  if (scope === "department" && !reason) {
    document.querySelector("#sourceDistributionNote").textContent = "切换为仅订阅部门时必须填写调整原因。";
    card.querySelector("[data-source-distribution-reason]")?.focus();
    return;
  }

  state.sourceDistributionSavingId = sourceId;
  renderSourceDistribution();
  try {
    const response = await fetch(`/api/source-distribution/${sourceId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        publicDailyEnabled: scope === "public",
        reason,
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    state.sourceDistributionSources = Array.isArray(data.sources) ? data.sources : [];
    state.departmentSubscriptionLoading = false;
    state.subscriptionLoaded = false;
    document.querySelector("#sourceDistributionNote").textContent =
      "发布范围已保存。请重新生成当天公共日报和部门重点后生效。";
  } catch (error) {
    document.querySelector("#sourceDistributionNote").textContent =
      `保存失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    state.sourceDistributionSavingId = null;
    renderSourceDistribution();
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
  const action = btn.dataset.action;

  if (action === "save-source-distribution") {
    await saveSourceDistribution(btn.closest("[data-source-distribution-id]"));
    return;
  }

  const card = btn.closest(".review-card");

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
  const hTabButton = event.target.closest("[data-h-tab]");
  if (hTabButton) {
    state.hTab = hTabButton.dataset.hTab || "today";
    state.hTopic = null;
    state.hSelectedDraftId = null;
    state.hSelectedOutlineId = null;
    state.hSuiteFailedModes = [];
    if (state.hTab === "history") await loadHHistory();
    else renderHColumn();
    return;
  }

  const hOpenTopicButton = event.target.closest("[data-h-open-topic]");
  if (hOpenTopicButton) {
    const topicId = hOpenTopicButton.dataset.hOpenTopic;
    state.hEditingViewpointId = null;
    state.hSelectedDraftId = null;
    state.hSelectedOutlineId = null;
    state.hSuiteFailedModes = [];
    if (state.hTab === "history") {
      const historyTopic = state.hHistory.find((topic) => Number(topic.id) === Number(topicId));
      state.hDate = historyTopic?.date || state.hDate;
      state.hTab = "today";
      await loadHColumn({ date: state.hDate });
    }
    await loadHTopic(topicId);
    return;
  }

  if (event.target.closest("[data-h-dismiss-error]")) {
    state.hError = "";
    renderHColumn();
    return;
  }

  if (event.target.closest("[data-h-close-topic]")) {
    state.hTopic = null;
    state.hSelectedDraftId = null;
    state.hSelectedOutlineId = null;
    state.hEditingViewpointId = null;
    state.hSuiteFailedModes = [];
    renderHColumn();
    return;
  }

  if (event.target.closest("[data-h-retry]")) {
    await loadHColumn({ date: state.hDate, force: true });
    return;
  }

  const hStatusButton = event.target.closest("[data-h-topic-status]");
  if (hStatusButton) {
    const topicId = hStatusButton.dataset.topicId;
    const status = hStatusButton.dataset.hTopicStatus;
    const message = status === "selected"
      ? (data) => {
          const sourceCount = Number(data.topic?.sourceCount || 0);
          const fullSourceCount = Number(data.topic?.fullSourceCount || 0);
          if (!sourceCount) return "已标记为值得写。当前没有可抓取链接，可在事实包中补充来源。";
          if (fullSourceCount >= sourceCount) {
            return `已标记为值得写，并自动补全 ${fullSourceCount}/${sourceCount} 条来源正文。`;
          }
          if (fullSourceCount > 0) {
            return `已标记为值得写，已自动补全 ${fullSourceCount}/${sourceCount} 条来源正文；其余可在事实包中重试。`;
          }
          return "已标记为值得写，系统已自动尝试补全文；暂未取得完整正文，可在事实包中重试。";
        }
      : status === "later"
        ? "已放入以后再说。"
        : "已记录为不写。";
    await hApiAction(`/api/h/topics/${encodeURIComponent(topicId)}`, {
      method: "PUT",
      body: JSON.stringify({ status }),
    }, message);
    return;
  }

  const hFetchEvidenceButton = event.target.closest("[data-h-fetch-evidence]");
  if (hFetchEvidenceButton) {
    await hApiAction(`/api/h/topics/${encodeURIComponent(hFetchEvidenceButton.dataset.hFetchEvidence)}/evidence/fetch`, {
      method: "POST",
    }, "事实包已重新抓取，并按来源等级与完整度更新。");
    return;
  }

  const hDeleteSourceButton = event.target.closest("[data-h-delete-source]");
  if (hDeleteSourceButton) {
    if (!window.confirm("确定从本选题移除这条来源吗？这不会删除公共日报原始数据。")) return;
    await hApiAction(`/api/h/sources/${encodeURIComponent(hDeleteSourceButton.dataset.hDeleteSource)}`, {
      method: "DELETE",
    }, "来源已从本选题移除。");
    return;
  }

  const hVerifySourceButton = event.target.closest("[data-h-verify-source]");
  if (hVerifySourceButton) {
    await hApiAction(`/api/h/sources/${encodeURIComponent(hVerifySourceButton.dataset.hVerifySource)}`, {
      method: "PUT",
      body: JSON.stringify({ verified: true }),
    }, "来源已由当前账号标记为人工核验。");
    return;
  }

  const hConfirmViewpointButton = event.target.closest("[data-h-confirm-viewpoint]");
  if (hConfirmViewpointButton) {
    await hApiAction(`/api/h/viewpoints/${encodeURIComponent(hConfirmViewpointButton.dataset.hConfirmViewpoint)}/confirm`, {
      method: "POST",
    }, "该观点已确认，可用于成稿。");
    return;
  }

  const hEditViewpointButton = event.target.closest("[data-h-edit-viewpoint]");
  if (hEditViewpointButton) {
    state.hEditingViewpointId = Number(hEditViewpointButton.dataset.hEditViewpoint);
    renderHColumn();
    return;
  }

  if (event.target.closest("[data-h-cancel-viewpoint]")) {
    state.hEditingViewpointId = null;
    renderHColumn();
    return;
  }

  const hDeleteViewpointButton = event.target.closest("[data-h-delete-viewpoint]");
  if (hDeleteViewpointButton) {
    if (!window.confirm("确定删除这条 Henry 观点吗？删除后不会再用于新草稿。")) return;
    const data = await hApiAction(`/api/h/viewpoints/${encodeURIComponent(hDeleteViewpointButton.dataset.hDeleteViewpoint)}`, {
      method: "DELETE",
    }, "观点已删除。");
    if (data) state.hEditingViewpointId = null;
    return;
  }

  const hGenerateButton = event.target.closest("[data-h-generate]");
  if (hGenerateButton) {
    const mode = hGenerateButton.dataset.hGenerate;
    await withHGenerationProgress(mode, () => hApiAction(
      `/api/h/topics/${encodeURIComponent(hGenerateButton.dataset.topicId)}/drafts`,
      {
        method: "POST",
        body: JSON.stringify({ mode }),
      },
      `${hModeLabels[mode] || "内容"}已生成。`,
    ));
    return;
  }

  const hGenerateSuiteButton = event.target.closest("[data-h-generate-suite]");
  if (hGenerateSuiteButton) {
    const outlineDraftId = hGenerateSuiteButton.dataset.hGenerateSuite;
    const topicId = hGenerateSuiteButton.dataset.topicId;
    state.hSuiteFailedModes = [];
    const results = await withHGenerationProgress(
      "suite",
      async () => {
        let completed = 0;
        const outcomes = await Promise.all(hSuiteModes.map(async (mode) => {
          let outcome;
          try {
            const data = await requestHChannelFromOutline(outlineDraftId, mode);
            outcome = { mode, ok: true, data };
          } catch (error) {
            outcome = {
              mode,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
          completed += 1;
          state.hGenerationProgress = {
            completed,
            total: hSuiteModes.length,
            label: outcome.ok
              ? `${hModeLabels[mode]}已生成，正在等待其余渠道…`
              : `${hModeLabels[mode]}生成失败，其他渠道仍在继续…`,
          };
          renderHColumn();
          return outcome;
        }));
        const failed = outcomes.filter((item) => !item.ok);
        const succeeded = outcomes.filter((item) => item.ok);
        await loadHTopic(topicId);
        const reloadError = state.hError;
        state.hActor = succeeded.find((item) => item.data?.actor)?.data?.actor || state.hActor;
        state.hSuiteFailedModes = failed.map((item) => item.mode);
        state.hMessage = succeeded.length
          ? `整套稿件已生成 ${succeeded.length}/${hSuiteModes.length} 个渠道；每个版本需要单独审校。`
          : "";
        state.hError = [
          reloadError,
          failed.length
            ? `${failed.map((item) => hModeLabels[item.mode]).join("、")}生成失败，可在渠道卡片中单独重试。`
            : "",
        ].filter(Boolean).join(" ");
        renderHColumn();
        return outcomes;
      },
      {
        completed: 0,
        total: hSuiteModes.length,
        label: "四个渠道已同时开始生成，请稍候…",
      },
    );
    if (!results) renderHColumn();
    return;
  }

  const hGenerateChannelButton = event.target.closest("[data-h-generate-channel]");
  if (hGenerateChannelButton) {
    const mode = hGenerateChannelButton.dataset.hGenerateChannel;
    const outlineDraftId = hGenerateChannelButton.dataset.outlineId;
    const topicId = hGenerateChannelButton.dataset.topicId;
    await withHGenerationProgress(mode, async () => {
      try {
        const data = await requestHChannelFromOutline(outlineDraftId, mode);
        state.hActor = data.actor || state.hActor;
        await loadHTopic(topicId);
        state.hSelectedDraftId = data.draft?.id || state.hSelectedDraftId;
        state.hSuiteFailedModes = (state.hSuiteFailedModes || []).filter((item) => item !== mode);
        state.hMessage = `${hModeLabels[mode]}已生成新版本，旧版本已保留。`;
        state.hError = "";
      } catch (error) {
        state.hSuiteFailedModes = Array.from(new Set([...(state.hSuiteFailedModes || []), mode]));
        state.hError = error instanceof Error ? error.message : String(error);
      }
      renderHColumn();
    });
    return;
  }

  const hSelectDraftButton = event.target.closest("[data-h-select-draft]");
  if (hSelectDraftButton) {
    const selectedDraftId = Number(hSelectDraftButton.dataset.hSelectDraft);
    const selectedDraft = state.hTopic?.drafts?.find((draft) => Number(draft.id) === selectedDraftId);
    const shouldScrollToEditor = hSelectDraftButton.hasAttribute("data-h-scroll-to-editor");
    state.hSelectedDraftId = selectedDraftId;
    if (selectedDraft?.mode === "outline") state.hSelectedOutlineId = selectedDraftId;
    renderHColumn();
    if (shouldScrollToEditor) {
      window.requestAnimationFrame(() => {
        const editorAnchor = hColumnApp?.querySelector("[data-h-draft-editor-anchor]");
        if (!editorAnchor) return;
        const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
        editorAnchor.scrollIntoView({
          behavior: reduceMotion ? "auto" : "smooth",
          block: "start",
        });
        editorAnchor.focus({ preventScroll: true });
        editorAnchor.classList.add("is-located");
        window.setTimeout(() => editorAnchor.classList.remove("is-located"), 1400);
      });
    }
    return;
  }

  const hCopyDraftButton = event.target.closest("[data-h-copy-draft]");
  if (hCopyDraftButton) {
    const draft = getHSelectedDraft(state.hTopic);
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(`# ${draft.title || state.hTopic?.title || ""}\n\n${draft.contentMarkdown || ""}`);
      state.hMessage = "Markdown 草稿已复制。";
    } catch {
      state.hMessage = "浏览器未允许复制，请在正文框中手动复制。";
    }
    renderHColumn();
    return;
  }

  const hCopyPlainButton = event.target.closest("[data-h-copy-plain]");
  if (hCopyPlainButton) {
    const draft = getHSelectedDraft(state.hTopic);
    if (!draft) return;
    try {
      await navigator.clipboard.writeText([
        draft.title || state.hTopic?.title || "",
        markdownToPlainText(draft.contentMarkdown || ""),
      ].filter(Boolean).join("\n\n"));
      state.hMessage = "纯文本草稿已复制。";
    } catch {
      state.hMessage = "浏览器未允许复制，请在正文框中手动复制。";
    }
    renderHColumn();
    return;
  }

  const hExportDraftButton = event.target.closest("[data-h-export-draft]");
  if (hExportDraftButton) {
    state.hSaving = true;
    renderHColumn();
    try {
      const response = await fetch(`/api/h/drafts/${encodeURIComponent(hExportDraftButton.dataset.hExportDraft)}/export`, {
        headers: { accept: "application/json" },
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const blob = new Blob([data.content || ""], { type: "text/markdown;charset=utf-8" });
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = `H内容包-${state.hTopic?.date || state.hDate || getShanghaiDateString()}-${hExportDraftButton.dataset.hExportDraft}.md`;
      link.click();
      URL.revokeObjectURL(href);
      state.hMessage = "内容包已导出。";
    } catch (error) {
      state.hError = error instanceof Error ? error.message : String(error);
    } finally {
      state.hSaving = false;
      renderHColumn();
    }
    return;
  }

  const hSaveDraftButton = event.target.closest("[data-h-save-draft]");
  if (hSaveDraftButton) {
    const editor = hSaveDraftButton.closest(".h-draft-editor");
    await hApiAction(`/api/h/drafts/${encodeURIComponent(hSaveDraftButton.dataset.hSaveDraft)}`, {
      method: "PUT",
      body: JSON.stringify({
        title: editor?.querySelector("[data-h-draft-title]")?.value || "",
        contentMarkdown: editor?.querySelector("[data-h-draft-content]")?.value || "",
      }),
    }, "修改已保存为新版本。");
    return;
  }

  const hRetryDraftButton = event.target.closest("[data-h-retry-draft]");
  if (hRetryDraftButton) {
    const mode = hRetryDraftButton.dataset.hMode;
    await withHGenerationProgress(mode, () => hApiAction(
      `/api/h/topics/${encodeURIComponent(state.hTopic?.id)}/drafts`,
      {
        method: "POST",
        body: JSON.stringify({
          mode,
          refresh: true,
        }),
      },
      "已重新生成一个完整版本。",
    ));
    return;
  }

  const hReviewDraftButton = event.target.closest("[data-h-review-draft]");
  if (hReviewDraftButton) {
    await withHGenerationProgress("review", () => hApiAction(
      `/api/h/drafts/${encodeURIComponent(hReviewDraftButton.dataset.hReviewDraft)}/review`,
      { method: "POST" },
      "四层审校已完成。",
    ));
    return;
  }

  const hGenerateReviewedButton = event.target.closest("[data-h-generate-reviewed]");
  if (hGenerateReviewedButton) {
    await withHGenerationProgress("review_revision", () => hApiAction(
      `/api/h/drafts/${encodeURIComponent(hGenerateReviewedButton.dataset.hGenerateReviewed)}/generate`,
      { method: "POST" },
      "已按最新审校意见生成新版本，旧版本已保留。",
    ));
    return;
  }

  const hMarkReviewedButton = event.target.closest("[data-h-mark-reviewed]");
  if (hMarkReviewedButton) {
    await hApiAction(`/api/h/drafts/${encodeURIComponent(hMarkReviewedButton.dataset.hMarkReviewed)}/henry-reviewed`, {
      method: "POST",
    }, "已记录本人或授权编辑审阅。");
    return;
  }

  const hApproveDraftButton = event.target.closest("[data-h-approve-draft]");
  if (hApproveDraftButton) {
    if (!window.confirm("确认将这个版本标记为最终采用吗？系统会记录确认人和时间。")) return;
    await hApiAction(`/api/h/drafts/${encodeURIComponent(hApproveDraftButton.dataset.hApproveDraft)}/approve`, {
      method: "POST",
    }, "该版本已最终采用，并写入操作日志。");
    return;
  }

  const hReturnDraftButton = event.target.closest("[data-h-return-draft]");
  if (hReturnDraftButton) {
    const note = window.prompt("请填写退回原因（可留空）：", "");
    if (note === null) return;
    await hApiAction(`/api/h/drafts/${encodeURIComponent(hReturnDraftButton.dataset.hReturnDraft)}/return`, {
      method: "POST",
      body: JSON.stringify({ note }),
    }, "该版本已退回修改，并写入操作日志。");
    return;
  }

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
    if (radarItems[idx]) showRadarDetail(radarItems[idx].key);
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

  const perspectiveButton = event.target.closest("[data-daily-perspective]");
  if (perspectiveButton) {
    const perspective = perspectiveButton.dataset.dailyPerspective;
    if (!dailyPerspectives.has(perspective)) return;
    state.dailyPerspective = perspective;
    try {
      localStorage.setItem(dailyPerspectiveStorageKey, perspective);
    } catch {
      // Storage availability should not block switching views.
    }
    renderDaily();
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

document.querySelector("#subscriptionSearch")?.addEventListener("input", (event) => {
  state.subscriptionSearch = event.target.value;
  renderSubscriptions();
});

document.querySelector("#subscriptionCountry")?.addEventListener("change", (event) => {
  state.subscriptionCountry = event.target.value;
  renderSubscriptions();
});

document.querySelector("#subscriptionCategory")?.addEventListener("change", (event) => {
  state.subscriptionCategory = event.target.value;
  renderSubscriptions();
});

document.querySelector("#subscriptionOnlySelected")?.addEventListener("change", (event) => {
  state.subscriptionOnlySelected = event.target.checked;
  renderSubscriptions();
});

subscriptionList?.addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-subscription-source]");
  if (!checkbox) return;
  const sourceId = Number(checkbox.dataset.subscriptionSource);
  if (!Number.isFinite(sourceId)) return;
  if (checkbox.checked) {
    state.subscriptionSelectedIds.add(sourceId);
  } else {
    state.subscriptionSelectedIds.delete(sourceId);
  }
  renderSubscriptions();
});

document.querySelector("#saveSubscriptions")?.addEventListener("click", () => {
  saveSubscriptions();
});

document.querySelector("#departmentSubscriptionSelect")?.addEventListener("focus", (event) => {
  if (!state.departmentSubscriptionPickerOpen) {
    state.departmentSubscriptionPickerQuery = "";
    event.target.value = "";
  }
  state.departmentSubscriptionPickerOpen = true;
  renderDepartmentSubscriptions();
});

document.querySelector("#departmentSubscriptionSelect")?.addEventListener("input", (event) => {
  state.departmentSubscriptionPickerQuery = event.target.value;
  state.departmentSubscriptionPickerOpen = true;
  renderDepartmentSubscriptions();
});

document.querySelector("#departmentSubscriptionSelect")?.addEventListener("keydown", (event) => {
  const optionButtons = [...document.querySelectorAll("#departmentSubscriptionOptions [data-department-id]")];
  if (event.key === "Escape") {
    state.departmentSubscriptionPickerQuery = "";
    state.departmentSubscriptionPickerOpen = false;
    event.target.blur();
    renderDepartmentSubscriptions();
    return;
  }
  if (event.key === "Enter" && optionButtons.length === 1) {
    event.preventDefault();
    selectDepartmentSubscription(optionButtons[0].dataset.departmentId);
    renderDepartmentSubscriptions();
    return;
  }
  if (event.key === "ArrowDown" && optionButtons.length) {
    event.preventDefault();
    optionButtons[0].focus();
  }
});

document.querySelector("#departmentSubscriptionOptions")?.addEventListener("click", (event) => {
  const option = event.target.closest("[data-department-id]");
  if (!option) return;
  selectDepartmentSubscription(option.dataset.departmentId);
  renderDepartmentSubscriptions();
});

document.querySelector("#departmentSubscriptionOptions")?.addEventListener("keydown", (event) => {
  const option = event.target.closest("[data-department-id]");
  if (!option) return;
  const optionButtons = [...document.querySelectorAll("#departmentSubscriptionOptions [data-department-id]")];
  const index = optionButtons.indexOf(option);
  if (event.key === "ArrowDown" && optionButtons[index + 1]) {
    event.preventDefault();
    optionButtons[index + 1].focus();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    if (optionButtons[index - 1]) {
      optionButtons[index - 1].focus();
    } else {
      document.querySelector("#departmentSubscriptionSelect")?.focus();
    }
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    selectDepartmentSubscription(option.dataset.departmentId);
    renderDepartmentSubscriptions();
  } else if (event.key === "Escape") {
    document.querySelector("#departmentSubscriptionSelect")?.focus();
    state.departmentSubscriptionPickerOpen = false;
    renderDepartmentSubscriptions();
  }
});

document.addEventListener("click", (event) => {
  if (event.target.closest("#departmentSubscriptionPicker")) return;
  if (!state.departmentSubscriptionPickerOpen) return;
  state.departmentSubscriptionPickerQuery = "";
  state.departmentSubscriptionPickerOpen = false;
  renderDepartmentSubscriptions();
});

document.querySelector("#departmentSubscriptionSearch")?.addEventListener("input", (event) => {
  state.departmentSubscriptionSearch = event.target.value;
  renderDepartmentSubscriptions();
});

document.querySelector("#sourceDistributionSearch")?.addEventListener("input", (event) => {
  state.sourceDistributionSearch = event.target.value;
  renderSourceDistribution();
});

departmentSubscriptionList?.addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-department-subscription-source]");
  if (!checkbox) return;
  const sourceId = Number(checkbox.dataset.departmentSubscriptionSource);
  if (!Number.isFinite(sourceId)) return;
  if (checkbox.checked) {
    state.departmentSubscriptionSelectedSourceIds.add(sourceId);
  } else {
    state.departmentSubscriptionSelectedSourceIds.delete(sourceId);
  }
  renderDepartmentSubscriptions();
});

document.querySelector("#saveDepartmentSubscriptions")?.addEventListener("click", () => {
  saveDepartmentSubscriptions();
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

document.querySelector("#hColumnRefresh")?.addEventListener("click", async () => {
  const data = await withHGenerationProgress("candidate_refresh", () => hApiAction(
    "/api/h/topics/generate",
    {
      method: "POST",
      body: JSON.stringify({
        date: state.hDate || getShanghaiDateString(),
        refresh: true,
      }),
    },
    "候选已按最新公共日报重新评估。",
  ));
  if (!data) return;
  state.hTopic = null;
  state.hSelectedDraftId = null;
  state.hSelectedOutlineId = null;
  state.hSuiteFailedModes = [];
  renderHColumn();
});

hColumnDate?.addEventListener("change", async (event) => {
  const date = event.target.value;
  if (!date) return;
  state.hTopic = null;
  state.hSelectedDraftId = null;
  state.hSelectedOutlineId = null;
  state.hSuiteFailedModes = [];
  state.hTab = "today";
  await loadHColumn({ date });
});

document.querySelector("#menuToggle").addEventListener("click", () => {
  document.body.classList.toggle("menu-open");
});

document.querySelector("#copyDaily").addEventListener("click", async () => {
  const text = dailyReport.querySelector(".daily-perspective-panel")?.innerText.trim()
    || dailyReport.innerText.trim();
  try {
    await navigator.clipboard.writeText(text);
    document.querySelector("#copyDaily").textContent = t("daily.copied");
    setTimeout(() => {
      document.querySelector("#copyDaily").textContent = t("daily.copy");
    }, 1400);
  } catch {
    document.querySelector("#copyDaily").textContent = t("daily.copyFailed");
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

document.addEventListener("submit", async (event) => {
  const viewpointEditForm = event.target.closest("[data-h-viewpoint-edit-form]");
  if (viewpointEditForm) {
    event.preventDefault();
    const formData = new FormData(viewpointEditForm);
    const editedText = String(formData.get("editedText") || "").trim();
    if (!editedText) {
      state.hMessage = "Henry 观点不能为空。";
      renderHColumn();
      return;
    }
    const data = await hApiAction(`/api/h/viewpoints/${encodeURIComponent(viewpointEditForm.dataset.viewpointId)}`, {
      method: "PUT",
      body: JSON.stringify({ editedText }),
    }, "观点已更新并重新确认。");
    if (data) {
      state.hEditingViewpointId = null;
      renderHColumn();
    }
    return;
  }

  const checksForm = event.target.closest("[data-h-checks-form]");
  if (checksForm) {
    event.preventDefault();
    const formData = new FormData(checksForm);
    await hApiAction(`/api/h/topics/${encodeURIComponent(checksForm.dataset.topicId)}`, {
      method: "PUT",
      body: JSON.stringify({
        fourChecks: {
          useful: formData.get("useful") === "1",
          longTerm: formData.get("longTerm") === "1",
        },
      }),
    }, "H 四问的人工确认已保存。");
    return;
  }

  const viewpointForm = event.target.closest("[data-h-viewpoint-form]");
  if (viewpointForm) {
    event.preventDefault();
    const formData = new FormData(viewpointForm);
    const rawText = String(formData.get("rawText") || "").trim();
    if (!rawText) {
      state.hMessage = "请先写下这次选题的真实观点。";
      renderHColumn();
      return;
    }
    const data = await hApiAction(`/api/h/topics/${encodeURIComponent(viewpointForm.dataset.topicId)}/viewpoints`, {
      method: "POST",
      body: JSON.stringify({
        rawText,
        confirm: formData.get("confirm") === "1",
      }),
    }, "观点已保存。");
    if (data) viewpointForm.reset();
    return;
  }

  const sourceForm = event.target.closest("[data-h-source-form]");
  if (sourceForm) {
    event.preventDefault();
    const formData = new FormData(sourceForm);
    const extractedText = String(formData.get("extractedText") || "").trim();
    const url = String(formData.get("url") || "").trim();
    if (!url && !extractedText) {
      state.hMessage = "来源链接和可核验材料至少填写一项。";
      renderHColumn();
      return;
    }
    const data = await hApiAction(`/api/h/topics/${encodeURIComponent(sourceForm.dataset.topicId)}/sources`, {
      method: "POST",
      body: JSON.stringify({
        sourceName: String(formData.get("sourceName") || "").trim(),
        url,
        title: String(formData.get("title") || "").trim(),
        sourceLevel: String(formData.get("sourceLevel") || "C"),
        policyStatus: String(formData.get("policyStatus") || "media_report"),
        extractedText,
        contentStatus: extractedText.length >= 800 ? "full" : extractedText ? "summary_only" : "missing",
        verified: formData.get("verified") === "1",
      }),
    }, "来源已加入事实包。");
    if (data) sourceForm.reset();
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
      document.querySelector("#feedbackNote").textContent = t("feedback.received");
      return;
    } catch (err) {
      console.error("feedback submit error:", err);
      document.querySelector("#feedbackNote").textContent = t("feedback.savedDraft");
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
  document.querySelector("#feedbackNote").textContent = t("feedback.savedDraft");
  form.reset();
});

window.addEventListener("hashchange", () => {
  const route = window.location.hash.replace("#", "");
  if (route) {
    setView(route);
  }
});

let lastBriefInfoTrigger = null;

function openBriefInfoModal(trigger) {
  const modal = document.querySelector("#briefInfoModal");
  if (!modal) return;
  lastBriefInfoTrigger = trigger || document.activeElement;
  closeArticleModal();
  modal.classList.add("active");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  modal.querySelector("[data-brief-info-close]")?.focus();
}

function closeBriefInfoModal() {
  const modal = document.querySelector("#briefInfoModal");
  if (!modal?.classList.contains("active")) return;
  modal.classList.remove("active");
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  lastBriefInfoTrigger?.focus?.();
}

document.querySelectorAll("[data-brief-info-open]").forEach((button) => {
  button.addEventListener("click", () => openBriefInfoModal(button));
});

document.querySelectorAll("[data-brief-info-close]").forEach((button) => {
  button.addEventListener("click", closeBriefInfoModal);
});

document.querySelector("#briefInfoModal")?.addEventListener("click", (event) => {
  if (event.target === event.currentTarget) {
    closeBriefInfoModal();
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    const briefInfoModal = document.querySelector("#briefInfoModal");
    if (briefInfoModal?.classList.contains("active")) {
      closeBriefInfoModal();
      return;
    }
    const overlay = document.getElementById("modalOverlay");
    if (overlay?.classList.contains("active")) {
      closeArticleModal();
    }
  }
});

// ── Theme switch ──────────────────────────────────────────
function initThemeSwitch() {
  const saved = localStorage.getItem("theme") || "dark";
  const html = document.documentElement;
  html.dataset.theme = saved;

  const radios = document.querySelectorAll("[data-theme-switch] input[name='theme']");
  radios.forEach(r => r.checked = r.value === saved);

  const apply = (value) => {
    html.dataset.theme = value;
    localStorage.setItem("theme", value);
  };

  radios.forEach(r => r.addEventListener("change", () => apply(r.value)));

  // Respond to OS preference changes when in system mode
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (localStorage.getItem("theme") === "system") apply("system");
  });
}

initThemeSwitch();

function setLanguage(language) {
  if (!supportedLanguages.has(language) || state.language === language) {
    applyStaticTranslations();
    return;
  }
  const shouldReloadDaily = state.view === "daily";
  const dailyDate = state.dailyDate;
  state.language = language;
  state.category = "全部";
  if (shouldReloadDaily) {
    state.dailyReport = null;
  }
  saveFilterCategory();
  try {
    localStorage.setItem(languageStorageKey, language);
  } catch {
    // ignore storage errors
  }
  renderContent();
  if (shouldReloadDaily) {
    loadDailyReport({ date: dailyDate || undefined });
  }
}

function initLanguageSwitch() {
  document.querySelectorAll("[data-lang-option]").forEach((button) => {
    button.addEventListener("click", () => setLanguage(button.dataset.langOption));
  });
  applyStaticTranslations();
}

initLanguageSwitch();

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
    await loadHAccess();
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
  await loadHAccess();
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
  loadSourceStats();
  await checkAuth();
  await loadHAccess();
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
        <a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" class="modal-link">${escapeHtml(t("common.viewOriginal"))}</a>
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
