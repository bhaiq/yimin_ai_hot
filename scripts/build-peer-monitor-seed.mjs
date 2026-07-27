import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const sourcePath = process.argv[2];
const outputPath = resolve(process.argv[3] || "data/peer-monitor-projects.json");

if (!sourcePath) {
  console.error("Usage: node scripts/build-peer-monitor-seed.mjs <all_companies_projects.json> [output]");
  process.exit(1);
}

const competitorConfigs = [
  { code: "peer-a", displayName: "同行A", sourceName: "桉侨移民", brandTerms: ["桉侨移民", "桉侨", "ANQIAO"] },
  { code: "peer-b", displayName: "同行B", sourceName: "景鸿集团（景鸿移民）", brandTerms: ["景鸿集团", "景鸿移民", "景鸿"] },
  { code: "peer-c", displayName: "同行C", sourceName: "侨外出国（侨外移民）", brandTerms: ["侨外出国", "侨外移民", "侨外"] },
  { code: "peer-d", displayName: "同行D", sourceName: "亨瑞集团（亨瑞移民）", brandTerms: ["亨瑞集团", "亨瑞移民", "亨瑞"] },
  { code: "peer-e", displayName: "同行E", sourceName: "世贸通集团（世贸通移民）", brandTerms: ["世贸通集团", "世贸通移民", "世贸通"] },
  { code: "peer-f", displayName: "同行F", sourceName: "澳星集团（澳星出国）", brandTerms: ["澳星集团", "澳星出国", "澳星"] },
  { code: "peer-g", displayName: "同行G", sourceName: "和中移民（WellTrend）", brandTerms: ["和中移民", "和中", "WellTrend"] },
  { code: "peer-h", displayName: "同行H", sourceName: "外联出国（外联移民）", brandTerms: ["外联出国", "外联移民", "外联"] },
  { code: "peer-i", displayName: "同行I", sourceName: "兆龙移民（兆龙出国）", brandTerms: ["兆龙移民", "兆龙出国", "兆龙"] },
];

const configBySourceName = new Map(
  competitorConfigs.map((config) => [config.sourceName, config]),
);
const allBrandTerms = [...new Set(
  competitorConfigs.flatMap((config) => config.brandTerms),
)].sort((left, right) => right.length - left.length);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const brandPattern = new RegExp(allBrandTerms.map(escapeRegExp).join("|"), "gi");
const urlPattern = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;

function sanitizeText(value) {
  return String(value || "")
    .replace(brandPattern, "该机构")
    .replace(urlPattern, "")
    .replace(/\s+/g, " ")
    .replace(/该机构(?:集团|移民|出国)/g, "该机构")
    .trim();
}

function sanitizeValue(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/(?:url|image|domain)/i.test(key))
        .map(([key, nestedValue]) => [key, sanitizeValue(nestedValue)]),
    );
  }
  return typeof value === "string" ? sanitizeText(value) : value;
}

function normalizeCountry(category) {
  const raw = sanitizeText(category);
  const aliases = new Map([
    ["澳洲", "澳大利亚"],
    ["澳洲移民", "澳大利亚"],
    ["马来移民", "马来西亚"],
    ["香港", "中国香港"],
    ["香港移民", "中国香港"],
    ["澳门", "中国澳门"],
    ["美国移民", "美国"],
    ["新西兰移民", "新西兰"],
    ["日本移民", "日本"],
    ["英国移民", "英国"],
    ["加拿大移民", "加拿大"],
    ["迪拜", "阿联酋"],
  ]);
  if (aliases.has(raw)) return aliases.get(raw);

  const withoutSuffix = raw.replace(/移民$/, "").trim();
  return aliases.get(withoutSuffix) || withoutSuffix || "其他";
}

function buildSourceKey(config, item) {
  return createHash("sha256")
    .update(`${config.code}\n${item.source_url || ""}\n${item.project_name || ""}`)
    .digest("hex");
}

const input = JSON.parse(await readFile(resolve(sourcePath), "utf8"));
if (!Array.isArray(input)) {
  throw new Error("Expected the source file to contain a JSON array");
}

const competitors = competitorConfigs.map((config) => ({
  code: config.code,
  displayName: config.displayName,
  projects: [],
}));
const competitorByCode = new Map(competitors.map((competitor) => [competitor.code, competitor]));

for (const item of input) {
  const config = configBySourceName.get(item.company_name);
  if (!config) {
    throw new Error(`Unknown company_name: ${item.company_name}`);
  }

  const categoryRaw = sanitizeText(item.category);
  competitorByCode.get(config.code).projects.push({
    sourceKey: buildSourceKey(config, item),
    projectName: sanitizeText(item.project_name),
    categoryRaw,
    country: normalizeCountry(categoryRaw),
    introduction: sanitizeText(item.introduction || item.introduction_summary),
    isInvestmentProject: Boolean(item.is_investment_project),
    investmentAmount: sanitizeText(item.investment_amount),
    investmentRequirements: sanitizeValue(item.investment_requirements || []),
    financialRequirements: sanitizeValue(item.financial_requirements || []),
    advantages: sanitizeValue(item.advantages || []),
    applicationConditions: sanitizeValue(item.application_conditions || []),
    processSummary: sanitizeText(item.process_summary),
    processSourceType: sanitizeText(item.process_source_type || "missing"),
    processText: sanitizeText(item.process_text),
    applicationProcess: sanitizeValue(item.application_process || item.handling_process || []),
    identityType: sanitizeText(item.identity_type),
    residenceRequirement: sanitizeText(item.residence_requirement),
    websiteStatusNote: sanitizeText(item.website_status_note),
    scrapedAt: item.scraped_at || null,
  });
}

for (const competitor of competitors) {
  competitor.projects.sort((left, right) => (
    left.country.localeCompare(right.country, "zh-Hans-CN")
    || left.projectName.localeCompare(right.projectName, "zh-Hans-CN")
  ));
}

const generatedAt = input
  .map((item) => item.scraped_at)
  .filter(Boolean)
  .sort()
  .at(-1) || null;
const payload = {
  version: 1,
  generatedAt,
  projectCount: competitors.reduce((sum, competitor) => sum + competitor.projects.length, 0),
  competitors,
};

await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`Wrote ${payload.projectCount} anonymized projects to ${outputPath}`);
