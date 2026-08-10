import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFallbackPeerDailyAggregate,
  createFallbackSourceAnalysis,
  getPeerDailyWindow,
  renderPeerDailyMdBrief,
  renderPeerDailyReport,
  validatePeerDailyAggregate,
} from "../lib/peer-daily-report.mjs";

const sources = [
  {
    id: 11,
    sourceRef: "wechat:11",
    sourceType: "wechat_article",
    competitorName: "甲移民",
    title: "美国项目说明会开放报名",
    summary: "面向家庭客户举办线上说明会。",
    content: "发布线上说明会的报名方式与时间。",
    url: "https://example.com/a",
    occurredAt: "2026-08-09T09:00:00+08:00",
  },
  {
    id: 22,
    sourceRef: "website:22",
    sourceType: "website_event",
    competitorName: "乙移民",
    projectName: "美国投资项目",
    title: "美国投资项目官网变化",
    eventType: "changed",
    changedFields: ["investment_amount"],
    url: "https://example.com/b",
    occurredAt: "2026-08-09T10:00:00+08:00",
  },
];

test("固定生成前一日 06:30 到报告日 06:30 的窗口", () => {
  assert.deepEqual(getPeerDailyWindow("2026-08-10"), {
    reportDate: "2026-08-10",
    windowStartAt: "2026-08-09T06:30:00+08:00",
    windowEndAt: "2026-08-10T06:30:00+08:00",
    windowLabel: "2026-08-09 06:30 至 2026-08-10 06:30",
  });
  assert.equal(getPeerDailyWindow("2024-03-01").windowStartAt, "2024-02-29T06:30:00+08:00");
  assert.throws(() => getPeerDailyWindow("2026-02-30"), /日期无效/);
});

test("校验汇总来源唯一并把模型遗漏来源放入附录", () => {
  const analyses = sources.map(createFallbackSourceAnalysis);
  const result = validatePeerDailyAggregate({
    shared_topics: [],
    key_actions: [{
      competitor_name: "甲移民",
      category: "活动获客",
      action_title: "线上说明会",
      action_summary: "甲移民发布线上说明会报名信息。",
      evidence_points: ["公布报名方式"],
      light_analysis: "",
      source_refs: ["wechat:11"],
    }],
    other_important_updates: [],
    appendix: [],
    warnings: [],
  }, sources, analyses);

  assert.equal(result.keyActions.length, 1);
  assert.equal(result.appendix.length, 1);
  assert.deepEqual(result.appendix[0].sourceRefs, ["website:22"]);
});

test("拒绝重复来源和只有一家同行的共同主题", () => {
  const analyses = sources.map(createFallbackSourceAnalysis);
  assert.throws(() => validatePeerDailyAggregate({
    shared_topics: [],
    key_actions: [
      { competitor_name: "甲移民", source_refs: ["wechat:11"] },
      { competitor_name: "甲移民", source_refs: ["wechat:11"] },
    ],
  }, sources, analyses), /重复使用来源/);

  assert.throws(() => validatePeerDailyAggregate({
    shared_topics: [{
      topic_title: "美国主题",
      source_refs: ["wechat:11"],
      differences: [],
    }],
  }, sources, analyses), /不足两家同行/);
});

test("完整日报把无更新放在正文开头，MD 简版不暴露外部链接", () => {
  const window = getPeerDailyWindow("2026-08-10");
  const aggregate = buildFallbackPeerDailyAggregate(sources, sources.map(createFallbackSourceAnalysis));
  const markdown = renderPeerDailyReport({
    reportDate: "2026-08-10",
    window,
    aggregate,
    sources,
    noUpdateNames: ["丙移民"],
    warnings: [],
  });
  assert.ok(markdown.indexOf("今日无更新同行：丙移民") < markdown.indexOf("## 一、重点动作"));
  assert.match(markdown, /https:\/\/example\.com\/a/);

  const brief = renderPeerDailyMdBrief({
    reportDate: "2026-08-10",
    window,
    aggregate,
    noUpdateNames: ["丙移民"],
    internalUrl: "https://internal.example/peer",
  });
  assert.doesNotMatch(brief, /example\.com\/a/);
  assert.match(brief, /internal\.example\/peer/);
  assert.ok(brief.length <= 1_000);
});

test("MD 简版在多条重点和共同主题下仍限制为 1000 字符", () => {
  const longText = "该同行围绕项目门槛、目标人群、活动形式和服务包装发布了可追溯的公开动作。".repeat(12);
  const aggregate = {
    keyActions: Array.from({ length: 5 }, (_, index) => ({
      competitorName: `同行${index + 1}`,
      actionSummary: longText,
    })),
    sharedTopics: Array.from({ length: 2 }, (_, topicIndex) => ({
      topicTitle: `共同主题${topicIndex + 1}`,
      commonAction: longText,
      differences: Array.from({ length: 3 }, (_, index) => ({
        competitorName: `同行${index + 1}`,
        difference: longText,
      })),
    })),
  };
  const brief = renderPeerDailyMdBrief({
    reportDate: "2026-08-10",
    window: getPeerDailyWindow("2026-08-10"),
    aggregate,
    noUpdateNames: [],
    internalUrl: "https://internal.example/peer",
  });
  assert.ok(brief.length <= 1_000);
  assert.match(brief, /查看完整报告/);
});
