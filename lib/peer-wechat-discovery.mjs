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

export function resolveDajialaLookup({ lookupMode = "auto", ghid = "", nickname = "", articleUrl = "" } = {}) {
  const mode = cleanText(lookupMode).toLowerCase() || "auto";
  const cleanGhid = cleanText(ghid);
  const cleanNickname = cleanText(nickname);
  const cleanArticleUrl = cleanText(articleUrl);
  if (!["auto", "ghid", "url", "nickname"].includes(mode)) {
    throw new Error(`unsupported lookup mode: ${mode}`);
  }

  const resolvedMode = mode === "auto"
    ? cleanGhid
      ? "ghid"
      : cleanArticleUrl
        ? "url"
        : cleanNickname
          ? "nickname"
          : ""
    : mode;
  const value = resolvedMode === "ghid"
    ? cleanGhid
    : resolvedMode === "url"
      ? cleanArticleUrl
      : resolvedMode === "nickname"
        ? cleanNickname
        : "";
  if (!resolvedMode || !value) {
    const label = mode === "auto" ? "ghid、文章 URL 或公众号名称" : mode;
    throw new Error(`lookup mode ${mode} requires ${label}`);
  }
  return {
    mode: resolvedMode,
    ghid: resolvedMode === "ghid" ? cleanGhid : "",
    articleUrl: resolvedMode === "url" ? cleanArticleUrl : "",
    nickname: resolvedMode === "nickname" ? cleanNickname : "",
  };
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
  const appmsgid = cleanText(article?.appmsgid ?? article?.app_msg_id ?? urlIdentity.appmsgid);
  const position = integer(article?.position ?? article?.idx ?? urlIdentity.position, 0);
  const publishTime = integer(
    article?.publishTime ?? article?.post_time ?? article?.publish_time ?? article?.create_time,
    0,
  );
  return {
    position,
    url,
    publishTime,
    publishTimeText: cleanText(article?.publishTimeText ?? article?.post_time_str),
    coverUrl: cleanText(article?.coverUrl ?? article?.cover_url ?? article?.pic_url),
    original: integer(article?.original, 0),
    itemShowType: integer(article?.itemShowType ?? article?.item_show_type ?? article?.show_type, 0),
    digest: cleanText(article?.digest ?? article?.description),
    title: cleanText(article?.title),
    appmsgid,
    updateTime: integer(article?.updateTime ?? article?.update_time, publishTime),
    sourceUrl: cleanText(article?.sourceUrl ?? article?.source_url),
    read: integer(article?.read, 0),
    zan: integer(article?.zan, 0),
  };
}

function flattenNativeDajialaMessage(message) {
  const messageBase = message?.BaseInfo || message?.base_info || {};
  const appMessage = message?.AppMsg || message?.app_msg || {};
  const appBase = appMessage?.BaseInfo || appMessage?.base_info || {};
  const details = Array.isArray(appMessage?.DetailInfo)
    ? appMessage.DetailInfo
    : Array.isArray(appMessage?.detail_info)
      ? appMessage.detail_info
      : [];
  const appmsgid = appBase.AppMsgId ?? appBase.app_msg_id ?? messageBase.MsgId ?? messageBase.msg_id;
  const publishTime = messageBase.DateTime
    ?? messageBase.date_time
    ?? appBase.CreateTime
    ?? appBase.create_time;
  const updateTime = appBase.UpdateTime ?? appBase.update_time ?? publishTime;

  return details.map((detail, index) => ({
    position: detail?.ItemIndex ?? detail?.item_index ?? index + 1,
    url: detail?.ContentUrl ?? detail?.content_url ?? "",
    post_time: detail?.send_time ?? detail?.SendTime ?? publishTime,
    cover_url: detail?.CoverImgUrl ?? detail?.cover_img_url ?? detail?.CoverImgUrl_235_1 ?? "",
    original: detail?.IsOriginal ?? detail?.is_original ?? 0,
    item_show_type: detail?.ItemShowType ?? detail?.item_show_type ?? appBase.Type ?? 0,
    digest: detail?.Digest ?? detail?.digest ?? "",
    title: detail?.Title ?? detail?.title ?? "",
    appmsgid,
    update_time: updateTime,
    source_url: detail?.SourceUrl ?? detail?.source_url ?? "",
    read: detail?.Read ?? detail?.read ?? 0,
    zan: detail?.Zan ?? detail?.zan ?? 0,
  }));
}

function flattenDajialaArticles(records) {
  return records.flatMap((record) => {
    const nativeArticles = flattenNativeDajialaMessage(record);
    return nativeArticles.length ? nativeArticles : [record];
  });
}

