import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";

const rootDir = resolve(".");
await loadEnv();

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const cacheTtlMs = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);
const requestTimeoutMs = Number(process.env.FEED_TIMEOUT_MS || 9000);
const maxItemsPerSource = Number(process.env.MAX_ITEMS_PER_SOURCE || 16);
const maxTotalItems = Number(process.env.MAX_TOTAL_ITEMS || 80);
const dailyCandidatePageSize = Math.max(50, Number(process.env.DAILY_CANDIDATE_PAGE_SIZE || 200));
const dailyAnalysisBatchSize = Math.max(10, Number(process.env.DAILY_ANALYSIS_BATCH_SIZE || 30));
const dailyAnalysisConcurrency = Math.max(1, Number(process.env.DAILY_ANALYSIS_CONCURRENCY || 3));
const dailyFinalPromptMaxChars = Math.max(20000, Number(process.env.DAILY_FINAL_PROMPT_MAX_CHARS || 80000));
const dailyAnalysisVersion = "daily-analysis-v2";
const dailyLocalizationVersion = "daily-localization-v1";
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

const deepseekConfig = {
  apiKey: process.env.DEEPSEEK_API_KEY || "",
  baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
  model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
};
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
const firecrawlConfig = {
  apiKey: process.env.FIRECRAWL_API_KEY || "",
  baseUrl: "https://api.firecrawl.dev/v1",
};
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
const dailyLocalizationGenerationPromises = new Map();
const departmentDailyGenerationPromises = new Map();

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

