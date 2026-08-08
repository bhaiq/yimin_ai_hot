import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import {
  buildWerssArticleRecord,
  extractWerssFeedId,
  getPeerDiscoveryWindow,
  normalizeDajialaResponse,
  resolveDajialaLookup,
} from "./lib/peer-wechat-discovery.mjs";
import {
  PEER_WEBSITE_SCHEMA_VERSION,
  buildPeerWebsiteDiffPlan,
  buildWebsiteProjectSourceKey,
  sanitizeWebsiteText,
  sanitizeWebsiteValue,
  validatePeerWebsiteSnapshot,
} from "./lib/peer-website-monitor.mjs";

const rootDir = resolve(".");
await loadEnv();

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const cacheTtlMs = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);
const requestTimeoutMs = Number(process.env.FEED_TIMEOUT_MS || 9000);
const peerRssMaxBytes = Math.max(
  1_000_000,
  Number(process.env.PEER_MONITOR_RSS_MAX_BYTES) || 32 * 1024 * 1024,
);
const peerRssTimeoutMs = Math.max(
  requestTimeoutMs,
  Number(process.env.PEER_MONITOR_RSS_TIMEOUT_MS) || 60_000,
);
const maxItemsPerSource = Number(process.env.MAX_ITEMS_PER_SOURCE || 16);
const maxTotalItems = Number(process.env.MAX_TOTAL_ITEMS || 80);
const dailyCandidatePageSize = Math.max(50, Number(process.env.DAILY_CANDIDATE_PAGE_SIZE || 200));
const dailyAnalysisBatchSize = Math.max(1, Number(process.env.DAILY_ANALYSIS_BATCH_SIZE || 10));
const dailyAnalysisConcurrency = Math.max(1, Number(process.env.DAILY_ANALYSIS_CONCURRENCY || 1));
const dailyFinalPromptMaxChars = Math.max(20000, Number(process.env.DAILY_FINAL_PROMPT_MAX_CHARS || 80000));
const deepseekTimeoutMs = Math.max(1000, Number(process.env.DEEPSEEK_TIMEOUT_MS || 120000));
const deepseekStreamEnabled = process.env.DEEPSEEK_STREAM !== "0";
const dailyAnalysisVersion = "daily-analysis-v4";
const dailyLocalizationVersion = "daily-localization-v2";
const articleTranslationVersion = "article-translation-v1";
const articleTranslationBatchSize = Math.max(5, Number(process.env.ARTICLE_TRANSLATION_BATCH_SIZE || 30));
const articleTranslationConcurrency = Math.max(1, Number(process.env.ARTICLE_TRANSLATION_CONCURRENCY || 2));
const articleTranslationMaxPerRun = Math.max(20, Number(process.env.ARTICLE_TRANSLATION_MAX_PER_RUN || 300));
const articleRelevanceMaxPerRun = Math.max(20, Number(process.env.ARTICLE_RELEVANCE_MAX_PER_RUN || 300));
const dailyRecentLookbackHoursValue = Number(process.env.DAILY_RECENT_LOOKBACK_HOURS || 48);
const dailyRecentLookbackHours = Number.isFinite(dailyRecentLookbackHoursValue)
  ? Math.max(24, dailyRecentLookbackHoursValue)
  : 48;
const dailyDefaultWindow = ["calendar", "last24h"].includes(process.env.DAILY_DEFAULT_WINDOW)
  ? process.env.DAILY_DEFAULT_WINDOW
  : "last24h";
const feedFetchConcurrency = Math.max(1, Number(process.env.FEED_FETCH_CONCURRENCY || 12));
const dbConfig = {
  host: process.env.DATABASE_HOST || "127.0.0.1",
  port: Number(process.env.DATABASE_PORT || 3306),
  user: process.env.DATABASE_USER || "root",
  password: process.env.DATABASE_PASSWORD || "",
  database: process.env.DATABASE_NAME || "yimin_ai_hot",
  mysqlBin: process.env.MYSQL_BIN || "mysql",
};
const werssDbConfig = {
  host: process.env.WERSS_DATABASE_HOST || dbConfig.host,
  port: Number(process.env.WERSS_DATABASE_PORT || dbConfig.port),
  user: process.env.WERSS_DATABASE_USER || dbConfig.user,
  password: process.env.WERSS_DATABASE_PASSWORD || dbConfig.password,
  database: process.env.WERSS_DATABASE_NAME || "",
  mysqlBin: process.env.WERSS_MYSQL_BIN || dbConfig.mysqlBin,
};

const deepseekConfig = {
  apiKey: process.env.DEEPSEEK_API_KEY || "",
  baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
  model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
};
const hColumnConfig = {
  enabled: process.env.H_COLUMN_ENABLED !== "0",
  maxTopics: Math.min(3, Math.max(1, Number(process.env.H_COLUMN_DAILY_MAX_TOPICS || 3))),
  model: process.env.H_COLUMN_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-chat",
  reviewModel: process.env.H_COLUMN_REVIEW_MODEL || process.env.H_COLUMN_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-chat",
  preGenerateModes: String(process.env.H_COLUMN_PREGENERATE_MODES || "wechat_article,short_video,run_and_talk_video,deep_video")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  preGenerateConcurrency: Math.min(3, Math.max(1, Number(process.env.H_COLUMN_PREGENERATE_CONCURRENCY || 2))),
  preGenerateMaxAttempts: Math.min(4, Math.max(1, Number(process.env.H_COLUMN_PREGENERATE_MAX_ATTEMPTS || 3))),
  preGenerateRetryDelayMs: Math.min(10000, Math.max(0, Number(process.env.H_COLUMN_PREGENERATE_RETRY_DELAY_MS || 2000))),
  ownerUserIds: new Set(String(process.env.H_COLUMN_USER_IDS || "fanrui").split(",").map((value) => value.trim()).filter(Boolean)),
  editorUserIds: new Set(String(process.env.H_COLUMN_EDITOR_USER_IDS || "liangshuang").split(",").map((value) => value.trim()).filter(Boolean)),
  ownerNames: new Set(String(process.env.H_COLUMN_OWNER_NAMES || "Henry范睿,范睿").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)),
  editorNames: new Set(String(process.env.H_COLUMN_EDITOR_NAMES || "Celine梁爽,梁爽").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)),
  departmentNames: new Set(String(process.env.H_COLUMN_DEPARTMENT_NAMES || "IOD").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)),
  autoGenerate: process.env.H_COLUMN_AUTO_GENERATE !== "0",
  skillVersion: process.env.H_COLUMN_SKILL_VERSION || "henry-content-v1",
  profileVersion: process.env.H_COLUMN_PROFILE_VERSION || "approved-profile-2026-07-23",
};
const hFullSourceMinChars = 800;
const marketProjects = [
  { name: "美国 EB-5", country: "美国", keywords: ["eb-5", "eb5", "regional center", "投资"] },
  { name: "美国 NIW / EB-1", country: "美国", keywords: ["niw", "eb-1", "eb1", "national interest waiver"] },
  { name: "加拿大 EE / 省提名", country: "加拿大", keywords: ["express entry", "ee", "pnp", "provincial nominee", "省提名"] },
  { name: "英国工签 / 雇主担保", country: "英国", keywords: ["work visa", "sponsor", "skilled worker", "工签", "雇主"] },
  { name: "澳大利亚技术移民", country: "澳新", keywords: ["australia", "skill", "occupation", "州担保", "职业"] },
  { name: "欧洲投资居留", country: "欧洲", keywords: ["golden visa", "investment", "investor", "投资居留"] },
];
const authConfig = {
  user: process.env.AUTH_USER || "admin",
  pass: process.env.AUTH_PASS || "admin123",
};
const ssoConfig = {
  secretKey: process.env.SSO_SECRET_KEY || "GlobeVisa_SSO_2026_SecretKey!@#",
  ivSeed: process.env.SSO_IV_SEED || "globevisa_sso_iv",
};
const localTestSsoConfig = {
  enabled:
    process.env.LOCAL_TEST_SSO_ENABLED === "1"
    && process.env.NODE_ENV !== "production",
  userId: String(process.env.LOCAL_TEST_SSO_USER_ID || "").trim().slice(0, 128),
  userName: String(process.env.LOCAL_TEST_SSO_USER_NAME || "").trim().slice(0, 160),
  departmentName: String(process.env.LOCAL_TEST_SSO_DEPARTMENT_NAME || "").trim().slice(0, 160),
  departmentIds: String(process.env.LOCAL_TEST_SSO_DEPARTMENT_IDS || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0),
};
const peerCompetitorSeeds = [
  {
    code: "peer-a",
    displayName: "同行A",
    privateName: "桉侨移民",
    privateDomain: "aqyimin.com",
    brandTerms: ["桉侨移民", "桉侨", "ANQIAO"],
    rssUrl: "https://ai.globevisa.space/feed/MP_WXS_3625711724.rss",
    providerNickname: "深圳桉侨移民",
    providerLookupMode: "nickname",
  },
  {
    code: "peer-b",
    displayName: "同行B",
    privateName: "景鸿集团（景鸿移民）",
    privateDomain: "ekimmigration.com",
    brandTerms: ["景鸿集团", "景鸿移民", "景鸿"],
    rssUrl: "https://ai.globevisa.space/feed/MP_WXS_3087573428.rss",
    providerNickname: "景鸿移民服务号",
  },
  {
    code: "peer-c",
    displayName: "同行C",
    privateName: "侨外出国（侨外移民）",
    privateDomain: "iqiaowai.com",
    brandTerms: ["侨外出国", "侨外移民", "侨外"],
    rssUrl: "https://ai.globevisa.space/feed/MP_WXS_3639875067.rss",
    providerNickname: "侨外移民",
  },
  {
    code: "peer-d",
    displayName: "同行D",
    privateName: "亨瑞集团（亨瑞移民）",
    privateDomain: "visa800.com",
    brandTerms: ["亨瑞集团", "亨瑞移民", "亨瑞"],
    rssUrl: "https://ai.globevisa.space/feed/MP_WXS_2390329593.rss",
    providerGhid: "henrygroup1992",
    providerNickname: "亨瑞出国",
  },
  {
    code: "peer-e",
    displayName: "同行E",
    privateName: "世贸通集团（世贸通移民）",
    privateDomain: "worldwayhk.com",
    brandTerms: ["世贸通集团", "世贸通移民", "世贸通"],
    rssUrl: "https://ai.globevisa.space/feed/MP_WXS_2395537072.rss",
    providerNickname: "世贸通移民",
  },
  {
    code: "peer-f",
    displayName: "同行F",
    privateName: "澳星集团（澳星出国）",
    privateDomain: "austargroup.com",
    brandTerms: ["澳星集团", "澳星出国", "澳星"],
    rssUrl: "https://ai.globevisa.space/feed/MP_WXS_3687013568.rss",
    providerNickname: "澳星出国",
  },
  {
    code: "peer-g",
    displayName: "同行G",
    privateName: "和中移民（WellTrend）",
    privateDomain: "welltrendvisa.com",
    brandTerms: ["和中移民", "和中", "WellTrend"],
    rssUrl: "https://ai.globevisa.space/feed/MP_WXS_3903727517.rss",
    providerNickname: "和中移民出国",
  },
  {
    code: "peer-h",
    displayName: "同行H",
    privateName: "外联出国（外联移民）",
    privateDomain: "wailianvisa.com",
    brandTerms: ["外联出国", "外联移民", "外联"],
    rssUrl: "https://ai.globevisa.space/feed/MP_WXS_2396409440.rss",
    providerNickname: "外联出国",
  },
  {
    code: "peer-i",
    displayName: "同行I",
    privateName: "兆龙移民（兆龙出国）",
    privateDomain: "zlglobal.net",
    brandTerms: ["兆龙移民", "兆龙出国", "兆龙"],
    rssUrl: "https://ai.globevisa.space/feed/MP_WXS_3081660335.rss",
    providerNickname: "兆龙移民",
  },
];
const peerMonitorConfig = {
  openAccess: process.env.PEER_MONITOR_OPEN_ACCESS !== "0",
  allowedUserIds: new Set(
    ["fanrui", ...String(process.env.PEER_MONITOR_USER_IDS || "").split(",")]
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  ),
  allowedDepartmentNames: new Set(
    ["iod", "md", ...String(process.env.PEER_MONITOR_DEPARTMENT_NAMES || "").split(",")]
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  ),
  seedPath: join(rootDir, "data", "peer-monitor-projects.json"),
};
const peerWechatDiscoveryConfig = {
  providerUrl: process.env.DAJIALA_HISTORY_URL || "https://www.dajiala.com/fbmain/monitor/v3/history_by_ghid",
  apiKey: process.env.DAJIALA_API_KEY || "",
  verifyCode: process.env.DAJIALA_VERIFYCODE || "",
  cronToken: process.env.PEER_DISCOVERY_CRON_TOKEN || "",
  requestTimeoutMs: getBoundedConfigNumber(process.env.DAJIALA_TIMEOUT_MS, 30_000, 3_000, 120_000),
  minIntervalMs: getBoundedConfigNumber(process.env.DAJIALA_MIN_INTERVAL_MS, 600, 500, 10_000),
  maxPagesPerAccount: getBoundedConfigNumber(process.env.PEER_DISCOVERY_MAX_PAGES_PER_ACCOUNT, 3, 1, 20),
  maxCostPerRun: Number.isFinite(Number(process.env.PEER_DISCOVERY_MAX_COST_PER_RUN || 5))
    ? Math.max(0, Number(process.env.PEER_DISCOVERY_MAX_COST_PER_RUN || 5))
    : 5,
};
function getBoundedConfigNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

const firecrawlConfig = {
  apiKeys: getFirecrawlApiKeys(),
  baseUrl: "https://api.firecrawl.dev/v1",
  requestsPerMinute: getBoundedConfigNumber(
    process.env.FIRECRAWL_REQUESTS_PER_MINUTE,
    8,
    1,
    9,
  ),
  maxRateLimitRetries: getBoundedConfigNumber(
    process.env.FIRECRAWL_MAX_RATE_LIMIT_RETRIES,
    3,
    0,
    5,
  ),
  retryJitterMs: getBoundedConfigNumber(
    process.env.FIRECRAWL_RETRY_JITTER_MS,
    1500,
    0,
    10000,
  ),
};
let firecrawlApiKeyIndex = 0;
let firecrawlQueueTail = Promise.resolve();
let firecrawlNextRequestAt = 0;
const sessions = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

let cache = null;
let dbReadyPromise = null;
let activeFetchRun = null;
let activeArticleTranslationPromise = null;
let activeArticleRelevancePromise = null;
let activePeerRefresh = null;
let activePeerWechatDiscovery = null;
const activePeerWebsiteImports = new Map();
let peerDiscoveryNextProviderRequestAt = 0;
const dailyReportGenerationPromises = new Map();
const dailyLocalizationGenerationPromises = new Map();
const departmentDailyGenerationPromises = new Map();
const allDepartmentDailyGenerationPromises = new Map();

async function loadEnv() {
  const envPath = join(rootDir, ".env");
  if (!existsSync(envPath)) {
    return;
  }

  const raw = await readFile(envPath, "utf8");
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const index = trimmed.indexOf("=");
    if (index === -1) {
      return;
    }

    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  });
}

function getFirecrawlApiKeys() {
  const numberedKeys = Object.entries(process.env)
    .map(([name, value]) => {
      const match = name.match(/^FIRECRAWL_API_KEY_?(\d+)$/);
      return match ? { order: Number(match[1]), value } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.order - right.order)
    .map(({ value }) => value);

  const keys = [
    process.env.FIRECRAWL_API_KEY,
    process.env.FIRECRAWL_API_KEYS,
    ...numberedKeys,
  ]
    .flatMap((value) => String(value || "").split(/[,;\s]+/))
    .map((value) => value.trim())
    .filter(Boolean);

  return [...new Set(keys)];
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sqlIdentifier(value) {
  return `\`${String(value).replace(/`/g, "``")}\``;
}

function sqlString(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }

  return `'${String(value)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''")
    .replace(/\u0000/g, "")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")}'`;
}

function sqlNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : String(fallback);
}

function sqlDate(value) {
  if (!value) {
    return "NULL";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "NULL";
  }

  const pad = (n) => String(n).padStart(2, "0");
  const bj = new Date(date.getTime() + 8 * 3600000 + date.getTimezoneOffset() * 60000);
  return sqlString(`${bj.getFullYear()}-${pad(bj.getMonth() + 1)}-${pad(bj.getDate())} ${pad(bj.getHours())}:${pad(bj.getMinutes())}:${pad(bj.getSeconds())}`);
}

function sqlJson(value) {
  return `CAST(${sqlString(JSON.stringify(value ?? null))} AS JSON)`;
}

function getClientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "";
}

function getPublicOrigin(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || "").trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      return configured.replace(/\/+$/, "");
    }
  }

  const proto = req.headers["x-forwarded-proto"]?.split(",")[0]?.trim()
    || (req.socket?.encrypted ? "https" : "http");
  const host = req.headers["x-forwarded-host"]?.split(",")[0]?.trim()
    || req.headers.host
    || "";
  return host ? `${proto}://${host}` : "";
}

function buildPublicUrl(req, path = "/") {
  const origin = getPublicOrigin(req);
  const cleanPath = String(path || "/").startsWith("/") ? String(path || "/") : `/${path}`;
  return origin ? `${origin}${cleanPath}` : cleanPath;
}

function getSsoKeyBuffer() {
  const source = Buffer.from(ssoConfig.secretKey, "utf8");
  if (source.length === 32) {
    return source;
  }

  const key = Buffer.alloc(32);
  source.copy(key, 0, 0, Math.min(source.length, 32));
  return key;
}

function base64UrlToBuffer(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function decryptSsoValue(encParam, fieldName) {
  const encrypted = base64UrlToBuffer(encParam);
  if (!encrypted.length) {
    throw new Error(`${fieldName} is empty`);
  }

  const iv = createHash("sha256").update(ssoConfig.ivSeed).digest("hex").slice(0, 16);
  const decipher = createDecipheriv("aes-256-cbc", getSsoKeyBuffer(), Buffer.from(iv, "utf8"));
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8").trim();
  if (!decrypted) {
    throw new Error(`decrypted ${fieldName} is empty`);
  }
  return decrypted;
}

function decryptSsoUserName(encParam) {
  return decryptSsoValue(encParam, "user name");
}

function decryptSsoUserId(encParam) {
  return decryptSsoValue(encParam, "user id");
}

function mysqlRunWithConfig(config, sql, { database = true, json = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const args = [
      `-h${config.host}`,
      `-P${config.port}`,
      `-u${config.user}`,
      "--default-character-set=utf8mb4",
      "--connect-timeout=5",
      "--batch",
      "--raw",
    ];

    if (json) {
      args.push("--skip-column-names");
    }

    if (database) {
      args.push(config.database);
    }

    const child = spawn(config.mysqlBin, args, {
      env: {
        ...process.env,
        MYSQL_PWD: config.password,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }

      reject(new Error(stderr.trim() || `mysql exited with code ${code}`));
    });
    // DATETIME columns store Beijing wall time; keep MySQL-generated times aligned with sqlDate().
    child.stdin.end(`SET time_zone = '+08:00';\n${sql}`);
  });
}

function mysqlRun(sql, options) {
  return mysqlRunWithConfig(dbConfig, sql, options);
}

async function mysqlExec(sql, options) {
  await mysqlRun(sql, options);
}

async function mysqlJson(sql, options) {
  const stdout = await mysqlRun(sql, { ...options, json: true });
  const trimmed = stdout.trim();
  if (!trimmed || trimmed.toUpperCase() === "NULL") {
    return null;
  }

  return JSON.parse(trimmed);
}

async function mysqlJsonRows(sql, options) {
  const stdout = await mysqlRun(sql, { ...options, json: true });
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  return trimmed
    .split(/\r?\n/)
    .filter((line) => line.trim() && line.trim().toUpperCase() !== "NULL")
    .map((line) => JSON.parse(line));
}

async function werssMysqlExec(sql, options) {
  await mysqlRunWithConfig(werssDbConfig, sql, options);
}

async function werssMysqlJson(sql, options) {
  const stdout = await mysqlRunWithConfig(werssDbConfig, sql, { ...options, json: true });
  const trimmed = stdout.trim();
  if (!trimmed || trimmed.toUpperCase() === "NULL") return null;
  return JSON.parse(trimmed);
}

async function initDb() {
  if (!dbReadyPromise) {
    dbReadyPromise = (async () => {
      await mysqlExec(
        `CREATE DATABASE IF NOT EXISTS ${sqlIdentifier(dbConfig.database)}
         DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;`,
        { database: false },
      );

      await mysqlExec(`
        CREATE TABLE IF NOT EXISTS yimin_sources (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          name VARCHAR(160) NOT NULL COMMENT '来源名称',
          url VARCHAR(1200) NOT NULL COMMENT 'RSS 订阅地址',
          country VARCHAR(80) NOT NULL COMMENT '所属国家/地区',
          category VARCHAR(120) NOT NULL COMMENT '分类（如政策、签证、生活等）',
          priority INT NOT NULL DEFAULT 70 COMMENT '优先级 0-100，越高越重要',
          type VARCHAR(20) NOT NULL DEFAULT 'rss' COMMENT '来源类型（rss/twitter/html/json/website）',
          enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否启用（1=启用 0=禁用）',
          public_daily_enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否进入公共日报（1=公开 0=仅订阅部门）',
          public_daily_exclusion_reason VARCHAR(255) NULL COMMENT '不进入公共日报的原因',
          public_daily_updated_by VARCHAR(160) NULL COMMENT '最后调整公共日报范围的管理员',
          public_daily_updated_at DATETIME NULL COMMENT '最后调整公共日报范围的时间',
          last_fetched_at DATETIME NULL COMMENT '最后一次抓取时间',
          last_fetch_error TEXT NULL COMMENT '最后一次抓取错误信息',
          daily_baseline_at DATETIME NULL COMMENT '日报基线抓取完成时间',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          UNIQUE KEY uk_sources_url (url(768)),
          INDEX idx_sources_enabled (enabled),
          INDEX idx_sources_public_daily (enabled, public_daily_enabled),
          INDEX idx_sources_country (country)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='RSS 信息来源配置表';

        CREATE TABLE IF NOT EXISTS yimin_articles (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          source_id BIGINT NOT NULL COMMENT '来源 ID，关联 sources 表',
          dedupe_hash CHAR(40) NOT NULL COMMENT '去重哈希（SHA1），防止重复入库',
          title VARCHAR(600) NOT NULL COMMENT '文章标题',
          summary TEXT NULL COMMENT '文章摘要',
          url VARCHAR(1400) NULL COMMENT '文章原文链接',
          country VARCHAR(80) NOT NULL COMMENT '所属国家/地区',
          country_en VARCHAR(120) NULL COMMENT '所属国家/地区英文名',
          category VARCHAR(120) NOT NULL COMMENT '分类（如政策、签证、生活等）',
          category_en VARCHAR(160) NULL COMMENT '分类英文名',
          tags_json JSON NULL COMMENT '标签列表，JSON 数组格式',
          tags_en_json JSON NULL COMMENT '英文标签列表，JSON 数组格式',
          image VARCHAR(1000) NULL COMMENT '文章配图 URL',
          heat INT NOT NULL DEFAULT 60 COMMENT '热度评分 0-100',
          impact VARCHAR(40) NOT NULL DEFAULT '中影响' COMMENT '影响力等级（高影响/中影响/低影响）',
          impact_en VARCHAR(60) NULL COMMENT '影响力等级英文',
          published_at DATETIME NULL COMMENT '文章发布时间',
          fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '抓取入库时间',
          daily_excluded TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否排除出日报候选',
          daily_excluded_reason VARCHAR(160) NULL COMMENT '排除出日报候选的原因',
          raw_json JSON NULL COMMENT '原始 RSS 条目 JSON 数据',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          UNIQUE KEY uk_articles_hash (dedupe_hash),
          INDEX idx_articles_published (published_at),
          INDEX idx_articles_daily_candidate (daily_excluded, published_at, fetched_at),
          INDEX idx_articles_heat (heat),
          INDEX idx_articles_country (country),
          CONSTRAINT fk_articles_source FOREIGN KEY (source_id) REFERENCES yimin_sources(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='新闻文章表';

        CREATE TABLE IF NOT EXISTS yimin_fetch_runs (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '抓取开始时间',
          finished_at DATETIME NULL COMMENT '抓取完成时间',
          status ENUM('running','completed','failed') NOT NULL DEFAULT 'running' COMMENT '运行状态（running=进行中 completed=完成 failed=失败）',
          source_count INT NOT NULL DEFAULT 0 COMMENT '本轮抓取的来源数量',
          processed_source_count INT NOT NULL DEFAULT 0 COMMENT '已处理来源数量',
          success_source_count INT NOT NULL DEFAULT 0 COMMENT '成功来源数量',
          failed_source_count INT NOT NULL DEFAULT 0 COMMENT '失败来源数量',
          item_count INT NOT NULL DEFAULT 0 COMMENT '本轮抓取的文章数量',
          error TEXT NULL COMMENT '错误信息'
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='RSS 抓取运行记录表';

        CREATE TABLE IF NOT EXISTS yimin_daily_reports (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          report_date DATE NOT NULL COMMENT '报告日期',
          window_start_at DATETIME NULL COMMENT '日报统计窗口开始时间',
          window_end_at DATETIME NULL COMMENT '日报统计窗口结束时间',
          window_mode VARCHAR(20) NOT NULL DEFAULT 'calendar' COMMENT '日报统计窗口模式（calendar/last24h）',
          title VARCHAR(200) NOT NULL COMMENT '报告标题',
          content_markdown LONGTEXT NOT NULL COMMENT '报告 Markdown 原文',
          content_html LONGTEXT NOT NULL COMMENT '报告 HTML 内容',
          source_item_count INT NOT NULL DEFAULT 0 COMMENT '本日报引用的文章数量',
          relevant_item_count INT NOT NULL DEFAULT 0 COMMENT '与移民主题相关的文章数量',
          event_count INT NOT NULL DEFAULT 0 COMMENT '聚合后的事件数量',
          model VARCHAR(120) NULL COMMENT '生成报告所用的 AI 模型名称',
          generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '报告生成时间',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          UNIQUE KEY uk_yimin_daily_reports_date (report_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI 每日移民报告表';

        CREATE TABLE IF NOT EXISTS yimin_daily_report_localizations (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          report_id BIGINT NOT NULL COMMENT '主日报 ID',
          language VARCHAR(10) NOT NULL COMMENT '本地化语言（如 en）',
          title VARCHAR(200) NOT NULL COMMENT '本地化标题',
          content_markdown LONGTEXT NOT NULL COMMENT '本地化 Markdown 原文',
          content_html LONGTEXT NOT NULL COMMENT '本地化 HTML 内容',
          input_hash CHAR(64) NOT NULL COMMENT '生成输入哈希',
          model VARCHAR(120) NULL COMMENT '生成所用 AI 模型名称',
          generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '生成时间',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          UNIQUE KEY uk_daily_report_localization (report_id, language),
          INDEX idx_daily_report_localizations_language (language),
          CONSTRAINT fk_daily_report_localizations_report FOREIGN KEY (report_id) REFERENCES yimin_daily_reports(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='日报多语言本地化内容表';

        CREATE TABLE IF NOT EXISTS yimin_daily_report_items (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          report_id BIGINT NOT NULL COMMENT '日报 ID',
          article_hash CHAR(40) NOT NULL COMMENT '文章去重哈希',
          topic_key VARCHAR(160) NOT NULL COMMENT '归一化主题 Key',
          event_key VARCHAR(160) NOT NULL DEFAULT '' COMMENT '聚合事件 Key',
          section VARCHAR(40) NOT NULL COMMENT '日报分组（today_new/important/continuing/repeated）',
          relevant TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否与日报主题相关',
          importance INT NOT NULL DEFAULT 0 COMMENT '文章重要度 0-100',
          article_date DATETIME NULL COMMENT '文章发布时间或抓取时间',
          article_snapshot JSON NOT NULL COMMENT '文章快照',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          UNIQUE KEY uk_daily_report_item (report_id, article_hash, section),
          INDEX idx_daily_report_items_hash (article_hash),
          INDEX idx_daily_report_items_topic (topic_key),
          INDEX idx_daily_report_items_event (event_key),
          INDEX idx_daily_report_items_section (section),
          CONSTRAINT fk_daily_report_items_report FOREIGN KEY (report_id) REFERENCES yimin_daily_reports(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='日报引用文章明细表';

        CREATE TABLE IF NOT EXISTS yimin_article_daily_analysis (
          article_hash CHAR(40) PRIMARY KEY COMMENT '文章去重哈希',
          content_hash CHAR(64) NOT NULL COMMENT '参与分析的内容哈希',
          analysis_version VARCHAR(40) NOT NULL COMMENT '分析逻辑版本',
          relevant TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否与移民主题相关',
          importance INT NOT NULL DEFAULT 0 COMMENT '重要度 0-100',
          canonical_topic VARCHAR(300) NOT NULL COMMENT '规范化事件主题',
          summary_zh TEXT NULL COMMENT '中文结构化摘要',
          country VARCHAR(80) NULL COMMENT 'AI 识别国家/地区',
          category VARCHAR(120) NULL COMMENT 'AI 识别分类',
          impact VARCHAR(80) NULL COMMENT 'AI 识别影响等级',
          model VARCHAR(120) NULL COMMENT '分析模型',
          analyzed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '分析时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          INDEX idx_article_daily_analysis_relevant (relevant, importance),
          INDEX idx_article_daily_analysis_version (analysis_version)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='文章级日报分析缓存';

        CREATE TABLE IF NOT EXISTS yimin_article_translations (
          article_hash CHAR(40) PRIMARY KEY COMMENT '文章去重哈希',
          content_hash CHAR(64) NOT NULL COMMENT '参与翻译的内容哈希',
          translation_version VARCHAR(40) NOT NULL COMMENT '翻译逻辑版本',
          source_title VARCHAR(600) NOT NULL COMMENT '翻译时的原始标题',
          source_summary TEXT NULL COMMENT '翻译时的原始简介',
          title_zh VARCHAR(600) NULL COMMENT '中文标题',
          summary_zh TEXT NULL COMMENT '中文简介',
          status ENUM('translated','failed') NOT NULL DEFAULT 'translated' COMMENT '翻译状态',
          model VARCHAR(120) NULL COMMENT '翻译模型',
          last_error TEXT NULL COMMENT '最近一次翻译错误',
          translated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '翻译时间',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          INDEX idx_article_translations_status (status, updated_at),
          INDEX idx_article_translations_version (translation_version)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='文章标题和简介中文翻译缓存';

        CREATE TABLE IF NOT EXISTS yimin_daily_report_events (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          report_id BIGINT NOT NULL COMMENT '日报 ID',
          event_key VARCHAR(160) NOT NULL COMMENT '聚合事件 Key',
          section VARCHAR(40) NOT NULL COMMENT '日报分组',
          title VARCHAR(600) NOT NULL COMMENT '事件标题',
          summary TEXT NULL COMMENT '事件摘要',
          country VARCHAR(80) NULL COMMENT '国家/地区',
          category VARCHAR(120) NULL COMMENT '分类',
          importance INT NOT NULL DEFAULT 0 COMMENT '事件重要度',
          article_count INT NOT NULL DEFAULT 0 COMMENT '包含文章数量',
          source_count INT NOT NULL DEFAULT 0 COMMENT '包含信源数量',
          representative_url VARCHAR(1400) NULL COMMENT '代表文章链接',
          article_hashes_json JSON NOT NULL COMMENT '关联文章哈希',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          UNIQUE KEY uk_daily_report_event (report_id, event_key),
          INDEX idx_daily_report_events_section (report_id, section, importance),
          CONSTRAINT fk_daily_report_events_report FOREIGN KEY (report_id) REFERENCES yimin_daily_reports(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='日报聚合事件';

        CREATE TABLE IF NOT EXISTS yimin_source_submissions (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          name VARCHAR(160) NOT NULL COMMENT '提交的来源名称',
          url VARCHAR(1200) NOT NULL COMMENT '提交的 RSS 地址',
          topic VARCHAR(200) NULL COMMENT '相关主题描述',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '提交时间',
          status ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending' COMMENT '审核状态（pending=待审核 accepted=已采纳 rejected=已拒绝）',
          INDEX idx_yimin_source_submissions_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户提交的信息来源表';

        CREATE TABLE IF NOT EXISTS yimin_feedback (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          type VARCHAR(120) NOT NULL COMMENT '反馈类型（如建议、Bug、投诉等）',
          module VARCHAR(120) NOT NULL DEFAULT '' COMMENT '反馈相关页面或模块',
          priority VARCHAR(40) NOT NULL DEFAULT 'normal' COMMENT '反馈优先级',
          message TEXT NULL COMMENT '反馈内容',
          contact VARCHAR(160) NULL COMMENT '联系方式',
          created_by VARCHAR(160) NOT NULL DEFAULT '' COMMENT '反馈人',
          status ENUM('new','reviewed','resolved','archived') NOT NULL DEFAULT 'new' COMMENT '处理状态',
          admin_note TEXT NULL COMMENT '管理员备注',
          page_url VARCHAR(1200) NULL COMMENT '提交页面地址',
          user_agent VARCHAR(600) NULL COMMENT '浏览器 UA',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '反馈时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          INDEX idx_yimin_feedback_status (status),
          INDEX idx_yimin_feedback_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户反馈表';

        CREATE TABLE IF NOT EXISTS yimin_market_reports (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          report_date DATE NOT NULL COMMENT '素材日报日期',
          title VARCHAR(200) NOT NULL COMMENT '素材日报标题',
          summary_json JSON NOT NULL COMMENT '素材日报统计信息',
          generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '生成时间',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          UNIQUE KEY uk_yimin_market_reports_date (report_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='市场素材日报表';

        CREATE TABLE IF NOT EXISTS yimin_market_materials (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          report_id BIGINT NOT NULL COMMENT '市场素材日报 ID',
          article_hash CHAR(40) NOT NULL COMMENT '文章去重哈希',
          section VARCHAR(40) NOT NULL COMMENT '素材分组（today_new/continuing/not_recommended）',
          project_name VARCHAR(160) NOT NULL COMMENT '匹配项目名称',
          market_score INT NOT NULL DEFAULT 0 COMMENT '市场素材评分',
          freshness_type VARCHAR(40) NOT NULL COMMENT '新鲜度类型',
          recommended_title VARCHAR(600) NOT NULL COMMENT '推荐发布标题',
          channels_json JSON NOT NULL COMMENT '推荐发布渠道',
          angle TEXT NULL COMMENT '推荐角度',
          customer_impact TEXT NULL COMMENT '客户影响',
          sales_talk TEXT NULL COMMENT '销售话术',
          risk_note TEXT NULL COMMENT '风险提醒',
          article_snapshot JSON NOT NULL COMMENT '文章快照',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          UNIQUE KEY uk_yimin_market_material (report_id, article_hash, section),
          INDEX idx_yimin_market_materials_article (article_hash),
          INDEX idx_yimin_market_materials_section (section),
          CONSTRAINT fk_market_material_report FOREIGN KEY (report_id) REFERENCES yimin_market_reports(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='市场素材明细表';

        CREATE TABLE IF NOT EXISTS yimin_market_project_status (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          report_id BIGINT NOT NULL COMMENT '市场素材日报 ID',
          project_name VARCHAR(160) NOT NULL COMMENT '项目名称',
          country VARCHAR(80) NOT NULL COMMENT '所属国家/地区',
          matched_count INT NOT NULL DEFAULT 0 COMMENT '匹配文章数量',
          latest_article_at DATETIME NULL COMMENT '最近有效文章时间',
          suggestion TEXT NULL COMMENT '市场建议',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          UNIQUE KEY uk_yimin_market_project_status (report_id, project_name),
          CONSTRAINT fk_market_project_report FOREIGN KEY (report_id) REFERENCES yimin_market_reports(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='市场素材项目更新状态表';

        CREATE TABLE IF NOT EXISTS yimin_market_feedback (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          article_hash CHAR(40) NOT NULL COMMENT '文章去重哈希',
          action ENUM('useful','later','used','useless') NOT NULL COMMENT '市场部反馈动作',
          note TEXT NULL COMMENT '反馈备注',
          created_by VARCHAR(120) NULL COMMENT '反馈人',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '首次反馈时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          UNIQUE KEY uk_yimin_market_feedback_article (article_hash),
          INDEX idx_yimin_market_feedback_action (action)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='市场素材反馈表';

        CREATE TABLE IF NOT EXISTS yimin_changelog (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          log_date VARCHAR(40) NOT NULL COMMENT '显示日期',
          title VARCHAR(200) NOT NULL COMMENT '更新标题',
          description TEXT NULL COMMENT '更新描述',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          INDEX idx_yimin_changelog_created (created_at DESC)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='更新日志表';

        CREATE TABLE IF NOT EXISTS yimin_push_tasks (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          push_date DATE NOT NULL COMMENT '推送日期',
          daily_date DATE NOT NULL COMMENT '日报日期',
          status ENUM('pending','running','completed','partial_failed','failed') NOT NULL DEFAULT 'pending' COMMENT '批次状态',
          total_count INT NOT NULL DEFAULT 0 COMMENT '目标人数',
          sent_count INT NOT NULL DEFAULT 0 COMMENT '已发送',
          failed_count INT NOT NULL DEFAULT 0 COMMENT '发送失败',
          visited_count INT NOT NULL DEFAULT 0 COMMENT '已访问',
          error TEXT NULL COMMENT '错误信息',
          started_at DATETIME NULL COMMENT '开始时间',
          finished_at DATETIME NULL COMMENT '完成时间',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          UNIQUE KEY uk_push_tasks_date (push_date),
          INDEX idx_push_tasks_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='日报推送批次表';

        CREATE TABLE IF NOT EXISTS yimin_push_logs (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          task_id BIGINT NOT NULL COMMENT '推送批次 ID',
          userid VARCHAR(128) NOT NULL COMMENT '企业微信 userid',
          username VARCHAR(128) NOT NULL DEFAULT '' COMMENT '用户姓名',
          token CHAR(12) NOT NULL COMMENT '访问令牌',
          send_status ENUM('pending','sent','failed') NOT NULL DEFAULT 'pending' COMMENT '发送状态',
          sent_at DATETIME NULL COMMENT '发送时间',
          visit_at DATETIME NULL COMMENT '首次访问时间',
          visit_ip VARCHAR(45) NULL COMMENT '访问 IP',
          error TEXT NULL COMMENT '发送错误信息',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          UNIQUE KEY uk_push_logs_token (token),
          INDEX idx_push_logs_task (task_id),
          INDEX idx_push_logs_userid (userid),
          CONSTRAINT fk_push_logs_task FOREIGN KEY (task_id) REFERENCES yimin_push_tasks(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='日报推送日志表';

        CREATE TABLE IF NOT EXISTS yimin_push_open_events (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          token CHAR(12) NOT NULL COMMENT '日报访问令牌',
          event_name VARCHAR(80) NOT NULL DEFAULT '' COMMENT '打开默认浏览器事件',
          event_detail TEXT NULL COMMENT '事件详情',
          client_ip VARCHAR(45) NULL COMMENT '访问 IP',
          user_agent VARCHAR(600) NULL COMMENT '浏览器 UA',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '事件时间',
          INDEX idx_push_open_events_token (token),
          INDEX idx_push_open_events_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='日报链接打开默认浏览器诊断事件表';

        CREATE TABLE IF NOT EXISTS yimin_wx_token_cache (
          id INT AUTO_INCREMENT PRIMARY KEY,
          access_token VARCHAR(512) NOT NULL COMMENT '企业微信 access_token',
          ticket VARCHAR(512) NULL COMMENT '企业微信 JS-SDK ticket',
          expires_at DATETIME NOT NULL COMMENT '过期时间',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '缓存时间'
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='企业微信令牌缓存';

        CREATE TABLE IF NOT EXISTS yimin_sso_login_logs (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          user_name VARCHAR(160) NOT NULL COMMENT '企业微信登录人姓名',
          user_id VARCHAR(128) NULL COMMENT '企业微信登录人 UserID（拼音名）',
          enc_hash CHAR(64) NOT NULL COMMENT '加密参数 SHA256，用于去重排查',
          user_id_enc_hash CHAR(64) NULL COMMENT '加密 UserID 参数 SHA256，用于去重排查',
          route VARCHAR(120) NOT NULL DEFAULT '' COMMENT '访问的前端路由',
          page_url VARCHAR(1200) NULL COMMENT '前端完整地址',
          client_ip VARCHAR(45) NULL COMMENT '访问 IP',
          user_agent VARCHAR(600) NULL COMMENT '浏览器 UA',
          visit_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '访问时间',
          INDEX idx_sso_login_visit_at (visit_at),
          INDEX idx_sso_login_user_name (user_name),
          INDEX idx_sso_login_user_id (user_id),
          INDEX idx_sso_login_enc_hash (enc_hash)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='企业微信 SSO 访问登记日志表';

        CREATE TABLE IF NOT EXISTS yimin_wx_users (
          userid VARCHAR(128) PRIMARY KEY COMMENT '企业微信 UserID',
          user_name VARCHAR(160) NOT NULL DEFAULT '' COMMENT '企业微信用户姓名',
          departments_json JSON NULL COMMENT '所属部门，预留企业微信同步',
          first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '首次识别时间',
          last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '最近识别时间',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          INDEX idx_wx_users_name (user_name),
          INDEX idx_wx_users_last_seen (last_seen_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='企业微信用户身份表';

        CREATE TABLE IF NOT EXISTS yimin_user_source_subscriptions (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          userid VARCHAR(128) NOT NULL COMMENT '企业微信 UserID',
          source_id BIGINT NOT NULL COMMENT '关注的信源 ID',
          status ENUM('subscribed','muted') NOT NULL DEFAULT 'subscribed' COMMENT '订阅状态',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          UNIQUE KEY uk_user_source_subscription (userid, source_id),
          INDEX idx_user_source_status (userid, status),
          INDEX idx_subscription_source (source_id),
          CONSTRAINT fk_subscription_user FOREIGN KEY (userid) REFERENCES yimin_wx_users(userid) ON DELETE CASCADE,
          CONSTRAINT fk_subscription_source FOREIGN KEY (source_id) REFERENCES yimin_sources(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户信源关注配置表';

        CREATE TABLE IF NOT EXISTS yimin_wx_departments (
          department_id BIGINT PRIMARY KEY COMMENT '企业微信部门 ID',
          department_name VARCHAR(160) NOT NULL DEFAULT '' COMMENT '部门名称',
          parent_id BIGINT NULL COMMENT '上级部门 ID',
          sort_order BIGINT NOT NULL DEFAULT 0 COMMENT '企业微信部门排序',
          synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '最近同步时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          INDEX idx_wx_departments_parent (parent_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='企业微信部门表';

        CREATE TABLE IF NOT EXISTS yimin_department_source_subscriptions (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          department_id BIGINT NOT NULL COMMENT '企业微信部门 ID',
          source_id BIGINT NOT NULL COMMENT '部门默认关注的信源 ID',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          UNIQUE KEY uk_department_source_subscription (department_id, source_id),
          INDEX idx_department_subscription_source (source_id),
          CONSTRAINT fk_department_subscription_source FOREIGN KEY (source_id) REFERENCES yimin_sources(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='部门默认信源关注配置表';

        CREATE TABLE IF NOT EXISTS yimin_department_daily_reports (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          report_date DATE NOT NULL COMMENT '报告日期',
          department_id BIGINT NOT NULL COMMENT '企业微信直属部门 ID',
          department_name_snapshot VARCHAR(160) NOT NULL COMMENT '生成时的部门名称快照',
          source_config_hash CHAR(64) NOT NULL COMMENT '部门关注信源集合哈希',
          input_hash CHAR(64) NOT NULL COMMENT '输入文章和公共日报内容哈希',
          content_markdown LONGTEXT NOT NULL COMMENT '部门重点 Markdown',
          content_html LONGTEXT NOT NULL COMMENT '部门重点 HTML',
          source_count INT NOT NULL DEFAULT 0 COMMENT '部门关注信源数量',
          article_count INT NOT NULL DEFAULT 0 COMMENT '参与生成的文章数量',
          model VARCHAR(120) NULL COMMENT '生成模型',
          status ENUM('generated','fallback','empty') NOT NULL DEFAULT 'generated' COMMENT '生成状态',
          error TEXT NULL COMMENT '降级或失败原因',
          generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '生成时间',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          UNIQUE KEY uk_department_daily_report (report_date, department_id),
          INDEX idx_department_daily_department (department_id, report_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='部门每日重点报告表';

        CREATE TABLE IF NOT EXISTS yimin_peer_competitors (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          code VARCHAR(32) NOT NULL COMMENT '内部稳定代号',
          display_name VARCHAR(80) NOT NULL COMMENT '前端匿名名称',
          private_name VARCHAR(200) NOT NULL COMMENT '服务端私有真实名称',
          private_domain VARCHAR(255) NOT NULL DEFAULT '' COMMENT '服务端私有官网域名',
          sort_order INT NOT NULL DEFAULT 0 COMMENT '匿名同行排序',
          enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          UNIQUE KEY uk_peer_competitor_code (code),
          INDEX idx_peer_competitor_enabled (enabled, sort_order)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='同行监控匿名档案';

        CREATE TABLE IF NOT EXISTS yimin_peer_sources (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          competitor_id BIGINT NOT NULL COMMENT '同行 ID',
          source_type VARCHAR(32) NOT NULL COMMENT '来源类型（wechat_rss/website_snapshot）',
          private_url VARCHAR(1400) NOT NULL COMMENT '仅服务端使用的来源地址',
          enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
          last_fetched_at DATETIME NULL COMMENT '最近成功刷新时间',
          last_fetch_error TEXT NULL COMMENT '最近刷新错误',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          UNIQUE KEY uk_peer_source_type (competitor_id, source_type),
          INDEX idx_peer_source_enabled (enabled, source_type),
          CONSTRAINT fk_peer_source_competitor FOREIGN KEY (competitor_id) REFERENCES yimin_peer_competitors(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='同行私有数据源';

        CREATE TABLE IF NOT EXISTS yimin_peer_projects (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          competitor_id BIGINT NOT NULL COMMENT '同行 ID',
          source_key CHAR(64) NOT NULL COMMENT '同行、原网址与项目名组合哈希',
          website_source_id BIGINT NULL COMMENT '官网监控来源 ID，静态种子为空',
          source_project_id VARCHAR(512) NULL COMMENT '采集器提供的稳定项目 ID',
          stable_identity VARCHAR(1600) NULL COMMENT '项目稳定身份（id/url）',
          canonical_url VARCHAR(1400) NULL COMMENT '官网证据链接，仅授权接口返回',
          canonical_url_hash CHAR(64) NULL COMMENT '规范化官网链接哈希',
          content_hash CHAR(64) NULL COMMENT '当前实质字段哈希',
          current_version_id BIGINT NULL COMMENT '当前项目版本 ID',
          lifecycle_status ENUM('active','removed') NOT NULL DEFAULT 'active' COMMENT '官网展示状态',
          missing_success_count INT NOT NULL DEFAULT 0 COMMENT '连续成功快照缺失次数',
          first_seen_at DATETIME NULL COMMENT '首次在成功快照中检测到',
          last_seen_at DATETIME NULL COMMENT '最近在成功快照中检测到',
          removed_at DATETIME NULL COMMENT '连续缺失确认时间',
          project_name VARCHAR(600) NOT NULL COMMENT '匿名化项目名称',
          category_raw VARCHAR(160) NOT NULL DEFAULT '' COMMENT '官网原分类的匿名化文本',
          country_normalized VARCHAR(120) NOT NULL DEFAULT '其他' COMMENT '统一国家筛选值',
          introduction LONGTEXT NULL COMMENT '匿名化项目介绍',
          is_investment_project TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否投资类项目',
          investment_amount TEXT NULL COMMENT '匿名化投资金额',
          investment_requirements_json JSON NULL COMMENT '投资要求',
          financial_requirements_json JSON NULL COMMENT '财务要求',
          advantages_json JSON NULL COMMENT '项目优势',
          application_conditions_json JSON NULL COMMENT '申请条件',
          process_summary TEXT NULL COMMENT '流程摘要',
          process_source_type VARCHAR(32) NOT NULL DEFAULT 'missing' COMMENT '流程来源类型',
          process_text LONGTEXT NULL COMMENT '匿名化流程正文',
          application_process_json JSON NULL COMMENT '结构化申请流程',
          handling_process_json JSON NULL COMMENT '结构化办理流程',
          identity_type VARCHAR(160) NULL COMMENT '身份类型',
          residence_requirement TEXT NULL COMMENT '居住要求',
          website_status_note TEXT NULL COMMENT '官网状态提示',
          scraped_at DATETIME NULL COMMENT '来源采集时间',
          seed_hash CHAR(64) NOT NULL COMMENT '当前种子数据哈希',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          UNIQUE KEY uk_peer_project_source (competitor_id, source_key),
          UNIQUE KEY uk_peer_project_website_identity (website_source_id, source_project_id),
          INDEX idx_peer_project_website_url (website_source_id, canonical_url_hash),
          INDEX idx_peer_project_website_state (website_source_id, lifecycle_status, last_seen_at),
          INDEX idx_peer_project_country (competitor_id, country_normalized),
          INDEX idx_peer_project_name (competitor_id, project_name(191)),
          CONSTRAINT fk_peer_project_competitor FOREIGN KEY (competitor_id) REFERENCES yimin_peer_competitors(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='同行官网项目匿名快照';

        CREATE TABLE IF NOT EXISTS yimin_peer_articles (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          source_id BIGINT NOT NULL COMMENT '同行 RSS 来源 ID',
          external_id VARCHAR(255) NOT NULL DEFAULT '' COMMENT 'RSS 稳定文章 ID',
          dedupe_hash CHAR(64) NOT NULL COMMENT '来源与文章标识去重哈希',
          title VARCHAR(800) NOT NULL COMMENT '匿名化文章标题',
          summary TEXT NULL COMMENT '匿名化文章摘要',
          content_text LONGTEXT NULL COMMENT '匿名化纯文本正文',
          private_url VARCHAR(1400) NULL COMMENT '仅服务端保留的文章地址',
          private_image_url VARCHAR(1400) NULL COMMENT '仅服务端保留的封面地址',
          published_at DATETIME NULL COMMENT '文章发布时间',
          first_fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '首次入库时间',
          last_fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '最近抓取时间',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          UNIQUE KEY uk_peer_article_hash (source_id, dedupe_hash),
          INDEX idx_peer_article_published (source_id, published_at),
          CONSTRAINT fk_peer_article_source FOREIGN KEY (source_id) REFERENCES yimin_peer_sources(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='同行公众号文章匿名快照';

        CREATE TABLE IF NOT EXISTS yimin_peer_refresh_runs (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          run_key CHAR(32) NOT NULL COMMENT '前端查询任务标识',
          competitor_code VARCHAR(32) NULL COMMENT '指定同行，空表示全部',
          status ENUM('running','completed','failed') NOT NULL DEFAULT 'running' COMMENT '刷新状态',
          source_count INT NOT NULL DEFAULT 0 COMMENT '来源数量',
          processed_source_count INT NOT NULL DEFAULT 0 COMMENT '已处理来源数量',
          item_count INT NOT NULL DEFAULT 0 COMMENT '读取文章数',
          new_item_count INT NOT NULL DEFAULT 0 COMMENT '新增文章数',
          updated_item_count INT NOT NULL DEFAULT 0 COMMENT '更新文章数',
          error TEXT NULL COMMENT '错误信息',
          started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '开始时间',
          finished_at DATETIME NULL COMMENT '结束时间',
          UNIQUE KEY uk_peer_refresh_run_key (run_key),
          INDEX idx_peer_refresh_started (started_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='同行公众号刷新任务';

        CREATE TABLE IF NOT EXISTS yimin_peer_wechat_accounts (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          source_id BIGINT NOT NULL COMMENT '同行公众号 RSS 来源 ID',
          provider VARCHAR(40) NOT NULL DEFAULT 'dajiala' COMMENT '文章列表供应商',
          lookup_mode ENUM('auto','ghid','url','nickname') NOT NULL DEFAULT 'auto' COMMENT '供应商账号查询方式',
          provider_ghid VARCHAR(255) NOT NULL DEFAULT '' COMMENT '供应商公众号标识',
          provider_nickname VARCHAR(255) NOT NULL DEFAULT '' COMMENT '公众号名称，可作为供应商昵称查询条件',
          werss_feed_id VARCHAR(255) NOT NULL COMMENT 'WeRSS feeds.id',
          enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否参与每日发现',
          last_discovered_at DATETIME NULL COMMENT '最近成功发现时间',
          last_discovery_error TEXT NULL COMMENT '最近发现错误',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          UNIQUE KEY uk_peer_wechat_source (source_id),
          INDEX idx_peer_wechat_enabled (enabled),
          CONSTRAINT fk_peer_wechat_source FOREIGN KEY (source_id) REFERENCES yimin_peer_sources(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='同行公众号付费发现配置';

        CREATE TABLE IF NOT EXISTS yimin_peer_discovery_runs (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          run_key CHAR(32) NOT NULL COMMENT '任务查询标识',
          report_date DATE NOT NULL COMMENT '发现窗口归属日期',
          window_start_at DATETIME NOT NULL COMMENT '窗口开始时间（北京时间）',
          window_end_at DATETIME NOT NULL COMMENT '窗口结束时间（北京时间）',
          competitor_code VARCHAR(32) NULL COMMENT '指定同行，空表示全部',
          status ENUM('running','completed','partial','failed') NOT NULL DEFAULT 'running' COMMENT '任务状态',
          run_mode ENUM('discover','dry_run','retry_cached') NOT NULL DEFAULT 'discover' COMMENT '任务运行模式',
          dry_run TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否仅做配置检查',
          active_lock_key VARCHAR(80) NULL COMMENT '运行中互斥键，结束后清空',
          account_count INT NOT NULL DEFAULT 0 COMMENT '公众号数量',
          processed_account_count INT NOT NULL DEFAULT 0 COMMENT '已处理公众号数量',
          success_account_count INT NOT NULL DEFAULT 0 COMMENT '成功公众号数量',
          failed_account_count INT NOT NULL DEFAULT 0 COMMENT '失败公众号数量',
          page_count INT NOT NULL DEFAULT 0 COMMENT '供应商请求页数',
          provider_article_count INT NOT NULL DEFAULT 0 COMMENT '供应商返回文章数',
          eligible_article_count INT NOT NULL DEFAULT 0 COMMENT '命中窗口的文章数',
          inserted_article_count INT NOT NULL DEFAULT 0 COMMENT '写入 WeRSS 新文章数',
          updated_article_count INT NOT NULL DEFAULT 0 COMMENT '更新 WeRSS 元数据数',
          skipped_article_count INT NOT NULL DEFAULT 0 COMMENT '跳过文章数',
          total_cost DECIMAL(12,4) NOT NULL DEFAULT 0 COMMENT '本次供应商费用',
          remain_money DECIMAL(12,4) NULL COMMENT '供应商返回余额',
          error TEXT NULL COMMENT '任务错误汇总',
          started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '开始时间',
          finished_at DATETIME NULL COMMENT '结束时间',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          UNIQUE KEY uk_peer_discovery_run_key (run_key),
          UNIQUE KEY uk_peer_discovery_active_lock (active_lock_key),
          INDEX idx_peer_discovery_report (report_date, competitor_code, dry_run, id),
          INDEX idx_peer_discovery_started (started_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='同行公众号文章发现任务';

        CREATE TABLE IF NOT EXISTS yimin_peer_discovery_batches (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          run_id BIGINT NOT NULL COMMENT '发现任务 ID',
          account_id BIGINT NOT NULL COMMENT '公众号配置 ID',
          page_no INT NOT NULL COMMENT '供应商页码',
          request_offset TEXT NULL COMMENT '本页请求游标',
          response_code INT NULL COMMENT '供应商响应码',
          provider_ghid VARCHAR(255) NOT NULL DEFAULT '' COMMENT '本页公众号标识',
          provider_nickname VARCHAR(255) NOT NULL DEFAULT '' COMMENT '本页公众号名称',
          next_offset TEXT NULL COMMENT '下一页游标',
          is_end TINYINT(1) NOT NULL DEFAULT 0 COMMENT '供应商是否已到末页',
          cost_money DECIMAL(12,4) NOT NULL DEFAULT 0 COMMENT '本页费用',
          remain_money DECIMAL(12,4) NULL COMMENT '本页后余额',
          response_hash CHAR(64) NOT NULL DEFAULT '' COMMENT '清洗后响应哈希',
          normalized_json JSON NULL COMMENT '不含密钥的标准化响应缓存',
          status ENUM('fetched','imported','failed') NOT NULL DEFAULT 'fetched' COMMENT '批次状态',
          article_count INT NOT NULL DEFAULT 0 COMMENT '本页文章数',
          eligible_article_count INT NOT NULL DEFAULT 0 COMMENT '本页命中窗口数',
          inserted_article_count INT NOT NULL DEFAULT 0 COMMENT '本页新增数',
          updated_article_count INT NOT NULL DEFAULT 0 COMMENT '本页更新数',
          skipped_article_count INT NOT NULL DEFAULT 0 COMMENT '本页跳过数',
          error TEXT NULL COMMENT '导入错误',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          UNIQUE KEY uk_peer_discovery_batch (run_id, account_id, page_no),
          INDEX idx_peer_discovery_batch_status (run_id, status),
          CONSTRAINT fk_peer_discovery_batch_run FOREIGN KEY (run_id) REFERENCES yimin_peer_discovery_runs(id) ON DELETE CASCADE,
          CONSTRAINT fk_peer_discovery_batch_account FOREIGN KEY (account_id) REFERENCES yimin_peer_wechat_accounts(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='同行公众号供应商响应缓存与导入结果';

        CREATE TABLE IF NOT EXISTS yimin_peer_imports (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          source_name VARCHAR(120) NOT NULL COMMENT '种子来源名称',
          content_hash CHAR(64) NOT NULL COMMENT '种子文件哈希',
          project_count INT NOT NULL DEFAULT 0 COMMENT '导入项目数量',
          imported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '导入时间',
          UNIQUE KEY uk_peer_import_source (source_name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='同行官网种子导入记录';

        CREATE TABLE IF NOT EXISTS yimin_peer_website_runs (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '官网快照导入主键',
          run_id VARCHAR(160) NOT NULL COMMENT '采集端全局唯一运行 ID',
          schema_version VARCHAR(80) NOT NULL COMMENT '官网快照契约版本',
          payload_hash CHAR(64) NOT NULL COMMENT '规范化请求哈希，防止同 ID 异内容',
          status ENUM('running','completed','partial','failed') NOT NULL DEFAULT 'running' COMMENT '导入状态',
          collector_count INT NOT NULL DEFAULT 0 COMMENT '提交站点数',
          accepted_count INT NOT NULL DEFAULT 0 COMMENT '通过校验站点数',
          rejected_count INT NOT NULL DEFAULT 0 COMMENT '校验或导入失败站点数',
          started_at DATETIME NOT NULL COMMENT '采集任务开始时间',
          finished_at DATETIME NOT NULL COMMENT '采集任务结束时间',
          result_json JSON NULL COMMENT '幂等返回结果',
          error TEXT NULL COMMENT '运行级错误',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '导入时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          UNIQUE KEY uk_peer_website_run_id (run_id),
          INDEX idx_peer_website_runs_started (started_at, id),
          INDEX idx_peer_website_runs_status (status, id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='同行官网快照导入运行';

        CREATE TABLE IF NOT EXISTS yimin_peer_website_sources (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '官网来源主键',
          competitor_id BIGINT NOT NULL COMMENT '同行 ID',
          source_domain VARCHAR(255) NOT NULL COMMENT '规范化官网域名',
          source_url VARCHAR(1400) NOT NULL COMMENT '官网来源地址',
          collector_version VARCHAR(160) NOT NULL DEFAULT '' COMMENT '最近采集器版本',
          last_status ENUM('completed','partial','failed') NULL COMMENT '最近提交状态',
          last_error TEXT NULL COMMENT '最近采集错误',
          last_run_id BIGINT NULL COMMENT '最近提交运行',
          last_success_run_id BIGINT NULL COMMENT '最近成功快照运行',
          last_success_at DATETIME NULL COMMENT '最近成功快照检测时间',
          baseline_completed TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否完成首轮成功基线',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          UNIQUE KEY uk_peer_website_source (competitor_id, source_domain),
          INDEX idx_peer_website_source_status (last_status, last_success_at),
          CONSTRAINT fk_peer_website_source_competitor FOREIGN KEY (competitor_id) REFERENCES yimin_peer_competitors(id) ON DELETE CASCADE,
          CONSTRAINT fk_peer_website_source_last_run FOREIGN KEY (last_run_id) REFERENCES yimin_peer_website_runs(id) ON DELETE SET NULL,
          CONSTRAINT fk_peer_website_source_success_run FOREIGN KEY (last_success_run_id) REFERENCES yimin_peer_website_runs(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='同行官网监控来源';

        CREATE TABLE IF NOT EXISTS yimin_peer_website_source_runs (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '单站运行主键',
          run_id BIGINT NOT NULL COMMENT '官网导入运行 ID',
          website_source_id BIGINT NULL COMMENT '已识别官网来源 ID',
          peer_code VARCHAR(32) NOT NULL DEFAULT '' COMMENT '提交的同行代码',
          source_domain VARCHAR(255) NOT NULL DEFAULT '' COMMENT '提交的来源域名',
          collector_version VARCHAR(160) NOT NULL DEFAULT '' COMMENT '采集器版本',
          status ENUM('completed','partial','failed','rejected') NOT NULL COMMENT '单站结果',
          error TEXT NULL COMMENT '校验或采集错误',
          warnings_json JSON NULL COMMENT '非阻断告警',
          discovered_count INT NOT NULL DEFAULT 0 COMMENT '发现项目数',
          success_count INT NOT NULL DEFAULT 0 COMMENT '成功项目数',
          failed_count INT NOT NULL DEFAULT 0 COMMENT '失败项目数',
          baseline_count INT NOT NULL DEFAULT 0 COMMENT '首轮基线项目数',
          added_count INT NOT NULL DEFAULT 0 COMMENT '新增项目数',
          changed_count INT NOT NULL DEFAULT 0 COMMENT '实质变化项目数',
          removed_count INT NOT NULL DEFAULT 0 COMMENT '连续缺失确认数',
          reappeared_count INT NOT NULL DEFAULT 0 COMMENT '恢复展示项目数',
          unchanged_count INT NOT NULL DEFAULT 0 COMMENT '无实质变化项目数',
          pending_removal_count INT NOT NULL DEFAULT 0 COMMENT '首轮缺失待确认项目数',
          result_json JSON NULL COMMENT '单站导入结果',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '记录时间',
          UNIQUE KEY uk_peer_website_source_run (run_id, peer_code, source_domain),
          INDEX idx_peer_website_source_runs_status (run_id, status),
          CONSTRAINT fk_peer_website_source_run FOREIGN KEY (run_id) REFERENCES yimin_peer_website_runs(id) ON DELETE CASCADE,
          CONSTRAINT fk_peer_website_source_run_source FOREIGN KEY (website_source_id) REFERENCES yimin_peer_website_sources(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='同行官网逐站运行结果';

        CREATE TABLE IF NOT EXISTS yimin_peer_project_versions (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '官网项目版本主键',
          project_id BIGINT NOT NULL COMMENT '同行官网项目 ID',
          website_source_id BIGINT NOT NULL COMMENT '官网来源 ID',
          run_id BIGINT NOT NULL COMMENT '产生版本的导入运行 ID',
          content_hash CHAR(64) NOT NULL COMMENT '实质字段哈希',
          canonical_url VARCHAR(1400) NOT NULL COMMENT '该版本证据链接',
          snapshot_json JSON NOT NULL COMMENT '规范化原始项目快照',
          detected_at DATETIME NOT NULL COMMENT '服务端检测时间',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          UNIQUE KEY uk_peer_project_version (project_id, content_hash),
          INDEX idx_peer_project_versions_run (run_id, id),
          CONSTRAINT fk_peer_project_version_project FOREIGN KEY (project_id) REFERENCES yimin_peer_projects(id) ON DELETE CASCADE,
          CONSTRAINT fk_peer_project_version_source FOREIGN KEY (website_source_id) REFERENCES yimin_peer_website_sources(id) ON DELETE CASCADE,
          CONSTRAINT fk_peer_project_version_run FOREIGN KEY (run_id) REFERENCES yimin_peer_website_runs(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='同行官网项目实质版本';

        CREATE TABLE IF NOT EXISTS yimin_peer_project_events (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '官网项目变化事件主键',
          event_key CHAR(64) NOT NULL COMMENT '幂等事件哈希',
          project_id BIGINT NOT NULL COMMENT '同行官网项目 ID',
          competitor_id BIGINT NOT NULL COMMENT '同行 ID',
          website_source_id BIGINT NOT NULL COMMENT '官网来源 ID',
          run_id BIGINT NOT NULL COMMENT '检测运行 ID',
          event_type ENUM('added','changed','removed','reappeared') NOT NULL COMMENT '变化类型',
          before_version_id BIGINT NULL COMMENT '变化前版本',
          after_version_id BIGINT NULL COMMENT '变化后版本',
          changed_fields_json JSON NOT NULL COMMENT '发生实质变化的字段',
          evidence_url VARCHAR(1400) NULL COMMENT '官网证据链接',
          detected_at DATETIME NOT NULL COMMENT '检测时间，不等于官网修改时间',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          UNIQUE KEY uk_peer_project_event (event_key),
          INDEX idx_peer_project_events_detected (detected_at, id),
          INDEX idx_peer_project_events_peer (competitor_id, detected_at, id),
          INDEX idx_peer_project_events_run (run_id, id),
          CONSTRAINT fk_peer_project_event_project FOREIGN KEY (project_id) REFERENCES yimin_peer_projects(id) ON DELETE CASCADE,
          CONSTRAINT fk_peer_project_event_competitor FOREIGN KEY (competitor_id) REFERENCES yimin_peer_competitors(id) ON DELETE CASCADE,
          CONSTRAINT fk_peer_project_event_source FOREIGN KEY (website_source_id) REFERENCES yimin_peer_website_sources(id) ON DELETE CASCADE,
          CONSTRAINT fk_peer_project_event_run FOREIGN KEY (run_id) REFERENCES yimin_peer_website_runs(id) ON DELETE CASCADE,
          CONSTRAINT fk_peer_project_event_before FOREIGN KEY (before_version_id) REFERENCES yimin_peer_project_versions(id) ON DELETE SET NULL,
          CONSTRAINT fk_peer_project_event_after FOREIGN KEY (after_version_id) REFERENCES yimin_peer_project_versions(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='同行官网项目变化事件';

        CREATE TABLE IF NOT EXISTS yimin_h_topics (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT 'H 专栏候选主键',
          topic_date DATE NOT NULL COMMENT '候选归属日期',
          source_report_id BIGINT NOT NULL COMMENT '来源公共日报 ID',
          event_key VARCHAR(160) NOT NULL COMMENT '来源事件 Key',
          title VARCHAR(600) NOT NULL COMMENT '候选标题',
          event_summary TEXT NULL COMMENT '事件事实摘要',
          core_question VARCHAR(600) NULL COMMENT '面向 Henry 的核心问题',
          suggested_angle TEXT NULL COMMENT '系统建议角度，不等于本人观点',
          target_audience VARCHAR(500) NULL COMMENT '目标读者',
          content_archetype VARCHAR(80) NOT NULL DEFAULT 'policy_explanation' COMMENT '内容原型',
          primary_mode VARCHAR(40) NOT NULL DEFAULT 'wechat_article' COMMENT '推荐主内容模式',
          reusable_mode VARCHAR(40) NULL COMMENT '推荐复用模式',
          four_checks_json JSON NOT NULL COMMENT 'H 选题四问结果',
          readiness ENUM('not_recommended','topic_only','outline_ready','needs_viewpoint','needs_evidence','draft_ready') NOT NULL DEFAULT 'topic_only' COMMENT '成稿准备度',
          status ENUM('candidate','selected','later','rejected','archived') NOT NULL DEFAULT 'candidate' COMMENT '候选状态',
          duplicate_risk_json JSON NULL COMMENT '近 30 天重复风险',
          source_snapshot_json JSON NULL COMMENT '日报事件快照',
          missing_items_json JSON NULL COMMENT '事实或判断缺口',
          input_hash CHAR(64) NOT NULL COMMENT '候选输入哈希',
          rule_version VARCHAR(80) NOT NULL COMMENT '候选规则版本',
          skill_version VARCHAR(80) NOT NULL COMMENT 'Henry Skill 版本',
          profile_version VARCHAR(80) NOT NULL COMMENT '人物档案版本',
          selected_by VARCHAR(160) NULL COMMENT '选择操作者',
          selected_at DATETIME NULL COMMENT '选择时间',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_h_topic_date_event (topic_date, event_key),
          INDEX idx_h_topics_status (topic_date, status, readiness),
          CONSTRAINT fk_h_topic_report FOREIGN KEY (source_report_id) REFERENCES yimin_daily_reports(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Henry 每日内容候选';

        CREATE TABLE IF NOT EXISTS yimin_h_topic_sources (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT 'H 事实包来源主键',
          topic_id BIGINT NOT NULL COMMENT '关联候选',
          article_hash CHAR(40) NULL COMMENT '关联日报文章哈希',
          source_name VARCHAR(240) NOT NULL DEFAULT '' COMMENT '来源名称',
          url VARCHAR(1400) NULL COMMENT '来源链接',
          title VARCHAR(600) NOT NULL DEFAULT '' COMMENT '来源标题',
          published_at DATETIME NULL COMMENT '来源发布时间',
          content_status ENUM('full','summary_only','missing') NOT NULL DEFAULT 'summary_only' COMMENT '原文完整度',
          source_level ENUM('A','B','C','D') NOT NULL DEFAULT 'C' COMMENT '证据等级',
          policy_status ENUM('effective','announced','pending','proposed','media_report','opinion','not_applicable') NOT NULL DEFAULT 'media_report' COMMENT '政策状态',
          extracted_text LONGTEXT NULL COMMENT '全文或可用摘要',
          evidence_summary TEXT NULL COMMENT '可证明事实',
          is_primary TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否主来源',
          verified_by VARCHAR(160) NULL COMMENT '核验人',
          verified_at DATETIME NULL COMMENT '核验时间',
          content_hash CHAR(64) NULL COMMENT '来源内容哈希',
          deleted_at DATETIME NULL COMMENT '软删除时间',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_h_topic_source_article (topic_id, article_hash),
          INDEX idx_h_topic_sources_topic (topic_id, deleted_at),
          CONSTRAINT fk_h_topic_source_topic FOREIGN KEY (topic_id) REFERENCES yimin_h_topics(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Henry 候选事实包来源';

        CREATE TABLE IF NOT EXISTS yimin_h_viewpoints (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT 'Henry 观点输入主键',
          topic_id BIGINT NOT NULL COMMENT '关联候选',
          input_type ENUM('text','transcript','profile','public_material') NOT NULL DEFAULT 'text' COMMENT '观点来源类型',
          raw_text TEXT NOT NULL COMMENT '原始输入',
          edited_text TEXT NULL COMMENT '编辑整理文本',
          is_confirmed TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否已确认可用于成稿',
          confirmation_type ENUM('unconfirmed','henry','authorized_editor','profile') NOT NULL DEFAULT 'unconfirmed' COMMENT '确认类型',
          confirmed_by VARCHAR(160) NULL COMMENT '真实确认操作者',
          confirmed_at DATETIME NULL COMMENT '确认时间',
          created_by VARCHAR(160) NOT NULL COMMENT '录入操作者',
          deleted_at DATETIME NULL COMMENT '软删除时间',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_h_viewpoints_topic (topic_id, deleted_at, is_confirmed),
          CONSTRAINT fk_h_viewpoint_topic FOREIGN KEY (topic_id) REFERENCES yimin_h_topics(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Henry 本次观点与确认记录';

        CREATE TABLE IF NOT EXISTS yimin_h_drafts (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT 'H 草稿主键',
          topic_id BIGINT NOT NULL COMMENT '关联候选',
          parent_draft_id BIGINT NULL COMMENT '父版本',
          mode ENUM('outline','wechat_article','short_video','run_and_talk_video','deep_video') NOT NULL COMMENT '内容模式',
          version_no INT NOT NULL DEFAULT 1 COMMENT '同模式版本号',
          title VARCHAR(600) NOT NULL DEFAULT '' COMMENT '推荐标题',
          title_candidates_json JSON NULL COMMENT '标题候选',
          outline_markdown LONGTEXT NULL COMMENT '结构化大纲',
          content_markdown LONGTEXT NOT NULL COMMENT '正文或口播 Markdown',
          content_html LONGTEXT NOT NULL COMMENT '渲染 HTML',
          extras_json JSON NULL COMMENT '摘要、配图、画面等附加输出',
          pending_facts_json JSON NULL COMMENT '待确认事实',
          status ENUM('generating','drafted','reviewing','needs_revision','ready_for_henry','henry_reviewed','approved','rejected','failed') NOT NULL DEFAULT 'drafted' COMMENT '草稿状态',
          readiness ENUM('pending','review_required','facts_required','ready_for_henry') NOT NULL DEFAULT 'review_required' COMMENT '发布准备度',
          provider VARCHAR(80) NOT NULL DEFAULT 'openai-compatible' COMMENT '模型提供方',
          model VARCHAR(120) NOT NULL COMMENT '生成模型',
          skill_version VARCHAR(80) NOT NULL COMMENT 'Skill 版本',
          profile_version VARCHAR(80) NOT NULL COMMENT '人物档案版本',
          prompt_version VARCHAR(80) NOT NULL COMMENT 'Prompt 版本',
          input_hash CHAR(64) NOT NULL COMMENT '输入事实与观点哈希',
          input_snapshot_json JSON NULL COMMENT '生成输入快照',
          generation_error TEXT NULL COMMENT '生成错误',
          created_by VARCHAR(160) NOT NULL COMMENT '生成操作者',
          approved_by VARCHAR(160) NULL COMMENT '真实采用操作者',
          approval_type ENUM('none','henry','authorized_editor') NOT NULL DEFAULT 'none' COMMENT '采用类型',
          approved_at DATETIME NULL COMMENT '采用时间',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_h_draft_version (topic_id, mode, version_no),
          INDEX idx_h_drafts_status (status, updated_at),
          CONSTRAINT fk_h_draft_topic FOREIGN KEY (topic_id) REFERENCES yimin_h_topics(id) ON DELETE CASCADE,
          CONSTRAINT fk_h_draft_parent FOREIGN KEY (parent_draft_id) REFERENCES yimin_h_drafts(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Henry 文章与视频草稿版本';

        CREATE TABLE IF NOT EXISTS yimin_h_reviews (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT 'H 草稿审校主键',
          draft_id BIGINT NOT NULL COMMENT '关联草稿',
          conclusion ENUM('ready_for_henry','facts_required','not_recommended') NOT NULL COMMENT '四层质检结论',
          l1_status ENUM('passed','needs_revision') NOT NULL COMMENT '事实与风险',
          l2_status ENUM('passed','needs_revision') NOT NULL COMMENT '判断与结构',
          l3_status ENUM('passed','needs_revision') NOT NULL COMMENT 'H 口吻与渠道',
          l4_status ENUM('passed','needs_revision') NOT NULL COMMENT '原创与发布准备',
          issues_json JSON NULL COMMENT '可验证问题',
          pending_facts_json JSON NULL COMMENT '待确认事实',
          required_actions_json JSON NULL COMMENT '必须处理项',
          model VARCHAR(120) NOT NULL COMMENT '审校模型',
          prompt_version VARCHAR(80) NOT NULL COMMENT '审校 Prompt 版本',
          input_hash CHAR(64) NOT NULL COMMENT '审校输入哈希',
          reviewed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_h_reviews_draft (draft_id, reviewed_at),
          CONSTRAINT fk_h_review_draft FOREIGN KEY (draft_id) REFERENCES yimin_h_drafts(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Henry 内容四层质检';

        CREATE TABLE IF NOT EXISTS yimin_h_feedback (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT 'H 内容反馈主键',
          topic_id BIGINT NOT NULL COMMENT '关联候选',
          draft_id BIGINT NULL COMMENT '关联草稿',
          action ENUM('use','later','reject','revise') NOT NULL COMMENT '反馈动作',
          reason_code VARCHAR(80) NULL COMMENT '结构化原因',
          note TEXT NULL COMMENT '备注',
          created_by VARCHAR(160) NOT NULL COMMENT '真实操作者',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_h_feedback_topic (topic_id, created_at),
          CONSTRAINT fk_h_feedback_topic FOREIGN KEY (topic_id) REFERENCES yimin_h_topics(id) ON DELETE CASCADE,
          CONSTRAINT fk_h_feedback_draft FOREIGN KEY (draft_id) REFERENCES yimin_h_drafts(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Henry 内容采用与退回日志';

        CREATE TABLE IF NOT EXISTS yimin_h_generation_runs (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT 'H 生成任务主键',
          run_type ENUM('topics','evidence','draft','review') NOT NULL COMMENT '任务类型',
          target_id BIGINT NULL COMMENT '候选或草稿 ID',
          idempotency_key CHAR(64) NOT NULL COMMENT '幂等键',
          status ENUM('pending','running','completed','failed') NOT NULL DEFAULT 'pending' COMMENT '任务状态',
          provider VARCHAR(80) NOT NULL DEFAULT 'openai-compatible',
          model VARCHAR(120) NOT NULL COMMENT '模型',
          attempt_count INT NOT NULL DEFAULT 0 COMMENT '尝试次数',
          started_at DATETIME NULL,
          finished_at DATETIME NULL,
          error_message TEXT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_h_generation_idempotency (idempotency_key),
          INDEX idx_h_generation_status (status, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Henry 内容异步生成日志';

        CREATE TABLE IF NOT EXISTS yimin_h_audit_logs (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT 'H 专栏审计日志主键',
          entity_type VARCHAR(40) NOT NULL COMMENT '实体类型',
          entity_id VARCHAR(160) NOT NULL DEFAULT '' COMMENT '实体 ID 或日期',
          action VARCHAR(80) NOT NULL COMMENT '操作名称',
          actor_id VARCHAR(160) NOT NULL COMMENT '真实操作者 ID',
          actor_name VARCHAR(160) NOT NULL DEFAULT '' COMMENT '真实操作者姓名',
          actor_role VARCHAR(40) NOT NULL DEFAULT '' COMMENT '操作者角色',
          metadata_json JSON NULL COMMENT '不含正文的操作元数据',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_h_audit_entity (entity_type, entity_id, created_at),
          INDEX idx_h_audit_actor (actor_id, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Henry 内容工作台写操作审计日志';
      `);

      const hViewpointColumns = await mysqlRun(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ${sqlString(dbConfig.database)}
          AND TABLE_NAME = 'yimin_h_viewpoints'
          AND COLUMN_NAME = 'deleted_at';
      `);
      if (!hViewpointColumns.includes("deleted_at")) {
        await mysqlExec(`
          ALTER TABLE yimin_h_viewpoints
          ADD COLUMN deleted_at DATETIME NULL COMMENT '软删除时间'
          AFTER created_by;
        `);
      }

      const colCheck = await mysqlRun(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ${sqlString(dbConfig.database)} AND TABLE_NAME = 'yimin_sources' AND COLUMN_NAME = 'type';
      `);
      if (!colCheck.includes("type")) {
        await mysqlExec(`
          ALTER TABLE yimin_sources
          ADD COLUMN type VARCHAR(20) NOT NULL DEFAULT 'rss' COMMENT '来源类型（rss/twitter/html/json/website）'
          AFTER priority;
        `);
      }

      const sourceColumns = await mysqlRun(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ${sqlString(dbConfig.database)}
          AND TABLE_NAME = 'yimin_sources'
          AND COLUMN_NAME IN ('daily_baseline_at');
      `);
      if (!sourceColumns.includes("daily_baseline_at")) {
        await mysqlExec(`
          ALTER TABLE yimin_sources
          ADD COLUMN daily_baseline_at DATETIME NULL COMMENT '日报基线抓取完成时间'
          AFTER last_fetch_error;
        `);
      }

      const sourceDistributionColumns = await mysqlRun(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ${sqlString(dbConfig.database)}
          AND TABLE_NAME = 'yimin_sources'
          AND COLUMN_NAME IN (
            'public_daily_enabled',
            'public_daily_exclusion_reason',
            'public_daily_updated_by',
            'public_daily_updated_at'
          );
      `);
      if (!sourceDistributionColumns.includes("public_daily_enabled")) {
        await mysqlExec(`
          ALTER TABLE yimin_sources
          ADD COLUMN public_daily_enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否进入公共日报（1=公开 0=仅订阅部门）'
          AFTER enabled;
        `);
      }
      if (!sourceDistributionColumns.includes("public_daily_exclusion_reason")) {
        await mysqlExec(`
          ALTER TABLE yimin_sources
          ADD COLUMN public_daily_exclusion_reason VARCHAR(255) NULL COMMENT '不进入公共日报的原因'
          AFTER public_daily_enabled;
        `);
      }
      if (!sourceDistributionColumns.includes("public_daily_updated_by")) {
        await mysqlExec(`
          ALTER TABLE yimin_sources
          ADD COLUMN public_daily_updated_by VARCHAR(160) NULL COMMENT '最后调整公共日报范围的管理员'
          AFTER public_daily_exclusion_reason;
        `);
      }
      if (!sourceDistributionColumns.includes("public_daily_updated_at")) {
        await mysqlExec(`
          ALTER TABLE yimin_sources
          ADD COLUMN public_daily_updated_at DATETIME NULL COMMENT '最后调整公共日报范围的时间'
          AFTER public_daily_updated_by;
        `);
      }

      const sourceDistributionIndex = await mysqlRun(`
        SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = ${sqlString(dbConfig.database)}
          AND TABLE_NAME = 'yimin_sources'
          AND INDEX_NAME = 'idx_sources_public_daily';
      `);
      if (!sourceDistributionIndex.includes("idx_sources_public_daily")) {
        await mysqlExec(`
          ALTER TABLE yimin_sources
          ADD INDEX idx_sources_public_daily (enabled, public_daily_enabled);
        `);
      }

      await mysqlExec(`
        UPDATE yimin_sources s
        SET daily_baseline_at = COALESCE(s.last_fetched_at, s.updated_at)
        WHERE s.daily_baseline_at IS NULL
          AND EXISTS (
            SELECT 1 FROM yimin_articles a
            WHERE a.source_id = s.id
            LIMIT 1
          );
      `);

      const articleColumns = await mysqlRun(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ${sqlString(dbConfig.database)}
          AND TABLE_NAME = 'yimin_articles';
      `);
      if (!articleColumns.includes("country_en")) {
        await mysqlExec(`
          ALTER TABLE yimin_articles
          ADD COLUMN country_en VARCHAR(120) NULL COMMENT '所属国家/地区英文名'
          AFTER country;
        `);
      }
      if (!articleColumns.includes("category_en")) {
        await mysqlExec(`
          ALTER TABLE yimin_articles
          ADD COLUMN category_en VARCHAR(160) NULL COMMENT '分类英文名'
          AFTER category;
        `);
      }
      if (!articleColumns.includes("tags_en_json")) {
        await mysqlExec(`
          ALTER TABLE yimin_articles
          ADD COLUMN tags_en_json JSON NULL COMMENT '英文标签列表，JSON 数组格式'
          AFTER tags_json;
        `);
      }
      if (!articleColumns.includes("impact_en")) {
        await mysqlExec(`
          ALTER TABLE yimin_articles
          ADD COLUMN impact_en VARCHAR(60) NULL COMMENT '影响力等级英文'
          AFTER impact;
        `);
      }
      if (!articleColumns.includes("daily_excluded")) {
        await mysqlExec(`
          ALTER TABLE yimin_articles
          ADD COLUMN daily_excluded TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否排除出日报候选'
          AFTER fetched_at;
        `);
      }
      if (!articleColumns.includes("daily_excluded_reason")) {
        await mysqlExec(`
          ALTER TABLE yimin_articles
          ADD COLUMN daily_excluded_reason VARCHAR(160) NULL COMMENT '排除出日报候选的原因'
          AFTER daily_excluded;
        `);
      }
      await backfillArticleEnglishLabels();

      const articleDailyIndex = await mysqlRun(`
        SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = ${sqlString(dbConfig.database)}
          AND TABLE_NAME = 'yimin_articles'
          AND INDEX_NAME = 'idx_articles_daily_candidate';
      `);
      if (!articleDailyIndex.includes("idx_articles_daily_candidate")) {
        await mysqlExec(`
          ALTER TABLE yimin_articles
          ADD INDEX idx_articles_daily_candidate (daily_excluded, published_at, fetched_at);
        `);
      }

      const dailyReportColumns = await mysqlRun(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ${sqlString(dbConfig.database)}
          AND TABLE_NAME = 'yimin_daily_reports'
          AND COLUMN_NAME IN ('window_start_at', 'window_end_at', 'window_mode');
      `);
      if (!dailyReportColumns.includes("window_start_at")) {
        await mysqlExec(`
          ALTER TABLE yimin_daily_reports
          ADD COLUMN window_start_at DATETIME NULL COMMENT '日报统计窗口开始时间'
          AFTER report_date;
        `);
      }
      if (!dailyReportColumns.includes("window_end_at")) {
        await mysqlExec(`
          ALTER TABLE yimin_daily_reports
          ADD COLUMN window_end_at DATETIME NULL COMMENT '日报统计窗口结束时间'
          AFTER window_start_at;
        `);
      }
      if (!dailyReportColumns.includes("window_mode")) {
        await mysqlExec(`
          ALTER TABLE yimin_daily_reports
          ADD COLUMN window_mode VARCHAR(20) NOT NULL DEFAULT 'calendar' COMMENT '日报统计窗口模式（calendar/last24h）'
          AFTER window_end_at;
        `);
      }

      const dailyReportMetricColumns = await mysqlRun(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ${sqlString(dbConfig.database)}
          AND TABLE_NAME = 'yimin_daily_reports'
          AND COLUMN_NAME IN ('relevant_item_count', 'event_count');
      `);
      if (!dailyReportMetricColumns.includes("relevant_item_count")) {
        await mysqlExec(`
          ALTER TABLE yimin_daily_reports
          ADD COLUMN relevant_item_count INT NOT NULL DEFAULT 0 COMMENT '与移民主题相关的文章数量'
          AFTER source_item_count;
        `);
      }
      if (!dailyReportMetricColumns.includes("event_count")) {
        await mysqlExec(`
          ALTER TABLE yimin_daily_reports
          ADD COLUMN event_count INT NOT NULL DEFAULT 0 COMMENT '聚合后的事件数量'
          AFTER relevant_item_count;
        `);
      }

      const dailyItemColumns = await mysqlRun(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ${sqlString(dbConfig.database)}
          AND TABLE_NAME = 'yimin_daily_report_items'
          AND COLUMN_NAME IN ('event_key', 'relevant', 'importance');
      `);
      if (!dailyItemColumns.includes("event_key")) {
        await mysqlExec(`
          ALTER TABLE yimin_daily_report_items
          ADD COLUMN event_key VARCHAR(160) NOT NULL DEFAULT '' COMMENT '聚合事件 Key'
          AFTER topic_key,
          ADD INDEX idx_daily_report_items_event (event_key);
        `);
      }
      if (!dailyItemColumns.includes("relevant")) {
        await mysqlExec(`
          ALTER TABLE yimin_daily_report_items
          ADD COLUMN relevant TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否与日报主题相关'
          AFTER section;
        `);
      }
      if (!dailyItemColumns.includes("importance")) {
        await mysqlExec(`
          ALTER TABLE yimin_daily_report_items
          ADD COLUMN importance INT NOT NULL DEFAULT 0 COMMENT '文章重要度 0-100'
          AFTER relevant;
        `);
      }

      const fetchRunColumns = await mysqlRun(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ${sqlString(dbConfig.database)}
          AND TABLE_NAME = 'yimin_fetch_runs'
          AND COLUMN_NAME IN ('processed_source_count', 'success_source_count', 'failed_source_count');
      `);
      if (!fetchRunColumns.includes("processed_source_count")) {
        await mysqlExec(`
          ALTER TABLE yimin_fetch_runs
          ADD COLUMN processed_source_count INT NOT NULL DEFAULT 0 COMMENT '已处理来源数量'
          AFTER source_count;
        `);
      }
      if (!fetchRunColumns.includes("success_source_count")) {
        await mysqlExec(`
          ALTER TABLE yimin_fetch_runs
          ADD COLUMN success_source_count INT NOT NULL DEFAULT 0 COMMENT '成功来源数量'
          AFTER processed_source_count;
        `);
      }
      if (!fetchRunColumns.includes("failed_source_count")) {
        await mysqlExec(`
          ALTER TABLE yimin_fetch_runs
          ADD COLUMN failed_source_count INT NOT NULL DEFAULT 0 COMMENT '失败来源数量'
          AFTER success_source_count;
        `);
      }

      const ssoLogColumns = await mysqlRun(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ${sqlString(dbConfig.database)}
          AND TABLE_NAME = 'yimin_sso_login_logs'
          AND COLUMN_NAME IN ('user_id', 'user_id_enc_hash');
      `);
      if (!ssoLogColumns.includes("user_id")) {
        await mysqlExec(`
          ALTER TABLE yimin_sso_login_logs
          ADD COLUMN user_id VARCHAR(128) NULL COMMENT '企业微信登录人 UserID（拼音名）'
          AFTER user_name,
          ADD INDEX idx_sso_login_user_id (user_id);
        `);
      }
      if (!ssoLogColumns.includes("user_id_enc_hash")) {
        await mysqlExec(`
          ALTER TABLE yimin_sso_login_logs
          ADD COLUMN user_id_enc_hash CHAR(64) NULL COMMENT '加密 UserID 参数 SHA256，用于去重排查'
          AFTER enc_hash;
        `);
      }

      const feedbackColumns = await mysqlRun(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ${sqlString(dbConfig.database)}
          AND TABLE_NAME = 'yimin_feedback'
          AND COLUMN_NAME IN ('module', 'priority', 'contact', 'created_by', 'status', 'admin_note', 'page_url', 'user_agent', 'updated_at');
      `);
      if (!feedbackColumns.includes("module")) {
        await mysqlExec(`
          ALTER TABLE yimin_feedback
          ADD COLUMN module VARCHAR(120) NOT NULL DEFAULT '' COMMENT '反馈相关页面或模块'
          AFTER type;
        `);
      }
      if (!feedbackColumns.includes("priority")) {
        await mysqlExec(`
          ALTER TABLE yimin_feedback
          ADD COLUMN priority VARCHAR(40) NOT NULL DEFAULT 'normal' COMMENT '反馈优先级'
          AFTER module;
        `);
      }
      if (!feedbackColumns.includes("contact")) {
        await mysqlExec(`
          ALTER TABLE yimin_feedback
          ADD COLUMN contact VARCHAR(160) NULL COMMENT '联系方式'
          AFTER message;
        `);
      }
      if (!feedbackColumns.includes("created_by")) {
        await mysqlExec(`
          ALTER TABLE yimin_feedback
          ADD COLUMN created_by VARCHAR(160) NOT NULL DEFAULT '' COMMENT '反馈人'
          AFTER contact;
        `);
      }
      if (!feedbackColumns.includes("status")) {
        await mysqlExec(`
          ALTER TABLE yimin_feedback
          ADD COLUMN status ENUM('new','reviewed','resolved','archived') NOT NULL DEFAULT 'new' COMMENT '处理状态'
          AFTER created_by;
        `);
      }
      if (!feedbackColumns.includes("admin_note")) {
        await mysqlExec(`
          ALTER TABLE yimin_feedback
          ADD COLUMN admin_note TEXT NULL COMMENT '管理员备注'
          AFTER status;
        `);
      }
      if (!feedbackColumns.includes("page_url")) {
        await mysqlExec(`
          ALTER TABLE yimin_feedback
          ADD COLUMN page_url VARCHAR(1200) NULL COMMENT '提交页面地址'
          AFTER admin_note;
        `);
      }
      if (!feedbackColumns.includes("user_agent")) {
        await mysqlExec(`
          ALTER TABLE yimin_feedback
          ADD COLUMN user_agent VARCHAR(600) NULL COMMENT '浏览器 UA'
          AFTER page_url;
        `);
      }
      if (!feedbackColumns.includes("updated_at")) {
        await mysqlExec(`
          ALTER TABLE yimin_feedback
          ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间'
          AFTER created_at;
        `);
      }

      const wxTokenColumns = await mysqlRun(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ${sqlString(dbConfig.database)}
          AND TABLE_NAME = 'yimin_wx_token_cache'
          AND COLUMN_NAME = 'ticket';
      `);
      if (!wxTokenColumns.includes("ticket")) {
        await mysqlExec(`
          ALTER TABLE yimin_wx_token_cache
          ADD COLUMN ticket VARCHAR(512) NULL COMMENT '企业微信 JS-SDK ticket'
          AFTER access_token;
        `);
      }

      await ensurePeerWechatDiscoverySchema();
      await ensurePeerWebsiteSchema();
      await ensureReportDateUniqueness();
      await seedConfiguredSources();
      await seedPeerMonitorData();
    })();
  }

  return dbReadyPromise;
}

async function ensurePeerWechatDiscoverySchema() {
  const accountColumns = await mysqlRun(`
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = ${sqlString(dbConfig.database)}
      AND TABLE_NAME = 'yimin_peer_wechat_accounts'
      AND COLUMN_NAME = 'lookup_mode';
  `);
  if (!accountColumns.includes("lookup_mode")) {
    await mysqlExec(`
      ALTER TABLE yimin_peer_wechat_accounts
      ADD COLUMN lookup_mode ENUM('auto','ghid','url','nickname') NOT NULL DEFAULT 'auto'
        COMMENT '供应商账号查询方式'
      AFTER provider;
    `);
  }

  const runColumns = await mysqlRun(`
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = ${sqlString(dbConfig.database)}
      AND TABLE_NAME = 'yimin_peer_discovery_runs'
      AND COLUMN_NAME = 'run_mode';
  `);
  if (!runColumns.includes("run_mode")) {
    await mysqlExec(`
      ALTER TABLE yimin_peer_discovery_runs
      ADD COLUMN run_mode ENUM('discover','dry_run','retry_cached') NOT NULL DEFAULT 'discover'
        COMMENT '任务运行模式'
      AFTER status;
    `);
  }
}

async function ensurePeerWebsiteSchema() {
  const projectColumnRows = await mysqlJsonRows(`
    SELECT JSON_OBJECT('name', COLUMN_NAME)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = ${sqlString(dbConfig.database)}
      AND TABLE_NAME = 'yimin_peer_projects';
  `);
  const projectColumns = new Set(projectColumnRows.map((row) => String(row.name)));
  const columnDefinitions = [
    ["website_source_id", "ADD COLUMN website_source_id BIGINT NULL COMMENT '官网监控来源 ID，静态种子为空' AFTER source_key"],
    ["source_project_id", "ADD COLUMN source_project_id VARCHAR(512) NULL COMMENT '采集器提供的稳定项目 ID' AFTER website_source_id"],
    ["stable_identity", "ADD COLUMN stable_identity VARCHAR(1600) NULL COMMENT '项目稳定身份（id/url）' AFTER source_project_id"],
    ["canonical_url", "ADD COLUMN canonical_url VARCHAR(1400) NULL COMMENT '官网证据链接，仅授权接口返回' AFTER stable_identity"],
    ["canonical_url_hash", "ADD COLUMN canonical_url_hash CHAR(64) NULL COMMENT '规范化官网链接哈希' AFTER canonical_url"],
    ["content_hash", "ADD COLUMN content_hash CHAR(64) NULL COMMENT '当前实质字段哈希' AFTER canonical_url_hash"],
    ["current_version_id", "ADD COLUMN current_version_id BIGINT NULL COMMENT '当前项目版本 ID' AFTER content_hash"],
    ["lifecycle_status", "ADD COLUMN lifecycle_status ENUM('active','removed') NOT NULL DEFAULT 'active' COMMENT '官网展示状态' AFTER current_version_id"],
    ["missing_success_count", "ADD COLUMN missing_success_count INT NOT NULL DEFAULT 0 COMMENT '连续成功快照缺失次数' AFTER lifecycle_status"],
    ["first_seen_at", "ADD COLUMN first_seen_at DATETIME NULL COMMENT '首次在成功快照中检测到' AFTER missing_success_count"],
    ["last_seen_at", "ADD COLUMN last_seen_at DATETIME NULL COMMENT '最近在成功快照中检测到' AFTER first_seen_at"],
    ["removed_at", "ADD COLUMN removed_at DATETIME NULL COMMENT '连续缺失确认时间' AFTER last_seen_at"],
    ["handling_process_json", "ADD COLUMN handling_process_json JSON NULL COMMENT '结构化办理流程' AFTER application_process_json"],
  ];
  const missingColumnDefinitions = columnDefinitions
    .filter(([columnName]) => !projectColumns.has(columnName))
    .map(([, definition]) => definition);
  if (missingColumnDefinitions.length) {
    await mysqlExec(`
      ALTER TABLE yimin_peer_projects
      ${missingColumnDefinitions.join(",\n")};
    `);
  }

  const projectIndexRows = await mysqlJsonRows(`
    SELECT JSON_OBJECT(
      'name', INDEX_NAME,
      'nonUnique', MIN(NON_UNIQUE)
    )
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = ${sqlString(dbConfig.database)}
      AND TABLE_NAME = 'yimin_peer_projects'
    GROUP BY INDEX_NAME;
  `);
  const projectIndexes = new Map(
    projectIndexRows.map((row) => [String(row.name), Number(row.nonUnique)])
  );
  if (projectIndexes.has("uk_peer_project_website_url")) {
    await mysqlExec(`
      ALTER TABLE yimin_peer_projects
      DROP INDEX uk_peer_project_website_url;
    `);
    projectIndexes.delete("uk_peer_project_website_url");
  }
  const missingIndexes = [
    ["uk_peer_project_website_identity", "ADD UNIQUE KEY uk_peer_project_website_identity (website_source_id, source_project_id)"],
    ["idx_peer_project_website_url", "ADD INDEX idx_peer_project_website_url (website_source_id, canonical_url_hash)"],
    ["idx_peer_project_website_state", "ADD INDEX idx_peer_project_website_state (website_source_id, lifecycle_status, last_seen_at)"],
  ]
    .filter(([indexName]) => !projectIndexes.has(indexName))
    .map(([, definition]) => definition);
  if (missingIndexes.length) {
    await mysqlExec(`
      ALTER TABLE yimin_peer_projects
      ${missingIndexes.join(",\n")};
    `);
  }
}

async function ensureReportDateUniqueness() {
  await mysqlExec(`
    DELETE d FROM yimin_daily_reports d
    JOIN (
      SELECT report_date, MAX(id) AS keep_id
      FROM yimin_daily_reports
      GROUP BY report_date
      HAVING COUNT(*) > 1
    ) dup ON dup.report_date = d.report_date AND d.id <> dup.keep_id;

    DELETE m FROM yimin_market_reports m
    JOIN (
      SELECT report_date, MAX(id) AS keep_id
      FROM yimin_market_reports
      GROUP BY report_date
      HAVING COUNT(*) > 1
    ) dup ON dup.report_date = m.report_date AND m.id <> dup.keep_id;
  `);

  const dailyIndex = await mysqlRun(`
    SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = ${sqlString(dbConfig.database)}
      AND TABLE_NAME = 'yimin_daily_reports'
      AND INDEX_NAME = 'uk_yimin_daily_reports_date';
  `);
  if (!dailyIndex.includes("uk_yimin_daily_reports_date")) {
    await mysqlExec(`
      ALTER TABLE yimin_daily_reports
      ADD UNIQUE KEY uk_yimin_daily_reports_date (report_date);
    `);
  }

  const marketIndex = await mysqlRun(`
    SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = ${sqlString(dbConfig.database)}
      AND TABLE_NAME = 'yimin_market_reports'
      AND INDEX_NAME = 'uk_yimin_market_reports_date';
  `);
  if (!marketIndex.includes("uk_yimin_market_reports_date")) {
    await mysqlExec(`
      ALTER TABLE yimin_market_reports
      ADD UNIQUE KEY uk_yimin_market_reports_date (report_date);
    `);
  }
}

async function seedConfiguredSources() {
  const sources = await readSources();
  for (const source of sources) {
    await upsertSource(source, { enabled: true });
  }
}

async function seedPeerMonitorData() {
  if (!existsSync(peerMonitorConfig.seedPath)) {
    console.warn(`Peer monitor seed not found: ${peerMonitorConfig.seedPath}`);
    return;
  }

  const raw = await readFile(peerMonitorConfig.seedPath, "utf8");
  const contentHash = createHash("sha256").update(raw).digest("hex");
  const existingImport = await mysqlJson(`
    SELECT JSON_OBJECT(
      'contentHash', content_hash,
      'projectCount', project_count
    )
    FROM yimin_peer_imports
    WHERE source_name = 'peer-monitor-projects'
    LIMIT 1;
  `);

  // sort_order is insert-only here so later database-managed ordering survives restarts.
  await mysqlExec(`
    INSERT INTO yimin_peer_competitors (
      code,
      display_name,
      private_name,
      private_domain,
      sort_order,
      enabled
    )
    VALUES
      ${peerCompetitorSeeds.map((competitor, index) => `(
        ${sqlString(competitor.code)},
        ${sqlString(competitor.displayName)},
        ${sqlString(competitor.privateName)},
        ${sqlString(competitor.privateDomain)},
        ${sqlNumber(index + 1)},
        1
      )`).join(",\n")}
    ON DUPLICATE KEY UPDATE
      display_name = VALUES(display_name),
      private_name = VALUES(private_name),
      private_domain = VALUES(private_domain),
      enabled = VALUES(enabled),
      updated_at = CURRENT_TIMESTAMP;
  `);

  const competitorRows = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT('id', id, 'code', code)
    ), JSON_ARRAY())
    FROM yimin_peer_competitors
    WHERE code IN (${peerCompetitorSeeds.map((competitor) => sqlString(competitor.code)).join(",")});
  `)) || [];
  const competitorIdByCode = new Map(
    competitorRows.map((row) => [String(row.code), Number(row.id)]),
  );

  for (const competitor of peerCompetitorSeeds) {
    if (!competitor.rssUrl) continue;
    const competitorId = competitorIdByCode.get(competitor.code);
    if (!competitorId) continue;
    await mysqlExec(`
      INSERT INTO yimin_peer_sources (
        competitor_id,
        source_type,
        private_url,
        enabled
      )
      VALUES (
        ${sqlNumber(competitorId)},
        'wechat_rss',
        ${sqlString(competitor.rssUrl)},
        1
      )
      ON DUPLICATE KEY UPDATE
        private_url = VALUES(private_url),
        enabled = VALUES(enabled),
        updated_at = CURRENT_TIMESTAMP;
    `);
  }

  if (existingImport?.contentHash === contentHash) {
    return;
  }

  const payload = JSON.parse(raw);
  if (!Array.isArray(payload.competitors)) {
    throw new Error("Invalid peer monitor seed: competitors must be an array");
  }

  let importedCount = 0;
  for (const competitor of payload.competitors) {
    const competitorId = competitorIdByCode.get(String(competitor.code));
    if (!competitorId) {
      throw new Error(`Peer monitor competitor is not configured: ${competitor.code}`);
    }

    const projects = Array.isArray(competitor.projects) ? competitor.projects : [];
    for (let offset = 0; offset < projects.length; offset += 20) {
      const chunk = projects.slice(offset, offset + 20);
      await mysqlExec(`
        INSERT INTO yimin_peer_projects (
          competitor_id,
          source_key,
          project_name,
          category_raw,
          country_normalized,
          introduction,
          is_investment_project,
          investment_amount,
          investment_requirements_json,
          financial_requirements_json,
          advantages_json,
          application_conditions_json,
          process_summary,
          process_source_type,
          process_text,
          application_process_json,
          identity_type,
          residence_requirement,
          website_status_note,
          scraped_at,
          seed_hash
        )
        VALUES
          ${chunk.map((project) => `(
            ${sqlNumber(competitorId)},
            ${sqlString(project.sourceKey)},
            ${sqlString(project.projectName)},
            ${sqlString(project.categoryRaw || "")},
            ${sqlString(project.country || "其他")},
            ${sqlString(project.introduction || "")},
            ${project.isInvestmentProject ? 1 : 0},
            ${sqlString(project.investmentAmount || "")},
            ${sqlJson(project.investmentRequirements || [])},
            ${sqlJson(project.financialRequirements || [])},
            ${sqlJson(project.advantages || [])},
            ${sqlJson(project.applicationConditions || [])},
            ${sqlString(project.processSummary || "")},
            ${sqlString(project.processSourceType || "missing")},
            ${sqlString(project.processText || "")},
            ${sqlJson(project.applicationProcess || [])},
            ${sqlString(project.identityType || "")},
            ${sqlString(project.residenceRequirement || "")},
            ${sqlString(project.websiteStatusNote || "")},
            ${sqlDate(project.scrapedAt)},
            ${sqlString(contentHash)}
          )`).join(",\n")}
        ON DUPLICATE KEY UPDATE
          project_name = VALUES(project_name),
          category_raw = VALUES(category_raw),
          country_normalized = VALUES(country_normalized),
          introduction = VALUES(introduction),
          is_investment_project = VALUES(is_investment_project),
          investment_amount = VALUES(investment_amount),
          investment_requirements_json = VALUES(investment_requirements_json),
          financial_requirements_json = VALUES(financial_requirements_json),
          advantages_json = VALUES(advantages_json),
          application_conditions_json = VALUES(application_conditions_json),
          process_summary = VALUES(process_summary),
          process_source_type = VALUES(process_source_type),
          process_text = VALUES(process_text),
          application_process_json = VALUES(application_process_json),
          identity_type = VALUES(identity_type),
          residence_requirement = VALUES(residence_requirement),
          website_status_note = VALUES(website_status_note),
          scraped_at = VALUES(scraped_at),
          seed_hash = VALUES(seed_hash),
          updated_at = CURRENT_TIMESTAMP;
      `);
      importedCount += chunk.length;
    }
  }

  await mysqlExec(`
    DELETE FROM yimin_peer_projects
    WHERE seed_hash <> ${sqlString(contentHash)}
      AND website_source_id IS NULL;

    INSERT INTO yimin_peer_imports (
      source_name,
      content_hash,
      project_count,
      imported_at
    )
    VALUES (
      'peer-monitor-projects',
      ${sqlString(contentHash)},
      ${sqlNumber(importedCount)},
      CURRENT_TIMESTAMP
    )
    ON DUPLICATE KEY UPDATE
      content_hash = VALUES(content_hash),
      project_count = VALUES(project_count),
      imported_at = CURRENT_TIMESTAMP;
  `);
}

function isPeerMonitorDepartmentNameAllowed(name) {
  const normalized = String(name || "").trim().toLowerCase();
  if (!normalized) return false;
  return [...peerMonitorConfig.allowedDepartmentNames].some((allowed) => (
    normalized === allowed
    || normalized === `${allowed}部门`
    || normalized.startsWith(`${allowed}-`)
    || normalized.startsWith(`${allowed} `)
    || normalized.startsWith(`${allowed}（`)
    || normalized.startsWith(`${allowed}(`)
    || normalized.startsWith(`${allowed}部门-`)
    || normalized.startsWith(`${allowed}部门 `)
    || normalized.startsWith(`${allowed}部门（`)
    || normalized.startsWith(`${allowed}部门(`)
  ));
}

async function getPeerMonitorAccess(req) {
  const identity = getSsoIdentityFromRequest(req);
  if (peerMonitorConfig.openAccess) {
    return { allowed: true, identity: identity || null, reason: "open_access" };
  }

  if (!identity?.userId) {
    return { allowed: false, identity: null, reason: "missing_identity" };
  }

  const userId = String(identity.userId).trim().toLowerCase();
  if (peerMonitorConfig.allowedUserIds.has(userId)) {
    return { allowed: true, identity, reason: "allowed_user" };
  }

  if (
    identity.source === "local-test"
    && isPeerMonitorDepartmentNameAllowed(localTestSsoConfig.departmentName)
  ) {
    return { allowed: true, identity, reason: "allowed_department" };
  }

  const user = await mysqlJson(`
    SELECT JSON_OBJECT(
      'departmentIds', COALESCE(departments_json, JSON_ARRAY())
    )
    FROM yimin_wx_users
    WHERE userid = ${sqlString(identity.userId)}
    LIMIT 1;
  `);
  let departmentIds = normalizeDepartmentIds(user?.departmentIds);
  if (!departmentIds.length && identity.source === "local-test") {
    departmentIds = await resolveLocalTestDepartmentIds(identity.departmentIds);
  }
  if (!departmentIds.length) {
    return { allowed: false, identity, reason: "department_not_found" };
  }

  const departmentNames = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(department_name), JSON_ARRAY())
    FROM yimin_wx_departments
    WHERE department_id IN (${departmentIds.map(sqlNumber).join(",")});
  `)) || [];
  const allowed = departmentNames.some(isPeerMonitorDepartmentNameAllowed);
  return {
    allowed,
    identity,
    reason: allowed ? "allowed_department" : "department_not_allowed",
  };
}

function peerArticleSqlIdentity(alias = "a") {
  const tableAlias = /^[a-z][a-z0-9_]*$/i.test(alias) ? alias : "a";
  return `
    CASE
      WHEN CHAR_LENGTH(TRIM(COALESCE(${tableAlias}.private_url, ''))) > 0 THEN CONCAT(
        'url:',
        LOWER(TRIM(TRAILING '/' FROM SUBSTRING_INDEX(
          TRIM(${tableAlias}.private_url),
          '#',
          1
        )))
      )
      WHEN CHAR_LENGTH(TRIM(COALESCE(${tableAlias}.external_id, ''))) > 0 THEN CONCAT(
        'external:',
        LOWER(TRIM(${tableAlias}.external_id))
      )
      ELSE CONCAT(
        'title-date:',
        LOWER(TRIM(${tableAlias}.title)),
        '\n',
        DATE_FORMAT(
          COALESCE(${tableAlias}.published_at, ${tableAlias}.first_fetched_at),
          '%Y-%m-%d %H:%i'
        )
      )
    END
  `;
}

async function listPeerMonitorOverview() {
  return mysqlJsonRows(`
    SELECT JSON_OBJECT(
      'code', code,
      'displayName', private_name,
      'anonymousName', display_name,
      'websiteDomain', private_domain,
      'projectCount', project_count,
      'articleCount', article_count,
      'hasRss', IF(rss_source_count > 0, CAST(TRUE AS JSON), CAST(FALSE AS JSON)),
      'lastFetchedAt', last_fetched_at,
      'lastFetchError', last_fetch_error
    )
    FROM (
      SELECT
        c.id,
        c.code,
        c.display_name,
        c.private_name,
        c.private_domain,
        c.sort_order,
        (
          SELECT COUNT(*)
          FROM yimin_peer_projects p
          WHERE p.competitor_id = c.id
            AND p.lifecycle_status = 'active'
        ) AS project_count,
        (
          SELECT COUNT(DISTINCT ${peerArticleSqlIdentity("a")})
          FROM yimin_peer_articles a
          JOIN yimin_peer_sources s ON s.id = a.source_id
          WHERE s.competitor_id = c.id
        ) AS article_count,
        (
          SELECT COUNT(*)
          FROM yimin_peer_sources s
          WHERE s.competitor_id = c.id
            AND s.source_type = 'wechat_rss'
            AND s.enabled = 1
        ) AS rss_source_count,
        (
          SELECT IF(
            MAX(s.last_fetched_at) IS NULL,
            NULL,
            DATE_FORMAT(MAX(s.last_fetched_at), '%Y-%m-%dT%H:%i:%s+08:00')
          )
          FROM yimin_peer_sources s
          WHERE s.competitor_id = c.id
            AND s.source_type = 'wechat_rss'
        ) AS last_fetched_at,
        (
          SELECT MAX(s.last_fetch_error)
          FROM yimin_peer_sources s
          WHERE s.competitor_id = c.id
            AND s.source_type = 'wechat_rss'
        ) AS last_fetch_error
      FROM yimin_peer_competitors c
      WHERE c.enabled = 1
    ) peer_overview
    ORDER BY sort_order, id;
  `);
}

async function listPeerProjects(competitorCode) {
  const projects = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT(
        'id', id,
        'projectName', project_name,
        'categoryRaw', category_raw,
        'country', country_normalized,
        'introduction', introduction,
        'isInvestmentProject', IF(is_investment_project = 1, CAST(TRUE AS JSON), CAST(FALSE AS JSON)),
        'investmentAmount', investment_amount,
        'investmentRequirements', COALESCE(investment_requirements_json, JSON_ARRAY()),
        'financialRequirements', COALESCE(financial_requirements_json, JSON_ARRAY()),
        'advantages', COALESCE(advantages_json, JSON_ARRAY()),
        'applicationConditions', COALESCE(application_conditions_json, JSON_ARRAY()),
        'processSummary', process_summary,
        'processSourceType', process_source_type,
        'processText', process_text,
        'applicationProcess', COALESCE(application_process_json, JSON_ARRAY()),
        'identityType', identity_type,
        'residenceRequirement', residence_requirement,
        'websiteStatusNote', website_status_note,
        'canonicalUrl', canonical_url,
        'scrapedAt', IF(scraped_at IS NULL, NULL, DATE_FORMAT(scraped_at, '%Y-%m-%dT%H:%i:%s+08:00'))
      )
    ), JSON_ARRAY())
    FROM (
      SELECT p.*
      FROM yimin_peer_projects p
      JOIN yimin_peer_competitors c ON c.id = p.competitor_id
      WHERE c.code = ${sqlString(competitorCode)}
        AND c.enabled = 1
        AND p.lifecycle_status = 'active'
      ORDER BY p.country_normalized, p.project_name, p.id
    ) peer_projects;
  `)) || [];
  const countries = [...new Set(
    projects.map((project) => String(project.country || "").trim()).filter(Boolean),
  )].sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
  return { projects, countries };
}

function emptyPeerWebsiteCounts() {
  return {
    baseline: 0,
    added: 0,
    changed: 0,
    removed: 0,
    reappeared: 0,
    unchanged: 0,
    pendingRemoval: 0,
    rejected: 0,
  };
}

function getPeerWebsiteRunStatus(collectorResults) {
  const accepted = collectorResults.filter((result) => result.status !== "rejected");
  if (!accepted.length || accepted.every((result) => result.status === "failed")) {
    return "failed";
  }
  if (collectorResults.some((result) => result.status !== "completed")) {
    return "partial";
  }
  return "completed";
}

async function getPeerWebsiteRunRecord(runId) {
  return mysqlJson(`
    SELECT JSON_OBJECT(
      'id', id,
      'runId', run_id,
      'schemaVersion', schema_version,
      'payloadHash', payload_hash,
      'status', status,
      'collectorCount', collector_count,
      'acceptedCount', accepted_count,
      'rejectedCount', rejected_count,
      'startedAt', DATE_FORMAT(started_at, '%Y-%m-%dT%H:%i:%s+08:00'),
      'finishedAt', DATE_FORMAT(finished_at, '%Y-%m-%dT%H:%i:%s+08:00'),
      'result', result_json,
      'error', error,
      'createdAt', DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s+08:00')
    )
    FROM yimin_peer_website_runs
    WHERE run_id = ${sqlString(runId)}
    LIMIT 1;
  `);
}

async function getPeerWebsiteRunDetail(runId) {
  const run = await getPeerWebsiteRunRecord(runId);
  if (!run) return null;
  const collectors = await mysqlJsonRows(`
    SELECT JSON_OBJECT(
      'peerCode', peer_code,
      'sourceDomain', source_domain,
      'collectorVersion', collector_version,
      'status', status,
      'error', error,
      'warnings', COALESCE(warnings_json, JSON_ARRAY()),
      'discoveredCount', discovered_count,
      'successCount', success_count,
      'failedCount', failed_count,
      'baseline', baseline_count,
      'added', added_count,
      'changed', changed_count,
      'removed', removed_count,
      'reappeared', reappeared_count,
      'unchanged', unchanged_count,
      'pendingRemoval', pending_removal_count,
      'result', result_json,
      'createdAt', DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s+08:00')
    )
    FROM yimin_peer_website_source_runs
    WHERE run_id = ${sqlNumber(run.id)}
    ORDER BY id;
  `);
  return { ...run, collectors };
}

async function getPeerWebsiteSourceContext(peerCode, sourceDomain) {
  return mysqlJson(`
    SELECT JSON_OBJECT(
      'competitorId', c.id,
      'competitorCode', c.code,
      'competitorName', c.private_name,
      'websiteSourceId', s.id,
      'sourceDomain', COALESCE(s.source_domain, ${sqlString(sourceDomain)}),
      'baselineCompleted', IF(COALESCE(s.baseline_completed, 0) = 1, CAST(TRUE AS JSON), CAST(FALSE AS JSON))
    )
    FROM yimin_peer_competitors c
    LEFT JOIN yimin_peer_website_sources s
      ON s.competitor_id = c.id
     AND s.source_domain = ${sqlString(sourceDomain)}
    WHERE c.code = ${sqlString(peerCode)}
      AND c.enabled = 1
    LIMIT 1;
  `);
}

async function ensurePeerWebsiteSource(collector) {
  await mysqlExec(`
    INSERT INTO yimin_peer_website_sources (
      competitor_id,
      source_domain,
      source_url,
      collector_version
    )
    SELECT
      c.id,
      ${sqlString(collector.source_domain)},
      ${sqlString(`https://${collector.source_domain}/`)},
      ${sqlString(collector.collector_version)}
    FROM yimin_peer_competitors c
    WHERE c.code = ${sqlString(collector.peer_code)}
      AND c.enabled = 1
    ON DUPLICATE KEY UPDATE
      source_url = VALUES(source_url),
      collector_version = VALUES(collector_version),
      updated_at = CURRENT_TIMESTAMP;
  `);
  return getPeerWebsiteSourceContext(collector.peer_code, collector.source_domain);
}

async function loadPeerWebsiteCurrentProjects(websiteSourceId) {
  if (!websiteSourceId) return [];
  return mysqlJsonRows(`
    SELECT JSON_OBJECT(
      'id', p.id,
      'sourceKey', p.source_key,
      'sourceProjectId', p.source_project_id,
      'stableIdentity', p.stable_identity,
      'canonicalUrl', p.canonical_url,
      'canonicalUrlHash', p.canonical_url_hash,
      'contentHash', p.content_hash,
      'currentVersionId', p.current_version_id,
      'lifecycleStatus', p.lifecycle_status,
      'missingSuccessCount', p.missing_success_count,
      'snapshot', COALESCE(v.snapshot_json, JSON_OBJECT())
    )
    FROM yimin_peer_projects p
    LEFT JOIN yimin_peer_project_versions v ON v.id = p.current_version_id
    WHERE p.website_source_id = ${sqlNumber(websiteSourceId)}
    ORDER BY p.id;
  `);
}

async function planPeerWebsiteCollector(collector) {
  const source = await getPeerWebsiteSourceContext(collector.peer_code, collector.source_domain);
  if (!source) {
    throw new Error(`未找到启用的同行配置: ${collector.peer_code}`);
  }
  const currentProjects = await loadPeerWebsiteCurrentProjects(source.websiteSourceId);
  const plan = buildPeerWebsiteDiffPlan({
    collector,
    currentProjects,
    hasBaseline: Boolean(source.baselineCompleted),
  });
  return { source, currentProjects, plan };
}

function flattenWebsiteProcessText(value) {
  const fragments = [];
  const walk = (item) => {
    if (Array.isArray(item)) {
      item.forEach(walk);
      return;
    }
    if (item && typeof item === "object") {
      Object.values(item).forEach(walk);
      return;
    }
    const text = String(item ?? "").trim();
    if (text) fragments.push(text);
  };
  walk(value);
  return [...new Set(fragments)].join(" ").slice(0, 200_000);
}

function buildPeerWebsiteDisplayProject(project, peerSeed) {
  const brandTerms = peerSeed?.brandTerms || [];
  const applicationProcess = sanitizeWebsiteValue(project.application_process || [], brandTerms);
  const handlingProcess = sanitizeWebsiteValue(project.handling_process || [], brandTerms);
  const processText = sanitizeWebsiteText(
    flattenWebsiteProcessText([applicationProcess, handlingProcess]),
    brandTerms,
  );
  return {
    projectName: sanitizeWebsiteText(project.project_name, brandTerms),
    category: sanitizeWebsiteText(project.category, brandTerms),
    country: sanitizeWebsiteText(project.country_or_region, brandTerms) || "其他",
    introduction: sanitizeWebsiteText(project.introduction, brandTerms),
    isInvestmentProject: Boolean(
      project.investment_amount
      || project.investment_requirements?.length
      || project.financial_requirements?.length
    ),
    investmentAmount: sanitizeWebsiteText(project.investment_amount, brandTerms),
    investmentRequirements: sanitizeWebsiteValue(project.investment_requirements || [], brandTerms),
    financialRequirements: sanitizeWebsiteValue(project.financial_requirements || [], brandTerms),
    advantages: sanitizeWebsiteValue(project.advantages || [], brandTerms),
    applicationConditions: sanitizeWebsiteValue(project.application_conditions || [], brandTerms),
    processSummary: processText.slice(0, 2000),
    processSourceType: sanitizeWebsiteText(project.process_source_type || "missing", brandTerms),
    processText,
    applicationProcess,
    handlingProcess,
    identityType: sanitizeWebsiteText(project.identity_type, brandTerms),
    residenceRequirement: sanitizeWebsiteText(project.residence_requirement, brandTerms),
    websiteStatusNote: sanitizeWebsiteText(project.website_status_note, brandTerms),
  };
}

function buildPeerWebsiteProjectWriteSql({
  project,
  source,
  runDbId,
  detectedAt,
  peerSeed,
  current = null,
}) {
  const display = buildPeerWebsiteDisplayProject(project, peerSeed);
  const sourceKey = buildWebsiteProjectSourceKey(project.peer_code || peerSeed?.code, project.stable_identity);
  const scrapedAt = project.scraped_at || detectedAt;
  if (!current) {
    return {
      sourceKey,
      projectIdExpression: `(SELECT id FROM yimin_peer_projects WHERE competitor_id = ${sqlNumber(source.competitorId)} AND source_key = ${sqlString(sourceKey)} LIMIT 1)`,
      projectWhereSql: `p.competitor_id = ${sqlNumber(source.competitorId)} AND p.source_key = ${sqlString(sourceKey)}`,
      sql: `
        INSERT INTO yimin_peer_projects (
          competitor_id, source_key, website_source_id, source_project_id, stable_identity,
          canonical_url, canonical_url_hash, content_hash, lifecycle_status,
          missing_success_count, first_seen_at, last_seen_at, removed_at,
          project_name, category_raw, country_normalized, introduction,
          is_investment_project, investment_amount, investment_requirements_json,
          financial_requirements_json, advantages_json, application_conditions_json,
          process_summary, process_source_type, process_text, application_process_json,
          handling_process_json, identity_type, residence_requirement, website_status_note,
          scraped_at, seed_hash
        ) VALUES (
          ${sqlNumber(source.competitorId)}, ${sqlString(sourceKey)}, ${sqlNumber(source.websiteSourceId)},
          ${sqlString(project.source_project_id || null)}, ${sqlString(project.stable_identity)},
          ${sqlString(project.canonical_url)}, ${sqlString(project.canonical_url_hash)}, ${sqlString(project.content_hash)},
          'active', 0, ${sqlDate(detectedAt)}, ${sqlDate(detectedAt)}, NULL,
          ${sqlString(display.projectName)}, ${sqlString(display.category)}, ${sqlString(display.country)},
          ${sqlString(display.introduction)}, ${display.isInvestmentProject ? 1 : 0},
          ${sqlString(display.investmentAmount)}, ${sqlJson(display.investmentRequirements)},
          ${sqlJson(display.financialRequirements)}, ${sqlJson(display.advantages)},
          ${sqlJson(display.applicationConditions)}, ${sqlString(display.processSummary)},
          ${sqlString(display.processSourceType || "missing")}, ${sqlString(display.processText)},
          ${sqlJson(display.applicationProcess)}, ${sqlJson(display.handlingProcess)},
          ${sqlString(display.identityType)}, ${sqlString(display.residenceRequirement)},
          ${sqlString(display.websiteStatusNote)}, ${sqlDate(scrapedAt)}, ${sqlString(project.content_hash)}
        )
        ON DUPLICATE KEY UPDATE
          website_source_id = VALUES(website_source_id),
          source_project_id = VALUES(source_project_id),
          stable_identity = VALUES(stable_identity),
          canonical_url = VALUES(canonical_url),
          canonical_url_hash = VALUES(canonical_url_hash),
          content_hash = VALUES(content_hash),
          lifecycle_status = 'active',
          missing_success_count = 0,
          last_seen_at = VALUES(last_seen_at),
          removed_at = NULL,
          project_name = VALUES(project_name),
          category_raw = VALUES(category_raw),
          country_normalized = VALUES(country_normalized),
          introduction = VALUES(introduction),
          is_investment_project = VALUES(is_investment_project),
          investment_amount = VALUES(investment_amount),
          investment_requirements_json = VALUES(investment_requirements_json),
          financial_requirements_json = VALUES(financial_requirements_json),
          advantages_json = VALUES(advantages_json),
          application_conditions_json = VALUES(application_conditions_json),
          process_summary = VALUES(process_summary),
          process_source_type = VALUES(process_source_type),
          process_text = VALUES(process_text),
          application_process_json = VALUES(application_process_json),
          handling_process_json = VALUES(handling_process_json),
          identity_type = VALUES(identity_type),
          residence_requirement = VALUES(residence_requirement),
          website_status_note = VALUES(website_status_note),
          scraped_at = VALUES(scraped_at),
          seed_hash = VALUES(seed_hash),
          updated_at = CURRENT_TIMESTAMP;
      `,
    };
  }

  return {
    sourceKey,
    projectIdExpression: sqlNumber(current.id),
    projectWhereSql: `p.id = ${sqlNumber(current.id)}`,
    sql: `
      UPDATE yimin_peer_projects SET
        source_key = ${sqlString(sourceKey)},
        source_project_id = ${sqlString(project.source_project_id || null)},
        stable_identity = ${sqlString(project.stable_identity)},
        canonical_url = ${sqlString(project.canonical_url)},
        canonical_url_hash = ${sqlString(project.canonical_url_hash)},
        content_hash = ${sqlString(project.content_hash)},
        lifecycle_status = 'active',
        missing_success_count = 0,
        last_seen_at = ${sqlDate(detectedAt)},
        removed_at = NULL,
        project_name = ${sqlString(display.projectName)},
        category_raw = ${sqlString(display.category)},
        country_normalized = ${sqlString(display.country)},
        introduction = ${sqlString(display.introduction)},
        is_investment_project = ${display.isInvestmentProject ? 1 : 0},
        investment_amount = ${sqlString(display.investmentAmount)},
        investment_requirements_json = ${sqlJson(display.investmentRequirements)},
        financial_requirements_json = ${sqlJson(display.financialRequirements)},
        advantages_json = ${sqlJson(display.advantages)},
        application_conditions_json = ${sqlJson(display.applicationConditions)},
        process_summary = ${sqlString(display.processSummary)},
        process_source_type = ${sqlString(display.processSourceType || "missing")},
        process_text = ${sqlString(display.processText)},
        application_process_json = ${sqlJson(display.applicationProcess)},
        handling_process_json = ${sqlJson(display.handlingProcess)},
        identity_type = ${sqlString(display.identityType)},
        residence_requirement = ${sqlString(display.residenceRequirement)},
        website_status_note = ${sqlString(display.websiteStatusNote)},
        scraped_at = ${sqlDate(scrapedAt)},
        seed_hash = ${sqlString(project.content_hash)},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlNumber(current.id)}
        AND website_source_id = ${sqlNumber(source.websiteSourceId)};
    `,
  };
}

function buildPeerWebsiteVersionSql({
  projectIdExpression,
  projectWhereSql,
  project,
  source,
  runDbId,
  detectedAt,
}) {
  return `
    INSERT INTO yimin_peer_project_versions (
      project_id, website_source_id, run_id, content_hash,
      canonical_url, snapshot_json, detected_at
    )
    SELECT
      ${projectIdExpression},
      ${sqlNumber(source.websiteSourceId)},
      ${sqlNumber(runDbId)},
      ${sqlString(project.content_hash)},
      ${sqlString(project.canonical_url)},
      ${sqlJson(project)},
      ${sqlDate(detectedAt)}
    WHERE ${projectIdExpression} IS NOT NULL
    ON DUPLICATE KEY UPDATE
      canonical_url = VALUES(canonical_url),
      snapshot_json = VALUES(snapshot_json);

    UPDATE yimin_peer_projects p
    JOIN yimin_peer_project_versions v
      ON v.project_id = p.id
     AND v.content_hash = ${sqlString(project.content_hash)}
    SET p.current_version_id = v.id
    WHERE ${projectWhereSql};
  `;
}

function buildPeerWebsiteEventSql({
  action,
  projectIdExpression,
  source,
  runDbId,
  runId,
  detectedAt,
}) {
  if (!["added", "changed", "removed", "reappeared"].includes(action.type)) return "";
  const beforeVersionId = action.current?.currentVersionId
    ? sqlNumber(action.current.currentVersionId)
    : "NULL";
  const afterVersionId = action.project
    ? `(
        SELECT v.id
        FROM yimin_peer_project_versions v
        WHERE v.project_id = ${projectIdExpression}
          AND v.content_hash = ${sqlString(action.project.content_hash)}
        LIMIT 1
      )`
    : "NULL";
  const evidenceUrl = action.project?.canonical_url || action.current?.canonicalUrl || "";
  const eventKey = createHash("sha256")
    .update([
      runId,
      action.type,
      action.project?.stable_identity || action.current?.stableIdentity || "",
      action.current?.contentHash || "",
      action.project?.content_hash || "",
    ].join("\n"))
    .digest("hex");
  return `
    INSERT INTO yimin_peer_project_events (
      event_key, project_id, competitor_id, website_source_id, run_id,
      event_type, before_version_id, after_version_id, changed_fields_json,
      evidence_url, detected_at
    )
    SELECT
      ${sqlString(eventKey)},
      ${projectIdExpression},
      ${sqlNumber(source.competitorId)},
      ${sqlNumber(source.websiteSourceId)},
      ${sqlNumber(runDbId)},
      ${sqlString(action.type)},
      ${beforeVersionId},
      ${afterVersionId},
      ${sqlJson(action.changedFields || [])},
      ${sqlString(evidenceUrl || null)},
      ${sqlDate(detectedAt)}
    WHERE ${projectIdExpression} IS NOT NULL
    ON DUPLICATE KEY UPDATE event_key = VALUES(event_key);
  `;
}

function buildPeerWebsiteCollectorResult(validationResult, plan = null, overrides = {}) {
  const collector = validationResult.collector || {};
  const counts = plan ? { ...emptyPeerWebsiteCounts(), ...plan } : emptyPeerWebsiteCounts();
  delete counts.actions;
  return {
    peerCode: validationResult.peerCode || collector.peer_code || "",
    sourceDomain: validationResult.sourceDomain || collector.source_domain || "",
    collectorVersion: collector.collector_version || "",
    status: overrides.status || (validationResult.valid ? collector.status : "rejected"),
    error: overrides.error || collector.error || validationResult.errors?.join("；") || "",
    warnings: (validationResult.warnings || []).slice(0, 50),
    warningCount: (validationResult.warnings || []).length,
    discoveredCount: collector.discovered_count || 0,
    successCount: collector.success_count || 0,
    failedCount: collector.failed_count || 0,
    ...counts,
    rejected: validationResult.valid ? 0 : Math.max(1, collector.projects?.length || 0),
  };
}

function buildPeerWebsiteSourceRunSql(runDbId, websiteSourceId, result) {
  return `
    INSERT INTO yimin_peer_website_source_runs (
      run_id, website_source_id, peer_code, source_domain, collector_version,
      status, error, warnings_json, discovered_count, success_count, failed_count,
      baseline_count, added_count, changed_count, removed_count, reappeared_count,
      unchanged_count, pending_removal_count, result_json
    ) VALUES (
      ${sqlNumber(runDbId)}, ${websiteSourceId ? sqlNumber(websiteSourceId) : "NULL"},
      ${sqlString(result.peerCode)}, ${sqlString(result.sourceDomain)}, ${sqlString(result.collectorVersion)},
      ${sqlString(result.status)}, ${sqlString(result.error || null)}, ${sqlJson(result.warnings || [])},
      ${sqlNumber(result.discoveredCount)}, ${sqlNumber(result.successCount)}, ${sqlNumber(result.failedCount)},
      ${sqlNumber(result.baseline)}, ${sqlNumber(result.added)}, ${sqlNumber(result.changed)},
      ${sqlNumber(result.removed)}, ${sqlNumber(result.reappeared)}, ${sqlNumber(result.unchanged)},
      ${sqlNumber(result.pendingRemoval)}, ${sqlJson(result)}
    )
    ON DUPLICATE KEY UPDATE
      website_source_id = VALUES(website_source_id),
      collector_version = VALUES(collector_version),
      status = VALUES(status),
      error = VALUES(error),
      warnings_json = VALUES(warnings_json),
      discovered_count = VALUES(discovered_count),
      success_count = VALUES(success_count),
      failed_count = VALUES(failed_count),
      baseline_count = VALUES(baseline_count),
      added_count = VALUES(added_count),
      changed_count = VALUES(changed_count),
      removed_count = VALUES(removed_count),
      reappeared_count = VALUES(reappeared_count),
      unchanged_count = VALUES(unchanged_count),
      pending_removal_count = VALUES(pending_removal_count),
      result_json = VALUES(result_json);
  `;
}

async function applyPeerWebsiteCompletedCollector({
  validationResult,
  source,
  plan,
  runDbId,
  runId,
  detectedAt,
}) {
  const collector = validationResult.collector;
  const peerSeed = peerCompetitorSeeds.find((peer) => peer.code === collector.peer_code);
  const statements = ["START TRANSACTION;"];

  for (const action of plan.actions) {
    if (["baseline", "added", "changed", "reappeared", "unchanged"].includes(action.type)) {
      const write = buildPeerWebsiteProjectWriteSql({
        project: action.project,
        source,
        runDbId,
        detectedAt,
        peerSeed,
        current: action.current,
      });
      statements.push(write.sql);
      if (["baseline", "added", "changed", "reappeared"].includes(action.type)) {
        statements.push(buildPeerWebsiteVersionSql({
          projectIdExpression: write.projectIdExpression,
          projectWhereSql: write.projectWhereSql,
          project: action.project,
          source,
          runDbId,
          detectedAt,
        }));
      }
      statements.push(buildPeerWebsiteEventSql({
        action,
        projectIdExpression: write.projectIdExpression,
        source,
        runDbId,
        runId,
        detectedAt,
      }));
      continue;
    }

    const nextMissingCount = Number(action.current?.missingSuccessCount || 0) + 1;
    if (action.type === "missing_once") {
      statements.push(`
        UPDATE yimin_peer_projects
        SET missing_success_count = ${sqlNumber(nextMissingCount)}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${sqlNumber(action.current.id)}
          AND website_source_id = ${sqlNumber(source.websiteSourceId)}
          AND lifecycle_status = 'active';
      `);
      continue;
    }
    if (action.type === "removed") {
      statements.push(`
        UPDATE yimin_peer_projects
        SET lifecycle_status = 'removed',
            missing_success_count = ${sqlNumber(nextMissingCount)},
            removed_at = ${sqlDate(detectedAt)},
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${sqlNumber(action.current.id)}
          AND website_source_id = ${sqlNumber(source.websiteSourceId)}
          AND lifecycle_status = 'active';
      `);
      statements.push(buildPeerWebsiteEventSql({
        action,
        projectIdExpression: sqlNumber(action.current.id),
        source,
        runDbId,
        runId,
        detectedAt,
      }));
    }
  }

  if (!source.baselineCompleted) {
    statements.push(`
      DELETE FROM yimin_peer_projects
      WHERE competitor_id = ${sqlNumber(source.competitorId)}
        AND website_source_id IS NULL;
    `);
  }
  const result = buildPeerWebsiteCollectorResult(validationResult, plan);
  statements.push(`
    UPDATE yimin_peer_website_sources SET
      collector_version = ${sqlString(collector.collector_version)},
      last_status = 'completed',
      last_error = NULL,
      last_run_id = ${sqlNumber(runDbId)},
      last_success_run_id = ${sqlNumber(runDbId)},
      last_success_at = ${sqlDate(detectedAt)},
      baseline_completed = 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${sqlNumber(source.websiteSourceId)};

    ${buildPeerWebsiteSourceRunSql(runDbId, source.websiteSourceId, result)}
    COMMIT;
  `);
  await mysqlExec(statements.join("\n"));
  return result;
}

async function recordPeerWebsiteNonCompletedCollector({ validationResult, source, runDbId }) {
  const result = buildPeerWebsiteCollectorResult(validationResult);
  const collector = validationResult.collector || {};
  const statements = [];
  if (source?.websiteSourceId) {
    statements.push(`
      UPDATE yimin_peer_website_sources SET
        collector_version = ${sqlString(collector.collector_version || "")},
        last_status = ${sqlString(result.status === "rejected" ? "failed" : result.status)},
        last_error = ${sqlString(result.error || null)},
        last_run_id = ${sqlNumber(runDbId)},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlNumber(source.websiteSourceId)};
    `);
  }
  statements.push(buildPeerWebsiteSourceRunSql(runDbId, source?.websiteSourceId, result));
  await mysqlExec(statements.join("\n"));
  return result;
}

function summarizePeerWebsiteResults(results) {
  const totals = emptyPeerWebsiteCounts();
  results.forEach((result) => {
    Object.keys(totals).forEach((key) => {
      totals[key] += Number(result[key] || 0);
    });
  });
  return totals;
}

async function importPeerWebsiteSnapshot(rawSnapshot, { dryRun = false } = {}) {
  const validation = validatePeerWebsiteSnapshot(rawSnapshot, peerCompetitorSeeds);
  if (!validation.valid) {
    const error = new Error(validation.errors.join("；"));
    error.code = "INVALID_WEBSITE_SNAPSHOT";
    throw error;
  }

  if (!dryRun) {
    const existing = await getPeerWebsiteRunRecord(validation.snapshot.run_id);
    if (existing) {
      if (existing.payloadHash !== validation.payloadHash) {
        const error = new Error("相同 run_id 已提交过不同内容");
        error.code = "WEBSITE_RUN_ID_CONFLICT";
        throw error;
      }
      if (existing.result) return { ...existing.result, reused: true };
      const active = activePeerWebsiteImports.get(validation.snapshot.run_id);
      if (active) return active;
      const error = new Error("该 run_id 已存在未完成记录，请更换 run_id 后重新提交");
      error.code = "WEBSITE_RUN_INCOMPLETE";
      throw error;
    }
  }

  const executeImport = async () => {
    if (dryRun) {
      const collectorResults = [];
      for (const validationResult of validation.collectors) {
        if (!validationResult.valid) {
          collectorResults.push(buildPeerWebsiteCollectorResult(validationResult));
          continue;
        }
        const { plan } = await planPeerWebsiteCollector(validationResult.collector);
        collectorResults.push(buildPeerWebsiteCollectorResult(validationResult, plan));
      }
      return {
        runId: validation.snapshot.run_id,
        schemaVersion: PEER_WEBSITE_SCHEMA_VERSION,
        status: getPeerWebsiteRunStatus(collectorResults),
        dryRun: true,
        reused: false,
        collectorCount: collectorResults.length,
        acceptedCount: collectorResults.filter((result) => result.status !== "rejected").length,
        rejectedCount: collectorResults.filter((result) => result.status === "rejected").length,
        totals: summarizePeerWebsiteResults(collectorResults),
        collectors: collectorResults,
      };
    }

    await mysqlExec(`
      INSERT INTO yimin_peer_website_runs (
        run_id, schema_version, payload_hash, status, collector_count,
        started_at, finished_at
      ) VALUES (
        ${sqlString(validation.snapshot.run_id)},
        ${sqlString(PEER_WEBSITE_SCHEMA_VERSION)},
        ${sqlString(validation.payloadHash)},
        'running',
        ${sqlNumber(validation.collectors.length)},
        ${sqlDate(validation.snapshot.started_at)},
        ${sqlDate(validation.snapshot.finished_at)}
      );
    `);
    const runRecord = await getPeerWebsiteRunRecord(validation.snapshot.run_id);
    if (!runRecord) throw new Error("官网导入运行记录创建失败");

    const collectorResults = [];
    for (const validationResult of validation.collectors) {
      if (!validationResult.valid) {
        collectorResults.push(await recordPeerWebsiteNonCompletedCollector({
          validationResult,
          source: null,
          runDbId: runRecord.id,
        }));
        continue;
      }

      let source = null;
      try {
        source = await ensurePeerWebsiteSource(validationResult.collector);
        if (!source?.websiteSourceId) throw new Error("官网来源初始化失败");
        if (validationResult.collector.status !== "completed") {
          collectorResults.push(await recordPeerWebsiteNonCompletedCollector({
            validationResult,
            source,
            runDbId: runRecord.id,
          }));
          continue;
        }
        const currentProjects = await loadPeerWebsiteCurrentProjects(source.websiteSourceId);
        const plan = buildPeerWebsiteDiffPlan({
          collector: validationResult.collector,
          currentProjects,
          hasBaseline: Boolean(source.baselineCompleted),
        });
        collectorResults.push(await applyPeerWebsiteCompletedCollector({
          validationResult,
          source,
          plan,
          runDbId: runRecord.id,
          runId: validation.snapshot.run_id,
          detectedAt: validation.snapshot.finished_at,
        }));
      } catch (error) {
        const failedValidation = {
          ...validationResult,
          collector: { ...validationResult.collector, status: "failed" },
          errors: [error instanceof Error ? error.message : String(error)],
        };
        collectorResults.push(await recordPeerWebsiteNonCompletedCollector({
          validationResult: failedValidation,
          source,
          runDbId: runRecord.id,
        }));
      }
    }

    const status = getPeerWebsiteRunStatus(collectorResults);
    const result = {
      runId: validation.snapshot.run_id,
      schemaVersion: PEER_WEBSITE_SCHEMA_VERSION,
      status,
      dryRun: false,
      reused: false,
      collectorCount: collectorResults.length,
      acceptedCount: collectorResults.filter((item) => item.status !== "rejected").length,
      rejectedCount: collectorResults.filter((item) => item.status === "rejected").length,
      totals: summarizePeerWebsiteResults(collectorResults),
      collectors: collectorResults,
    };
    await mysqlExec(`
      UPDATE yimin_peer_website_runs SET
        status = ${sqlString(status)},
        accepted_count = ${sqlNumber(result.acceptedCount)},
        rejected_count = ${sqlNumber(result.rejectedCount)},
        result_json = ${sqlJson(result)},
        error = ${sqlString(status === "failed" ? "没有站点成功完成导入" : null)},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlNumber(runRecord.id)};
    `);
    return result;
  };

  if (dryRun) return executeImport();
  const active = activePeerWebsiteImports.get(validation.snapshot.run_id);
  if (active) return active;
  const promise = executeImport().finally(() => {
    activePeerWebsiteImports.delete(validation.snapshot.run_id);
  });
  activePeerWebsiteImports.set(validation.snapshot.run_id, promise);
  return promise;
}

async function listPeerWebsiteEvents({ competitorCode = "", eventType = "", from = "", to = "", limit = 50, offset = 0 } = {}) {
  const filters = [];
  if (competitorCode) filters.push(`c.code = ${sqlString(competitorCode)}`);
  if (eventType) filters.push(`e.event_type = ${sqlString(eventType)}`);
  if (from) filters.push(`e.detected_at >= ${sqlDate(from)}`);
  if (to) filters.push(`e.detected_at <= ${sqlDate(to)}`);
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  return mysqlJsonRows(`
    SELECT JSON_OBJECT(
      'id', e.id,
      'eventType', e.event_type,
      'peerCode', c.code,
      'competitorName', c.private_name,
      'projectId', p.id,
      'projectName', p.project_name,
      'country', p.country_normalized,
      'category', p.category_raw,
      'changedFields', COALESCE(e.changed_fields_json, JSON_ARRAY()),
      'evidenceUrl', e.evidence_url,
      'beforeSnapshot', before_version.snapshot_json,
      'afterSnapshot', after_version.snapshot_json,
      'detectedAt', DATE_FORMAT(e.detected_at, '%Y-%m-%dT%H:%i:%s+08:00'),
      'runId', r.run_id
    )
    FROM yimin_peer_project_events e
    JOIN yimin_peer_projects p ON p.id = e.project_id
    JOIN yimin_peer_competitors c ON c.id = e.competitor_id
    JOIN yimin_peer_website_runs r ON r.id = e.run_id
    LEFT JOIN yimin_peer_project_versions before_version ON before_version.id = e.before_version_id
    LEFT JOIN yimin_peer_project_versions after_version ON after_version.id = e.after_version_id
    ${where}
    ORDER BY e.detected_at DESC, e.id DESC
    LIMIT ${sqlNumber(Math.min(100, Math.max(1, Number(limit) || 50)))}
    OFFSET ${sqlNumber(Math.max(0, Number(offset) || 0))};
  `);
}

async function listPeerArticles(competitorCode, { limit = 20, offset = 0 } = {}) {
  const pageSize = Math.min(50, Math.max(1, Number(limit) || 20));
  const pageOffset = Math.max(0, Number(offset) || 0);
  const rows = (await mysqlJson(`
    WITH ranked_peer_articles AS (
      SELECT
        a.*,
        c.private_name AS competitor_name,
        ROW_NUMBER() OVER (
          PARTITION BY a.source_id, ${peerArticleSqlIdentity("a")}
          ORDER BY
            IF(CHAR_LENGTH(TRIM(COALESCE(a.content_text, ''))) > 0, 1, 0) DESC,
            COALESCE(a.published_at, a.first_fetched_at) DESC,
            a.id DESC
        ) AS identity_rank
      FROM yimin_peer_articles a
      JOIN yimin_peer_sources s ON s.id = a.source_id
      JOIN yimin_peer_competitors c ON c.id = s.competitor_id
      WHERE c.code = ${sqlString(competitorCode)}
        AND c.enabled = 1
        AND s.enabled = 1
        AND s.source_type = 'wechat_rss'
    )
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT(
        'id', id,
        'title', title,
        'summary', summary,
        'content', content_text,
        'url', private_url,
        'imageUrl', private_image_url,
        'competitorName', competitor_name,
        'hasFullContent', IF(
          CHAR_LENGTH(TRIM(COALESCE(content_text, ''))) > 0,
          CAST(TRUE AS JSON),
          CAST(FALSE AS JSON)
        ),
        'publishedAt', published_at
      )
    ), JSON_ARRAY())
    FROM (
      SELECT
        a.id,
        a.title,
        a.summary,
        a.content_text,
        a.private_url,
        a.private_image_url,
        a.competitor_name,
        IF(
          a.published_at IS NULL,
          NULL,
          DATE_FORMAT(a.published_at, '%Y-%m-%dT%H:%i:%s+08:00')
        ) AS published_at
      FROM ranked_peer_articles a
      WHERE a.identity_rank = 1
      ORDER BY COALESCE(a.published_at, a.first_fetched_at) DESC, a.id DESC
      LIMIT ${sqlNumber(pageSize + 1)}
      OFFSET ${sqlNumber(pageOffset)}
    ) peer_articles;
  `)) || [];
  const hasMore = rows.length > pageSize;
  const articles = rows.slice(0, pageSize).map((article) => {
    const competitorName = normalizePeerText(article.competitorName);
    const exposeOriginalName = (value) => {
      const text = normalizePeerText(value);
      return competitorName ? text.replace(/该机构/g, competitorName) : text;
    };
    const content = exposeOriginalName(article.content);
    return {
      ...article,
      title: exposeOriginalName(article.title),
      summary: exposeOriginalName(article.summary),
      content,
      url: normalizePeerArticleUrl(article.url),
      hasFullContent: Boolean(article.hasFullContent && content),
    };
  });
  return {
    articles,
    hasMore,
    nextOffset: pageOffset + articles.length,
  };
}

async function listPeerRssSources(competitorCode = "") {
  const codeFilter = competitorCode
    ? `AND c.code = ${sqlString(competitorCode)}`
    : "";
  return (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT(
        'id', s.id,
        'privateUrl', s.private_url,
        'competitorCode', c.code
      )
    ), JSON_ARRAY())
    FROM yimin_peer_sources s
    JOIN yimin_peer_competitors c ON c.id = s.competitor_id
    WHERE s.enabled = 1
      AND c.enabled = 1
      AND s.source_type = 'wechat_rss'
      ${codeFilter};
  `)) || [];
}

async function refreshPeerRssSource(source) {
  const result = await fetchWithTimeout(
    source.privateUrl,
    {},
    peerRssTimeoutMs,
  );
  if (!result.ok) {
    throw new Error(`RSS 返回 HTTP ${result.status}`);
  }
  const contentBytes = Buffer.byteLength(result.text, "utf8");
  if (contentBytes > peerRssMaxBytes) {
    const maxMegabytes = Math.round(peerRssMaxBytes / 1024 / 1024);
    throw new Error(`RSS 内容超过 ${maxMegabytes} MB 安全上限`);
  }

  const items = parsePeerFeed(result.text, source.id);
  if (!items.length) {
    throw new Error("RSS 中没有可识别的文章");
  }

  const existingRows = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT(
        'id', id,
        'dedupeHash', dedupe_hash,
        'externalId', external_id,
        'title', title,
        'privateUrl', private_url,
        'publishedAt', IF(
          published_at IS NULL,
          NULL,
          DATE_FORMAT(published_at, '%Y-%m-%dT%H:%i:%s+08:00')
        ),
        'hasFullContent', IF(
          CHAR_LENGTH(TRIM(COALESCE(content_text, ''))) > 0,
          CAST(TRUE AS JSON),
          CAST(FALSE AS JSON)
        )
      )
    ), JSON_ARRAY())
    FROM yimin_peer_articles
    WHERE source_id = ${sqlNumber(source.id)};
  `)) || [];
  const existingByHash = new Map(
    existingRows.map((row) => [String(row.dedupeHash || ""), row]),
  );
  const existingByIdentity = new Map();
  for (const row of existingRows) {
    for (const key of getPeerArticleIdentityKeys(row)) {
      if (!existingByIdentity.has(key)) existingByIdentity.set(key, row);
    }
  }
  const matchedItems = items.map((item) => {
    const existing = existingByHash.get(item.dedupeHash)
      || getPeerArticleIdentityKeys(item)
        .map((key) => existingByIdentity.get(key))
        .find(Boolean);
    return {
      ...item,
      existing,
      dedupeHash: existing?.dedupeHash || item.dedupeHash,
    };
  });
  const newItems = matchedItems.filter((item) => !item.existing);
  const contentBackfillItems = matchedItems.filter((item) => {
    const existing = item.existing;
    return existing && !existing.hasFullContent && Boolean(item.contentText.trim());
  });
  const itemsToWrite = [...newItems, ...contentBackfillItems];
  const newItemCount = newItems.length;
  const updatedItemCount = contentBackfillItems.length;

  for (let offset = 0; offset < itemsToWrite.length; offset += 10) {
    const chunk = itemsToWrite.slice(offset, offset + 10);
    await mysqlExec(`
      INSERT INTO yimin_peer_articles (
        source_id,
        external_id,
        dedupe_hash,
        title,
        summary,
        content_text,
        private_url,
        private_image_url,
        published_at,
        first_fetched_at,
        last_fetched_at
      )
      VALUES
        ${chunk.map((item) => `(
          ${sqlNumber(source.id)},
          ${sqlString(item.externalId)},
          ${sqlString(item.dedupeHash)},
          ${sqlString(item.title)},
          ${sqlString(item.summary || "")},
          ${sqlString(item.contentText || "")},
          ${sqlString(item.privateUrl || "")},
          ${sqlString(item.privateImageUrl || "")},
          ${sqlDate(item.publishedAt)},
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )`).join(",\n")}
      ON DUPLICATE KEY UPDATE
        external_id = VALUES(external_id),
        title = VALUES(title),
        summary = VALUES(summary),
        content_text = IF(
          CHAR_LENGTH(TRIM(VALUES(content_text))) > 0,
          VALUES(content_text),
          content_text
        ),
        private_url = VALUES(private_url),
        private_image_url = VALUES(private_image_url),
        published_at = VALUES(published_at),
        last_fetched_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP;
    `);
  }

  await mysqlExec(`
    UPDATE yimin_peer_sources
    SET last_fetched_at = CURRENT_TIMESTAMP,
        last_fetch_error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${sqlNumber(source.id)};
  `);
  return {
    itemCount: items.length,
    newItemCount,
    updatedItemCount,
  };
}

async function getPeerRefreshRun(runKey) {
  return mysqlJson(`
    SELECT JSON_OBJECT(
      'runKey', run_key,
      'competitorCode', competitor_code,
      'status', status,
      'sourceCount', source_count,
      'processedSourceCount', processed_source_count,
      'itemCount', item_count,
      'newItemCount', new_item_count,
      'updatedItemCount', updated_item_count,
      'error', error,
      'startedAt', DATE_FORMAT(started_at, '%Y-%m-%dT%H:%i:%s+08:00'),
      'finishedAt', IF(finished_at IS NULL, NULL, DATE_FORMAT(finished_at, '%Y-%m-%dT%H:%i:%s+08:00'))
    )
    FROM yimin_peer_refresh_runs
    WHERE run_key = ${sqlString(runKey)}
    LIMIT 1;
  `);
}

async function getLatestPeerRefreshRun() {
  return mysqlJson(`
    SELECT JSON_OBJECT(
      'runKey', run_key,
      'competitorCode', competitor_code,
      'status', status,
      'sourceCount', source_count,
      'processedSourceCount', processed_source_count,
      'itemCount', item_count,
      'newItemCount', new_item_count,
      'updatedItemCount', updated_item_count,
      'error', error,
      'startedAt', DATE_FORMAT(started_at, '%Y-%m-%dT%H:%i:%s+08:00'),
      'finishedAt', IF(finished_at IS NULL, NULL, DATE_FORMAT(finished_at, '%Y-%m-%dT%H:%i:%s+08:00'))
    )
    FROM yimin_peer_refresh_runs
    ORDER BY id DESC
    LIMIT 1;
  `);
}

async function runPeerRefresh(runKey, sources) {
  let processedSourceCount = 0;
  let itemCount = 0;
  let newItemCount = 0;
  let updatedItemCount = 0;
  const errors = [];

  try {
    for (const source of sources) {
      try {
        const result = await refreshPeerRssSource(source);
        itemCount += result.itemCount;
        newItemCount += result.newItemCount;
        updatedItemCount += result.updatedItemCount;
      } catch (error) {
        const cleanError = normalizePeerText(
          error instanceof Error ? error.message : String(error),
        );
        errors.push(cleanError);
        await mysqlExec(`
          UPDATE yimin_peer_sources
          SET last_fetch_error = ${sqlString(cleanError)},
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ${sqlNumber(source.id)};
        `);
      }
      processedSourceCount += 1;
      await mysqlExec(`
        UPDATE yimin_peer_refresh_runs
        SET processed_source_count = ${sqlNumber(processedSourceCount)},
            item_count = ${sqlNumber(itemCount)},
            new_item_count = ${sqlNumber(newItemCount)},
            updated_item_count = ${sqlNumber(updatedItemCount)},
            error = ${errors.length ? sqlString(errors.join("；")) : "NULL"}
        WHERE run_key = ${sqlString(runKey)};
      `);
    }

    const status = errors.length === sources.length ? "failed" : "completed";
    await mysqlExec(`
      UPDATE yimin_peer_refresh_runs
      SET status = ${sqlString(status)},
          processed_source_count = ${sqlNumber(processedSourceCount)},
          item_count = ${sqlNumber(itemCount)},
          new_item_count = ${sqlNumber(newItemCount)},
          updated_item_count = ${sqlNumber(updatedItemCount)},
          error = ${errors.length ? sqlString(errors.join("；")) : "NULL"},
          finished_at = CURRENT_TIMESTAMP
      WHERE run_key = ${sqlString(runKey)};
    `);
  } catch (error) {
    const cleanError = normalizePeerText(
      error instanceof Error ? error.message : String(error),
    );
    await mysqlExec(`
      UPDATE yimin_peer_refresh_runs
      SET status = 'failed',
          error = ${sqlString(cleanError)},
          finished_at = CURRENT_TIMESTAMP
      WHERE run_key = ${sqlString(runKey)};
    `);
  }
}

async function startPeerRefresh(competitorCode = "") {
  if (activePeerRefresh) {
    return {
      started: false,
      active: true,
      run: await getPeerRefreshRun(activePeerRefresh.runKey),
    };
  }

  const sources = await listPeerRssSources(competitorCode);
  if (!sources.length) {
    return {
      started: false,
      active: false,
      error: competitorCode ? "该同行尚未配置公众号 RSS" : "尚未配置可用的同行 RSS",
    };
  }

  const runKey = randomBytes(16).toString("hex");
  await mysqlExec(`
    INSERT INTO yimin_peer_refresh_runs (
      run_key,
      competitor_code,
      status,
      source_count
    )
    VALUES (
      ${sqlString(runKey)},
      ${competitorCode ? sqlString(competitorCode) : "NULL"},
      'running',
      ${sqlNumber(sources.length)}
    );
  `);

  activePeerRefresh = { runKey };
  void runPeerRefresh(runKey, sources)
    .catch((error) => {
      console.error("Peer monitor refresh failed:", error);
    })
    .finally(() => {
      if (activePeerRefresh?.runKey === runKey) {
        activePeerRefresh = null;
      }
    });

  return {
    started: true,
    active: true,
    run: await getPeerRefreshRun(runKey),
  };
}

function assertPeerDiscoveryConfiguration({ dryRun = false, retryCached = false } = {}) {
  if (!werssDbConfig.database) {
    throw new Error("未配置 WERSS_DATABASE_NAME，无法连接 WeRSS 数据库");
  }
  if (!dryRun && !retryCached && !peerWechatDiscoveryConfig.apiKey) {
    throw new Error("未配置 DAJIALA_API_KEY");
  }
}

function safeSecretEquals(left, right) {
  if (!left || !right) return false;
  const leftHash = createHash("sha256").update(String(left)).digest();
  const rightHash = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function isPeerDiscoveryAuthorized(req) {
  if (isLoopbackRequest(req) || requireAuth(req)) return true;
  const authorization = String(req.headers.authorization || "");
  const bearerToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  const headerToken = String(req.headers["x-cron-token"] || "").trim();
  return safeSecretEquals(peerWechatDiscoveryConfig.cronToken, bearerToken || headerToken);
}

async function syncPeerWechatDiscoveryAccounts(competitorCode = "") {
  const codeFilter = competitorCode ? `AND c.code = ${sqlString(competitorCode)}` : "";
  const sources = await mysqlJsonRows(`
    SELECT JSON_OBJECT(
      'sourceId', s.id,
      'privateUrl', s.private_url,
      'competitorCode', c.code,
      'competitorName', c.private_name,
      'sortOrder', c.sort_order
    )
    FROM yimin_peer_sources s
    JOIN yimin_peer_competitors c ON c.id = s.competitor_id
    WHERE s.source_type = 'wechat_rss'
      AND s.enabled = 1
      AND c.enabled = 1
      ${codeFilter}
    ORDER BY c.sort_order, c.id;
  `);

  for (const source of sources) {
    const feedId = extractWerssFeedId(source.privateUrl);
    if (!feedId) continue;
    const seed = peerCompetitorSeeds.find((item) => item.code === source.competitorCode);
    await mysqlExec(`
      INSERT INTO yimin_peer_wechat_accounts (
        source_id,
        provider,
        lookup_mode,
        provider_ghid,
        provider_nickname,
        werss_feed_id,
        enabled
      )
      VALUES (
        ${sqlNumber(source.sourceId)},
        'dajiala',
        ${sqlString(seed?.providerLookupMode || "auto")},
        ${sqlString(seed?.providerGhid || "")},
        ${sqlString(seed?.providerNickname || "")},
        ${sqlString(feedId)},
        1
      )
      ON DUPLICATE KEY UPDATE
        lookup_mode = IF(
          lookup_mode = 'auto' AND VALUES(lookup_mode) <> 'auto',
          VALUES(lookup_mode),
          lookup_mode
        ),
        provider_ghid = IF(provider_ghid = '', VALUES(provider_ghid), provider_ghid),
        provider_nickname = IF(provider_nickname = '', VALUES(provider_nickname), provider_nickname),
        werss_feed_id = VALUES(werss_feed_id),
        updated_at = CURRENT_TIMESTAMP;
    `);
  }

  return mysqlJsonRows(`
    SELECT JSON_OBJECT(
      'id', a.id,
      'sourceId', a.source_id,
      'lookupMode', a.lookup_mode,
      'providerGhid', a.provider_ghid,
      'providerNickname', a.provider_nickname,
      'werssFeedId', a.werss_feed_id,
      'competitorCode', c.code,
      'competitorName', c.private_name,
      'sortOrder', c.sort_order
    )
    FROM yimin_peer_wechat_accounts a
    JOIN yimin_peer_sources s ON s.id = a.source_id
    JOIN yimin_peer_competitors c ON c.id = s.competitor_id
    WHERE a.enabled = 1
      AND s.enabled = 1
      AND c.enabled = 1
      ${codeFilter}
    ORDER BY c.sort_order, c.id;
  `);
}

async function getWerssFeedBootstrap(feedId) {
  return werssMysqlJson(`
    SELECT JSON_OBJECT(
      'id', f.id,
      'name', f.mp_name,
      'status', f.status,
      'latestArticleUrl', (
        SELECT a.url
        FROM articles a
        WHERE a.mp_id = f.id
          AND a.url <> ''
        ORDER BY a.publish_time DESC, a.id DESC
        LIMIT 1
      )
    )
    FROM feeds f
    WHERE f.id = ${sqlString(feedId)}
    LIMIT 1;
  `);
}

async function waitForPeerDiscoveryProviderSlot() {
  const now = Date.now();
  const waitMs = Math.max(0, peerDiscoveryNextProviderRequestAt - now);
  if (waitMs > 0) await waitForMilliseconds(waitMs);
  peerDiscoveryNextProviderRequestAt = Date.now() + peerWechatDiscoveryConfig.minIntervalMs;
}

async function fetchDajialaHistoryPage({ lookup, offset = "" }) {
  await waitForPeerDiscoveryProviderSlot();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), peerWechatDiscoveryConfig.requestTimeoutMs);
  try {
    const response = await fetch(peerWechatDiscoveryConfig.providerUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ghid: lookup.mode === "ghid" ? lookup.ghid : "",
        url: lookup.mode === "url" ? lookup.articleUrl : "",
        nickname: lookup.mode === "nickname" ? lookup.nickname : "",
        offset,
        key: peerWechatDiscoveryConfig.apiKey,
        verifycode: peerWechatDiscoveryConfig.verifyCode,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`大家啦接口返回 HTTP ${response.status}`);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("大家啦接口返回了非 JSON 内容");
    }
    return normalizeDajialaResponse(payload);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("大家啦接口请求超时；为避免重复扣费，本次不自动重试");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function savePeerDiscoveryBatch({ runId, accountId, pageNo, requestOffset, normalized, lookupMode = "", status = "fetched", error = "" }) {
  const safePayload = {
    requestLookupMode: lookupMode,
    code: normalized.code,
    message: normalized.message,
    errorMessage: normalized.errorMessage,
    costMoney: normalized.costMoney,
    remainMoney: normalized.remainMoney,
    offset: normalized.offset,
    isEnd: normalized.isEnd,
    nickname: normalized.nickname,
    ghid: normalized.ghid,
    articles: normalized.articles,
  };
  const responseHash = createHash("sha256").update(JSON.stringify(safePayload)).digest("hex");
  await mysqlExec(`
    INSERT INTO yimin_peer_discovery_batches (
      run_id, account_id, page_no, request_offset, response_code,
      provider_ghid, provider_nickname, next_offset, is_end,
      cost_money, remain_money, response_hash, normalized_json,
      status, article_count, error
    )
    VALUES (
      ${sqlNumber(runId)}, ${sqlNumber(accountId)}, ${sqlNumber(pageNo)}, ${sqlString(requestOffset)},
      ${sqlNumber(normalized.code, -1)}, ${sqlString(normalized.ghid)}, ${sqlString(normalized.nickname)},
      ${sqlString(normalized.offset)}, ${normalized.isEnd ? 1 : 0}, ${sqlNumber(normalized.costMoney)},
      ${normalized.remainMoney !== null && Number.isFinite(Number(normalized.remainMoney)) ? sqlNumber(normalized.remainMoney) : "NULL"},
      ${sqlString(responseHash)}, ${sqlJson(safePayload)}, ${sqlString(status)},
      ${sqlNumber(normalized.articles.length)}, ${error ? sqlString(error) : "NULL"}
    )
    ON DUPLICATE KEY UPDATE
      response_code = VALUES(response_code),
      provider_ghid = VALUES(provider_ghid),
      provider_nickname = VALUES(provider_nickname),
      next_offset = VALUES(next_offset),
      is_end = VALUES(is_end),
      cost_money = VALUES(cost_money),
      remain_money = VALUES(remain_money),
      response_hash = VALUES(response_hash),
      normalized_json = VALUES(normalized_json),
      status = VALUES(status),
      article_count = VALUES(article_count),
      error = VALUES(error),
      updated_at = CURRENT_TIMESTAMP;
  `);
}

async function loadCachedPeerDiscoveryPages(reportDate, accountId) {
  return mysqlJsonRows(`
    SELECT JSON_OBJECT(
      'pageNo', b.page_no,
      'normalized', b.normalized_json
    )
    FROM yimin_peer_discovery_batches b
    JOIN yimin_peer_discovery_runs r ON r.id = b.run_id
    WHERE r.report_date = ${sqlString(reportDate)}
      AND b.account_id = ${sqlNumber(accountId)}
      AND b.normalized_json IS NOT NULL
      AND b.status IN ('fetched','imported','failed')
    ORDER BY r.id DESC, b.page_no ASC;
  `);
}

async function importPeerArticlesToWerss(account, articles) {
  const recordsById = new Map();
  for (const article of articles) {
    const record = buildWerssArticleRecord(account.werssFeedId, article);
    if (record) recordsById.set(record.id, record);
  }
  const records = [...recordsById.values()];
  if (!records.length) return { inserted: 0, updated: 0, skipped: articles.length };

  const existingIds = (await werssMysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(id), JSON_ARRAY())
    FROM articles
    WHERE id IN (${records.map((record) => sqlString(record.id)).join(",")});
  `)) || [];
  const existingSet = new Set(existingIds.map(String));

  await werssMysqlExec(`
    START TRANSACTION;
    INSERT INTO articles (
      id, mp_id, title, pic_url, url, description, extinfo, status,
      publish_time, create_time, publish_type, publish_src, publish_status,
      art_type, show_type, publish_info, original_check_type, in_profile,
      pre_publish_status, service_type, item_show_type, copyright_stat,
      has_red_packet_cover, created_at, updated_at, updated_at_millis,
      is_export, is_read, is_favorite, fix_fail_count, has_content, content, content_html
    )
    VALUES
      ${records.map((record) => `(
        ${sqlString(record.id)}, ${sqlString(record.mpId)}, ${sqlString(record.title)},
        ${sqlString(record.picUrl)}, ${sqlString(record.url)}, ${sqlString(record.description)},
        ${sqlString(JSON.stringify({ discoverySource: "dajiala" }))}, 1,
        ${sqlNumber(record.publishTime)}, ${sqlNumber(record.createTime)}, 0, 0, 0,
        0, 0, ${sqlString(JSON.stringify(record.publishInfo))}, 0, 0,
        0, 0, ${sqlNumber(record.itemShowType)}, 0, 0,
        CURRENT_TIMESTAMP, ${sqlNumber(record.updatedAt)}, ${sqlNumber(record.updatedAtMillis)},
        0, 0, 0, 0, 0, '', ''
      )`).join(",\n")}
    ON DUPLICATE KEY UPDATE
      title = VALUES(title),
      pic_url = VALUES(pic_url),
      url = VALUES(url),
      description = VALUES(description),
      extinfo = IF(extinfo = '', VALUES(extinfo), extinfo),
      status = 1,
      publish_time = VALUES(publish_time),
      create_time = VALUES(create_time),
      publish_info = VALUES(publish_info),
      item_show_type = VALUES(item_show_type),
      updated_at = GREATEST(updated_at, VALUES(updated_at)),
      updated_at_millis = GREATEST(updated_at_millis, VALUES(updated_at_millis));
    COMMIT;
  `);
  const inserted = records.filter((record) => !existingSet.has(record.id)).length;
  return {
    inserted,
    updated: records.length - inserted,
    skipped: Math.max(0, articles.length - records.length),
  };
}

async function processPeerDiscoveryAccount({ run, account, window, dryRun, retryCached, totals }) {
  const feed = await getWerssFeedBootstrap(account.werssFeedId);
  if (!feed || Number(feed.status) !== 1) {
    throw new Error(`WeRSS feed ${account.werssFeedId} 不存在或未启用`);
  }
  let lookup = null;
  if (!retryCached) {
    lookup = resolveDajialaLookup({
      lookupMode: account.lookupMode || "auto",
      ghid: account.providerGhid,
      nickname: account.providerNickname,
      articleUrl: feed.latestArticleUrl,
    });
  }
  if (dryRun) return { pages: 0, providerArticles: 0, eligible: 0, inserted: 0, updated: 0, skipped: 0, cost: 0 };

  let pages = [];
  if (retryCached) {
    const cached = await loadCachedPeerDiscoveryPages(run.reportDate, account.id);
    const seenPageNumbers = new Set();
    pages = cached.filter((item) => {
      if (!item.normalized || Number(item.normalized.code) !== 0) return false;
      if (seenPageNumbers.has(Number(item.pageNo))) return false;
      seenPageNumbers.add(Number(item.pageNo));
      return true;
    }).map((item) => ({ pageNo: Number(item.pageNo), normalized: item.normalized }));
    if (!pages.length) throw new Error("没有可重试导入的供应商缓存；未发起新的付费请求");
    for (const page of pages) {
      await savePeerDiscoveryBatch({
        runId: run.id,
        accountId: account.id,
        pageNo: page.pageNo,
        requestOffset: "cached-retry",
        normalized: { ...page.normalized, costMoney: 0 },
        lookupMode: "cached_retry",
      });
    }
  } else {
    let offset = "";
    for (let pageNo = 1; pageNo <= peerWechatDiscoveryConfig.maxPagesPerAccount; pageNo += 1) {
      if (peerWechatDiscoveryConfig.maxCostPerRun > 0 && totals.cost >= peerWechatDiscoveryConfig.maxCostPerRun) {
        throw new Error(`已达到单次费用上限 ${peerWechatDiscoveryConfig.maxCostPerRun} 元`);
      }
      const normalized = await fetchDajialaHistoryPage({ lookup, offset });
      totals.cost += normalized.costMoney;
      if (normalized.remainMoney !== null && Number.isFinite(Number(normalized.remainMoney))) {
        totals.remainMoney = normalized.remainMoney;
      }
      await savePeerDiscoveryBatch({
        runId: run.id,
        accountId: account.id,
        pageNo,
        requestOffset: offset,
        normalized,
        lookupMode: lookup.mode,
        status: normalized.code === 0 ? "fetched" : "failed",
        error: normalized.code === 0 ? "" : (normalized.errorMessage || normalized.message || `供应商错误码 ${normalized.code}`),
      });
      if (normalized.code !== 0) {
        throw new Error(normalized.errorMessage || normalized.message || `大家啦接口错误码 ${normalized.code}`);
      }
      pages.push({ pageNo, normalized });
      if (normalized.ghid || normalized.nickname) {
        await mysqlExec(`
          UPDATE yimin_peer_wechat_accounts
          SET provider_ghid = IF(${sqlString(normalized.ghid)} = '', provider_ghid, ${sqlString(normalized.ghid)}),
              provider_nickname = IF(${sqlString(normalized.nickname)} = '', provider_nickname, ${sqlString(normalized.nickname)}),
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ${sqlNumber(account.id)};
        `);
      }
      if ((account.lookupMode || "auto") === "auto" && normalized.ghid) {
        lookup = resolveDajialaLookup({ lookupMode: "ghid", ghid: normalized.ghid });
      }
      const positiveTimes = normalized.articles.map((article) => article.publishTime).filter((value) => value > 0);
      const oldestPublishTime = positiveTimes.length ? Math.min(...positiveTimes) : 0;
      const windowStartSeconds = Math.floor(window.windowStart.getTime() / 1000);
      if (normalized.isEnd || !normalized.offset || (oldestPublishTime > 0 && oldestPublishTime < windowStartSeconds)) break;
      offset = normalized.offset;
    }
  }

  const windowStartSeconds = Math.floor(window.windowStart.getTime() / 1000);
  const windowEndSeconds = Math.floor(window.windowEnd.getTime() / 1000);
  const allArticles = pages.flatMap((page) => page.normalized.articles || []);
  const eligibleByIdentity = new Map();
  for (const article of allArticles) {
    if (article.publishTime < windowStartSeconds || article.publishTime >= windowEndSeconds) continue;
    const key = `${article.appmsgid}:${article.position}`;
    if (article.appmsgid && article.position > 0) eligibleByIdentity.set(key, article);
  }
  const eligibleArticles = [...eligibleByIdentity.values()];
  await mysqlExec(`
    UPDATE yimin_peer_discovery_batches
    SET eligible_article_count = ${sqlNumber(eligibleArticles.length)},
        updated_at = CURRENT_TIMESTAMP
    WHERE run_id = ${sqlNumber(run.id)}
      AND account_id = ${sqlNumber(account.id)};
  `);
  const imported = await importPeerArticlesToWerss(account, eligibleArticles);
  await mysqlExec(`
    UPDATE yimin_peer_discovery_batches
    SET status = 'imported',
        eligible_article_count = ${sqlNumber(eligibleArticles.length)},
        inserted_article_count = ${sqlNumber(imported.inserted)},
        updated_article_count = ${sqlNumber(imported.updated)},
        skipped_article_count = ${sqlNumber(imported.skipped)},
        error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE run_id = ${sqlNumber(run.id)}
      AND account_id = ${sqlNumber(account.id)};
    UPDATE yimin_peer_wechat_accounts
    SET last_discovered_at = CURRENT_TIMESTAMP,
        last_discovery_error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${sqlNumber(account.id)};
  `);
  return {
    pages: pages.length,
    providerArticles: allArticles.length,
    eligible: eligibleArticles.length,
    inserted: imported.inserted,
    updated: imported.updated,
    skipped: Math.max(0, allArticles.length - eligibleArticles.length) + imported.skipped,
  };
}

async function updatePeerDiscoveryRun(runId, totals, { status = "running", errors = [], finished = false } = {}) {
  await mysqlExec(`
    UPDATE yimin_peer_discovery_runs
    SET status = ${sqlString(status)},
        processed_account_count = ${sqlNumber(totals.processed)},
        success_account_count = ${sqlNumber(totals.success)},
        failed_account_count = ${sqlNumber(totals.failed)},
        page_count = ${sqlNumber(totals.pages)},
        provider_article_count = ${sqlNumber(totals.providerArticles)},
        eligible_article_count = ${sqlNumber(totals.eligible)},
        inserted_article_count = ${sqlNumber(totals.inserted)},
        updated_article_count = ${sqlNumber(totals.updated)},
        skipped_article_count = ${sqlNumber(totals.skipped)},
        total_cost = ${sqlNumber(totals.cost)},
        remain_money = ${totals.remainMoney === null ? "NULL" : sqlNumber(totals.remainMoney)},
        error = ${errors.length ? sqlString(errors.join("；")) : "NULL"},
        active_lock_key = ${finished ? "NULL" : "active_lock_key"},
        finished_at = ${finished ? "CURRENT_TIMESTAMP" : "finished_at"},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${sqlNumber(runId)};
  `);
}

async function readPeerDiscoveryBatchTotals(runId) {
  return mysqlJson(`
    SELECT JSON_OBJECT(
      'pages', COUNT(*),
      'providerArticles', COALESCE(SUM(article_count), 0),
      'eligible', COALESCE(SUM(account_eligible), 0),
      'cost', COALESCE(SUM(cost_money), 0),
      'remainMoney', (
        SELECT remain_money
        FROM yimin_peer_discovery_batches
        WHERE run_id = ${sqlNumber(runId)}
          AND remain_money IS NOT NULL
        ORDER BY id DESC
        LIMIT 1
      )
    )
    FROM (
      SELECT
        b.id,
        b.article_count,
        b.cost_money,
        IF(
          b.page_no = MIN(b.page_no) OVER (PARTITION BY b.account_id),
          MAX(b.eligible_article_count) OVER (PARTITION BY b.account_id),
          0
        ) AS account_eligible
      FROM yimin_peer_discovery_batches b
      WHERE b.run_id = ${sqlNumber(runId)}
    ) batch_totals;
  `);
}

async function getPeerWechatDiscoveryRun(runKey) {
  const run = await mysqlJson(`
    SELECT JSON_OBJECT(
      'id', id,
      'runKey', run_key,
      'reportDate', DATE_FORMAT(report_date, '%Y-%m-%d'),
      'windowStartAt', DATE_FORMAT(window_start_at, '%Y-%m-%dT%H:%i:%s+08:00'),
      'windowEndAt', DATE_FORMAT(window_end_at, '%Y-%m-%dT%H:%i:%s+08:00'),
      'competitorCode', competitor_code,
      'status', status,
      'runMode', run_mode,
      'dryRun', IF(dry_run = 1, CAST(TRUE AS JSON), CAST(FALSE AS JSON)),
      'accountCount', account_count,
      'processedAccountCount', processed_account_count,
      'successAccountCount', success_account_count,
      'failedAccountCount', failed_account_count,
      'pageCount', page_count,
      'providerArticleCount', provider_article_count,
      'eligibleArticleCount', eligible_article_count,
      'insertedArticleCount', inserted_article_count,
      'updatedArticleCount', updated_article_count,
      'skippedArticleCount', skipped_article_count,
      'totalCost', total_cost,
      'remainMoney', remain_money,
      'error', error,
      'startedAt', DATE_FORMAT(started_at, '%Y-%m-%dT%H:%i:%s+08:00'),
      'finishedAt', IF(finished_at IS NULL, NULL, DATE_FORMAT(finished_at, '%Y-%m-%dT%H:%i:%s+08:00'))
    )
    FROM yimin_peer_discovery_runs
    WHERE run_key = ${sqlString(runKey)}
    LIMIT 1;
  `);
  if (!run) return null;
  run.accounts = await mysqlJsonRows(`
    SELECT JSON_OBJECT(
      'competitorCode', c.code,
      'competitorName', c.private_name,
      'feedId', a.werss_feed_id,
      'lookupMode', a.lookup_mode,
      'status', IF(SUM(b.status = 'failed') > 0, 'failed', IF(SUM(b.status = 'imported') > 0, 'imported', 'pending')),
      'pageCount', COUNT(b.id),
      'articleCount', COALESCE(SUM(b.article_count), 0),
      'eligibleArticleCount', COALESCE(MAX(b.eligible_article_count), 0),
      'error', MAX(b.error)
    )
    FROM yimin_peer_wechat_accounts a
    JOIN yimin_peer_sources s ON s.id = a.source_id
    JOIN yimin_peer_competitors c ON c.id = s.competitor_id
    LEFT JOIN yimin_peer_discovery_batches b ON b.account_id = a.id AND b.run_id = ${sqlNumber(run.id)}
    WHERE a.id IN (
      SELECT account_id FROM yimin_peer_discovery_batches WHERE run_id = ${sqlNumber(run.id)}
    )
    GROUP BY a.id, c.code, c.private_name, a.werss_feed_id, a.lookup_mode, c.sort_order
    ORDER BY c.sort_order, a.id;
  `);
  delete run.id;
  return run;
}

async function getLatestPeerWechatDiscoveryRun() {
  const row = await mysqlJson(`
    SELECT JSON_OBJECT('runKey', run_key)
    FROM yimin_peer_discovery_runs
    ORDER BY id DESC
    LIMIT 1;
  `);
  return row?.runKey ? getPeerWechatDiscoveryRun(row.runKey) : null;
}

async function runPeerWechatDiscovery(run, accounts, options) {
  const totals = {
    processed: 0, success: 0, failed: 0, pages: 0,
    providerArticles: 0, eligible: 0, inserted: 0, updated: 0, skipped: 0,
    cost: 0, remainMoney: null,
  };
  const errors = [];
  try {
    for (const account of accounts) {
      try {
        const result = await processPeerDiscoveryAccount({
          run,
          account,
          window: options.window,
          dryRun: options.dryRun,
          retryCached: options.retryCached,
          totals,
        });
        totals.inserted += result.inserted;
        totals.updated += result.updated;
        totals.skipped += result.skipped;
        totals.success += 1;
      } catch (error) {
        const cleanError = normalizePeerText(error instanceof Error ? error.message : String(error));
        totals.failed += 1;
        errors.push(`${account.competitorName}：${cleanError}`);
        await mysqlExec(`
          UPDATE yimin_peer_wechat_accounts
          SET last_discovery_error = ${sqlString(cleanError)},
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ${sqlNumber(account.id)};
        `);
      }
      totals.processed += 1;
      const batchTotals = await readPeerDiscoveryBatchTotals(run.id);
      totals.pages = Number(batchTotals?.pages || 0);
      totals.providerArticles = Number(batchTotals?.providerArticles || 0);
      totals.eligible = Number(batchTotals?.eligible || 0);
      totals.cost = Number(batchTotals?.cost || totals.cost || 0);
      totals.remainMoney = batchTotals?.remainMoney === null || batchTotals?.remainMoney === undefined
        ? totals.remainMoney
        : Number(batchTotals.remainMoney);
      await updatePeerDiscoveryRun(run.id, totals, { errors });
    }
    const status = totals.failed === 0 ? "completed" : totals.success > 0 ? "partial" : "failed";
    await updatePeerDiscoveryRun(run.id, totals, { status, errors, finished: true });
  } catch (error) {
    errors.push(normalizePeerText(error instanceof Error ? error.message : String(error)));
    await updatePeerDiscoveryRun(run.id, totals, { status: "failed", errors, finished: true });
  }
}

async function startPeerWechatDiscovery({ reportDate, competitorCode = "", dryRun = false, refresh = false, retryCached = false }) {
  assertPeerDiscoveryConfiguration({ dryRun, retryCached });
  if (activePeerWechatDiscovery) {
    return { started: false, reused: true, run: await getPeerWechatDiscoveryRun(activePeerWechatDiscovery.runKey) };
  }
  await mysqlExec(`
    UPDATE yimin_peer_discovery_runs
    SET status = 'failed',
        active_lock_key = NULL,
        error = CONCAT_WS('；', NULLIF(error, ''), '任务运行超过 2 小时，已释放互斥锁'),
        finished_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'running'
      AND started_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 2 HOUR);
  `);
  const running = await mysqlJson(`
    SELECT JSON_OBJECT('runKey', run_key)
    FROM yimin_peer_discovery_runs
    WHERE status = 'running'
    ORDER BY id DESC
    LIMIT 1;
  `);
  if (running?.runKey) {
    return { started: false, reused: true, run: await getPeerWechatDiscoveryRun(running.runKey) };
  }
  if (!refresh && !retryCached) {
    const existing = await mysqlJson(`
      SELECT JSON_OBJECT('runKey', run_key)
      FROM yimin_peer_discovery_runs
      WHERE report_date = ${sqlString(reportDate)}
        AND competitor_code <=> ${competitorCode ? sqlString(competitorCode) : "NULL"}
        AND dry_run = ${dryRun ? 1 : 0}
      ORDER BY id DESC
      LIMIT 1;
    `);
    if (existing?.runKey) {
      return { started: false, reused: true, run: await getPeerWechatDiscoveryRun(existing.runKey) };
    }
  }

  const window = getPeerDiscoveryWindow(reportDate);
  const accounts = await syncPeerWechatDiscoveryAccounts(competitorCode);
  if (!accounts.length) throw new Error(competitorCode ? "该同行没有可用的公众号配置" : "没有可用的同行公众号配置");
  const runKey = randomBytes(16).toString("hex");
  const activeLockKey = "peer-wechat-discovery";
  await mysqlExec(`
    INSERT INTO yimin_peer_discovery_runs (
      run_key, report_date, window_start_at, window_end_at, competitor_code,
      status, run_mode, dry_run, active_lock_key, account_count
    )
    VALUES (
      ${sqlString(runKey)}, ${sqlString(reportDate)}, ${sqlDate(window.windowStart)}, ${sqlDate(window.windowEnd)},
      ${competitorCode ? sqlString(competitorCode) : "NULL"}, 'running',
      ${sqlString(dryRun ? "dry_run" : retryCached ? "retry_cached" : "discover")}, ${dryRun ? 1 : 0},
      ${sqlString(activeLockKey)}, ${sqlNumber(accounts.length)}
    );
  `);
  const runRow = await mysqlJson(`
    SELECT JSON_OBJECT('id', id, 'runKey', run_key, 'reportDate', DATE_FORMAT(report_date, '%Y-%m-%d'))
    FROM yimin_peer_discovery_runs WHERE run_key = ${sqlString(runKey)} LIMIT 1;
  `);
  activePeerWechatDiscovery = { runKey };
  void runPeerWechatDiscovery(runRow, accounts, { window, dryRun, retryCached })
    .catch((error) => console.error("Peer WeChat discovery failed:", error))
    .finally(() => {
      if (activePeerWechatDiscovery?.runKey === runKey) activePeerWechatDiscovery = null;
    });
  return { started: true, reused: false, run: await getPeerWechatDiscoveryRun(runKey) };
}

async function upsertSource(source, { enabled = true } = {}) {
  await mysqlExec(`
    INSERT INTO yimin_sources (name, url, country, category, priority, type, enabled)
    VALUES (
      ${sqlString(source.name)},
      ${sqlString(source.url)},
      ${sqlString(source.country)},
      ${sqlString(source.category || "政策")},
      ${sqlNumber(source.priority, 70)},
      ${sqlString(source.type || "rss")},
      ${enabled ? 1 : 0}
    )
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      country = VALUES(country),
      category = VALUES(category),
      priority = VALUES(priority),
      type = VALUES(type),
      enabled = VALUES(enabled),
      updated_at = CURRENT_TIMESTAMP;
  `);

  const row = await mysqlJson(`
    SELECT JSON_OBJECT('id', id)
    FROM yimin_sources
    WHERE url = ${sqlString(source.url)}
    LIMIT 1;
  `);

  return row?.id;
}

async function updateSourceFetchStatus(sourceId, error = null) {
  await mysqlExec(`
    UPDATE yimin_sources
    SET last_fetched_at = CURRENT_TIMESTAMP,
        last_fetch_error = ${sqlString(error)}
    WHERE id = ${sqlNumber(sourceId)};
  `);
}

async function isSourceDailyBaselinePending(sourceId) {
  const row = await mysqlJson(`
    SELECT JSON_OBJECT(
      'dailyBaselineAt', IF(daily_baseline_at IS NULL, NULL, DATE_FORMAT(daily_baseline_at, '%Y-%m-%dT%H:%i:%s+08:00'))
    )
    FROM yimin_sources
    WHERE id = ${sqlNumber(sourceId)}
    LIMIT 1;
  `);
  return !row?.dailyBaselineAt;
}

async function markSourceDailyBaselineCompleted(sourceId) {
  await mysqlExec(`
    UPDATE yimin_sources
    SET daily_baseline_at = COALESCE(daily_baseline_at, CURRENT_TIMESTAMP)
    WHERE id = ${sqlNumber(sourceId)};
  `);
}

async function createFetchRun(sourceCount) {
  const row = await mysqlJson(`
    INSERT INTO yimin_fetch_runs (source_count)
    VALUES (${sqlNumber(sourceCount)});
    SELECT JSON_OBJECT('id', LAST_INSERT_ID());
  `);
  return row?.id;
}

async function finishFetchRun(runId, { status, itemCount, error = null }) {
  await mysqlExec(`
    UPDATE yimin_fetch_runs
    SET status = ${sqlString(status)},
        item_count = ${sqlNumber(itemCount)},
        error = ${sqlString(error)},
        finished_at = CURRENT_TIMESTAMP
    WHERE id = ${sqlNumber(runId)};
  `);
}

async function updateFetchRunProgress(
  runId,
  { processedSourceCount, successSourceCount, failedSourceCount, itemCount },
) {
  await mysqlExec(`
    UPDATE yimin_fetch_runs
    SET processed_source_count = GREATEST(processed_source_count, ${sqlNumber(processedSourceCount)}),
        success_source_count = GREATEST(success_source_count, ${sqlNumber(successSourceCount)}),
        failed_source_count = GREATEST(failed_source_count, ${sqlNumber(failedSourceCount)}),
        item_count = GREATEST(item_count, ${sqlNumber(itemCount)})
    WHERE id = ${sqlNumber(runId)};
  `);
}

function normalizeFetchRun(run) {
  if (!run) {
    return null;
  }
  const sourceCount = Number(run.sourceCount || 0);
  const processedSourceCount = Number(run.processedSourceCount || 0);
  return {
    ...run,
    sourceCount,
    processedSourceCount,
    successSourceCount: Number(run.successSourceCount || 0),
    failedSourceCount: Number(run.failedSourceCount || 0),
    itemCount: Number(run.itemCount || 0),
    progress: sourceCount > 0 ? Math.min(100, Math.round((processedSourceCount / sourceCount) * 100)) : 100,
  };
}

async function getFetchRunById(runId) {
  const run = await mysqlJson(`
    SELECT JSON_OBJECT(
      'id', id,
      'status', status,
      'sourceCount', source_count,
      'processedSourceCount', processed_source_count,
      'successSourceCount', success_source_count,
      'failedSourceCount', failed_source_count,
      'itemCount', item_count,
      'error', error,
      'startedAt', DATE_FORMAT(started_at, '%Y-%m-%dT%H:%i:%s+08:00'),
      'finishedAt', IF(finished_at IS NULL, NULL, DATE_FORMAT(finished_at, '%Y-%m-%dT%H:%i:%s+08:00'))
    )
    FROM yimin_fetch_runs
    WHERE id = ${sqlNumber(runId)}
    LIMIT 1;
  `);
  return normalizeFetchRun(run);
}

async function getLatestFetchRun() {
  const run = await mysqlJson(`
    SELECT JSON_OBJECT(
      'id', id,
      'status', status,
      'sourceCount', source_count,
      'processedSourceCount', processed_source_count,
      'successSourceCount', success_source_count,
      'failedSourceCount', failed_source_count,
      'itemCount', item_count,
      'error', error,
      'startedAt', DATE_FORMAT(started_at, '%Y-%m-%dT%H:%i:%s+08:00'),
      'finishedAt', IF(finished_at IS NULL, NULL, DATE_FORMAT(finished_at, '%Y-%m-%dT%H:%i:%s+08:00'))
    )
    FROM yimin_fetch_runs
    ORDER BY id DESC
    LIMIT 1;
  `);
  return normalizeFetchRun(run);
}

function hasValidPublishedAt(item) {
  const date = item?.publishedAt ? new Date(item.publishedAt) : null;
  return Boolean(date && !Number.isNaN(date.getTime()));
}

async function upsertArticle(item, sourceId, { dailyExcluded = false, dailyExcludedReason = null } = {}) {
  const rawJson = JSON.stringify(item);
  const tagsJson = JSON.stringify(item.tags || []);
  const englishLabels = buildArticleEnglishLabels(item);
  const tagsEnJson = JSON.stringify(englishLabels.tagsEn);

  await mysqlExec(`
    INSERT INTO yimin_articles (
      source_id, dedupe_hash, title, summary, url, country, country_en, category, category_en,
      tags_json, tags_en_json, image, heat, impact, impact_en, published_at,
      daily_excluded, daily_excluded_reason, raw_json
    )
    VALUES (
      ${sqlNumber(sourceId)},
      ${sqlString(item.id)},
      ${sqlString(item.title)},
      ${sqlString(item.summary)},
      ${sqlString(item.url)},
      ${sqlString(item.country)},
      ${sqlString(englishLabels.countryEn)},
      ${sqlString(item.category)},
      ${sqlString(englishLabels.categoryEn)},
      CAST(${sqlString(tagsJson)} AS JSON),
      CAST(${sqlString(tagsEnJson)} AS JSON),
      ${sqlString(item.image)},
      ${sqlNumber(item.heat, 60)},
      ${sqlString(item.impact)},
      ${sqlString(englishLabels.impactEn)},
      ${sqlDate(item.publishedAt)},
      ${dailyExcluded ? 1 : 0},
      ${sqlString(dailyExcludedReason)},
      CAST(${sqlString(rawJson)} AS JSON)
    )
    ON DUPLICATE KEY UPDATE
      source_id = VALUES(source_id),
      title = VALUES(title),
      summary = VALUES(summary),
      url = VALUES(url),
      country = VALUES(country),
      country_en = VALUES(country_en),
      category = VALUES(category),
      category_en = VALUES(category_en),
      tags_json = VALUES(tags_json),
      tags_en_json = VALUES(tags_en_json),
      image = VALUES(image),
      heat = VALUES(heat),
      impact = VALUES(impact),
      impact_en = VALUES(impact_en),
      published_at = COALESCE(published_at, VALUES(published_at)),
      daily_excluded = CASE
        WHEN VALUES(published_at) IS NOT NULL THEN VALUES(daily_excluded)
        WHEN daily_excluded = 1 THEN daily_excluded
        ELSE VALUES(daily_excluded)
      END,
      daily_excluded_reason = CASE
        WHEN VALUES(published_at) IS NOT NULL THEN VALUES(daily_excluded_reason)
        WHEN daily_excluded = 1 THEN daily_excluded_reason
        ELSE VALUES(daily_excluded_reason)
      END,
      raw_json = VALUES(raw_json),
      updated_at = CURRENT_TIMESTAMP;
  `);
}

function getArticleTranslationContentHash(item) {
  return createHash("sha256")
    .update(JSON.stringify({
      title: sanitizeTextArtifacts(item.title),
      summary: sanitizeTextArtifacts(item.summary),
    }))
    .digest("hex");
}

function articleDisplayRelevanceWhere({ articleAlias = "a", analysisAlias = "ad" } = {}) {
  return `${analysisAlias}.article_hash IS NOT NULL AND ${analysisAlias}.relevant = 1`;
}

function buildArticleTranslationPrompt(items) {
  const payload = items.map((item) => ({
    id: item.id,
    title: sanitizeTextArtifacts(item.title),
    summary: truncate(item.summary, 700),
    source: sanitizeTextArtifacts(item.source),
    country: sanitizeTextArtifacts(item.country),
    category: sanitizeTextArtifacts(item.category),
  }));

  return `请把以下移民资讯的标题和简介翻译为简体中文，只返回 JSON 数组，不要 Markdown，不要解释。

每个输入 id 必须恰好返回一次，字段格式：
{"id":"原 id","titleZh":"中文标题","summaryZh":"中文简介"}

规则：
- 只翻译 title 和 summary，不添加原文没有的政策、日期、费用、名额或影响判断。
- 保留 USCIS、IRCC、EB-5、NIW、PNP、Express Entry、Home Office 等常用机构/项目名；必要时可在中文中保留英文缩写。
- titleZh 要像新闻标题，简洁自然。
- summaryZh 不超过 120 字；如果原简介为空，请基于标题翻译出一句中性简介，不扩写事实。
- 如果原文已经是中文，可润色为简体中文。

输入：
${JSON.stringify(payload)}`;
}

async function listPendingArticleTranslations(limit = articleTranslationMaxPerRun) {
  const rows = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT(
        'id', dedupe_hash,
        'title', title,
        'summary', COALESCE(summary, ''),
        'source', source_name,
        'country', country,
        'category', category
      )
    ), JSON_ARRAY())
    FROM (
      SELECT a.*, s.name AS source_name, t.status AS translation_status, t.updated_at AS translation_updated_at
      FROM yimin_articles a
      JOIN yimin_sources s ON s.id = a.source_id
      LEFT JOIN yimin_article_translations t ON t.article_hash = a.dedupe_hash
      WHERE t.article_hash IS NULL
        OR t.translation_version <> ${sqlString(articleTranslationVersion)}
        OR t.status <> 'translated'
        OR NOT (t.source_title <=> a.title)
        OR NOT (t.source_summary <=> COALESCE(a.summary, ''))
      ORDER BY
        CASE WHEN t.article_hash IS NULL THEN 0 ELSE 1 END,
        COALESCE(a.published_at, a.fetched_at) DESC,
        a.id DESC
      LIMIT ${sqlNumber(limit, articleTranslationMaxPerRun)}
    ) pending_translations;
  `)) || [];

  return rows.map((row) => ({
    ...row,
    contentHash: getArticleTranslationContentHash(row),
  }));
}

async function saveArticleTranslations(items, translationsById) {
  const values = [];
  for (const item of items) {
    const translated = translationsById.get(item.id);
    const titleZh = truncate(translated?.titleZh || "", 600);
    const summaryZh = truncate(translated?.summaryZh || "", 600);
    if (!titleZh && !summaryZh) {
      continue;
    }

    values.push(`(
      ${sqlString(item.id)},
      ${sqlString(item.contentHash || getArticleTranslationContentHash(item))},
      ${sqlString(articleTranslationVersion)},
      ${sqlString(sanitizeTextArtifacts(item.title))},
      ${sqlString(sanitizeTextArtifacts(item.summary))},
      ${sqlString(titleZh || sanitizeTextArtifacts(item.title))},
      ${sqlString(summaryZh || sanitizeTextArtifacts(item.summary))},
      'translated',
      ${sqlString(deepseekConfig.model)},
      NULL
    )`);
  }

  if (!values.length) {
    return 0;
  }

  await mysqlExec(`
    INSERT INTO yimin_article_translations (
      article_hash, content_hash, translation_version, source_title, source_summary,
      title_zh, summary_zh, status, model, last_error
    )
    VALUES ${values.join(",")}
    ON DUPLICATE KEY UPDATE
      content_hash = VALUES(content_hash),
      translation_version = VALUES(translation_version),
      source_title = VALUES(source_title),
      source_summary = VALUES(source_summary),
      title_zh = VALUES(title_zh),
      summary_zh = VALUES(summary_zh),
      status = VALUES(status),
      model = VALUES(model),
      last_error = NULL,
      translated_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP;
  `);

  return values.length;
}

async function saveArticleTranslationFailures(items, error) {
  const message = truncate(error instanceof Error ? error.message : String(error), 1000);
  const values = items.map((item) => `(
    ${sqlString(item.id)},
    ${sqlString(item.contentHash || getArticleTranslationContentHash(item))},
    ${sqlString(articleTranslationVersion)},
    ${sqlString(sanitizeTextArtifacts(item.title))},
    ${sqlString(sanitizeTextArtifacts(item.summary))},
    NULL,
    NULL,
    'failed',
    ${sqlString(deepseekConfig.model)},
    ${sqlString(message)}
  )`);
  if (!values.length) {
    return;
  }

  await mysqlExec(`
    INSERT INTO yimin_article_translations (
      article_hash, content_hash, translation_version, source_title, source_summary,
      title_zh, summary_zh, status, model, last_error
    )
    VALUES ${values.join(",")}
    ON DUPLICATE KEY UPDATE
      content_hash = VALUES(content_hash),
      translation_version = VALUES(translation_version),
      source_title = VALUES(source_title),
      source_summary = VALUES(source_summary),
      status = VALUES(status),
      model = VALUES(model),
      last_error = VALUES(last_error),
      updated_at = CURRENT_TIMESTAMP;
  `);
}

async function translateArticleBatch(items) {
  const content = await callDeepSeek(buildArticleTranslationPrompt(items));
  const parsed = parseDeepSeekJsonArray(content);
  const translationsById = new Map();
  for (const row of parsed) {
    const id = String(row?.id || "");
    if (!id) continue;
    translationsById.set(id, {
      titleZh: sanitizeTextArtifacts(row.titleZh || row.title_zh || ""),
      summaryZh: sanitizeTextArtifacts(row.summaryZh || row.summary_zh || ""),
    });
  }
  return saveArticleTranslations(items, translationsById);
}

async function translatePendingArticles({ limit = articleTranslationMaxPerRun } = {}) {
  await initDb();

  if (!deepseekConfig.apiKey) {
    return {
      ok: false,
      skipped: true,
      error: "DeepSeek API key is not configured",
      pendingCount: 0,
      translatedCount: 0,
      failedCount: 0,
    };
  }

  const pending = await listPendingArticleTranslations(limit);
  if (!pending.length) {
    return {
      ok: true,
      pendingCount: 0,
      translatedCount: 0,
      failedCount: 0,
    };
  }

  const batches = [];
  for (let index = 0; index < pending.length; index += articleTranslationBatchSize) {
    batches.push(pending.slice(index, index + articleTranslationBatchSize));
  }

  let translatedCount = 0;
  let failedCount = 0;
  await runWithConcurrency(batches, articleTranslationConcurrency, async (batch) => {
    try {
      translatedCount += await translateArticleBatch(batch);
    } catch (error) {
      failedCount += batch.length;
      await saveArticleTranslationFailures(batch, error).catch((saveError) => {
        console.error("Save article translation failures failed:", saveError);
      });
      console.error("Article translation batch failed:", error instanceof Error ? error.message : String(error));
    }
  });

  cache = null;
  return {
    ok: failedCount === 0,
    pendingCount: pending.length,
    translatedCount,
    failedCount,
  };
}

function startArticleTranslationInBackground(options = {}) {
  if (activeArticleTranslationPromise) {
    return activeArticleTranslationPromise;
  }

  activeArticleTranslationPromise = translatePendingArticles(options)
    .then((result) => {
      if (result?.skipped) {
        console.warn("Article translation skipped:", result.error);
      }
      return result;
    })
    .catch((error) => {
      console.error("Article translation failed:", error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    })
    .finally(() => {
      activeArticleTranslationPromise = null;
    });

  return activeArticleTranslationPromise;
}

async function getArticleTranslationStatus() {
  await initDb();
  const row = await mysqlJson(`
    SELECT JSON_OBJECT(
      'translatedCount', SUM(CASE WHEN t.status = 'translated' THEN 1 ELSE 0 END),
      'failedCount', SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END),
      'missingCount', SUM(CASE WHEN t.article_hash IS NULL THEN 1 ELSE 0 END),
      'staleCount', SUM(CASE
        WHEN t.article_hash IS NOT NULL
          AND (
            t.translation_version <> ${sqlString(articleTranslationVersion)}
            OR NOT (t.source_title <=> a.title)
            OR NOT (t.source_summary <=> COALESCE(a.summary, ''))
          )
        THEN 1 ELSE 0 END),
      'running', ${activeArticleTranslationPromise ? "CAST(TRUE AS JSON)" : "CAST(FALSE AS JSON)"}
    )
    FROM yimin_articles a
    LEFT JOIN yimin_article_translations t ON t.article_hash = a.dedupe_hash;
  `);

  return {
    translatedCount: Number(row?.translatedCount || 0),
    failedCount: Number(row?.failedCount || 0),
    missingCount: Number(row?.missingCount || 0),
    staleCount: Number(row?.staleCount || 0),
    running: Boolean(row?.running),
  };
}

async function listPendingArticleRelevanceAnalyses(limit = articleRelevanceMaxPerRun) {
  const scanLimit = Math.max(limit * 3, limit);
  const rows = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT(
        'id', dedupe_hash,
        'title', title,
        'summary', COALESCE(summary, ''),
        'source', source_name,
        'country', country,
        'category', category,
        'time', COALESCE(DATE_FORMAT(published_at, '%H:%i'), '刚刚'),
        'publishedAt', IF(published_at IS NULL, NULL, DATE_FORMAT(published_at, '%Y-%m-%dT%H:%i:%s+08:00')),
        'fetchedAt', IF(fetched_at IS NULL, NULL, DATE_FORMAT(fetched_at, '%Y-%m-%dT%H:%i:%s+08:00')),
        'url', url,
        'heat', heat,
        'impact', impact,
        'tags', CAST(tags_json AS JSON),
        'analysisContentHash', analysis_content_hash,
        'analysisModel', analysis_model
      )
    ), JSON_ARRAY())
    FROM (
      SELECT a.*, s.name AS source_name, ad.content_hash AS analysis_content_hash, ad.model AS analysis_model
      FROM yimin_articles a
      JOIN yimin_sources s ON s.id = a.source_id
      LEFT JOIN yimin_article_daily_analysis ad
        ON ad.article_hash = a.dedupe_hash
       AND ad.analysis_version = ${sqlString(dailyAnalysisVersion)}
      ORDER BY
        CASE
          WHEN ad.article_hash IS NULL THEN 0
          WHEN ad.model = 'rules' THEN 1
          ELSE 2
        END,
        COALESCE(a.published_at, a.fetched_at) DESC,
        a.id DESC
      LIMIT ${sqlNumber(scanLimit, Math.max(articleRelevanceMaxPerRun * 3, articleRelevanceMaxPerRun))}
    ) pending_relevance;
  `)) || [];

  return rows
    .filter((item) => item.analysisContentHash !== getDailyAnalysisContentHash(item) || item.analysisModel === "rules")
    .slice(0, limit);
}

async function analyzePendingArticleRelevance({ limit = articleRelevanceMaxPerRun } = {}) {
  await initDb();

  if (!deepseekConfig.apiKey) {
    return {
      ok: false,
      skipped: true,
      error: "DeepSeek API key is not configured",
      pendingCount: 0,
      analyzedCount: 0,
      failedCount: 0,
    };
  }

  const pending = await listPendingArticleRelevanceAnalyses(limit);
  if (!pending.length) {
    return {
      ok: true,
      pendingCount: 0,
      analyzedCount: 0,
      failedCount: 0,
    };
  }

  const batches = [];
  for (let index = 0; index < pending.length; index += dailyAnalysisBatchSize) {
    batches.push(pending.slice(index, index + dailyAnalysisBatchSize));
  }

  let analyzedCount = 0;
  let failedCount = 0;
  await runWithConcurrency(batches, dailyAnalysisConcurrency, async (batch) => {
    try {
      const analyses = await analyzeDailyArticleBatch(batch);
      await saveDailyAnalyses(analyses);
      analyzedCount += analyses.length;
    } catch (error) {
      failedCount += batch.length;
      console.error("Article relevance analysis batch failed:", error instanceof Error ? error.message : String(error));
    }
  });

  cache = null;
  return {
    ok: failedCount === 0,
    pendingCount: pending.length,
    analyzedCount,
    failedCount,
  };
}

function startArticleRelevanceInBackground(options = {}) {
  if (activeArticleRelevancePromise) {
    return activeArticleRelevancePromise;
  }

  activeArticleRelevancePromise = analyzePendingArticleRelevance(options)
    .then((result) => {
      if (result?.skipped) {
        console.warn("Article relevance analysis skipped:", result.error);
      }
      return result;
    })
    .catch((error) => {
      console.error("Article relevance analysis failed:", error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    })
    .finally(() => {
      activeArticleRelevancePromise = null;
    });

  return activeArticleRelevancePromise;
}

async function getArticleRelevanceStatus() {
  await initDb();
  const row = await mysqlJson(`
    SELECT JSON_OBJECT(
      'relevantCount', SUM(CASE WHEN ad.relevant = 1 THEN 1 ELSE 0 END),
      'irrelevantCount', SUM(CASE WHEN ad.article_hash IS NOT NULL AND ad.relevant = 0 THEN 1 ELSE 0 END),
      'missingCount', SUM(CASE WHEN ad.article_hash IS NULL THEN 1 ELSE 0 END),
      'running', ${activeArticleRelevancePromise ? "CAST(TRUE AS JSON)" : "CAST(FALSE AS JSON)"}
    )
    FROM yimin_articles a
    LEFT JOIN yimin_article_daily_analysis ad
      ON ad.article_hash = a.dedupe_hash
     AND ad.analysis_version = ${sqlString(dailyAnalysisVersion)};
  `);

  return {
    relevantCount: Number(row?.relevantCount || 0),
    irrelevantCount: Number(row?.irrelevantCount || 0),
    missingCount: Number(row?.missingCount || 0),
    running: Boolean(row?.running),
  };
}

async function listArticlesFromDb(limit = maxTotalItems) {
  return (
    (await mysqlJson(`
      SELECT COALESCE(JSON_ARRAYAGG(
        JSON_OBJECT(
          'id', dedupe_hash,
          'title', display_title,
          'summary', COALESCE(display_summary, ''),
          'originalTitle', original_title,
          'originalSummary', COALESCE(original_summary, ''),
          'translated', translated,
          'source', source_name,
          'country', country,
          'countryEn', COALESCE(country_en, ''),
          'category', category,
          'categoryEn', COALESCE(category_en, ''),
          'time', COALESCE(DATE_FORMAT(published_at, '%H:%i'), '刚刚'),
          'publishedAt', IF(published_at IS NULL, NULL, DATE_FORMAT(published_at, '%Y-%m-%dT%H:%i:%s+08:00')),
          'fetchedAt', IF(fetched_at IS NULL, NULL, DATE_FORMAT(fetched_at, '%Y-%m-%dT%H:%i:%s+08:00')),
          'url', url,
          'heat', heat,
          'impact', impact,
          'impactEn', COALESCE(impact_en, ''),
          'tags', CAST(tags_json AS JSON),
          'tagsEn', COALESCE(CAST(tags_en_json AS JSON), JSON_ARRAY()),
          'image', image
        )
      ), JSON_ARRAY())
      FROM (
        SELECT
          a.*,
          s.name AS source_name,
          a.title AS original_title,
          a.summary AS original_summary,
          COALESCE(NULLIF(t.title_zh, ''), a.title) AS display_title,
          COALESCE(NULLIF(t.summary_zh, ''), a.summary, '') AS display_summary,
          IF(t.status = 'translated' AND (NULLIF(t.title_zh, '') IS NOT NULL OR NULLIF(t.summary_zh, '') IS NOT NULL), CAST(TRUE AS JSON), CAST(FALSE AS JSON)) AS translated
        FROM yimin_articles a
        JOIN yimin_sources s ON s.id = a.source_id
        LEFT JOIN yimin_article_daily_analysis ad
          ON ad.article_hash = a.dedupe_hash
         AND ad.analysis_version = ${sqlString(dailyAnalysisVersion)}
        LEFT JOIN yimin_article_translations t
          ON t.article_hash = a.dedupe_hash
         AND t.translation_version = ${sqlString(articleTranslationVersion)}
         AND t.status = 'translated'
        WHERE ${articleDisplayRelevanceWhere()}
        ORDER BY a.heat DESC, COALESCE(a.published_at, a.fetched_at) DESC, a.id DESC
        LIMIT ${sqlNumber(limit, maxTotalItems)}
      ) ranked;
    `)) || []
  );
}

async function getTodayArticleStats() {
  try {
    const today = getShanghaiDate();
    const row = await mysqlJson(`
      SELECT JSON_OBJECT(
        'total', COUNT(*),
        'highCount', SUM(CASE WHEN heat >= 85 THEN 1 ELSE 0 END),
        'countryCount', COUNT(DISTINCT country),
        'categoryCount', COUNT(DISTINCT category)
      ) AS stats
      FROM yimin_articles
      WHERE fetched_at >= CONCAT(${sqlString(today)}, ' 07:00:00') - INTERVAL 24 HOUR
        AND fetched_at < CONCAT(${sqlString(today)}, ' 07:00:00')
    `);
    const r = row || {};
    return {
      total: Number(r.total || 0),
      highCount: Number(r.highCount || 0),
      countryCount: Number(r.countryCount || 0),
      categoryCount: Number(r.categoryCount || 0),
    };
  } catch {
    return { total: 0, highCount: 0, countryCount: 0, categoryCount: 0 };
  }
}
async function listRecentArticlesFromDb(limit = Math.max(maxTotalItems * 2, 160)) {
  return (
    (await mysqlJson(`
      SELECT COALESCE(JSON_ARRAYAGG(
        JSON_OBJECT(
          'id', dedupe_hash,
          'title', display_title,
          'summary', COALESCE(display_summary, ''),
          'originalTitle', original_title,
          'originalSummary', COALESCE(original_summary, ''),
          'translated', translated,
          'source', source_name,
          'country', country,
          'countryEn', COALESCE(country_en, ''),
          'category', category,
          'categoryEn', COALESCE(category_en, ''),
          'time', COALESCE(DATE_FORMAT(published_at, '%H:%i'), '刚刚'),
          'publishedAt', IF(published_at IS NULL, NULL, DATE_FORMAT(published_at, '%Y-%m-%dT%H:%i:%s+08:00')),
          'fetchedAt', IF(fetched_at IS NULL, NULL, DATE_FORMAT(fetched_at, '%Y-%m-%dT%H:%i:%s+08:00')),
          'url', url,
          'heat', heat,
          'impact', impact,
          'impactEn', COALESCE(impact_en, ''),
          'tags', CAST(tags_json AS JSON),
          'tagsEn', COALESCE(CAST(tags_en_json AS JSON), JSON_ARRAY()),
          'image', image
        )
      ), JSON_ARRAY())
      FROM (
        SELECT
          a.*,
          s.name AS source_name,
          a.title AS original_title,
          a.summary AS original_summary,
          COALESCE(NULLIF(t.title_zh, ''), a.title) AS display_title,
          COALESCE(NULLIF(t.summary_zh, ''), a.summary, '') AS display_summary,
          IF(t.status = 'translated' AND (NULLIF(t.title_zh, '') IS NOT NULL OR NULLIF(t.summary_zh, '') IS NOT NULL), CAST(TRUE AS JSON), CAST(FALSE AS JSON)) AS translated
        FROM yimin_articles a
        JOIN yimin_sources s ON s.id = a.source_id
        LEFT JOIN yimin_article_translations t
          ON t.article_hash = a.dedupe_hash
         AND t.translation_version = ${sqlString(articleTranslationVersion)}
         AND t.status = 'translated'
        ORDER BY COALESCE(a.published_at, a.fetched_at) DESC, a.heat DESC, a.id DESC
        LIMIT ${sqlNumber(limit, Math.max(maxTotalItems * 2, 160))}
      ) ranked;
    `)) || []
  );
}

async function listDailyCandidateArticlePageFromDb(window, offset, limit = dailyCandidatePageSize) {
  return (
    (await mysqlJson(`
      SELECT COALESCE(JSON_ARRAYAGG(
        JSON_OBJECT(
          'id', dedupe_hash,
          'sourceId', source_id,
          'title', display_title,
          'summary', COALESCE(display_summary, ''),
          'originalTitle', original_title,
          'originalSummary', COALESCE(original_summary, ''),
          'translated', translated,
          'source', source_name,
          'country', country,
          'countryEn', COALESCE(country_en, ''),
          'category', category,
          'categoryEn', COALESCE(category_en, ''),
          'time', COALESCE(DATE_FORMAT(published_at, '%H:%i'), '刚刚'),
          'publishedAt', IF(published_at IS NULL, NULL, DATE_FORMAT(published_at, '%Y-%m-%dT%H:%i:%s+08:00')),
          'fetchedAt', IF(fetched_at IS NULL, NULL, DATE_FORMAT(fetched_at, '%Y-%m-%dT%H:%i:%s+08:00')),
          'url', url,
          'heat', heat,
          'impact', impact,
          'impactEn', COALESCE(impact_en, ''),
          'tags', CAST(tags_json AS JSON),
          'tagsEn', COALESCE(CAST(tags_en_json AS JSON), JSON_ARRAY()),
          'image', image
        )
      ), JSON_ARRAY())
      FROM (
        SELECT
          a.*,
          s.name AS source_name,
          COALESCE(a.published_at, a.fetched_at) AS article_at,
          a.title AS original_title,
          a.summary AS original_summary,
          COALESCE(NULLIF(t.title_zh, ''), a.title) AS display_title,
          COALESCE(NULLIF(t.summary_zh, ''), a.summary, '') AS display_summary,
          IF(t.status = 'translated' AND (NULLIF(t.title_zh, '') IS NOT NULL OR NULLIF(t.summary_zh, '') IS NOT NULL), CAST(TRUE AS JSON), CAST(FALSE AS JSON)) AS translated
        FROM yimin_articles a
        JOIN yimin_sources s ON s.id = a.source_id
        LEFT JOIN yimin_article_translations t
          ON t.article_hash = a.dedupe_hash
         AND t.translation_version = ${sqlString(articleTranslationVersion)}
         AND t.status = 'translated'
        WHERE a.daily_excluded = 0
          AND s.enabled = 1
          AND s.public_daily_enabled = 1
          AND COALESCE(a.published_at, a.fetched_at) >= ${sqlDate(window.recentStart)}
          AND COALESCE(a.published_at, a.fetched_at) < ${sqlDate(window.end)}
        ORDER BY a.heat DESC, article_at DESC, a.id DESC
        LIMIT ${sqlNumber(limit, dailyCandidatePageSize)}
        OFFSET ${sqlNumber(offset)}
      ) ranked;
    `)) || []
  );
}

async function listDailyCandidateArticlesFromDb(window) {
  const items = [];
  for (let offset = 0; ; offset += dailyCandidatePageSize) {
    const page = await listDailyCandidateArticlePageFromDb(window, offset, dailyCandidatePageSize);
    items.push(...page);
    if (page.length < dailyCandidatePageSize) break;
  }
  return items;
}

async function listSourceStatusesFromDb() {
  return (
    (await mysqlJson(`
      SELECT COALESCE(JSON_ARRAYAGG(
        JSON_OBJECT(
          'name', name,
          'country', country,
          'ok', IF(last_fetch_error IS NULL, CAST(TRUE AS JSON), CAST(FALSE AS JSON)),
          'count', article_count,
          'error', last_fetch_error,
          'lastFetchedAt', IF(last_fetched_at IS NULL, NULL, DATE_FORMAT(last_fetched_at, '%Y-%m-%dT%H:%i:%s+08:00'))
        )
      ), JSON_ARRAY())
      FROM (
        SELECT s.*,
          (SELECT COUNT(*) FROM yimin_articles a WHERE a.source_id = s.id) AS article_count
        FROM yimin_sources s
        WHERE s.enabled = 1
        ORDER BY s.id
      ) source_rows;
    `)) || []
  );
}

async function getSourceStatsFromDb() {
  const row = await mysqlJson(`
    SELECT JSON_OBJECT(
      'totalCount', COUNT(*),
      'enabledCount', SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END),
      'publicDailyCount', SUM(CASE WHEN enabled = 1 AND public_daily_enabled = 1 THEN 1 ELSE 0 END)
    ) AS stats
    FROM yimin_sources;
  `);
  return {
    totalCount: Number(row?.totalCount || 0),
    enabledCount: Number(row?.enabledCount || 0),
    publicDailyCount: Number(row?.publicDailyCount || 0),
  };
}

async function listSourceDistributionSettings() {
  return (
    (await mysqlJson(`
      SELECT COALESCE(JSON_ARRAYAGG(
        JSON_OBJECT(
          'id', id,
          'name', name,
          'url', url,
          'country', country,
          'category', category,
          'type', type,
          'enabled', IF(enabled = 1, CAST(TRUE AS JSON), CAST(FALSE AS JSON)),
          'publicDailyEnabled', IF(public_daily_enabled = 1, CAST(TRUE AS JSON), CAST(FALSE AS JSON)),
          'publicDailyExclusionReason', COALESCE(public_daily_exclusion_reason, ''),
          'publicDailyUpdatedBy', COALESCE(public_daily_updated_by, ''),
          'publicDailyUpdatedAt', IF(
            public_daily_updated_at IS NULL,
            NULL,
            DATE_FORMAT(public_daily_updated_at, '%Y-%m-%dT%H:%i:%s+08:00')
          ),
          'departmentCount', department_count
        )
      ), JSON_ARRAY())
      FROM (
        SELECT
          s.*,
          (
            SELECT COUNT(DISTINCT ds.department_id)
            FROM yimin_department_source_subscriptions ds
            WHERE ds.source_id = s.id
          ) AS department_count
        FROM yimin_sources s
        ORDER BY s.enabled DESC, s.public_daily_enabled ASC, s.country, s.category, s.name
      ) source_distribution;
    `)) || []
  );
}

async function updateSourceDistributionSetting(sourceIdValue, data, session) {
  const sourceId = Number(sourceIdValue);
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0) {
    throw new Error("sourceId must be a positive integer");
  }
  if (typeof data.publicDailyEnabled !== "boolean") {
    throw new Error("publicDailyEnabled must be a boolean");
  }

  const reason = truncate(String(data.reason || "").trim(), 255);
  if (!data.publicDailyEnabled && !reason) {
    throw new Error("设为仅订阅部门时必须填写调整原因");
  }

  const result = await mysqlJson(`
    SELECT JSON_OBJECT(
      'id', id,
      'enabled', enabled,
      'publicDailyEnabled', public_daily_enabled
    )
    FROM yimin_sources
    WHERE id = ${sqlNumber(sourceId)}
    LIMIT 1;
  `);
  if (!result) {
    const error = new Error("信源不存在");
    error.code = "SOURCE_NOT_FOUND";
    throw error;
  }

  await mysqlExec(`
    UPDATE yimin_sources
    SET public_daily_enabled = ${data.publicDailyEnabled ? 1 : 0},
        public_daily_exclusion_reason = ${data.publicDailyEnabled ? "NULL" : sqlString(reason)},
        public_daily_updated_by = ${sqlString(session?.username || "admin")},
        public_daily_updated_at = CURRENT_TIMESTAMP
    WHERE id = ${sqlNumber(sourceId)};
  `);
  if (
    Boolean(Number(result.enabled))
    && Boolean(Number(result.publicDailyEnabled)) !== data.publicDailyEnabled
  ) {
    const currentDate = getShanghaiDate();
    await mysqlExec(`
      DELETE FROM yimin_department_daily_reports
      WHERE report_date = ${sqlString(currentDate)};
      DELETE FROM yimin_daily_reports
      WHERE report_date = ${sqlString(currentDate)};
    `);
  }
  cache = null;
  return listSourceDistributionSettings();
}

function getMarketArticleDate(item) {
  const rawDate = item.publishedAt || item.fetchedAt;
  const date = rawDate ? new Date(rawDate) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function getMarketArticleAgeHours(item) {
  const date = getMarketArticleDate(item);
  if (!date) return 168;
  const age = (Date.now() - date.getTime()) / 36e5;
  if (age < 0) return 168;
  return age;
}

function matchMarketProject(item) {
  const text = `${item.title} ${item.summary} ${item.country} ${item.category} ${(item.tags || []).join(" ")}`.toLowerCase();
  return marketProjects.find((project) =>
    item.country === project.country || project.keywords.some((keyword) => text.includes(keyword)),
  );
}

function getMarketBusinessScore(item) {
  const text = `${item.title} ${item.summary} ${(item.tags || []).join(" ")}`.toLowerCase();
  let score = 0;
  if (matchMarketProject(item)) score += 18;
  if (/eb-?5|niw|eb-?1|express entry|pnp|skilled worker|visa bulletin|priority date/.test(text)) score += 16;
  if (/fee|rule|policy|quota|cap|limit|processing|排期|费用|新规|配额|审理|工签/.test(text)) score += 14;
  return Math.min(35, score);
}

function getMarketFreshnessType(item, action) {
  if (action === "used") return "已采用";
  if (action === "useless") return "不相关";

  const age = getMarketArticleAgeHours(item);
  if (age <= 24) return "今日新增";
  if (age <= 72) return "延续关注";
  return "不建议重复";
}

function getMarketRecommendedChannels(item) {
  const text = `${item.title} ${item.summary} ${item.category}`.toLowerCase();
  const channels = new Set();
  if (/policy|rule|regulation|uscis|ircc|home office|官方|政策|新规/.test(text)) {
    channels.add("公众号");
    channels.add("销售私聊");
  }
  if (/eb-?5|investor|investment|排期|priority date|visa bulletin/.test(text)) {
    channels.add("朋友圈");
    channels.add("客户社群");
  }
  if (/student|work permit|skilled worker|工签|留学|雇主/.test(text)) {
    channels.add("小红书");
    channels.add("短视频");
  }
  if (!channels.size) {
    channels.add("朋友圈");
    channels.add("销售私聊");
  }
  return [...channels].slice(0, 3);
}

function buildMarketRecommendedTitle(item) {
  const project = matchMarketProject(item);
  const label = project?.name || item.country || "移民政策";
  const text = `${item.title} ${item.summary}`.toLowerCase();
  if (/visa bulletin|priority date|排期/.test(text)) return `${label}排期变化，哪些客户需要关注？`;
  if (/fee|费用/.test(text)) return `${label}费用或缴费要求变化，申请前要确认什么？`;
  if (/work|sponsor|permit|工签|雇主/.test(text)) return `${label}工签/雇主相关动态，适合哪些申请人？`;
  if (/eb-?5|investor|investment|投资/.test(text)) return `${label}投资移民动态，客户最关心的影响点是什么？`;
  return `${label}最新动态：市场部可以怎么解读？`;
}

function buildMarketAngle(item) {
  const text = `${item.title} ${item.summary}`.toLowerCase();
  if (/visa bulletin|priority date|排期/.test(text)) return "从客户等待周期、签约预期和递案节奏切入。";
  if (/fee|费用/.test(text)) return "从申请成本、预算准备和时间节点切入。";
  if (/policy|rule|regulation|政策|新规/.test(text)) return "从政策变化对目标客户的实际影响切入。";
  if (/work|sponsor|permit|工签|雇主/.test(text)) return "从雇主资质、岗位匹配和材料准备切入。";
  return "从客户是否需要重新评估方案切入。";
}

function buildMarketCustomerImpact(item) {
  const project = matchMarketProject(item);
  const target = project?.name || item.country || "相关移民项目";
  return `可能影响正在关注${target}的潜在客户，适合用于初步教育和咨询前置沟通。`;
}

function buildMarketSalesTalk(item) {
  const project = matchMarketProject(item);
  const label = project?.name || item.country || "相关项目";
  return `最近${label}有新动态，如果您正在评估方案，可以先看这条信息是否影响申请节奏或材料准备。`;
}

function buildMarketRiskNote(item) {
  const source = item.source || "原文";
  return `发布时建议引用${source}原文，不要扩大为所有申请人都受影响；涉及条件、费用、排期需以官方页面为准。`;
}

async function getMarketFeedbackMap() {
  const rows = await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT(
        'articleHash', article_hash,
        'action', action,
        'note', note,
        'createdBy', created_by,
        'updatedAt', DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s+08:00')
      )
    ), JSON_ARRAY())
    FROM yimin_market_feedback;
  `);

  return Object.fromEntries((rows || []).map((row) => [row.articleHash, row]));
}

function buildMarketMaterial(item, feedbackMap) {
  const feedback = feedbackMap[item.id] || null;
  const action = feedback?.action || null;
  const age = getMarketArticleAgeHours(item);
  const freshnessType = getMarketFreshnessType(item, action);
  const freshnessScore = age <= 24 ? 30 : age <= 72 ? 16 : 4;
  const authorityScore = /官方|USCIS|IRCC|Visas and Immigration|Department|Gov/i.test(item.source) ? 18 : 10;
  const businessScore = getMarketBusinessScore(item);
  const customerScore = item.heat >= 85 ? 14 : item.heat >= 70 ? 9 : 5;
  const actionPenalty = action === "used" ? 45 : action === "useless" ? 55 : action === "later" ? 6 : 0;
  const oldPenalty = age > 72 ? 18 : 0;
  const marketScore = Math.max(0, Math.min(99, freshnessScore + authorityScore + businessScore + customerScore - actionPenalty - oldPenalty));

  return {
    ...item,
    action,
    feedback,
    marketScore,
    freshnessType,
    projectName: matchMarketProject(item)?.name || item.country || "综合移民",
    recommendedTitle: buildMarketRecommendedTitle(item),
    channels: getMarketRecommendedChannels(item),
    angle: buildMarketAngle(item),
    customerImpact: buildMarketCustomerImpact(item),
    salesTalk: buildMarketSalesTalk(item),
    riskNote: buildMarketRiskNote(item),
    ageHours: age,
  };
}

function buildMarketReport(date, items, feedbackMap) {
  const materials = items.map((item) => buildMarketMaterial(item, feedbackMap)).sort((a, b) => b.marketScore - a.marketScore);
  const todayNew = materials.filter((m) => m.freshnessType === "今日新增" && m.marketScore >= 45).slice(0, 6);
  const continuing = materials
    .filter((m) => m.freshnessType === "延续关注" && m.action !== "used" && m.action !== "useless")
    .slice(0, 6);
  const notRecommended = materials
    .filter((m) => ["不建议重复", "已采用", "不相关"].includes(m.freshnessType) || m.marketScore < 35)
    .slice(0, 6);
  const usableCount = materials.filter((m) => m.marketScore >= 55 && !["used", "useless"].includes(m.action)).length;
  const noUpdateProjects = marketProjects
    .map((project) => {
      const matched = materials.filter((m) => {
        const text = `${m.title} ${m.summary} ${m.country} ${m.category} ${(m.tags || []).join(" ")}`.toLowerCase();
        return m.country === project.country || project.keywords.some((keyword) => text.includes(keyword));
      });
      const hasFresh = matched.some((m) => m.ageHours <= 24);
      const latestDate = matched
        .map((m) => getMarketArticleDate(m))
        .filter(Boolean)
        .sort((a, b) => b - a)[0];
      return {
        ...project,
        matchedCount: matched.length,
        hasFresh,
        latest: latestDate ? formatShanghaiDateTimeISO(latestDate) : null,
        suggestion: "今日不单独发新热点，可使用常青科普或等待新政策变化。",
      };
    })
    .filter((project) => !project.hasFresh)
    .slice(0, 8);

  const report = {
    date,
    title: `市场素材日报（${date}）`,
    generatedAt: formatShanghaiDateTimeISO(new Date()),
    todayNew,
    continuing,
    noUpdateProjects,
    notRecommended,
    summary: {
      total: materials.length,
      todayNew: todayNew.length,
      usable: usableCount,
      continuing: continuing.length,
      noUpdate: noUpdateProjects.length,
      notRecommended: notRecommended.length,
    },
  };

  return report;
}

function getMarketArticleSnapshot(material) {
  return {
    id: material.id,
    title: material.title,
    summary: material.summary,
    source: material.source,
    country: material.country,
    category: material.category,
    time: material.time,
    publishedAt: material.publishedAt,
    fetchedAt: material.fetchedAt,
    url: material.url,
    heat: material.heat,
    impact: material.impact,
    tags: material.tags || [],
    image: material.image || "",
    ageHours: material.ageHours,
  };
}

async function saveMarketReport(report) {
  await mysqlExec(`
    INSERT INTO yimin_market_reports (report_date, title, summary_json, generated_at)
    VALUES (
      ${sqlString(report.date)},
      ${sqlString(report.title)},
      ${sqlJson(report.summary)},
      CURRENT_TIMESTAMP
    )
    ON DUPLICATE KEY UPDATE
      title = VALUES(title),
      summary_json = VALUES(summary_json),
      generated_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP;
  `);

  const row = await mysqlJson(`
    SELECT JSON_OBJECT('id', id)
    FROM yimin_market_reports
    WHERE report_date = ${sqlString(report.date)}
    LIMIT 1;
  `);
  const reportId = row?.id;
  if (!reportId) return;

  await mysqlExec(`
    DELETE FROM yimin_market_materials WHERE report_id = ${sqlNumber(reportId)};
    DELETE FROM yimin_market_project_status WHERE report_id = ${sqlNumber(reportId)};
  `);

  const sections = [
    ["today_new", report.todayNew],
    ["continuing", report.continuing],
    ["not_recommended", report.notRecommended],
  ];

  for (const [section, materials] of sections) {
    for (const material of materials) {
      await mysqlExec(`
        INSERT INTO yimin_market_materials (
          report_id, article_hash, section, project_name, market_score, freshness_type,
          recommended_title, channels_json, angle, customer_impact, sales_talk, risk_note, article_snapshot
        )
        VALUES (
          ${sqlNumber(reportId)},
          ${sqlString(material.id)},
          ${sqlString(section)},
          ${sqlString(material.projectName)},
          ${sqlNumber(material.marketScore)},
          ${sqlString(material.freshnessType)},
          ${sqlString(material.recommendedTitle)},
          ${sqlJson(material.channels || [])},
          ${sqlString(material.angle)},
          ${sqlString(material.customerImpact)},
          ${sqlString(material.salesTalk)},
          ${sqlString(material.riskNote)},
          ${sqlJson(getMarketArticleSnapshot(material))}
        );
      `);
    }
  }

  for (const project of report.noUpdateProjects) {
    await mysqlExec(`
      INSERT INTO yimin_market_project_status (
        report_id, project_name, country, matched_count, latest_article_at, suggestion
      )
      VALUES (
        ${sqlNumber(reportId)},
        ${sqlString(project.name)},
        ${sqlString(project.country)},
        ${sqlNumber(project.matchedCount)},
        ${sqlDate(project.latest)},
        ${sqlString(project.suggestion)}
      );
    `);
  }
}

async function listSavedMarketMaterials(reportId, section) {
  return (
    (await mysqlJson(`
      SELECT COALESCE(JSON_ARRAYAGG(material_json), JSON_ARRAY())
      FROM (
        SELECT JSON_MERGE_PATCH(
          article_snapshot,
          JSON_OBJECT(
            'id', m.article_hash,
            'action', f.action,
            'feedback', IF(
              f.article_hash IS NULL,
              CAST(NULL AS JSON),
              JSON_OBJECT(
                'action', f.action,
                'note', f.note,
                'createdBy', f.created_by,
                'updatedAt', DATE_FORMAT(f.updated_at, '%Y-%m-%dT%H:%i:%s+08:00')
              )
            ),
            'marketScore', market_score,
            'freshnessType', freshness_type,
            'projectName', project_name,
            'recommendedTitle', recommended_title,
            'channels', CAST(channels_json AS JSON),
            'angle', angle,
            'customerImpact', customer_impact,
            'salesTalk', sales_talk,
            'riskNote', risk_note
          )
        ) AS material_json
        FROM yimin_market_materials m
        LEFT JOIN yimin_market_feedback f ON f.article_hash = m.article_hash
        WHERE m.report_id = ${sqlNumber(reportId)}
          AND m.section = ${sqlString(section)}
        ORDER BY m.market_score DESC, m.id ASC
      ) saved_materials;
    `)) || []
  );
}

async function listSavedMarketProjects(reportId) {
  return (
    (await mysqlJson(`
      SELECT COALESCE(JSON_ARRAYAGG(project_json), JSON_ARRAY())
      FROM (
        SELECT JSON_OBJECT(
          'name', project_name,
          'country', country,
          'matchedCount', matched_count,
          'latest', IF(latest_article_at IS NULL, NULL, DATE_FORMAT(latest_article_at, '%Y-%m-%dT%H:%i:%s+08:00')),
          'suggestion', suggestion
        ) AS project_json
        FROM yimin_market_project_status
        WHERE report_id = ${sqlNumber(reportId)}
        ORDER BY id ASC
      ) saved_projects;
    `)) || []
  );
}

async function getSavedMarketReport(date) {
  const existing = await mysqlJson(`
    SELECT JSON_OBJECT(
      'id', id,
      'date', DATE_FORMAT(report_date, '%Y-%m-%d'),
      'title', title,
      'summary', CAST(summary_json AS JSON),
      'generatedAt', DATE_FORMAT(generated_at, '%Y-%m-%dT%H:%i:%s+08:00')
    )
    FROM yimin_market_reports
    WHERE report_date = ${sqlString(date)}
    LIMIT 1;
  `);

  if (!existing) {
    return null;
  }

  const reportId = existing.id;
  return {
    date: existing.date,
    title: existing.title,
    summary: existing.summary || {},
    generatedAt: existing.generatedAt,
    todayNew: await listSavedMarketMaterials(reportId, "today_new"),
    continuing: await listSavedMarketMaterials(reportId, "continuing"),
    noUpdateProjects: await listSavedMarketProjects(reportId),
    notRecommended: await listSavedMarketMaterials(reportId, "not_recommended"),
  };
}

async function listMarketHistory() {
  await initDb();
  return (
    (await mysqlJson(`
      SELECT COALESCE(JSON_ARRAYAGG(
        JSON_OBJECT(
          'date', DATE_FORMAT(report_date, '%Y-%m-%d'),
          'title', title,
          'todayNew', CAST(JSON_UNQUOTE(JSON_EXTRACT(summary_json, '$.todayNew')) AS UNSIGNED),
          'usable', CAST(JSON_UNQUOTE(JSON_EXTRACT(summary_json, '$.usable')) AS UNSIGNED),
          'continuing', CAST(JSON_UNQUOTE(JSON_EXTRACT(summary_json, '$.continuing')) AS UNSIGNED),
          'notRecommended', CAST(JSON_UNQUOTE(JSON_EXTRACT(summary_json, '$.notRecommended')) AS UNSIGNED),
          'generatedAt', DATE_FORMAT(generated_at, '%Y-%m-%dT%H:%i:%s+08:00')
        )
      ), JSON_ARRAY())
      FROM (
        SELECT report_date, title, summary_json, generated_at
        FROM yimin_market_reports
        ORDER BY report_date DESC
        LIMIT 30
      ) recent;
    `)) || []
  );
}

async function getMarketReport(date = getShanghaiDate(), { refresh = false, rebuild = false } = {}) {
  await initDb();

  if (!refresh && !rebuild) {
    const existing = await getSavedMarketReport(date);
    if (existing) {
      return existing;
    }
  }

  if (refresh) {
    await refreshFeeds();
  }

  let items = await listRecentArticlesFromDb(Math.max(maxTotalItems * 2, 160));
  if (items.length === 0) {
    await refreshFeeds().catch(() => {});
    items = await listRecentArticlesFromDb(Math.max(maxTotalItems * 2, 160));
  }

  const feedbackMap = await getMarketFeedbackMap();
  const report = buildMarketReport(date, items, feedbackMap);
  await saveMarketReport(report);
  return (await getSavedMarketReport(date)) || report;
}

async function saveMarketFeedback(data, session = null) {
  await initDb();
  const articleHash = String(data.articleHash || data.id || "").trim();
  const action = String(data.action || "").trim();
  if (!articleHash) {
    throw new Error("articleHash is required");
  }
  if (!["useful", "later", "used", "useless"].includes(action)) {
    throw new Error("invalid feedback action");
  }

  await mysqlExec(`
    INSERT INTO yimin_market_feedback (article_hash, action, note, created_by)
    VALUES (
      ${sqlString(articleHash)},
      ${sqlString(action)},
      ${sqlString(data.note || "")},
      ${sqlString(session?.username || data.createdBy || "")}
    )
    ON DUPLICATE KEY UPDATE
      action = VALUES(action),
      note = VALUES(note),
      created_by = VALUES(created_by),
      updated_at = CURRENT_TIMESTAMP;
  `);

  return { articleHash, action };
}

// ── WeChat Work (企业微信) push integration ──────────────────────────

const wxWorkConfig = {
  corpId: process.env.WX_WORK_CORP_ID || "",
  agentId: Number(process.env.WX_WORK_AGENT_ID || 0),
  secret: process.env.WX_WORK_SECRET || "",
  pushDeptIds: (process.env.WX_WORK_PUSH_DEPT_IDS || "").split(",").filter(Boolean).map(Number),
  pushTagIds: (process.env.WX_WORK_PUSH_TAG_IDS || "").split(",").filter(Boolean).map(Number),
  excludeDeptUrl: process.env.WX_WORK_PUSH_EXCLUDE_DEPT_URL || "https://restful.globevisa.cn/Km/YiminHot/getMainland",
  openDebug: ["1", "true", "yes"].includes(String(process.env.WX_WORK_OPEN_DEBUG || "").toLowerCase()),
};
let wxContactsSyncPromise = null;

function generatePushToken() {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";
  let token = "";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  for (let i = 0; i < 12; i++) {
    token += chars[bytes[i] % chars.length];
  }
  return token;
}

async function getWxAccessToken() {
  if (!wxWorkConfig.corpId || !wxWorkConfig.secret) {
    throw new Error("WX_WORK_CORP_ID or WX_WORK_SECRET not configured");
  }

  const cached = await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT('access_token', access_token, 'expires_at', expires_at)
    ), JSON_ARRAY())
    FROM yimin_wx_token_cache
    WHERE access_token IS NOT NULL AND access_token != ''
    ORDER BY id DESC LIMIT 1
  `);
  if (cached && cached.length > 0) {
    const row = cached[0];
    const expiresAt = new Date(row.expires_at || row.expiresAt);
    if (expiresAt.getTime() > Date.now() + 300_000) {
      return row.access_token || row.accessToken;
    }
  }

  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${wxWorkConfig.corpId}&corpsecret=${wxWorkConfig.secret}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.errcode !== 0) {
    throw new Error(`WeChat Work gettoken failed: ${data.errcode} ${data.errmsg}`);
  }

  const expiresIn = Number(data.expires_in || 7200);
  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  await mysqlExec(`
    INSERT INTO yimin_wx_token_cache (access_token, expires_at)
    VALUES (${sqlString(data.access_token)}, ${sqlDate(expiresAt)})
  `);

  return data.access_token;
}

async function getWxJsapiTicket(accessToken) {
  const cached = await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT('ticket', ticket, 'expiresAt', expires_at)
    ), JSON_ARRAY())
    FROM yimin_wx_token_cache
    WHERE expires_at > NOW() AND ticket IS NOT NULL AND ticket != ''
    ORDER BY id DESC LIMIT 1
  `);
  if (cached && cached.length > 0 && cached[0].ticket) {
    return cached[0].ticket;
  }

  const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/get_jsapi_ticket?access_token=${accessToken}`);
  const data = await res.json();
  if (data.errcode !== 0) {
    throw new Error(`WeChat Work get_jsapi_ticket failed: ${data.errcode} ${data.errmsg}`);
  }

  const expiresIn = Number(data.expires_in || 7200);
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  await mysqlExec(`
    INSERT INTO yimin_wx_token_cache (access_token, expires_at, ticket)
    VALUES ('', ${sqlDate(expiresAt)}, ${sqlString(data.ticket)})
  `);

  return data.ticket;
}

async function getWxAgentTicket(accessToken) {
  const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/ticket/get?access_token=${accessToken}&type=agent_config`);
  const data = await res.json();
  if (data.errcode !== 0) {
    throw new Error(`WeChat Work get_agent_ticket failed: ${data.errcode} ${data.errmsg}`);
  }
  return data.ticket;
}

function buildWxJsConfig(jsapiTicket, url) {
  const nonceStr = Math.random().toString(36).slice(2, 15);
  const timestamp = Math.floor(Date.now() / 1000);
  const string1 = `jsapi_ticket=${jsapiTicket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`;
  const signature = createHash("sha1").update(string1).digest("hex");
  return { nonceStr, timestamp, signature };
}

async function getWxDepartmentUsers(accessToken, deptId, { fetchChild = true } = {}) {
  const url = `https://qyapi.weixin.qq.com/cgi-bin/user/simplelist?access_token=${accessToken}&department_id=${deptId}&fetch_child=${fetchChild ? 1 : 0}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.errcode !== 0) {
    throw new Error(`WeChat Work user list failed (dept ${deptId}): ${data.errcode} ${data.errmsg}`);
  }
  return (data.userlist || []).map((u) => ({
    userid: String(u.userid || ""),
    name: String(u.name || ""),
    departmentIds: (Array.isArray(u.department) ? u.department : [])
      .map(Number)
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  }));
}

async function getWxAllPushUsers(accessToken) {
  const usersById = new Map();
  const deptIds = wxWorkConfig.pushDeptIds.length > 0
    ? wxWorkConfig.pushDeptIds
    : [1];

  for (const deptId of deptIds) {
    const deptUsers = await getWxDepartmentUsers(accessToken, deptId);
    for (const u of deptUsers) {
      if (!u.userid) continue;
      const existing = usersById.get(u.userid);
      const departmentIds = [...new Set([
        ...(existing?.departmentIds || []),
        ...((u.departmentIds || []).length ? u.departmentIds : [deptId]),
      ])];
      usersById.set(u.userid, {
        userid: u.userid,
        name: u.name || existing?.name || "",
        departmentIds,
      });
    }
  }
  const users = [...usersById.values()];

  // 从接口获取排除部门，递归子部门后差集过滤
  let excludeIds = [];
  try {
    const exclRes = await fetch(wxWorkConfig.excludeDeptUrl, { signal: AbortSignal.timeout(10000) });
    const exclJson = await exclRes.json();
    if (exclJson.ret === 200 && exclJson.code === 0 && typeof exclJson.data === "string") {
      excludeIds = exclJson.data.split(",").filter(Boolean).map(Number);
    }
  } catch (e) {
    console.error("[push] 获取排除部门列表失败:", e.message);
  }

  if (excludeIds.length > 0) {
    const excludedSet = new Set();
    for (const deptId of excludeIds) {
      const deptUsers = await getWxDepartmentUsers(accessToken, deptId);
      for (const u of deptUsers) {
        if (u.userid) excludedSet.add(u.userid);
      }
    }
    return users.filter(u => !excludedSet.has(u.userid));
  }

  return users;
}

async function syncWxDepartments(accessToken) {
  const res = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/department/list?access_token=${accessToken}`,
  );
  const data = await res.json();
  if (data.errcode !== 0) {
    throw new Error(`WeChat Work department list failed: ${data.errcode} ${data.errmsg}`);
  }

  const departments = (data.department || data.department_id || [])
    .map((department) => ({
      id: Number(department.id),
      name: String(department.name || ""),
      parentId: Number(department.parentid || department.parent_id || 0) || null,
      order: Number(department.order || 0),
    }))
    .filter((department) => Number.isSafeInteger(department.id) && department.id > 0);
  if (!departments.length) return [];

  for (const batch of chunkArray(departments, 100)) {
    await mysqlExec(`
      INSERT INTO yimin_wx_departments (
        department_id, department_name, parent_id, sort_order, synced_at
      )
      VALUES ${batch.map((department) => `(
        ${sqlNumber(department.id)},
        ${sqlString(department.name.slice(0, 160))},
        ${department.parentId ? sqlNumber(department.parentId) : "NULL"},
        ${sqlNumber(department.order)},
        CURRENT_TIMESTAMP
      )`).join(",")}
      ON DUPLICATE KEY UPDATE
        department_name = VALUES(department_name),
        parent_id = VALUES(parent_id),
        sort_order = VALUES(sort_order),
        synced_at = CURRENT_TIMESTAMP;
    `);
  }
  return departments;
}

async function upsertWxUsers(users) {
  const userValues = (users || [])
    .filter((user) => user.userid)
    .map((user) => `(
      ${sqlString(String(user.userid).slice(0, 128))},
      ${sqlString(String(user.name || "").slice(0, 160))},
      ${sqlString(JSON.stringify(
        [...new Set(user.departmentIds || [])]
          .map(Number)
          .filter((value) => Number.isSafeInteger(value) && value > 0),
      ))},
      CURRENT_TIMESTAMP
    )`);
  for (const batch of chunkArray(userValues, 100)) {
    if (!batch.length) continue;
    await mysqlExec(`
      INSERT INTO yimin_wx_users (userid, user_name, departments_json, last_seen_at)
      VALUES ${batch.join(",")}
      ON DUPLICATE KEY UPDATE
        user_name = CASE
          WHEN VALUES(user_name) <> '' THEN VALUES(user_name)
          ELSE user_name
        END,
        departments_json = VALUES(departments_json),
        last_seen_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP;
    `);
  }
}

async function performWxContactsSync() {
  await initDb();
  const startedAt = new Date();
  const accessToken = await getWxAccessToken();
  const departments = await syncWxDepartments(accessToken);
  const usersById = new Map();

  for (const departmentBatch of chunkArray(departments, 5)) {
    const batchResults = await Promise.all(
      departmentBatch.map(async (department) => ({
        department,
        users: await getWxDepartmentUsers(
          accessToken,
          department.id,
          { fetchChild: false },
        ),
      })),
    );
    for (const { department, users: departmentUsers } of batchResults) {
      for (const user of departmentUsers) {
        if (!user.userid) continue;
        const existing = usersById.get(user.userid);
        usersById.set(user.userid, {
          userid: user.userid,
          name: user.name || existing?.name || "",
          departmentIds: [...new Set([
            ...(existing?.departmentIds || []),
            ...((user.departmentIds || []).length ? user.departmentIds : [department.id]),
          ])],
        });
      }
    }
  }

  const users = [...usersById.values()];
  await upsertWxUsers(users);
  return {
    departmentCount: departments.length,
    userCount: users.length,
    membershipCount: users.reduce(
      (total, user) => total + (user.departmentIds || []).length,
      0,
    ),
    startedAt: formatShanghaiDateTimeISO(startedAt),
    finishedAt: formatShanghaiDateTimeISO(new Date()),
  };
}

function syncWxContacts() {
  if (!wxContactsSyncPromise) {
    wxContactsSyncPromise = performWxContactsSync()
      .finally(() => {
        wxContactsSyncPromise = null;
      });
  }
  return wxContactsSyncPromise;
}

async function sendWxTextCard(accessToken, userIds, title, description, url, buttonText = "View") {
  const toUser = userIds.join("|");
  if (!toUser) return { errcode: 0, errmsg: "no users" };

  const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      touser: toUser,
      msgtype: "textcard",
      agentid: wxWorkConfig.agentId,
      textcard: { title, description, url, btntxt: buttonText },
    }),
  });
  return res.json();
}

function pluralizeEnglishUnit(count, singular, plural = `${singular}s`) {
  return Number(count) === 1 ? singular : plural;
}

function buildDailyPushTextCard(dailyDate, personalStats = null) {
  const title = "移民热点日报 / Immigration Daily News";
  const buttonText = "View";
  const sourceCount = Number(personalStats?.sourceCount || 0);
  const itemCount = Number(personalStats?.itemCount || 0);
  let lines = [
    dailyDate,
    "公共日报已生成 / Daily brief is ready",
    "点击查看今日动态 / Open to view updates",
  ];

  if (sourceCount > 0) {
    if (itemCount > 0) {
      lines = [
        dailyDate,
        "公共日报已生成 / Daily brief is ready",
        `你的关注：${sourceCount} 个信源 · ${itemCount} 条动态`,
        `Following: ${sourceCount} ${pluralizeEnglishUnit(sourceCount, "source")} · ${itemCount} ${pluralizeEnglishUnit(itemCount, "update")}`,
      ];
    } else {
      lines = [
        dailyDate,
        "公共日报已生成 / Daily brief is ready",
        `你的关注：${sourceCount} 个信源 · 今日暂无新增`,
        `Following: ${sourceCount} ${pluralizeEnglishUnit(sourceCount, "source")} · No new updates today`,
      ];
    }
  }

  return {
    title,
    description: lines.join("\n"),
    buttonText,
  };
}

// ── Push task logic ──────────────────────────────────────────────────

async function createPushTask(dailyDate, users) {
  const pushDate = getShanghaiDate();
  await mysqlExec(`
    INSERT INTO yimin_push_tasks (push_date, daily_date, status, total_count)
    VALUES (${sqlString(pushDate)}, ${sqlString(dailyDate)}, 'pending', ${sqlNumber(users.length)})
    ON DUPLICATE KEY UPDATE
      daily_date = VALUES(daily_date),
      status = 'pending',
      total_count = VALUES(total_count),
      sent_count = 0,
      failed_count = 0,
      visited_count = 0,
      error = NULL,
      started_at = NULL,
      finished_at = NULL
  `);

  const rows = await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('id', id)), JSON_ARRAY())
    FROM yimin_push_tasks WHERE push_date = ${sqlString(pushDate)}
  `);
  const taskId = rows && rows.length > 0 ? rows[0].id : null;
  if (!taskId) throw new Error("Failed to create push task: insert ok but select returned nothing");

  await mysqlExec(`
    DELETE FROM yimin_push_logs WHERE task_id = ${sqlNumber(taskId)}
  `);

  const values = users.map((u) =>
    `(${sqlNumber(taskId)}, ${sqlString(u.userid)}, ${sqlString(u.name)}, ${sqlString(generatePushToken())}, 'pending')`
  );

  const batchSize = 50;
  for (let i = 0; i < values.length; i += batchSize) {
    const batch = values.slice(i, i + batchSize);
    await mysqlExec(`
      INSERT INTO yimin_push_logs (task_id, userid, username, token, send_status)
      VALUES ${batch.join(",")}
    `);
  }

  return taskId;
}

async function getPushSubscriptionStats(dailyDate, userIds) {
  const cleanUserIds = [...new Set(
    (userIds || []).map((value) => String(value || "").trim()).filter(Boolean),
  )];
  if (!cleanUserIds.length) return new Map();

  const users = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT(
        'userid', userid,
        'departmentIds', COALESCE(departments_json, JSON_ARRAY())
      )
    ), JSON_ARRAY())
    FROM yimin_wx_users
    WHERE userid IN (${cleanUserIds.map(sqlString).join(",")});
  `)) || [];
  const personalRows = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT(
        'userid', us.userid,
        'sourceId', us.source_id,
        'status', us.status,
        'publicDailyEnabled', IF(s.public_daily_enabled = 1, CAST(TRUE AS JSON), CAST(FALSE AS JSON))
      )
    ), JSON_ARRAY())
    FROM yimin_user_source_subscriptions us
    JOIN yimin_sources s ON s.id = us.source_id AND s.enabled = 1
    WHERE us.userid IN (${cleanUserIds.map(sqlString).join(",")});
  `)) || [];
  const departmentIds = [...new Set(
    users.flatMap((user) => normalizeDepartmentIds(user.departmentIds)),
  )];
  const departmentRows = departmentIds.length
    ? (await mysqlJson(`
      SELECT COALESCE(JSON_ARRAYAGG(
        JSON_OBJECT('departmentId', department_id, 'sourceId', source_id)
      ), JSON_ARRAY())
      FROM yimin_department_source_subscriptions
      WHERE department_id IN (${departmentIds.map(sqlNumber).join(",")});
    `)) || []
    : [];
  const sourceItemRows = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT('sourceId', source_id, 'itemCount', item_count)
    ), JSON_ARRAY())
    FROM (
      SELECT a.source_id, COUNT(DISTINCT a.dedupe_hash) AS item_count
      FROM yimin_daily_reports r
      JOIN yimin_articles a
        ON COALESCE(a.published_at, a.fetched_at) >= DATE_SUB(
          COALESCE(r.window_end_at, DATE_ADD(r.report_date, INTERVAL 1 DAY)),
          INTERVAL ${sqlNumber(dailyRecentLookbackHours)} HOUR
        )
       AND COALESCE(a.published_at, a.fetched_at) < COALESCE(
          r.window_end_at,
          DATE_ADD(r.report_date, INTERVAL 1 DAY)
        )
       AND a.daily_excluded = 0
      JOIN yimin_sources s ON s.id = a.source_id AND s.enabled = 1
      LEFT JOIN yimin_article_daily_analysis ad
        ON ad.article_hash = a.dedupe_hash
       AND ad.analysis_version = ${sqlString(dailyAnalysisVersion)}
      WHERE r.report_date = ${sqlString(dailyDate)}
        AND COALESCE(ad.relevant, 1) = 1
      GROUP BY a.source_id
    ) source_items;
  `)) || [];

  const departmentSources = new Map();
  for (const row of departmentRows) {
    const departmentId = Number(row.departmentId);
    if (!departmentSources.has(departmentId)) departmentSources.set(departmentId, new Set());
    departmentSources.get(departmentId).add(Number(row.sourceId));
  }
  const personalByUser = new Map();
  for (const row of personalRows) {
    if (!personalByUser.has(row.userid)) personalByUser.set(row.userid, []);
    personalByUser.get(row.userid).push(row);
  }
  const itemCountBySource = new Map(
    sourceItemRows.map((row) => [Number(row.sourceId), Number(row.itemCount || 0)]),
  );

  return new Map(users.map((user) => {
    const effectiveSourceIds = new Set();
    for (const departmentId of normalizeDepartmentIds(user.departmentIds)) {
      for (const sourceId of departmentSources.get(departmentId) || []) {
        effectiveSourceIds.add(sourceId);
      }
    }
    for (const row of personalByUser.get(user.userid) || []) {
      const sourceId = Number(row.sourceId);
      if (row.status === "subscribed" && row.publicDailyEnabled) effectiveSourceIds.add(sourceId);
      if (row.status === "muted") effectiveSourceIds.delete(sourceId);
    }
    return [
      user.userid,
      {
        sourceCount: effectiveSourceIds.size,
        itemCount: [...effectiveSourceIds]
          .reduce((total, sourceId) => total + (itemCountBySource.get(sourceId) || 0), 0),
      },
    ];
  }));
}

async function executePushTask(taskId) {
  await initDb();

  await mysqlExec(`
    UPDATE yimin_push_tasks SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ${sqlNumber(taskId)}
  `);

  const task = await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT('id', id, 'dailyDate', daily_date)
    ), JSON_ARRAY())
    FROM yimin_push_tasks WHERE id = ${sqlNumber(taskId)}
  `);
  if (!task || task.length === 0) throw new Error(`Push task ${taskId} not found`);

  const dailyDate = task[0].dailyDate;
  const baseUrl = process.env.PUBLIC_BASE_URL || `http://127.0.0.1:4173`;

  const accessToken = await getWxAccessToken();

  const logs = await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT('id', id, 'userid', userid, 'username', username, 'token', token, 'sendStatus', send_status)
    ), JSON_ARRAY())
    FROM yimin_push_logs
    WHERE task_id = ${sqlNumber(taskId)} AND send_status = 'pending'
    ORDER BY id
  `);

  const allLogs = logs || [];
  const subscriptionStats = await getPushSubscriptionStats(
    dailyDate,
    allLogs.map((log) => log.userid),
  );
  let sentCount = 0;
  let failedCount = 0;
  const batchSize = 100;

  for (const logEntry of allLogs) {
    const dailyUrl = `${baseUrl}/d/${logEntry.token}`;
    const personalStats = subscriptionStats.get(logEntry.userid);
    const pushCard = buildDailyPushTextCard(dailyDate, personalStats);

    try {
      const result = await sendWxTextCard(
        accessToken,
        [logEntry.userid],
        pushCard.title,
        pushCard.description,
        dailyUrl,
        pushCard.buttonText,
      );

      if (result.errcode === 0) {
        await mysqlExec(`
          UPDATE yimin_push_logs
          SET send_status = 'sent', sent_at = CURRENT_TIMESTAMP
          WHERE id = ${sqlNumber(logEntry.id)}
        `);
        sentCount += 1;
      } else {
        await mysqlExec(`
          UPDATE yimin_push_logs
          SET send_status = 'failed', error = ${sqlString(`${result.errcode}: ${result.errmsg}`)}
          WHERE id = ${sqlNumber(logEntry.id)}
        `);
        failedCount += 1;
      }
    } catch (err) {
      await mysqlExec(`
        UPDATE yimin_push_logs
        SET send_status = 'failed', error = ${sqlString(err.message)}
        WHERE id = ${sqlNumber(logEntry.id)}
      `);
      failedCount += 1;
    }
  }

  const finalStatus = failedCount === 0 ? "completed" : sentCount > 0 ? "partial_failed" : "failed";
  await mysqlExec(`
    UPDATE yimin_push_tasks
    SET status = ${sqlString(finalStatus)},
        sent_count = ${sqlNumber(sentCount)},
        failed_count = ${sqlNumber(failedCount)},
        finished_at = CURRENT_TIMESTAMP
    WHERE id = ${sqlNumber(taskId)}
  `);

  return { taskId, sentCount, failedCount, status: finalStatus };
}

async function markPushTaskFailed(taskId, error) {
  const message = error instanceof Error ? error.message : String(error);
  await mysqlExec(`
    UPDATE yimin_push_tasks
    SET status = 'failed',
        sent_count = (
          SELECT COUNT(*) FROM yimin_push_logs
          WHERE task_id = ${sqlNumber(taskId)} AND send_status = 'sent'
        ),
        failed_count = (
          SELECT COUNT(*) FROM yimin_push_logs
          WHERE task_id = ${sqlNumber(taskId)} AND send_status = 'failed'
        ),
        error = ${sqlString(message.slice(0, 1000))},
        finished_at = CURRENT_TIMESTAMP
    WHERE id = ${sqlNumber(taskId)}
  `);
}

function startPushTaskInBackground(taskId) {
  setTimeout(() => {
    executePushTask(taskId).catch((error) => {
      console.error(`Push task ${taskId} failed:`, error);
      markPushTaskFailed(taskId, error).catch((markError) => {
        console.error(`Failed to mark push task ${taskId} as failed:`, markError);
      });
    });
  }, 0);
}

async function recordPushVisit(token, ip) {
  await initDb();

  const row = await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT('id', id, 'taskId', task_id, 'userid', userid, 'username', username, 'visitAt', visit_at)
    ), JSON_ARRAY())
    FROM yimin_push_logs WHERE token = ${sqlString(token)}
  `);

  if (!row || row.length === 0) return null;

  const log = row[0];
  if (!log.visitAt) {
    await mysqlExec(`
      UPDATE yimin_push_logs
      SET visit_at = CURRENT_TIMESTAMP, visit_ip = ${sqlString(ip || "")}
      WHERE id = ${sqlNumber(log.id)}
    `);

    await mysqlExec(`
      UPDATE yimin_push_tasks
      SET visited_count = visited_count + 1
      WHERE id = ${sqlNumber(log.task_id || log.taskId)}
    `);
  }

  await upsertWxUser({
    userId: log.userid,
    userName: log.username,
  });

  return { taskId: log.task_id || log.taskId, userid: log.userid, username: log.username };
}

async function recordPushOpenEvent({ token, eventName, eventDetail, ip, userAgent }) {
  await initDb();
  if (!wxWorkConfig.openDebug) return;
  if (!token || !/^[a-kmnp-z2-9]{12}$/i.test(token)) return;

  await mysqlExec(`
    INSERT INTO yimin_push_open_events (token, event_name, event_detail, client_ip, user_agent)
    VALUES (
      ${sqlString(String(token).slice(0, 12))},
      ${sqlString(String(eventName || "").slice(0, 80))},
      ${sqlString(String(eventDetail || "").slice(0, 1200))},
      ${sqlString(ip || "")},
      ${sqlString(String(userAgent || "").slice(0, 600))}
    );
  `);
}

async function listPushTasks(limit = 30) {
  return (
    (await mysqlJson(`
      SELECT COALESCE(JSON_ARRAYAGG(
        JSON_OBJECT(
          'id', id,
          'pushDate', DATE_FORMAT(push_date, '%Y-%m-%d'),
          'dailyDate', DATE_FORMAT(daily_date, '%Y-%m-%d'),
          'status', status,
          'totalCount', total_count,
          'sentCount', sent_count,
          'failedCount', failed_count,
          'visitedCount', visited_count,
          'error', error,
          'startedAt', DATE_FORMAT(started_at, '%Y-%m-%dT%H:%i:%s+08:00'),
          'finishedAt', DATE_FORMAT(finished_at, '%Y-%m-%dT%H:%i:%s+08:00')
        )
      ), JSON_ARRAY())
      FROM (
        SELECT * FROM yimin_push_tasks ORDER BY id DESC LIMIT ${sqlNumber(limit)}
      ) t;
    `)) || []
  );
}

async function getPushTaskLogs(taskId, { status = null, limit = 100 } = {}) {
  const where = [`task_id = ${sqlNumber(taskId)}`];
  if (status) where.push(`send_status = ${sqlString(status)}`);

  return (
    (await mysqlJson(`
      SELECT COALESCE(JSON_ARRAYAGG(
        JSON_OBJECT(
          'id', id,
          'userid', userid,
          'username', username,
          'token', token,
          'sendStatus', send_status,
          'sentAt', DATE_FORMAT(sent_at, '%Y-%m-%dT%H:%i:%s+08:00'),
          'visitAt', DATE_FORMAT(visit_at, '%Y-%m-%dT%H:%i:%s+08:00'),
          'visitIp', visit_ip,
          'error', error
        )
      ), JSON_ARRAY())
      FROM (
        SELECT * FROM yimin_push_logs
        WHERE ${where.join(" AND ")}
        ORDER BY id
        LIMIT ${sqlNumber(limit)}
      ) l;
    `)) || []
  );
}

async function retryFailedPushes(taskId) {
  await mysqlExec(`
    UPDATE yimin_push_logs SET send_status = 'pending', error = NULL
    WHERE task_id = ${sqlNumber(taskId)} AND send_status = 'failed'
  `);
}

async function recordSsoVisit({ encParam, encUserId, route, pageUrl, ip, userAgent }) {
  await initDb();
  const userName = decryptSsoUserName(encParam);
  const userId = encUserId ? decryptSsoUserId(encUserId).slice(0, 128) : "";
  const encHash = createHash("sha256").update(String(encParam || "")).digest("hex");
  const userIdEncHash = encUserId
    ? createHash("sha256").update(String(encUserId)).digest("hex")
    : null;
  const cleanRoute = String(route || "").slice(0, 120);
  const cleanPageUrl = String(pageUrl || "").slice(0, 1200);
  const cleanUa = String(userAgent || "").slice(0, 600);

  await mysqlExec(`
    INSERT INTO yimin_sso_login_logs (
      user_name, user_id, enc_hash, user_id_enc_hash, route, page_url, client_ip, user_agent
    )
    VALUES (
      ${sqlString(userName)},
      ${sqlString(userId || null)},
      ${sqlString(encHash)},
      ${sqlString(userIdEncHash)},
      ${sqlString(cleanRoute)},
      ${sqlString(cleanPageUrl)},
      ${sqlString(ip || "")},
      ${sqlString(cleanUa)}
    );
  `);

  await upsertWxUser({ userId, userName });

  return { userName, userId };
}

async function getSsoStats() {
  await initDb();

  const summary = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
      'totalVisits', total_visits,
      'uniqueUsers', unique_users,
      'todayVisits', today_visits,
      'todayUsers', today_users
    )), JSON_ARRAY())
    FROM (
      SELECT
        COUNT(*) AS total_visits,
        COUNT(DISTINCT COALESCE(NULLIF(user_id, ''), user_name)) AS unique_users,
        SUM(DATE(visit_at) = CURDATE()) AS today_visits,
        COUNT(DISTINCT CASE
          WHEN DATE(visit_at) = CURDATE() THEN COALESCE(NULLIF(user_id, ''), user_name)
        END) AS today_users
      FROM yimin_sso_login_logs
    ) s;
  `)) || [];

  const daily = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT(
        'date', DATE_FORMAT(visit_day, '%Y-%m-%d'),
        'visits', visits,
        'users', users
      )
    ), JSON_ARRAY())
    FROM (
      SELECT DATE(visit_at) AS visit_day,
             COUNT(*) AS visits,
             COUNT(DISTINCT COALESCE(NULLIF(user_id, ''), user_name)) AS users
      FROM yimin_sso_login_logs
      WHERE visit_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
      GROUP BY DATE(visit_at)
      ORDER BY visit_day
    ) d;
  `)) || [];

  const users = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT(
        'userName', user_name,
        'userId', user_id,
        'visits', visits,
        'lastVisitAt', DATE_FORMAT(last_visit_at, '%Y-%m-%d %H:%i:%s')
      )
    ), JSON_ARRAY())
    FROM (
      SELECT
        MAX(user_name) AS user_name,
        MAX(NULLIF(user_id, '')) AS user_id,
        COUNT(*) AS visits,
        MAX(visit_at) AS last_visit_at
      FROM yimin_sso_login_logs
      GROUP BY COALESCE(NULLIF(user_id, ''), user_name)
      ORDER BY visits DESC, last_visit_at DESC
      LIMIT 30
    ) u;
  `)) || [];

  const recent = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT(
        'id', id,
        'userName', user_name,
        'userId', user_id,
        'route', route,
        'pageUrl', page_url,
        'clientIp', client_ip,
        'userAgent', user_agent,
        'visitAt', DATE_FORMAT(visit_at, '%Y-%m-%d %H:%i:%s')
      )
    ), JSON_ARRAY())
    FROM (
      SELECT *
      FROM yimin_sso_login_logs
      ORDER BY visit_at DESC, id DESC
      LIMIT 100
    ) r;
  `)) || [];

  return {
    summary: summary[0] || { totalVisits: 0, uniqueUsers: 0, todayVisits: 0, todayUsers: 0 },
    daily,
    users,
    recent,
    push: await getDailyPushStats(),
  };
}

async function getDailyPushStats() {
  const summary = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
      'taskCount', task_count,
      'totalTargets', total_targets,
      'sentCount', sent_count,
      'failedCount', failed_count,
      'visitedCount', visited_count,
      'todayVisits', today_visits,
      'uniqueVisitors', unique_visitors
    )), JSON_ARRAY())
    FROM (
      SELECT
        (SELECT COUNT(*) FROM yimin_push_tasks) AS task_count,
        (SELECT COALESCE(SUM(total_count), 0) FROM yimin_push_tasks) AS total_targets,
        (SELECT COALESCE(SUM(sent_count), 0) FROM yimin_push_tasks) AS sent_count,
        (SELECT COALESCE(SUM(failed_count), 0) FROM yimin_push_tasks) AS failed_count,
        (SELECT COUNT(*) FROM yimin_push_logs WHERE visit_at IS NOT NULL) AS visited_count,
        (SELECT COUNT(*) FROM yimin_push_logs WHERE DATE(visit_at) = CURDATE()) AS today_visits,
        (SELECT COUNT(DISTINCT userid) FROM yimin_push_logs WHERE visit_at IS NOT NULL) AS unique_visitors
    ) s;
  `)) || [];

  const daily = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT(
        'date', DATE_FORMAT(visit_day, '%Y-%m-%d'),
        'visits', visits,
        'users', users
      )
    ), JSON_ARRAY())
    FROM (
      SELECT DATE(visit_at) AS visit_day,
             COUNT(*) AS visits,
             COUNT(DISTINCT userid) AS users
      FROM yimin_push_logs
      WHERE visit_at IS NOT NULL
        AND visit_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
      GROUP BY DATE(visit_at)
      ORDER BY visit_day
    ) d;
  `)) || [];

  const tasks = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT(
        'id', id,
        'pushDate', DATE_FORMAT(push_date, '%Y-%m-%d'),
        'dailyDate', DATE_FORMAT(daily_date, '%Y-%m-%d'),
        'status', status,
        'totalCount', total_count,
        'sentCount', sent_count,
        'failedCount', failed_count,
        'visitedCount', visited_count
      )
    ), JSON_ARRAY())
    FROM (
      SELECT *
      FROM yimin_push_tasks
      ORDER BY id DESC
      LIMIT 30
    ) t;
  `)) || [];

  const recent = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT(
        'id', id,
        'pushDate', DATE_FORMAT(push_date, '%Y-%m-%d'),
        'dailyDate', DATE_FORMAT(daily_date, '%Y-%m-%d'),
        'userid', userid,
        'username', username,
        'visitAt', DATE_FORMAT(visit_at, '%Y-%m-%d %H:%i:%s'),
        'visitIp', visit_ip
      )
    ), JSON_ARRAY())
    FROM (
      SELECT l.id, t.push_date, t.daily_date, l.userid, l.username, l.visit_at, l.visit_ip
      FROM yimin_push_logs l
      JOIN yimin_push_tasks t ON t.id = l.task_id
      WHERE l.visit_at IS NOT NULL
      ORDER BY l.visit_at DESC, l.id DESC
      LIMIT 100
    ) r;
  `)) || [];

  const recentEvents = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT(
        'id', id,
        'token', token,
        'eventName', event_name,
        'eventDetail', event_detail,
        'clientIp', client_ip,
        'userAgent', user_agent,
        'createdAt', DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s')
      )
    ), JSON_ARRAY())
    FROM (
      SELECT *
      FROM yimin_push_open_events
      ORDER BY created_at DESC, id DESC
      LIMIT 120
    ) e;
  `)) || [];

  return {
    summary: summary[0] || {
      taskCount: 0,
      totalTargets: 0,
      sentCount: 0,
      failedCount: 0,
      visitedCount: 0,
      todayVisits: 0,
      uniqueVisitors: 0,
    },
    daily,
    tasks,
    recent,
    recentEvents,
  };
}

async function saveSourceSubmission(data) {
  await initDb();
  await mysqlExec(`
    INSERT INTO yimin_source_submissions (name, url, topic)
    VALUES (
      ${sqlString(data.name)},
      ${sqlString(data.url)},
      ${sqlString(data.topic || "")}
    );
  `);

  await upsertSource(
    {
      name: data.name,
      url: data.url,
      country: data.topic || "待分类",
      category: "用户提报",
      priority: 50,
      type: data.type || "rss",
    },
    { enabled: false },
  );
}

function normalizeFeedbackStatus(value) {
  return ["new", "reviewed", "resolved", "archived"].includes(value) ? value : "new";
}

async function saveFeedback(data, { session = null, req = null } = {}) {
  await initDb();
  const cookies = req ? parseCookies(req) : {};
  let cookieName = "";
  try {
    cookieName = decodeURIComponent(cookies.feedback_name || "");
  } catch {
    cookieName = cookies.feedback_name || "";
  }
  const createdBy = String(session?.username || cookieName || data.createdBy || data.created_by || "").trim();
  const userAgent = String(req?.headers?.["user-agent"] || data.userAgent || "").slice(0, 600);

  await mysqlExec(`
    INSERT INTO yimin_feedback (
      type, module, priority, message, contact, created_by, page_url, user_agent
    )
    VALUES (
      ${sqlString(data.type || "页面反馈")},
      ${sqlString(data.module || "")},
      ${sqlString(data.priority || "normal")},
      ${sqlString(data.message || "")},
      ${sqlString(data.contact || "")},
      ${sqlString(createdBy)},
      ${sqlString(data.pageUrl || data.page_url || "")},
      ${sqlString(userAgent)}
    );
  `);
}

async function listFeedback({ limit = 200, status = "" } = {}) {
  await initDb();
  const where = status ? `WHERE status = ${sqlString(normalizeFeedbackStatus(status))}` : "";
  return (
    (await mysqlJson(`
      SELECT COALESCE(JSON_ARRAYAGG(
        JSON_OBJECT(
          'id', id,
          'type', type,
          'module', module,
          'priority', priority,
          'message', message,
          'contact', contact,
          'createdBy', created_by,
          'status', status,
          'adminNote', admin_note,
          'pageUrl', page_url,
          'userAgent', user_agent,
          'createdAt', DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s'),
          'updatedAt', DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s')
        )
      ), JSON_ARRAY())
      FROM (
        SELECT *
        FROM yimin_feedback
        ${where}
        ORDER BY FIELD(status, 'new', 'reviewed', 'resolved', 'archived'), created_at DESC, id DESC
        LIMIT ${sqlNumber(limit, 200)}
      ) f;
    `)) || []
  );
}

async function updateFeedback(id, data) {
  await initDb();
  const feedbackId = Number(id);
  if (!feedbackId) throw new Error("Invalid feedback id");
  const status = normalizeFeedbackStatus(data.status || "reviewed");

  await mysqlExec(`
    UPDATE yimin_feedback
    SET status = ${sqlString(status)},
        admin_note = ${sqlString(data.adminNote || data.admin_note || "")}
    WHERE id = ${sqlNumber(feedbackId)};
  `);
}

async function readSources() {
  const sourcePath = join(rootDir, "data", "sources.json");
  const raw = await readFile(sourcePath, "utf8");
  return JSON.parse(raw);
}

async function listEnabledSourcesForFetch() {
  const fileSources = (await readSources()).filter((source) => source.enabled !== false);
  const fileSourceByUrl = new Map(fileSources.map((source) => [source.url, source]));
  const dbSources =
    (await mysqlJson(`
      SELECT COALESCE(JSON_ARRAYAGG(
        JSON_OBJECT(
          'id', id,
          'name', name,
          'url', url,
          'country', country,
          'category', category,
          'priority', priority,
          'type', type,
          'enabled', enabled
        )
      ), JSON_ARRAY())
      FROM (
        SELECT *
        FROM yimin_sources
        WHERE enabled = 1
        ORDER BY priority DESC, id ASC
      ) enabled_sources;
    `)) || [];

  return dbSources.map((source) => ({
    ...(fileSourceByUrl.get(source.url) || {}),
    ...source,
    enabled: Boolean(source.enabled),
  }));
}

async function fetchWithTimeout(
  url,
  extraHeaders = {},
  timeoutMs = requestTimeoutMs,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        ...extraHeaders,
      },
    });

    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      text,
    };
  } finally {
    clearTimeout(timer);
  }
}

function waitForMilliseconds(delayMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, Math.max(0, delayMs)));
}

async function waitForFirecrawlQueueSlot() {
  const previousQueueTail = firecrawlQueueTail;
  let releaseQueueSlot;
  firecrawlQueueTail = new Promise((resolvePromise) => {
    releaseQueueSlot = resolvePromise;
  });

  await previousQueueTail;
  try {
    while (firecrawlNextRequestAt > Date.now()) {
      await waitForMilliseconds(firecrawlNextRequestAt - Date.now());
    }

    const requestIntervalMs = Math.ceil(60000 / firecrawlConfig.requestsPerMinute);
    firecrawlNextRequestAt = Date.now() + requestIntervalMs;
  } finally {
    releaseQueueSlot();
  }
}

function pauseFirecrawlQueue(delayMs) {
  firecrawlNextRequestAt = Math.max(
    firecrawlNextRequestAt,
    Date.now() + Math.max(0, delayMs),
  );
}

function isFirecrawlRateLimitError(status, error, data) {
  const details = `${error}\n${JSON.stringify(data)}`;
  return status === 429 || /rate[\s_-]+limit|too many requests/i.test(details);
}

function parseFirecrawlRetryAfterMs(response, error, data) {
  const now = Date.now();
  const retryAfterHeader = response.headers.get("retry-after");
  if (retryAfterHeader) {
    const retryAfterSeconds = Number(retryAfterHeader);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
      return Math.ceil(retryAfterSeconds * 1000);
    }

    const retryAfterDate = Date.parse(retryAfterHeader);
    if (Number.isFinite(retryAfterDate)) {
      return Math.max(0, retryAfterDate - now);
    }
  }

  const details = `${error}\n${JSON.stringify(data)}`;
  const retryAfterMatch = details.match(/retry after\s+(\d+(?:\.\d+)?)\s*s/i);
  if (retryAfterMatch) {
    return Math.ceil(Number(retryAfterMatch[1]) * 1000);
  }

  const resetAtMatch = details.match(/resets?\s+at\s+(.+?)(?:\s+\(|\n|$)/i);
  if (resetAtMatch) {
    const resetAt = Date.parse(resetAtMatch[1].trim());
    if (Number.isFinite(resetAt)) {
      return Math.max(0, resetAt - now);
    }
  }

  return 60000;
}

function getFirecrawlRateLimitWaitMs(response, error, data) {
  const requestIntervalMs = Math.ceil(60000 / firecrawlConfig.requestsPerMinute);
  const retryAfterMs = Math.max(
    requestIntervalMs,
    parseFirecrawlRetryAfterMs(response, error, data),
  );
  const jitterMs = firecrawlConfig.retryJitterMs > 0
    ? Math.floor(Math.random() * (firecrawlConfig.retryJitterMs + 1))
    : 0;
  return retryAfterMs + jitterMs;
}

async function fetchWithFirecrawl(url) {
  if (firecrawlConfig.apiKeys.length === 0) {
    return {
      ok: false,
      status: 0,
      error: "FIRECRAWL_API_KEY or FIRECRAWL_API_KEYS not configured",
    };
  }

  const attemptedKeyIndexes = new Set();
  let lastKeyError = null;

  while (attemptedKeyIndexes.size < firecrawlConfig.apiKeys.length) {
    const keyIndex = findNextFirecrawlKeyIndex(attemptedKeyIndexes);
    const apiKey = firecrawlConfig.apiKeys[keyIndex];
    attemptedKeyIndexes.add(keyIndex);
    let rateLimitRetryCount = 0;
    let shouldRotateKey = false;

    while (true) {
      await waitForFirecrawlQueueSlot();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);

      try {
        const response = await fetch(`${firecrawlConfig.baseUrl}/scrape`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ url, formats: ["markdown"] }),
        });

        const responseText = await response.text();
        let data = {};
        try {
          data = JSON.parse(responseText);
        } catch {
          data = {};
        }

        if (!response.ok || !data.success) {
          const error = getFirecrawlError(data, response.status);
          if (isFirecrawlRateLimitError(response.status, error, data)) {
            if (rateLimitRetryCount >= firecrawlConfig.maxRateLimitRetries) {
              return {
                ok: false,
                status: response.status,
                error: `${error} (rate limit retry limit reached after ${rateLimitRetryCount} retries)`,
              };
            }

            rateLimitRetryCount += 1;
            const waitMs = getFirecrawlRateLimitWaitMs(response, error, data);
            pauseFirecrawlQueue(waitMs);
            console.warn(
              `[firecrawl] Rate limited; queued retry ${rateLimitRetryCount}/${firecrawlConfig.maxRateLimitRetries} in ${Math.ceil(waitMs / 1000)}s.`,
            );
            continue;
          }

          const rotationReason = getFirecrawlKeyRotationReason(error, data, response.status);
          if (rotationReason) {
            lastKeyError = { status: response.status, error };
            advanceFirecrawlApiKey(keyIndex);

            if (attemptedKeyIndexes.size < firecrawlConfig.apiKeys.length) {
              console.warn(
                `[firecrawl] API key ${keyIndex + 1}/${firecrawlConfig.apiKeys.length} ${rotationReason}; retrying with another key.`,
              );
              shouldRotateKey = true;
              break;
            }

            break;
          }

          return { ok: false, status: response.status, error };
        }

        const page = data.data || {};
        const metadata = page.metadata || {};
        const markdown = page.markdown || "";

        return {
          ok: true,
          title: metadata.title || "",
          summary: markdown.slice(0, 500),
          content: markdown,
          url: metadata.sourceURL || url,
          publishedAt: metadata.publishedTime || null,
        };
      } catch (err) {
        return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
      } finally {
        clearTimeout(timer);
      }
    }

    if (shouldRotateKey) {
      continue;
    }
  }

  return {
    ok: false,
    status: lastKeyError?.status || 0,
    error: `${lastKeyError?.error || "No usable Firecrawl API key"} (all ${firecrawlConfig.apiKeys.length} configured keys were tried)`,
  };
}

function findNextFirecrawlKeyIndex(attemptedKeyIndexes) {
  for (let offset = 0; offset < firecrawlConfig.apiKeys.length; offset += 1) {
    const index = (firecrawlApiKeyIndex + offset) % firecrawlConfig.apiKeys.length;
    if (!attemptedKeyIndexes.has(index)) {
      return index;
    }
  }

  return firecrawlApiKeyIndex;
}

function advanceFirecrawlApiKey(failedKeyIndex) {
  if (firecrawlApiKeyIndex === failedKeyIndex) {
    firecrawlApiKeyIndex = (failedKeyIndex + 1) % firecrawlConfig.apiKeys.length;
  }
}

function getFirecrawlError(data, status) {
  if (typeof data?.error === "string" && data.error.trim()) {
    return data.error.trim();
  }
  if (typeof data?.error?.message === "string" && data.error.message.trim()) {
    return data.error.message.trim();
  }
  if (typeof data?.message === "string" && data.message.trim()) {
    return data.message.trim();
  }
  return `HTTP ${status}`;
}

function isFirecrawlCreditError(error, data) {
  const details = `${error}\n${JSON.stringify(data)}`;
  return /insufficient[\s_-]+credits?/i.test(details);
}

function getFirecrawlKeyRotationReason(error, data, status) {
  if (isFirecrawlCreditError(error, data)) {
    return "has insufficient credits";
  }

  const details = `${error}\n${JSON.stringify(data)}`;
  if (
    status === 401
    || /unauthorized\s*:\s*invalid[\s_-]+token/i.test(details)
    || /invalid[\s_-]+(?:api[\s_-]+)?(?:key|token)/i.test(details)
  ) {
    return "was rejected as invalid";
  }

  return "";
}

async function fetchWithJina(url) {
  const jinaUrl = `https://r.jina.ai/${url}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(jinaUrl, {
      signal: controller.signal,
      headers: { Accept: "text/plain" },
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      text,
      title: response.headers.get("x-title") || "",
    };
  } catch (err) {
    return { ok: false, status: 0, text: "", title: "", error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function parseJinaMarkdown(markdown, source, pageTitle) {
  if (!markdown) return [];
  const lines = markdown.split("\n");
  const articles = [];
  let currentTitle = "";
  let currentUrl = "";
  let currentSummary = "";
  const urlRe = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    const linkMatch = line.match(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/);

    if (headingMatch) {
      if (currentTitle && (currentUrl || currentSummary)) {
        articles.push({ title: currentTitle, url: currentUrl, summary: currentSummary.trim() });
      }
      currentTitle = headingMatch[1].replace(/[*_`]/g, "").trim();
      currentUrl = "";
      currentSummary = "";
    } else if (linkMatch && !currentUrl) {
      currentUrl = linkMatch[2];
      if (!currentTitle) currentTitle = linkMatch[1] || pageTitle || source.name;
    } else if (line.trim() && !line.startsWith("!") && !line.startsWith("[")) {
      if (currentTitle) {
        currentSummary += (currentSummary ? " " : "") + line.replace(/[*_`#\[\]()]/g, "").trim();
      }
    }
  }
  if (currentTitle && (currentUrl || currentSummary)) {
    articles.push({ title: currentTitle, url: currentUrl, summary: currentSummary.trim() });
  }

  return articles.slice(0, maxItemsPerSource).map((a) => {
    const publishedAt = null;
    const category = inferCategory(`${a.title} ${a.summary}`, source.category);
    const item = {
      id: createHash("sha1").update(`${a.url || ""}|${a.title}`).digest("hex").slice(0, 12),
      title: cleanText(a.title),
      summary: truncate(a.summary || "查看原文获取完整信息。", 150),
      source: source.name,
      country: source.country,
      category,
      time: "刚刚",
      publishedAt,
      url: a.url ? resolveRelativeUrl(a.url, source.url) : source.url,
    };
    const heat = calculateHeat(item, source);
    return {
      ...item,
      heat,
      impact: heat >= 85 ? "高影响" : heat >= 70 ? "中影响" : "低影响",
      tags: inferTags({ ...item, category }, source),
      image: imageFor({ ...item, category }, source),
    };
  });
}

const nitterInstances = [
  "nitter.net",
  "nitter.privacydev.net",
  "nitter.poast.org",
  "nitter.cz",
];

function twitterToNitterRss(twitterUrl) {
  const match = twitterUrl.match(/(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]+)/);
  if (!match) {
    return null;
  }

  const username = match[1].toLowerCase();
  const instance = nitterInstances[Math.floor(Math.random() * nitterInstances.length)];
  return `https://${instance}/${username}/rss`;
}

function resolveRelativeUrl(href, baseUrl) {
  if (!href) return "";
  if (/^https?:\/\//i.test(href)) return href;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

function resolveJsonPath(obj, path) {
  if (!path || !obj) return obj;
  const keys = path.split(".");
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function getBlocks(xml) {
  const rssItems = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => match[0]);
  if (rssItems.length) {
    return rssItems;
  }

  return [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((match) => match[0]);
}

function getTag(block, tagName) {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  return block.match(pattern)?.[1] || "";
}

function getAtomLink(block) {
  const alternate = block.match(/<link\b(?=[^>]*rel=["']alternate["'])([^>]*)>/i)?.[1];
  const firstLink = block.match(/<link\b([^>]*)>/i)?.[1];
  const attrs = alternate || firstLink || "";
  return attrs.match(/\bhref=["']([^"']+)["']/i)?.[1] || "";
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function sanitizeTextArtifacts(value) {
  return String(value || "")
    .replace(/雇主担(?:�|&(?:amp;)?#65533;|\\ufffd)+/gi, "雇主担保")
    .replace(/担(?:�|&(?:amp;)?#65533;|\\ufffd)+/gi, "担保")
    .replace(/置业(?:�|&(?:amp;)?#65533;|\\ufffd)+民/gi, "置业移民")
    .replace(/(?:�|&(?:amp;)?#65533;|\\ufffd)+/gi, "")
    .trim();
}

function hasReplacementTextArtifacts(value) {
  return /(?:�|&(?:amp;)?#65533;|\\ufffd)/i.test(String(value || ""));
}

function sanitizeStructuredTextArtifacts(value) {
  if (typeof value === "string") return sanitizeTextArtifacts(value);
  if (Array.isArray(value)) return value.map(sanitizeStructuredTextArtifacts);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeStructuredTextArtifacts(item)]),
    );
  }
  return value;
}

function cleanText(value) {
  return sanitizeTextArtifacts(decodeEntities(
    String(value || "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ));
}

function normalizePeerText(value) {
  return sanitizeTextArtifacts(String(value || "")
    .replace(/\s+/g, " ")
    .trim());
}

function normalizePeerArticleUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.pathname = url.pathname.replace(/\/{2,}/g, "/");
    return url.toString();
  } catch {
    return "";
  }
}

function normalizePeerArticleIdentityUrl(value) {
  const normalized = normalizePeerArticleUrl(value);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
    for (const key of [...url.searchParams.keys()]) {
      if (
        /^utm_/i.test(key)
        || ["from", "scene", "share", "clicktime", "enterid", "sessionid"].includes(key.toLowerCase())
      ) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function getPeerArticleIdentityKeys(article) {
  const keys = [];
  const privateUrl = normalizePeerArticleIdentityUrl(
    article?.privateUrl || article?.private_url || article?.url,
  );
  const externalId = normalizePeerText(article?.externalId || article?.external_id).toLowerCase();
  const title = normalizePeerText(article?.title).toLowerCase();
  const rawPublishedAt = article?.publishedAt || article?.published_at || "";
  const publishedDate = rawPublishedAt ? new Date(rawPublishedAt) : null;
  const publishedMinute = publishedDate && !Number.isNaN(publishedDate.getTime())
    ? publishedDate.toISOString().slice(0, 16)
    : "";

  if (privateUrl) keys.push(`url:${privateUrl}`);
  if (externalId) keys.push(`external:${externalId}`);
  if (title && publishedMinute) keys.push(`title-date:${title}\n${publishedMinute}`);
  return keys;
}

function mergePeerFeedItems(existing, incoming) {
  const preferIncomingContent =
    String(incoming.contentText || "").length > String(existing.contentText || "").length;
  return {
    ...existing,
    externalId: existing.externalId || incoming.externalId,
    title: existing.title || incoming.title,
    summary: String(incoming.summary || "").length > String(existing.summary || "").length
      ? incoming.summary
      : existing.summary,
    contentText: preferIncomingContent ? incoming.contentText : existing.contentText,
    privateUrl: existing.privateUrl || incoming.privateUrl,
    privateImageUrl: existing.privateImageUrl || incoming.privateImageUrl,
    publishedAt: existing.publishedAt || incoming.publishedAt,
  };
}

function dedupePeerFeedItems(items) {
  const deduped = [];
  const itemIndexByIdentity = new Map();

  for (const item of items) {
    const identityKeys = getPeerArticleIdentityKeys(item);
    const existingIndex = identityKeys
      .map((key) => itemIndexByIdentity.get(key))
      .find((index) => index !== undefined);
    if (existingIndex !== undefined) {
      const merged = mergePeerFeedItems(deduped[existingIndex], item);
      deduped[existingIndex] = merged;
      for (const key of getPeerArticleIdentityKeys(merged)) {
        itemIndexByIdentity.set(key, existingIndex);
      }
      continue;
    }

    const nextIndex = deduped.length;
    deduped.push(item);
    for (const key of identityKeys) {
      itemIndexByIdentity.set(key, nextIndex);
    }
  }

  return deduped;
}

function getXmlAttribute(block, tagName, attributeName) {
  const tag = block.match(new RegExp(`<${tagName}\\b([^>]*)>`, "i"))?.[1] || "";
  return decodeEntities(
    tag.match(new RegExp(`\\b${attributeName}=["']([^"']+)["']`, "i"))?.[1] || "",
  );
}

function parsePeerFeed(xml, sourceId) {
  const items = getBlocks(xml)
    .map((block) => {
      const externalId =
        cleanText(getTag(block, "id"))
        || cleanText(getTag(block, "guid"));
      const title = normalizePeerText(cleanText(cleanText(getTag(block, "title"))));
      const description = normalizePeerText(cleanText(cleanText(getTag(block, "description"))));
      const rssLink = cleanText(getTag(block, "link"));
      const privateUrl = normalizePeerArticleUrl(
        rssLink
        || cleanText(getTag(block, "guid"))
        || decodeEntities(getAtomLink(block)),
      );
      const rawContent =
        getTag(block, "content:encoded")
        || getTag(block, "content")
        || getTag(block, "summary");
      const contentText = normalizePeerText(cleanText(cleanText(rawContent)));
      const publishedAt =
        normalizeDate(getTag(block, "pubDate"))
        || normalizeDate(getTag(block, "published"))
        || normalizeDate(getTag(block, "updated"))
        || null;
      const privateImageUrl = getXmlAttribute(block, "enclosure", "url");
      const identityKeys = getPeerArticleIdentityKeys({
        externalId,
        privateUrl,
        title,
        publishedAt,
      });
      const stableValue = identityKeys[0] || `${title}\n${publishedAt || ""}`;
      const dedupeHash = createHash("sha256")
        .update(`${sourceId}\n${stableValue}`)
        .digest("hex");

      return {
        externalId: externalId.slice(0, 255),
        dedupeHash,
        title: title.slice(0, 800),
        summary: truncate(description || contentText, 500),
        contentText,
        privateUrl,
        privateImageUrl,
        publishedAt,
      };
    })
    .filter((item) => item.title);
  return dedupePeerFeedItems(items);
}

function truncate(value, maxLength = 150) {
  const text = sanitizeTextArtifacts(value);
  if (!text) {
    return "";
  }

  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function normalizeDate(value) {
  const date = value ? new Date(cleanText(value)) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function inferCategory(text, fallback) {
  const lower = text.toLowerCase();
  const rules = [
    ["EB-5", ["eb-5", "eb5", "investor program", "regional center"]],
    ["排期", ["visa bulletin", "priority date", "final action", "dates for filing", "排期"]],
    ["签证", ["visa", "签证", "permit", "status", "uscis", "ukvi"]],
    ["雇主担保", ["employer", "sponsor", "lmia", "provincial nominee", "pnp"]],
    ["投资", ["investment", "investor", "golden visa", "startup", "entrepreneur"]],
  ];

  const match = rules.find(([, keywords]) => keywords.some((keyword) => lower.includes(keyword)));
  return match ? match[0] : fallback || "政策";
}

function inferTags(item, source) {
  const text = `${item.title} ${item.summary} ${source.category}`.toLowerCase();
  const tags = new Set([source.country, item.category]);
  const keywordTags = [
    ["EB-5", ["eb-5", "eb5", "regional center"]],
    ["NIW", [" niw", "national interest waiver"]],
    ["EB-1", ["eb-1", "extraordinary ability"]],
    ["排期", ["visa bulletin", "priority date", "dates for filing"]],
    ["EE", ["express entry"]],
    ["PNP", ["provincial nominee", "pnp"]],
    ["留学", ["student", "study permit", "international student"]],
    ["工签", ["work permit", "h-1b", "temporary worker"]],
    ["投资", ["investor", "investment", "golden visa"]],
    ["官方", ["uscis", "ircc", "government", "home office"]],
  ];

  keywordTags.forEach(([tag, keywords]) => {
    if (keywords.some((keyword) => text.includes(keyword))) {
      tags.add(tag);
    }
  });

  return [...tags].filter(Boolean).slice(0, 5);
}

const englishLabelMap = new Map([
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
  ["巴拿马", "Panama"],
  ["多米尼克", "Dominica"],
  ["瓦努阿图", "Vanuatu"],
  ["圣基茨", "St. Kitts"],
  ["圣卢西亚", "Saint Lucia"],
  ["安提瓜", "Antigua"],
  ["泰国", "Thailand"],
  ["澳新", "Australia / New Zealand"],
  ["澳大利亚", "Australia"],
  ["新西兰", "New Zealand"],
  ["全球", "Global"],
  ["all", "Global"],
  ["more", "More"],
  ["all-bal", "Global"],
  ["政策", "Policy"],
  ["签证", "Visa"],
  ["排期", "Visa Bulletin"],
  ["雇主担保", "Employer Sponsorship"],
  ["官方", "Official"],
  ["官方机构", "Official Agency"],
  ["投资", "Investment"],
  ["工签", "Work Permit"],
  ["留学", "Study Abroad"],
  ["土耳其官方新闻", "Turkey Official News"],
  ["希腊官方网站", "Greece Official Website"],
  ["Home Office Media Blog", "Home Office Media Blog"],
  ["美国/全球企业移民", "US / Global Corporate Immigration"],
  ["香港政府新闻", "Hong Kong Government News"],
  ["EB-5", "EB-5"],
  ["NIW", "NIW"],
  ["EB-1", "EB-1"],
  ["EE", "Express Entry"],
  ["PNP", "PNP"],
]);

function translateArticleLabelToEnglish(value) {
  const text = sanitizeTextArtifacts(value).trim();
  if (!text) return "";
  return englishLabelMap.get(text) || text;
}

function normalizeTagsArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function buildArticleEnglishLabels(item) {
  const tags = normalizeTagsArray(item.tags || item.tags_json || item.tagsJson);
  return {
    countryEn: translateArticleLabelToEnglish(item.country),
    categoryEn: translateArticleLabelToEnglish(item.category),
    impactEn: translateArticleLabelToEnglish(item.impact),
    tagsEn: tags.map(translateArticleLabelToEnglish).filter(Boolean),
  };
}

async function backfillArticleEnglishLabels() {
  while (true) {
    const rows = (await mysqlJson(`
      SELECT COALESCE(JSON_ARRAYAGG(
        JSON_OBJECT(
          'id', id,
          'country', country,
          'category', category,
          'impact', impact,
          'tags', CAST(tags_json AS JSON)
        )
      ), JSON_ARRAY())
      FROM (
        SELECT id, country, category, impact, tags_json
        FROM yimin_articles
        WHERE country_en IS NULL
           OR category_en IS NULL
           OR impact_en IS NULL
           OR tags_en_json IS NULL
        ORDER BY id
        LIMIT 500
      ) missing_labels;
    `)) || [];
    if (!rows.length) return;

    for (const row of rows) {
      const labels = buildArticleEnglishLabels(row);
      await mysqlExec(`
        UPDATE yimin_articles
        SET country_en = ${sqlString(labels.countryEn)},
            category_en = ${sqlString(labels.categoryEn)},
            impact_en = ${sqlString(labels.impactEn)},
            tags_en_json = CAST(${sqlString(JSON.stringify(labels.tagsEn))} AS JSON)
        WHERE id = ${sqlNumber(row.id)};
      `);
    }
  }
}

function calculateHeat(item, source) {
  const text = `${item.title} ${item.summary}`.toLowerCase();
  const publishedAt = item.publishedAt ? new Date(item.publishedAt).getTime() : 0;
  const ageHours = publishedAt ? Math.max(0, (Date.now() - publishedAt) / 36e5) : 999;
  let score = Math.round(source.priority || 68);

  if (ageHours <= 24) score += 10;
  else if (ageHours <= 72) score += 6;
  else if (ageHours <= 168) score += 2;

  if (/eb-?5|visa bulletin|priority date|final rule|fee|policy|regional center/.test(text)) {
    score += 8;
  }
  if (/uscis|ircc|home office|government|department/.test(text)) {
    score += 4;
  }

  return Math.max(45, Math.min(99, score));
}

function imageFor(item, source) {
  const key = `${source.country} ${item.category}`.toLowerCase();

  if (key.includes("加拿大")) {
    return "https://images.unsplash.com/photo-1523240795612-9a054b0db644?auto=format&fit=crop&w=360&q=80";
  }
  if (key.includes("英国") || key.includes("欧洲")) {
    return "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=360&q=80";
  }
  if (key.includes("澳")) {
    return "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=360&q=80";
  }
  if (key.includes("eb-5") || key.includes("投资")) {
    return "https://images.unsplash.com/photo-1554224155-6726b3ff858f?auto=format&fit=crop&w=360&q=80";
  }

  return "https://images.unsplash.com/photo-1521791136064-7986c2920216?auto=format&fit=crop&w=360&q=80";
}

function parseFeed(xml, source) {
  return getBlocks(xml)
    .map((block) => {
      const title = cleanText(getTag(block, "title"));
      const rssLink = cleanText(getTag(block, "link"));
      const link = rssLink || decodeEntities(getAtomLink(block));
      const description =
        cleanText(getTag(block, "description")) ||
        cleanText(getTag(block, "summary")) ||
        cleanText(getTag(block, "content")) ||
        cleanText(getTag(block, "content:encoded"));
      const publishedAt =
        normalizeDate(getTag(block, "pubDate")) ||
        normalizeDate(getTag(block, "published")) ||
        normalizeDate(getTag(block, "updated")) ||
        null;
      const text = `${title} ${description}`;
      const category = inferCategory(text, source.category);
      const item = {
        id: createHash("sha1").update(`${link || ""}|${title}`).digest("hex").slice(0, 12),
        title,
        summary: truncate(description || "查看原文获取完整信息。", 150),
        source: source.name,
        country: source.country,
        category,
        time: publishedAt
          ? new Intl.DateTimeFormat("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
              timeZone: "Asia/Shanghai",
            }).format(new Date(publishedAt))
          : "刚刚",
        publishedAt,
        url: link,
      };
      const heat = calculateHeat(item, source);

      return {
        ...item,
        heat,
        impact: heat >= 85 ? "高影响" : heat >= 70 ? "中影响" : "低影响",
        tags: inferTags({ ...item, category }, source),
        image: imageFor({ ...item, category }, source),
      };
    })
    .filter((item) => item.title)
    .slice(0, maxItemsPerSource);
}

function extractHtmlBlocks(html, selector) {
  const selMatch = selector.match(/^(\w+)(?:\.([a-zA-Z0-9_-]+))?$/);
  if (!selMatch) return [];

  const tag = selMatch[1];
  const cls = selMatch[2];

  if (cls) {
    const re = new RegExp(
      `<${tag}\\b[^>]*class=["'][^"']*\\b${cls}\\b[^"']*["'][\\s\\S]*?<\\/${tag}>`,
      "gi",
    );
    return [...html.matchAll(re)].map((m) => m[0]);
  }

  const re = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi");
  return [...html.matchAll(re)].map((m) => m[0]);
}

function extractHtmlField(block, selector, preferAttr = false) {
  if (!selector) return "";

  if (selector.startsWith("/") && selector.endsWith("/")) {
    const pattern = selector.slice(1, -1);
    const match = block.match(new RegExp(pattern));
    return (match?.[1] || match?.[0] || "");
  }

  const parts = selector.split(/\s+/);
  const elementSel = parts[0];
  const attrHint = parts[1];

  const selMatch = elementSel.match(/^(\w+)(?:\.([a-zA-Z0-9_-]+))?$/);
  if (!selMatch) return "";

  const tag = selMatch[1];
  const cls = selMatch[2];

  let openTagRe;
  if (cls) {
    openTagRe = new RegExp(
      `<${tag}\\b[^>]*class=["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>`,
      "i",
    );
  } else {
    openTagRe = new RegExp(`<${tag}\\b[^>]*>`, "i");
  }

  const openMatch = block.match(openTagRe);
  if (!openMatch) return "";

  const openTag = openMatch[0];

  if (preferAttr || attrHint) {
    const attrName = attrHint ? attrHint.replace(/^@/, "") : "href";
    const attrMatch = openTag.match(new RegExp(`\\b${attrName}=["']([^"']+)["']`, "i"));
    return (attrMatch?.[1] || "");
  }

  const closeTagRe = new RegExp(`<\\/${tag}>`, "i");
  const openIdx = block.indexOf(openTag) + openTag.length;
  const closeIdx = block.slice(openIdx).search(closeTagRe);
  if (closeIdx === -1) return "";

  const inner = block.slice(openIdx, openIdx + closeIdx);
  return decodeEntities(inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function parseHtml(htmlText, source) {
  const fields = source.fields || {};
  const containerSelector = fields.container || "article";
  const blocks = extractHtmlBlocks(htmlText, containerSelector);
  if (!blocks.length) return [];

  return blocks
    .map((block) => {
      const title = extractHtmlField(block, fields.title);
      const link = extractHtmlField(block, fields.link, true);
      const summary = extractHtmlField(block, fields.summary);
      const timeRaw = extractHtmlField(block, fields.time, true);

      if (!title) return null;

      const linkResolved = resolveRelativeUrl(link, source.url);
      const publishedAt = normalizeDate(timeRaw);
      const text = `${title} ${summary}`;
      const category = inferCategory(text, source.category);
      const item = {
        id: createHash("sha1").update(`${linkResolved || ""}|${title}`).digest("hex").slice(0, 12),
        title: cleanText(title),
        summary: truncate(summary || "查看原文获取完整信息。", 150),
        source: source.name,
        country: source.country,
        category,
        time: publishedAt
          ? new Intl.DateTimeFormat("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
              timeZone: "Asia/Shanghai",
            }).format(new Date(publishedAt))
          : "刚刚",
        publishedAt,
        url: linkResolved,
      };
      const heat = calculateHeat(item, source);

      return {
        ...item,
        heat,
        impact: heat >= 85 ? "高影响" : heat >= 70 ? "中影响" : "低影响",
        tags: inferTags({ ...item, category }, source),
        image: imageFor({ ...item, category }, source),
      };
    })
    .filter(Boolean)
    .slice(0, maxItemsPerSource);
}

function parseJson(jsonText, source) {
  const fields = source.fields || {};

  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }

  const listPath = fields.list || "";
  const items = resolveJsonPath(data, listPath);
  if (!Array.isArray(items)) return [];

  return items
    .map((entry) => {
      const title = cleanText(String(resolveJsonPath(entry, fields.title) || ""));
      const link = String(resolveJsonPath(entry, fields.link) || "");
      const summary = cleanText(String(resolveJsonPath(entry, fields.summary) || ""));
      const timeRaw = String(resolveJsonPath(entry, fields.time) || "");

      if (!title) return null;

      const publishedAt = normalizeDate(timeRaw);
      const text = `${title} ${summary}`;
      const category = inferCategory(text, source.category);
      const item = {
        id: createHash("sha1").update(`${link || ""}|${title}`).digest("hex").slice(0, 12),
        title,
        summary: truncate(summary || "查看原文获取完整信息。", 150),
        source: source.name,
        country: source.country,
        category,
        time: publishedAt
          ? new Intl.DateTimeFormat("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
              timeZone: "Asia/Shanghai",
            }).format(new Date(publishedAt))
          : "刚刚",
        publishedAt,
        url: link,
      };
      const heat = calculateHeat(item, source);

      return {
        ...item,
        heat,
        impact: heat >= 85 ? "高影响" : heat >= 70 ? "中影响" : "低影响",
        tags: inferTags({ ...item, category }, source),
        image: imageFor({ ...item, category }, source),
      };
    })
    .filter(Boolean)
    .slice(0, maxItemsPerSource);
}

async function fetchSource(source) {
  const sourceType = source.type || "rss";
  const sourceId = await upsertSource(source, { enabled: source.enabled !== false });
  const dailyBaselinePending = await isSourceDailyBaselinePending(sourceId);
  const requirePublishedAtForDaily = source.requirePublishedAtForDaily === true;

  try {
    let fetchUrl = source.url;
    if (sourceType === "twitter") {
      const nitterUrl = twitterToNitterRss(source.url);
      if (!nitterUrl) {
        await updateSourceFetchStatus(sourceId, "Invalid Twitter URL");
        return {
          source,
          items: [],
          status: {
            name: source.name,
            country: source.country,
            ok: false,
            count: 0,
            error: "Invalid Twitter URL",
          },
        };
      }
      fetchUrl = nitterUrl;
    }

    const extraHeaders = {};
    if (sourceType === "json") {
      extraHeaders.accept = "application/json, */*";
    }

    let items;
    if (sourceType === "website") {
      const result = await fetchWithFirecrawl(fetchUrl);
      if (!result.ok) {
        await updateSourceFetchStatus(sourceId, result.error);
        return {
          source,
          items: [],
          status: { name: source.name, country: source.country, ok: false, count: 0, error: result.error },
        };
      }
      const id = createHash("sha1").update(`${result.url}|${result.title}`).digest("hex").slice(0, 12);
      items = [{
        id,
        title: cleanText(result.title),
        summary: truncate(result.summary, 500),
        source: source.name,
        country: source.country,
        category: source.category,
        time: result.publishedAt
          ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" }).format(new Date(result.publishedAt))
          : "刚刚",
        publishedAt: result.publishedAt,
        url: result.url,
        heat: calculateHeat({}, source),
        impact: source.priority >= 85 ? "高影响" : "中影响",
        tags: inferTags({}, source),
        image: imageFor({}, source),
      }];
    } else if (sourceType === "html") {
      const jinaResult = await fetchWithJina(fetchUrl);
      if (!jinaResult.ok) {
        await updateSourceFetchStatus(sourceId, jinaResult.error || `HTTP ${jinaResult.status}`);
        return {
          source,
          items: [],
          status: { name: source.name, country: source.country, ok: false, count: 0, error: jinaResult.error || `HTTP ${jinaResult.status}` },
        };
      }
      items = parseJinaMarkdown(jinaResult.text, source, jinaResult.title);
    } else {
      const response = await fetchWithTimeout(fetchUrl, extraHeaders);
      if (!response.ok) {
        await updateSourceFetchStatus(sourceId, `HTTP ${response.status}`);
        return {
          source,
          items: [],
          status: {
            name: source.name,
            country: source.country,
            ok: false,
            count: 0,
            error: `HTTP ${response.status}`,
          },
        };
      }

      if (sourceType === "rss" || sourceType === "twitter") {
        items = parseFeed(response.text, source);
      } else if (sourceType === "json") {
        items = parseJson(response.text, source);
      } else {
        items = [];
      }
    }

    for (const item of items) {
      const hasPublishedAt = hasValidPublishedAt(item);
      const dailyExcluded = !hasPublishedAt && (dailyBaselinePending || requirePublishedAtForDaily);
      await upsertArticle(item, sourceId, {
        dailyExcluded,
        dailyExcludedReason: dailyExcluded
          ? requirePublishedAtForDaily
            ? "source_requires_published_at"
            : "source_first_fetch_no_published_at"
          : null,
      });
    }
    await updateSourceFetchStatus(sourceId, null);
    if (items.length > 0) {
      await markSourceDailyBaselineCompleted(sourceId);
    }

    return {
      source,
      items,
      status: {
        name: source.name,
        country: source.country,
        ok: true,
        count: items.length,
        error: null,
      },
    };
  } catch (error) {
    await updateSourceFetchStatus(
      sourceId,
      error instanceof Error ? error.message : String(error),
    ).catch(() => {});

    return {
      source,
      items: [],
      status: {
        name: source.name,
        country: source.country,
        ok: false,
        count: 0,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    }),
  );

  return results;
}

async function executeFetchRun(runId, sources, { concurrency = feedFetchConcurrency } = {}) {
  let processedSourceCount = 0;
  let successSourceCount = 0;
  let failedSourceCount = 0;
  let itemCount = 0;

  try {
    const results = new Array(sources.length);
    const indexedSources = sources.map((source, index) => ({ source, index }));
    const firecrawlSources = indexedSources.filter(({ source }) => source.type === "website");
    const directSources = indexedSources.filter(({ source }) => source.type !== "website");

    const processSource = async ({ source, index }) => {
      const result = await fetchSource(source);
      results[index] = result;
      itemCount += result.items.length;
      processedSourceCount += 1;
      if (result.status.ok) {
        successSourceCount += 1;
      } else {
        failedSourceCount += 1;
      }

      await updateFetchRunProgress(runId, {
        processedSourceCount,
        successSourceCount,
        failedSourceCount,
        itemCount,
      });

      return result;
    };

    await Promise.all([
      runWithConcurrency(directSources, concurrency, processSource),
      runWithConcurrency(firecrawlSources, 1, processSource),
    ]);

    await finishFetchRun(runId, {
      status: "completed",
      itemCount,
    });
    cache = null;
    startArticleRelevanceInBackground()
      .then(() => startArticleTranslationInBackground())
      .catch((error) => {
        console.error("Post-fetch article AI tasks failed:", error);
      });
    return results.map((result) => result.status);
  } catch (error) {
    await finishFetchRun(runId, {
      status: "failed",
      itemCount,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    cache = null;
    throw error;
  }
}

async function refreshFeeds({ concurrency = feedFetchConcurrency } = {}) {
  await initDb();
  const sources = await listEnabledSourcesForFetch();

  const runId = await createFetchRun(sources.length);
  return executeFetchRun(runId, sources, { concurrency });
}

async function startBackgroundFeedRefresh() {
  await initDb();

  if (activeFetchRun?.status === "running") {
    return activeFetchRun;
  }

  const sources = await listEnabledSourcesForFetch();
  const runId = await createFetchRun(sources.length);
  activeFetchRun = normalizeFetchRun({
    id: runId,
    status: "running",
    sourceCount: sources.length,
    processedSourceCount: 0,
    successSourceCount: 0,
    failedSourceCount: 0,
    itemCount: 0,
    error: null,
    startedAt: formatShanghaiDateTimeISO(new Date()),
    finishedAt: null,
  });

  executeFetchRun(runId, sources)
    .then(() => getFetchRunById(runId))
    .then((run) => {
      activeFetchRun = run;
    })
    .catch((error) => {
      console.error("Background feed refresh failed:", error);
    })
    .finally(() => {
      if (activeFetchRun?.id === runId) {
        activeFetchRun = null;
      }
    });

  return activeFetchRun;
}

async function getNews({ force = false, background = false } = {}) {
  await initDb();

  if (!force && !activeFetchRun && cache && cache.expiresAt > Date.now()) {
    return cache.payload;
  }

  let statuses = await listSourceStatusesFromDb();
  let items = await listArticlesFromDb(maxTotalItems);
  let fetchRun = activeFetchRun?.status === "running"
    ? (await getFetchRunById(activeFetchRun.id)) || activeFetchRun
    : null;

  if (force) {
    if (background) {
      fetchRun = await startBackgroundFeedRefresh();
    } else {
      statuses = await refreshFeeds();
    }
    items = await listArticlesFromDb(maxTotalItems);
  } else if (items.length === 0) {
    fetchRun = await startBackgroundFeedRefresh();
  }

  const todayStats = await getTodayArticleStats();
  const generatedAt = formatShanghaiDateTimeISO(new Date());
  const payload = {
    ok: true,
    live: true,
    generatedAt,
    cacheTtlMs,
    sourceCount: statuses.length,
    itemCount: items.length,
    todayArticleCount: todayStats.total,
    todayStats,
    items,
    sources: statuses,
    refreshing: Boolean(fetchRun?.status === "running"),
    fetchRun,
  };

  if (!force && !payload.refreshing) {
    cache = {
      expiresAt: Date.now() + cacheTtlMs,
      payload,
    };
  }

  return payload;
}

function getShanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function markdownToHtml(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const html = [];
  let listType = null;
  let orderedListCounter = 0;

  function closeList() {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      orderedListCounter = 0;
      const level = heading[1].length + 1;
      html.push(`<h${level}>${escapeHtml(heading[2])}</h${level}>`);
      continue;
    }

    const ordered = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (ordered) {
      const markdownNumber = Number(ordered[1]);
      orderedListCounter = Math.max(orderedListCounter + 1, Number.isFinite(markdownNumber) ? markdownNumber : 1);
      if (listType !== "ol") {
        closeList();
        listType = "ol";
        html.push(`<ol start="${orderedListCounter}">`);
      }
      html.push(`<li>${formatInlineMarkdown(ordered[2])}</li>`);
      continue;
    }

    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    if (unordered) {
      if (listType !== "ul") {
        closeList();
        listType = "ul";
        html.push("<ul>");
      }
      html.push(`<li>${formatInlineMarkdown(unordered[1])}</li>`);
      continue;
    }

    closeList();
    html.push(`<p>${formatInlineMarkdown(trimmed)}</p>`);
  }

  closeList();
  return html.join("\n");
}

function formatInlineMarkdown(value) {
  const links = [];
  let content = escapeHtml(value).replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi,
    (_match, label, href) => {
      const token = `@@DAILY_LINK_${links.length}@@`;
      links.push(`<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`);
      return token;
    },
  );

  content = content
    .replace(
      /(^|[\s(（])((?:https?:\/\/)[^\s<>"']+)/gi,
      (_match, prefix, rawUrl) => {
        const trailing = rawUrl.match(/[),，。；;!！?？、\]】）]+$/)?.[0] || "";
        const href = rawUrl.slice(0, rawUrl.length - trailing.length);
        if (!href) {
          return `${prefix}${rawUrl}`;
        }
        return `${prefix}<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>${trailing}`;
      },
    )
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  return content.replace(/@@DAILY_LINK_(\d+)@@/g, (_match, index) => links[Number(index)] || "");
}

function normalizeDailyTopicText(value) {
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "have",
    "has",
    "are",
    "will",
    "news",
    "update",
    "updates",
    "immigration",
    "visa",
  ]);

  return String(value || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 1 && !stopWords.has(word))
    .slice(0, 18)
    .join(" ");
}

function getDailyTopicKey(item) {
  const normalized = normalizeDailyTopicText(`${item.country} ${item.category} ${item.title}`);
  return createHash("sha1").update(normalized || item.id || item.title || "").digest("hex").slice(0, 32);
}

function getDailyArticleDate(item) {
  const rawDate = item.publishedAt || item.fetchedAt;
  const date = rawDate ? new Date(rawDate) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function normalizeDailyWindowMode(value, fallback = dailyDefaultWindow) {
  const mode = String(value || "").toLowerCase();
  if (["last24h", "rolling", "24h", "past24h"].includes(mode)) {
    return "last24h";
  }
  if (["calendar", "day", "date"].includes(mode)) {
    return "calendar";
  }
  return fallback === "calendar" ? "calendar" : "last24h";
}

function formatShanghaiDateTime(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date).replace(/\//g, "-");
}

function formatShanghaiDateTimeISO(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  const bj = new Date(d.getTime() + 8 * 3600000 + d.getTimezoneOffset() * 60000);
  return `${bj.getFullYear()}-${pad(bj.getMonth() + 1)}-${pad(bj.getDate())}T${pad(bj.getHours())}:${pad(bj.getMinutes())}:${pad(bj.getSeconds())}+08:00`;
}

function getDailyWindowLabel(window) {
  if (!window?.start || !window?.end) {
    return "";
  }
  return `${formatShanghaiDateTime(window.start)} - ${formatShanghaiDateTime(window.end)}`;
}

function getDailyRecentLookbackLabel() {
  if (dailyRecentLookbackHours % 24 === 0) {
    return `近 ${dailyRecentLookbackHours / 24} 天内`;
  }
  return `近 ${dailyRecentLookbackHours} 小时内`;
}

function getDailyDateWindow(date, mode = "calendar", now = new Date()) {
  const normalizedMode = normalizeDailyWindowMode(mode, "calendar");
  if (normalizedMode === "last24h") {
    const end = now;
    const start = new Date(end.getTime() - 24 * 36e5);
    const recentStart = new Date(end.getTime() - dailyRecentLookbackHours * 36e5);
    return {
      mode: "last24h",
      start,
      end,
      recentStart,
      label: getDailyWindowLabel({ start, end }),
    };
  }

  const start = new Date(`${date}T00:00:00+08:00`);
  const end = new Date(start.getTime() + 24 * 36e5);
  const recentStart = new Date(end.getTime() - dailyRecentLookbackHours * 36e5);
  return {
    mode: "calendar",
    start,
    end,
    recentStart,
    label: getDailyWindowLabel({ start, end }),
  };
}

function getDailyWindowModeFromSearch(searchParams) {
  const explicitDate = Boolean(searchParams.get("date"));
  if (searchParams.has("window")) {
    return normalizeDailyWindowMode(searchParams.get("window"));
  }
  return explicitDate ? "calendar" : normalizeDailyWindowMode(dailyDefaultWindow);
}

function getDailyItemScore(item, articleDate, window) {
  const heat = Number(item.heat || 0);
  const ageHours = articleDate ? Math.max(0, (window.end.getTime() - articleDate.getTime()) / 36e5) : 999;
  const freshness = ageHours <= 24 ? 35 : ageHours <= dailyRecentLookbackHours ? 18 : 0;
  const official = /官方|uscis|ircc|gov|government|department|home office/i.test(item.source || "") ? 12 : 0;
  const highIntent = /eb-?5|niw|eb-?1|visa bulletin|priority date|express entry|pnp|skilled worker|排期|费用|新规|配额|审理|工签/.test(
    `${item.title} ${item.summary} ${(item.tags || []).join(" ")}`.toLowerCase(),
  )
    ? 10
    : 0;
  return heat + freshness + official + highIntent;
}

async function getRecentDailyUsage(date, lookbackDays = 7) {
  const rows = await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT(
        'articleHash', i.article_hash,
        'topicKey', i.topic_key,
        'section', i.section,
        'reportDate', DATE_FORMAT(r.report_date, '%Y-%m-%d')
      )
    ), JSON_ARRAY())
    FROM yimin_daily_report_items i
    JOIN yimin_daily_reports r ON r.id = i.report_id
    WHERE r.report_date < ${sqlString(date)}
      AND r.report_date >= DATE_SUB(${sqlString(date)}, INTERVAL ${sqlNumber(lookbackDays, 7)} DAY)
      AND i.relevant = 1;
  `);

  const byHash = new Map();
  const byTopic = new Map();
  for (const row of rows || []) {
    if (row.articleHash && !byHash.has(row.articleHash)) byHash.set(row.articleHash, row);
    if (row.topicKey && !byTopic.has(row.topicKey)) byTopic.set(row.topicKey, row);
  }
  return { rows: rows || [], byHash, byTopic };
}

function clampDailyImportance(value, fallback = 50) {
  const number = Number(value);
  return Math.max(0, Math.min(100, Number.isFinite(number) ? Math.round(number) : fallback));
}

function normalizeDailyRelevant(value, fallback = true) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["false", "0", "no", "否", "不相关"].includes(normalized)) return false;
    if (["true", "1", "yes", "是", "相关"].includes(normalized)) return true;
  }
  return fallback;
}

function getDailyAnalysisContentHash(item) {
  return createHash("sha256")
    .update(JSON.stringify({
      title: sanitizeTextArtifacts(item.title),
      summary: sanitizeTextArtifacts(item.summary),
      source: sanitizeTextArtifacts(item.source),
      country: sanitizeTextArtifacts(item.country),
      category: sanitizeTextArtifacts(item.category),
      tags: item.tags || [],
      publishedAt: item.publishedAt || null,
    }))
    .digest("hex");
}

function buildFallbackDailyAnalysis(item) {
  const canonicalTopic = sanitizeTextArtifacts(item.title) || `${item.country} ${item.category}`;
  return {
    articleHash: item.id,
    contentHash: getDailyAnalysisContentHash(item),
    relevant: true,
    importance: clampDailyImportance(item.dailyScore, 50),
    canonicalTopic,
    summaryZh: truncate(item.summary || item.title, 500),
    country: sanitizeTextArtifacts(item.country),
    category: sanitizeTextArtifacts(item.category),
    impact: sanitizeTextArtifacts(item.impact),
    model: "rules",
  };
}

function parseDeepSeekJsonArray(content) {
  const text = String(content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) {
    throw new Error("DeepSeek analysis did not return a JSON array");
  }
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) {
    throw new Error("DeepSeek analysis JSON is not an array");
  }
  return parsed;
}

function buildDailyAnalysisPrompt(items) {
  const payload = items.map((item) => ({
    id: item.id,
    title: sanitizeTextArtifacts(item.title),
    summary: truncate(item.summary, 650),
    source: sanitizeTextArtifacts(item.source),
    country: sanitizeTextArtifacts(item.country),
    category: sanitizeTextArtifacts(item.category),
    tags: (item.tags || []).slice(0, 12),
    publishedAt: item.publishedAt || item.fetchedAt || null,
    heat: Number(item.heat || 0),
  }));

  return `请逐条分析以下移民资讯，只返回 JSON 数组，不要 Markdown，不要解释。

每个输入 id 必须恰好返回一次，字段格式：
{"id":"原 id","relevant":true,"importance":0-100,"canonicalTopic":"用于合并同一事件的简短中文主题，不含媒体名","summaryZh":"不超过120字的中文事实摘要","country":"国家或地区","category":"政策分类","impact":"高影响/中影响/低影响"}

规则：
- 只有对移民业务、客户申请、签证/居留/永居/入籍路径、项目政策、配额排期、审理规则、申请费用、雇主担保、工签/学签、投资移民、技术移民、难民庇护政策有实际参考价值时 relevant=true。
- 即使出现 immigration/immigrant/alien/border/CBP/ICE 等词，只要主要内容是刑事执法个案、酒驾或死亡事件、海关查扣、假冒商品、普通公共活动、健康日宣传、天气安排、食品安全、农业渔业、一般劳工关系或普通社会新闻，也必须 relevant=false。
- 官方机构发布但与签证、身份、申请资格、审理流程、项目政策无关时 relevant=false。
- 普通旅游、房产、娱乐、体育、一般商业或科技新闻且没有明确移民申请影响时 relevant=false。
- “职业机会/就业机会/招聘/岗位列表/职位发布/Career Opportunities/Job Opportunities/Job Posting”等招聘或求职信息，除非明确宣布工签、雇主担保、短缺职业配额、移民就业合规等政策变化，否则必须 relevant=false。
- canonicalTopic 对同一政策或同一事件的不同媒体报道应尽量使用相同表述。
- canonicalTopic 必须基于原文核心事实，不得添加原文没有的断言或结论。
- canonicalTopic 避免使用“勒令”“最后通牒”“终止”“关闭”等绝对化、煽动性词汇，除非原文白纸黑字明确为此类行动，且没有任何缓冲或谈判空间。
- 如果原文包含“警告”“可能”“如果…否则…”“建议”“提议”等条件性表述，canonicalTopic 必须如实反映该条件性，例如使用“欧盟警告称可能…”“欧盟提议…否则面临…”等措辞。
- canonicalTopic 应平衡反映事件中的主要行动方和回应方，必要时可包含“双方回应”“谈判中”等词语。
- summaryZh 必须完整覆盖原文核心信息：谁、对谁、做了什么，该动作是最终决定还是提议/警告/谈判筹码，有无时间期限、条件、过渡期、替代方案，以及相关各方的直接回应或已知立场。
- summaryZh 务必区分事实陈述和观点/推测；原文引用的官方声明、信件内容等可作为事实呈现，分析性语言必须注明出处或使用“据报道”“分析认为”等措辞。
- 如果原文提到某项措施是为了达到某个目的，例如测试系统、加强审查，summaryZh 必须体现这一目的，不能只截取威胁部分。
- summaryZh 应客观中立，不偏向任何一方，但要如实反映各方矛盾或共识。
- summaryZh 避免使用“震惊”“重磅”“突发”等情绪化词汇，除非原文本身以此为标题且事实确凿。
- 输出前必须自查：canonicalTopic 是否可能让只读标题的读者产生误解，如可能则修改；summaryZh 是否忽略“仅当…才…”等关键限制条件，如有则补充；各方回应是否都得到体现，若一方明确反驳或拒绝必须写出；原文中的“截至…”“过渡期至…”等时间节点是否准确反映。
- 不得编造原文没有的政策、日期、费用或影响。
- 外文内容翻译成简体中文。

输入：
${JSON.stringify(payload)}`;
}

async function analyzeDailyArticleBatch(items) {
  const fallbackById = new Map(items.map((item) => [item.id, buildFallbackDailyAnalysis(item)]));
  try {
    const content = await callDeepSeek(buildDailyAnalysisPrompt(items));
    const parsed = parseDeepSeekJsonArray(content);
    for (const result of parsed) {
      const fallback = fallbackById.get(String(result?.id || ""));
      if (!fallback) continue;
      fallbackById.set(fallback.articleHash, {
        ...fallback,
        relevant: normalizeDailyRelevant(result.relevant, fallback.relevant),
        importance: clampDailyImportance(result.importance, fallback.importance),
        canonicalTopic: truncate(result.canonicalTopic || fallback.canonicalTopic, 300),
        summaryZh: truncate(result.summaryZh || fallback.summaryZh, 600),
        country: truncate(result.country || fallback.country, 80),
        category: truncate(result.category || fallback.category, 120),
        impact: truncate(result.impact || fallback.impact, 80),
        model: deepseekConfig.model,
      });
    }
  } catch (error) {
    if (items.length > 1 && shouldSplitDailyAnalysisBatch(error)) {
      const mid = Math.ceil(items.length / 2);
      console.warn(
        `Daily article analysis batch retrying split ${items.length} -> ${mid}+${items.length - mid}: ${formatErrorMessage(error)}`,
      );
      const results = await runWithConcurrency(
        [items.slice(0, mid), items.slice(mid)],
        1,
        (batch) => analyzeDailyArticleBatch(batch),
      );
      return results.flat();
    }
    console.error("Daily article analysis batch fallback:", formatErrorMessage(error));
  }
  return [...fallbackById.values()];
}

function shouldSplitDailyAnalysisBatch(error) {
  const message = formatErrorMessage(error);
  return /DeepSeek HTTP (408|409|425|429|5\d\d)\b/i.test(message)
    || /timeout|timed out|aborted|fetch failed|network/i.test(message)
    || /DeepSeek analysis did not return a JSON array|DeepSeek analysis JSON is not an array|Unexpected end of JSON input|DeepSeek returned empty content/i.test(message);
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function formatAiGenerationError(error) {
  const message = formatErrorMessage(error || "DeepSeek generation failed");
  const httpMatch = message.match(/^DeepSeek HTTP\s+(\d+)/i);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    if (status === 504) return "DeepSeek HTTP 504: 网关超时";
    if (status >= 500) return `DeepSeek HTTP ${status}: 服务暂时不可用`;
    return truncate(stripHtmlTags(message), 240);
  }
  if (/timeout|timed out|aborted/i.test(message)) {
    return "DeepSeek 请求超时";
  }
  return truncate(stripHtmlTags(message), 240);
}

async function loadCachedDailyAnalyses(items) {
  const byHash = new Map();
  const chunkSize = 150;
  for (let index = 0; index < items.length; index += chunkSize) {
    const chunk = items.slice(index, index + chunkSize);
    const hashes = chunk.map((item) => sqlString(item.id)).join(",");
    if (!hashes) continue;
    const rows = (await mysqlJson(`
      SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
        'articleHash', article_hash,
        'contentHash', content_hash,
        'relevant', relevant,
        'importance', importance,
        'canonicalTopic', canonical_topic,
        'summaryZh', summary_zh,
        'country', country,
        'category', category,
        'impact', impact,
        'model', model
      )), JSON_ARRAY())
      FROM yimin_article_daily_analysis
      WHERE analysis_version = ${sqlString(dailyAnalysisVersion)}
        AND article_hash IN (${hashes});
    `)) || [];
    for (const row of rows) byHash.set(row.articleHash, row);
  }
  return byHash;
}

async function saveDailyAnalyses(analyses) {
  const batchSize = 100;
  for (let index = 0; index < analyses.length; index += batchSize) {
    const values = analyses.slice(index, index + batchSize).map((analysis) => `(
      ${sqlString(analysis.articleHash)},
      ${sqlString(analysis.contentHash)},
      ${sqlString(dailyAnalysisVersion)},
      ${analysis.relevant ? 1 : 0},
      ${sqlNumber(analysis.importance)},
      ${sqlString(analysis.canonicalTopic)},
      ${sqlString(analysis.summaryZh)},
      ${sqlString(analysis.country)},
      ${sqlString(analysis.category)},
      ${sqlString(analysis.impact)},
      ${sqlString(analysis.model)}
    )`);
    if (!values.length) continue;
    await mysqlExec(`
      INSERT INTO yimin_article_daily_analysis (
        article_hash, content_hash, analysis_version, relevant, importance,
        canonical_topic, summary_zh, country, category, impact, model
      )
      VALUES ${values.join(",")}
      ON DUPLICATE KEY UPDATE
        content_hash = VALUES(content_hash),
        analysis_version = VALUES(analysis_version),
        relevant = VALUES(relevant),
        importance = VALUES(importance),
        canonical_topic = VALUES(canonical_topic),
        summary_zh = VALUES(summary_zh),
        country = VALUES(country),
        category = VALUES(category),
        impact = VALUES(impact),
        model = VALUES(model),
        analyzed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP;
    `);
  }
}

async function getDailyArticleAnalyses(items) {
  const cached = await loadCachedDailyAnalyses(items);
  const analyses = new Map();
  const missing = [];
  for (const item of items) {
    const contentHash = getDailyAnalysisContentHash(item);
    const existing = cached.get(item.id);
    if (existing?.contentHash === contentHash && existing.model !== "rules") {
      analyses.set(item.id, {
        ...existing,
        relevant: Boolean(Number(existing.relevant)),
        importance: clampDailyImportance(existing.importance),
      });
    } else {
      missing.push(item);
    }
  }

  const batches = [];
  for (let index = 0; index < missing.length; index += dailyAnalysisBatchSize) {
    batches.push(missing.slice(index, index + dailyAnalysisBatchSize));
  }
  if (batches.length) {
    const results = await runWithConcurrency(
      batches,
      dailyAnalysisConcurrency,
      (batch) => analyzeDailyArticleBatch(batch),
    );
    const fresh = results.flat();
    await saveDailyAnalyses(fresh);
    for (const analysis of fresh) analyses.set(analysis.articleHash, analysis);
  }

  return analyses;
}

function getDailyEventKey(item, analysis) {
  const normalized = normalizeDailyTopicText(
    `${analysis.country || item.country} ${analysis.category || item.category} ${analysis.canonicalTopic || item.title}`,
  );
  return createHash("sha1")
    .update(normalized || item.topicKey || item.id)
    .digest("hex")
    .slice(0, 32);
}

function buildDailyEvents(items, usage) {
  const groups = new Map();
  for (const item of items.filter((candidate) => candidate.analysis.relevant)) {
    const eventKey = getDailyEventKey(item, item.analysis);
    const recentUsage = usage.byHash.get(item.id)
      || usage.byTopic.get(eventKey)
      || usage.byTopic.get(item.topicKey)
      || null;
    const enriched = { ...item, eventKey, recentUsage };
    if (!groups.has(eventKey)) groups.set(eventKey, []);
    groups.get(eventKey).push(enriched);
  }

  const events = [];
  for (const [eventKey, members] of groups) {
    members.sort((a, b) =>
      (b.analysis.importance + b.dailyScore) - (a.analysis.importance + a.dailyScore)
    );
    const representative = members[0];
    const hasTodayNew = members.some((item) => item.isToday && !item.recentUsage);
    const hasRecentUnused = members.some((item) => item.isRecent && !item.isToday && !item.recentUsage);
    const hasRecent = members.some((item) => item.isRecent);
    const section = hasTodayNew
      ? "today_new"
      : hasRecentUnused
        ? "important"
        : hasRecent
          ? "continuing"
          : "repeated";
    const sources = [...new Set(members.map((item) => item.source).filter(Boolean))];
    const event = {
      eventKey,
      dailySection: section,
      title: representative.analysis.canonicalTopic || representative.title,
      summary: representative.analysis.summaryZh || representative.summary,
      country: representative.analysis.country || representative.country,
      category: representative.analysis.category || representative.category,
      impact: representative.analysis.impact || representative.impact,
      importance: Math.max(...members.map((item) => item.analysis.importance)),
      articleCount: members.length,
      sourceCount: sources.length,
      sources,
      articleHashes: members.map((item) => item.id),
      representativeUrl: representative.url || "",
      url: representative.url || "",
      articleDate: representative.articleDate,
      recentUsage: members.find((item) => item.recentUsage)?.recentUsage || null,
      members,
    };
    for (const member of members) {
      member.eventKey = eventKey;
      member.dailySection = section;
    }
    events.push(event);
  }
  return events.sort((a, b) => b.importance - a.importance || b.articleCount - a.articleCount);
}

async function buildDailyContext(date, { windowMode = "calendar" } = {}) {
  const window = getDailyDateWindow(date, windowMode);
  let items = await listDailyCandidateArticlesFromDb(window);
  if (items.length === 0) {
    await refreshFeeds();
    items = await listDailyCandidateArticlesFromDb(window);
  }

  const enriched = items.map((item) => {
    const sanitizedItem = {
      ...item,
      title: sanitizeTextArtifacts(item.title),
      summary: sanitizeTextArtifacts(item.summary),
      source: sanitizeTextArtifacts(item.source),
      country: sanitizeTextArtifacts(item.country),
      category: sanitizeTextArtifacts(item.category),
      impact: sanitizeTextArtifacts(item.impact),
      tags: (item.tags || []).map((tag) => sanitizeTextArtifacts(tag)).filter(Boolean),
    };
    const articleDate = getDailyArticleDate(item);
    const topicKey = getDailyTopicKey(sanitizedItem);
    const ageHours = articleDate ? Math.max(0, (window.end.getTime() - articleDate.getTime()) / 36e5) : 999;
    const isToday = articleDate ? articleDate >= window.start && articleDate < window.end : false;
    const isRecent = articleDate ? articleDate >= window.recentStart && articleDate < window.end : false;
    return {
      ...sanitizedItem,
      articleDate: articleDate ? formatShanghaiDateTimeISO(articleDate) : null,
      ageHours,
      isToday,
      isRecent,
      topicKey,
      dailyScore: getDailyItemScore(sanitizedItem, articleDate, window),
    };
  });

  const analyses = await getDailyArticleAnalyses(enriched);
  const analyzedItems = enriched.map((item) => ({
    ...item,
    analysis: analyses.get(item.id) || buildFallbackDailyAnalysis(item),
  }));
  const usage = await getRecentDailyUsage(date);
  const events = buildDailyEvents(analyzedItems, usage);
  const eventMembers = new Map(events.flatMap((event) => event.members.map((item) => [item.id, item])));
  const allItems = analyzedItems.map((item) => {
    const member = eventMembers.get(item.id);
    if (member) return member;
    return {
      ...item,
      eventKey: getDailyEventKey(item, item.analysis),
      dailySection: "excluded",
      recentUsage: usage.byHash.get(item.id) || usage.byTopic.get(item.topicKey) || null,
    };
  });

  return {
    date,
    window,
    rawItems: items,
    allItems,
    relevantItems: allItems.filter((item) => item.analysis.relevant),
    events,
    todayNew: events.filter((event) => event.dailySection === "today_new"),
    important: events.filter((event) => event.dailySection === "important"),
    continuing: events.filter((event) => event.dailySection === "continuing"),
    repeated: events.filter((event) => event.dailySection === "repeated"),
  };
}

function formatDailyPromptEvents(events) {
  if (!events.length) {
    return "暂无。";
  }

  return events
    .map((event, index) => [
      `${index + 1}. [${event.dailySection}] ${sanitizeTextArtifacts(event.title)}`,
      `国家/分类：${sanitizeTextArtifacts(event.country)} / ${sanitizeTextArtifacts(event.category)}`,
      `重要度：${event.importance}；文章数：${event.articleCount}；信源数：${event.sourceCount}`,
      `摘要：${truncate(event.summary, 260)}`,
      `代表链接：${event.representativeUrl || ""}`,
      event.recentUsage
        ? `历史状态：近 7 天已在 ${event.recentUsage.reportDate} 出现，只能作为延续关注或不建议重复。`
        : "历史状态：近 7 天未出现。",
    ].join("\n"))
    .join("\n\n");
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function reduceDailyEventChunk(events) {
  const prompt = `请把以下日报聚合事件压缩成简洁的中文分析素材，供另一个模型生成最终日报。

要求：
- 保留每条高重要度事件的事实、国家、影响对象、分组标记和代表链接。
- 同类低重要度事件可以合并概括，但不得把 today_new 写成 continuing，也不得编造事实。
- 使用紧凑 Markdown，每条最多两行。

${formatDailyPromptEvents(events)}`;
  try {
    return await callDeepSeek(prompt);
  } catch (error) {
    console.error("Daily event digest fallback:", error instanceof Error ? error.message : String(error));
    return formatDailyPromptEvents(events);
  }
}

async function reduceDailyDigestDocuments(documents) {
  const prompt = `请继续压缩以下多批日报分析素材。

要求：
- 必须保留所有高重要度政策变化、数字、日期、影响对象及代表链接。
- 保留 today_new / important / continuing / repeated 分组含义。
- 同类低重要度内容可按国家和主题合并，不得编造。
- 输出紧凑 Markdown，供最终日报模型使用。

${documents.join("\n\n--- 批次分隔 ---\n\n")}`;
  try {
    return await callDeepSeek(prompt);
  } catch (error) {
    console.error("Daily digest reduction fallback:", error instanceof Error ? error.message : String(error));
    return documents.join("\n\n");
  }
}

function dailyItemLink(item) {
  const title = sanitizeTextArtifacts(item.title);
  return item.url ? `[${title}](${item.url})` : title;
}

function buildFallbackDailyMarkdown(date, context, reason = "") {
  const todayNew = context.todayNew || [];
  const important = context.important || [];
  const continuing = context.continuing || [];
  const repeated = context.repeated || [];
  const windowText = context.window?.label || date;
  const cleanReason = reason ? formatAiGenerationError(reason) : "";

  return `# 移民热点日报 | ${date}

> 统计窗口：${windowText}

## 一、今日总结

${todayNew.length ? `本期发现 ${todayNew.length} 条未在近 7 天日报中出现的新增事实，重点集中在 ${[...new Set(todayNew.map((item) => item.country).filter(Boolean))].slice(0, 4).join("、") || "多个地区"}。` : "本期暂无可确认的重大新增事实，避免把旧热点包装成今日新闻。"}

${cleanReason ? `> AI 日报生成暂不可用：${cleanReason}` : ""}

## 二、今日新增

${todayNew.length ? todayNew.map((item) => `- ${item.country || "未知地区"}｜${item.category || "未分类"}：${dailyItemLink(item)} - ${item.summary}`).join("\n") : "- 暂无。"}

## 三、重要变化

${important.length ? important.map((item) => `- ${item.country || "未知地区"}｜${item.category || "未分类"}：${dailyItemLink(item)} - ${item.summary}`).join("\n") : "- 暂无新的重要变化。"}

## 四、延续关注

${continuing.length ? continuing.map((item) => `- ${dailyItemLink(item)}：${item.recentUsage ? `近 7 天已出现过（${item.recentUsage.reportDate}），仅适合作为背景跟进。` : "不是今日新增，仅作为延续关注。"}`).join("\n") : "- 暂无。"}

## 五、不建议重复

${repeated.length ? repeated.map((item) => `- ${item.title}：已过新鲜期或近期出现过，不建议放入今日总结。`).join("\n") : "- 暂无。"}

## 六、行动建议

- 今日总结只发布“今日新增”里的本期新增事实。
- 延续关注内容可做 FAQ、客户答疑或内部跟进，不要包装为新政策。`;
}

async function buildDailyPrompt(date, context) {
  const eventMaterial = await buildDailyEventMaterial(context.events || []);
  return `你是一位资深移民行业信息分析师。请基于以下抓取到的移民资讯，生成中文移民热点日报。

日期：${date}
统计窗口：${context.window?.label || date}
窗口模式：${context.window?.mode === "last24h" ? "过去 24 小时早报" : "自然日完整日报"}
日报可选时间范围：${getDailyWindowLabel({ start: context.window.recentStart, end: context.window.end })}
候选资讯总数：${context.rawItems.length}
相关资讯总数：${context.relevantItems.length}
聚合事件总数：${context.events.length}

【全量聚合事件分析素材】
每条事件带有 today_new / important / continuing / repeated 分组标记。生成日报时必须遵守分组。
${eventMaterial}

内容相关性过滤：
- 只保留与移民、签证、永久居留、国籍、边境/入境、工签/雇主担保、留学签证、投资移民、难民/庇护、移民机构政策、移民相关就业或教育合规直接相关的资讯。
- 如果某条资讯明显只是宏观政治、普通旅游、城市生活、房产、商业新闻、体育娱乐、科技产品、灾害事故等，且标题和摘要都看不出与移民客户、移民项目或签证政策有关，必须剔除，不得出现在任何章节。
- “职业机会/就业机会/招聘/岗位列表/职位发布/Career Opportunities/Job Opportunities/Job Posting”等招聘或求职信息不得进入日报；只有当内容明确涉及工签、雇主担保、短缺职业配额、移民就业合规等政策变化时才可保留。
- 无法确认是否相关、或可能间接影响移民客户/项目判断的资讯，可以保留。
- 不要输出“已剔除内容”列表，也不要解释剔除过程。

发布时间过滤：
- 只使用“日报可选时间范围”内的资讯；发布时间早于该范围的内容不得出现在任何章节。
- 如果没有明确发布时间，但抓取时间在“日报可选时间范围”内，可以保留。

标题生成规则：
- 标题必须基于原文核心事实，不得添加原文没有的断言或结论。
- 避免使用“勒令”“最后通牒”“终止”“关闭”等绝对化、煽动性词汇，除非原文白纸黑字明确为此类行动，且没有任何缓冲或谈判空间。
- 如果原文包含“警告”“可能”“如果…否则…”“建议”“提议”等条件性表述，标题应如实反映该条件性，例如使用“欧盟警告称可能…”“欧盟提议…否则面临…”等措辞。
- 标题应平衡反映事件中的主要行动方和回应方，必要时可包含“双方回应”“谈判中”等词语。

摘要生成规则：
- 摘要必须完整覆盖原文的核心信息，包括谁、对谁、做了什么；该动作是最终决定，还是提议/警告/谈判筹码；有无时间期限、条件、过渡期、替代方案；相关各方的直接回应或已知立场。
- 务必区分“事实陈述”和“观点/推测”。原文中引用的官方声明、信件内容等作为事实呈现，分析性语言应注明出处或使用“据报道”“分析认为”等。
- 如果原文提到某项措施是为了达到某个目的，例如测试系统、加强审查，摘要中必须体现这一目的，不能只截取威胁部分。
- 摘要应客观中立，不偏向任何一方，但也要如实反映各方矛盾或共识。
- 避免使用“震惊”“重磅”“突发”等情绪化词汇，除非原文本身以此为标题且事实确凿。

自查要求：
- 输出前，请对照原文检查标题是否可能让只读标题的读者产生误解。如果是，请修改。
- 摘要中是否有被忽略的关键限制条件，例如“仅当…才…”。如果有，请补充。
- 各方回应是否都得到了体现。如果一方明确反驳或拒绝，应一并写出。
- 原文中的时间节点，例如“截至…”“过渡期至…”，是否准确反映。

请严格使用 Markdown，包含以下六节：
## 一、今日总结
只总结【本期新增】里的事实。若本期新增为空，必须明确写“本期暂无可确认的重大新增事实”，不要复述延续关注或不建议重复内容。

## 二、今日新增
列出本期新增事实，明确国家、项目、影响对象，并保留原文链接。

## 三、重要变化
列出不是本期新增、但在${getDailyRecentLookbackLabel()}且近 7 天未写过的变化。

## 四、延续关注
列出需要跟进但不能当作今日新闻的内容，说明为什么不能重复包装。

## 五、不建议重复
列出过旧或近 7 天已出现的信息，提醒不要放进今日总结。

## 六、行动建议
给销售、文案、项目经理各 1-2 条行动建议。

硬性要求：
- 不要把【延续关注】或【不建议重复】写进“今日总结”。
- 不要编造政策、日期、费用、影响范围。
- 明显与移民类内容不相关的信息必须剔除；无法确认是否相关的信息可以保留。
- 职业机会、招聘岗位、职位列表、求职公告不得出现在任何章节，除非它本身是移民就业/签证政策变化。
- 发布时间早于“日报可选时间范围”的信息必须剔除；无法确认发布时间但抓取时间较新的信息可以保留。
- 如果某条信息近 7 天已经出现，只能放在“延续关注”或“不建议重复”。
- 同一章节内如使用数字编号，必须连续递增，不要每条都写成”1.”。
- 所有输出必须使用简体中文，遇到英文、希腊文或其他语言的标题和摘要必须翻译为中文，不得保留原文。`;
}

async function buildDailyEventMaterial(events) {
  const direct = formatDailyPromptEvents(events);
  if (direct.length <= dailyFinalPromptMaxChars) return direct;

  let documents = await runWithConcurrency(
    chunkArray(events, 40),
    dailyAnalysisConcurrency,
    (chunk) => reduceDailyEventChunk(chunk),
  );

  while (documents.join("\n\n").length > dailyFinalPromptMaxChars && documents.length > 1) {
    documents = await runWithConcurrency(
      chunkArray(documents, 6),
      dailyAnalysisConcurrency,
      (group) => reduceDailyDigestDocuments(group),
    );
  }

  return documents.join("\n\n");
}

async function generateDailyMarkdown(date, dailyContext) {
  try {
    const markdown = await callDeepSeek(await buildDailyPrompt(date, dailyContext));
    return {
      markdown,
      model: deepseekConfig.model,
    };
  } catch (error) {
    console.warn(`Daily report DeepSeek failed: ${formatAiGenerationError(error)}`);
    return {
      markdown: buildFallbackDailyMarkdown(date, dailyContext, formatAiGenerationError(error)),
      model: "fallback",
    };
  }
}

function getDailyContextItems(context) {
  return context.allItems || [];
}

function getDailyArticleSnapshot(item) {
  return {
    id: item.id,
    title: sanitizeTextArtifacts(item.title),
    summary: sanitizeTextArtifacts(item.summary),
    source: sanitizeTextArtifacts(item.source),
    country: sanitizeTextArtifacts(item.country),
    category: sanitizeTextArtifacts(item.category),
    time: item.time,
    publishedAt: item.publishedAt,
    fetchedAt: item.fetchedAt,
    articleDate: item.articleDate,
    url: item.url,
    heat: item.heat,
    impact: sanitizeTextArtifacts(item.impact),
    tags: (item.tags || []).map((tag) => sanitizeTextArtifacts(tag)).filter(Boolean),
    image: item.image || "",
    recentUsage: item.recentUsage || null,
    eventKey: item.eventKey || "",
    relevant: item.analysis?.relevant !== false,
    importance: item.analysis?.importance || 0,
    canonicalTopic: item.analysis?.canonicalTopic || "",
    analysisSummary: item.analysis?.summaryZh || "",
    analysisModel: item.analysis?.model || "",
  };
}

async function saveDailyReportItems(reportDate, context) {
  const row = await mysqlJson(`
    SELECT JSON_OBJECT('id', id)
    FROM yimin_daily_reports
    WHERE report_date = ${sqlString(reportDate)}
    LIMIT 1;
  `);
  const reportId = row?.id;
  if (!reportId) return;

  await mysqlExec(`
    DELETE FROM yimin_daily_report_items WHERE report_id = ${sqlNumber(reportId)};
    DELETE FROM yimin_daily_report_events WHERE report_id = ${sqlNumber(reportId)};
  `);

  const items = getDailyContextItems(context);
  for (const batch of chunkArray(items, 100)) {
    const values = batch.map((item) => `(
      ${sqlNumber(reportId)},
      ${sqlString(item.id)},
      ${sqlString(item.eventKey || item.topicKey)},
      ${sqlString(item.eventKey || "")},
      ${sqlString(item.dailySection || "excluded")},
      ${item.analysis?.relevant === false ? 0 : 1},
      ${sqlNumber(item.analysis?.importance || 0)},
      ${sqlDate(item.articleDate)},
      ${sqlJson(getDailyArticleSnapshot(item))}
    )`);
    if (!values.length) continue;
    await mysqlExec(`
      INSERT INTO yimin_daily_report_items (
        report_id, article_hash, topic_key, event_key, section,
        relevant, importance, article_date, article_snapshot
      )
      VALUES ${values.join(",")};
    `);
  }

  for (const batch of chunkArray(context.events || [], 100)) {
    const values = batch.map((event) => `(
      ${sqlNumber(reportId)},
      ${sqlString(event.eventKey)},
      ${sqlString(event.dailySection)},
      ${sqlString(event.title)},
      ${sqlString(event.summary)},
      ${sqlString(event.country)},
      ${sqlString(event.category)},
      ${sqlNumber(event.importance)},
      ${sqlNumber(event.articleCount)},
      ${sqlNumber(event.sourceCount)},
      ${sqlString(event.representativeUrl)},
      ${sqlJson(event.articleHashes)}
    )`);
    if (!values.length) continue;
    await mysqlExec(`
      INSERT INTO yimin_daily_report_events (
        report_id, event_key, section, title, summary, country, category,
        importance, article_count, source_count, representative_url, article_hashes_json
      )
      VALUES ${values.join(",")};
    `);
  }
}

async function callDeepSeek(prompt, options = {}) {
  if (!deepseekConfig.apiKey) {
    throw new Error("DeepSeek API key is not configured");
  }

  const systemPrompt = options.systemPrompt
    || "你是移民政策日报编辑，只能基于用户提供的信息进行归纳，不能编造政策、日期、费用或结论。输出必须使用简体中文，遇到英文或其他语言的源材料必须翻译为中文，不要保留原文。";
  const temperature = Number.isFinite(Number(options.temperature)) ? Number(options.temperature) : 0.25;

  const response = await fetch(getDeepSeekChatCompletionsUrl(), {
    method: "POST",
    signal: AbortSignal.timeout(deepseekTimeoutMs),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${deepseekConfig.apiKey}`,
    },
    body: JSON.stringify({
      model: options.model || deepseekConfig.model,
      temperature,
      stream: deepseekStreamEnabled,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DeepSeek HTTP ${response.status}: ${text.slice(0, 180)}`);
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  let content = deepseekStreamEnabled && !contentType.includes("application/json")
    ? await readOpenAICompatibleStream(response)
    : await readOpenAICompatibleJson(response);
  content = content.trim();
  if (!content) {
    throw new Error("DeepSeek returned empty content");
  }

  // Remove non-CJK garbage: Greek, control chars, isolated combining marks
  content = content.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  content = content.replace(
    /[Ͱ-Ͽᴀ-ᶿἀ-῿Ⲁ-⳿]/g,
    "",
  );
  if (hasReplacementTextArtifacts(content)) {
    throw new Error("模型返回内容包含乱码，系统已阻止保存，请重试生成");
  }

  return sanitizeTextArtifacts(content);
}

async function readOpenAICompatibleJson(response) {
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

async function readOpenAICompatibleStream(response) {
  if (!response.body) {
    return readOpenAICompatibleJson(response);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let content = "";

  const processLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith(":")) {
      return false;
    }
    if (!line.startsWith("data:")) {
      return false;
    }

    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") {
      return data === "[DONE]";
    }

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return false;
    }
    if (parsed.error) {
      throw new Error(parsed.error.message || JSON.stringify(parsed.error));
    }

    const choice = parsed.choices?.[0] || {};
    content += choice.delta?.content
      || choice.message?.content
      || choice.text
      || "";
    return false;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (processLine(line)) {
        return content;
      }
    }
  }

  buffer += decoder.decode();
  for (const line of buffer.split(/\r?\n/)) {
    if (processLine(line)) {
      break;
    }
  }
  return content;
}

function getDeepSeekChatCompletionsUrl() {
  const baseUrl = deepseekConfig.baseUrl.replace(/\/+$/, "");
  return baseUrl.endsWith("/chat/completions")
    ? baseUrl
    : `${baseUrl}/chat/completions`;
}

function attachDailyWindowLabel(report) {
  if (!report) {
    return report;
  }
  const start = report.windowStart ? new Date(report.windowStart) : null;
  const end = report.windowEnd ? new Date(report.windowEnd) : null;
  return {
    ...report,
    windowLabel:
      start && end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())
        ? getDailyWindowLabel({ start, end })
        : "",
  };
}

function normalizeDailyLanguage(value) {
  return String(value || "").trim().toLowerCase() === "en" ? "en" : "zh";
}

function extractMarkdownTitle(markdown, fallback) {
  const firstHeading = String(markdown || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^#\s+/.test(line));
  return sanitizeTextArtifacts(firstHeading ? firstHeading.replace(/^#\s+/, "") : fallback);
}

async function loadDailyReportBaseRow(date) {
  return mysqlJson(`
    SELECT JSON_OBJECT(
      'id', id,
      'date', DATE_FORMAT(report_date, '%Y-%m-%d'),
      'title', title,
      'contentMarkdown', content_markdown,
      'html', content_html,
      'sourceItemCount', source_item_count,
      'relevantItemCount', relevant_item_count,
      'eventCount', event_count,
      'model', model,
      'generatedAt', DATE_FORMAT(generated_at, '%Y-%m-%dT%H:%i:%s+08:00'),
      'windowMode', window_mode,
      'windowStart', IF(window_start_at IS NULL, NULL, DATE_FORMAT(window_start_at, '%Y-%m-%dT%H:%i:%s+08:00')),
      'windowEnd', IF(window_end_at IS NULL, NULL, DATE_FORMAT(window_end_at, '%Y-%m-%dT%H:%i:%s+08:00'))
    )
    FROM yimin_daily_reports
    WHERE report_date = ${sqlString(date)}
    LIMIT 1;
  `);
}

async function loadDailyLocalizationEvents(reportId) {
  return (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
      'eventKey', event_key,
      'section', section,
      'title', title,
      'summary', summary,
      'country', country,
      'category', category,
      'importance', importance,
      'articleCount', article_count,
      'sourceCount', source_count,
      'representativeUrl', representative_url,
      'articleHashes', article_hashes_json
    )), JSON_ARRAY())
    FROM (
      SELECT *
      FROM yimin_daily_report_events
      WHERE report_id = ${sqlNumber(reportId)}
      ORDER BY FIELD(section, 'today_new', 'important', 'continuing', 'repeated'), importance DESC, id ASC
    ) ordered_events;
  `)) || [];
}

function getDailyLocalizationInputHash(baseReport, events, language) {
  return createHash("sha256")
    .update(JSON.stringify({
      version: dailyLocalizationVersion,
      language,
      date: baseReport.date,
      windowMode: baseReport.windowMode,
      windowStart: baseReport.windowStart,
      windowEnd: baseReport.windowEnd,
      sourceItemCount: baseReport.sourceItemCount,
      relevantItemCount: baseReport.relevantItemCount,
      eventCount: baseReport.eventCount,
      events: events.map((event) => ({
        eventKey: event.eventKey,
        section: event.section,
        title: event.title,
        summary: event.summary,
        country: event.country,
        category: event.category,
        importance: event.importance,
        articleCount: event.articleCount,
        sourceCount: event.sourceCount,
        representativeUrl: event.representativeUrl,
      })),
      sourceMarkdownHash: createHash("sha256").update(String(baseReport.contentMarkdown || "")).digest("hex"),
    }))
    .digest("hex");
}

async function loadDailyLocalization(reportId, language) {
  return mysqlJson(`
    SELECT JSON_OBJECT(
      'language', language,
      'title', title,
      'contentMarkdown', content_markdown,
      'html', content_html,
      'inputHash', input_hash,
      'model', model,
      'generatedAt', DATE_FORMAT(generated_at, '%Y-%m-%dT%H:%i:%s+08:00')
    )
    FROM yimin_daily_report_localizations
    WHERE report_id = ${sqlNumber(reportId)}
      AND language = ${sqlString(language)}
    LIMIT 1;
  `);
}

async function saveDailyLocalization(reportId, language, localization) {
  await mysqlExec(`
    INSERT INTO yimin_daily_report_localizations (
      report_id, language, title, content_markdown, content_html,
      input_hash, model, generated_at
    )
    VALUES (
      ${sqlNumber(reportId)},
      ${sqlString(language)},
      ${sqlString(localization.title)},
      ${sqlString(localization.contentMarkdown)},
      ${sqlString(localization.html)},
      ${sqlString(localization.inputHash)},
      ${sqlString(localization.model)},
      CURRENT_TIMESTAMP
    )
    ON DUPLICATE KEY UPDATE
      title = VALUES(title),
      content_markdown = VALUES(content_markdown),
      content_html = VALUES(content_html),
      input_hash = VALUES(input_hash),
      model = VALUES(model),
      generated_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP;
  `);
}

function mergeDailyLocalization(baseReport, localization) {
  const contentMarkdown = sanitizeTextArtifacts(localization.contentMarkdown || "");
  return attachDailyWindowLabel({
    date: baseReport.date,
    title: sanitizeTextArtifacts(localization.title || baseReport.title),
    contentMarkdown,
    html: markdownToHtml(contentMarkdown),
    sourceItemCount: baseReport.sourceItemCount,
    relevantItemCount: baseReport.relevantItemCount,
    eventCount: baseReport.eventCount,
    model: localization.model || baseReport.model,
    generatedAt: localization.generatedAt,
    windowMode: baseReport.windowMode,
    windowStart: baseReport.windowStart,
    windowEnd: baseReport.windowEnd,
    language: localization.language || "en",
  });
}

function formatDailyLocalizationEvents(events) {
  if (!events.length) {
    return "No grouped immigration events were saved for this report.";
  }

  return events.map((event, index) => [
    `${index + 1}. [${event.section}] ${sanitizeTextArtifacts(event.title)}`,
    `Country/category: ${sanitizeTextArtifacts(event.country)} / ${sanitizeTextArtifacts(event.category)}`,
    `Importance: ${event.importance}; article count: ${event.articleCount}; source count: ${event.sourceCount}`,
    `Summary: ${truncate(event.summary, 360)}`,
    `Representative link: ${event.representativeUrl || ""}`,
  ].join("\n")).join("\n\n");
}

function buildEnglishDailyPrompt(baseReport, events) {
  return `You are a senior immigration industry analyst. Generate an English immigration daily brief that matches the Chinese public daily brief's factual scope and editorial rules.

Date: ${baseReport.date}
Reporting window: ${baseReport.windowStart || ""} to ${baseReport.windowEnd || ""}
Window mode: ${baseReport.windowMode === "last24h" ? "last 24 hours morning brief" : "calendar-day daily brief"}
Candidate article count: ${baseReport.sourceItemCount}
Relevant article count: ${baseReport.relevantItemCount}
Grouped event count: ${baseReport.eventCount}

Chinese public daily brief (authoritative factual scope):
${truncate(baseReport.contentMarkdown || "", 16000)}

Grouped event material:
${formatDailyLocalizationEvents(events)}

Consistency rules:
- The Chinese public daily brief is the source of truth for what domestic and overseas colleagues should see.
- Do not add facts, countries, policies, dates, fees, risks, or action recommendations that are absent from the Chinese public daily brief or its saved grouped events.
- Do not remove or downgrade material that the Chinese public daily includes as a major new fact unless it is clearly duplicated inside the same English section.
- Preserve the same section meaning and freshness classification as the Chinese brief: today's new facts stay in Executive Summary/New Today; continuing or repeated items must not become headline news.
- Use grouped event material only to preserve original links, country/category context, and section labels. Do not use it to introduce a separate English editorial selection.

Content relevance rules, identical to the Chinese daily:
- Keep only updates directly relevant to immigration, visas, permanent residence, nationality, border/entry, work permits/employer sponsorship, study visas, investment immigration, asylum/refugee policy, immigration agency policy, immigration-related employment compliance, or immigration-related education compliance.
- Exclude general politics, ordinary tourism, city life, real estate, general business, sports/entertainment, technology products, disasters/incidents, and other non-immigration content when the title and summary do not show a clear immigration client, program, or visa-policy impact.
- Exclude career opportunity, job opportunity, recruitment, job listing, and job posting content unless the item itself announces a work visa, employer sponsorship, shortage occupation quota, or immigration employment-compliance policy change.
- Use only material within the reporting window represented by the Chinese public daily.

Headline and summary rules, identical to the Chinese daily:
- Headlines must be based on the source material's core facts and must not add assertions or conclusions absent from the source.
- Avoid absolute or sensational terms such as "ordered", "ultimatum", "terminated", or "closed" unless the source explicitly describes that exact action with no buffer, condition, negotiation, or transition path.
- If the source uses conditional language such as "warned", "may", "if...otherwise", "recommended", or "proposed", preserve that conditional nature in the English headline and summary.
- Balance the main actor and the responding party where relevant; use wording such as "both sides responded" or "talks continue" when the source supports it.
- Summaries must cover who acted, who was affected, what was done or stated, whether it is a final decision or a proposal/warning/negotiating position, any deadline, condition, transition period, alternative, and known responses or positions from relevant parties.
- Distinguish facts from views or speculation. Present official statements, letters, and quoted documents as sourced facts; label analysis with wording such as "according to reports" or "analysts said" when needed.
- If the source states the purpose of a measure, such as testing a system or strengthening review, include that purpose instead of extracting only the threatening portion.
- Keep summaries neutral and avoid emotional wording such as "shocking", "blockbuster", or "breaking" unless the original source itself uses it and the fact is verified.

Self-check before output:
- Check whether any headline could mislead a reader who only reads the headline. If yes, revise it.
- Check whether the summary omits key limiting conditions such as "only if..." or "provided that...". If yes, add them.
- Check whether relevant parties' responses are represented. If one side clearly refuted or rejected a claim, include that response.
- Check whether source time markers such as "as of..." or "transition period until..." are accurately reflected.

Section rules:
- today_new means facts that did not appear in the last 7 days of daily reports.
- important means relevant recent changes that are not today's new facts but have not been used recently.
- continuing means items that need monitoring but should not be packaged as fresh news.
- repeated means stale or recently repeated items that should not be used in today's headline summary.

Write concise, professional Markdown in English with exactly these six sections:
## 1. Executive Summary
Only summarize today_new facts. If there are no today_new facts, state that there are no confirmed major new immigration facts for this issue.

## 2. New Today
List new facts with country or region, program or policy area, affected audience, and original links.

## 3. Important Changes
List recent important changes that are not today_new.

## 4. Continuing Watch
List follow-up items and explain why they should not be repackaged as fresh news.

## 5. Do Not Repackage
List stale or repeated items that should stay out of the headline summary.

## 6. Suggested Actions
Give 1-2 practical actions each for sales, copywriting, and project managers.

Hard requirements:
- Do not invent policies, dates, fees, eligibility rules, impacts, or conclusions.
- Do not move continuing or repeated items into the Executive Summary.
- Do not include career opportunities, recruitment posts, job lists, or job postings in any section unless they are immigration employment/visa policy changes.
- Preserve original links when a link is available.
- Translate Chinese event titles and summaries naturally into English.
- Output English only.`;
}

function buildEnglishDailyTranslationPrompt(baseReport) {
  return `Translate the following Chinese immigration daily brief into natural professional English Markdown.

Rules:
- Preserve the factual meaning, Markdown structure, and original links.
- Do not add new facts, dates, fees, policy interpretations, or conclusions.
- Preserve the Chinese brief's inclusion/exclusion decisions and freshness classification; do not promote continuing or repeated items into headline news.
- Exclude career opportunities, recruitment posts, job lists, or job postings unless the Chinese brief explicitly treats them as immigration employment/visa policy changes.
- Preserve cautious and conditional wording in headlines and summaries. Do not turn warnings, proposals, possible actions, negotiation positions, or "if...otherwise" statements into final decisions.
- Avoid absolute or sensational terms such as "ordered", "ultimatum", "terminated", or "closed" unless the Chinese brief/source explicitly supports that exact meaning with no buffer, condition, negotiation, or transition path.
- Keep summaries neutral, complete, and factual; include deadlines, conditions, transition periods, alternatives, purposes, and relevant responses when the Chinese brief contains them.
- Before output, self-check whether any headline may mislead headline-only readers, whether key limiting conditions were omitted, whether responses from all relevant parties are represented, and whether time markers such as "as of..." or "transition period until..." are accurate.
- Make headings and action recommendations read naturally in English.
- Output English only.

Chinese daily brief:
${baseReport.contentMarkdown || ""}`;
}

function buildFallbackEnglishDailyMarkdown(baseReport, events, reason = "") {
  const sectionEvents = (section) => events.filter((event) => event.section === section);
  const formatLine = (event) => {
    const link = event.representativeUrl ? ` ([source](${event.representativeUrl}))` : "";
    return `- ${event.country || "Unknown"} | ${event.category || "Uncategorized"}: ${event.title || "Untitled update"} - ${event.summary || ""}${link}`;
  };
  const todayNew = sectionEvents("today_new");
  const important = sectionEvents("important");
  const continuing = sectionEvents("continuing");
  const repeated = sectionEvents("repeated");

  return `# Immigration Daily Brief | ${baseReport.date}

> Reporting window: ${baseReport.windowLabel || baseReport.date}
${reason ? `\n> English generation fallback: ${reason}\n` : ""}
## 1. Executive Summary

${todayNew.length ? `This issue includes ${todayNew.length} confirmed new immigration-related update${todayNew.length === 1 ? "" : "s"}.` : "There are no confirmed major new immigration facts for this issue."}

## 2. New Today

${todayNew.length ? todayNew.map(formatLine).join("\n") : "- None."}

## 3. Important Changes

${important.length ? important.map(formatLine).join("\n") : "- No additional important changes."}

## 4. Continuing Watch

${continuing.length ? continuing.map(formatLine).join("\n") : "- None."}

## 5. Do Not Repackage

${repeated.length ? repeated.map(formatLine).join("\n") : "- None."}

## 6. Suggested Actions

- Sales: Use only confirmed new facts in client-facing updates.
- Copywriting: Keep continuing or repeated items as background follow-up, not headline news.
- Project managers: Check original sources before changing client plans or internal guidance.`;
}

async function getDailyReportLocalization(baseReport, language, { refresh = false } = {}) {
  const normalizedLanguage = normalizeDailyLanguage(language);
  if (normalizedLanguage === "zh") {
    return attachDailyWindowLabel(baseReport);
  }

  const baseRow = await loadDailyReportBaseRow(baseReport.date);
  if (!baseRow) return null;

  if (!refresh) {
    const cached = await loadDailyLocalization(baseRow.id, normalizedLanguage);
    if (cached?.contentMarkdown) {
      return mergeDailyLocalization(baseRow, cached);
    }
  }

  const events = await loadDailyLocalizationEvents(baseRow.id);
  const inputHash = getDailyLocalizationInputHash(baseRow, events, normalizedLanguage);

  const generationKey = `${baseRow.id}:${normalizedLanguage}:${inputHash}`;
  if (dailyLocalizationGenerationPromises.has(generationKey)) {
    const localization = await dailyLocalizationGenerationPromises.get(generationKey);
    return mergeDailyLocalization(baseRow, localization);
  }

  const generationPromise = (async () => {
    let markdown;
    let model = deepseekConfig.model;
    try {
      markdown = await callDeepSeek(buildEnglishDailyPrompt(baseRow, events), {
        systemPrompt: "You are an immigration policy daily brief editor. Use only the user's provided material. Do not invent policies, dates, fees, eligibility rules, impacts, or conclusions. Output polished professional English Markdown only.",
      });
    } catch (error) {
      const firstError = error instanceof Error ? error.message : String(error);
      try {
        markdown = await callDeepSeek(buildEnglishDailyTranslationPrompt(baseRow), {
          systemPrompt: "You are a professional English editor translating immigration industry briefings. Preserve facts and links exactly. Output English Markdown only.",
        });
        model = `${deepseekConfig.model}:translation-fallback`;
      } catch (translationError) {
        model = "fallback";
        markdown = buildFallbackEnglishDailyMarkdown(
          attachDailyWindowLabel(baseRow),
          events,
          translationError instanceof Error ? translationError.message : firstError,
        );
      }
    }

    markdown = sanitizeTextArtifacts(markdown);
    const title = extractMarkdownTitle(markdown, `Immigration Daily Brief (${baseRow.date})`);
    const localization = {
      language: normalizedLanguage,
      title,
      contentMarkdown: markdown,
      html: markdownToHtml(markdown),
      inputHash,
      model,
      generatedAt: formatShanghaiDateTimeISO(new Date()),
    };
    await saveDailyLocalization(baseRow.id, normalizedLanguage, localization);
    return localization;
  })();

  dailyLocalizationGenerationPromises.set(generationKey, generationPromise);
  let localization;
  try {
    localization = await generationPromise;
  } finally {
    dailyLocalizationGenerationPromises.delete(generationKey);
  }
  return mergeDailyLocalization(baseRow, localization);
}

async function prebuildDailyLocalizations(report) {
  try {
    await getDailyReportLocalization(report, "en", { refresh: true });
  } catch (error) {
    console.error("English daily report prebuild failed:", error instanceof Error ? error.message : String(error));
  }
}

async function getDailyReport(date = getShanghaiDate(), { refresh = false, windowMode = "calendar", language = "zh", prebuildLocalizations = true } = {}) {
  await initDb();

  const normalizedLanguage = normalizeDailyLanguage(language);
  if (normalizedLanguage !== "zh") {
    const baseReport = await getDailyReport(date, {
      refresh,
      windowMode,
      language: "zh",
      prebuildLocalizations: false,
    });
    return getDailyReportLocalization(baseReport, normalizedLanguage, { refresh });
  }

  if (!refresh) {
    const existing = await mysqlJson(`
      SELECT JSON_OBJECT(
        'date', DATE_FORMAT(report_date, '%Y-%m-%d'),
        'title', title,
        'contentMarkdown', content_markdown,
        'html', content_html,
        'sourceItemCount', source_item_count,
        'relevantItemCount', relevant_item_count,
        'eventCount', event_count,
        'model', model,
        'generatedAt', DATE_FORMAT(generated_at, '%Y-%m-%dT%H:%i:%s+08:00'),
        'windowMode', window_mode,
        'windowStart', IF(window_start_at IS NULL, NULL, DATE_FORMAT(window_start_at, '%Y-%m-%dT%H:%i:%s+08:00')),
        'windowEnd', IF(window_end_at IS NULL, NULL, DATE_FORMAT(window_end_at, '%Y-%m-%dT%H:%i:%s+08:00'))
      )
      FROM yimin_daily_reports
      WHERE report_date = ${sqlString(date)}
      LIMIT 1;
    `);

    if (existing && existing.model !== "fallback") {
      if (existing.contentMarkdown) {
        existing.contentMarkdown = sanitizeTextArtifacts(existing.contentMarkdown);
        existing.html = markdownToHtml(existing.contentMarkdown);
      }
      startHTopicGenerationInBackground(date);
      return attachDailyWindowLabel({ ...existing, language: "zh" });
    }
  }

  const dailyContext = await buildDailyContext(date, { windowMode });
  const selectedItems = getDailyContextItems(dailyContext);
  const relevantItemCount = dailyContext.relevantItems.length;
  const eventCount = dailyContext.events.length;

  const generated = await generateDailyMarkdown(date, dailyContext);
  let markdown = generated.markdown;
  let model = generated.model;
  markdown = sanitizeTextArtifacts(markdown);

  const title = dailyContext.window.mode === "last24h" ? `移民热点早报（${date}）` : `移民热点日报（${date}）`;
  const html = markdownToHtml(markdown);

  await mysqlExec(`
    INSERT INTO yimin_daily_reports (
      report_date, window_start_at, window_end_at, window_mode,
      title, content_markdown, content_html, source_item_count,
      relevant_item_count, event_count, model, generated_at
    )
    VALUES (
      ${sqlString(date)},
      ${sqlDate(dailyContext.window.start)},
      ${sqlDate(dailyContext.window.end)},
      ${sqlString(dailyContext.window.mode)},
      ${sqlString(title)},
      ${sqlString(markdown)},
      ${sqlString(html)},
      ${sqlNumber(selectedItems.length)},
      ${sqlNumber(relevantItemCount)},
      ${sqlNumber(eventCount)},
      ${sqlString(model)},
      CURRENT_TIMESTAMP
    )
    ON DUPLICATE KEY UPDATE
      window_start_at = VALUES(window_start_at),
      window_end_at = VALUES(window_end_at),
      window_mode = VALUES(window_mode),
      title = VALUES(title),
      content_markdown = VALUES(content_markdown),
      content_html = VALUES(content_html),
      source_item_count = VALUES(source_item_count),
      relevant_item_count = VALUES(relevant_item_count),
      event_count = VALUES(event_count),
      model = VALUES(model),
      generated_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP;
  `);
  await saveDailyReportItems(date, dailyContext);

  const report = attachDailyWindowLabel({
    date,
    title,
    contentMarkdown: markdown,
    html,
    sourceItemCount: selectedItems.length,
    relevantItemCount,
    eventCount,
    model,
    windowMode: dailyContext.window.mode,
    windowStart: formatShanghaiDateTimeISO(dailyContext.window.start),
    windowEnd: formatShanghaiDateTimeISO(dailyContext.window.end),
    generatedAt: formatShanghaiDateTimeISO(new Date()),
    language: "zh",
  });
  if (prebuildLocalizations) {
    await prebuildDailyLocalizations(report);
  }
  startHTopicGenerationInBackground(date, { refresh });
  return report;
}

async function readCachedDailyReport(date, { language = "zh" } = {}) {
  await initDb();

  const normalizedLanguage = normalizeDailyLanguage(language);
  const baseRow = await loadDailyReportBaseRow(date);
  if (!baseRow || baseRow.model === "fallback") {
    return null;
  }

  if (baseRow.contentMarkdown) {
    baseRow.contentMarkdown = sanitizeTextArtifacts(baseRow.contentMarkdown);
    baseRow.html = markdownToHtml(baseRow.contentMarkdown);
  }

  const baseReport = attachDailyWindowLabel({ ...baseRow, language: "zh" });
  if (normalizedLanguage === "zh") {
    return baseReport;
  }

  const cached = await loadDailyLocalization(baseRow.id, normalizedLanguage);
  if (!cached?.contentMarkdown || cached.model === "fallback") {
    return null;
  }
  return mergeDailyLocalization(baseRow, cached);
}

function startDailyReportInBackground(date, { refresh = false, windowMode = "calendar", language = "zh" } = {}) {
  const normalizedLanguage = normalizeDailyLanguage(language);
  const generationKey = `${date}:${normalizeDailyWindowMode(windowMode)}:${normalizedLanguage}:${refresh ? "refresh" : "cached"}`;
  if (dailyReportGenerationPromises.has(generationKey)) {
    return dailyReportGenerationPromises.get(generationKey);
  }

  const generationPromise = getDailyReport(date, {
    refresh,
    windowMode,
    language: normalizedLanguage,
    prebuildLocalizations: normalizedLanguage === "zh",
  })
    .catch((error) => {
      console.error(
        `Daily report generation failed for ${date}:`,
        error instanceof Error ? error.message : String(error),
      );
      return {
        ok: false,
        date,
        error: error instanceof Error ? error.message : String(error),
      };
    })
    .finally(() => {
      dailyReportGenerationPromises.delete(generationKey);
    });

  dailyReportGenerationPromises.set(generationKey, generationPromise);
  return generationPromise;
}

function isDailyReportGenerationRunning(date, { windowMode = "calendar", language = "zh" } = {}) {
  const normalizedLanguage = normalizeDailyLanguage(language);
  const normalizedWindowMode = normalizeDailyWindowMode(windowMode);
  return ["refresh", "cached"].some((mode) => (
    dailyReportGenerationPromises.has(`${date}:${normalizedWindowMode}:${normalizedLanguage}:${mode}`)
  ));
}

let hContentProfileCache = null;
const hTopicGenerationPromises = new Map();
const hArticlePreGenerationPromises = new Map();
const hArticlePreGenerationResults = new Map();
const hAutomationActor = Object.freeze({
  id: "automation:h-column",
  name: "H 专栏定时任务",
  source: "automation",
  role: "system",
  confirmationType: "unconfirmed",
});

async function saveHAuditLog(entityType, entityId, action, actor, metadata = {}) {
  const normalizedActor = actor || {
    id: "system",
    name: "system",
    role: "system",
  };
  await mysqlExec(`
    INSERT INTO yimin_h_audit_logs (
      entity_type, entity_id, action, actor_id, actor_name, actor_role, metadata_json
    )
    VALUES (
      ${sqlString(entityType)}, ${sqlString(entityId ?? "")}, ${sqlString(action)},
      ${sqlString(normalizedActor.id || "system")}, ${sqlString(normalizedActor.name || "")},
      ${sqlString(normalizedActor.role || normalizedActor.source || "")}, ${sqlJson(metadata || {})}
    );
  `);
}

async function listHAuditLogs(limit = 100) {
  const safeLimit = Math.min(300, Math.max(1, Number(limit) || 100));
  return (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
      'id', id,
      'entityType', entity_type,
      'entityId', entity_id,
      'action', action,
      'actorId', actor_id,
      'actorName', actor_name,
      'actorRole', actor_role,
      'metadata', metadata_json,
      'createdAt', DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s+08:00')
    )), JSON_ARRAY())
    FROM (
      SELECT *
      FROM yimin_h_audit_logs
      ORDER BY id DESC
      LIMIT ${sqlNumber(safeLimit)}
    ) audit_rows;
  `)) || [];
}

function normalizeHIdentityValue(value) {
  return String(value || "").trim().toLowerCase();
}

function hIdentityMatches(value, configuredValues) {
  const normalized = normalizeHIdentityValue(value);
  if (!normalized) return false;
  const identityTokens = normalized
    .split(/[\s,，/|()（）【】[\]_-]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  return [...configuredValues].some((candidate) => (
    normalized === candidate
    || identityTokens.includes(candidate)
  ));
}

function hDepartmentMatches(value) {
  const normalized = normalizeHIdentityValue(value);
  if (!normalized) return false;
  return [...hColumnConfig.departmentNames].some((candidate) => (
    normalized === candidate
    || normalized.startsWith(candidate)
  ));
}

async function listHActorDepartments(identity) {
  if (!identity?.userId) return [];
  await initDb();
  let departmentIds;
  if (identity.source === "local-test") {
    departmentIds = await resolveLocalTestDepartmentIds(identity.departmentIds);
  } else {
    const user = await mysqlJson(`
      SELECT JSON_OBJECT(
        'departmentIds', COALESCE(departments_json, JSON_ARRAY())
      )
      FROM yimin_wx_users
      WHERE userid = ${sqlString(identity.userId)}
      LIMIT 1;
    `);
    departmentIds = normalizeDepartmentIds(user?.departmentIds);
  }
  const normalizedIds = normalizeDepartmentIds(departmentIds);
  if (!normalizedIds.length) return [];
  return (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT('id', department_id, 'name', department_name)
    ), JSON_ARRAY())
    FROM yimin_wx_departments
    WHERE department_id IN (${normalizedIds.map(sqlNumber).join(",")});
  `)) || [];
}

async function getHColumnActor(req) {
  if (!hColumnConfig.enabled) return null;

  const identity = getSsoIdentityFromRequest(req);
  const adminSession = requireAuth(req);
  const userId = String(identity?.userId || "").trim();
  const userName = String(identity?.userName || "").trim();
  const hasNamedAccess = Boolean(identity) && (
    hColumnConfig.ownerUserIds.has(userId)
    || hIdentityMatches(userName, hColumnConfig.ownerNames)
    || hColumnConfig.editorUserIds.has(userId)
    || hIdentityMatches(userName, hColumnConfig.editorNames)
  );
  let hasDepartmentAccess = false;
  if (identity && !hasNamedAccess) {
    try {
      const departments = await listHActorDepartments(identity);
      hasDepartmentAccess = departments.some((department) => hDepartmentMatches(department.name));
    } catch (error) {
      console.warn(`H department access lookup failed for ${userId}:`, formatErrorMessage(error));
    }
  }

  if (identity && (hasNamedAccess || hasDepartmentAccess)) {
    return {
      id: userId,
      name: userName || userId,
      source: identity.source,
      role: "member",
      confirmationType: "authorized_editor",
    };
  }

  if (adminSession) {
    return {
      id: `admin:${adminSession.username}`,
      name: adminSession.username,
      source: "admin-session",
      role: "member",
      confirmationType: "authorized_editor",
    };
  }

  return null;
}

async function loadHContentProfile() {
  if (hContentProfileCache) return hContentProfileCache;
  const raw = await readFile(join(rootDir, "data", "henry-content-profile.json"), "utf8");
  const parsed = JSON.parse(raw);
  hContentProfileCache = {
    ...parsed,
    skillVersion: parsed.skillVersion || hColumnConfig.skillVersion,
    profileVersion: parsed.profileVersion || hColumnConfig.profileVersion,
  };
  return hContentProfileCache;
}

function parseDeepSeekJsonObject(content) {
  const text = String(content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("AI output did not return a JSON object");
  }
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AI output JSON is not an object");
  }
  return parsed;
}

function inferHSourceLevel(sourceName, url) {
  const text = `${sourceName || ""} ${url || ""}`.toLowerCase();
  if (
    /\.(gov|gc\.ca)(?:\/|$)/i.test(text)
    || /gov\.uk|europa\.eu|uscis|ircc|政府|移民局|议会|法院|官方公报|department of|home office/i.test(text)
  ) {
    return "A";
  }
  if (/reuters|associated press|bbc|financial times|权威媒体/i.test(text)) {
    return "B";
  }
  if (/twitter|x\.com|weibo|reddit|传闻|朋友圈/i.test(text)) {
    return "D";
  }
  return "C";
}

function inferHPolicyStatus(title, summary, category) {
  const text = `${title || ""} ${summary || ""} ${category || ""}`.toLowerCase();
  if (/拟议|提议|草案|proposal|proposed|consultation/i.test(text)) return "proposed";
  if (/待生效|将于.+生效|announced|takes effect|effective from/i.test(text)) return "announced";
  if (/审议|表决|诉讼中|pending|under review|in progress/i.test(text)) return "pending";
  if (/媒体|报道称|据报道|分析|观点|评论|reportedly|analysis|opinion/i.test(text)) return "media_report";
  if (/已生效|正式实施|生效|effective|in force|implemented/i.test(text)) return "effective";
  if (/政策|签证|居留|永居|入籍|税务|投资|移民|visa|residence|citizenship|immigration/i.test(text)) {
    return "media_report";
  }
  return "not_applicable";
}

function isHHighRiskTopic(topic) {
  const text = `${topic?.title || ""} ${topic?.eventSummary || topic?.event_summary || ""} ${topic?.contentArchetype || topic?.content_archetype || ""}`;
  return /政策|签证|居留|永居|入籍|税|投资|费用|资格|排期|法律|visa|residence|citizenship|tax|investment|legal/i.test(text);
}

function findHStableJudgment(profile, text) {
  const normalized = String(text || "").toLowerCase();
  return (profile.stableJudgments || []).find((item) => (
    (item.keywords || []).some((keyword) => {
      const normalizedKeyword = String(keyword || "").toLowerCase();
      if (!normalizedKeyword) return false;
      if (/^[a-z0-9 .+-]+$/i.test(normalizedKeyword)) {
        const escaped = normalizedKeyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`\\b${escaped}\\b`, "i").test(normalized);
      }
      return normalized.includes(normalizedKeyword);
    })
  )) || null;
}

function buildHTitleBigrams(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
  if (normalized.length < 2) return normalized ? [normalized] : [];
  return Array.from({ length: normalized.length - 1 }, (_, index) => normalized.slice(index, index + 2));
}

function getHTitleSimilarity(left, right) {
  const leftSet = new Set(buildHTitleBigrams(left));
  const rightSet = new Set(buildHTitleBigrams(right));
  if (!leftSet.size || !rightSet.size) return 0;
  let overlap = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) overlap += 1;
  }
  return (2 * overlap) / (leftSet.size + rightSet.size);
}

function buildHDuplicateRisk(event, candidate, recentTopics) {
  if (!recentTopics.length) {
    return { level: "unknown", reason: "系统上线后开始积累近30天历史" };
  }
  const exactEvent = recentTopics.find((topic) => topic.eventKey === event.eventKey);
  if (exactEvent) {
    return {
      level: "high",
      reason: `近30天已有同一事件候选：${exactEvent.title}`,
      relatedTopic: exactEvent,
    };
  }
  const title = candidate.title || event.title;
  const matches = recentTopics
    .map((topic) => ({ topic, similarity: getHTitleSimilarity(title, topic.title) }))
    .sort((left, right) => right.similarity - left.similarity);
  const best = matches[0];
  if (best?.similarity >= 0.62) {
    return {
      level: "high",
      reason: `与 ${best.topic.date} 的候选主题高度相似`,
      similarity: Number(best.similarity.toFixed(3)),
      relatedTopic: best.topic,
    };
  }
  if (best?.similarity >= 0.38) {
    return {
      level: "medium",
      reason: `与 ${best.topic.date} 的候选存在主题重叠`,
      similarity: Number(best.similarity.toFixed(3)),
      relatedTopic: best.topic,
    };
  }
  return { level: "low", reason: "近30天未发现明显重复主题" };
}

function normalizeHMode(value, fallback = "wechat_article") {
  const allowed = new Set(["outline", "wechat_article", "short_video", "run_and_talk_video", "deep_video"]);
  const mode = String(value || "");
  return allowed.has(mode) ? mode : fallback;
}

function normalizeHReadiness(value, fallback = "topic_only") {
  const allowed = new Set(["not_recommended", "topic_only", "outline_ready", "needs_viewpoint", "needs_evidence", "draft_ready"]);
  const readiness = String(value || "");
  return allowed.has(readiness) ? readiness : fallback;
}

function normalizeHTopicStatus(value, fallback = "candidate") {
  const allowed = new Set(["candidate", "selected", "later", "rejected", "archived"]);
  const status = String(value || "");
  return allowed.has(status) ? status : fallback;
}

function buildFallbackHTopicCandidates(events, profile) {
  return events
    .filter((event) => (
      ["today_new", "important"].includes(event.section)
      && /移民|签证|居留|永居|永久居民|入籍|国籍|边境|工签|工作许可|雇主担保|庇护|难民|遣返|领事|visa|immigra|residen|citizen|border|work permit|sponsor|asylum|refugee|deport|consular/i.test(
        `${event.title || ""} ${event.summary || ""}`,
      )
    ))
    .slice(0, hColumnConfig.maxTopics)
    .map((event) => {
      const stableJudgment = findHStableJudgment(profile, `${event.title} ${event.summary}`);
      const hasJudgment = Boolean(stableJudgment);
      const hasBasis = false;
      const useful = Number(event.importance || 0) >= 55;
      const longTerm = Boolean(stableJudgment) || /政策|风险|选择|合规|专业|投资/i.test(`${event.title} ${event.summary}`);
      const passedCount = [hasJudgment, hasBasis, useful, longTerm].filter(Boolean).length;
      return {
        eventKey: event.eventKey,
        title: event.title,
        coreQuestion: `这件事对哪些客户真正有影响，Henry 会如何排序风险和行动？`,
        suggestedAngle: stableJudgment?.summary || "先说明适用对象和政策状态，再解释客户应如何判断，而不是复述新闻。",
        targetAudience: "正在进行身份、签证或跨境规划的中文读者",
        contentArchetype: "policy_explanation",
        primaryMode: "wechat_article",
        reusableMode: "short_video",
        fourChecks: {
          hasJudgment,
          hasBasis,
          useful,
          longTerm,
          passedCount,
        },
        readiness: passedCount <= 1 ? "not_recommended" : (hasJudgment ? "needs_evidence" : "topic_only"),
        missingItems: [
          ...(!hasBasis ? ["需要完整原文及核心政策的 A 级来源"] : []),
          ...(!hasJudgment ? ["需要 H 专栏成员确认本次核心观点"] : []),
        ],
        stableJudgment,
      };
    });
}

function buildHTopicGenerationPrompt(report, events, recentTopics, profile) {
  const eventPayload = events
    .filter((event) => event.section !== "repeated")
    .slice(0, 18)
    .map((event) => ({
      eventKey: event.eventKey,
      section: event.section,
      title: event.title,
      summary: event.summary,
      country: event.country,
      category: event.category,
      importance: event.importance,
      articleCount: event.articleCount,
      sourceCount: event.sourceCount,
    }));
  const stableJudgments = (profile.stableJudgments || []).map((item) => ({
    key: item.key,
    keywords: item.keywords,
    summary: item.summary,
  }));

  return `请为 Henry 内容工作台从以下公共日报事件中选择 0—${hColumnConfig.maxTopics} 个真正值得判断的候选题。

只返回 JSON 数组，不要 Markdown，不要解释。数组元素格式：
{
  "eventKey":"必须来自输入",
  "title":"候选标题",
  "coreQuestion":"Henry真正需要回答的问题",
  "suggestedAngle":"系统建议角度，不能冒充Henry本人观点",
  "targetAudience":"明确读者",
  "contentArchetype":"policy_explanation|country_city|ceo_management|experience_reflection|viewpoint_response|recommendation_list",
  "primaryMode":"wechat_article|short_video|run_and_talk_video|deep_video",
  "reusableMode":"wechat_article|short_video|run_and_talk_video|deep_video",
  "fourChecks":{"hasJudgment":false,"hasBasis":false,"useful":true,"longTerm":true},
  "readiness":"not_recommended|topic_only|outline_ready|needs_viewpoint|needs_evidence|draft_ready",
  "missingItems":["事实或判断缺口"],
  "stableJudgmentKey":"仅当与已确认稳定观点直接匹配时填写，否则为空"
}

硬规则：
- 稀缺的是 Henry 的真实判断，不是文章数量；允许返回空数组。
- 只选择 today_new 或 important。continuing 只有出现可明确说明的实质变化时才可选择。
- 日报标题和摘要只能证明“值得研究”，不能自动视为完整原文，因此默认 hasBasis=false。
- 系统建议角度不等于 Henry 已确认观点。
- 只有与已确认稳定观点直接匹配，hasJudgment 才可为 true。
- 不虚构 Henry 的经历、观点、客户、数字或公司事实。
- 不选择招聘、普通执法个案、旅游、娱乐或与客户决策无关的资讯。
- 一篇只保留一个主轴，必须说明对谁有用以及风险或代价。
- 与近30天主题重复且无新增事实的内容不要选择。

人物稳定观点：
${JSON.stringify(stableJudgments)}

近30天已存在候选：
${JSON.stringify(recentTopics)}

日报：
${JSON.stringify({ date: report.date, title: report.title, events: eventPayload })}`;
}

async function listRecentHTopicTitles(date, days = 30) {
  return (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
      'date', DATE_FORMAT(topic_date, '%Y-%m-%d'),
      'eventKey', event_key,
      'title', title,
      'status', status
    )), JSON_ARRAY())
    FROM (
      SELECT topic_date, event_key, title, status
      FROM yimin_h_topics
      WHERE topic_date < ${sqlString(date)}
        AND topic_date >= DATE_SUB(${sqlString(date)}, INTERVAL ${sqlNumber(days, 30)} DAY)
      ORDER BY topic_date DESC, id DESC
      LIMIT 120
    ) recent_topics;
  `)) || [];
}

async function seedHTopicSources(topicId, event) {
  const hashes = Array.isArray(event.articleHashes) ? event.articleHashes.filter(Boolean) : [];
  if (!hashes.length) {
    if (!event.representativeUrl) return;
    const existing = await mysqlJson(`
      SELECT JSON_OBJECT('id', id)
      FROM yimin_h_topic_sources
      WHERE topic_id = ${sqlNumber(topicId)}
        AND url = ${sqlString(event.representativeUrl)}
        AND deleted_at IS NULL
      LIMIT 1;
    `);
    if (existing) return;
    const sourceLevel = inferHSourceLevel("", event.representativeUrl);
    const policyStatus = inferHPolicyStatus(event.title, event.summary, event.category);
    await mysqlExec(`
      INSERT INTO yimin_h_topic_sources (
        topic_id, article_hash, source_name, url, title, content_status,
        source_level, policy_status, extracted_text, evidence_summary,
        is_primary, content_hash
      )
      VALUES (
        ${sqlNumber(topicId)}, NULL, '', ${sqlString(event.representativeUrl)},
        ${sqlString(event.title)}, 'summary_only', ${sqlString(sourceLevel)},
        ${sqlString(policyStatus)}, ${sqlString(event.summary || "")},
        ${sqlString(event.summary || "")}, 1,
        ${sqlString(createHash("sha256").update(String(event.summary || "")).digest("hex"))}
      );
    `);
    return;
  }

  const rows = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
      'articleHash', a.dedupe_hash,
      'title', a.title,
      'summary', COALESCE(a.summary, ''),
      'url', a.url,
      'publishedAt', IF(a.published_at IS NULL, NULL, DATE_FORMAT(a.published_at, '%Y-%m-%dT%H:%i:%s+08:00')),
      'sourceName', s.name,
      'category', a.category
    )), JSON_ARRAY())
    FROM yimin_articles a
    JOIN yimin_sources s ON s.id = a.source_id
    WHERE a.dedupe_hash IN (${hashes.map(sqlString).join(",")});
  `)) || [];

  for (const [index, row] of rows.entries()) {
    const sourceLevel = inferHSourceLevel(row.sourceName, row.url);
    const policyStatus = inferHPolicyStatus(row.title, row.summary, row.category);
    const extractedText = String(row.summary || "");
    await mysqlExec(`
      INSERT INTO yimin_h_topic_sources (
        topic_id, article_hash, source_name, url, title, published_at,
        content_status, source_level, policy_status, extracted_text,
        evidence_summary, is_primary, content_hash
      )
      VALUES (
        ${sqlNumber(topicId)}, ${sqlString(row.articleHash)}, ${sqlString(row.sourceName)},
        ${sqlString(row.url || "")}, ${sqlString(row.title)}, ${sqlDate(row.publishedAt)},
        ${sqlString(extractedText ? "summary_only" : "missing")}, ${sqlString(sourceLevel)},
        ${sqlString(policyStatus)}, ${sqlString(extractedText)}, ${sqlString(extractedText)},
        ${sqlNumber(index === 0 || row.url === event.representativeUrl ? 1 : 0)},
        ${sqlString(createHash("sha256").update(extractedText).digest("hex"))}
      )
      ON DUPLICATE KEY UPDATE
        source_name = VALUES(source_name),
        url = VALUES(url),
        title = VALUES(title),
        published_at = VALUES(published_at),
        updated_at = CURRENT_TIMESTAMP;
    `);
  }
}

async function insertHTopicCandidate(date, report, event, candidate, profile, inputHash, recentTopics = []) {
  const stableJudgment = candidate.stableJudgment
    || (candidate.stableJudgmentKey
      ? (profile.stableJudgments || []).find((item) => item.key === candidate.stableJudgmentKey)
      : findHStableJudgment(profile, `${event.title} ${event.summary}`));
  const checks = {
    hasJudgment: Boolean(stableJudgment || candidate.fourChecks?.hasJudgment),
    hasBasis: false,
    useful: Boolean(candidate.fourChecks?.useful),
    longTerm: Boolean(candidate.fourChecks?.longTerm),
  };
  checks.passedCount = Object.values(checks).filter((value) => value === true).length;
  const readiness = checks.passedCount <= 1
    ? "not_recommended"
    : normalizeHReadiness(candidate.readiness, checks.hasJudgment ? "needs_evidence" : "topic_only");
  const missingItems = Array.isArray(candidate.missingItems) ? candidate.missingItems : [];
  if (!checks.hasBasis && !missingItems.some((item) => /来源|原文|证据/.test(item))) {
    missingItems.push("需要完整原文及核心政策的 A 级来源");
  }
  if (!checks.hasJudgment && !missingItems.some((item) => /判断|观点/.test(item))) {
    missingItems.push("需要 H 专栏成员确认本次核心观点");
  }
  const duplicateRisk = buildHDuplicateRisk(event, candidate, recentTopics);

  await mysqlExec(`
    INSERT INTO yimin_h_topics (
      topic_date, source_report_id, event_key, title, event_summary,
      core_question, suggested_angle, target_audience, content_archetype,
      primary_mode, reusable_mode, four_checks_json, readiness, status,
      duplicate_risk_json, source_snapshot_json, missing_items_json,
      input_hash, rule_version, skill_version, profile_version
    )
    VALUES (
      ${sqlString(date)}, ${sqlNumber(report.id)}, ${sqlString(event.eventKey)},
      ${sqlString(candidate.title || event.title)}, ${sqlString(event.summary || "")},
      ${sqlString(candidate.coreQuestion || "")}, ${sqlString(candidate.suggestedAngle || stableJudgment?.summary || "")},
      ${sqlString(candidate.targetAudience || "关心身份与全球化选择的中文读者")},
      ${sqlString(candidate.contentArchetype || "policy_explanation")},
      ${sqlString(normalizeHMode(candidate.primaryMode))},
      ${sqlString(normalizeHMode(candidate.reusableMode, "short_video"))},
      ${sqlJson(checks)}, ${sqlString(readiness)}, 'candidate',
      ${sqlJson(duplicateRisk)},
      ${sqlJson(event)}, ${sqlJson(missingItems)}, ${sqlString(inputHash)},
      'h-topic-v1', ${sqlString(profile.skillVersion)}, ${sqlString(profile.profileVersion)}
    )
    ON DUPLICATE KEY UPDATE
      title = VALUES(title),
      event_summary = VALUES(event_summary),
      core_question = VALUES(core_question),
      suggested_angle = VALUES(suggested_angle),
      target_audience = VALUES(target_audience),
      content_archetype = VALUES(content_archetype),
      primary_mode = VALUES(primary_mode),
      reusable_mode = VALUES(reusable_mode),
      four_checks_json = IF(status IN ('selected','later','rejected'), four_checks_json, VALUES(four_checks_json)),
      readiness = IF(status IN ('selected','later','rejected'), readiness, VALUES(readiness)),
      status = IF(status = 'archived', 'candidate', status),
      duplicate_risk_json = VALUES(duplicate_risk_json),
      source_snapshot_json = VALUES(source_snapshot_json),
      missing_items_json = IF(status IN ('selected','later','rejected'), missing_items_json, VALUES(missing_items_json)),
      input_hash = VALUES(input_hash),
      rule_version = VALUES(rule_version),
      skill_version = VALUES(skill_version),
      profile_version = VALUES(profile_version),
      updated_at = CURRENT_TIMESTAMP;
  `);
  const row = await mysqlJson(`
    SELECT JSON_OBJECT('id', id)
    FROM yimin_h_topics
    WHERE topic_date = ${sqlString(date)}
      AND event_key = ${sqlString(event.eventKey)}
    LIMIT 1;
  `);
  if (!row?.id) return null;
  await seedHTopicSources(row.id, event);
  if (stableJudgment) {
    const existingViewpoint = await mysqlJson(`
      SELECT JSON_OBJECT('id', id)
      FROM yimin_h_viewpoints
      WHERE topic_id = ${sqlNumber(row.id)}
        AND input_type = 'profile'
      LIMIT 1;
    `);
    if (!existingViewpoint) {
      await mysqlExec(`
        INSERT INTO yimin_h_viewpoints (
          topic_id, input_type, raw_text, edited_text, is_confirmed,
          confirmation_type, confirmed_by, confirmed_at, created_by
        )
        VALUES (
          ${sqlNumber(row.id)}, 'profile', ${sqlString(stableJudgment.summary)},
          ${sqlString(stableJudgment.summary)}, 1, 'profile',
          ${sqlString(`profile:${stableJudgment.key}`)}, CURRENT_TIMESTAMP,
          ${sqlString(`profile:${stableJudgment.key}`)}
        );
      `);
    }
  }
  return row.id;
}

async function generateHTopics(date = getShanghaiDate(), { refresh = false, actor = null } = {}) {
  await initDb();
  const report = await loadDailyReportBaseRow(date);
  if (!report) {
    const error = new Error("请先生成当天公共日报");
    error.code = "H_DAILY_MISSING";
    throw error;
  }
  const events = await loadDailyLocalizationEvents(report.id);
  const eligibleEvents = events.filter((event) => ["today_new", "important", "continuing"].includes(event.section));
  const profile = await loadHContentProfile();
  const recentTopics = await listRecentHTopicTitles(date);
  const inputHash = createHash("sha256").update(JSON.stringify({
    date,
    reportId: report.id,
    generatedAt: report.generatedAt,
    events: eligibleEvents,
    recentTopics,
    skillVersion: profile.skillVersion,
    profileVersion: profile.profileVersion,
  })).digest("hex");

  if (!refresh) {
    const existing = await mysqlJson(`
      SELECT JSON_OBJECT('count', COUNT(*), 'inputHash', MAX(input_hash))
      FROM yimin_h_topics
      WHERE topic_date = ${sqlString(date)};
    `);
    if (Number(existing?.count || 0) > 0 && existing.inputHash === inputHash) {
      return listHTopics(date);
    }
  }

  let candidates = [];
  if (eligibleEvents.length) {
    try {
      const content = await callDeepSeek(
        buildHTopicGenerationPrompt(report, eligibleEvents, recentTopics, profile),
        {
          model: hColumnConfig.model,
          temperature: 0.2,
          systemPrompt: "你是 Henry 内容工作台的选题编辑。你只做选题判断，不替 Henry 发明观点、经历、客户、数字或公司事实。日报摘要不是完整原文。只返回严格 JSON。",
        },
      );
      candidates = parseDeepSeekJsonArray(content);
    } catch (error) {
      console.error("H topic generation fallback:", formatErrorMessage(error));
      candidates = buildFallbackHTopicCandidates(eligibleEvents, profile);
    }
  }

  const eventByKey = new Map(eligibleEvents.map((event) => [event.eventKey, event]));
  const accepted = [];
  const usedKeys = new Set();
  for (const candidate of candidates) {
    const eventKey = String(candidate?.eventKey || "");
    const event = eventByKey.get(eventKey);
    if (!event || usedKeys.has(eventKey) || accepted.length >= hColumnConfig.maxTopics) continue;
    if (!["today_new", "important"].includes(event.section) && event.section !== "continuing") continue;
    usedKeys.add(eventKey);
    accepted.push({ event, candidate });
  }

  await mysqlExec(`
    UPDATE yimin_h_topics
    SET status = 'archived',
        updated_at = CURRENT_TIMESTAMP
    WHERE topic_date = ${sqlString(date)}
      AND status = 'candidate';
  `);
  for (const { event, candidate } of accepted) {
    await insertHTopicCandidate(date, report, event, candidate, profile, inputHash, recentTopics);
  }
  await saveHAuditLog("topic_date", date, "topics.generate", actor, {
    refresh,
    acceptedCount: accepted.length,
    sourceReportId: report.id,
    inputHash,
  });
  return listHTopics(date);
}

function startHTopicGenerationInBackground(date, { refresh = false } = {}) {
  if (!hColumnConfig.enabled || !hColumnConfig.autoGenerate) return null;
  const key = `${date}:${refresh ? "refresh" : "cached"}`;
  if (hTopicGenerationPromises.has(key)) return hTopicGenerationPromises.get(key);
  const promise = generateHTopics(date, { refresh })
    .catch((error) => {
      console.error(`H topic generation failed for ${date}:`, formatErrorMessage(error));
      return null;
    })
    .finally(() => hTopicGenerationPromises.delete(key));
  hTopicGenerationPromises.set(key, promise);
  return promise;
}

function isHTopicGenerationRunning(date) {
  return ["refresh", "cached"].some((mode) => hTopicGenerationPromises.has(`${date}:${mode}`));
}

async function listHTopics(date = getShanghaiDate()) {
  await initDb();
  const topics = sanitizeStructuredTextArtifacts((await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(topic_json), JSON_ARRAY())
    FROM (
      SELECT JSON_OBJECT(
        'id', t.id,
        'date', DATE_FORMAT(t.topic_date, '%Y-%m-%d'),
        'eventKey', t.event_key,
        'title', t.title,
        'eventSummary', COALESCE(t.event_summary, ''),
        'coreQuestion', COALESCE(t.core_question, ''),
        'suggestedAngle', COALESCE(t.suggested_angle, ''),
        'targetAudience', COALESCE(t.target_audience, ''),
        'contentArchetype', t.content_archetype,
        'primaryMode', t.primary_mode,
        'reusableMode', t.reusable_mode,
        'fourChecks', t.four_checks_json,
        'readiness', t.readiness,
        'status', t.status,
        'duplicateRisk', t.duplicate_risk_json,
        'missingItems', t.missing_items_json,
        'sourceCount', (
          SELECT COUNT(*) FROM yimin_h_topic_sources s
          WHERE s.topic_id = t.id AND s.deleted_at IS NULL
        ),
        'fullSourceCount', (
          SELECT COUNT(*) FROM yimin_h_topic_sources s
          WHERE s.topic_id = t.id AND s.deleted_at IS NULL AND s.content_status = 'full'
        ),
        'aLevelSourceCount', (
          SELECT COUNT(*) FROM yimin_h_topic_sources s
          WHERE s.topic_id = t.id AND s.deleted_at IS NULL AND s.source_level = 'A'
        ),
        'confirmedViewpointCount', (
          SELECT COUNT(*) FROM yimin_h_viewpoints v
          WHERE v.topic_id = t.id AND v.deleted_at IS NULL AND v.is_confirmed = 1
        ),
        'draftCount', (
          SELECT COUNT(*) FROM yimin_h_drafts d
          WHERE d.topic_id = t.id AND d.status <> 'failed'
        ),
        'readyForHenryDraftCount', (
          SELECT COUNT(*) FROM yimin_h_drafts d
          WHERE d.topic_id = t.id AND d.status = 'ready_for_henry'
        ),
        'updatedAt', DATE_FORMAT(t.updated_at, '%Y-%m-%dT%H:%i:%s+08:00')
      ) AS topic_json
      FROM yimin_h_topics t
      WHERE t.topic_date = ${sqlString(date)}
        AND t.status <> 'archived'
      ORDER BY FIELD(t.status, 'selected', 'candidate', 'later', 'rejected', 'archived'),
               FIELD(t.readiness, 'draft_ready', 'needs_viewpoint', 'needs_evidence', 'outline_ready', 'topic_only', 'not_recommended'),
               t.id ASC
    ) topics;
  `)) || []);
  const statusRank = { selected: 0, candidate: 1, later: 2, rejected: 3, archived: 4 };
  const readinessRank = {
    draft_ready: 0,
    needs_viewpoint: 1,
    needs_evidence: 2,
    outline_ready: 3,
    topic_only: 4,
    not_recommended: 5,
  };
  return topics.sort((left, right) => (
    (statusRank[left.status] ?? 99) - (statusRank[right.status] ?? 99)
    || (readinessRank[left.readiness] ?? 99) - (readinessRank[right.readiness] ?? 99)
    || Number(left.id) - Number(right.id)
  ));
}

async function getHTopicBase(topicId) {
  return sanitizeStructuredTextArtifacts(await mysqlJson(`
    SELECT JSON_OBJECT(
      'id', id,
      'date', DATE_FORMAT(topic_date, '%Y-%m-%d'),
      'sourceReportId', source_report_id,
      'eventKey', event_key,
      'title', title,
      'eventSummary', COALESCE(event_summary, ''),
      'coreQuestion', COALESCE(core_question, ''),
      'suggestedAngle', COALESCE(suggested_angle, ''),
      'targetAudience', COALESCE(target_audience, ''),
      'contentArchetype', content_archetype,
      'primaryMode', primary_mode,
      'reusableMode', reusable_mode,
      'fourChecks', four_checks_json,
      'readiness', readiness,
      'status', status,
      'duplicateRisk', duplicate_risk_json,
      'sourceSnapshot', source_snapshot_json,
      'missingItems', missing_items_json,
      'skillVersion', skill_version,
      'profileVersion', profile_version,
      'selectedBy', selected_by,
      'selectedAt', IF(selected_at IS NULL, NULL, DATE_FORMAT(selected_at, '%Y-%m-%dT%H:%i:%s+08:00')),
      'createdAt', DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s+08:00'),
      'updatedAt', DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s+08:00')
    )
    FROM yimin_h_topics
    WHERE id = ${sqlNumber(topicId)}
    LIMIT 1;
  `));
}

async function listHTopicSources(topicId) {
  return sanitizeStructuredTextArtifacts((await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
      'id', id,
      'articleHash', article_hash,
      'sourceName', source_name,
      'url', url,
      'title', title,
      'publishedAt', IF(published_at IS NULL, NULL, DATE_FORMAT(published_at, '%Y-%m-%dT%H:%i:%s+08:00')),
      'contentStatus', content_status,
      'sourceLevel', source_level,
      'policyStatus', policy_status,
      'extractedText', COALESCE(extracted_text, ''),
      'evidenceSummary', COALESCE(evidence_summary, ''),
      'isPrimary', is_primary,
      'verifiedBy', verified_by,
      'verifiedAt', IF(verified_at IS NULL, NULL, DATE_FORMAT(verified_at, '%Y-%m-%dT%H:%i:%s+08:00')),
      'updatedAt', DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s+08:00')
    )), JSON_ARRAY())
    FROM (
      SELECT *
      FROM yimin_h_topic_sources
      WHERE topic_id = ${sqlNumber(topicId)}
        AND deleted_at IS NULL
      ORDER BY is_primary DESC, FIELD(source_level, 'A', 'B', 'C', 'D'), id ASC
    ) sources;
  `)) || []);
}

async function listHTopicViewpoints(topicId) {
  return sanitizeStructuredTextArtifacts((await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
      'id', id,
      'inputType', input_type,
      'rawText', raw_text,
      'editedText', COALESCE(edited_text, ''),
      'isConfirmed', is_confirmed,
      'confirmationType', confirmation_type,
      'confirmedBy', confirmed_by,
      'confirmedAt', IF(confirmed_at IS NULL, NULL, DATE_FORMAT(confirmed_at, '%Y-%m-%dT%H:%i:%s+08:00')),
      'createdBy', created_by,
      'createdAt', DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s+08:00'),
      'updatedAt', DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s+08:00')
    )), JSON_ARRAY())
    FROM (
      SELECT *
      FROM yimin_h_viewpoints
      WHERE topic_id = ${sqlNumber(topicId)}
        AND deleted_at IS NULL
      ORDER BY is_confirmed DESC, id DESC
    ) viewpoints;
  `)) || []);
}

async function listHTopicDrafts(topicId) {
  const drafts = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
      'id', d.id,
      'topicId', d.topic_id,
      'parentDraftId', d.parent_draft_id,
      'mode', d.mode,
      'versionNo', d.version_no,
      'title', d.title,
      'titleCandidates', d.title_candidates_json,
      'outlineMarkdown', COALESCE(d.outline_markdown, ''),
      'contentMarkdown', d.content_markdown,
      'html', d.content_html,
      'extras', d.extras_json,
      'pendingFacts', d.pending_facts_json,
      'status', d.status,
      'readiness', d.readiness,
      'provider', d.provider,
      'model', d.model,
      'skillVersion', d.skill_version,
      'profileVersion', d.profile_version,
      'promptVersion', d.prompt_version,
      'generationError', d.generation_error,
      'createdBy', d.created_by,
      'approvedBy', d.approved_by,
      'approvalType', d.approval_type,
      'approvedAt', IF(d.approved_at IS NULL, NULL, DATE_FORMAT(d.approved_at, '%Y-%m-%dT%H:%i:%s+08:00')),
      'createdAt', DATE_FORMAT(d.created_at, '%Y-%m-%dT%H:%i:%s+08:00'),
      'updatedAt', DATE_FORMAT(d.updated_at, '%Y-%m-%dT%H:%i:%s+08:00'),
      'latestReview', (
        SELECT JSON_OBJECT(
          'id', r.id,
          'conclusion', r.conclusion,
          'l1Status', r.l1_status,
          'l2Status', r.l2_status,
          'l3Status', r.l3_status,
          'l4Status', r.l4_status,
          'issues', r.issues_json,
          'pendingFacts', r.pending_facts_json,
          'requiredActions', r.required_actions_json,
          'model', r.model,
          'reviewedAt', DATE_FORMAT(r.reviewed_at, '%Y-%m-%dT%H:%i:%s+08:00')
        )
        FROM yimin_h_reviews r
        WHERE r.draft_id = d.id
        ORDER BY r.id DESC
        LIMIT 1
      )
    )), JSON_ARRAY())
    FROM (
      SELECT *
      FROM yimin_h_drafts
      WHERE topic_id = ${sqlNumber(topicId)}
      ORDER BY updated_at DESC, id DESC
    ) d;
  `)) || [];
  return sanitizeStructuredTextArtifacts(drafts)
    .sort((left, right) => Number(right.id) - Number(left.id));
}

async function getHDraft(draftId) {
  return sanitizeStructuredTextArtifacts(await mysqlJson(`
    SELECT JSON_OBJECT(
      'id', id,
      'topicId', topic_id,
      'parentDraftId', parent_draft_id,
      'mode', mode,
      'versionNo', version_no,
      'title', title,
      'titleCandidates', title_candidates_json,
      'outlineMarkdown', COALESCE(outline_markdown, ''),
      'contentMarkdown', content_markdown,
      'html', content_html,
      'extras', extras_json,
      'pendingFacts', pending_facts_json,
      'status', status,
      'readiness', readiness,
      'provider', provider,
      'model', model,
      'skillVersion', skill_version,
      'profileVersion', profile_version,
      'promptVersion', prompt_version,
      'generationError', generation_error,
      'inputHash', input_hash,
      'inputSnapshot', input_snapshot_json,
      'createdBy', created_by,
      'approvedBy', approved_by,
      'approvalType', approval_type,
      'approvedAt', IF(approved_at IS NULL, NULL, DATE_FORMAT(approved_at, '%Y-%m-%dT%H:%i:%s+08:00')),
      'createdAt', DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s+08:00'),
      'updatedAt', DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s+08:00')
    )
    FROM yimin_h_drafts
    WHERE id = ${sqlNumber(draftId)}
    LIMIT 1;
  `));
}

async function getLatestHDraftReview(draftId) {
  return sanitizeStructuredTextArtifacts(await mysqlJson(`
    SELECT JSON_OBJECT(
      'id', id,
      'draftId', draft_id,
      'conclusion', conclusion,
      'l1Status', l1_status,
      'l2Status', l2_status,
      'l3Status', l3_status,
      'l4Status', l4_status,
      'issues', issues_json,
      'pendingFacts', pending_facts_json,
      'requiredActions', required_actions_json,
      'model', model,
      'reviewedAt', DATE_FORMAT(reviewed_at, '%Y-%m-%dT%H:%i:%s+08:00')
    )
    FROM yimin_h_reviews
    WHERE draft_id = ${sqlNumber(draftId)}
    ORDER BY id DESC
    LIMIT 1;
  `));
}

function isHDraftReviewStale(review, sources = [], viewpoints = []) {
  if (!review) return true;
  const reviewedAt = Date.parse(review.reviewedAt || "");
  if (!Number.isFinite(reviewedAt)) return true;
  return sources.some((source) => Date.parse(source.updatedAt || "") > reviewedAt)
    || viewpoints.some((viewpoint) => Date.parse(viewpoint.updatedAt || viewpoint.createdAt || "") > reviewedAt);
}

async function assertHDraftReviewCurrent(draft) {
  const [review, sources, viewpoints] = await Promise.all([
    getLatestHDraftReview(draft.id),
    listHTopicSources(draft.topicId),
    listHTopicViewpoints(draft.topicId),
  ]);
  if (!review || isHDraftReviewStale(review, sources, viewpoints)) {
    const error = new Error("事实包或 Henry 观点在审校后发生变化，请重新运行四层审校");
    error.code = "H_DRAFT_REVIEW_STALE";
    throw error;
  }
  return review;
}

async function getHTopicDetail(topicId) {
  await initDb();
  const topic = await getHTopicBase(topicId);
  if (!topic) return null;
  const [sources, viewpoints, drafts] = await Promise.all([
    listHTopicSources(topicId),
    listHTopicViewpoints(topicId),
    listHTopicDrafts(topicId),
  ]);
  const draftsWithReviewState = drafts.map((draft) => ({
    ...draft,
    latestReview: draft.latestReview
      ? {
          ...draft.latestReview,
          isStale: isHDraftReviewStale(draft.latestReview, sources, viewpoints),
        }
      : null,
  }));
  return {
    ...topic,
    sources,
    viewpoints,
    drafts: draftsWithReviewState,
    sourceCount: sources.length,
    fullSourceCount: sources.filter((source) => source.contentStatus === "full").length,
    aLevelSourceCount: sources.filter((source) => source.sourceLevel === "A").length,
    confirmedViewpointCount: viewpoints.filter((viewpoint) => viewpoint.isConfirmed).length,
    draftCount: draftsWithReviewState.filter((draft) => draft.status !== "failed").length,
    readyForHenryDraftCount: draftsWithReviewState.filter((draft) => draft.status === "ready_for_henry").length,
  };
}

async function refreshHTopicReadiness(topicId) {
  const topic = await getHTopicBase(topicId);
  if (!topic) return null;
  const [sources, viewpoints] = await Promise.all([
    listHTopicSources(topicId),
    listHTopicViewpoints(topicId),
  ]);
  const highRisk = isHHighRiskTopic(topic);
  const hasFullSource = sources.some((source) => source.contentStatus === "full" && source.verifiedAt);
  const hasAFullSource = sources.some((source) => (
    source.contentStatus === "full"
    && source.sourceLevel === "A"
    && source.verifiedAt
  ));
  const hasBasis = highRisk ? hasAFullSource : hasFullSource;
  const hasJudgment = viewpoints.some((viewpoint) => Boolean(viewpoint.isConfirmed));
  const currentChecks = topic.fourChecks || {};
  const checks = {
    hasJudgment,
    hasBasis,
    useful: Boolean(currentChecks.useful),
    longTerm: Boolean(currentChecks.longTerm),
  };
  checks.passedCount = Object.values(checks).filter((value) => value === true).length;

  let readiness = "topic_only";
  if (checks.passedCount <= 1) readiness = "not_recommended";
  else if (!hasBasis && !hasJudgment) readiness = "topic_only";
  else if (!hasBasis) readiness = "needs_evidence";
  else if (!hasJudgment) readiness = "needs_viewpoint";
  else if (checks.useful && checks.longTerm) readiness = "draft_ready";
  else readiness = "outline_ready";

  const missingItems = [
    ...(!hasBasis
      ? [highRisk
        ? "政策、法律、税务或投资核心事实需要至少一个 A 级完整来源"
        : "需要至少一个完整来源"]
      : []),
    ...(!hasJudgment ? ["需要 H 专栏成员确认本次核心观点"] : []),
    ...(!checks.useful ? ["需要说明读者看完后可以采取什么行动"] : []),
    ...(!checks.longTerm ? ["需要建立与专业、合规、安全、公平、全球化或长期主义的真实连接"] : []),
  ];
  await mysqlExec(`
    UPDATE yimin_h_topics
    SET four_checks_json = ${sqlJson(checks)},
        readiness = ${sqlString(readiness)},
        missing_items_json = ${sqlJson(missingItems)}
    WHERE id = ${sqlNumber(topicId)};
  `);
  return getHTopicDetail(topicId);
}

async function updateHTopic(topicId, data, actor) {
  const topic = await getHTopicBase(topicId);
  if (!topic) return null;
  const status = normalizeHTopicStatus(data.status, topic.status);
  const newlySelected = status === "selected" && topic.status !== "selected";
  const requestedChecks = data.fourChecks && typeof data.fourChecks === "object"
    ? data.fourChecks
    : {};
  const nextChecks = {
    ...(topic.fourChecks || {}),
    useful: typeof requestedChecks.useful === "boolean"
      ? requestedChecks.useful
      : Boolean(topic.fourChecks?.useful),
    longTerm: typeof requestedChecks.longTerm === "boolean"
      ? requestedChecks.longTerm
      : Boolean(topic.fourChecks?.longTerm),
  };
  await mysqlExec(`
    UPDATE yimin_h_topics
    SET status = ${sqlString(status)},
        primary_mode = ${sqlString(normalizeHMode(data.primaryMode, topic.primaryMode))},
        reusable_mode = ${sqlString(normalizeHMode(data.reusableMode, topic.reusableMode || "short_video"))},
        four_checks_json = ${sqlJson(nextChecks)},
        selected_by = ${newlySelected ? sqlString(actor.id) : "selected_by"},
        selected_at = ${newlySelected ? "CURRENT_TIMESTAMP" : "selected_at"},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${sqlNumber(topicId)};
  `);
  await saveHAuditLog("topic", topicId, "topic.update", actor, {
    previousStatus: topic.status,
    status,
    primaryMode: normalizeHMode(data.primaryMode, topic.primaryMode),
    reusableMode: normalizeHMode(data.reusableMode, topic.reusableMode || "short_video"),
    fourChecks: {
      useful: nextChecks.useful,
      longTerm: nextChecks.longTerm,
    },
  });
  if (["later", "rejected"].includes(status)) {
    await saveHFeedback(topicId, null, status === "later" ? "later" : "reject", data.reasonCode, data.note, actor);
  }
  if (newlySelected) {
    try {
      return await fetchHTopicEvidence(topicId, actor);
    } catch (error) {
      console.warn(`H automatic evidence fetch failed for topic ${topicId}:`, formatErrorMessage(error));
    }
  }
  return refreshHTopicReadiness(topicId);
}

async function saveHFeedback(topicId, draftId, action, reasonCode, note, actor) {
  await mysqlExec(`
    INSERT INTO yimin_h_feedback (
      topic_id, draft_id, action, reason_code, note, created_by
    )
    VALUES (
      ${sqlNumber(topicId)}, ${draftId ? sqlNumber(draftId) : "NULL"},
      ${sqlString(action)}, ${sqlString(reasonCode || "")},
      ${sqlString(note || "")}, ${sqlString(actor.id)}
    );
  `);
  await saveHAuditLog(draftId ? "draft" : "topic", draftId || topicId, `feedback.${action}`, actor, {
    topicId: Number(topicId),
    draftId: draftId ? Number(draftId) : null,
    reasonCode: reasonCode || "",
  });
}

async function addHViewpoint(topicId, data, actor) {
  const topic = await getHTopicBase(topicId);
  if (!topic) return null;
  const rawText = sanitizeTextArtifacts(String(data.rawText || data.text || "").trim());
  if (!rawText) {
    throw new Error("请输入 Henry 本次观点");
  }
  const wantsConfirmation = data.confirm === true;
  const confirmed = wantsConfirmation;
  await mysqlExec(`
    INSERT INTO yimin_h_viewpoints (
      topic_id, input_type, raw_text, edited_text, is_confirmed,
      confirmation_type, confirmed_by, confirmed_at, created_by
    )
    VALUES (
      ${sqlNumber(topicId)}, 'text', ${sqlString(rawText)},
      ${sqlString(sanitizeTextArtifacts(String(data.editedText || rawText)))},
      ${sqlNumber(confirmed ? 1 : 0)},
      ${sqlString(confirmed ? actor.confirmationType : "unconfirmed")},
      ${confirmed ? sqlString(actor.id) : "NULL"},
      ${confirmed ? "CURRENT_TIMESTAMP" : "NULL"},
      ${sqlString(actor.id)}
    );
  `);
  await saveHAuditLog("topic", topicId, "viewpoint.add", actor, {
    confirmed,
    confirmationType: confirmed ? actor.confirmationType : "unconfirmed",
  });
  return refreshHTopicReadiness(topicId);
}

async function confirmHViewpoint(viewpointId, actor) {
  const row = await mysqlJson(`
    SELECT JSON_OBJECT('id', id, 'topicId', topic_id)
    FROM yimin_h_viewpoints
    WHERE id = ${sqlNumber(viewpointId)}
      AND deleted_at IS NULL
    LIMIT 1;
  `);
  if (!row) return null;
  await mysqlExec(`
    UPDATE yimin_h_viewpoints
    SET is_confirmed = 1,
        confirmation_type = ${sqlString(actor.confirmationType)},
        confirmed_by = ${sqlString(actor.id)},
        confirmed_at = CURRENT_TIMESTAMP
    WHERE id = ${sqlNumber(viewpointId)};
  `);
  await saveHAuditLog("viewpoint", viewpointId, "viewpoint.confirm", actor, {
    topicId: Number(row.topicId),
    confirmationType: actor.confirmationType,
  });
  return refreshHTopicReadiness(row.topicId);
}

async function updateHViewpoint(viewpointId, data, actor) {
  const row = await mysqlJson(`
    SELECT JSON_OBJECT(
      'id', id,
      'topicId', topic_id,
      'currentText', COALESCE(edited_text, raw_text)
    )
    FROM yimin_h_viewpoints
    WHERE id = ${sqlNumber(viewpointId)}
      AND deleted_at IS NULL
    LIMIT 1;
  `);
  if (!row) return null;
  const editedText = sanitizeTextArtifacts(String(data.editedText || data.text || "").trim());
  if (!editedText) throw new Error("Henry 观点不能为空");
  await mysqlExec(`
    UPDATE yimin_h_viewpoints
    SET input_type = IF(input_type = 'profile', 'text', input_type),
        edited_text = ${sqlString(editedText)},
        is_confirmed = 1,
        confirmation_type = ${sqlString(actor.confirmationType)},
        confirmed_by = ${sqlString(actor.id)},
        confirmed_at = CURRENT_TIMESTAMP
    WHERE id = ${sqlNumber(viewpointId)}
      AND deleted_at IS NULL;
  `);
  await saveHAuditLog("viewpoint", viewpointId, "viewpoint.update", actor, {
    topicId: Number(row.topicId),
    previousContentHash: createHash("sha256").update(String(row.currentText || "")).digest("hex"),
    contentHash: createHash("sha256").update(editedText).digest("hex"),
  });
  return refreshHTopicReadiness(row.topicId);
}

async function deleteHViewpoint(viewpointId, actor) {
  const row = await mysqlJson(`
    SELECT JSON_OBJECT('id', id, 'topicId', topic_id, 'inputType', input_type)
    FROM yimin_h_viewpoints
    WHERE id = ${sqlNumber(viewpointId)}
      AND deleted_at IS NULL
    LIMIT 1;
  `);
  if (!row) return null;
  await mysqlExec(`
    UPDATE yimin_h_viewpoints
    SET deleted_at = CURRENT_TIMESTAMP
    WHERE id = ${sqlNumber(viewpointId)}
      AND deleted_at IS NULL;
  `);
  await saveHAuditLog("viewpoint", viewpointId, "viewpoint.delete", actor, {
    topicId: Number(row.topicId),
    inputType: row.inputType,
  });
  return refreshHTopicReadiness(row.topicId);
}

function normalizeHSourceUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("unsupported protocol");
    }
    return url.href;
  } catch {
    throw new Error("来源链接必须是有效的 http:// 或 https:// 地址");
  }
}

function deriveHContentStatus(extractedText) {
  const length = String(extractedText || "").trim().length;
  if (length >= hFullSourceMinChars) return "full";
  return length > 0 ? "summary_only" : "missing";
}

async function addHTopicSource(topicId, data, actor) {
  const topic = await getHTopicBase(topicId);
  if (!topic) return null;
  const url = normalizeHSourceUrl(data.url);
  const title = sanitizeTextArtifacts(String(data.title || "").trim());
  const extractedText = sanitizeTextArtifacts(String(data.extractedText || data.content || "").trim());
  if (!url && !title && !extractedText) throw new Error("来源链接、标题或正文至少填写一项");
  const contentStatus = deriveHContentStatus(extractedText);
  const sourceLevel = ["A", "B", "C", "D"].includes(data.sourceLevel)
    ? data.sourceLevel
    : inferHSourceLevel(data.sourceName, url);
  const allowedPolicyStatuses = new Set(["effective", "announced", "pending", "proposed", "media_report", "opinion", "not_applicable"]);
  const policyStatus = allowedPolicyStatuses.has(data.policyStatus)
    ? data.policyStatus
    : inferHPolicyStatus(title, extractedText, topic.contentArchetype);
  const row = await mysqlJson(`
    INSERT INTO yimin_h_topic_sources (
      topic_id, article_hash, source_name, url, title, published_at,
      content_status, source_level, policy_status, extracted_text,
      evidence_summary, is_primary, verified_by, verified_at, content_hash
    )
    VALUES (
      ${sqlNumber(topicId)}, NULL, ${sqlString(data.sourceName || "")},
      ${sqlString(url)}, ${sqlString(title)}, ${sqlDate(data.publishedAt)},
      ${sqlString(contentStatus)}, ${sqlString(sourceLevel)}, ${sqlString(policyStatus)},
      ${sqlString(extractedText)}, ${sqlString(data.evidenceSummary || "")},
      ${sqlNumber(data.isPrimary ? 1 : 0)}, ${data.verified ? sqlString(actor.id) : "NULL"},
      ${data.verified ? "CURRENT_TIMESTAMP" : "NULL"},
      ${sqlString(createHash("sha256").update(extractedText).digest("hex"))}
    );
    SELECT JSON_OBJECT('id', LAST_INSERT_ID());
  `);
  await saveHAuditLog("source", row?.id || "", "source.add", actor, {
    topicId: Number(topicId),
    contentStatus,
    sourceLevel,
    policyStatus,
    verified: Boolean(data.verified),
  });
  return refreshHTopicReadiness(topicId);
}

async function updateHTopicSource(sourceId, data, actor) {
  const source = await mysqlJson(`
    SELECT JSON_OBJECT(
      'id', id,
      'topicId', topic_id,
      'sourceName', source_name,
      'url', url,
      'title', title,
      'contentStatus', content_status,
      'sourceLevel', source_level,
      'policyStatus', policy_status,
      'extractedText', COALESCE(extracted_text, ''),
      'evidenceSummary', COALESCE(evidence_summary, ''),
      'isPrimary', is_primary,
      'verifiedAt', IF(verified_at IS NULL, NULL, DATE_FORMAT(verified_at, '%Y-%m-%dT%H:%i:%s+08:00'))
    )
    FROM yimin_h_topic_sources
    WHERE id = ${sqlNumber(sourceId)}
      AND deleted_at IS NULL
    LIMIT 1;
  `);
  if (!source) return null;
  const extractedText = sanitizeTextArtifacts(String(data.extractedText ?? source.extractedText));
  const extractedTextWasProvided = Object.prototype.hasOwnProperty.call(data, "extractedText");
  const contentStatusWasProvided = Object.prototype.hasOwnProperty.call(data, "contentStatus");
  const contentStatus = extractedTextWasProvided || contentStatusWasProvided
    ? deriveHContentStatus(extractedText)
    : source.contentStatus;
  const sourceLevel = ["A", "B", "C", "D"].includes(data.sourceLevel)
    ? data.sourceLevel
    : source.sourceLevel;
  const policyStatus = ["effective", "announced", "pending", "proposed", "media_report", "opinion", "not_applicable"].includes(data.policyStatus)
    ? data.policyStatus
    : source.policyStatus;
  const url = Object.prototype.hasOwnProperty.call(data, "url")
    ? normalizeHSourceUrl(data.url)
    : String(source.url || "");
  const title = sanitizeTextArtifacts(String(data.title ?? source.title));
  const contentChanged = extractedText !== String(source.extractedText || "")
    || contentStatus !== source.contentStatus
    || sourceLevel !== source.sourceLevel
    || policyStatus !== source.policyStatus
    || url !== String(source.url || "")
    || title !== String(source.title || "");
  await mysqlExec(`
    UPDATE yimin_h_topic_sources
    SET source_name = ${sqlString(data.sourceName ?? source.sourceName)},
        url = ${sqlString(url)},
        title = ${sqlString(title)},
        content_status = ${sqlString(contentStatus)},
        source_level = ${sqlString(sourceLevel)},
        policy_status = ${sqlString(policyStatus)},
        extracted_text = ${sqlString(extractedText)},
        evidence_summary = ${sqlString(data.evidenceSummary ?? source.evidenceSummary)},
        is_primary = ${sqlNumber((data.isPrimary ?? source.isPrimary) ? 1 : 0)},
        verified_by = ${data.verified ? sqlString(actor.id) : (contentChanged ? "NULL" : "verified_by")},
        verified_at = ${data.verified ? "CURRENT_TIMESTAMP" : (contentChanged ? "NULL" : "verified_at")},
        content_hash = ${sqlString(createHash("sha256").update(extractedText).digest("hex"))}
    WHERE id = ${sqlNumber(sourceId)};
  `);
  await saveHAuditLog("source", sourceId, "source.update", actor, {
    topicId: Number(source.topicId),
    contentStatus,
    sourceLevel,
    policyStatus,
    verified: data.verified ? true : (contentChanged ? false : Boolean(source.verifiedAt)),
  });
  return refreshHTopicReadiness(source.topicId);
}

async function deleteHTopicSource(sourceId, actor) {
  const source = await mysqlJson(`
    SELECT JSON_OBJECT('topicId', topic_id)
    FROM yimin_h_topic_sources
    WHERE id = ${sqlNumber(sourceId)}
      AND deleted_at IS NULL
    LIMIT 1;
  `);
  if (!source) return null;
  await mysqlExec(`
    UPDATE yimin_h_topic_sources
    SET deleted_at = CURRENT_TIMESTAMP
    WHERE id = ${sqlNumber(sourceId)};
  `);
  await saveHAuditLog("source", sourceId, "source.delete", actor, {
    topicId: Number(source.topicId),
  });
  return refreshHTopicReadiness(source.topicId);
}

async function fetchHTopicEvidence(topicId, actor) {
  const sources = await listHTopicSources(topicId);
  if (!sources.length) return refreshHTopicReadiness(topicId);
  const pendingSources = sources.filter((source) => source.url && source.contentStatus !== "full");
  const results = await runWithConcurrency(pendingSources, 3, async (source) => {
    let fetched = null;
    try {
      const firecrawl = await fetchWithFirecrawl(source.url);
      if (firecrawl.ok && String(firecrawl.content || "").trim().length >= 800) {
        fetched = {
          text: firecrawl.content,
          title: firecrawl.title || source.title,
        };
      } else {
        const jina = await fetchWithJina(source.url);
        if (jina.ok && String(jina.text || "").trim().length >= 800) {
          fetched = {
            text: jina.text,
            title: jina.title || source.title,
          };
        }
      }
    } catch (error) {
      console.warn(`H evidence fetch failed ${source.url}:`, formatErrorMessage(error));
    }
    if (!fetched) return false;
    const cleanText = sanitizeTextArtifacts(String(fetched.text || "")).slice(0, 120000);
    await mysqlExec(`
      UPDATE yimin_h_topic_sources
      SET title = ${sqlString(fetched.title || source.title)},
          extracted_text = ${sqlString(cleanText)},
          content_status = 'full',
          source_level = ${sqlString(inferHSourceLevel(source.sourceName, source.url))},
          content_hash = ${sqlString(createHash("sha256").update(cleanText).digest("hex"))},
          verified_by = NULL,
          verified_at = NULL
      WHERE id = ${sqlNumber(source.id)};
    `);
    return true;
  });
  const updatedCount = results.filter(Boolean).length;
  if (updatedCount > 0) {
    await saveHAuditLog("topic", topicId, "evidence.fetch", actor, {
      updatedSourceCount: updatedCount,
    });
  }
  return refreshHTopicReadiness(topicId);
}

function buildHDraftPrompt(topic, sources, viewpoints, profile, mode) {
  const channel = mode === "outline"
    ? {
        label: "内容大纲",
        length: "以清晰完整为准",
        requirements: ["确认一个主轴", "列出事实依据和边界", "组织3—5个独立论点", "保留风险、反面和读者行动"],
      }
    : profile.channelModes?.[mode] || profile.channelModes?.wechat_article || {};
  const sourcePayload = sources.map((source) => ({
    sourceName: source.sourceName,
    title: source.title,
    url: source.url,
    publishedAt: source.publishedAt,
    contentStatus: source.contentStatus,
    sourceLevel: source.sourceLevel,
    policyStatus: source.policyStatus,
    evidenceSummary: source.evidenceSummary,
    text: String(source.extractedText || "").slice(0, 22000),
  }));
  const viewpointPayload = viewpoints
    .filter((viewpoint) => Boolean(viewpoint.isConfirmed))
    .map((viewpoint) => ({
      inputType: viewpoint.inputType,
      text: viewpoint.editedText || viewpoint.rawText,
      confirmationType: viewpoint.confirmationType,
      confirmedBy: viewpoint.confirmedBy,
    }));

  return `请基于以下事实包和已确认观点生成 Henry 内容草稿。

任务模式：${mode}
渠道名称：${channel.label || mode}
建议长度：${channel.length || ""}
渠道要求：${JSON.stringify(channel.requirements || [])}

只返回一个严格 JSON 对象，不要 Markdown 代码围栏：
{
  "titleCandidates":["默认8个，不复制历史标题"],
  "recommendedTitle":"推荐标题",
  "outlineMarkdown":"大纲 Markdown",
  "contentMarkdown":"${mode === "outline" ? "与 outlineMarkdown 一致的结构化内容大纲" : "完整正文或口播 Markdown"}",
  "extras":{
    "recommendationReason":"推荐标题理由",
    "summary":"公众号摘要或视频定位",
    "coverText":"视频封面或文章封面文案",
    "visualSuggestions":["配图、画面、字幕或B-roll节点"]
  },
  "pendingFacts":["待本人确认、待补来源、待补数据或待补统计日期"],
  "verificationNotes":["发布前核验提示"]
}

写作原则：
- 这是供 Henry 本人或授权编辑审阅的草稿，不声称完全代表本人。
- 先有观点，再说明前提、事实、原因、风险和读者行动。
- 一篇只保留一个主轴和3—5个独立论点，不换词重复结论。
- 系统建议角度不是本人观点，只能使用“已确认观点”里的第一人称表达。
- 不得虚构个人经历、客户案例、公司事实、情绪、对话或现场。
- 只有标题或摘要的来源不得冒充完整原文。
- 政策、法律、税务、投资、费用、排期和资格必须保留状态、日期、适用对象和不确定性。
- 不得使用“保证获批、绝对安全、零风险、百分百”等承诺。
- 不得披露禁区内容。
- 标题默认 balanced：专业、有明确对象和问题，但不得超过正文证据强度。
- 公众号开头150字内出现主题；视频前20秒出现核心问题和初步答案。
- 必须承认至少一个风险、代价、反面或不适合人群。
- 不使用“赋能、布局、生态、认知升级、底层逻辑”等空泛公关表达。
${mode === "outline" ? "- 当前任务只生成内容大纲：明确主轴、事实边界、核心观点、3—5个论点、风险和行动。" : ""}

人物定位：
${profile.positioning}

禁止内容：
${JSON.stringify(profile.prohibitedContent || [])}

选题：
${JSON.stringify({
    title: topic.title,
    eventSummary: topic.eventSummary,
    coreQuestion: topic.coreQuestion,
    suggestedAngle: topic.suggestedAngle,
    targetAudience: topic.targetAudience,
    contentArchetype: topic.contentArchetype,
  })}

已确认观点：
${JSON.stringify(viewpointPayload)}

事实包：
${JSON.stringify(sourcePayload)}`;
}

function buildFallbackHDraft(topic, sources, viewpoints, mode) {
  const confirmedViewpoint = viewpoints.find((viewpoint) => Boolean(viewpoint.isConfirmed));
  const facts = sources
    .filter((source) => source.evidenceSummary || source.extractedText)
    .slice(0, 5)
    .map((source) => `- ${source.evidenceSummary || String(source.extractedText || "").slice(0, 220)}（${source.sourceLevel}级，${source.policyStatus}）`);
  const outline = [
    `# ${topic.title}`,
    "",
    "## 核心观点",
    confirmedViewpoint?.editedText || confirmedViewpoint?.rawText || "[待本人确认：这件事真正想表达的判断]",
    "",
    "## 适用前提",
    `面向：${topic.targetAudience || "关心身份与全球化选择的中文读者"}`,
    "",
    "## 已确认事实",
    ...(facts.length ? facts : ["- [待补来源：当前没有足够完整的事实材料]"]),
    "",
    "## 风险与不确定性",
    "- 发布前需逐项核验政策状态、日期、适用对象和限制条件。",
    "",
    "## 对读者的行动建议",
    "- 先判断自身目标和风险承受能力，再决定是否调整方案。",
  ].join("\n");
  return {
    titleCandidates: [topic.title],
    recommendedTitle: topic.title,
    outlineMarkdown: outline,
    contentMarkdown: mode === "outline"
      ? outline
      : `${outline}\n\n> AI 完整成稿暂不可用，本版本仅保留可验证的大纲，不能直接发布。`,
    extras: {
      recommendationReason: "标题直接对应已确认事件，不扩大证据强度。",
      summary: topic.coreQuestion,
      coverText: topic.title.slice(0, 16),
      visualSuggestions: [],
    },
    pendingFacts: topic.missingItems || [],
    verificationNotes: ["生成模型暂不可用，本版本为规则化降级大纲。"],
  };
}

async function beginHGenerationRun(runType, targetId, idempotencyKey, model) {
  await mysqlExec(`
    INSERT INTO yimin_h_generation_runs (
      run_type, target_id, idempotency_key, status, provider, model,
      attempt_count, started_at
    )
    VALUES (
      ${sqlString(runType)}, ${targetId ? sqlNumber(targetId) : "NULL"},
      ${sqlString(idempotencyKey)}, 'running', 'openai-compatible',
      ${sqlString(model)}, 1, CURRENT_TIMESTAMP
    )
    ON DUPLICATE KEY UPDATE
      status = 'running',
      attempt_count = attempt_count + 1,
      started_at = CURRENT_TIMESTAMP,
      finished_at = NULL,
      error_message = NULL,
      updated_at = CURRENT_TIMESTAMP;
  `);
}

async function finishHGenerationRun(idempotencyKey, error = null) {
  await mysqlExec(`
    UPDATE yimin_h_generation_runs
    SET status = ${sqlString(error ? "failed" : "completed")},
        finished_at = CURRENT_TIMESTAMP,
        error_message = ${error ? sqlString(formatErrorMessage(error)) : "NULL"}
    WHERE idempotency_key = ${sqlString(idempotencyKey)};
  `);
}

async function generateHDraft(topicId, data, actor) {
  const topic = await refreshHTopicReadiness(topicId);
  if (!topic) return null;
  const mode = normalizeHMode(data.mode, topic.primaryMode);
  if (topic.status !== "selected") {
    const error = new Error("请先选择“值得写”，再生成内容");
    error.code = "H_TOPIC_NOT_SELECTED";
    throw error;
  }
  if (topic.readiness === "not_recommended") {
    const error = new Error("当前选题暂不建议成稿");
    error.code = "H_TOPIC_NOT_READY";
    throw error;
  }
  if (mode !== "outline" && topic.readiness !== "draft_ready") {
    const error = new Error(`当前准备度为 ${topic.readiness}，请先补齐事实和已确认观点`);
    error.code = "H_TOPIC_NOT_READY";
    throw error;
  }
  const sources = topic.sources || await listHTopicSources(topicId);
  const viewpoints = topic.viewpoints || await listHTopicViewpoints(topicId);
  const profile = await loadHContentProfile();
  const inputSnapshot = {
    topic: {
      id: topic.id,
      title: topic.title,
      eventSummary: topic.eventSummary,
      coreQuestion: topic.coreQuestion,
      suggestedAngle: topic.suggestedAngle,
      targetAudience: topic.targetAudience,
      contentArchetype: topic.contentArchetype,
      readiness: topic.readiness,
    },
    sources: sources.map((source) => ({
      id: source.id,
      sourceName: source.sourceName,
      url: source.url,
      title: source.title,
      contentStatus: source.contentStatus,
      sourceLevel: source.sourceLevel,
      policyStatus: source.policyStatus,
      contentHash: createHash("sha256").update(String(source.extractedText || "")).digest("hex"),
    })),
    viewpoints: viewpoints.filter((viewpoint) => viewpoint.isConfirmed).map((viewpoint) => ({
      id: viewpoint.id,
      inputType: viewpoint.inputType,
      text: viewpoint.editedText || viewpoint.rawText,
      confirmationType: viewpoint.confirmationType,
      confirmedBy: viewpoint.confirmedBy,
    })),
    mode,
    skillVersion: profile.skillVersion,
    profileVersion: profile.profileVersion,
  };
  const inputHash = createHash("sha256").update(JSON.stringify(inputSnapshot)).digest("hex");
  if (!data.refresh) {
    const existing = await mysqlJson(`
      SELECT JSON_OBJECT('id', id)
      FROM yimin_h_drafts
      WHERE topic_id = ${sqlNumber(topicId)}
        AND mode = ${sqlString(mode)}
        AND input_hash = ${sqlString(inputHash)}
        AND status <> 'failed'
      ORDER BY id DESC
      LIMIT 1;
    `);
    if (existing?.id) return getHDraft(existing.id);
  }

  const versionRow = await mysqlJson(`
    SELECT JSON_OBJECT('nextVersion', COALESCE(MAX(version_no), 0) + 1)
    FROM yimin_h_drafts
    WHERE topic_id = ${sqlNumber(topicId)}
      AND mode = ${sqlString(mode)};
  `);
  const versionNo = Number(versionRow?.nextVersion || 1);
  const idempotencyKey = createHash("sha256").update(`draft:${topicId}:${mode}:${inputHash}:${versionNo}`).digest("hex");
  await beginHGenerationRun("draft", topicId, idempotencyKey, hColumnConfig.model);
  let generated;
  let generationError = null;
  try {
    const content = await callDeepSeek(
      buildHDraftPrompt(topic, sources, viewpoints, profile, mode),
      {
        model: hColumnConfig.model,
        temperature: mode === "outline" ? 0.25 : 0.48,
        systemPrompt: "你是 Henry 内容工作台的资深内容编辑。只使用提供的事实包和已确认观点，不得虚构 Henry 的观点、经历、客户、数字或公司事实。输出严格 JSON。",
      },
    );
    generated = parseDeepSeekJsonObject(content);
  } catch (error) {
    generationError = error;
    console.error("H draft generation fallback:", formatErrorMessage(error));
    generated = buildFallbackHDraft(topic, sources, viewpoints, mode);
  }
  const titleCandidates = Array.isArray(generated.titleCandidates)
    ? generated.titleCandidates.map((value) => sanitizeTextArtifacts(String(value))).filter(Boolean).slice(0, 8)
    : [];
  const title = sanitizeTextArtifacts(String(generated.recommendedTitle || titleCandidates[0] || topic.title));
  const outlineMarkdown = sanitizeTextArtifacts(String(generated.outlineMarkdown || ""));
  const contentMarkdown = sanitizeTextArtifacts(String(generated.contentMarkdown || outlineMarkdown || ""));
  const pendingFacts = Array.isArray(generated.pendingFacts)
    ? generated.pendingFacts.map((value) => sanitizeTextArtifacts(String(value))).filter(Boolean)
    : [];
  const extras = sanitizeStructuredTextArtifacts({
    ...(generated.extras && typeof generated.extras === "object" ? generated.extras : {}),
    verificationNotes: Array.isArray(generated.verificationNotes) ? generated.verificationNotes : [],
  });
  const row = await mysqlJson(`
    INSERT INTO yimin_h_drafts (
      topic_id, parent_draft_id, mode, version_no, title,
      title_candidates_json, outline_markdown, content_markdown, content_html,
      extras_json, pending_facts_json, status, readiness, provider, model,
      skill_version, profile_version, prompt_version, input_hash,
      input_snapshot_json, generation_error, created_by
    )
    VALUES (
      ${sqlNumber(topicId)}, NULL, ${sqlString(mode)}, ${sqlNumber(versionNo)},
      ${sqlString(title)}, ${sqlJson(titleCandidates)}, ${sqlString(outlineMarkdown)},
      ${sqlString(contentMarkdown)}, ${sqlString(markdownToHtml(contentMarkdown))},
      ${sqlJson(extras)}, ${sqlJson(pendingFacts)}, 'drafted', 'review_required',
      'openai-compatible', ${sqlString(generationError ? "fallback" : hColumnConfig.model)},
      ${sqlString(profile.skillVersion)}, ${sqlString(profile.profileVersion)},
      ${sqlString(mode === "outline" ? "h-outline-v2" : "h-draft-v1")},
      ${sqlString(inputHash)}, ${sqlJson(inputSnapshot)},
      ${generationError ? sqlString(formatErrorMessage(generationError)) : "NULL"},
      ${sqlString(actor.id)}
    );
    SELECT JSON_OBJECT('id', LAST_INSERT_ID());
  `);
  await finishHGenerationRun(idempotencyKey, generationError);
  await saveHAuditLog("draft", row?.id || "", "draft.generate", actor, {
    topicId: Number(topicId),
    mode,
    versionNo,
    model: generationError ? "fallback" : hColumnConfig.model,
    generationFailed: Boolean(generationError),
  });
  return getHDraft(row?.id);
}

async function saveHDraftRevision(draftId, data, actor) {
  const draft = await getHDraft(draftId);
  if (!draft) return null;
  const versionRow = await mysqlJson(`
    SELECT JSON_OBJECT('nextVersion', COALESCE(MAX(version_no), 0) + 1)
    FROM yimin_h_drafts
    WHERE topic_id = ${sqlNumber(draft.topicId)}
      AND mode = ${sqlString(draft.mode)};
  `);
  const title = sanitizeTextArtifacts(String(data.title ?? draft.title));
  const outlineMarkdown = sanitizeTextArtifacts(String(data.outlineMarkdown ?? draft.outlineMarkdown));
  const contentMarkdown = sanitizeTextArtifacts(String(data.contentMarkdown ?? draft.contentMarkdown));
  const versionNo = Number(versionRow?.nextVersion || (draft.versionNo + 1));
  const inputHash = createHash("sha256").update(JSON.stringify({
    parentDraftId: draft.id,
    title,
    outlineMarkdown,
    contentMarkdown,
    editedBy: actor.id,
  })).digest("hex");
  const row = await mysqlJson(`
    INSERT INTO yimin_h_drafts (
      topic_id, parent_draft_id, mode, version_no, title,
      title_candidates_json, outline_markdown, content_markdown, content_html,
      extras_json, pending_facts_json, status, readiness, provider, model,
      skill_version, profile_version, prompt_version, input_hash,
      input_snapshot_json, created_by
    )
    VALUES (
      ${sqlNumber(draft.topicId)}, ${sqlNumber(draft.id)}, ${sqlString(draft.mode)},
      ${sqlNumber(versionNo)}, ${sqlString(title)}, ${sqlJson(draft.titleCandidates || [])},
      ${sqlString(outlineMarkdown)}, ${sqlString(contentMarkdown)},
      ${sqlString(markdownToHtml(contentMarkdown))}, ${sqlJson(draft.extras || {})},
      ${sqlJson(data.pendingFacts ?? draft.pendingFacts ?? [])}, 'drafted',
      'review_required', ${sqlString(draft.provider)}, ${sqlString(draft.model)},
      ${sqlString(draft.skillVersion)}, ${sqlString(draft.profileVersion)},
      ${sqlString(draft.mode === "outline" ? "h-outline-manual-v1" : "h-manual-edit-v1")},
      ${sqlString(inputHash)}, ${sqlJson({ parentDraftId: draft.id })},
      ${sqlString(actor.id)}
    );
    SELECT JSON_OBJECT('id', LAST_INSERT_ID());
  `);
  await saveHAuditLog("draft", row?.id || "", "draft.revise", actor, {
    topicId: Number(draft.topicId),
    parentDraftId: Number(draft.id),
    mode: draft.mode,
    versionNo,
  });
  return getHDraft(row?.id);
}

function buildHReviewedRevisionPrompt(
  topic,
  draft,
  review,
  sources,
  viewpoints,
  profile,
  targetMode = draft.mode,
  { fromOutline = false } = {},
) {
  const channel = targetMode === "outline"
    ? {
        label: "内容大纲",
        length: "以清晰完整为准",
        requirements: ["确认一个主轴", "列出事实依据和边界", "组织3—5个独立论点", "保留风险、反面和读者行动"],
      }
    : profile.channelModes?.[targetMode] || profile.channelModes?.wechat_article || {};
  const isChannelAdaptation = targetMode !== draft.mode;
  const sourceLabel = fromOutline ? "选中的内容大纲" : "当前渠道稿";
  return `请基于${sourceLabel}，直接生成一份可继续审阅的 Henry 内容新稿。不要只给修改建议。

来源模式：${draft.mode}
目标模式：${targetMode}
渠道名称：${channel.label || targetMode}
建议长度：${channel.length || ""}
渠道要求：${JSON.stringify(channel.requirements || [])}
任务性质：${isChannelAdaptation ? "从选中大纲独立生成目标渠道版本" : "按最新审校意见修订当前渠道版本"}

只返回一个严格 JSON 对象，不要 Markdown 代码围栏：
{
  "titleCandidates":["最多8个标题"],
  "recommendedTitle":"推荐标题",
  "outlineMarkdown":"修订后的大纲 Markdown",
  "contentMarkdown":"${targetMode === "outline" ? "与 outlineMarkdown 一致的结构化内容大纲" : "修订后的完整正文或口播 Markdown"}",
  "extras":{
    "recommendationReason":"推荐标题理由",
    "summary":"公众号摘要或视频定位",
    "coverText":"视频封面或文章封面文案",
    "visualSuggestions":["配图、画面、字幕或B-roll节点"]
  },
  "pendingFacts":["修订后仍需人工确认或补充来源的事实"],
  "verificationNotes":["发布前核验提示"]
}

生成规则：
${review ? "- 逐项处理最新审校的 requiredActions 和 issues。" : "- 当前大纲没有可用的最新审校；依据大纲、当前事实包和已确认观点生成，所有渠道稿生成后再独立审校。"}
- 输出完整新稿，不输出修改说明或思维过程。
- 目标渠道稿必须从事实包、已确认观点和选中大纲独立组织，不得把公众号文章机械缩写成视频稿。
- 审校意见若要求补充当前事实包没有的信息，不得虚构；应删除过强表述、改为有边界的表达，并列入 pendingFacts。
- 只能把“已确认观点”写成 Henry 的第一人称判断，不得把系统建议角度冒充本人观点。
- 不得虚构个人经历、客户案例、公司事实、日期、金额、资格、结果、对话或情绪。
- 保留政策状态、适用对象、时间条件和不确定性；不得使用保证获批、绝对安全、零风险等承诺。
- 保持一个主轴，先讲判断，再说明前提、事实、原因、风险和读者行动。
- 新稿仍需再次运行四层审校，不能宣称已经可发布。
${targetMode === "outline" ? "- 当前目标是内容大纲，只保留主轴、事实边界、核心观点、论点、风险和行动。" : ""}

人物定位：
${profile.positioning}

禁止内容：
${JSON.stringify(profile.prohibitedContent || [])}

选题：
${JSON.stringify({
    title: topic.title,
    eventSummary: topic.eventSummary,
    coreQuestion: topic.coreQuestion,
    suggestedAngle: topic.suggestedAngle,
    targetAudience: topic.targetAudience,
    contentArchetype: topic.contentArchetype,
  })}

可用的最新四层审校：
${review ? JSON.stringify(review) : "无；渠道稿生成后必须分别运行四层审校"}

已确认观点：
${JSON.stringify(viewpoints.filter((item) => item.isConfirmed).map((item) => ({
    inputType: item.inputType,
    text: item.editedText || item.rawText,
    confirmationType: item.confirmationType,
    confirmedBy: item.confirmedBy,
  })))}

事实包：
${JSON.stringify(sources.map((source) => ({
    sourceName: source.sourceName,
    title: source.title,
    url: source.url,
    publishedAt: source.publishedAt,
    contentStatus: source.contentStatus,
    sourceLevel: source.sourceLevel,
    policyStatus: source.policyStatus,
    evidenceSummary: source.evidenceSummary,
    text: String(source.extractedText || "").slice(0, 22000),
  })))}

当前标题：
${draft.title}

当前大纲：
${draft.outlineMarkdown}

当前正文：
${draft.contentMarkdown}`;
}

async function generateHDraftFromReview(draftId, data = {}, actor) {
  const draft = await getHDraft(draftId);
  if (!draft) return null;
  const fromOutline = data.fromOutline === true;
  const latestReview = await getLatestHDraftReview(draftId);
  if (!fromOutline && !latestReview) {
    const error = new Error("请先运行四层审校，再生成修订稿");
    error.code = "H_REVIEW_REQUIRED";
    throw error;
  }
  const targetMode = normalizeHMode(data.mode, draft.mode);
  if (fromOutline && draft.mode !== "outline") {
    const error = new Error("请先选择一个内容大纲，再生成整套稿件");
    error.code = "H_OUTLINE_REQUIRED";
    throw error;
  }
  if (fromOutline && !["wechat_article", "short_video", "run_and_talk_video", "deep_video"].includes(targetMode)) {
    const error = new Error("请选择公众号文章、H快评、H边跑边聊或H深聊");
    error.code = "H_CHANNEL_MODE_REQUIRED";
    throw error;
  }
  const topic = fromOutline
    ? await refreshHTopicReadiness(draft.topicId)
    : await getHTopicBase(draft.topicId);
  if (!topic) return null;
  if (fromOutline && topic.status !== "selected") {
    const error = new Error("请先选择“值得写”，再生成整套稿件");
    error.code = "H_TOPIC_NOT_SELECTED";
    throw error;
  }
  const [sources, viewpoints, profile] = await Promise.all([
    listHTopicSources(draft.topicId),
    listHTopicViewpoints(draft.topicId),
    loadHContentProfile(),
  ]);
  const reviewIsStale = latestReview && isHDraftReviewStale(latestReview, sources, viewpoints);
  if (!fromOutline && reviewIsStale) {
    const error = new Error("事实包或 Henry 观点在审校后发生变化，请重新运行四层审校");
    error.code = "H_DRAFT_REVIEW_STALE";
    throw error;
  }
  const review = fromOutline || reviewIsStale ? null : latestReview;
  const inputSnapshot = {
    parentDraftId: Number(draft.id),
    parentContentHash: createHash("sha256").update(String(draft.contentMarkdown || "")).digest("hex"),
    review,
    sources: sources.map((source) => ({
      id: source.id,
      contentStatus: source.contentStatus,
      sourceLevel: source.sourceLevel,
      policyStatus: source.policyStatus,
      contentHash: createHash("sha256").update(String(source.extractedText || "")).digest("hex"),
    })),
    viewpoints: viewpoints.filter((item) => item.isConfirmed).map((item) => ({
      id: item.id,
      text: item.editedText || item.rawText,
      confirmationType: item.confirmationType,
      confirmedBy: item.confirmedBy,
    })),
    sourceMode: draft.mode,
    targetMode,
    skillVersion: profile.skillVersion,
    profileVersion: profile.profileVersion,
  };
  const inputHash = createHash("sha256").update(JSON.stringify(inputSnapshot)).digest("hex");
  const versionRow = await mysqlJson(`
    SELECT JSON_OBJECT('nextVersion', COALESCE(MAX(version_no), 0) + 1)
    FROM yimin_h_drafts
    WHERE topic_id = ${sqlNumber(draft.topicId)}
      AND mode = ${sqlString(targetMode)};
  `);
  const versionNo = Number(versionRow?.nextVersion || (targetMode === draft.mode ? draft.versionNo + 1 : 1));
  const idempotencyKey = createHash("sha256")
    .update(`review-revision:${draft.id}:${review?.id || "no-review"}:${targetMode}:${inputHash}:${versionNo}`)
    .digest("hex");
  await beginHGenerationRun("draft", draft.id, idempotencyKey, hColumnConfig.model);

  let generated;
  try {
    const content = await callDeepSeek(
      buildHReviewedRevisionPrompt(
        topic,
        draft,
        review,
        sources,
        viewpoints,
        profile,
        targetMode,
        { fromOutline },
      ),
      {
        model: hColumnConfig.model,
        temperature: targetMode === "outline" ? 0.25 : 0.42,
        systemPrompt: "你是 Henry 内容工作台的资深内容编辑。依据选中大纲、当前事实包和已确认观点输出目标渠道完整稿件。不得虚构事实或 Henry 观点。只输出严格 JSON。",
      },
    );
    generated = parseDeepSeekJsonObject(content);
    if (!String(generated.contentMarkdown || generated.outlineMarkdown || "").trim()) {
      throw new Error("模型未返回完整修订稿");
    }
  } catch (error) {
    await finishHGenerationRun(idempotencyKey, error);
    const generationError = new Error(`修订稿生成失败：${formatErrorMessage(error)}`);
    generationError.code = "H_DRAFT_GENERATION_FAILED";
    throw generationError;
  }

  const titleCandidates = Array.isArray(generated.titleCandidates)
    ? generated.titleCandidates.map((value) => sanitizeTextArtifacts(String(value))).filter(Boolean).slice(0, 8)
    : [];
  const title = sanitizeTextArtifacts(String(generated.recommendedTitle || titleCandidates[0] || draft.title));
  const outlineMarkdown = sanitizeTextArtifacts(String(generated.outlineMarkdown || draft.outlineMarkdown || ""));
  const contentMarkdown = sanitizeTextArtifacts(String(generated.contentMarkdown || outlineMarkdown));
  const pendingFacts = Array.isArray(generated.pendingFacts)
    ? generated.pendingFacts.map((value) => sanitizeTextArtifacts(String(value))).filter(Boolean)
    : [];
  const extras = sanitizeStructuredTextArtifacts({
    ...(generated.extras && typeof generated.extras === "object" ? generated.extras : {}),
    verificationNotes: Array.isArray(generated.verificationNotes) ? generated.verificationNotes : [],
    ...(review ? { revisedFromReviewId: Number(review.id) } : {}),
  });
  const promptVersion = fromOutline && targetMode !== "outline"
    ? "h-channel-from-outline-v1"
    : targetMode === "outline"
      ? "h-outline-revision-v1"
      : "h-review-revision-v1";
  let row;
  try {
    row = await mysqlJson(`
      INSERT INTO yimin_h_drafts (
        topic_id, parent_draft_id, mode, version_no, title,
        title_candidates_json, outline_markdown, content_markdown, content_html,
        extras_json, pending_facts_json, status, readiness, provider, model,
        skill_version, profile_version, prompt_version, input_hash,
        input_snapshot_json, generation_error, created_by
      )
      VALUES (
        ${sqlNumber(draft.topicId)}, ${sqlNumber(draft.id)}, ${sqlString(targetMode)},
        ${sqlNumber(versionNo)}, ${sqlString(title)}, ${sqlJson(titleCandidates)},
        ${sqlString(outlineMarkdown)}, ${sqlString(contentMarkdown)},
        ${sqlString(markdownToHtml(contentMarkdown))}, ${sqlJson(extras)},
        ${sqlJson(pendingFacts)}, 'drafted', 'review_required',
        'openai-compatible', ${sqlString(hColumnConfig.model)},
        ${sqlString(profile.skillVersion)}, ${sqlString(profile.profileVersion)},
        ${sqlString(promptVersion)}, ${sqlString(inputHash)}, ${sqlJson(inputSnapshot)},
        NULL, ${sqlString(actor.id)}
      );
      SELECT JSON_OBJECT('id', LAST_INSERT_ID());
    `);
  } catch (error) {
    await finishHGenerationRun(idempotencyKey, error);
    throw error;
  }
  await finishHGenerationRun(idempotencyKey);
  await saveHAuditLog("draft", row?.id || "", "draft.generate_from_review", actor, {
    topicId: Number(draft.topicId),
    parentDraftId: Number(draft.id),
    reviewId: review ? Number(review.id) : null,
    sourceMode: draft.mode,
    fromOutline,
    mode: targetMode,
    versionNo,
    model: hColumnConfig.model,
  });
  return getHDraft(row?.id);
}

function parseHAutomationBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function normalizeHPreGenerationModes(value) {
  const requested = Array.isArray(value)
    ? value
    : String(value || "").split(",");
  const configured = requested.map((item) => String(item || "").trim()).filter(Boolean);
  const source = configured.length ? configured : hColumnConfig.preGenerateModes;
  const modes = source
    .map((item) => normalizeHMode(item, ""))
    .filter((mode) => mode && mode !== "outline");
  return [...new Set(modes.length ? modes : [
    "wechat_article",
    "short_video",
    "run_and_talk_video",
    "deep_video",
  ])];
}

function normalizeHPreGenerationTopicIds(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(values
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0))]
    .slice(0, hColumnConfig.maxTopics);
}

async function getLatestUsableHDraft(topicId, mode) {
  const row = await mysqlJson(`
    SELECT JSON_OBJECT('id', id)
    FROM yimin_h_drafts
    WHERE topic_id = ${sqlNumber(topicId)}
      AND mode = ${sqlString(mode)}
      AND status <> 'failed'
      AND generation_error IS NULL
    ORDER BY id DESC
    LIMIT 1;
  `);
  return row?.id ? getHDraft(row.id) : null;
}

function waitForHPreGenerationRetry(attempt) {
  const delayMs = hColumnConfig.preGenerateRetryDelayMs * Math.max(1, attempt);
  return delayMs > 0
    ? new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs))
    : Promise.resolve();
}

async function generateHOutlineWithRetry(topicId, actor) {
  let lastDraft = null;
  for (let attempt = 1; attempt <= hColumnConfig.preGenerateMaxAttempts; attempt += 1) {
    lastDraft = await generateHDraft(topicId, {
      mode: "outline",
      refresh: true,
    }, actor);
    if (lastDraft && !lastDraft.generationError) {
      return {
        draft: lastDraft,
        attempts: attempt,
      };
    }
    if (attempt < hColumnConfig.preGenerateMaxAttempts) {
      await waitForHPreGenerationRetry(attempt);
    }
  }
  const error = new Error(
    lastDraft?.generationError
      ? `大纲生成自动重试 ${hColumnConfig.preGenerateMaxAttempts} 次后仍失败：${lastDraft.generationError}`
      : `大纲生成自动重试 ${hColumnConfig.preGenerateMaxAttempts} 次后仍未返回内容`,
  );
  error.code = "H_OUTLINE_GENERATION_FAILED";
  throw error;
}

async function generateHChannelWithRetry(outlineId, mode, actor) {
  let lastError = null;
  for (let attempt = 1; attempt <= hColumnConfig.preGenerateMaxAttempts; attempt += 1) {
    try {
      const draft = await generateHDraftFromReview(outlineId, {
        fromOutline: true,
        mode,
      }, actor);
      return {
        mode,
        id: Number(draft.id),
        versionNo: Number(draft.versionNo),
        created: true,
        attempts: attempt,
        recoveredAfterRetry: attempt > 1,
      };
    } catch (error) {
      lastError = error;
      if (attempt < hColumnConfig.preGenerateMaxAttempts) {
        await waitForHPreGenerationRetry(attempt);
      }
    }
  }
  return {
    mode,
    created: false,
    attempts: hColumnConfig.preGenerateMaxAttempts,
    error: lastError instanceof Error ? lastError.message : String(lastError),
    code: lastError?.code || "",
  };
}

async function preGenerateHTopicArticles(
  topic,
  {
    modes,
    refreshDrafts = false,
    actor = hAutomationActor,
  } = {},
) {
  const requestedModes = normalizeHPreGenerationModes(modes);
  if (["later", "rejected", "archived"].includes(topic.status)) {
    return {
      topicId: Number(topic.id),
      title: topic.title,
      status: "skipped",
      reason: `选题状态为 ${topic.status}，保留人工决定`,
      outlineDraftId: null,
      drafts: [],
    };
  }
  if (topic.readiness === "not_recommended") {
    return {
      topicId: Number(topic.id),
      title: topic.title,
      status: "skipped",
      reason: "H 四问仅满足 0—1 项，暂不自动成稿",
      outlineDraftId: null,
      drafts: [],
    };
  }

  const existingDrafts = new Map();
  if (!refreshDrafts) {
    const rows = await Promise.all(
      requestedModes.map(async (mode) => [mode, await getLatestUsableHDraft(topic.id, mode)]),
    );
    rows.forEach(([mode, draft]) => {
      if (draft) existingDrafts.set(mode, draft);
    });
    if (existingDrafts.size === requestedModes.length) {
      return {
        topicId: Number(topic.id),
        title: topic.title,
        status: "existing",
        reason: "已存在可编辑文章版本",
        outlineDraftId: null,
        drafts: requestedModes.map((mode) => ({
          mode,
          id: Number(existingDrafts.get(mode).id),
          versionNo: Number(existingDrafts.get(mode).versionNo),
          created: false,
          attempts: 0,
          recoveredAfterRetry: false,
        })),
      };
    }
  }

  const preparedTopic = topic.status === "selected"
    ? await fetchHTopicEvidence(topic.id, actor)
    : await updateHTopic(topic.id, { status: "selected" }, actor);
  if (!preparedTopic) {
    throw new Error("选题不存在");
  }
  if (preparedTopic.readiness === "not_recommended") {
    return {
      topicId: Number(topic.id),
      title: topic.title,
      status: "skipped",
      reason: "补充事实后仍不满足自动成稿条件",
      outlineDraftId: null,
      drafts: [],
    };
  }

  let outline = refreshDrafts ? null : await getLatestUsableHDraft(topic.id, "outline");
  let outlineAttempts = 0;
  if (!outline) {
    const outlineResult = await generateHOutlineWithRetry(topic.id, actor);
    outline = outlineResult.draft;
    outlineAttempts = outlineResult.attempts;
  }
  if (!outline) {
    throw new Error("大纲生成失败");
  }

  const draftResults = await runWithConcurrency(requestedModes, 2, async (mode) => {
    const existing = existingDrafts.get(mode);
    if (existing && !refreshDrafts) {
      return {
        mode,
        id: Number(existing.id),
        versionNo: Number(existing.versionNo),
        created: false,
        attempts: 0,
        recoveredAfterRetry: false,
      };
    }
    return generateHChannelWithRetry(outline.id, mode, actor);
  });
  const failedCount = draftResults.filter((draft) => draft.error).length;
  const createdCount = draftResults.filter((draft) => draft.created).length;
  const retriedCount = draftResults.filter((draft) => Number(draft.attempts || 0) > 1).length;
  return {
    topicId: Number(topic.id),
    title: topic.title,
    status: failedCount
      ? (failedCount === draftResults.length ? "failed" : "partial_failed")
      : (createdCount ? "generated" : "existing"),
    reason: failedCount
      ? `部分或全部渠道自动重试 ${hColumnConfig.preGenerateMaxAttempts} 次后仍失败，可再次请求补跑`
      : "",
    outlineDraftId: Number(outline.id),
    outlineAttempts,
    retriedChannelCount: retriedCount,
    drafts: draftResults,
  };
}

async function preGenerateHArticles({
  date = getShanghaiDate(),
  topicIds = [],
  modes = hColumnConfig.preGenerateModes,
  limit = hColumnConfig.maxTopics,
  refreshTopics = false,
  refreshDrafts = false,
  actor = hAutomationActor,
} = {}) {
  await initDb();
  const normalizedTopicIds = normalizeHPreGenerationTopicIds(topicIds);
  const normalizedModes = normalizeHPreGenerationModes(modes);
  const safeLimit = Math.min(
    hColumnConfig.maxTopics,
    Math.max(1, Number(limit) || hColumnConfig.maxTopics),
  );
  let sourceTopics;
  if (normalizedTopicIds.length) {
    sourceTopics = (await Promise.all(normalizedTopicIds.map((topicId) => getHTopicBase(topicId))))
      .filter(Boolean)
      .filter((topic) => topic.date === date);
  } else {
    sourceTopics = await generateHTopics(date, {
      refresh: refreshTopics,
      actor,
    });
  }
  const topics = sourceTopics
    .filter((topic) => ["candidate", "selected", "later", "rejected"].includes(topic.status))
    .slice(0, safeLimit);
  const startedAt = formatShanghaiDateTimeISO(new Date());
  const results = await runWithConcurrency(
    topics,
    hColumnConfig.preGenerateConcurrency,
    async (topic) => {
      try {
        return await preGenerateHTopicArticles(topic, {
          modes: normalizedModes,
          refreshDrafts,
          actor,
        });
      } catch (error) {
        return {
          topicId: Number(topic.id),
          title: topic.title,
          status: "failed",
          reason: error instanceof Error ? error.message : String(error),
          code: error?.code || "",
          outlineDraftId: null,
          drafts: [],
        };
      }
    },
  );
  const failedTopicCount = results.filter((item) => ["failed", "partial_failed"].includes(item.status)).length;
  const skippedTopicCount = results.filter((item) => item.status === "skipped").length;
  const generatedArticleCount = results
    .flatMap((item) => item.drafts || [])
    .filter((draft) => draft.created && !draft.error)
    .length;
  const existingArticleCount = results
    .flatMap((item) => item.drafts || [])
    .filter((draft) => !draft.created && !draft.error && draft.id)
    .length;
  const retriedChannelCount = results
    .flatMap((item) => item.drafts || [])
    .filter((draft) => Number(draft.attempts || 0) > 1)
    .length;
  const result = {
    ok: failedTopicCount === 0,
    date,
    status: failedTopicCount ? "partial_failed" : "completed",
    modes: normalizedModes,
    refreshTopics,
    refreshDrafts,
    requestedTopicCount: topics.length,
    generatedArticleCount,
    existingArticleCount,
    retriedChannelCount,
    skippedTopicCount,
    failedTopicCount,
    startedAt,
    finishedAt: formatShanghaiDateTimeISO(new Date()),
    topics: results,
  };
  await saveHAuditLog("topic_date", date, "articles.pre_generate", actor, {
    modes: normalizedModes,
    refreshTopics,
    refreshDrafts,
    requestedTopicCount: topics.length,
    generatedArticleCount,
    existingArticleCount,
    retriedChannelCount,
    skippedTopicCount,
    failedTopicCount,
  });
  return result;
}

function startHArticlePreGenerationInBackground(date, options = {}) {
  if (hArticlePreGenerationPromises.has(date)) {
    return hArticlePreGenerationPromises.get(date);
  }
  hArticlePreGenerationResults.set(date, {
    ok: true,
    date,
    status: "running",
    running: true,
    startedAt: formatShanghaiDateTimeISO(new Date()),
  });
  const promise = preGenerateHArticles({ ...options, date })
    .then((result) => {
      hArticlePreGenerationResults.set(date, { ...result, running: false });
      return result;
    })
    .catch((error) => {
      const result = {
        ok: false,
        date,
        status: "failed",
        running: false,
        error: error instanceof Error ? error.message : String(error),
        code: error?.code || "",
        finishedAt: formatShanghaiDateTimeISO(new Date()),
      };
      hArticlePreGenerationResults.set(date, result);
      console.error(`H article pre-generation failed for ${date}:`, result.error);
      return result;
    })
    .finally(() => hArticlePreGenerationPromises.delete(date));
  hArticlePreGenerationPromises.set(date, promise);
  return promise;
}

function isHArticlePreGenerationRunning(date) {
  return hArticlePreGenerationPromises.has(date);
}

function buildHReviewPrompt(topic, draft, sources, viewpoints, profile, recentTopics) {
  return `请对 Henry 内容草稿执行四层发布前质检，只返回严格 JSON 对象。

格式：
{
  "conclusion":"ready_for_henry|facts_required|not_recommended",
  "l1Status":"passed|needs_revision",
  "l2Status":"passed|needs_revision",
  "l3Status":"passed|needs_revision",
  "l4Status":"passed|needs_revision",
  "issues":[{"layer":"L1|L2|L3|L4","message":"可验证问题","evidence":"对应事实或原文位置"}],
  "pendingFacts":["待确认事实"],
  "requiredActions":["本人审阅前必须处理"]
}

标准：
L1 ${profile.qualityGates?.l1 || ""}
L2 ${profile.qualityGates?.l2 || ""}
L3 ${profile.qualityGates?.l3 || ""}
L4 ${profile.qualityGates?.l4 || ""}

硬规则：
- 只有标题或摘要不能当完整原文。
- 政策、法律、税务和投资的确定性核心事实需要 A 级完整来源。
- 强第一人称判断必须来自已确认观点。
- 禁止虚构经历、客户、公司事实、情绪、对话或数字。
- 发现必须修改项时不得输出 ready_for_henry。
- 不输出思维过程，只列问题、证据和动作。

禁止内容：
${JSON.stringify(profile.prohibitedContent || [])}

选题：
${JSON.stringify(topic)}

已确认观点：
${JSON.stringify(viewpoints.filter((item) => item.isConfirmed).map((item) => ({
    text: item.editedText || item.rawText,
    confirmationType: item.confirmationType,
    confirmedBy: item.confirmedBy,
  })))}

事实来源：
${JSON.stringify(sources.map((source) => ({
    title: source.title,
    url: source.url,
    contentStatus: source.contentStatus,
    sourceLevel: source.sourceLevel,
    policyStatus: source.policyStatus,
    evidenceSummary: source.evidenceSummary,
    text: String(source.extractedText || "").slice(0, 16000),
  })))}

近30天候选：
${JSON.stringify(recentTopics)}

草稿：
${draft.contentMarkdown}`;
}

async function reviewHDraft(draftId, actor) {
  const draft = await getHDraft(draftId);
  if (!draft) return null;
  const topic = await getHTopicBase(draft.topicId);
  const [sources, viewpoints, profile, recentTopics] = await Promise.all([
    listHTopicSources(draft.topicId),
    listHTopicViewpoints(draft.topicId),
    loadHContentProfile(),
    listRecentHTopicTitles(topic.date),
  ]);
  const inputHash = createHash("sha256").update(JSON.stringify({
    draftId,
    content: draft.contentMarkdown,
    sources: sources.map((source) => ({
      id: source.id,
      contentStatus: source.contentStatus,
      sourceLevel: source.sourceLevel,
      policyStatus: source.policyStatus,
      contentHash: createHash("sha256").update(String(source.extractedText || "")).digest("hex"),
    })),
    viewpoints: viewpoints.filter((item) => item.isConfirmed).map((item) => item.id),
    profileVersion: profile.profileVersion,
  })).digest("hex");
  const idempotencyKey = createHash("sha256").update(`review:${draftId}:${inputHash}`).digest("hex");
  await beginHGenerationRun("review", draftId, idempotencyKey, hColumnConfig.reviewModel);
  let result;
  let reviewError = null;
  try {
    const content = await callDeepSeek(
      buildHReviewPrompt(topic, draft, sources, viewpoints, profile, recentTopics),
      {
        model: hColumnConfig.reviewModel,
        temperature: 0.1,
        systemPrompt: "你是 Henry 内容的事实核验与发布前审校编辑。只输出严格 JSON，不输出思维过程。发现事实、本人判断或隐私边界问题时必须阻止进入本人审阅。",
      },
    );
    result = parseDeepSeekJsonObject(content);
  } catch (error) {
    reviewError = error;
    result = {
      conclusion: "facts_required",
      l1Status: "needs_revision",
      l2Status: "needs_revision",
      l3Status: "needs_revision",
      l4Status: "needs_revision",
      issues: [{ layer: "L1", message: "AI 审校暂不可用，需要人工完成四层质检", evidence: formatErrorMessage(error) }],
      pendingFacts: draft.pendingFacts || [],
      requiredActions: ["人工核对全部事实、观点来源、禁区和渠道节奏"],
    };
  }

  const highRisk = isHHighRiskTopic(topic);
  const hasRequiredEvidence = highRisk
    ? sources.some((source) => source.contentStatus === "full" && source.sourceLevel === "A" && source.verifiedAt)
    : sources.some((source) => source.contentStatus === "full" && source.verifiedAt);
  const hasConfirmedViewpoint = viewpoints.some((item) => item.isConfirmed);
  const issues = sanitizeStructuredTextArtifacts(Array.isArray(result.issues) ? result.issues : []);
  const pendingFacts = sanitizeStructuredTextArtifacts(Array.isArray(result.pendingFacts) ? result.pendingFacts : []);
  const requiredActions = sanitizeStructuredTextArtifacts(Array.isArray(result.requiredActions) ? result.requiredActions : []);
  if (!hasRequiredEvidence) {
    issues.push({
      layer: "L1",
      message: highRisk ? "缺少 A 级完整来源" : "缺少完整来源",
      evidence: "事实包门槛未通过",
    });
    requiredActions.push("补充并核验满足门槛的完整来源");
  }
  if (!hasConfirmedViewpoint) {
    issues.push({
      layer: "L1",
      message: "缺少 H 专栏成员确认的本次观点",
      evidence: "观点确认门槛未通过",
    });
    requiredActions.push("确认本次核心观点");
  }
  let conclusion = ["ready_for_henry", "facts_required", "not_recommended"].includes(result.conclusion)
    ? result.conclusion
    : "facts_required";
  if (!hasRequiredEvidence || !hasConfirmedViewpoint || reviewError) conclusion = "facts_required";
  const normalizeLayer = (value) => value === "passed" ? "passed" : "needs_revision";
  let l1Status = normalizeLayer(result.l1Status);
  const l2Status = normalizeLayer(result.l2Status);
  const l3Status = normalizeLayer(result.l3Status);
  const l4Status = normalizeLayer(result.l4Status);
  if (!hasRequiredEvidence || !hasConfirmedViewpoint || reviewError) l1Status = "needs_revision";
  if ([l1Status, l2Status, l3Status, l4Status].includes("needs_revision")) {
    if (conclusion === "ready_for_henry") conclusion = "facts_required";
  }

  await mysqlExec(`
    INSERT INTO yimin_h_reviews (
      draft_id, conclusion, l1_status, l2_status, l3_status, l4_status,
      issues_json, pending_facts_json, required_actions_json, model,
      prompt_version, input_hash, reviewed_at
    )
    VALUES (
      ${sqlNumber(draftId)}, ${sqlString(conclusion)}, ${sqlString(l1Status)},
      ${sqlString(l2Status)}, ${sqlString(l3Status)}, ${sqlString(l4Status)},
      ${sqlJson(issues)}, ${sqlJson(pendingFacts)}, ${sqlJson(requiredActions)},
      ${sqlString(reviewError ? "fallback" : hColumnConfig.reviewModel)},
      'h-review-v1', ${sqlString(inputHash)}, CURRENT_TIMESTAMP
    );
    UPDATE yimin_h_drafts
    SET status = ${sqlString(conclusion === "ready_for_henry" ? "ready_for_henry" : "needs_revision")},
        readiness = ${sqlString(conclusion === "ready_for_henry" ? "ready_for_henry" : "facts_required")}
    WHERE id = ${sqlNumber(draftId)};
  `);
  await finishHGenerationRun(idempotencyKey, reviewError);
  await saveHAuditLog("draft", draftId, "draft.review", actor, {
    topicId: Number(draft.topicId),
    conclusion,
    reviewModel: reviewError ? "fallback" : hColumnConfig.reviewModel,
    reviewFailed: Boolean(reviewError),
  });
  return getHTopicDetail(draft.topicId);
}

async function markHDraftReviewed(draftId, actor) {
  const draft = await getHDraft(draftId);
  if (!draft) return null;
  if (draft.status !== "ready_for_henry") {
    const error = new Error("草稿尚未通过四层质检，不能标记已审阅");
    error.code = "H_DRAFT_NOT_READY";
    throw error;
  }
  await assertHDraftReviewCurrent(draft);
  await mysqlExec(`
    UPDATE yimin_h_drafts
    SET status = 'henry_reviewed'
    WHERE id = ${sqlNumber(draftId)};
  `);
  await saveHAuditLog("draft", draftId, "draft.mark_reviewed", actor, {
    topicId: Number(draft.topicId),
  });
  return getHTopicDetail(draft.topicId);
}

async function returnHDraftForRevision(draftId, data, actor) {
  const draft = await getHDraft(draftId);
  if (!draft) return null;
  if (!["ready_for_henry", "henry_reviewed"].includes(draft.status)) {
    const error = new Error("只有进入本人审阅的草稿才能退回修改");
    error.code = "H_DRAFT_NOT_READY";
    throw error;
  }
  await mysqlExec(`
    UPDATE yimin_h_drafts
    SET status = 'needs_revision',
        readiness = 'facts_required'
    WHERE id = ${sqlNumber(draftId)};
  `);
  await saveHFeedback(
    draft.topicId,
    draftId,
    "revise",
    "returned_for_revision",
    sanitizeTextArtifacts(String(data?.note || "").trim()),
    actor,
  );
  await saveHAuditLog("draft", draftId, "draft.return_for_revision", actor, {
    topicId: Number(draft.topicId),
    hadNote: Boolean(String(data?.note || "").trim()),
  });
  return getHTopicDetail(draft.topicId);
}

async function approveHDraft(draftId, actor) {
  const draft = await getHDraft(draftId);
  if (!draft) return null;
  if (!["ready_for_henry", "henry_reviewed"].includes(draft.status)) {
    const error = new Error("草稿尚未通过四层质检，不能最终采用");
    error.code = "H_DRAFT_NOT_READY";
    throw error;
  }
  await assertHDraftReviewCurrent(draft);
  await mysqlExec(`
    UPDATE yimin_h_drafts
    SET status = 'approved',
        approved_by = ${sqlString(actor.id)},
        approval_type = ${sqlString(actor.confirmationType)},
        approved_at = CURRENT_TIMESTAMP
    WHERE id = ${sqlNumber(draftId)};
  `);
  await saveHFeedback(draft.topicId, draftId, "use", "approved", "最终采用，仅写入系统日志，不发送企业微信通知。", actor);
  await saveHAuditLog("draft", draftId, "draft.approve", actor, {
    topicId: Number(draft.topicId),
    approvalType: actor.confirmationType,
  });
  return getHTopicDetail(draft.topicId);
}

async function exportHDraftPackage(draftId) {
  const draft = await getHDraft(draftId);
  if (!draft) return null;
  const topic = await getHTopicDetail(draft.topicId);
  const profile = await loadHContentProfile();
  const channel = profile.channelModes?.[draft.mode] || profile.channelModes?.wechat_article || {};
  const sourceLines = (topic.sources || []).map((source, index) => [
    `${index + 1}. ${source.title || source.sourceName || "来源"}`,
    `   - 等级：${source.sourceLevel}；完整度：${source.contentStatus}；政策状态：${source.policyStatus}`,
    `   - 链接：${source.url || "无"}`,
    `   - 可证明事实：${source.evidenceSummary || "待补"}`,
  ].join("\n"));
  const sourceTextBlocks = (topic.sources || []).map((source, index) => [
    `### 来源 ${index + 1}：${source.title || source.sourceName || "来源"}`,
    `- 等级：${source.sourceLevel}；完整度：${source.contentStatus}；政策状态：${source.policyStatus}`,
    `- 链接：${source.url || "无"}`,
    "",
    String(source.extractedText || "").trim()
      ? String(source.extractedText || "").trim().slice(0, 18000)
      : "[未取得正文；不得把标题或摘要当作完整原文]",
  ].join("\n"));
  const viewpointLines = (topic.viewpoints || [])
    .filter((item) => item.isConfirmed)
    .map((item) => `- ${item.editedText || item.rawText}（${item.confirmationType}：${item.confirmedBy}）`);
  return [
    `# H 内容包：${draft.title || topic.title}`,
    "",
    "> 用途：可复制给 Claude、Gemini 或其他模型继续编辑。只能使用本包中的已确认观点和事实；不得把系统建议角度冒充 Henry 本人观点。",
    "",
    "## 任务",
    `- Skill：${profile.skillName || "Henry 文章与视频写作"}`,
    `- 模式：${draft.mode}`,
    `- 渠道：${channel.label || draft.mode}`,
    `- 建议长度：${channel.length || "按内容需要"}`,
    `- 目标读者：${topic.targetAudience}`,
    `- 核心问题：${topic.coreQuestion}`,
    `- 系统建议角度（非本人观点）：${topic.suggestedAngle || "无"}`,
    ...(channel.requirements || []).map((item) => `- 渠道要求：${item}`),
    "",
    "## 已确认观点",
    viewpointLines.length ? viewpointLines.join("\n") : "- 无",
    "",
    "## 事实来源",
    sourceLines.length ? sourceLines.join("\n") : "- 无",
    "",
    "## 来源正文或现有摘录",
    sourceTextBlocks.length ? sourceTextBlocks.join("\n\n") : "- 无",
    "",
    "## 人物与禁区",
    `- 人物定位：${profile.positioning || ""}`,
    `- Skill版本：${profile.skillVersion}`,
    `- 人物档案版本：${profile.profileVersion}`,
    ...(profile.prohibitedContent || []).map((item) => `- 禁止：${item}`),
    "",
    "## 写作与审校硬规则",
    "- 一篇只保留一个主轴；先讲判断，再说明前提、事实、原因、风险和读者行动。",
    "- 只有“已确认观点”可以写成 Henry 的第一人称判断。",
    "- 不虚构个人经历、客户案例、公司事实、日期、金额、资格、结果、对话或情绪。",
    "- 保留政策状态、适用对象、时间条件和不确定性；不得使用保证获批、绝对安全、零风险等承诺。",
    ...Object.entries(profile.qualityGates || {}).map(([layer, rule]) => `- ${layer.toUpperCase()}：${rule}`),
    "",
    "## 当前草稿",
    draft.contentMarkdown,
    "",
    "## 待确认事实",
    ...(draft.pendingFacts || []).map((item) => `- ${item}`),
  ].join("\n");
}

function sendHApiError(res, error) {
  const code = error?.code || "";
  const status = code === "H_DAILY_MISSING"
    || code === "H_TOPIC_NOT_SELECTED"
    || code === "H_TOPIC_NOT_READY"
    || code === "H_DRAFT_NOT_READY"
    || code === "H_REVIEW_REQUIRED"
    || code === "H_DRAFT_REVIEW_STALE"
    || code === "H_OUTLINE_REQUIRED"
    || code === "H_CHANNEL_MODE_REQUIRED"
    ? 409
    : 400;
  sendJson(res, status, {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    code,
  });
}

async function handleHColumnAutomationApi(req, res, url) {
  const generatePath = "/api/h/automation/pre-generate";
  const statusPath = "/api/h/automation/pre-generate/status";
  if (![generatePath, statusPath].includes(url.pathname)) return false;
  if (!hColumnConfig.enabled) {
    sendJson(res, 503, { ok: false, error: "H 专栏未启用" });
    return true;
  }

  const date = String(url.searchParams.get("date") || getShanghaiDate());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    sendJson(res, 400, { ok: false, error: "date must use YYYY-MM-DD" });
    return true;
  }

  if (url.pathname === statusPath) {
    if (req.method !== "GET") {
      sendJson(res, 405, { ok: false, error: "Method not allowed" });
      return true;
    }
    const lastResult = hArticlePreGenerationResults.get(date) || null;
    sendJson(res, 200, {
      ok: true,
      date,
      running: isHArticlePreGenerationRunning(date),
      status: isHArticlePreGenerationRunning(date)
        ? "running"
        : (lastResult?.status || "idle"),
      result: lastResult,
    });
    return true;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return true;
  }
  const body = await readOptionalJsonOrFormBody(req);
  const requestDate = String(body.date || date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestDate)) {
    sendJson(res, 400, { ok: false, error: "date must use YYYY-MM-DD" });
    return true;
  }
  const refresh = parseHAutomationBoolean(body.refresh ?? url.searchParams.get("refresh"));
  const refreshTopics = parseHAutomationBoolean(
    body.refreshTopics ?? url.searchParams.get("refreshTopics"),
    refresh,
  );
  const refreshDrafts = parseHAutomationBoolean(
    body.refreshDrafts ?? url.searchParams.get("refreshDrafts"),
    refresh,
  );
  const sync = parseHAutomationBoolean(body.sync ?? url.searchParams.get("sync"));
  const topicIds = body.topicIds ?? body.topicId ?? url.searchParams.get("topicIds") ?? url.searchParams.get("topicId");
  const modes = body.modes ?? body.mode ?? url.searchParams.get("modes") ?? url.searchParams.get("mode");
  const limit = body.limit ?? url.searchParams.get("limit") ?? hColumnConfig.maxTopics;
  const alreadyRunning = isHArticlePreGenerationRunning(requestDate);
  const promise = startHArticlePreGenerationInBackground(requestDate, {
    topicIds,
    modes,
    limit,
    refreshTopics,
    refreshDrafts,
    actor: hAutomationActor,
  });

  if (!sync) {
    sendJson(res, 202, {
      ok: true,
      date: requestDate,
      running: true,
      status: alreadyRunning ? "running" : "queued",
      modes: normalizeHPreGenerationModes(modes),
      message: "H 专栏文章预生成已在后台开始；重复调用默认复用已有版本，传 refresh=1 可重新生成新版本。",
      statusUrl: `/api/h/automation/pre-generate/status?date=${encodeURIComponent(requestDate)}`,
    });
    return true;
  }

  const result = await promise;
  if (!result.ok && result.error) {
    sendJson(res, result.code === "H_DAILY_MISSING" ? 409 : 500, result);
    return true;
  }
  sendJson(res, result.failedTopicCount ? 207 : 200, result);
  return true;
}

async function handleHColumnApi(req, res, url) {
  if (!url.pathname.startsWith("/api/h/")) return false;
  if (await handleHColumnAutomationApi(req, res, url)) return true;
  const actor = await getHColumnActor(req);
  if (!actor) {
    sendJson(res, 403, {
      ok: false,
      error: "H 专栏仅限 Henry、Celine、IOD 部门成员和系统管理员访问",
    });
    return true;
  }

  if (url.pathname === "/api/h/me" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      enabled: hColumnConfig.enabled,
      actor,
      maxTopics: hColumnConfig.maxTopics,
      model: hColumnConfig.model,
      reviewModel: hColumnConfig.reviewModel,
    });
    return true;
  }

  if (url.pathname === "/api/h/audit" && req.method === "GET") {
    await initDb();
    sendJson(res, 200, {
      ok: true,
      actor,
      logs: await listHAuditLogs(url.searchParams.get("limit")),
    });
    return true;
  }

  if (url.pathname === "/api/h/topics/history" && req.method === "GET") {
    await initDb();
    const topics = (await mysqlJson(`
      SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
        'id', id,
        'date', DATE_FORMAT(topic_date, '%Y-%m-%d'),
        'title', title,
        'status', status,
        'readiness', readiness,
        'primaryMode', primary_mode,
        'updatedAt', DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s+08:00')
      )), JSON_ARRAY())
      FROM (
        SELECT *
        FROM yimin_h_topics
        ORDER BY topic_date DESC, id DESC
        LIMIT 120
      ) h;
    `)) || [];
    sendJson(res, 200, { ok: true, actor, topics });
    return true;
  }

  if (url.pathname === "/api/h/topics" && req.method === "GET") {
    const date = url.searchParams.get("date") || getShanghaiDate();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      sendJson(res, 400, { ok: false, error: "date must use YYYY-MM-DD" });
      return true;
    }
    let topics = await listHTopics(date);
    if (!topics.length && hColumnConfig.autoGenerate) {
      if (url.searchParams.get("sync") === "1") {
        try {
          topics = await generateHTopics(date, { actor });
        } catch (error) {
          sendHApiError(res, error);
          return true;
        }
      } else {
        startHTopicGenerationInBackground(date);
        sendJson(res, 202, {
          ok: true,
          actor,
          date,
          topics: [],
          running: true,
          status: isHTopicGenerationRunning(date) ? "running" : "queued",
        });
        return true;
      }
    }
    sendJson(res, 200, {
      ok: true,
      actor,
      date,
      topics,
      running: isHTopicGenerationRunning(date),
    });
    return true;
  }

  if (url.pathname === "/api/h/topics/generate" && req.method === "POST") {
    const body = await readOptionalJsonOrFormBody(req);
    const date = String(body.date || getShanghaiDate());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      sendJson(res, 400, { ok: false, error: "date must use YYYY-MM-DD" });
      return true;
    }
    try {
      const topics = await generateHTopics(date, {
        refresh: body.refresh === true,
        actor,
      });
      sendJson(res, 200, { ok: true, actor, date, topics });
    } catch (error) {
      sendHApiError(res, error);
    }
    return true;
  }

  const topicMatch = url.pathname.match(/^\/api\/h\/topics\/(\d+)$/);
  if (topicMatch && req.method === "GET") {
    const topic = await getHTopicDetail(topicMatch[1]);
    if (!topic) sendJson(res, 404, { ok: false, error: "选题不存在" });
    else sendJson(res, 200, { ok: true, actor, topic });
    return true;
  }
  if (topicMatch && req.method === "PUT") {
    const body = await readJsonBody(req);
    try {
      const topic = await updateHTopic(topicMatch[1], body, actor);
      if (!topic) sendJson(res, 404, { ok: false, error: "选题不存在" });
      else sendJson(res, 200, { ok: true, actor, topic });
    } catch (error) {
      sendHApiError(res, error);
    }
    return true;
  }

  const evidenceFetchMatch = url.pathname.match(/^\/api\/h\/topics\/(\d+)\/evidence\/fetch$/);
  if (evidenceFetchMatch && req.method === "POST") {
    try {
      const topic = await fetchHTopicEvidence(evidenceFetchMatch[1], actor);
      if (!topic) sendJson(res, 404, { ok: false, error: "选题不存在" });
      else sendJson(res, 200, { ok: true, actor, topic });
    } catch (error) {
      sendHApiError(res, error);
    }
    return true;
  }

  const topicSourcesMatch = url.pathname.match(/^\/api\/h\/topics\/(\d+)\/sources$/);
  if (topicSourcesMatch && req.method === "POST") {
    const body = await readJsonBody(req);
    try {
      const topic = await addHTopicSource(topicSourcesMatch[1], body, actor);
      if (!topic) sendJson(res, 404, { ok: false, error: "选题不存在" });
      else sendJson(res, 201, { ok: true, actor, topic });
    } catch (error) {
      sendHApiError(res, error);
    }
    return true;
  }

  const sourceMatch = url.pathname.match(/^\/api\/h\/sources\/(\d+)$/);
  if (sourceMatch && req.method === "PUT") {
    const body = await readJsonBody(req);
    try {
      const topic = await updateHTopicSource(sourceMatch[1], body, actor);
      if (!topic) sendJson(res, 404, { ok: false, error: "来源不存在" });
      else sendJson(res, 200, { ok: true, actor, topic });
    } catch (error) {
      sendHApiError(res, error);
    }
    return true;
  }
  if (sourceMatch && req.method === "DELETE") {
    const topic = await deleteHTopicSource(sourceMatch[1], actor);
    if (!topic) sendJson(res, 404, { ok: false, error: "来源不存在" });
    else sendJson(res, 200, { ok: true, actor, topic });
    return true;
  }

  const viewpointsMatch = url.pathname.match(/^\/api\/h\/topics\/(\d+)\/viewpoints$/);
  if (viewpointsMatch && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      actor,
      viewpoints: await listHTopicViewpoints(viewpointsMatch[1]),
    });
    return true;
  }
  if (viewpointsMatch && req.method === "POST") {
    const body = await readJsonBody(req);
    try {
      const topic = await addHViewpoint(viewpointsMatch[1], body, actor);
      if (!topic) sendJson(res, 404, { ok: false, error: "选题不存在" });
      else sendJson(res, 201, { ok: true, actor, topic });
    } catch (error) {
      sendHApiError(res, error);
    }
    return true;
  }

  const viewpointMatch = url.pathname.match(/^\/api\/h\/viewpoints\/(\d+)$/);
  if (viewpointMatch && req.method === "PUT") {
    const body = await readJsonBody(req);
    try {
      const topic = await updateHViewpoint(viewpointMatch[1], body, actor);
      if (!topic) sendJson(res, 404, { ok: false, error: "观点不存在" });
      else sendJson(res, 200, { ok: true, actor, topic });
    } catch (error) {
      sendHApiError(res, error);
    }
    return true;
  }
  if (viewpointMatch && req.method === "DELETE") {
    const topic = await deleteHViewpoint(viewpointMatch[1], actor);
    if (!topic) sendJson(res, 404, { ok: false, error: "观点不存在" });
    else sendJson(res, 200, { ok: true, actor, topic });
    return true;
  }

  const viewpointConfirmMatch = url.pathname.match(/^\/api\/h\/viewpoints\/(\d+)\/confirm$/);
  if (viewpointConfirmMatch && req.method === "POST") {
    try {
      const topic = await confirmHViewpoint(viewpointConfirmMatch[1], actor);
      if (!topic) sendJson(res, 404, { ok: false, error: "观点不存在" });
      else sendJson(res, 200, { ok: true, actor, topic });
    } catch (error) {
      sendHApiError(res, error);
    }
    return true;
  }

  const topicDraftsMatch = url.pathname.match(/^\/api\/h\/topics\/(\d+)\/drafts$/);
  if (topicDraftsMatch && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      actor,
      drafts: await listHTopicDrafts(topicDraftsMatch[1]),
    });
    return true;
  }
  if (topicDraftsMatch && req.method === "POST") {
    const body = await readJsonBody(req);
    try {
      const draft = await generateHDraft(topicDraftsMatch[1], body, actor);
      if (!draft) sendJson(res, 404, { ok: false, error: "选题不存在" });
      else sendJson(res, 201, { ok: true, actor, draft });
    } catch (error) {
      sendHApiError(res, error);
    }
    return true;
  }

  const draftMatch = url.pathname.match(/^\/api\/h\/drafts\/(\d+)$/);
  if (draftMatch && req.method === "GET") {
    const draft = await getHDraft(draftMatch[1]);
    if (!draft) sendJson(res, 404, { ok: false, error: "草稿不存在" });
    else sendJson(res, 200, { ok: true, actor, draft });
    return true;
  }
  if (draftMatch && req.method === "PUT") {
    const body = await readJsonBody(req);
    try {
      const draft = await saveHDraftRevision(draftMatch[1], body, actor);
      if (!draft) sendJson(res, 404, { ok: false, error: "草稿不存在" });
      else sendJson(res, 201, { ok: true, actor, draft });
    } catch (error) {
      sendHApiError(res, error);
    }
    return true;
  }

  const draftGenerateMatch = url.pathname.match(/^\/api\/h\/drafts\/(\d+)\/generate$/);
  if (draftGenerateMatch && req.method === "POST") {
    const body = await readOptionalJsonOrFormBody(req);
    try {
      const draft = await generateHDraftFromReview(draftGenerateMatch[1], body, actor);
      if (!draft) sendJson(res, 404, { ok: false, error: "草稿不存在" });
      else sendJson(res, 201, { ok: true, actor, draft });
    } catch (error) {
      sendHApiError(res, error);
    }
    return true;
  }

  const draftReviewMatch = url.pathname.match(/^\/api\/h\/drafts\/(\d+)\/review$/);
  if (draftReviewMatch && req.method === "POST") {
    try {
      const topic = await reviewHDraft(draftReviewMatch[1], actor);
      if (!topic) sendJson(res, 404, { ok: false, error: "草稿不存在" });
      else sendJson(res, 200, { ok: true, actor, topic });
    } catch (error) {
      sendHApiError(res, error);
    }
    return true;
  }

  const draftReviewedMatch = url.pathname.match(/^\/api\/h\/drafts\/(\d+)\/henry-reviewed$/);
  if (draftReviewedMatch && req.method === "POST") {
    try {
      const topic = await markHDraftReviewed(draftReviewedMatch[1], actor);
      if (!topic) sendJson(res, 404, { ok: false, error: "草稿不存在" });
      else sendJson(res, 200, { ok: true, actor, topic });
    } catch (error) {
      sendHApiError(res, error);
    }
    return true;
  }

  const draftApproveMatch = url.pathname.match(/^\/api\/h\/drafts\/(\d+)\/approve$/);
  if (draftApproveMatch && req.method === "POST") {
    try {
      const topic = await approveHDraft(draftApproveMatch[1], actor);
      if (!topic) sendJson(res, 404, { ok: false, error: "草稿不存在" });
      else sendJson(res, 200, { ok: true, actor, topic });
    } catch (error) {
      sendHApiError(res, error);
    }
    return true;
  }

  const draftReturnMatch = url.pathname.match(/^\/api\/h\/drafts\/(\d+)\/return$/);
  if (draftReturnMatch && req.method === "POST") {
    const body = await readJsonBody(req);
    try {
      const topic = await returnHDraftForRevision(draftReturnMatch[1], body, actor);
      if (!topic) sendJson(res, 404, { ok: false, error: "草稿不存在" });
      else sendJson(res, 200, { ok: true, actor, topic });
    } catch (error) {
      sendHApiError(res, error);
    }
    return true;
  }

  const draftExportMatch = url.pathname.match(/^\/api\/h\/drafts\/(\d+)\/export$/);
  if (draftExportMatch && req.method === "GET") {
    const content = await exportHDraftPackage(draftExportMatch[1]);
    if (!content) sendJson(res, 404, { ok: false, error: "草稿不存在" });
    else sendJson(res, 200, { ok: true, actor, content });
    return true;
  }

  const topicFeedbackMatch = url.pathname.match(/^\/api\/h\/topics\/(\d+)\/feedback$/);
  if (topicFeedbackMatch && req.method === "POST") {
    const body = await readJsonBody(req);
    const action = ["use", "later", "reject", "revise"].includes(body.action) ? body.action : "revise";
    await saveHFeedback(topicFeedbackMatch[1], body.draftId, action, body.reasonCode, body.note, actor);
    sendJson(res, 201, { ok: true, actor });
    return true;
  }

  const runMatch = url.pathname.match(/^\/api\/h\/runs\/(\d+)$/);
  if (runMatch && req.method === "GET") {
    const run = await mysqlJson(`
      SELECT JSON_OBJECT(
        'id', id,
        'runType', run_type,
        'targetId', target_id,
        'status', status,
        'provider', provider,
        'model', model,
        'attemptCount', attempt_count,
        'startedAt', IF(started_at IS NULL, NULL, DATE_FORMAT(started_at, '%Y-%m-%dT%H:%i:%s+08:00')),
        'finishedAt', IF(finished_at IS NULL, NULL, DATE_FORMAT(finished_at, '%Y-%m-%dT%H:%i:%s+08:00')),
        'error', error_message
      )
      FROM yimin_h_generation_runs
      WHERE id = ${sqlNumber(runMatch[1])}
      LIMIT 1;
    `);
    if (!run) sendJson(res, 404, { ok: false, error: "任务不存在" });
    else sendJson(res, 200, { ok: true, actor, run });
    return true;
  }

  sendJson(res, 404, { ok: false, error: "H 专栏接口不存在" });
  return true;
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const decodedPath = decodeURIComponent(url.pathname);
  const cleanPath = normalize(decodedPath).replace(/^(\.\.[/\\])+/, "");
  const relativePath = cleanPath === "/" ? "index.html" : cleanPath.replace(/^[/\\]/, "");
  const filePath = resolve(rootDir, relativePath);
  const publicFiles = new Set(["index.html", "styles.css", "app.js"]);
  const isPublicUpload = relativePath.startsWith("uploads/")
    && !relativePath.split("/").some((segment) => segment.startsWith("."));
  const isPublicFile = publicFiles.has(relativePath) || isPublicUpload;

  if (
    !isPublicFile
    || !(filePath === rootDir || filePath.startsWith(`${rootDir}/`))
    || !existsSync(filePath)
  ) {
    sendText(res, 404, "Not found");
    return;
  }

  const ext = extname(filePath);
  const contentType = mimeTypes[ext] || "application/octet-stream";
  const body = await readFile(filePath);

  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(body);
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  header.split(";").forEach((pair) => {
    const [k, ...v] = pair.split("=");
    cookies[k.trim()] = v.join("=").trim();
  });
  return cookies;
}

function buildFeedbackNameCookie(name) {
  const cleanName = String(name || "").trim();
  if (!cleanName) return "";
  return `feedback_name=${encodeURIComponent(cleanName)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`;
}

function buildSsoUserIdCookie(userId) {
  const cleanUserId = String(userId || "").trim();
  if (!cleanUserId) return "";
  return `sso_user_id=${encodeURIComponent(cleanUserId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`;
}

function signSsoIdentity(userName, userId) {
  return createHmac("sha256", getSsoKeyBuffer())
    .update(`${String(userName || "").trim()}\n${String(userId || "").trim()}`)
    .digest("base64url");
}

function buildSsoIdentitySignatureCookie(userName, userId) {
  if (!userName && !userId) return "";
  return `sso_identity_sig=${signSsoIdentity(userName, userId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`;
}

function buildIdentityCookies({ userName, userId }) {
  return [
    buildFeedbackNameCookie(userName),
    buildSsoUserIdCookie(userId),
    buildSsoIdentitySignatureCookie(userName, userId),
  ].filter(Boolean);
}

function decodeCookieValue(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function hasValidSsoIdentitySignature(userName, userId, signature) {
  if (!signature || (!userName && !userId)) return false;
  const expected = Buffer.from(signSsoIdentity(userName, userId));
  const actual = Buffer.from(String(signature));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function requireAuth(req) {
  const cookies = parseCookies(req);
  const token = cookies.token;
  if (!token) return null;
  const session = sessions.get(token);
  return session || null;
}

function isLoopbackRequest(req) {
  const remoteAddress = String(req.socket?.remoteAddress || "").toLowerCase();
  const remoteIsLoopback =
    remoteAddress === "::1"
    || remoteAddress === "127.0.0.1"
    || remoteAddress.startsWith("127.")
    || remoteAddress === "::ffff:127.0.0.1";
  if (!remoteIsLoopback) return false;

  const rawHost = String(req.headers.host || "").trim();
  try {
    const hostname = new URL(`http://${rawHost}`).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.");
  } catch {
    return false;
  }
}

function getSsoIdentityFromRequest(req) {
  const cookies = parseCookies(req);
  const userName = decodeCookieValue(cookies.feedback_name).trim();
  const userId = decodeCookieValue(cookies.sso_user_id).trim();
  const identified = hasValidSsoIdentitySignature(
    userName,
    userId,
    cookies.sso_identity_sig,
  );
  if (identified && userId) {
    return { userName, userId, source: "sso" };
  }

  if (
    localTestSsoConfig.enabled
    && localTestSsoConfig.userId
    && isLoopbackRequest(req)
  ) {
    return {
      userName: localTestSsoConfig.userName || localTestSsoConfig.userId,
      userId: localTestSsoConfig.userId,
      source: "local-test",
      departmentIds: localTestSsoConfig.departmentIds,
    };
  }

  return null;
}

function normalizeDepartmentIds(value) {
  const raw = Array.isArray(value) ? value : [];
  return [...new Set(
    raw
      .map(Number)
      .filter((departmentId) => Number.isSafeInteger(departmentId) && departmentId > 0),
  )];
}

async function resolveLocalTestDepartmentIds(fallbackIds) {
  const departmentName = localTestSsoConfig.departmentName;
  if (!departmentName) return normalizeDepartmentIds(fallbackIds);

  const departments = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT('id', department_id, 'name', department_name)
    ), JSON_ARRAY())
    FROM (
      SELECT department_id, department_name
      FROM yimin_wx_departments
      ORDER BY department_name, department_id
    ) department_rows;
  `)) || [];
  const target = departmentName.toLocaleLowerCase("zh-CN");
  const candidates = departments
    .map((department) => ({
      id: Number(department.id),
      name: String(department.name || "").trim(),
    }))
    .filter((department) => Number.isSafeInteger(department.id) && department.id > 0);
  const exact = candidates.find(
    (department) => department.name.toLocaleLowerCase("zh-CN") === target,
  );
  const prefix = candidates.find(
    (department) => department.name.toLocaleLowerCase("zh-CN").startsWith(target),
  );
  const partial = candidates.find(
    (department) => department.name.toLocaleLowerCase("zh-CN").includes(target),
  );
  const matched = exact || prefix || partial;
  return matched ? [matched.id] : normalizeDepartmentIds(fallbackIds);
}

async function upsertWxUser({
  userId,
  userName = "",
  departmentIds,
  source = "",
}) {
  const cleanUserId = String(userId || "").trim().slice(0, 128);
  if (!cleanUserId) return;
  const cleanUserName = String(userName || "").trim().slice(0, 160);
  const resolvedDepartmentIds = source === "local-test"
    ? await resolveLocalTestDepartmentIds(departmentIds)
    : departmentIds;
  const cleanDepartmentIds = Array.isArray(resolvedDepartmentIds)
    ? normalizeDepartmentIds(resolvedDepartmentIds)
    : null;
  const departmentsInsert = cleanDepartmentIds === null
    ? "NULL"
    : sqlString(JSON.stringify(cleanDepartmentIds));
  const departmentsUpdate = cleanDepartmentIds === null
    ? "departments_json"
    : "VALUES(departments_json)";
  await mysqlExec(`
    INSERT INTO yimin_wx_users (userid, user_name, departments_json, last_seen_at)
    VALUES (
      ${sqlString(cleanUserId)},
      ${sqlString(cleanUserName)},
      ${departmentsInsert},
      CURRENT_TIMESTAMP
    )
    ON DUPLICATE KEY UPDATE
      user_name = CASE
        WHEN VALUES(user_name) <> '' THEN VALUES(user_name)
        ELSE user_name
      END,
      departments_json = ${departmentsUpdate},
      last_seen_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP;
  `);
}

async function getUserSubscriptionContext(userId) {
  const user = await mysqlJson(`
    SELECT JSON_OBJECT(
      'departmentIds', COALESCE(departments_json, JSON_ARRAY())
    )
    FROM yimin_wx_users
    WHERE userid = ${sqlString(userId)}
    LIMIT 1;
  `);
  const departmentIds = normalizeDepartmentIds(user?.departmentIds);

  const departmentSourceIds = departmentIds.length
    ? (await mysqlJson(`
      SELECT COALESCE(JSON_ARRAYAGG(source_id), JSON_ARRAY())
      FROM (
        SELECT DISTINCT source_id
        FROM yimin_department_source_subscriptions
        WHERE department_id IN (${departmentIds.map(sqlNumber).join(",")})
      ) department_sources;
    `)) || []
    : [];
  const personalRows = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT(
        'sourceId', us.source_id,
        'status', us.status,
        'publicDailyEnabled', IF(s.public_daily_enabled = 1, CAST(TRUE AS JSON), CAST(FALSE AS JSON))
      )
    ), JSON_ARRAY())
    FROM yimin_user_source_subscriptions us
    JOIN yimin_sources s ON s.id = us.source_id AND s.enabled = 1
    WHERE us.userid = ${sqlString(userId)};
  `)) || [];

  const departmentDefaults = new Set(departmentSourceIds.map(Number).filter(Number.isFinite));
  const personalStatuses = new Map(
    personalRows.map((row) => [Number(row.sourceId), row.status]),
  );
  const effectiveSourceIds = new Set(departmentDefaults);
  for (const row of personalRows) {
    const sourceId = Number(row.sourceId);
    const status = row.status;
    if (status === "subscribed" && row.publicDailyEnabled) effectiveSourceIds.add(sourceId);
    if (status === "muted") effectiveSourceIds.delete(sourceId);
  }

  return {
    departmentIds,
    departmentDefaults,
    personalStatuses,
    effectiveSourceIds,
  };
}

async function listMySourceSubscriptions(identity) {
  await initDb();
  await upsertWxUser(identity);
  const context = await getUserSubscriptionContext(identity.userId);
  const visibleSourceCondition = context.departmentDefaults.size
    ? `(s.public_daily_enabled = 1 OR s.id IN (${[...context.departmentDefaults].map(sqlNumber).join(",")}))`
    : "s.public_daily_enabled = 1";
  const sources = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT(
        'id', id,
        'name', name,
        'url', url,
        'country', country,
        'category', category,
        'type', type,
        'priority', priority,
        'publicDailyEnabled', IF(public_daily_enabled = 1, CAST(TRUE AS JSON), CAST(FALSE AS JSON)),
        'articleCount', article_count,
        'lastFetchedAt', last_fetched_at,
        'personalStatus', subscription_status
      )
    ), JSON_ARRAY())
    FROM (
      SELECT
        s.id,
        s.name,
        s.url,
        s.country,
        s.category,
        s.type,
        s.priority,
        s.public_daily_enabled,
        (SELECT COUNT(*) FROM yimin_articles a WHERE a.source_id = s.id) AS article_count,
        IF(s.last_fetched_at IS NULL, NULL, DATE_FORMAT(s.last_fetched_at, '%Y-%m-%dT%H:%i:%s+08:00')) AS last_fetched_at,
        us.status AS subscription_status
      FROM yimin_sources s
      LEFT JOIN yimin_user_source_subscriptions us
        ON us.source_id = s.id
       AND us.userid = ${sqlString(identity.userId)}
      WHERE s.enabled = 1
        AND ${visibleSourceCondition}
      ORDER BY
        IF(us.status = 'subscribed', 0, 1),
        s.country,
        s.category,
        s.priority DESC,
        s.name
    ) source_rows;
  `)) || [];
  const enrichedSources = sources.map((source) => {
    const sourceId = Number(source.id);
    return {
      ...source,
      departmentDefault: context.departmentDefaults.has(sourceId),
      subscribed: context.effectiveSourceIds.has(sourceId),
    };
  });

  return {
    user: {
      userId: identity.userId,
      userName: identity.userName || "",
      departmentIds: context.departmentIds,
    },
    sources: enrichedSources,
    subscribedSourceIds: enrichedSources
      .filter((source) => source.subscribed)
      .map((source) => Number(source.id)),
  };
}

async function saveMySourceSubscriptions(identity, rawSourceIds) {
  await initDb();
  await upsertWxUser(identity);
  const context = await getUserSubscriptionContext(identity.userId);
  const sourceIds = [...new Set(
    (Array.isArray(rawSourceIds) ? rawSourceIds : [])
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  )].slice(0, 300);

  let validSourceIds = [];
  if (sourceIds.length) {
    const selectableSourceCondition = context.departmentDefaults.size
      ? `(public_daily_enabled = 1 OR id IN (${[...context.departmentDefaults].map(sqlNumber).join(",")}))`
      : "public_daily_enabled = 1";
    validSourceIds = (await mysqlJson(`
      SELECT COALESCE(JSON_ARRAYAGG(id), JSON_ARRAY())
      FROM yimin_sources
      WHERE enabled = 1
        AND ${selectableSourceCondition}
        AND id IN (${sourceIds.map((id) => sqlNumber(id)).join(",")});
    `)) || [];
  }

  const selectedSourceIds = new Set(validSourceIds.map(Number));
  const overrideRows = [];
  for (const sourceId of selectedSourceIds) {
    if (!context.departmentDefaults.has(sourceId)) {
      overrideRows.push({ sourceId, status: "subscribed" });
    }
  }
  for (const sourceId of context.departmentDefaults) {
    if (!selectedSourceIds.has(sourceId)) {
      overrideRows.push({ sourceId, status: "muted" });
    }
  }

  const insertSql = overrideRows.length
    ? `INSERT INTO yimin_user_source_subscriptions (userid, source_id, status)
       VALUES ${overrideRows.map(({ sourceId, status }) => `(
         ${sqlString(identity.userId)},
         ${sqlNumber(sourceId)},
         ${sqlString(status)}
       )`).join(",")}
       ON DUPLICATE KEY UPDATE status = VALUES(status), updated_at = CURRENT_TIMESTAMP;`
    : "";

  await mysqlExec(`
    START TRANSACTION;
    DELETE FROM yimin_user_source_subscriptions
    WHERE userid = ${sqlString(identity.userId)};
    ${insertSql}
    COMMIT;
  `);

  return listMySourceSubscriptions(identity);
}

async function listDepartmentSubscriptionSettings() {
  await initDb();
  const [departments, users, subscriptions, sources] = await Promise.all([
    mysqlJson(`
      SELECT COALESCE(JSON_ARRAYAGG(
        JSON_OBJECT(
          'id', department_id,
          'name', department_name,
          'parentId', parent_id
        )
      ), JSON_ARRAY())
      FROM yimin_wx_departments;
    `),
    mysqlJson(`
      SELECT COALESCE(JSON_ARRAYAGG(
        JSON_OBJECT(
          'userId', userid,
          'userName', user_name,
          'departmentIds', COALESCE(departments_json, JSON_ARRAY())
        )
      ), JSON_ARRAY())
      FROM yimin_wx_users;
    `),
    mysqlJson(`
      SELECT COALESCE(JSON_ARRAYAGG(
        JSON_OBJECT('departmentId', department_id, 'sourceId', source_id)
      ), JSON_ARRAY())
      FROM yimin_department_source_subscriptions;
    `),
    mysqlJson(`
      SELECT COALESCE(JSON_ARRAYAGG(
        JSON_OBJECT(
          'id', id,
          'name', name,
          'country', country,
          'category', category,
          'type', type,
          'publicDailyEnabled', IF(public_daily_enabled = 1, CAST(TRUE AS JSON), CAST(FALSE AS JSON))
        )
      ), JSON_ARRAY())
      FROM (
        SELECT id, name, country, category, type, public_daily_enabled
        FROM yimin_sources
        WHERE enabled = 1
        ORDER BY country, category, priority DESC, name
      ) enabled_sources;
    `),
  ]);

  const departmentMap = new Map(
    (departments || []).map((department) => [
      Number(department.id),
      {
        id: Number(department.id),
        name: department.name || `部门 ${department.id}`,
        parentId: department.parentId ? Number(department.parentId) : null,
        userCount: 0,
        sourceIds: [],
      },
    ]),
  );
  for (const user of users || []) {
    for (const departmentId of normalizeDepartmentIds(user.departmentIds)) {
      if (!departmentMap.has(departmentId)) {
        departmentMap.set(departmentId, {
          id: departmentId,
          name: `部门 ${departmentId}`,
          parentId: null,
          userCount: 0,
          sourceIds: [],
        });
      }
      departmentMap.get(departmentId).userCount += 1;
    }
  }
  for (const departmentId of localTestSsoConfig.departmentIds) {
    if (!departmentMap.has(departmentId)) {
      departmentMap.set(departmentId, {
        id: departmentId,
        name: `本地测试部门 ${departmentId}`,
        parentId: null,
        userCount: 1,
        sourceIds: [],
      });
    }
  }
  for (const row of subscriptions || []) {
    const departmentId = Number(row.departmentId);
    if (!departmentMap.has(departmentId)) {
      departmentMap.set(departmentId, {
        id: departmentId,
        name: `部门 ${departmentId}`,
        parentId: null,
        userCount: 0,
        sourceIds: [],
      });
    }
    departmentMap.get(departmentId).sourceIds.push(Number(row.sourceId));
  }

  return {
    departments: [...departmentMap.values()]
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
    sources: sources || [],
  };
}

async function saveDepartmentSourceSubscriptions(departmentIdValue, rawSourceIds) {
  await initDb();
  const departmentId = Number(departmentIdValue);
  if (!Number.isSafeInteger(departmentId) || departmentId <= 0) {
    throw new Error("departmentId must be a positive integer");
  }
  const sourceIds = [...new Set(
    (Array.isArray(rawSourceIds) ? rawSourceIds : [])
      .map(Number)
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  )].slice(0, 300);
  const validSourceIds = sourceIds.length
    ? (await mysqlJson(`
      SELECT COALESCE(JSON_ARRAYAGG(id), JSON_ARRAY())
      FROM yimin_sources
      WHERE enabled = 1
        AND id IN (${sourceIds.map(sqlNumber).join(",")});
    `)) || []
    : [];
  const insertSql = validSourceIds.length
    ? `INSERT INTO yimin_department_source_subscriptions (department_id, source_id)
       VALUES ${validSourceIds.map((sourceId) => `(
         ${sqlNumber(departmentId)},
         ${sqlNumber(sourceId)}
       )`).join(",")};`
    : "";

  await mysqlExec(`
    START TRANSACTION;
    INSERT INTO yimin_wx_departments (department_id, department_name, synced_at)
    VALUES (${sqlNumber(departmentId)}, ${sqlString(`部门 ${departmentId}`)}, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE synced_at = synced_at;
    DELETE FROM yimin_department_source_subscriptions
    WHERE department_id = ${sqlNumber(departmentId)};
    ${insertSql}
    COMMIT;
  `);

  return listDepartmentSubscriptionSettings();
}

function normalizeComparableUrl(value) {
  try {
    const url = new URL(String(value || ""));
    url.hash = "";
    return url.href.replace(/\/+$/, "");
  } catch {
    return String(value || "").trim().replace(/\/+$/, "");
  }
}

async function getMyDailySupplement(identity, date = getShanghaiDate()) {
  await initDb();
  await upsertWxUser(identity);
  const context = await getUserSubscriptionContext(identity.userId);
  const effectiveSourceIds = [...context.effectiveSourceIds];

  const report = await mysqlJson(`
    SELECT JSON_OBJECT(
      'id', id,
      'date', DATE_FORMAT(report_date, '%Y-%m-%d'),
      'contentMarkdown', content_markdown
    )
    FROM yimin_daily_reports
    WHERE report_date = ${sqlString(date)}
    LIMIT 1;
  `);

  let subscriptionCount = 0;
  if (effectiveSourceIds.length) {
    const subscriptionCountRow = await mysqlJson(`
      SELECT JSON_OBJECT('count', COUNT(*))
      FROM yimin_sources
      WHERE enabled = 1
        AND id IN (${effectiveSourceIds.map(sqlNumber).join(",")});
    `);
    subscriptionCount = Number(subscriptionCountRow?.count || 0);
  }

  if (!report || subscriptionCount === 0) {
    return {
      date,
      subscriptionCount,
      matchedCount: 0,
      publicCoveredCount: 0,
      items: [],
    };
  }

  const rows = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT(
        'id', article_hash,
        'sourceId', source_id,
        'source', source_name,
        'country', country,
        'category', category,
        'title', title,
        'summary', summary,
        'url', url,
        'publishedAt', published_at,
        'articleDate', article_date,
        'section', section,
        'importance', importance
      )
    ), JSON_ARRAY())
    FROM (
      SELECT
        i.article_hash,
        a.source_id,
        s.name AS source_name,
        a.country,
        a.category,
        a.title,
        COALESCE(NULLIF(ad.summary_zh, ''), a.summary, '') AS summary,
        a.url,
        IF(a.published_at IS NULL, NULL, DATE_FORMAT(a.published_at, '%Y-%m-%dT%H:%i:%s+08:00')) AS published_at,
        IF(i.article_date IS NULL, NULL, DATE_FORMAT(i.article_date, '%Y-%m-%dT%H:%i:%s+08:00')) AS article_date,
        i.section,
        i.importance
      FROM yimin_daily_reports r
      JOIN yimin_daily_report_items i ON i.report_id = r.id
      JOIN yimin_articles a ON a.dedupe_hash = i.article_hash
      JOIN yimin_sources s ON s.id = a.source_id
      LEFT JOIN yimin_article_daily_analysis ad ON ad.article_hash = i.article_hash
      WHERE r.report_date = ${sqlString(date)}
        AND i.relevant = 1
        AND s.enabled = 1
        AND a.source_id IN (${effectiveSourceIds.map(sqlNumber).join(",")})
      ORDER BY i.importance DESC, i.article_date DESC, i.id DESC
      LIMIT 100
    ) subscribed_items;
  `)) || [];

  const publicMarkdown = String(report.contentMarkdown || "");
  const publicUrls = new Set(
    (publicMarkdown.match(/https?:\/\/[^\s)\]}>"']+/g) || [])
      .map(normalizeComparableUrl)
      .filter(Boolean),
  );
  const uncoveredItems = rows
    .map((item) => ({
      ...item,
      importance: Number(item.importance || 0),
      sourceId: Number(item.sourceId),
    }))
    .filter((item) => !item.url || !publicUrls.has(normalizeComparableUrl(item.url)));
  const items = uncoveredItems.slice(0, 30);

  return {
    date: report.date || date,
    subscriptionCount,
    matchedCount: rows.length,
    publicCoveredCount: rows.length - uncoveredItems.length,
    hiddenCount: Math.max(0, uncoveredItems.length - items.length),
    items,
  };
}

async function getDirectUserDepartments(identity) {
  await initDb();
  await upsertWxUser(identity);
  const user = await mysqlJson(`
    SELECT JSON_OBJECT(
      'departmentIds', COALESCE(departments_json, JSON_ARRAY())
    )
    FROM yimin_wx_users
    WHERE userid = ${sqlString(identity.userId)}
    LIMIT 1;
  `);
  const departmentIds = normalizeDepartmentIds(user?.departmentIds);
  if (!departmentIds.length) return [];

  const departments = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT(
        'id', department_id,
        'name', department_name
      )
    ), JSON_ARRAY())
    FROM (
      SELECT department_id, department_name
      FROM yimin_wx_departments
      WHERE department_id IN (${departmentIds.map(sqlNumber).join(",")})
      ORDER BY department_name, department_id
    ) direct_departments;
  `)) || [];
  return departments.map((department) => ({
    id: Number(department.id),
    name: String(department.name || "").trim(),
  })).filter((department) => department.id > 0 && department.name);
}

function buildDepartmentDailyFallbackMarkdown(department, items, reason = "") {
  const focusItems = items.slice(0, 8);
  return `## 今日重点

${focusItems.length
    ? focusItems.map((item) => `- **${item.title}**：${truncate(item.summary || "请查看原文了解详情。", 180)}${item.url ? ` [查看原文](${item.url})` : ""}`).join("\n")
    : "- 今日暂无匹配的部门关注动态。"}

## 业务影响

- 当前内容由系统按「${department.name}」配置的直属部门关注信源整理。${reason ? "AI 部门分析暂不可用，请由业务负责人结合原文判断具体影响。" : "请结合在办客户和项目情况判断具体影响。"}

## 建议动作

- 优先核对上述原文中的适用对象、生效日期和材料要求。
- 如需调整客户沟通或项目方案，请先由业务负责人确认。

## 参考原文

${focusItems.length
    ? focusItems.map((item) => `- ${item.url ? `[${item.title}](${item.url})` : item.title}（${item.source || "未知信源"}）`).join("\n")
    : "- 暂无。"}

${reason ? `> 降级原因：${reason}` : ""}`;
}

function buildDepartmentDailyPrompt({
  date,
  department,
  sources,
  items,
  publicMarkdown,
}) {
  const articleMaterial = items.map((item, index) => [
    `${index + 1}. ${item.title}`,
    `信源：${item.source}；国家/分类：${item.country || "未知"} / ${item.category || "未分类"}；重要度：${item.importance || 0}`,
    `摘要：${truncate(item.summary || "", 320)}`,
    `原文：${item.url || "无"}`,
  ].join("\n")).join("\n\n");

  return `你正在为企业微信中的直属部门「${department.name}」生成 ${date} 的部门重点板块。

部门名称来自企业微信通讯录数据库，不得改写、推断或根据关注信源重新命名。
部门默认关注信源：${sources.map((source) => source.name).join("、")}

【公共日报背景】
${truncate(publicMarkdown || "暂无公共日报正文。", 6000)}

【本部门关注信源的当日文章】
${articleMaterial || "暂无。"}

请严格输出以下 Markdown 结构：
## 今日重点
提炼 1-5 项最值得本部门关注的事实，保留原文链接。

## 业务影响
只基于输入材料，说明可能影响的客户、项目、材料、时间安排或内部协作。不能确认时明确写“需结合官方原文和具体案例确认”。

## 建议动作
给出 1-4 条内部跟进建议。不得直接生成对客承诺、确定性法律结论或输入中不存在的日期、金额、适用范围。

## 参考原文
列出实际使用过的文章标题、信源和链接。

硬性要求：
- 部门重点可以重新解释公共日报已覆盖的文章，不要仅因为公共日报出现过就删除。
- 只能使用上述文章中的事实，不得补充模型记忆中的政策信息。
- 重大政策判断使用审慎措辞，并提醒以官方原文和业务负责人确认为准。
- 标题或重点小标题必须基于原文核心事实，不得添加原文没有的断言或结论。
- 避免使用“勒令”“最后通牒”“终止”“关闭”等绝对化、煽动性词汇，除非原文白纸黑字明确为此类行动，且没有任何缓冲或谈判空间。
- 如果原文包含“警告”“可能”“如果…否则…”“建议”“提议”等条件性表述，标题、重点和摘要应如实反映该条件性。
- 摘要必须覆盖主体、对象、动作性质、时间期限、条件、过渡期、替代方案，以及相关各方的直接回应或已知立场。
- 务必区分事实陈述和观点/推测；分析性语言应注明出处或使用“据报道”“分析认为”等措辞。
- 如果原文提到某项措施的目的，例如测试系统、加强审查，摘要中必须体现该目的，不能只截取威胁部分。
- 摘要应客观中立，避免“震惊”“重磅”“突发”等情绪化词汇，除非原文本身以此为标题且事实确凿。
- 输出前请自查：标题是否可能让只读标题的读者产生误解，如可能则修改；摘要是否忽略“仅当…才…”等关键限制条件，如有则补充；各方回应是否都得到体现，若一方明确反驳或拒绝必须写出；原文中的“截至…”“过渡期至…”等时间节点是否准确反映。
- 全部使用简体中文。`;
}

async function generateDepartmentDailyMarkdown({ date, department, input }) {
  try {
    const markdown = await callDeepSeek(buildDepartmentDailyPrompt({
      date,
      department,
      sources: input.sources,
      items: input.items,
      publicMarkdown: input.report.contentMarkdown,
    }));
    return {
      markdown,
      model: deepseekConfig.model,
      status: "generated",
      error: "",
    };
  } catch (error) {
    const errorMessage = formatDepartmentDailyError(error);
    console.warn(`Department daily DeepSeek failed for ${department.id}: ${errorMessage}`);
    return {
      markdown: buildDepartmentDailyFallbackMarkdown(department, input.items, errorMessage),
      model: "fallback",
      status: "fallback",
      error: errorMessage,
    };
  }
}

function formatDepartmentDailyError(error) {
  return formatAiGenerationError(error || "DeepSeek department daily generation failed");
}

function stripHtmlTags(value) {
  return sanitizeTextArtifacts(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

async function getDepartmentDailyInput(department, date) {
  const report = await mysqlJson(`
    SELECT JSON_OBJECT(
      'date', DATE_FORMAT(report_date, '%Y-%m-%d'),
      'contentMarkdown', content_markdown,
      'windowMode', window_mode,
      'windowStart', IF(window_start_at IS NULL, NULL, DATE_FORMAT(window_start_at, '%Y-%m-%dT%H:%i:%s+08:00')),
      'windowEnd', IF(window_end_at IS NULL, NULL, DATE_FORMAT(window_end_at, '%Y-%m-%dT%H:%i:%s+08:00'))
    )
    FROM yimin_daily_reports
    WHERE report_date = ${sqlString(date)}
    LIMIT 1;
  `);
  if (!report) return null;

  const sources = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT('id', id, 'name', name)
    ), JSON_ARRAY())
    FROM (
      SELECT s.id, s.name
      FROM yimin_department_source_subscriptions ds
      JOIN yimin_sources s ON s.id = ds.source_id AND s.enabled = 1
      WHERE ds.department_id = ${sqlNumber(department.id)}
      ORDER BY s.id
    ) department_sources;
  `)) || [];
  const sourceIds = sources.map((source) => Number(source.id)).filter(Number.isFinite);
  const sourceConfigHash = createHash("sha256")
    .update([...sourceIds].sort((a, b) => a - b).join(","))
    .digest("hex");
  if (!sourceIds.length) {
    return {
      report,
      sources,
      items: [],
      sourceConfigHash,
      inputHash: createHash("sha256").update(String(report.contentMarkdown || "")).digest("hex"),
    };
  }

  const fallbackWindow = getDailyDateWindow(date, report.windowMode || "calendar");
  const windowEnd = report.windowEnd ? new Date(report.windowEnd) : fallbackWindow.end;
  const recentStart = new Date(windowEnd.getTime() - dailyRecentLookbackHours * 36e5);
  const rawItems = (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT(
        'id', dedupe_hash,
        'sourceId', source_id,
        'source', source_name,
        'country', country,
        'category', category,
        'title', display_title,
        'summary', COALESCE(display_summary, ''),
        'url', url,
        'publishedAt', published_at,
        'fetchedAt', fetched_at,
        'heat', heat,
        'impact', impact,
        'tags', CAST(tags_json AS JSON)
      )
    ), JSON_ARRAY())
    FROM (
      SELECT
        a.dedupe_hash,
        a.source_id,
        s.name AS source_name,
        a.country,
        a.category,
        COALESCE(NULLIF(t.title_zh, ''), a.title) AS display_title,
        COALESCE(NULLIF(t.summary_zh, ''), a.summary, '') AS display_summary,
        a.url,
        IF(a.published_at IS NULL, NULL, DATE_FORMAT(a.published_at, '%Y-%m-%dT%H:%i:%s+08:00')) AS published_at,
        IF(a.fetched_at IS NULL, NULL, DATE_FORMAT(a.fetched_at, '%Y-%m-%dT%H:%i:%s+08:00')) AS fetched_at,
        a.heat,
        a.impact,
        a.tags_json,
        COALESCE(a.published_at, a.fetched_at) AS article_at
      FROM yimin_articles a
      JOIN yimin_sources s ON s.id = a.source_id AND s.enabled = 1
      LEFT JOIN yimin_article_translations t
        ON t.article_hash = a.dedupe_hash
       AND t.translation_version = ${sqlString(articleTranslationVersion)}
       AND t.status = 'translated'
      WHERE a.daily_excluded = 0
        AND a.source_id IN (${sourceIds.map(sqlNumber).join(",")})
        AND COALESCE(a.published_at, a.fetched_at) >= ${sqlDate(recentStart)}
        AND COALESCE(a.published_at, a.fetched_at) < ${sqlDate(windowEnd)}
      ORDER BY a.heat DESC, article_at DESC, a.id DESC
      LIMIT 500
    ) department_items;
  `)) || [];

  const analysisInput = rawItems.map((item) => {
    const articleDate = getDailyArticleDate(item);
    return {
      ...item,
      title: sanitizeTextArtifacts(item.title),
      summary: sanitizeTextArtifacts(item.summary),
      source: sanitizeTextArtifacts(item.source),
      country: sanitizeTextArtifacts(item.country),
      category: sanitizeTextArtifacts(item.category),
      impact: sanitizeTextArtifacts(item.impact),
      tags: (item.tags || []).map((tag) => sanitizeTextArtifacts(tag)).filter(Boolean),
      articleDate: articleDate ? formatShanghaiDateTimeISO(articleDate) : null,
      dailyScore: getDailyItemScore(item, articleDate, { end: windowEnd }),
    };
  });
  const analyses = await getDailyArticleAnalyses(analysisInput);
  const items = analysisInput
    .map((item) => {
      const analysis = analyses.get(item.id) || buildFallbackDailyAnalysis(item);
      return {
        ...item,
        summary: analysis.summaryZh || item.summary,
        importance: analysis.importance,
        relevant: analysis.relevant,
      };
    })
    .filter((item) => item.relevant)
    .sort((a, b) => b.importance - a.importance || b.dailyScore - a.dailyScore)
    .slice(0, 40);

  const inputHash = createHash("sha256")
    .update(JSON.stringify({
      publicMarkdown: report.contentMarkdown || "",
      articles: items.map((item) => ({
        id: item.id,
        title: item.title,
        summary: item.summary,
        importance: item.importance,
      })),
    }))
    .digest("hex");

  return { report, sources, items, sourceConfigHash, inputHash };
}

function normalizeDepartmentDailyReport(row) {
  if (!row) return null;
  const contentMarkdown = sanitizeTextArtifacts(row.contentMarkdown);
  return {
    departmentId: Number(row.departmentId),
    departmentName: sanitizeTextArtifacts(row.departmentName),
    date: row.date,
    contentMarkdown,
    html: contentMarkdown ? markdownToHtml(contentMarkdown) : "",
    sourceCount: Number(row.sourceCount || 0),
    articleCount: Number(row.articleCount || 0),
    model: row.model || "",
    status: row.status || "empty",
    error: sanitizeTextArtifacts(row.error),
    generatedAt: row.generatedAt || null,
  };
}

async function readDepartmentDailyReport(date, departmentId) {
  const row = await mysqlJson(`
    SELECT JSON_OBJECT(
      'departmentId', department_id,
      'departmentName', department_name_snapshot,
      'date', DATE_FORMAT(report_date, '%Y-%m-%d'),
      'contentMarkdown', content_markdown,
      'sourceCount', source_count,
      'articleCount', article_count,
      'model', model,
      'status', status,
      'error', error,
      'sourceConfigHash', source_config_hash,
      'inputHash', input_hash,
      'generatedAt', DATE_FORMAT(generated_at, '%Y-%m-%dT%H:%i:%s+08:00')
    )
    FROM yimin_department_daily_reports
    WHERE report_date = ${sqlString(date)}
      AND department_id = ${sqlNumber(departmentId)}
    LIMIT 1;
  `);
  return row || null;
}

async function saveDepartmentDailyReport({
  date,
  department,
  input,
  markdown,
  model,
  status,
  error = "",
}) {
  const cleanMarkdown = sanitizeTextArtifacts(markdown);
  await mysqlExec(`
    INSERT INTO yimin_department_daily_reports (
      report_date, department_id, department_name_snapshot,
      source_config_hash, input_hash, content_markdown, content_html,
      source_count, article_count, model, status, error, generated_at
    )
    VALUES (
      ${sqlString(date)},
      ${sqlNumber(department.id)},
      ${sqlString(department.name)},
      ${sqlString(input.sourceConfigHash)},
      ${sqlString(input.inputHash)},
      ${sqlString(cleanMarkdown)},
      ${sqlString(markdownToHtml(cleanMarkdown))},
      ${sqlNumber(input.sources.length)},
      ${sqlNumber(input.items.length)},
      ${sqlString(model)},
      ${sqlString(status)},
      ${sqlString(error)},
      CURRENT_TIMESTAMP
    )
    ON DUPLICATE KEY UPDATE
      department_name_snapshot = VALUES(department_name_snapshot),
      source_config_hash = VALUES(source_config_hash),
      input_hash = VALUES(input_hash),
      content_markdown = VALUES(content_markdown),
      content_html = VALUES(content_html),
      source_count = VALUES(source_count),
      article_count = VALUES(article_count),
      model = VALUES(model),
      status = VALUES(status),
      error = VALUES(error),
      generated_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP;
  `);
  return normalizeDepartmentDailyReport(await readDepartmentDailyReport(date, department.id));
}

async function generateDepartmentDailyReport(department, date, { refresh = false } = {}) {
  const generationKey = `${date}:${department.id}`;
  if (departmentDailyGenerationPromises.has(generationKey)) {
    return departmentDailyGenerationPromises.get(generationKey);
  }

  const generationPromise = (async () => {
    const existing = await readDepartmentDailyReport(date, department.id);
    const input = await getDepartmentDailyInput(department, date);
    if (!input) return null;
    if (
      !refresh
      && existing
      && existing.sourceConfigHash === input.sourceConfigHash
      && existing.inputHash === input.inputHash
      && existing.status !== "fallback"
    ) {
      return normalizeDepartmentDailyReport(existing);
    }

    if (!input.sources.length || !input.items.length) {
      const message = !input.sources.length
        ? `## 今日重点\n\n「${department.name}」尚未配置部门默认关注信源，暂不生成部门重点。`
        : `## 今日重点\n\n「${department.name}」关注的信源今日暂无匹配动态。`;
      return saveDepartmentDailyReport({
        date,
        department,
        input,
        markdown: message,
        model: "none",
        status: "empty",
      });
    }

    const generated = await generateDepartmentDailyMarkdown({ date, department, input });

    return saveDepartmentDailyReport({
      date,
      department,
      input,
      markdown: generated.markdown,
      model: generated.model,
      status: generated.status,
      error: generated.error,
    });
  })().finally(() => {
    departmentDailyGenerationPromises.delete(generationKey);
  });
  departmentDailyGenerationPromises.set(generationKey, generationPromise);
  return generationPromise;
}

async function readMyDepartmentDailyReports(identity, date) {
  const departments = await getDirectUserDepartments(identity);
  if (!departments.length) {
    return {
      date,
      departments: [],
      missingDepartmentSync: true,
    };
  }
  const reports = await Promise.all(
    departments.map((department) => readDepartmentDailyReport(date, department.id)),
  );
  return {
    date,
    departments: reports.map(normalizeDepartmentDailyReport).filter(Boolean),
    missingDepartmentSync: false,
  };
}

async function listConfiguredDepartmentDailyTargets() {
  return (await mysqlJson(`
    SELECT COALESCE(JSON_ARRAYAGG(
      JSON_OBJECT(
        'id', department_id,
        'name', department_name
      )
    ), JSON_ARRAY())
    FROM (
      SELECT d.department_id, d.department_name
      FROM yimin_wx_departments d
      JOIN (
        SELECT department_id
        FROM yimin_department_source_subscriptions
        GROUP BY department_id
      ) configured ON configured.department_id = d.department_id
      ORDER BY d.department_name, d.department_id
    ) configured_departments;
  `)) || [];
}

async function generateAllDepartmentDailyReports(date, { refresh = false } = {}) {
  await initDb();
  const publicReport = await mysqlJson(`
    SELECT JSON_OBJECT(
      'date', DATE_FORMAT(report_date, '%Y-%m-%d')
    )
    FROM yimin_daily_reports
    WHERE report_date = ${sqlString(date)}
    LIMIT 1;
  `);
  if (!publicReport) {
    const error = new Error(`请先生成 ${date} 的公共日报`);
    error.code = "PUBLIC_DAILY_REPORT_MISSING";
    throw error;
  }

  const departments = (await listConfiguredDepartmentDailyTargets())
    .map((department) => ({
      id: Number(department.id),
      name: String(department.name || "").trim(),
    }))
    .filter((department) => department.id > 0 && department.name);
  const reports = await runWithConcurrency(
    departments,
    2,
    async (department) => {
      try {
        const report = await generateDepartmentDailyReport(department, date, { refresh });
        return {
          departmentId: department.id,
          departmentName: department.name,
          ok: Boolean(report),
          status: report?.status || "skipped",
          sourceCount: Number(report?.sourceCount || 0),
          articleCount: Number(report?.articleCount || 0),
          generatedAt: report?.generatedAt || null,
          error: report ? (report.error || "") : "未生成部门日报",
        };
      } catch (error) {
        return {
          departmentId: department.id,
          departmentName: department.name,
          ok: false,
          status: "failed",
          sourceCount: 0,
          articleCount: 0,
          generatedAt: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  return {
    date,
    departmentCount: departments.length,
    completedCount: reports.filter((report) => report.ok).length,
    generatedCount: reports.filter((report) => report.status === "generated").length,
    fallbackCount: reports.filter((report) => report.status === "fallback").length,
    emptyCount: reports.filter((report) => report.status === "empty").length,
    failedCount: reports.filter((report) => !report.ok).length,
    reports,
  };
}

function startAllDepartmentDailyReportsInBackground(date, { refresh = false } = {}) {
  const generationKey = `${date}:${refresh ? "refresh" : "cached"}`;
  if (allDepartmentDailyGenerationPromises.has(generationKey)) {
    return allDepartmentDailyGenerationPromises.get(generationKey);
  }

  const generationPromise = generateAllDepartmentDailyReports(date, { refresh })
    .catch((error) => {
      console.error(
        `Department daily batch generation failed for ${date}:`,
        error instanceof Error ? error.message : String(error),
      );
      return {
        ok: false,
        date,
        error: error instanceof Error ? error.message : String(error),
      };
    })
    .finally(() => {
      allDepartmentDailyGenerationPromises.delete(generationKey);
    });

  allDepartmentDailyGenerationPromises.set(generationKey, generationPromise);
  return generationPromise;
}

function isAllDepartmentDailyGenerationRunning(date) {
  return ["refresh", "cached"].some((mode) => (
    allDepartmentDailyGenerationPromises.has(`${date}:${mode}`)
  ));
}

async function readRequestBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolvePromise, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > maxBytes) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      resolvePromise(body);
    });
    req.on("error", reject);
  });
}

async function readJsonBody(req, maxBytes) {
  const body = await readRequestBody(req, maxBytes);
  if (!body.trim()) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

async function readOptionalJsonOrFormBody(req) {
  const body = await readRequestBody(req);
  const trimmed = body.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    if (
      contentType.includes("application/x-www-form-urlencoded")
      || /^[^=&\s]+=[\s\S]*$/.test(trimmed)
    ) {
      return Object.fromEntries(new URLSearchParams(trimmed));
    }
    return {};
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (await handleHColumnApi(req, res, url)) {
      return;
    }

    if (url.pathname === "/api/login" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (body.username !== authConfig.user || body.password !== authConfig.pass) {
        sendJson(res, 401, { ok: false, error: "用户名或密码错误" });
        return;
      }
      const token = randomBytes(32).toString("hex");
      sessions.set(token, { username: body.username, createdAt: Date.now() });
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": `token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7 * 24 * 3600}`,
      });
      res.end(JSON.stringify({ ok: true, username: body.username }));
      return;
    }

    if (url.pathname === "/api/logout" && req.method === "POST") {
      const cookies = parseCookies(req);
      if (cookies.token) sessions.delete(cookies.token);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": "token=; Path=/; HttpOnly; Max-Age=0",
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/api/me") {
      const session = requireAuth(req);
      sendJson(res, 200, {
        loggedIn: !!session,
        username: session ? session.username : null,
      });
      return;
    }

    if (url.pathname === "/api/sso/me" && req.method === "GET") {
      const identity = getSsoIdentityFromRequest(req);
      sendJson(res, 200, {
        ok: true,
        identified: Boolean(identity),
        userName: identity?.userName || "",
        userId: identity?.userId || "",
        localTest: identity?.source === "local-test",
      });
      return;
    }

    if (url.pathname === "/api/peer-monitor/access" && req.method === "GET") {
      await initDb();
      const access = await getPeerMonitorAccess(req);
      sendJson(res, 200, {
        ok: true,
        allowed: access.allowed,
      });
      return;
    }

    if (url.pathname === "/api/peer-monitor/overview" && req.method === "GET") {
      await initDb();
      const access = await getPeerMonitorAccess(req);
      if (!access.allowed) {
        sendJson(res, 403, { ok: false, error: "无权访问同行监控" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        competitors: await listPeerMonitorOverview(),
      });
      return;
    }

    if (url.pathname === "/api/peer-monitor/projects" && req.method === "GET") {
      await initDb();
      const access = await getPeerMonitorAccess(req);
      if (!access.allowed) {
        sendJson(res, 403, { ok: false, error: "无权访问同行监控" });
        return;
      }
      const competitorCode = String(url.searchParams.get("competitor") || "");
      if (!/^peer-[a-i]$/.test(competitorCode)) {
        sendJson(res, 400, { ok: false, error: "competitor 参数无效" });
        return;
      }
      const payload = await listPeerProjects(competitorCode);
      sendJson(res, 200, { ok: true, ...payload });
      return;
    }

    if (url.pathname === "/api/peer-monitor/website/import" && req.method === "POST") {
      if (!isPeerDiscoveryAuthorized(req)) {
        sendJson(res, 401, { ok: false, error: "请使用管理员登录、loopback 请求或有效的定时任务令牌" });
        return;
      }
      await initDb();
      const dryRun = url.searchParams.get("dryRun") === "1";
      try {
        const body = await readJsonBody(req, 32 * 1024 * 1024);
        const result = await importPeerWebsiteSnapshot(body, { dryRun });
        sendJson(res, dryRun || result.reused ? 200 : 201, { ok: true, ...result });
      } catch (error) {
        const code = error?.code;
        const status = code === "INVALID_WEBSITE_SNAPSHOT"
          ? 400
          : ["WEBSITE_RUN_ID_CONFLICT", "WEBSITE_RUN_INCOMPLETE"].includes(code)
            ? 409
            : 500;
        sendJson(res, status, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    const peerWebsiteRunMatch = url.pathname.match(/^\/api\/peer-monitor\/website\/runs\/([^/]+)$/);
    if (peerWebsiteRunMatch && req.method === "GET") {
      await initDb();
      const access = await getPeerMonitorAccess(req);
      if (!access.allowed && !isPeerDiscoveryAuthorized(req)) {
        sendJson(res, 403, { ok: false, error: "无权查看官网导入任务" });
        return;
      }
      const runId = decodeURIComponent(peerWebsiteRunMatch[1]);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:+-]{7,159}$/.test(runId)) {
        sendJson(res, 400, { ok: false, error: "runId 格式无效" });
        return;
      }
      const run = await getPeerWebsiteRunDetail(runId);
      if (!run) {
        sendJson(res, 404, { ok: false, error: "官网导入任务不存在" });
        return;
      }
      sendJson(res, 200, { ok: true, run });
      return;
    }

    if (url.pathname === "/api/peer-monitor/website/events" && req.method === "GET") {
      await initDb();
      const access = await getPeerMonitorAccess(req);
      if (!access.allowed && !isLoopbackRequest(req)) {
        sendJson(res, 403, { ok: false, error: "无权查看官网变化事件" });
        return;
      }
      const competitorCode = String(url.searchParams.get("competitor") || "");
      const eventType = String(url.searchParams.get("eventType") || "");
      const from = String(url.searchParams.get("from") || "");
      const to = String(url.searchParams.get("to") || "");
      if (competitorCode && !/^peer-[a-i]$/.test(competitorCode)) {
        sendJson(res, 400, { ok: false, error: "competitor 参数无效" });
        return;
      }
      if (eventType && !["added", "changed", "removed", "reappeared"].includes(eventType)) {
        sendJson(res, 400, { ok: false, error: "eventType 参数无效" });
        return;
      }
      if ((from && Number.isNaN(Date.parse(from))) || (to && Number.isNaN(Date.parse(to)))) {
        sendJson(res, 400, { ok: false, error: "from/to 必须是有效时间" });
        return;
      }
      const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "50", 10) || 50));
      const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0);
      const events = await listPeerWebsiteEvents({ competitorCode, eventType, from, to, limit, offset });
      sendJson(res, 200, { ok: true, events, limit, offset });
      return;
    }

    if (url.pathname === "/api/peer-monitor/articles" && req.method === "GET") {
      await initDb();
      const access = await getPeerMonitorAccess(req);
      if (!access.allowed) {
        sendJson(res, 403, { ok: false, error: "无权访问同行监控" });
        return;
      }
      const competitorCode = String(url.searchParams.get("competitor") || "");
      if (!/^peer-[a-i]$/.test(competitorCode)) {
        sendJson(res, 400, { ok: false, error: "competitor 参数无效" });
        return;
      }
      const limit = Math.min(
        50,
        Math.max(1, Number.parseInt(url.searchParams.get("limit") || "20", 10) || 20),
      );
      const offset = Math.max(
        0,
        Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0,
      );
      const payload = await listPeerArticles(competitorCode, { limit, offset });
      sendJson(res, 200, {
        ok: true,
        ...payload,
      });
      return;
    }

    if (url.pathname === "/api/peer-monitor/wechat/discover" && req.method === "POST") {
      if (!isPeerDiscoveryAuthorized(req)) {
        sendJson(res, 401, { ok: false, error: "请使用管理员登录、loopback 请求或有效的定时任务令牌" });
        return;
      }
      await initDb();
      const body = await readJsonBody(req);
      const reportDate = String(body.date || url.searchParams.get("date") || getShanghaiDate());
      const competitorCode = String(body.competitor || url.searchParams.get("competitor") || "");
      if (competitorCode && !/^peer-[a-i]$/.test(competitorCode)) {
        sendJson(res, 400, { ok: false, error: "competitor 参数无效" });
        return;
      }
      const refresh = body.refresh === true || url.searchParams.get("refresh") === "1";
      const retryCached = body.retryCached === true || url.searchParams.get("retryCached") === "1";
      const dryRun = body.dryRun === true || url.searchParams.get("dryRun") === "1";
      if ((refresh && retryCached) || (dryRun && retryCached)) {
        sendJson(res, 400, { ok: false, error: "refresh、dryRun 与 retryCached 不能同时使用" });
        return;
      }
      try {
        getPeerDiscoveryWindow(reportDate);
        const result = await startPeerWechatDiscovery({
          reportDate,
          competitorCode,
          dryRun,
          refresh,
          retryCached,
        });
        sendJson(res, result.started ? 202 : 200, { ok: true, ...result });
      } catch (error) {
        sendJson(res, 409, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (url.pathname === "/api/peer-monitor/wechat/discovery-runs/latest" && req.method === "GET") {
      if (!isPeerDiscoveryAuthorized(req)) {
        sendJson(res, 401, { ok: false, error: "无权查看公众号发现任务" });
        return;
      }
      await initDb();
      sendJson(res, 200, { ok: true, run: await getLatestPeerWechatDiscoveryRun() });
      return;
    }

    const peerDiscoveryRunMatch = url.pathname.match(/^\/api\/peer-monitor\/wechat\/discovery-runs\/([a-f0-9]{32})$/);
    if (peerDiscoveryRunMatch && req.method === "GET") {
      if (!isPeerDiscoveryAuthorized(req)) {
        sendJson(res, 401, { ok: false, error: "无权查看公众号发现任务" });
        return;
      }
      await initDb();
      const run = await getPeerWechatDiscoveryRun(peerDiscoveryRunMatch[1]);
      if (!run) {
        sendJson(res, 404, { ok: false, error: "公众号发现任务不存在" });
        return;
      }
      sendJson(res, 200, { ok: true, run });
      return;
    }

    if (url.pathname === "/api/peer-monitor/refresh" && req.method === "POST") {
      await initDb();
      const competitorCode = String(url.searchParams.get("competitor") || "");
      if (competitorCode && !/^peer-[a-i]$/.test(competitorCode)) {
        sendJson(res, 400, { ok: false, error: "competitor 参数无效" });
        return;
      }
      const result = await startPeerRefresh(competitorCode);
      if (result.error) {
        sendJson(res, 409, { ok: false, error: result.error });
        return;
      }
      sendJson(res, result.started ? 202 : 200, {
        ok: true,
        started: result.started,
        active: result.active,
        run: result.run,
      });
      return;
    }

    if (url.pathname === "/api/peer-monitor/refresh-runs/latest" && req.method === "GET") {
      await initDb();
      const access = await getPeerMonitorAccess(req);
      if (!access.allowed && !isLoopbackRequest(req)) {
        sendJson(res, 403, { ok: false, error: "无权查看同行刷新任务" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        run: await getLatestPeerRefreshRun(),
      });
      return;
    }

    const peerRefreshRunMatch = url.pathname.match(/^\/api\/peer-monitor\/refresh-runs\/([a-f0-9]{32})$/);
    if (peerRefreshRunMatch && req.method === "GET") {
      await initDb();
      const access = await getPeerMonitorAccess(req);
      if (!access.allowed && !isLoopbackRequest(req)) {
        sendJson(res, 403, { ok: false, error: "无权查看同行刷新任务" });
        return;
      }
      const run = await getPeerRefreshRun(peerRefreshRunMatch[1]);
      if (!run) {
        sendJson(res, 404, { ok: false, error: "刷新任务不存在" });
        return;
      }
      sendJson(res, 200, { ok: true, run });
      return;
    }

    if (url.pathname === "/api/sso/visit" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body.ssoAuthCode) {
        sendJson(res, 400, { ok: false, error: "ssoAuthCode is required" });
        return;
      }

      try {
        const result = await recordSsoVisit({
          encParam: body.ssoAuthCode,
          encUserId: body.ssoUserId || "",
          route: body.route || "",
          pageUrl: body.pageUrl || "",
          ip: getClientIp(req),
          userAgent: req.headers["user-agent"] || "",
        });
        const payload = JSON.stringify({
          ok: true,
          userName: result.userName,
          userId: result.userId || "",
        }, null, 2);
        const identityCookies = buildIdentityCookies(result);
        res.writeHead(201, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          ...(identityCookies.length ? { "set-cookie": identityCookies } : {}),
        });
        res.end(payload);
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message || "SSO 解密失败" });
      }
      return;
    }

    if (url.pathname === "/api/sso/stats" && req.method === "GET") {
      if (!requireAuth(req)) {
        sendJson(res, 401, { ok: false, error: "请先登录" });
        return;
      }
      const stats = await getSsoStats();
      sendJson(res, 200, { ok: true, stats });
      return;
    }

    if (url.pathname === "/api/subscriptions/me") {
      const identity = getSsoIdentityFromRequest(req);
      if (!identity) {
        sendJson(res, 401, {
          ok: false,
          error: "请从企业微信日报链接进入后管理关注",
        });
        return;
      }

      if (req.method === "GET") {
        const subscriptions = await listMySourceSubscriptions(identity);
        sendJson(res, 200, { ok: true, ...subscriptions });
        return;
      }

      if (req.method === "PUT") {
        const body = await readJsonBody(req);
        if (!Array.isArray(body.sourceIds)) {
          sendJson(res, 400, { ok: false, error: "sourceIds must be an array" });
          return;
        }
        const subscriptions = await saveMySourceSubscriptions(identity, body.sourceIds);
        sendJson(res, 200, { ok: true, ...subscriptions });
        return;
      }

      sendJson(res, 405, { ok: false, error: "Method not allowed" });
      return;
    }

    if (url.pathname === "/api/subscriptions/departments") {
      if (!requireAuth(req)) {
        sendJson(res, 401, { ok: false, error: "请先登录" });
        return;
      }

      if (req.method === "GET") {
        const settings = await listDepartmentSubscriptionSettings();
        sendJson(res, 200, { ok: true, ...settings });
        return;
      }

      if (req.method === "PUT") {
        const body = await readJsonBody(req);
        if (!Array.isArray(body.sourceIds)) {
          sendJson(res, 400, { ok: false, error: "sourceIds must be an array" });
          return;
        }
        try {
          const settings = await saveDepartmentSourceSubscriptions(
            body.departmentId,
            body.sourceIds,
          );
          sendJson(res, 200, { ok: true, ...settings });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error.message });
        }
        return;
      }

      sendJson(res, 405, { ok: false, error: "Method not allowed" });
      return;
    }

    if (url.pathname === "/api/health") {
      await initDb();
      sendJson(res, 200, {
        ok: true,
        service: "immigration-hot",
        database: dbConfig.database,
        time: formatShanghaiDateTimeISO(new Date()),
      });
      return;
    }

    if (url.pathname === "/api/changelog") {
      await initDb();
      try {
        const rows = await mysqlJson(
          `SELECT JSON_ARRAYAGG(JSON_OBJECT('id', id, 'log_date', log_date, 'title', title, 'description', description))
           FROM (SELECT * FROM yimin_changelog ORDER BY created_at DESC LIMIT 100) t`
        );
        sendJson(res, 200, { ok: true, items: rows || [] });
      } catch (e) {
        sendJson(res, 200, { ok: true, items: [] });
      }
      return;
    }

    if (url.pathname === "/api/source-distribution" && req.method === "GET") {
      const session = requireAuth(req);
      if (!session) {
        sendJson(res, 401, { ok: false, error: "请先登录" });
        return;
      }
      await initDb();
      sendJson(res, 200, {
        ok: true,
        sources: await listSourceDistributionSettings(),
      });
      return;
    }

    const sourceDistributionMatch = url.pathname.match(/^\/api\/source-distribution\/(\d+)$/);
    if (sourceDistributionMatch && req.method === "PUT") {
      const session = requireAuth(req);
      if (!session) {
        sendJson(res, 401, { ok: false, error: "请先登录" });
        return;
      }
      await initDb();
      try {
        const body = await readJsonBody(req);
        const sources = await updateSourceDistributionSetting(
          sourceDistributionMatch[1],
          body,
          session,
        );
        sendJson(res, 200, { ok: true, sources });
      } catch (error) {
        sendJson(res, error?.code === "SOURCE_NOT_FOUND" ? 404 : 400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (url.pathname === "/api/sources") {
      await initDb();
      if (req.method === "POST") {
        if (!requireAuth(req)) {
          sendJson(res, 401, { ok: false, error: "请先登录" });
          return;
        }
        const body = await readJsonBody(req);
        if (!body.name || !body.url) {
          sendJson(res, 400, {
            ok: false,
            error: "name and url are required",
          });
          return;
        }

        await saveSourceSubmission(body);
        cache = null;
        sendJson(res, 201, {
          ok: true,
        });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        configuredSources: await readSources(),
        sources: await listSourceStatusesFromDb(),
      });
      return;
    }

    if (url.pathname === "/api/sources/stats" && req.method === "GET") {
      await initDb();
      sendJson(res, 200, {
        ok: true,
        stats: await getSourceStatsFromDb(),
      });
      return;
    }

    if (url.pathname === "/api/news") {
      const force = url.searchParams.get("refresh") === "1";
      const sync = url.searchParams.get("sync") === "1";
      const payload = await getNews({ force, background: force && !sync });
      sendJson(res, 200, payload);
      return;
    }

    if (url.pathname === "/api/relevance/articles") {
      if (req.method === "GET") {
        sendJson(res, 200, {
          ok: true,
          status: await getArticleRelevanceStatus(),
        });
        return;
      }

      if (req.method === "POST") {
        const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get("limit") || articleRelevanceMaxPerRun)));
        if (url.searchParams.get("sync") === "1") {
          const result = await analyzePendingArticleRelevance({ limit });
          sendJson(res, 200, {
            ok: true,
            result,
            status: await getArticleRelevanceStatus(),
          });
          return;
        }

        startArticleRelevanceInBackground({ limit });
        sendJson(res, 202, {
          ok: true,
          running: true,
          status: await getArticleRelevanceStatus(),
        });
        return;
      }

      sendJson(res, 405, {
        ok: false,
        error: "Method not allowed",
      });
      return;
    }

    if (url.pathname === "/api/translations/articles") {
      if (req.method === "GET") {
        sendJson(res, 200, {
          ok: true,
          status: await getArticleTranslationStatus(),
        });
        return;
      }

      if (req.method === "POST") {
        const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get("limit") || articleTranslationMaxPerRun)));
        if (url.searchParams.get("sync") === "1") {
          const result = await translatePendingArticles({ limit });
          sendJson(res, 200, {
            ok: true,
            result,
            status: await getArticleTranslationStatus(),
          });
          return;
        }

        startArticleTranslationInBackground({ limit });
        sendJson(res, 202, {
          ok: true,
          running: true,
          status: await getArticleTranslationStatus(),
        });
        return;
      }

      sendJson(res, 405, {
        ok: false,
        error: "Method not allowed",
      });
      return;
    }

    if (url.pathname === "/api/fetch-runs/latest") {
      await initDb();
      const run = activeFetchRun?.status === "running"
        ? (await getFetchRunById(activeFetchRun.id)) || activeFetchRun
        : await getLatestFetchRun();
      sendJson(res, 200, {
        ok: true,
        run,
      });
      return;
    }

    const fetchRunMatch = url.pathname.match(/^\/api\/fetch-runs\/(\d+)$/);
    if (fetchRunMatch) {
      await initDb();
      const runId = Number(fetchRunMatch[1]);
      const run = await getFetchRunById(runId);
      if (!run) {
        sendJson(res, 404, {
          ok: false,
          error: "Fetch run not found",
        });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        run,
      });
      return;
    }

    if (url.pathname === "/api/daily") {
      const date = url.searchParams.get("date") || getShanghaiDate();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        sendJson(res, 400, {
          ok: false,
          error: "date must use YYYY-MM-DD",
        });
        return;
      }

      const refresh = url.searchParams.get("refresh") === "1";
      const sync = url.searchParams.get("sync") === "1";
      const windowMode = getDailyWindowModeFromSearch(url.searchParams);
      const language = normalizeDailyLanguage(url.searchParams.get("lang"));
      if (!sync) {
        if (!refresh) {
          const cached = await readCachedDailyReport(date, { language });
          if (cached) {
            sendJson(res, 200, {
              ok: true,
              report: cached,
            });
            return;
          }
        }

        startDailyReportInBackground(date, { refresh, windowMode, language });
        sendJson(res, 202, {
          ok: true,
          date,
          language,
          running: true,
          status: isDailyReportGenerationRunning(date, { windowMode, language }) ? "running" : "queued",
          message: "日报生成已在后台开始，可稍后刷新日报页面查看结果；如需等待结果，请加 sync=1。",
        });
        return;
      }

      const report = await getDailyReport(date, {
        refresh,
        windowMode,
        language,
      });
      sendJson(res, 200, {
        ok: true,
        report,
      });
      return;
    }

    if (url.pathname === "/api/daily/personal" && req.method === "GET") {
      const identity = getSsoIdentityFromRequest(req);
      if (!identity) {
        sendJson(res, 401, {
          ok: false,
          error: "未识别企业微信身份",
        });
        return;
      }
      const supplement = await getMyDailySupplement(
        identity,
        url.searchParams.get("date") || getShanghaiDate(),
      );
      sendJson(res, 200, {
        ok: true,
        user: identity,
        supplement,
      });
      return;
    }

    if (url.pathname === "/api/daily/department" && req.method === "GET") {
      const identity = getSsoIdentityFromRequest(req);
      if (!identity) {
        sendJson(res, 401, {
          ok: false,
          error: "未识别企业微信身份",
        });
        return;
      }
      const result = await readMyDepartmentDailyReports(
        identity,
        url.searchParams.get("date") || getShanghaiDate(),
      );
      sendJson(res, 200, {
        ok: true,
        user: identity,
        ...result,
      });
      return;
    }

    if (url.pathname === "/api/daily/departments/generate") {
      if (!["GET", "POST"].includes(req.method)) {
        sendJson(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }

      const body = req.method === "POST" ? await readOptionalJsonOrFormBody(req) : {};
      const date = String(body.date || url.searchParams.get("date") || getShanghaiDate());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        sendJson(res, 400, {
          ok: false,
          error: "date must use YYYY-MM-DD",
        });
        return;
      }

      try {
        const refresh = body.refresh === true || url.searchParams.get("refresh") === "1";
        const sync = body.sync === true || url.searchParams.get("sync") === "1";
        if (!sync) {
          startAllDepartmentDailyReportsInBackground(date, { refresh });
          sendJson(res, 202, {
            ok: true,
            date,
            running: true,
            status: isAllDepartmentDailyGenerationRunning(date) ? "running" : "queued",
            message: "部门日报生成已在后台开始，可稍后刷新日报页面查看结果；如需等待结果，请加 sync=1。",
          });
          return;
        }

        const result = await generateAllDepartmentDailyReports(date, { refresh });
        sendJson(res, result.failedCount ? 207 : 200, {
          ok: result.failedCount === 0,
          ...result,
        });
      } catch (error) {
        sendJson(
          res,
          error?.code === "PUBLIC_DAILY_REPORT_MISSING" ? 409 : 500,
          {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return;
    }

    if (url.pathname === "/api/daily/history") {
      await initDb();
      const rows = await mysqlJson(`
        SELECT COALESCE(JSON_ARRAYAGG(
          JSON_OBJECT(
            'date', DATE_FORMAT(report_date, '%Y-%m-%d'),
            'title', title,
            'sourceItemCount', source_item_count,
            'model', model
          )
        ), JSON_ARRAY())
        FROM (
          SELECT report_date, title, source_item_count, model
          FROM yimin_daily_reports
          ORDER BY report_date DESC
          LIMIT 30
        ) recent;
      `);
      sendJson(res, 200, { ok: true, history: rows || [] });
      return;
    }

    if (url.pathname === "/api/market" && req.method === "GET") {
      const report = await getMarketReport(url.searchParams.get("date") || getShanghaiDate(), {
        refresh: url.searchParams.get("refresh") === "1",
      });
      sendJson(res, 200, {
        ok: true,
        report,
      });
      return;
    }

    if (url.pathname === "/api/market/history") {
      const history = await listMarketHistory();
      sendJson(res, 200, { ok: true, history });
      return;
    }

    if (url.pathname === "/api/market/feedback" && req.method === "POST") {
      const body = await readJsonBody(req);
      const feedback = await saveMarketFeedback(body, requireAuth(req));
      const report = await getMarketReport(body.date || getShanghaiDate(), { rebuild: true });
      sendJson(res, 200, {
        ok: true,
        feedback,
        report,
      });
      return;
    }

    if (url.pathname === "/api/submissions") {
      if (!requireAuth(req)) {
        sendJson(res, 401, { ok: false, error: "请先登录" });
        return;
      }
      await initDb();
      if (req.method === "GET") {
        const rows = await mysqlJson(`
          SELECT COALESCE(JSON_ARRAYAGG(
            JSON_OBJECT(
              'id', id,
              'name', name,
              'url', url,
              'topic', topic,
              'status', status,
              'created_at', DATE_FORMAT(created_at, '%Y-%m-%d %H:%i')
            )
          ), JSON_ARRAY())
          FROM (
            SELECT * FROM yimin_source_submissions
            ORDER BY FIELD(status, 'pending', 'accepted', 'rejected'), created_at DESC
          ) sorted;
        `);
        sendJson(res, 200, { ok: true, submissions: rows || [] });
        return;
      }
    }

    if (url.pathname.startsWith("/api/submissions/") && req.method === "PUT") {
      if (!requireAuth(req)) {
        sendJson(res, 401, { ok: false, error: "请先登录" });
        return;
      }
      await initDb();
      const parts = url.pathname.replace("/api/submissions/", "").split("/");
      const subId = Number(parts[0]);
      if (!subId) {
        sendJson(res, 400, { ok: false, error: "Invalid id" });
        return;
      }
      const body = await readJsonBody(req);

      if (body.status === "accepted") {
        const type = body.type || "rss";
        const country = body.country || "待分类";
        const category = body.category || "用户提报";
        const priority = Number(body.priority) || 50;
        await mysqlExec(`
          UPDATE yimin_source_submissions SET status = 'accepted' WHERE id = ${sqlNumber(subId)};
        `);
        await mysqlExec(`
          UPDATE yimin_sources
          SET enabled = 1, type = ${sqlString(type)}, country = ${sqlString(country)},
              category = ${sqlString(category)}, priority = ${sqlNumber(priority)}
          WHERE url = (SELECT url FROM yimin_source_submissions WHERE id = ${sqlNumber(subId)});
        `);
        cache = null;
        sendJson(res, 200, { ok: true });
        return;
      }

      if (body.status === "rejected") {
        await mysqlExec(`
          UPDATE yimin_source_submissions SET status = 'rejected' WHERE id = ${sqlNumber(subId)};
        `);
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 400, { ok: false, error: "status must be accepted or rejected" });
      return;
    }

    if (url.pathname === "/api/feedback") {
      if (req.method === "GET") {
        if (!requireAuth(req)) {
          sendJson(res, 401, { ok: false, error: "请先登录" });
          return;
        }
        const feedback = await listFeedback({
          status: url.searchParams.get("status") || "",
        });
        sendJson(res, 200, { ok: true, feedback });
        return;
      }

      if (req.method === "POST") {
        const body = await readJsonBody(req);
        await saveFeedback(body, { session: requireAuth(req), req });
        sendJson(res, 201, {
          ok: true,
        });
        return;
      }
    }

    if (url.pathname.startsWith("/api/feedback/") && req.method === "PUT") {
      if (!requireAuth(req)) {
        sendJson(res, 401, { ok: false, error: "请先登录" });
        return;
      }
      const feedbackId = Number(url.pathname.replace("/api/feedback/", "").split("/")[0]);
      const body = await readJsonBody(req);
      await updateFeedback(feedbackId, body);
      sendJson(res, 200, {
        ok: true,
      });
      return;
    }

    if (url.pathname === "/api/push/open-event" && req.method === "POST") {
      if (!wxWorkConfig.openDebug) {
        sendJson(res, 200, { ok: true, disabled: true });
        return;
      }
      const body = await readJsonBody(req);
      const token = String(body.token || "");
      if (!/^[a-kmnp-z2-9]{12}$/i.test(token)) {
        sendJson(res, 400, { ok: false, error: "Invalid token" });
        return;
      }
      await recordPushOpenEvent({
        token,
        eventName: body.eventName || "",
        eventDetail: body.eventDetail || "",
        ip: getClientIp(req),
        userAgent: req.headers["user-agent"] || "",
      });
      sendJson(res, 201, { ok: true });
      return;
    }

    // ── Push visit tracking: /d/:token ──
    if (url.pathname.startsWith("/d/") && req.method === "GET") {
      const token = url.pathname.replace("/d/", "").split("/")[0];
      if (token && /^[a-kmnp-z2-9]{12}$/i.test(token)) {
        const ip = getClientIp(req);
        const visitInfo = await recordPushVisit(token, ip);
        const identityCookies = buildIdentityCookies({
          userName: visitInfo?.username,
          userId: visitInfo?.userid,
        });

        const targetUrl = buildPublicUrl(req, "/#daily");
        const ua = (req.headers["user-agent"] || "").toLowerCase();

        if (ua.includes("wxwork")) {
          const currentUrl = buildPublicUrl(req, `${url.pathname}${url.search}`);
          let jsConfig = null;
          let agentConfig = null;
          let signatureError = "";
          try {
            const accessToken = await getWxAccessToken();
            const ticket = await getWxJsapiTicket(accessToken);
            jsConfig = buildWxJsConfig(ticket, currentUrl);
            const agentTicket = await getWxAgentTicket(accessToken);
            agentConfig = buildWxJsConfig(agentTicket, currentUrl);
          } catch (err) {
            signatureError = err instanceof Error ? err.message : String(err);
            await recordPushOpenEvent({
              token,
              eventName: "server signature error",
              eventDetail: signatureError,
              ip,
              userAgent: req.headers["user-agent"] || "",
            }).catch(() => {});
          }

          const corpId = wxWorkConfig.corpId;
          const agentId = wxWorkConfig.agentId;
          const nonceStr = jsConfig ? jsConfig.nonceStr : "";
          const timestamp = jsConfig ? jsConfig.timestamp : "";
          const signature = jsConfig ? jsConfig.signature : "";
          const agentNonceStr = agentConfig ? agentConfig.nonceStr : "";
          const agentTimestamp = agentConfig ? agentConfig.timestamp : "";
          const agentSignature = agentConfig ? agentConfig.signature : "";
          const targetUrlJson = JSON.stringify(targetUrl);
          const tokenJson = JSON.stringify(token);
          const currentUrlJson = JSON.stringify(currentUrl);
          const corpIdJson = JSON.stringify(corpId);
          const nonceStrJson = JSON.stringify(nonceStr);
          const signatureJson = JSON.stringify(signature);
          const agentNonceStrJson = JSON.stringify(agentNonceStr);
          const agentSignatureJson = JSON.stringify(agentSignature);
          const hasWxSdkConfig = Boolean(corpId && agentId && signature && agentSignature);
          if (!hasWxSdkConfig && !signatureError) {
            signatureError = [
              !corpId ? "missing WX_WORK_CORP_ID" : "",
              !agentId ? "missing WX_WORK_AGENT_ID" : "",
              !signature ? "missing jsapi signature" : "",
              !agentSignature ? "missing agent signature" : "",
            ].filter(Boolean).join("; ");
          }
          const signatureErrorJson = JSON.stringify(signatureError);
          const openDebugJson = wxWorkConfig.openDebug ? "true" : "false";
          const debugMarkup = wxWorkConfig.openDebug
            ? '<p id="dbg" style="font-size:11px;color:#9ca3af;margin-top:12px;word-break:break-all;text-align:left;min-height:40px"></p>'
            : "";

          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            ...(identityCookies.length ? { "set-cookie": identityCookies } : {}),
          });
          res.end(`<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>移民热点日报</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d0d1a;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
.wrap{text-align:center;padding:24px;max-width:360px}
</style>
</head>
<body>
<div class="wrap">
<p>正在打开日报...</p>
${debugMarkup}
</div>
<script>
var targetUrl = ${targetUrlJson};
var token = ${tokenJson};
var currentUrl = ${currentUrlJson};
var openDebug = ${openDebugJson};
var dbg = openDebug ? document.getElementById('dbg') : null;
function sendEvent(name, detail) {
  if (!openDebug) return;
  try {
    var payload = JSON.stringify({
      token: token,
      eventName: String(name || '').slice(0, 80),
      eventDetail: String(detail || '').slice(0, 1200)
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/push/open-event', new Blob([payload], { type: 'application/json' }));
    } else {
      fetch('/api/push/open-event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, keepalive: true });
    }
  } catch(e) {}
}
function log(msg) {
  if (!openDebug) return;
  try {
    console.log('[daily-open]', msg);
    if (dbg) dbg.textContent += msg + "\\n";
    sendEvent(msg.split(':')[0].slice(0, 80), msg);
  } catch(e) {}
}
var done = false;
var openedExternal = false;
function go(reason) { if(!done){done=true;log('fallback: ' + (reason || 'redirect'));window.location.replace(targetUrl);} }
function tryOpenDefaultBrowser(source) {
  if (openedExternal || typeof wx === 'undefined') return;
  log('invoke start: ' + source);
  try {
    wx.invoke('openDefaultBrowser', { url: targetUrl }, function(res) {
      var msg = res && (res.err_msg || JSON.stringify(res));
      log('invoke result: ' + source + ' ' + msg);
      if (msg === 'openDefaultBrowser:ok') {
        openedExternal = true;
        go('opened external');
      } else {
        go('invoke failed');
      }
    });
  } catch(e) {
    log('invoke error: ' + source + ' ' + e.message);
    go('invoke error');
  }
}
log('1. page loaded');
log('2. sign=${signature ? "1" : "0"} agent=${agentSignature ? "1" : "0"} serverError=' + ${signatureErrorJson} + ' current=' + currentUrl + ' target=' + targetUrl + ' ua=' + navigator.userAgent);
setTimeout(function(){ go('timeout'); }, 1200);
</script>
<script src="https://res.wx.qq.com/open/js/jweixin-1.2.0.js"
  onload="log('3. sdk loaded')"
  onerror="log('3. sdk FAILED'); go('sdk failed');"></script>
<script>
log('4. after sdk tag');
try {
  var hasWxSdkConfig = ${hasWxSdkConfig ? "true" : "false"};
  if (!hasWxSdkConfig) {
    log('4a. missing wx sdk signature, normal redirect: ' + ${signatureErrorJson});
    setTimeout(function(){ go('missing signature'); }, 100);
  } else if(typeof wx === 'undefined') { log('4b. wx undefined'); go('wx undefined'); } else {
  wx.config({
    beta: true,
    debug: false,
    appId: ${corpIdJson},
    timestamp: ${Number(timestamp) || 0},
    nonceStr: ${nonceStrJson},
    signature: ${signatureJson},
    jsApiList: ['openDefaultBrowser']
  });
  log('5. config called');
  wx.ready(function() {
    log('5a. ready');
    tryOpenDefaultBrowser('config-ready');
    wx.agentConfig({
      corpid: ${corpIdJson},
      agentid: ${Number(agentId) || 0},
      timestamp: ${Number(agentTimestamp) || 0},
      nonceStr: ${agentNonceStrJson},
      signature: ${agentSignatureJson},
      jsApiList: ['openDefaultBrowser'],
      success: function() {
        log('5b. agentConfig ok');
        tryOpenDefaultBrowser('agentConfig');
      },
      fail: function(res) {
        log('5d. agentConfig fail: ' + JSON.stringify(res));
        go('agentConfig fail');
      }
    });
  });
  wx.error(function(res) {
    log('5e. config error: ' + JSON.stringify(res));
    go('config error');
  });
  }
} catch(e) {
  log('ERR: ' + e.message);
  go('exception');
}
</script>
</body></html>`);

          return;
        }

        res.writeHead(302, {
          Location: targetUrl,
          ...(identityCookies.length ? { "set-cookie": identityCookies } : {}),
        });
        res.end();
        return;
      }
      res.writeHead(302, { Location: "/" });
      res.end();
      return;
    }

    // ── WeChat Work JS-SDK signature ──
    if (url.pathname === "/api/wx/jsconfig" && req.method === "GET") {
      const callbackUrl = url.searchParams.get("url") || "";
      if (!callbackUrl) {
        sendJson(res, 400, { ok: false, error: "url param required" });
        return;
      }
      try {
        const accessToken = await getWxAccessToken();
        const ticket = await getWxJsapiTicket(accessToken);
        const config = buildWxJsConfig(ticket, callbackUrl);
        sendJson(res, 200, {
          ok: true,
          corpId: wxWorkConfig.corpId,
          agentId: wxWorkConfig.agentId,
          nonceStr: config.nonceStr,
          timestamp: config.timestamp,
          signature: config.signature,
        });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    // ── Push task management APIs ──
    if (url.pathname === "/api/wx/sync-contacts" && req.method === "POST") {
      if (!wxWorkConfig.corpId || !wxWorkConfig.secret) {
        sendJson(res, 400, {
          ok: false,
          error: "企业微信未配置（WX_WORK_CORP_ID / WX_WORK_SECRET）",
        });
        return;
      }

      try {
        const stats = await syncWxContacts();
        sendJson(res, 200, {
          ok: true,
          ...stats,
          message: "企业微信部门和成员同步完成。",
        });
      } catch (error) {
        sendJson(res, 502, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (url.pathname === "/api/push/tasks" && req.method === "GET") {
      if (!requireAuth(req)) {
        sendJson(res, 401, { ok: false, error: "请先登录" });
        return;
      }
      const tasks = await listPushTasks();
      sendJson(res, 200, { ok: true, tasks });
      return;
    }

    if (url.pathname === "/api/push/daily" && req.method === "POST") {
      const body = await readJsonBody(req);
      const dailyDate = body?.date || getShanghaiDate();

      if (!wxWorkConfig.corpId || !wxWorkConfig.secret) {
        sendJson(res, 400, { ok: false, error: "企业微信未配置（WX_WORK_CORP_ID / WX_WORK_SECRET）" });
        return;
      }

      const accessToken = await getWxAccessToken();
      const users = await getWxAllPushUsers(accessToken);

      if (users.length === 0) {
        sendJson(res, 400, { ok: false, error: "未找到推送目标用户，请检查 WX_WORK_PUSH_DEPT_IDS / WX_WORK_PUSH_EXCLUDE_DEPT_IDS" });
        return;
      }

      const taskId = await createPushTask(dailyDate, users);
      startPushTaskInBackground(taskId);

      sendJson(res, 202, {
        ok: true,
        taskId,
        status: "queued",
        totalCount: users.length,
        message: "日报推送任务已创建，正在后台发送。",
      });
      return;
    }

    if (url.pathname === "/api/push/retry" && req.method === "POST") {
      const body = await readJsonBody(req);
      const taskId = Number(body?.taskId);
      if (!taskId) {
        sendJson(res, 400, { ok: false, error: "taskId required" });
        return;
      }
      await retryFailedPushes(taskId);
      startPushTaskInBackground(taskId);
      sendJson(res, 202, {
        ok: true,
        taskId,
        status: "queued",
        message: "失败推送已重新排队，正在后台重试。",
      });
      return;
    }

    if (url.pathname.startsWith("/api/push/tasks/") && req.method === "GET") {
      if (!requireAuth(req)) {
        sendJson(res, 401, { ok: false, error: "请先登录" });
        return;
      }
      const taskId = Number(url.pathname.replace("/api/push/tasks/", ""));
      const status = url.searchParams.get("status") || null;
      const logs = await getPushTaskLogs(taskId, { status });
      sendJson(res, 200, { ok: true, logs });
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, host, () => {
  console.log(`Immigration Hot is running at http://${host}:${port}`);
});
