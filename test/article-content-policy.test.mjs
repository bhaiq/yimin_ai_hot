import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import {
  GREEK_MINISTRY_SOURCE_NAME,
  OPERATIONAL_CASE_DOCUMENT_PICKUP_REASON,
  REFUGEE_ASYLUM_REASON,
  RELIGION_REASON,
  applyArticleContentPolicy,
  getBusinessArticleExclusionReason,
  getOperationalArticleExclusionReason,
  normalizeSourceMetadata,
} from "../lib/article-content-policy.mjs";

const ministrySource = {
  name: "希腊购房",
  url: "https://migration.gov.gr/feed/",
  country: "欧洲",
  category: "希腊官方网站",
};

test("normalizes the official Greek ministry source without changing its category", () => {
  assert.deepEqual(normalizeSourceMetadata(ministrySource), {
    ...ministrySource,
    name: GREEK_MINISTRY_SOURCE_NAME,
    country: "希腊",
  });
});

test("does not normalize a lookalike hostname", () => {
  const source = { ...ministrySource, url: "https://migration.gov.gr.example.com/feed/" };
  assert.deepEqual(normalizeSourceMetadata(source), source);
});

test("excludes Greek travel-document pickup lists", () => {
  const item = {
    title: "28.08.2026: Λίστα υποθέσεων ασύλου των οποίων τα ταξιδιωτικά έγγραφα είναι έτοιμα προς παράδοση στους δικαιούχους",
    url: "https://migration.gov.gr/28-08-2026-lista-ypotheseon-asyloy-ton-opoion-ta-taxidiotika-eggrafa-einai-etoima-pros-paradosi/",
  };
  assert.equal(
    getOperationalArticleExclusionReason(item, ministrySource),
    OPERATIONAL_CASE_DOCUMENT_PICKUP_REASON,
  );
});

test("excludes residence-permit pickup lists by their official URL slug", () => {
  const item = {
    title: "27.08.2026 — Daily notice",
    url: "https://migration.gov.gr/27-08-2026-lista-ypotheseon-asyloy-ton-opoion-oi-adeies-diamonis-einai-etoimes-pros-paradosi/",
  };
  assert.equal(
    getOperationalArticleExclusionReason(item, ministrySource),
    OPERATIONAL_CASE_DOCUMENT_PICKUP_REASON,
  );
});

test("excludes Chinese translations of the same operational notice", () => {
  const item = {
    title: "2026年8月28日：可领取旅行证件的庇护案件清单（塞萨洛尼基地区庇护办公室领取）",
  };
  assert.equal(
    getOperationalArticleExclusionReason(item, ministrySource),
    OPERATIONAL_CASE_DOCUMENT_PICKUP_REASON,
  );
});

test("excludes English translations of the same operational notice", () => {
  const item = {
    title: "List of asylum cases whose residence permits are ready for collection",
  };
  assert.equal(
    getOperationalArticleExclusionReason(item, ministrySource),
    OPERATIONAL_CASE_DOCUMENT_PICKUP_REASON,
  );
});

test("keeps genuine policy announcements from the ministry", () => {
  const item = {
    title: "New asylum procedure enters into force",
    summary: "The ministry announced changes to application processing.",
  };
  assert.equal(getOperationalArticleExclusionReason(item, ministrySource), "");
});

test("does not apply the rule to another publisher", () => {
  const item = {
    title: "List of asylum cases whose travel documents are ready for pickup",
  };
  assert.equal(
    getOperationalArticleExclusionReason(item, {
      ...ministrySource,
      url: "https://example.com/feed/",
    }),
    "",
  );
});

test("caps operational notices at low impact while retaining the raw item", () => {
  const item = {
    id: "raw-article-id",
    title: "可领取居留许可的庇护案件清单",
    heat: 99,
    impact: "高影响",
  };
  const result = applyArticleContentPolicy(item, ministrySource);

  assert.equal(result.dailyExcluded, true);
  assert.equal(result.dailyExcludedReason, OPERATIONAL_CASE_DOCUMENT_PICKUP_REASON);
  assert.equal(result.item.id, item.id);
  assert.equal(result.item.heat, 55);
  assert.equal(result.item.impact, "低影响");
  assert.equal(item.heat, 99);
});

for (const title of [
  "加拿大难民申请审理新规",
  "New asylum procedure enters into force",
  "Resettlement for refugees expanded",
  "Humanitarian protection application update",
  "Λίστα υποθέσεων ασύλου",
  "Νέα μέτρα για πρόσφυγες",
  "Accueil des réfugiés : nouvelles règles",
  "庇護申請流程更新",
]) {
  test(`blocks refugee/asylum topics across publishers: ${title}`, () => {
    const policy = applyArticleContentPolicy({ title, heat: 95 }, { url: "https://example.com" });
    assert.equal(policy.dailyExcluded, true);
    assert.equal(policy.dailyExcludedReason, REFUGEE_ASYLUM_REASON);
    assert.equal(policy.item.heat, 55);
  });
}

for (const title of [
  "美国宗教工作者签证延期",
  "Special Immigrant Religious Workers program extended",
  "R-1 visa application requirements",
  "Church conference on immigration",
  "New faith-based resettlement initiative",
  "宗教自由事务年度报告",
]) {
  test(`blocks religion topics: ${title}`, () => {
    assert.equal(getBusinessArticleExclusionReason({ title }), RELIGION_REASON);
  });
}