function mysqlRun(sql, { database = true, json = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const args = [
      `-h${dbConfig.host}`,
      `-P${dbConfig.port}`,
      `-u${dbConfig.user}`,
      "--default-character-set=utf8mb4",
      "--connect-timeout=5",
      "--batch",
      "--raw",
    ];

    if (json) {
      args.push("--skip-column-names");
    }

    if (database) {
      args.push(dbConfig.database);
    }

    const child = spawn(dbConfig.mysqlBin, args, {
      env: {
        ...process.env,
        MYSQL_PWD: dbConfig.password,
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
      `);

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

      await ensureReportDateUniqueness();
      await seedConfiguredSources();
    })();
  }

  return dbReadyPromise;
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
        'analysisContentHash', analysis_content_hash
      )
    ), JSON_ARRAY())
    FROM (
      SELECT a.*, s.name AS source_name, ad.content_hash AS analysis_content_hash
      FROM yimin_articles a
      JOIN yimin_sources s ON s.id = a.source_id
      LEFT JOIN yimin_article_daily_analysis ad
        ON ad.article_hash = a.dedupe_hash
       AND ad.analysis_version = ${sqlString(dailyAnalysisVersion)}
      ORDER BY
        CASE WHEN ad.article_hash IS NULL THEN 0 ELSE 1 END,
        COALESCE(a.published_at, a.fetched_at) DESC,
        a.id DESC
      LIMIT ${sqlNumber(scanLimit, Math.max(articleRelevanceMaxPerRun * 3, articleRelevanceMaxPerRun))}
    ) pending_relevance;
  `)) || [];

  return rows
    .filter((item) => item.analysisContentHash !== getDailyAnalysisContentHash(item))
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

async function fetchWithTimeout(url, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

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

async function fetchWithFirecrawl(url) {
  if (!firecrawlConfig.apiKey) {
    return { ok: false, status: 0, error: "FIRECRAWL_API_KEY not configured" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(`${firecrawlConfig.baseUrl}/scrape`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${firecrawlConfig.apiKey}`,
      },
      body: JSON.stringify({ url, formats: ["markdown"] }),
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
      return { ok: false, status: response.status, error: data.error || `HTTP ${response.status}` };
    }

    const page = data.data || {};
    const metadata = page.metadata || {};
    const markdown = page.markdown || "";

    return {
      ok: true,
      title: metadata.title || "",
      summary: markdown.slice(0, 500),
      url: metadata.sourceURL || url,
      publishedAt: metadata.publishedTime || null,
    };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
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
    .replace(/雇主担(?:�{1,}|&amp;#65533;|&#65533;|\\ufffd)+/g, "雇主担保")
    .replace(/担(?:�{1,}|&amp;#65533;|&#65533;|\\ufffd)+/g, "担保")
    .replace(/(?:�|&amp;#65533;|&#65533;|\\ufffd)+/g, "")
    .trim();
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
    const results = await runWithConcurrency(sources, concurrency, async (source) => {
      const result = await fetchSource(source);
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
    });

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
- canonicalTopic 对同一政策或同一事件的不同媒体报道应尽量使用相同表述。
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
    console.error("Daily article analysis batch fallback:", error instanceof Error ? error.message : String(error));
  }
  return [...fallbackById.values()];
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
    if (existing?.contentHash === contentHash) {
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

  return `# 移民热点日报 | ${date}

> 统计窗口：${windowText}

## 一、今日总结

${todayNew.length ? `本期发现 ${todayNew.length} 条未在近 7 天日报中出现的新增事实，重点集中在 ${[...new Set(todayNew.map((item) => item.country).filter(Boolean))].slice(0, 4).join("、") || "多个地区"}。` : "本期暂无可确认的重大新增事实，避免把旧热点包装成今日新闻。"}

${reason ? `> AI 日报生成暂不可用：${reason}` : ""}

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
- 无法确认是否相关、或可能间接影响移民客户/项目判断的资讯，可以保留。
- 不要输出“已剔除内容”列表，也不要解释剔除过程。

发布时间过滤：
- 只使用“日报可选时间范围”内的资讯；发布时间早于该范围的内容不得出现在任何章节。
- 如果没有明确发布时间，但抓取时间在“日报可选时间范围”内，可以保留。

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
- 发布时间早于“日报可选时间范围”的信息必须剔除；无法确认发布时间但抓取时间较新的信息可以保留。
- 如果某条信息近 7 天已经出现，只能放在“延续关注”或“不建议重复”。
- 同一章节内如使用数字编号，必须连续递增，不要每条都写成”1.”。
- 所有输出必须使用简体中文，遇到英文、希腊文或其他语言的标题和摘要必须翻译为中文，不得保留原文。`;
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

  const response = await fetch(`${deepseekConfig.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${deepseekConfig.apiKey}`,
    },
    body: JSON.stringify({
      model: deepseekConfig.model,
      temperature,
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

  const data = await response.json();
  let content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("DeepSeek returned empty content");
  }

  // Remove non-CJK garbage: Greek, control chars, isolated combining marks
  content = content.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  content = content.replace(
    /[Ͱ-Ͽᴀ-ᶿἀ-῿Ⲁ-⳿]/g,
    "",
  );

  return sanitizeTextArtifacts(content);
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
  return `You are a senior immigration industry analyst. Generate an English immigration daily brief based only on the grouped event material below.

Date: ${baseReport.date}
Reporting window: ${baseReport.windowStart || ""} to ${baseReport.windowEnd || ""}
Window mode: ${baseReport.windowMode === "last24h" ? "last 24 hours morning brief" : "calendar-day daily brief"}
Candidate article count: ${baseReport.sourceItemCount}
Relevant article count: ${baseReport.relevantItemCount}
Grouped event count: ${baseReport.eventCount}

Grouped event material:
${formatDailyLocalizationEvents(events)}

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
- Preserve original links when a link is available.
- Translate Chinese event titles and summaries naturally into English.
- Output English only.`;
}

function buildEnglishDailyTranslationPrompt(baseReport) {
  return `Translate the following Chinese immigration daily brief into natural professional English Markdown.

Rules:
- Preserve the factual meaning, Markdown structure, and original links.
- Do not add new facts, dates, fees, policy interpretations, or conclusions.
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

  const events = await loadDailyLocalizationEvents(baseRow.id);
  const inputHash = getDailyLocalizationInputHash(baseRow, events, normalizedLanguage);
  if (!refresh) {
    const cached = await loadDailyLocalization(baseRow.id, normalizedLanguage);
    if (cached?.inputHash === inputHash) {
      return mergeDailyLocalization(baseRow, cached);
    }
  }

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

    if (existing) {
      if (existing.contentMarkdown) {
        existing.contentMarkdown = sanitizeTextArtifacts(existing.contentMarkdown);
        existing.html = markdownToHtml(existing.contentMarkdown);
      }
      return attachDailyWindowLabel({ ...existing, language: "zh" });
    }
  }

  const dailyContext = await buildDailyContext(date, { windowMode });
  const selectedItems = getDailyContextItems(dailyContext);
  const relevantItemCount = dailyContext.relevantItems.length;
  const eventCount = dailyContext.events.length;

  let markdown;
  let model = deepseekConfig.model;
  try {
    markdown = await callDeepSeek(await buildDailyPrompt(date, dailyContext));
  } catch (error) {
    model = "fallback";
    markdown = buildFallbackDailyMarkdown(
      date,
      dailyContext,
      error instanceof Error ? error.message : String(error),
    );
  }
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
  return report;
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const decodedPath = decodeURIComponent(url.pathname);
  const cleanPath = normalize(decodedPath).replace(/^(\.\.[/\\])+/, "");
  const relativePath = cleanPath === "/" ? "index.html" : cleanPath.replace(/^[/\\]/, "");
  const filePath = resolve(rootDir, relativePath);

  if (!(filePath === rootDir || filePath.startsWith(`${rootDir}/`)) || !existsSync(filePath)) {
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
- 全部使用简体中文。`;
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

    let markdown;
    let model = deepseekConfig.model;
    let status = "generated";
    let errorMessage = "";
    try {
      markdown = await callDeepSeek(buildDepartmentDailyPrompt({
        date,
        department,
        sources: input.sources,
        items: input.items,
        publicMarkdown: input.report.contentMarkdown,
      }));
    } catch (error) {
      status = "fallback";
      model = "fallback";
      errorMessage = error instanceof Error ? error.message : String(error);
      markdown = buildDepartmentDailyFallbackMarkdown(department, input.items, errorMessage);
    }

    return saveDepartmentDailyReport({
      date,
      department,
      input,
      markdown,
      model,
      status,
      error: errorMessage,
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

async function readJsonBody(req) {
  return new Promise((resolvePromise, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolvePromise({});
        return;
      }

      try {
        resolvePromise(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

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
      const report = await getDailyReport(url.searchParams.get("date") || getShanghaiDate(), {
        refresh: url.searchParams.get("refresh") === "1",
        windowMode: getDailyWindowModeFromSearch(url.searchParams),
        language: normalizeDailyLanguage(url.searchParams.get("lang")),
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

    if (url.pathname === "/api/daily/departments/generate" && req.method === "POST") {
      const body = await readJsonBody(req);
      const date = String(body.date || url.searchParams.get("date") || getShanghaiDate());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        sendJson(res, 400, {
          ok: false,
          error: "date must use YYYY-MM-DD",
        });
        return;
      }

      try {
        const result = await generateAllDepartmentDailyReports(date, {
          refresh: body.refresh === true || url.searchParams.get("refresh") === "1",
        });
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
