export const GREEK_MINISTRY_SOURCE_NAME = "希腊移民与庇护部官网";
export const OPERATIONAL_CASE_DOCUMENT_PICKUP_REASON =
  "operational_case_document_pickup_list";
export const REFUGEE_ASYLUM_REASON = "business_scope_refugee_asylum";
export const RELIGION_REASON = "business_scope_religion";

// 只检查文章内容，不使用信源名称；移民与庇护部也会发布正常的投资、签证政策。
const excludedTopics = [
  [REFUGEE_ASYLUM_REASON, /难民|難民|庇护|庇護|政治避难|政治避難|人道主义保护|人道主義保護|\b(?:refugees?|asylum|asylees?|refugies?|refugiados?|refugio|asile|asyl|fluchtlinge?|humanitarian protection)\b|ασυλ|προσφυγ/u],
  [RELIGION_REASON, /宗教|宗教人士|传教|傳教|神职|神職|教会|教會|基督教|天主教|佛教|伊斯兰|伊斯蘭|穆斯林|\b(?:religion|religions|religious|religieux|religieuse|religiones|religios[oa]s?|r[- ]?1|faith[- ]based|church(?:es)?|clergy|priests?|missionar(?:y|ies)|christian(?:ity|s)?|muslims?|islam(?:ic)?|buddhis(?:m|t|ts)|hindu(?:ism|s)?)\b/u],
];
const commercialImmigrationTitle = /投资|投資|黄金签证|黃金簽證|购房|購房|技术移民|技術移民|雇主担保|雇主擔保|留学|留學|工签|工簽|排期|\b(?:eb[- ]?[15]|niw|golden visa|invest(?:or|ment)|skilled (?:worker|migration)|express entry|h[- ]?1b|student visa|study permit|visa bulletin)\b/u;

const greekMinistryHosts = new Set([
  "migration.gov.gr",
  "www.migration.gov.gr",
]);

function getHostname(value) {
  try {
    return new URL(String(value || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

function normalizeTopicText(value) {
  return normalizeSearchText(value)
    .replace(/immigration,?\s+refugees\s+and\s+citizenship\s+canada/g, "ircc")
    .replace(/(?:ministry|minister)\s+of\s+migration\s+and\s+asylum/g, "migration ministry")
    .replace(/(?:希腊|希臘)?移民[与與和]庇[护護]部/gu, "移民部");
}

export function isGreekMigrationMinistrySource(source) {
  return greekMinistryHosts.has(getHostname(source?.url));
}

export function normalizeSourceMetadata(source) {
  if (!isGreekMigrationMinistrySource(source)) {
    return { ...source };
  }

  return {
    ...source,
    name: GREEK_MINISTRY_SOURCE_NAME,
    country: "希腊",
  };
}

export function getOperationalArticleExclusionReason(item, source) {
  if (!isGreekMigrationMinistrySource(source)) {
    return "";
  }

  const articleUrl = normalizeSearchText(item?.url);
  const text = normalizeSearchText(`${item?.title || ""}\n${item?.summary || ""}`);

  const operationalSlug =
    /lista[-_/]ypotheseon[-_/]asyloy/.test(articleUrl)
    && /(taxidiotika[-_/]eggrafa|adeies[-_/]diamonis)/.test(articleUrl)
    && /etoim[^/?#]*[-_/]pros[-_/]paradosi/.test(articleUrl);

  const isAsylumCaseList =
    /λιστα\s+υποθεσεων\s+ασυλου/u.test(text)
    || /庇护案件(?:的)?(?:清单|列表)/u.test(text)
    || /list\s+of\s+asylum\s+cases/.test(text);
  const isPickupReady =
    /ετοιμ(?:α|ες)\s+προς\s+παραδοση/u.test(text)
    || /(?:可领取|已可领取|领取通知)/u.test(text)
    || /ready\s+(?:for\s+(?:delivery|collection|pickup)|to\s+be\s+delivered)/.test(text);
  const isCaseDocument =
    /(?:ταξιδιωτικα\s+εγγραφα|αδειες\s+διαμονης)/u.test(text)
    || /(?:旅行证件|旅行文件|居留许可|居留证件)/u.test(text)
    || /(?:travel\s+documents?|residence\s+permits?)/.test(text);

  return operationalSlug || (isAsylumCaseList && isPickupReady && isCaseDocument)
    ? OPERATIONAL_CASE_DOCUMENT_PICKUP_REASON
    : "";
}

/** 屏蔽业务范围外的难民、庇护和宗教主题，保留仅在摘要中顺带提及它们的商业移民政策。 */
export function getBusinessArticleExclusionReason(item) {
  const title = normalizeTopicText([item?.title, item?.originalTitle, item?.titleZh].filter(Boolean).join("\n"));
  const summary = normalizeTopicText([item?.summary, item?.originalSummary, item?.summaryZh].filter(Boolean).join("\n"));
  for (const [reason, pattern] of excludedTopics) {
    if (pattern.test(title) || (!commercialImmigrationTitle.test(title) && pattern.test(summary))) {
      return reason;
    }
  }
  return "";
}

/** 保留原始文章供追溯；统一排除标记同时控制热点、日报和市场素材的候选范围。 */
export function applyArticleContentPolicy(item, source) {
  const dailyExcludedReason = getOperationalArticleExclusionReason(item, source)
    || getBusinessArticleExclusionReason(item);
  if (!dailyExcludedReason) {
    return {
      item,
      dailyExcluded: false,
      dailyExcludedReason: null,
    };
  }

  const currentHeat = Number(item?.heat);
  return {
    item: {
      ...item,
      heat: Number.isFinite(currentHeat) ? Math.min(currentHeat, 55) : 55,
      impact: "低影响",
    },
    dailyExcluded: true,
    dailyExcludedReason,
  };
}