test("detects out-of-scope topics in summaries and stored translations", () => {
  assert.equal(getBusinessArticleExclusionReason({
    title: "New application rules", summary: "The updated procedure covers asylum seekers.",
  }), REFUGEE_ASYLUM_REASON);
  assert.equal(getBusinessArticleExclusionReason({
    title: "New application rules", summaryZh: "发布宗教工作者签证新规。",
  }), RELIGION_REASON);
  assert.equal(getBusinessArticleExclusionReason({
    title: "Νέα ανακοίνωση", titleZh: "难民安置公告",
  }), REFUGEE_ASYLUM_REASON);
});

test("keeps commercial immigration news even when source metadata mentions asylum", () => {
  const item = {
    title: "Golden Visa investment threshold updated",
    summary: "The Ministry of Migration and Asylum announced the investment rules.",
    category: "Ministry of Migration and Asylum",
  };
  const policy = applyArticleContentPolicy(item, ministrySource);
  assert.equal(policy.dailyExcluded, false);
  assert.equal(policy.item, item);
});

test("keeps incidental references in summaries of core business topics", () => {
  for (const title of ["EB-5 quota update", "Express Entry draw results", "留学签证申请费用调整"]) {
    assert.equal(getBusinessArticleExclusionReason({
      title, summary: "The announcement also mentions asylum and religious programs separately.",
    }), "");
  }
});

test("does not treat an agency's full name in the headline as an excluded topic", () => {
  for (const title of [
    "Immigration, Refugees and Citizenship Canada announces student visa changes",
    "Ministry of Migration and Asylum announces Golden Visa reforms",
    "希腊移民与庇护部调整黄金签证门槛",
  ]) {
    assert.equal(getBusinessArticleExclusionReason({ title }), "");
  }
  assert.equal(getBusinessArticleExclusionReason({
    title: "Immigration, Refugees and Citizenship Canada announces refugee resettlement changes",
  }), REFUGEE_ASYLUM_REASON);
});

test("an explicit excluded topic in the title takes precedence over commercial keywords", () => {
  assert.equal(getBusinessArticleExclusionReason({
    title: "Religious workers and EB-5 program comparison",
  }), RELIGION_REASON);
});

test("does not mistake ordinary government and business words for religious topics", () => {
  for (const title of [
    "Minister announces skilled worker visa reforms",
    "Good faith requirement for investor applications",
    "EB-4 special immigrant visa bulletin",
    "希腊黄金签证投资规则调整",
    "UK student visa requirements",
  ]) {
    assert.equal(getBusinessArticleExclusionReason({ title }), "");
  }
  assert.equal(getBusinessArticleExclusionReason(null), "");
});

// 单文件服务器会在导入时监听端口；隔离执行回填函数，验证迁移而不连接真实数据库。
const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const backfillStart = serverSource.indexOf("async function backfillArticleContentPolicies()");
const backfillEnd = serverSource.indexOf("async function updateSourceFetchStatus", backfillStart);
const backfillSource = serverSource.slice(backfillStart, backfillEnd);

async function simulateBackfill(articles) {
  const writes = [];
  const cursors = [];
  await runInNewContext(`${backfillSource}; backfillArticleContentPolicies();`, {
    normalizeSourceMetadata,
    isGreekMigrationMinistrySource: () => false,
    applyArticleContentPolicy,
    articleTranslationVersion: "test-version",
    dailyRecentLookbackHours: 72,
    sqlNumber: Number,
    sqlString: (value) => `'${value}'`,
    mysqlJson: async (sql) => {
      if (sql.includes("FROM yimin_sources")) return [{ id: 7, url: "https://example.com/feed" }];
      const cursor = Number(sql.match(/WHERE a.id > (\d+)/)[1]);
      cursors.push(cursor);
      return articles.filter((article) => article.id > cursor).slice(0, 500);
    },
    mysqlExec: async (sql) => { writes.push(sql); },
  });
  return { writes, cursors };
}

test("backfills all publishers across page boundaries and keeps separate exclusion reasons", async () => {
  const articles = Array.from({ length: 500 }, (_, index) => ({
    id: index + 1, sourceId: 7, title: "Golden Visa investment update", heat: 90,
  }));
  articles.push(
    { id: 501, sourceId: 7, title: "New asylum rules", heat: 90 },
    { id: 502, sourceId: 7, title: "Religious worker visa update", heat: 90 },
  );
  const { writes, cursors } = await simulateBackfill(articles);
  assert.deepEqual(cursors, [0, 500, 502]);
  assert.equal(writes.length, 2);
  for (const [index, reason] of [REFUGEE_ASYLUM_REASON, RELIGION_REASON].entries()) {
    const sql = writes[index];
    assert.ok(sql.includes(`daily_excluded_reason = '${reason}'`));
    assert.ok(sql.includes(`WHERE id IN (${501 + index})`));
    assert.match(sql, /START TRANSACTION/);
    assert.match(sql, /DELETE d FROM yimin_department_daily_reports/);
    assert.match(sql, /DELETE r FROM yimin_market_reports/);
    assert.match(sql, /DELETE r FROM yimin_daily_reports/);
    assert.match(sql, /COMMIT/);
    assert.doesNotMatch(sql, /DELETE FROM yimin_articles/);
  }
});

test("an already-applied backfill does not clear report caches again", async () => {
  const { writes } = await simulateBackfill([{
    id: 1, sourceId: 7, title: "New asylum rules",
    dailyExcluded: 1, dailyExcludedReason: REFUGEE_ASYLUM_REASON,
    heat: 55, impact: "低影响", impactEn: "Low Impact",
  }]);
  assert.equal(writes.length, 0);
});
