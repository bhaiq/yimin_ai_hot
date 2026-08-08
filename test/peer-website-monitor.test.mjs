import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPeerWebsiteDiffPlan,
  canonicalizeWebsiteUrl,
  getWebsiteProjectContentHash,
  normalizeWebsiteProject,
  validatePeerWebsiteSnapshot,
} from "../lib/peer-website-monitor.mjs";

const peers = [
  {
    code: "peer-a",
    privateDomain: "aqyimin.com",
    brandTerms: ["桉侨移民", "桉侨"],
  },
  {
    code: "peer-b",
    privateDomain: "ekimmigration.com",
    brandTerms: ["景鸿移民", "景鸿"],
  },
];

function rawProject(overrides = {}) {
  return {
    source_project_id: "turmigrate",
    canonical_url: "http://www.aqyimin.com/detail/turmigrate/?utm_source=test#top",
    project_name: "阿联酋黄金签证",
    country_or_region: "阿联酋",
    category: "投资移民",
    website_status_note: "",
    introduction: "公开介绍",
    investment_amount: "200 万迪拉姆",
    investment_requirements: ["要求 B", "要求 A"],
    financial_requirements: [],
    application_conditions: ["年满 18 周岁"],
    advantages: ["优势一"],
    application_process: [{ stage: "递交", number: "1" }],
    handling_process: [],
    identity_type: "黄金签证",
    residence_requirement: "无硬性居住要求",
    process_source_type: "html_text",
    scraped_at: "2026-08-08T02:30:00+08:00",
    ...overrides,
  };
}

function normalizedProject(overrides = {}) {
  const result = normalizeWebsiteProject(rawProject(overrides), {
    expectedDomain: "aqyimin.com",
  });
  assert.equal(result.valid, true, result.errors.join("; "));
  return result.project;
}

function snapshot(collectors) {
  return {
    schema_version: "peer-website-snapshot/v1",
    run_id: "web-2026-08-08T023000+0800-test",
    started_at: "2026-08-08T02:30:00+08:00",
    finished_at: "2026-08-08T03:30:00+08:00",
    collectors,
  };
}

function completedCollector(projects = [rawProject()]) {
  return {
    peer_code: "peer-a",
    source_domain: "aqyimin.com",
    collector_version: "test-sha",
    status: "completed",
    error: "",
    discovered_count: projects.length,
    success_count: projects.length,
    failed_count: 0,
    projects,
  };
}

test("canonicalizeWebsiteUrl removes tracking data but keeps the project path", () => {
  assert.equal(
    canonicalizeWebsiteUrl(
      "http://www.aqyimin.com/detail/turmigrate/?utm_source=test&lang=zh#top",
      "aqyimin.com",
    ),
    "https://www.aqyimin.com/detail/turmigrate?lang=zh",
  );
  assert.equal(
    canonicalizeWebsiteUrl("https://example.com/detail/turmigrate", "aqyimin.com"),
    "",
  );
});

test("material hash ignores whitespace, punctuation, list order and scraped time", () => {
  const first = normalizedProject();
  const second = normalizedProject({
    project_name: "阿联酋，黄金签证！",
    investment_amount: " 200万迪拉姆 ",
    investment_requirements: ["要求A。", "要求 B"],
    scraped_at: "2026-08-09T02:30:00+08:00",
  });
  assert.equal(getWebsiteProjectContentHash(first), getWebsiteProjectContentHash(second));
});

test("material hash preserves meaningful currency and percentage symbols", () => {
  const withPercentage = normalizedProject({ investment_amount: "回报率 3%" });
  const withoutPercentage = normalizedProject({ investment_amount: "回报率 3" });
  const withCurrency = normalizedProject({ investment_amount: "$500,000" });
  const withoutCurrency = normalizedProject({ investment_amount: "500,000" });
  assert.notEqual(withPercentage.content_hash, withoutPercentage.content_hash);
  assert.notEqual(withCurrency.content_hash, withoutCurrency.content_hash);
});

test("snapshot validation rejects one bad collector without invalidating the envelope", () => {
  const result = validatePeerWebsiteSnapshot(snapshot([
    completedCollector(),
    {
      ...completedCollector([]),
      peer_code: "peer-b",
      source_domain: "wrong.example.com",
      discovered_count: 0,
      success_count: 0,
    },
  ]), peers);
  assert.equal(result.valid, true);
  assert.equal(result.collectors[0].valid, true);
  assert.equal(result.collectors[1].valid, false);
  assert.match(result.collectors[1].errors.join(" "), /source_domain/);
});

