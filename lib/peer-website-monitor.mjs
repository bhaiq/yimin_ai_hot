import { createHash } from "node:crypto";

export const PEER_WEBSITE_SCHEMA_VERSION = "peer-website-snapshot/v1";
export const PEER_WEBSITE_COLLECTOR_STATUSES = new Set(["completed", "partial", "failed"]);

const materialFieldNames = [
  "project_name",
  "country_or_region",
  "category",
  "website_status_note",
  "introduction",
  "investment_amount",
  "investment_requirements",
  "financial_requirements",
  "application_conditions",
  "advantages",
  "application_process",
  "handling_process",
  "identity_type",
  "residence_requirement",
  "process_source_type",
];

const trackingQueryNames = new Set([
  "from",
  "source",
  "spm",
  "ref",
  "referrer",
  "fbclid",
  "gclid",
  "wx_header",
]);

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function normalizeText(value, { maxLength = 200_000 } = {}) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeComparisonText(value) {
  return normalizeText(value)
    .toLocaleLowerCase("zh-CN")
    .replace(/%/g, "百分号")
    .replace(/‰/g, "千分号")
    .replace(/[\p{P}]+/gu, "")
    .replace(/\s+/g, "")
    .trim();
}

function normalizeMaterialValue(value) {
  if (Array.isArray(value)) {
    return value
      .map(normalizeMaterialValue)
      .filter((item) => {
        if (typeof item === "string") return Boolean(item);
        if (Array.isArray(item)) return item.length > 0;
        return item && typeof item === "object" ? Object.keys(item).length > 0 : item !== null;
      })
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "zh-CN"));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, normalizeMaterialValue(nestedValue)])
        .filter(([, nestedValue]) => {
          if (typeof nestedValue === "string") return Boolean(nestedValue);
          if (Array.isArray(nestedValue)) return nestedValue.length > 0;
          return nestedValue && typeof nestedValue === "object"
            ? Object.keys(nestedValue).length > 0
            : nestedValue !== null;
        }),
    );
  }
  if (typeof value === "string") return normalizeComparisonText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  return null;
}

function normalizeDisplayValue(value) {
  if (Array.isArray(value)) {
    return value
      .map(normalizeDisplayValue)
      .filter((item) => {
        if (typeof item === "string") return Boolean(item);
        if (Array.isArray(item)) return item.length > 0;
        return item && typeof item === "object" ? Object.keys(item).length > 0 : item !== null;
      });
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, normalizeDisplayValue(nestedValue)]),
    );
  }
  if (typeof value === "string") return normalizeText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  return "";
}

function normalizeArray(value) {
  return Array.isArray(value) ? normalizeDisplayValue(value) : [];
}

function normalizeInteger(value, fieldName, errors) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    errors.push(`${fieldName} 必须是非负整数`);
    return 0;
  }
  return parsed;
}

function parseIsoDate(value, fieldName, errors, { required = true } = {}) {
  const text = normalizeText(value, { maxLength: 80 });
  if (!text && !required) return "";
  const parsed = Date.parse(text);
  if (!text || Number.isNaN(parsed)) {
    errors.push(`${fieldName} 必须是有效的 ISO 8601 时间`);
    return "";
  }
  return new Date(parsed).toISOString();
}

export function normalizeWebsiteDomain(value) {
  let domain = normalizeText(value, { maxLength: 255 }).toLowerCase();
  if (!domain) return "";
  try {
    if (domain.includes("://")) domain = new URL(domain).hostname.toLowerCase();
  } catch {
    return "";
  }
  return domain.replace(/^www\./, "").replace(/\.$/, "");
}

function domainMatches(hostname, expectedDomain) {
  const host = normalizeWebsiteDomain(hostname);
  const expected = normalizeWebsiteDomain(expectedDomain);
  return Boolean(host && expected && (host === expected || host.endsWith(`.${expected}`)));
}

export function canonicalizeWebsiteUrl(value, expectedDomain = "") {
  const text = normalizeText(value, { maxLength: 1400 });
  if (!text) return "";
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (expectedDomain && !domainMatches(url.hostname, expectedDomain)) return "";
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (lower.startsWith("utm_") || trackingQueryNames.has(lower)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return "";
  }
}