export function normalizeDajialaResponse(payload) {
  const body = payload && typeof payload === "object" ? payload : {};
  const nestedData = body.data && !Array.isArray(body.data) ? body.data : {};
  const rootMessage = body.MsgList || body.msg_list || {};
  const nestedMessage = nestedData.MsgList || nestedData.msg_list || {};
  const rawArticles = Array.isArray(body.data)
    ? body.data
    : Array.isArray(rootMessage.Msg)
      ? rootMessage.Msg
      : Array.isArray(rootMessage.msg)
        ? rootMessage.msg
        : Array.isArray(nestedMessage.Msg)
      ? nestedMessage.Msg
      : Array.isArray(nestedMessage.msg)
        ? nestedMessage.msg
        : Array.isArray(nestedData.list)
          ? nestedData.list
          : [];
  const articles = flattenDajialaArticles(rawArticles);
  const paging = body.PagingInfo
    || body.paging_info
    || rootMessage.PagingInfo
    || rootMessage.paging_info
    || nestedData.PagingInfo
    || nestedData.paging_info
    || {};
  const account = body.AccountInfo || body.account_info || nestedData.AccountInfo || nestedData.account_info || {};

  return {
    code: integer(body.code, -1),
    message: cleanText(body.msg || body.error_msg || nestedData.msg),
    errorMessage: cleanText(body.error_msg || nestedData.error_msg),
    costMoney: finiteNumber(body.cost_money ?? body.cost ?? nestedData.cost_money ?? nestedData.cost, 0),
    remainMoney: optionalFiniteNumber(body.remain_money ?? nestedData.remain_money),
    offset: cleanText(body.offset ?? nestedData.offset ?? paging.Offset ?? paging.offset),
    isEnd: integer(body.is_end ?? nestedData.is_end ?? paging.IsEnd ?? paging.is_end, 0) === 1,
    nickname: cleanText(body.nickname || nestedData.nickname || account.NickName || account.nickname),
    ghid: cleanText(body.ghid || nestedData.ghid || account.UserName || account.user_name),
    articles: articles.map(normalizeDajialaArticle),
  };
}

function extractHtmlElementInnerById(html, elementId) {
  const source = String(html || "");
  const escapedId = String(elementId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const openingPattern = new RegExp(
    `<([a-z][\\w:-]*)\\b(?=[^>]*\\bid\\s*=\\s*["']${escapedId}["'])[^>]*>`,
    "i",
  );
  const opening = openingPattern.exec(source);
  if (!opening) return "";

  const tagName = opening[1];
  const tokenPattern = new RegExp(`</?${tagName}\\b[^>]*>`, "gi");
  tokenPattern.lastIndex = opening.index + opening[0].length;
  let depth = 1;
  let token;
  while ((token = tokenPattern.exec(source))) {
    const value = token[0];
    if (new RegExp(`^</${tagName}\\b`, "i").test(value)) {
      depth -= 1;
      if (depth === 0) {
        return source.slice(opening.index + opening[0].length, token.index);
      }
    } else if (!/\/\s*>$/.test(value)) {
      depth += 1;
    }
  }
  return "";
}

function getHtmlAttribute(tag, name) {
  const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(tag).match(new RegExp(`\\s${escapedName}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match ? match[2].trim() : "";
}

function setHtmlAttribute(tag, name, value) {
  const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const safeValue = String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const pattern = new RegExp(`\\s${escapedName}\\s*=\\s*(["']).*?\\1`, "i");
  if (pattern.test(tag)) return tag.replace(pattern, ` ${name}="${safeValue}"`);
  return tag.replace(/\s*\/?>$/, (ending) => ` ${name}="${safeValue}"${ending}`);
}

function normalizeWechatImageTag(tag) {
  const lazySource = getHtmlAttribute(tag, "data-src")
    || getHtmlAttribute(tag, "data-original")
    || getHtmlAttribute(tag, "data-backsrc");
  let normalized = tag;
  if (lazySource) normalized = setHtmlAttribute(normalized, "src", lazySource);
  normalized = setHtmlAttribute(normalized, "referrerpolicy", "no-referrer");
  normalized = setHtmlAttribute(normalized, "loading", "lazy");
  return normalized;
}

export function normalizeWechatArticleContentHtml(value) {
  const fullHtml = cleanText(value);
  if (!fullHtml) return "";
  const bodyMatch = fullHtml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const content = extractHtmlElementInnerById(fullHtml, "js_content")
    || bodyMatch?.[1]
    || fullHtml;
  return content
    .replace(/<!--([\s\S]*?)-->/g, "")
    .replace(/<(script|noscript|iframe|object|embed|form)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<img\b[^>]*>/gi, normalizeWechatImageTag)
    .trim();
}

export function getWechatArticleContentText(value) {
  return String(value || "")
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|h[1-6]|li|blockquote|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeDajialaArticleHtmlResponse(payload) {
  const body = payload && typeof payload === "object" ? payload : {};
  const data = body.data && typeof body.data === "object" && !Array.isArray(body.data)
    ? body.data
    : {};
  const rawHtml = cleanText(data.html);
  const contentHtml = normalizeWechatArticleContentHtml(rawHtml);
  return {
    code: integer(body.code, -1),
    message: cleanText(body.msk || body.msg || body.error_msg),
    costMoney: finiteNumber(body.cost_money ?? body.cost, 0),
    remainMoney: optionalFiniteNumber(body.remain_money),
    title: cleanText(data.title),
    biz: cleanText(data.biz),
    articleUrl: canonicalizeWechatArticleUrl(data.article_url),
    accountHeadImageUrl: cleanText(data.mp_head_img),
    coverUrl: cleanText(data.cover_url),
    nickname: cleanText(data.nickname),
    publishTime: integer(data.post_time, 0),
    publishTimeText: cleanText(data.post_time_str),
    ghid: cleanText(data.gh_id),
    wxid: cleanText(data.wxid),
    signature: cleanText(data.signature),
    author: cleanText(data.author),
    description: cleanText(data.desc),
    copyright: integer(data.copyright, 0),
    ipWording: cleanText(data.ip_wording),
    contentHtml,
    contentText: getWechatArticleContentText(contentHtml),
  };
}

export function shouldRetryDajialaArticleHtmlResult({ code = -1, httpStatus = 0 } = {}) {
  return Number(code) === 107 || Number(httpStatus) >= 500;
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