test("snapshot validation allows multiple stable project IDs on one page", () => {
  const duplicate = rawProject({ source_project_id: "another-id" });
  const result = validatePeerWebsiteSnapshot(snapshot([
    completedCollector([rawProject(), duplicate]),
  ]), peers);
  assert.equal(result.valid, true);
  assert.equal(result.collectors[0].valid, true);
});

test("first successful snapshot builds a baseline without added events", () => {
  const collector = {
    ...completedCollector(),
    projects: [normalizedProject()],
  };
  const plan = buildPeerWebsiteDiffPlan({ collector, currentProjects: [], hasBaseline: false });
  assert.equal(plan.baseline, 1);
  assert.equal(plan.added, 0);
  assert.equal(plan.actions[0].type, "baseline");
});

test("an existing project produces changed and unchanged results", () => {
  const before = normalizedProject();
  const changed = normalizedProject({ investment_amount: "300 万迪拉姆" });
  const current = {
    id: 10,
    stableIdentity: before.stable_identity,
    canonicalUrlHash: before.canonical_url_hash,
    lifecycleStatus: "active",
    missingSuccessCount: 0,
    contentHash: before.content_hash,
    currentVersionId: 20,
    snapshot: before,
  };

  const unchangedPlan = buildPeerWebsiteDiffPlan({
    collector: { ...completedCollector(), projects: [before] },
    currentProjects: [current],
    hasBaseline: true,
  });
  assert.equal(unchangedPlan.unchanged, 1);

  const changedPlan = buildPeerWebsiteDiffPlan({
    collector: { ...completedCollector(), projects: [changed] },
    currentProjects: [current],
    hasBaseline: true,
  });
  assert.equal(changedPlan.changed, 1);
  assert.deepEqual(changedPlan.actions[0].changedFields, ["investment_amount"]);
});

test("a project is removed only after two completed snapshots miss it", () => {
  const before = normalizedProject();
  const baseCurrent = {
    id: 10,
    stableIdentity: before.stable_identity,
    canonicalUrlHash: before.canonical_url_hash,
    lifecycleStatus: "active",
    contentHash: before.content_hash,
    currentVersionId: 20,
    snapshot: before,
  };
  const emptyCompleted = { ...completedCollector(), projects: [] };

  const firstMiss = buildPeerWebsiteDiffPlan({
    collector: emptyCompleted,
    currentProjects: [{ ...baseCurrent, missingSuccessCount: 0 }],
    hasBaseline: true,
  });
  assert.equal(firstMiss.pendingRemoval, 1);
  assert.equal(firstMiss.removed, 0);

  const secondMiss = buildPeerWebsiteDiffPlan({
    collector: emptyCompleted,
    currentProjects: [{ ...baseCurrent, missingSuccessCount: 1 }],
    hasBaseline: true,
  });
  assert.equal(secondMiss.pendingRemoval, 0);
  assert.equal(secondMiss.removed, 1);
});

test("one missing project is detected when two stable IDs share one page", () => {
  const first = normalizedProject({ source_project_id: "tab-1" });
  const second = normalizedProject({ source_project_id: "tab-2" });
  const currentProjects = [first, second].map((project, index) => ({
    id: index + 10,
    stableIdentity: project.stable_identity,
    canonicalUrlHash: project.canonical_url_hash,
    lifecycleStatus: "active",
    missingSuccessCount: 0,
    contentHash: project.content_hash,
    currentVersionId: index + 20,
    snapshot: project,
  }));
  const plan = buildPeerWebsiteDiffPlan({
    collector: { ...completedCollector(), projects: [first] },
    currentProjects,
    hasBaseline: true,
  });
  assert.equal(plan.unchanged, 1);
  assert.equal(plan.pendingRemoval, 1);
});

test("a removed project returning to the site produces reappeared", () => {
  const project = normalizedProject();
  const plan = buildPeerWebsiteDiffPlan({
    collector: { ...completedCollector(), projects: [project] },
    currentProjects: [{
      id: 10,
      stableIdentity: project.stable_identity,
      canonicalUrlHash: project.canonical_url_hash,
      lifecycleStatus: "removed",
      missingSuccessCount: 2,
      contentHash: project.content_hash,
      currentVersionId: 20,
      snapshot: project,
    }],
    hasBaseline: true,
  });
  assert.equal(plan.reappeared, 1);
  assert.equal(plan.actions[0].type, "reappeared");
});