function safeDiagnostic(value) {
  return normalizeText(value, { maxLength: 2000 })
    .replace(/(api[_-]?key|token|secret|password|cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

export function getWebsiteProjectMaterial(project) {
  return Object.fromEntries(
    materialFieldNames.map((fieldName) => [
      fieldName,
      normalizeMaterialValue(project?.[fieldName]),
    ]),
  );
}

export function getWebsiteProjectContentHash(project) {
  return sha256(JSON.stringify(getWebsiteProjectMaterial(project)));
}

export function getChangedWebsiteProjectFields(beforeProject, afterProject) {
  const before = getWebsiteProjectMaterial(beforeProject);
  const after = getWebsiteProjectMaterial(afterProject);
  return materialFieldNames.filter((fieldName) => (
    JSON.stringify(before[fieldName]) !== JSON.stringify(after[fieldName])
  ));
}

export function normalizeWebsiteProject(rawProject, { expectedDomain = "", index = 0 } = {}) {
  const errors = [];
  if (!rawProject || typeof rawProject !== "object" || Array.isArray(rawProject)) {
    return { valid: false, errors: [`projects[${index}] 必须是对象`], project: null };
  }

  const sourceProjectId = normalizeText(rawProject.source_project_id, { maxLength: 512 });
  const canonicalUrl = canonicalizeWebsiteUrl(rawProject.canonical_url, expectedDomain);
  if (!canonicalUrl) errors.push(`projects[${index}].canonical_url 无效或不属于 ${expectedDomain}`);
  if (!sourceProjectId && !canonicalUrl) {
    errors.push(`projects[${index}] 缺少 source_project_id 或 canonical_url`);
  }
  const projectName = normalizeText(rawProject.project_name, { maxLength: 600 });
  if (!projectName) errors.push(`projects[${index}].project_name 不能为空`);

  const scrapedAtErrors = [];
  const scrapedAt = parseIsoDate(
    rawProject.scraped_at,
    `projects[${index}].scraped_at`,
    scrapedAtErrors,
    { required: false },
  );
  errors.push(...scrapedAtErrors);

  const project = {
    source_project_id: sourceProjectId,
    canonical_url: canonicalUrl,
    canonical_url_hash: canonicalUrl ? sha256(canonicalUrl) : "",
    project_name: projectName,
    country_or_region: normalizeText(rawProject.country_or_region, { maxLength: 120 }) || "其他",
    category: normalizeText(rawProject.category, { maxLength: 160 }),
    website_status_note: normalizeText(rawProject.website_status_note),
    introduction: normalizeText(rawProject.introduction),
    investment_amount: normalizeText(rawProject.investment_amount),
    investment_requirements: normalizeArray(rawProject.investment_requirements),
    financial_requirements: normalizeArray(rawProject.financial_requirements),
    application_conditions: normalizeArray(rawProject.application_conditions),
    advantages: normalizeArray(rawProject.advantages),
    application_process: normalizeArray(rawProject.application_process),
    handling_process: normalizeArray(rawProject.handling_process),
    identity_type: normalizeText(rawProject.identity_type, { maxLength: 160 }),
    residence_requirement: normalizeText(rawProject.residence_requirement),
    process_source_type: normalizeText(rawProject.process_source_type, { maxLength: 32 }) || "missing",
    scraped_at: scrapedAt,
  };
  project.stable_identity = sourceProjectId
    ? `id:${sourceProjectId}`
    : `url:${project.canonical_url_hash}`;
  project.source_key = sha256(project.stable_identity);
  project.content_hash = getWebsiteProjectContentHash(project);

  const suppliedHash = normalizeText(rawProject.content_hash, { maxLength: 128 }).toLowerCase();
  const warnings = [];
  if (suppliedHash && suppliedHash !== project.content_hash) {
    warnings.push(`projects[${index}].content_hash 与服务端规范化结果不同，已使用服务端结果`);
  }

  return { valid: errors.length === 0, errors, warnings, project };
}

function normalizeCollector(rawCollector, peerByCode, index) {
  const errors = [];
  const warnings = [];
  if (!rawCollector || typeof rawCollector !== "object" || Array.isArray(rawCollector)) {
    return {
      valid: false,
      errors: [`collectors[${index}] 必须是对象`],
      collector: null,
      peerCode: "",
      sourceDomain: "",
    };
  }

  const peerCode = normalizeText(rawCollector.peer_code, { maxLength: 32 });
  const peer = peerByCode.get(peerCode);
  if (!peer) errors.push(`collectors[${index}].peer_code 未配置: ${peerCode || "(empty)"}`);
  const sourceDomain = normalizeWebsiteDomain(rawCollector.source_domain);
  const expectedDomain = normalizeWebsiteDomain(peer?.privateDomain);
  if (!sourceDomain || !expectedDomain || sourceDomain !== expectedDomain) {
    errors.push(`collectors[${index}].source_domain 与 ${peerCode || "同行"} 配置不一致`);
  }

  const status = normalizeText(rawCollector.status, { maxLength: 20 }).toLowerCase();
  if (!PEER_WEBSITE_COLLECTOR_STATUSES.has(status)) {
    errors.push(`collectors[${index}].status 只允许 completed/partial/failed`);
  }
  const collectorVersion = normalizeText(rawCollector.collector_version, { maxLength: 160 });
  if (!collectorVersion) errors.push(`collectors[${index}].collector_version 不能为空`);
  const error = safeDiagnostic(rawCollector.error);
  if (status === "failed" && !error) errors.push(`collectors[${index}].error 在 failed 状态下不能为空`);

  const discoveredCount = normalizeInteger(rawCollector.discovered_count, `collectors[${index}].discovered_count`, errors);
  const successCount = normalizeInteger(rawCollector.success_count, `collectors[${index}].success_count`, errors);
  const failedCount = normalizeInteger(rawCollector.failed_count, `collectors[${index}].failed_count`, errors);
  const rawProjects = Array.isArray(rawCollector.projects) ? rawCollector.projects : [];
  if (!Array.isArray(rawCollector.projects)) errors.push(`collectors[${index}].projects 必须是数组`);
  if (successCount !== rawProjects.length) {
    errors.push(`collectors[${index}].success_count 必须等于 projects 数量`);
  }
  if (discoveredCount !== successCount + failedCount) {
    errors.push(`collectors[${index}].discovered_count 必须等于 success_count + failed_count`);
  }
  if (status === "completed" && failedCount !== 0) {
    errors.push(`collectors[${index}] completed 状态不能包含失败项目`);
  }
  if (status === "completed" && rawProjects.length === 0) {
    errors.push(`collectors[${index}] completed 状态至少需要一个项目`);
  }
  if (status === "failed" && rawProjects.length > 0) {
    errors.push(`collectors[${index}] failed 状态不能包含项目`);
  }

  const projects = [];
  const identities = new Set();
  rawProjects.forEach((rawProject, projectIndex) => {
    const normalized = normalizeWebsiteProject(rawProject, {
      expectedDomain: expectedDomain || sourceDomain,
      index: projectIndex,
    });
    errors.push(...normalized.errors);
    warnings.push(...(normalized.warnings || []));
    if (!normalized.project) return;
    if (identities.has(normalized.project.stable_identity)) {
      errors.push(`collectors[${index}] 存在重复项目身份: ${normalized.project.stable_identity}`);
      return;
    }
    identities.add(normalized.project.stable_identity);
    projects.push(normalized.project);
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    peerCode,
    sourceDomain,
    collector: {
      peer_code: peerCode,
      source_domain: sourceDomain,
      collector_version: collectorVersion,
      status,
      error,
      discovered_count: discoveredCount,
      success_count: successCount,
      failed_count: failedCount,
      projects,
    },
  };
}

export function validatePeerWebsiteSnapshot(rawSnapshot, peerConfigs) {
  const errors = [];
  if (!rawSnapshot || typeof rawSnapshot !== "object" || Array.isArray(rawSnapshot)) {
    return { valid: false, errors: ["请求体必须是官网快照对象"], snapshot: null, collectors: [] };
  }
  const schemaVersion = normalizeText(rawSnapshot.schema_version, { maxLength: 80 });
  if (schemaVersion !== PEER_WEBSITE_SCHEMA_VERSION) {
    errors.push(`schema_version 必须是 ${PEER_WEBSITE_SCHEMA_VERSION}`);
  }
  const runId = normalizeText(rawSnapshot.run_id, { maxLength: 160 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:+-]{7,159}$/.test(runId)) {
    errors.push("run_id 格式无效，长度必须为 8-160 且只能使用安全字符");
  }
  const startedAt = parseIsoDate(rawSnapshot.started_at, "started_at", errors);
  const finishedAt = parseIsoDate(rawSnapshot.finished_at, "finished_at", errors);
  if (startedAt && finishedAt && Date.parse(finishedAt) < Date.parse(startedAt)) {
    errors.push("finished_at 不能早于 started_at");
  }

  const rawCollectors = Array.isArray(rawSnapshot.collectors) ? rawSnapshot.collectors : [];
  if (!rawCollectors.length) errors.push("collectors 至少需要一个站点结果");
  const peerByCode = new Map(
    (Array.isArray(peerConfigs) ? peerConfigs : []).map((peer) => [String(peer.code), peer]),
  );
  const collectors = rawCollectors.map((collector, index) => (
    normalizeCollector(collector, peerByCode, index)
  ));
  const collectorKeys = new Set();
  collectors.forEach((result, index) => {
    const key = `${result.peerCode}\n${result.sourceDomain}`;
    if (collectorKeys.has(key)) {
      result.valid = false;
      result.errors.push(`collectors[${index}] 同一同行和域名在本轮重复出现`);
    }
    collectorKeys.add(key);
  });

  const snapshot = {
    schema_version: schemaVersion,
    run_id: runId,
    started_at: startedAt,
    finished_at: finishedAt,
    collectors: collectors.map((result) => result.collector).filter(Boolean),
  };
  return {
    valid: errors.length === 0,
    errors,
    snapshot,
    collectors,
    payloadHash: sha256(JSON.stringify(snapshot)),
  };
}

export function buildPeerWebsiteDiffPlan({ collector, currentProjects = [], hasBaseline = false }) {
  if (!collector || collector.status !== "completed") {
    return {
      baseline: 0,
      added: 0,
      changed: 0,
      removed: 0,
      reappeared: 0,
      unchanged: 0,
      pendingRemoval: 0,
      actions: [],
    };
  }

  const currentByIdentity = new Map(
    currentProjects.map((project) => [String(project.stableIdentity || ""), project]),
  );
  const currentByCanonicalUrlHash = new Map(
    currentProjects
      .filter((project) => (
        project.canonicalUrlHash
        && String(project.stableIdentity || "").startsWith("url:")
      ))
      .map((project) => [String(project.canonicalUrlHash), project]),
  );
  const matchedCurrentIds = new Set();
  const actions = [];
  const counts = {
    baseline: 0,
    added: 0,
    changed: 0,
    removed: 0,
    reappeared: 0,
    unchanged: 0,
    pendingRemoval: 0,
  };

  for (const project of collector.projects) {
    const current = currentByIdentity.get(project.stable_identity)
      || currentByCanonicalUrlHash.get(project.canonical_url_hash);
    if (!current) {
      const type = hasBaseline ? "added" : "baseline";
      counts[type] += 1;
      actions.push({ type, project, current: null, changedFields: materialFieldNames });
      continue;
    }
    matchedCurrentIds.add(Number(current.id));

    if (current.lifecycleStatus === "removed") {
      const changedFields = getChangedWebsiteProjectFields(current.snapshot || {}, project);
      counts.reappeared += 1;
      actions.push({ type: "reappeared", project, current, changedFields });
      continue;
    }

    if (String(current.contentHash || "") !== project.content_hash) {
      const changedFields = getChangedWebsiteProjectFields(current.snapshot || {}, project);
      counts.changed += 1;
      actions.push({ type: "changed", project, current, changedFields });
      continue;
    }

    counts.unchanged += 1;
    actions.push({ type: "unchanged", project, current, changedFields: [] });
  }

  if (hasBaseline) {
    for (const current of currentProjects) {
      if (
        current.lifecycleStatus !== "active"
        || matchedCurrentIds.has(Number(current.id))
      ) {
        continue;
      }
      const nextMissingCount = Number(current.missingSuccessCount || 0) + 1;
      if (nextMissingCount >= 2) {
        counts.removed += 1;
        actions.push({ type: "removed", project: null, current, changedFields: [] });
      } else {
        counts.pendingRemoval += 1;
        actions.push({ type: "missing_once", project: null, current, changedFields: [] });
      }
    }
  }

  return { ...counts, actions };
}

export function buildWebsiteProjectSourceKey(peerCode, stableIdentity) {
  return sha256(`${normalizeText(peerCode, { maxLength: 32 })}\n${normalizeText(stableIdentity, { maxLength: 1600 })}`);
}

export function sanitizeWebsiteText(value, brandTerms = []) {
  const terms = [...new Set((brandTerms || []).map((term) => normalizeText(term)).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  let text = normalizeText(value);
  for (const term of terms) {
    text = text.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "该机构");
  }
  return text
    .replace(/(?:https?:\/\/|www\.)[^\s<>"']+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeWebsiteValue(value, brandTerms = []) {
  if (Array.isArray(value)) return value.map((item) => sanitizeWebsiteValue(item, brandTerms));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, sanitizeWebsiteValue(nestedValue, brandTerms)]),
    );
  }
  return typeof value === "string" ? sanitizeWebsiteText(value, brandTerms) : value;
}
