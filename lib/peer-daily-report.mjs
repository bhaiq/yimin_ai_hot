import { createHash } from "node:crypto";

export const PEER_DAILY_PROMPT_VERSION = "peer-daily-v3-ingestion-window";
export const PEER_SOURCE_ANALYSIS_PROMPT_VERSION = "peer-source-analysis-v2-wechat-only";

export const PEER_ACTION_CATEGORIES = Object.freeze([
  "项目推广",
  "政策解读",
  "客户案例",
  "活动获客",
  "服务或产品",
  "品牌动态",
  "合作与渠道",
  "常规科普",
  "其他",
]);

const categorySet = new Set(PEER_ACTION_CATEGORIES);

function assertReportDate(reportDate) {
  const value = String(reportDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("日报日期必须使用 YYYY-MM-DD 格式");
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new Error("日报日期无效");
  }
  return { value, parsed };
}

export function getPeerDailyWindow(reportDate) {
  const { value, parsed } = assertReportDate(reportDate);
  const previous = new Date(parsed.getTime() - 24 * 60 * 60 * 1000);
  const previousDate = previous.toISOString().slice(0, 10);
  return {
    reportDate: value,
    windowStartAt: `${previousDate}T06:30:00+08:00`,
    windowEndAt: `${value}T06:30:00+08:00`,
    windowLabel: `${previousDate} 06:30 至 ${value} 06:30`,
  };
}

export function getPeerDailyIngestionWindow(reportDate) {
  const window = getPeerDailyWindow(reportDate);
  return {
    ...window,
    windowBasis: "first_fetched_at",
    windowLabel: `采集入库窗口：${window.windowLabel}`,
  };
}

