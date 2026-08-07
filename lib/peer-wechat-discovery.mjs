const SHANGHAI_OFFSET = "+08:00";
const DAY_MS = 24 * 60 * 60 * 1000;

function cleanText(value) {
  return String(value ?? "").trim();
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function integer(value, fallback = 0) {
  return Math.trunc(finiteNumber(value, fallback));
}

function optionalFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function getPeerDiscoveryWindow(reportDate) {
  const date = cleanText(reportDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("date must use YYYY-MM-DD");
  }

  const windowEnd = new Date(`${date}T06:30:00${SHANGHAI_OFFSET}`);
  if (Number.isNaN(windowEnd.getTime())) {
    throw new Error("date is invalid");
  }
  const normalizedDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(windowEnd);
  if (normalizedDate !== date) {
    throw new Error("date is invalid");
  }

  const windowStart = new Date(windowEnd.getTime() - DAY_MS);
  return {
    reportDate: date,
    windowStart,
    windowEnd,
    windowStartIso: windowStart.toISOString(),
    windowEndIso: windowEnd.toISOString(),
  };
}

export function extractWerssFeedId(value) {
  const match = cleanText(value).match(/(?:^|\/)(MP_WXS_\d+)(?:\.rss)?(?:[?#]|$)/i);
  return match ? match[1].toUpperCase() : "";
}

export function canonicalizeWechatArticleUrl(value) {
  const raw = cleanText(value);
  if (!raw) return "";

  try {
    const url = new URL(raw);
    if (url.hostname.toLowerCase() !== "mp.weixin.qq.com") return raw;
    const canonical = new URL("https://mp.weixin.qq.com/s");
    for (const key of ["__biz", "mid", "idx", "sn"]) {
      const item = url.searchParams.get(key);
      if (item) canonical.searchParams.set(key, item);
    }
    return canonical.searchParams.size ? canonical.toString() : raw;
  } catch {
    return raw;
  }
}

export function getWechatArticleUrlIdentity(value) {
  const raw = cleanText(value);
  if (!raw) return { biz: "", appmsgid: "", position: 0 };
  try {
    const url = new URL(raw);
    return {
      biz: cleanText(url.searchParams.get("__biz")),
      appmsgid: cleanText(url.searchParams.get("mid")),
      position: integer(url.searchParams.get("idx"), 0),
    };
  } catch {
    return { biz: "", appmsgid: "", position: 0 };
  }
}

export function makeWerssArticleId(feedId, appmsgid, position) {
  const numericFeedId = cleanText(feedId).replace(/^MP_WXS_/i, "");
  const cleanAppmsgid = cleanText(appmsgid);
  const cleanPosition = integer(position, 0);
  if (!/^\d+$/.test(numericFeedId) || !/^\d+$/.test(cleanAppmsgid) || cleanPosition < 1) {
    return "";
  }
  return `${numericFeedId}-${cleanAppmsgid}_${cleanPosition}`;
}

function normalizeDajialaArticle(article) {
  const url = canonicalizeWechatArticleUrl(article?.url);
  const urlIdentity = getWechatArticleUrlIdentity(url);
  const appmsgid = cleanText(article?.appmsgid || article?.app_msg_id || urlIdentity.appmsgid);
  const position = integer(article?.position || article?.idx || urlIdentity.position, 0);
  const publishTime = integer(article?.post_time || article?.publish_time || article?.create_time, 0);
  return {
    position,
    url,
    publishTime,
    publishTimeText: cleanText(article?.post_time_str),
    coverUrl: cleanText(article?.cover_url || article?.pic_url),
    original: integer(article?.original, 0),
    itemShowType: integer(article?.item_show_type || article?.show_type, 0),
    digest: cleanText(article?.digest || article?.description),
    title: cleanText(article?.title),
    appmsgid,
    updateTime: integer(article?.update_time, publishTime),
    sourceUrl: cleanText(article?.source_url),
    read: integer(article?.read, 0),
    zan: integer(article?.zan, 0),
  };
}

export function normalizeDajialaResponse(payload) {
  const body = payload && typeof payload === "object" ? payload : {};
  const nestedData = body.data && !Array.isArray(body.data) ? body.data : {};
  const nestedMessage = nestedData.MsgList || nestedData.msg_list || {};
  const articles = Array.isArray(body.data)
    ? body.data
    : Array.isArray(nestedMessage.Msg)
      ? nestedMessage.Msg
      : Array.isArray(nestedMessage.msg)
        ? nestedMessage.msg
        : Array.isArray(nestedData.list)
          ? nestedData.list
          : [];
  const paging = nestedData.PagingInfo || nestedData.paging_info || {};

  return {
    code: integer(body.code, -1),
    message: cleanText(body.msg || body.error_msg || nestedData.msg),
    errorMessage: cleanText(body.error_msg || nestedData.error_msg),
    costMoney: finiteNumber(body.cost_money ?? body.cost ?? nestedData.cost_money ?? nestedData.cost, 0),
    remainMoney: optionalFiniteNumber(body.remain_money ?? nestedData.remain_money),
    offset: cleanText(body.offset ?? nestedData.offset ?? paging.Offset ?? paging.offset),
    isEnd: integer(body.is_end ?? nestedData.is_end ?? paging.IsEnd ?? paging.is_end, 0) === 1,
    nickname: cleanText(body.nickname || nestedData.nickname),
    ghid: cleanText(body.ghid || nestedData.ghid),
    articles: articles.map(normalizeDajialaArticle),
  };
}

export function buildWerssArticleRecord(feedId, article, nowSeconds = Math.floor(Date.now() / 1000)) {
  const normalized = normalizeDajialaArticle(article);
  const id = makeWerssArticleId(feedId, normalized.appmsgid, normalized.position);
  if (!id || !normalized.url || !normalized.title || normalized.publishTime <= 0) return null;
  const updatedAt = normalized.updateTime > 0 ? normalized.updateTime : nowSeconds;
  return {
    id,
    mpId: cleanText(feedId),
    title: normalized.title.slice(0, 1000),
    picUrl: normalized.coverUrl.slice(0, 500),
    url: normalized.url.slice(0, 500),
    description: normalized.digest,
    publishTime: normalized.publishTime,
    createTime: normalized.publishTime,
    updatedAt,
    updatedAtMillis: updatedAt * 1000,
    itemShowType: normalized.itemShowType,
    publishInfo: {
      appmsgid: normalized.appmsgid,
      position: normalized.position,
      original: normalized.original,
      sourceUrl: normalized.sourceUrl,
      read: normalized.read,
      zan: normalized.zan,
    },
  };
}