function cleanText(value, maxLength = 2_000) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanMarkdownText(value, maxLength = 2_000) {
  return cleanText(value, maxLength)
    .replace(/[\[\]_*`#<>]/g, "")
    .trim();
}

function uniqueStrings(values, maxItems = 20, maxLength = 500) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => cleanText(value, maxLength))
      .filter(Boolean),
  )].slice(0, maxItems);
}

function inferCategory(source) {
  const text = `${source.title || ""} ${source.summary || ""} ${source.content || ""}`;
  if (/讲座|直播|说明会|沙龙|报名|预约|开放日|活动|峰会|展会/.test(text)) return "活动获客";
  if (/成功案例|获批|客户案例|案例分享|登陆|拿到身份/.test(text)) return "客户案例";
  if (/合作|签约|战略伙伴|渠道|联盟/.test(text)) return "合作与渠道";
  if (/新服务|产品发布|服务升级|解决方案|会员|工具/.test(text)) return "服务或产品";
  if (/品牌|周年|荣誉|获奖|采访|媒体/.test(text)) return "品牌动态";
  if (/政策|法案|新规|签证|移民局|税务|配额|排期|审理/.test(text)) return "政策解读";
  if (/项目|投资|移民|永居|身份|护照|居留/.test(text)) return "项目推广";
  if (/科普|解读|问答|指南|知识|注意事项/.test(text)) return "常规科普";
  return "其他";
}

function inferImportance(source, category) {
  const text = `${source.title || ""} ${source.summary || ""} ${source.content || ""}`;
  if (["客户案例", "活动获客", "服务或产品", "合作与渠道"].includes(category)) return "important";
  if (/重磅|首发|全新|正式上线|发布|启动|签约|成功获批|限时|名额|招募/.test(text)) return "important";
  return "normal";
}

function topicKeyFromSource(source) {
  const text = cleanText(`${source.country || ""} ${source.title || source.projectName || ""}`, 160)
    .toLowerCase()
    .replace(/[\s·｜|—_\-:：，。！？、（）()【】\[\]]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return text.slice(0, 80) || source.sourceRef;
}

export function createFallbackSourceAnalysis(source) {
  const category = inferCategory(source);
  const importance = inferImportance(source, category);
  const rawSummary = `${source.competitorName}发布《${source.title || "未命名文章"}》：${source.summary || cleanText(source.content, 180) || "正文主要围绕标题所示主题展开。"}`;
  return {
    sourceRef: source.sourceRef,
    competitorName: source.competitorName,
    category,
    importance,
    actionTitle: cleanText(source.title || "公开动态", 180),
    actionSummary: cleanText(rawSummary, 500),
    evidencePoints: uniqueStrings(
      [source.summary || cleanText(source.content, 240)],
      5,
      300,
    ),
    lightAnalysis: "",
    topicKey: topicKeyFromSource(source),
    isActionablePeerMove: true,
  };
}

export function buildPeerSourceAnalysisPrompt(sources) {
  const input = (sources || [])
    .filter((source) => source.sourceType === "wechat_article")
    .map((source) => ({
    source_ref: source.sourceRef,
    source_type: source.sourceType,
    competitor_name: source.competitorName,
    title: source.title || "",
    summary: source.summary || "",
    content: cleanText(source.content, 12_000),
    occurred_at: source.occurredAt || "",
  }));
  return `请从下列同行公众号文章中逐条抽取“同行动作”。只能依据输入，不核验政策或宣传真假，不提出我方建议。\n\n动作分类只允许：${PEER_ACTION_CATEGORIES.join("、")}。\n重要度只允许 important 或 normal。\n\n输出严格 JSON：\n{"analyses":[{"source_ref":"原值","category":"允许分类","importance":"important|normal","action_title":"简短标题","action_summary":"归因式事实摘要","evidence_points":["输入可支持的证据"],"light_analysis":"有依据才填写，否则空字符串","topic_key":"稳定简短主题键","is_actionable_peer_move":true}]}\n\n输入：\n${JSON.stringify(input)}`;
}

export const PEER_DAILY_SYSTEM_PROMPT = `你是集团内部的同行情报日报编辑。读者是老板、市场部和项目部。

你的任务是根据已完成单条抽取的同行公众号文章，保守汇总观察窗口内可见的同行动作，并在多家同行关注同一主题时比较具体差异。

硬性规则：
1. 只能使用输入，不补充外部知识，不虚构事实、数字、意图、客户或结果。
2. 不核验政策或宣传真假；使用“该同行发布、称、主推、从发布内容看”等归因表达。
3. 不输出我方策略、应对、销售建议或项目推荐。
4. 轻度分析必须有输入依据，不能把推测写成事实。
5. 必须使用输入中的真实同行名称。
6. 重要动作进入正文；常规科普、节日问候和弱动作进入附录。
7. 共同主题必须至少包含两家同行，并比较项目、对象、门槛金额、活动形式、服务包装、内容角度或行动号召中的具体差异。
8. 每个 source_ref 只能出现一次，优先级：共同主题、重点动作、其他重要更新、普通附录。
9. 不生成老板速览、结尾建议或状态图例。
10. 只输出严格 JSON，不输出 Markdown、链接、解释或代码围栏。`;

export function buildPeerDailyAggregatePrompt({ reportDate, window, analyses }) {
  return `请汇总以下结构化同行动作。\n\n报告日期：${reportDate}\n观察窗口：${window.windowLabel}\n输入：${JSON.stringify(analyses)}\n\n输出 Schema：\n{"shared_topics":[{"topic_key":"键","topic_title":"主题","competitor_names":["至少2家"],"common_action":"共同点","differences":[{"competitor_name":"真实名称","difference":"具体差异","source_refs":["source_ref"]}],"light_analysis":"可空","source_refs":["本主题全部来源"]}],"key_actions":[{"competitor_name":"真实名称","category":"允许分类","action_title":"标题","action_summary":"事实摘要","evidence_points":["证据"],"light_analysis":"可空","source_refs":["source_ref"]}],"other_important_updates":[{"competitor_name":"真实名称","category":"允许分类","summary":"简洁更新","source_refs":["source_ref"]}],"appendix":[{"competitor_name":"真实名称","category":"允许分类","summary":"一句话普通动态","source_refs":["source_ref"]}],"warnings":[]}\n\n再次检查：共同主题至少2家；每个 source_ref 只出现一次；不输出建议、链接、不存在的名称或来源；附录保持简短。`;
}

function normalizeRefs(value, sourceMap) {
  return uniqueStrings(value, 50, 100).filter((ref) => sourceMap.has(ref));
}

function assertExclusiveRefs(refs, seen) {
  for (const ref of refs) {
    if (seen.has(ref)) throw new Error(`模型重复使用来源 ${ref}`);
    seen.add(ref);
  }
}

function assertSingleCompetitor(item, refs, sourceMap) {
  const names = [...new Set(refs.map((ref) => sourceMap.get(ref)?.competitorName).filter(Boolean))];
  if (names.length !== 1) throw new Error("单同行动作引用了多家同行的来源");
  const requested = cleanText(item.competitor_name || item.competitorName, 200);
  if (requested && requested !== names[0]) throw new Error("模型返回的同行名称与来源不匹配");
  return names[0];
}

function normalizedCategory(value, fallback = "其他") {
  const category = cleanText(value, 40);
  return categorySet.has(category) ? category : fallback;
}

export function validatePeerDailyAggregate(payload, sources, analyses) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("同行日报模型输出不是 JSON 对象");
  }
  const sourceMap = new Map((sources || []).map((source) => [source.sourceRef, source]));
  const analysisMap = new Map((analyses || []).map((item) => [item.sourceRef, item]));
  const seen = new Set();

  const sharedTopics = (Array.isArray(payload.shared_topics) ? payload.shared_topics : []).map((item) => {
    const refs = normalizeRefs(item.source_refs || item.sourceRefs, sourceMap);
    if (!refs.length) throw new Error("共同主题缺少有效来源");
    assertExclusiveRefs(refs, seen);
    const names = [...new Set(refs.map((ref) => sourceMap.get(ref).competitorName))];
    if (names.length < 2) throw new Error("共同主题不足两家同行");
    const differences = (Array.isArray(item.differences) ? item.differences : []).map((difference) => {
      const differenceRefs = normalizeRefs(difference.source_refs || difference.sourceRefs, sourceMap)
        .filter((ref) => refs.includes(ref));
      const competitorName = cleanText(difference.competitor_name || difference.competitorName, 200);
      if (!names.includes(competitorName)) return null;
      if (differenceRefs.some((ref) => sourceMap.get(ref).competitorName !== competitorName)) {
        throw new Error("共同主题差异的同行名称与来源不匹配");
      }
      return {
        competitorName,
        difference: cleanText(difference.difference, 500),
        sourceRefs: differenceRefs,
      };
    }).filter((item) => item?.difference);
    return {
      topicKey: cleanText(item.topic_key || item.topicKey, 100) || refs.join("+"),
      topicTitle: cleanText(item.topic_title || item.topicTitle, 200) || "共同关注",
      competitorNames: names,
      commonAction: cleanText(item.common_action || item.commonAction, 600),
      differences,
      lightAnalysis: cleanText(item.light_analysis || item.lightAnalysis, 500),
      sourceRefs: refs,
    };
  });

  const normalizeSingleItems = (items, section) => (Array.isArray(items) ? items : []).map((item) => {
    const refs = normalizeRefs(item.source_refs || item.sourceRefs, sourceMap);
    if (!refs.length) throw new Error(`${section}缺少有效来源`);
    assertExclusiveRefs(refs, seen);
    const competitorName = assertSingleCompetitor(item, refs, sourceMap);
    const fallbackAnalysis = analysisMap.get(refs[0]) || createFallbackSourceAnalysis(sourceMap.get(refs[0]));
    return {
      competitorName,
      category: normalizedCategory(item.category, fallbackAnalysis.category),
      actionTitle: cleanText(item.action_title || item.actionTitle, 200) || fallbackAnalysis.actionTitle,
      actionSummary: cleanText(item.action_summary || item.actionSummary || item.summary, 700) || fallbackAnalysis.actionSummary,
      evidencePoints: uniqueStrings(item.evidence_points || item.evidencePoints, 6, 400),
      lightAnalysis: cleanText(item.light_analysis || item.lightAnalysis, 500),
      sourceRefs: refs,
    };
  });

  const keyActions = normalizeSingleItems(payload.key_actions, "重点动作");
  const otherImportantUpdates = normalizeSingleItems(payload.other_important_updates, "其他重要更新");
  const appendix = normalizeSingleItems(payload.appendix, "普通附录");

  for (const source of sources || []) {
    if (seen.has(source.sourceRef)) continue;
    const analysis = analysisMap.get(source.sourceRef) || createFallbackSourceAnalysis(source);
    appendix.push({
      competitorName: source.competitorName,
      category: normalizedCategory(analysis.category),
      actionTitle: analysis.actionTitle,
      actionSummary: analysis.actionSummary,
      evidencePoints: analysis.evidencePoints || [],
      lightAnalysis: "",
      sourceRefs: [source.sourceRef],
    });
    seen.add(source.sourceRef);
  }

  return {
    sharedTopics,
    keyActions,
    otherImportantUpdates,
    appendix,
    warnings: uniqueStrings(payload.warnings, 10, 500),
  };
}

export function buildFallbackPeerDailyAggregate(sources, analyses) {
  const analysisMap = new Map((analyses || []).map((item) => [item.sourceRef, item]));
  return {
    sharedTopics: [],
    keyActions: [],
    otherImportantUpdates: [],
    appendix: (sources || []).map((source) => {
      const analysis = analysisMap.get(source.sourceRef) || createFallbackSourceAnalysis(source);
      return {
        competitorName: source.competitorName,
        category: normalizedCategory(analysis.category),
        actionTitle: analysis.actionTitle,
        actionSummary: analysis.actionSummary,
        evidencePoints: analysis.evidencePoints || [],
        lightAnalysis: "",
        sourceRefs: [source.sourceRef],
      };
    }),
    warnings: [],
  };
}

function sourceLinks(refs, sourceMap) {
  return (refs || []).map((ref) => {
    const source = sourceMap.get(ref);
    if (!source) return "";
    const label = cleanMarkdownText(source.title || source.projectName || "来源", 180) || "来源";
    const url = String(source.url || "").trim();
    return /^https?:\/\//i.test(url) ? `[${label}](${url})` : label;
  }).filter(Boolean).join("；");
}

function renderEmptyList(lines, items, renderItem) {
  if (!items.length) {
    lines.push("今日暂无。", "");
    return;
  }
  items.forEach((item, index) => renderItem(item, index));
  lines.push("");
}

function formatChineseReportDate(reportDate) {
  const [year, month, day] = String(reportDate).split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}

export function renderPeerDailyReport({ reportDate, window, aggregate, sources, noUpdateNames, warnings }) {
  const sourceMap = new Map((sources || []).map((source) => [source.sourceRef, source]));
  const lines = [
    `# 同行日报｜${formatChineseReportDate(reportDate)}`,
    "",
    `数据范围：${window.windowLabel}`,
    "",
    `今日无更新同行：${noUpdateNames.length ? noUpdateNames.join("、") : "无"}。`,
    "",
  ];
  const allWarnings = uniqueStrings([...(warnings || []), ...(aggregate.warnings || [])], 12, 500);
  if (allWarnings.length) {
    lines.push(`> 数据完整性提示：${allWarnings.join("；")}`, "");
  }

  lines.push("## 一、重点动作", "");
  renderEmptyList(lines, aggregate.keyActions, (item) => {
    lines.push(`### ${cleanMarkdownText(item.competitorName)}｜${cleanMarkdownText(item.actionTitle)}`);
    lines.push("", `- 动作：${cleanMarkdownText(item.actionSummary, 700)}`);
    if (item.evidencePoints?.length) lines.push(`- 核心信息：${item.evidencePoints.map((point) => cleanMarkdownText(point, 400)).join("；")}`);
    if (item.lightAnalysis) lines.push(`- 轻度判断：${cleanMarkdownText(item.lightAnalysis, 500)}`);
    const links = sourceLinks(item.sourceRefs, sourceMap);
    if (links) lines.push(`- 来源：${links}`);
    lines.push("");
  });

  lines.push("## 二、多家同行共同关注", "");
  renderEmptyList(lines, aggregate.sharedTopics, (item) => {
    lines.push(`### ${cleanMarkdownText(item.topicTitle)}`, "");
    lines.push(`- 共同动作：${cleanMarkdownText(item.commonAction, 700)}`);
    if (item.differences?.length) {
      lines.push(`- 差异：${item.differences.map((difference) => `${cleanMarkdownText(difference.competitorName)}：${cleanMarkdownText(difference.difference, 500)}`).join("；")}`);
    }
    if (item.lightAnalysis) lines.push(`- 轻度判断：${cleanMarkdownText(item.lightAnalysis, 500)}`);
    const links = sourceLinks(item.sourceRefs, sourceMap);
    if (links) lines.push(`- 来源：${links}`);
    lines.push("");
  });

  lines.push("## 三、各同行其他重要更新", "");
  renderEmptyList(lines, aggregate.otherImportantUpdates, (item) => {
    const links = sourceLinks(item.sourceRefs, sourceMap);
    lines.push(`- **${cleanMarkdownText(item.competitorName)}｜${cleanMarkdownText(item.category)}**：${cleanMarkdownText(item.actionSummary, 700)}${links ? ` 来源：${links}` : ""}`);
  });

  lines.push("## 四、普通动态附录", "");
  renderEmptyList(lines, aggregate.appendix, (item) => {
    const firstSource = sourceMap.get(item.sourceRefs[0]);
    const link = /^https?:\/\//i.test(firstSource?.url || "") ? ` [原文](${firstSource.url})` : "";
    lines.push(`- **${cleanMarkdownText(item.competitorName)}｜${cleanMarkdownText(item.category)}**：${cleanMarkdownText(item.actionSummary, 450)}${link}`);
  });

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function renderPeerDailyMdBrief({ reportDate, window, aggregate, noUpdateNames, internalUrl }) {
  const [, month, day] = String(reportDate).split("-");
  const lines = [
    `## 同行日报｜${Number(month)}月${Number(day)}日`,
    `> 数据范围：${window.windowLabel}`,
    `> 今日无更新：${noUpdateNames.length ? noUpdateNames.join("、") : "无"}`,
    "",
    "**重点动作**",
  ];
  if (!aggregate.keyActions.length) {
    lines.push("今日未发现重要同行动作。普通动态已收录在完整报告。" );
  } else {
    const keyActions = aggregate.keyActions.slice(0, 5);
    const perActionLength = Math.max(90, Math.floor(420 / keyActions.length));
    keyActions.forEach((item, index) => {
      lines.push(`${index + 1}. **${cleanMarkdownText(item.competitorName)}**：${cleanMarkdownText(item.actionSummary, perActionLength)}`);
    });
  }
  if (aggregate.sharedTopics.length) {
    lines.push("", "**共同关注**");
    const sharedTopics = aggregate.sharedTopics.slice(0, 2);
    const perTopicLength = Math.max(150, Math.floor(360 / sharedTopics.length));
    sharedTopics.forEach((item) => {
      const differences = item.differences
        .slice(0, 3)
        .map((difference) => {
          const competitorName = cleanMarkdownText(difference.competitorName);
          let detail = cleanMarkdownText(difference.difference, 100);
          if (detail.startsWith(competitorName)) detail = detail.slice(competitorName.length).trim();
          return `${competitorName}侧重${detail}`;
        })
        .join("；");
      const commonAction = cleanMarkdownText(item.commonAction, 100);
      lines.push(`- **${cleanMarkdownText(item.topicTitle)}**：${cleanMarkdownText(`${commonAction}${differences ? `；${differences}` : ""}`, perTopicLength)}`);
    });
  }
  const linkLine = internalUrl ? `[查看完整报告](${internalUrl})` : "";
  const maxLength = 1_000;
  let body = lines.join("\n");
  const reservedLength = linkLine ? linkLine.length + 2 : 0;
  while (body.length + reservedLength > maxLength) {
    const candidateIndexes = lines
      .map((line, index) => ({ index, length: line.length }))
      .filter((item) => item.length > 90 && !/^##|^\*\*[^*]+\*\*$|^>/.test(lines[item.index]));
    if (!candidateIndexes.length) {
      body = `${body.slice(0, Math.max(0, maxLength - reservedLength - 1)).trimEnd()}…`;
      break;
    }
    candidateIndexes.sort((left, right) => right.length - left.length);
    const index = candidateIndexes[0].index;
    const overflow = body.length + reservedLength - maxLength;
    lines[index] = `${lines[index].slice(0, Math.max(80, lines[index].length - overflow - 1)).trimEnd()}…`;
    body = lines.join("\n");
  }
  return linkLine ? `${body}\n\n${linkLine}` : body;
}

export function buildPeerDailyReportItems(aggregate, sources) {
  const sourceMap = new Map((sources || []).map((source) => [source.sourceRef, source]));
  const items = [];
  let sortOrder = 0;
  const append = (section, record) => {
    for (const sourceRef of record.sourceRefs || []) {
      const source = sourceMap.get(sourceRef);
      if (!source) continue;
      items.push({
        sourceRef,
        sourceType: source.sourceType,
        peerArticleId: source.sourceType === "wechat_article" ? source.id : null,
        websiteEventId: null,
        section,
        category: record.category || (section === "shared_topic" ? "其他" : "其他"),
        importance: section === "appendix" ? "normal" : "important",
        topicKey: record.topicKey || "",
        sortOrder: sortOrder++,
        snapshot: { source, reportItem: record },
      });
    }
  };
  aggregate.sharedTopics.forEach((item) => append("shared_topic", item));
  aggregate.keyActions.forEach((item) => append("key_action", item));
  aggregate.otherImportantUpdates.forEach((item) => append("other_important", item));
  aggregate.appendix.forEach((item) => append("appendix", item));
  return items;
}

export function hashPeerDailyInput(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
