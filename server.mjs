import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const rootDir = resolve(".");
await loadEnv();

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const cacheTtlMs = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);
const requestTimeoutMs = Number(process.env.FEED_TIMEOUT_MS || 9000);
const maxItemsPerSource = Number(process.env.MAX_ITEMS_PER_SOURCE || 16);
const maxTotalItems = Number(process.env.MAX_TOTAL_ITEMS || 80);
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

  return sqlString(date.toISOString().slice(0, 19).replace("T", " "));
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
    child.stdin.end(sql);
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
        CREATE TABLE IF NOT EXISTS sources (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(160) NOT NULL,
          url VARCHAR(1200) NOT NULL,
          country VARCHAR(80) NOT NULL,
          category VARCHAR(120) NOT NULL,
          priority INT NOT NULL DEFAULT 70,
          enabled TINYINT(1) NOT NULL DEFAULT 1,
          last_fetched_at DATETIME NULL,
          last_fetch_error TEXT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_sources_url (url(768)),
          INDEX idx_sources_enabled (enabled),
          INDEX idx_sources_country (country)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

        CREATE TABLE IF NOT EXISTS articles (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          source_id BIGINT NOT NULL,
          dedupe_hash CHAR(40) NOT NULL,
          title VARCHAR(600) NOT NULL,
          summary TEXT NULL,
          url VARCHAR(1400) NULL,
          country VARCHAR(80) NOT NULL,
          category VARCHAR(120) NOT NULL,
          tags_json JSON NULL,
          image VARCHAR(1000) NULL,
          heat INT NOT NULL DEFAULT 60,
          impact VARCHAR(40) NOT NULL DEFAULT '中影响',
          published_at DATETIME NULL,
          fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          raw_json JSON NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_articles_hash (dedupe_hash),
          INDEX idx_articles_published (published_at),
          INDEX idx_articles_heat (heat),
          INDEX idx_articles_country (country),
          CONSTRAINT fk_articles_source FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

        CREATE TABLE IF NOT EXISTS fetch_runs (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          finished_at DATETIME NULL,
          status ENUM('running','completed','failed') NOT NULL DEFAULT 'running',
          source_count INT NOT NULL DEFAULT 0,
          item_count INT NOT NULL DEFAULT 0,
          error TEXT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

        CREATE TABLE IF NOT EXISTS daily_reports (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          report_date DATE NOT NULL,
          title VARCHAR(200) NOT NULL,
          content_markdown LONGTEXT NOT NULL,
          content_html LONGTEXT NOT NULL,
          source_item_count INT NOT NULL DEFAULT 0,
          model VARCHAR(120) NULL,
          generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_daily_reports_date (report_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

        CREATE TABLE IF NOT EXISTS source_submissions (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(160) NOT NULL,
          url VARCHAR(1200) NOT NULL,
          topic VARCHAR(200) NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          status ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
          INDEX idx_source_submissions_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

        CREATE TABLE IF NOT EXISTS feedback (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          type VARCHAR(120) NOT NULL,
          message TEXT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      await seedConfiguredSources();
    })();
  }

  return dbReadyPromise;
}

async function seedConfiguredSources() {
  const sources = await readSources();
  for (const source of sources) {
    await upsertSource(source, { enabled: true });
  }
}

async function upsertSource(source, { enabled = true } = {}) {
  await mysqlExec(`
    INSERT INTO sources (name, url, country, category, priority, enabled)
    VALUES (
      ${sqlString(source.name)},
      ${sqlString(source.url)},
      ${sqlString(source.country)},
      ${sqlString(source.category || "政策")},
      ${sqlNumber(source.priority, 70)},
      ${enabled ? 1 : 0}
    )
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      country = VALUES(country),
      category = VALUES(category),
      priority = VALUES(priority),
      enabled = VALUES(enabled),
      updated_at = CURRENT_TIMESTAMP;
  `);

  const row = await mysqlJson(`
    SELECT JSON_OBJECT('id', id)
    FROM sources
    WHERE url = ${sqlString(source.url)}
    LIMIT 1;
  `);

  return row?.id;
}

async function updateSourceFetchStatus(sourceId, error = null) {
  await mysqlExec(`
    UPDATE sources
    SET last_fetched_at = CURRENT_TIMESTAMP,
        last_fetch_error = ${sqlString(error)}
    WHERE id = ${sqlNumber(sourceId)};
  `);
}

async function createFetchRun(sourceCount) {
  const row = await mysqlJson(`
    INSERT INTO fetch_runs (source_count)
    VALUES (${sqlNumber(sourceCount)});
    SELECT JSON_OBJECT('id', LAST_INSERT_ID());
  `);
  return row?.id;
}

async function finishFetchRun(runId, { status, itemCount, error = null }) {
  await mysqlExec(`
    UPDATE fetch_runs
    SET status = ${sqlString(status)},
        item_count = ${sqlNumber(itemCount)},
        error = ${sqlString(error)},
        finished_at = CURRENT_TIMESTAMP
    WHERE id = ${sqlNumber(runId)};
  `);
}

async function upsertArticle(item, sourceId) {
  const rawJson = JSON.stringify(item);
  const tagsJson = JSON.stringify(item.tags || []);

  await mysqlExec(`
    INSERT INTO articles (
      source_id, dedupe_hash, title, summary, url, country, category,
      tags_json, image, heat, impact, published_at, raw_json
    )
    VALUES (
      ${sqlNumber(sourceId)},
      ${sqlString(item.id)},
      ${sqlString(item.title)},
      ${sqlString(item.summary)},
      ${sqlString(item.url)},
      ${sqlString(item.country)},
      ${sqlString(item.category)},
      CAST(${sqlString(tagsJson)} AS JSON),
      ${sqlString(item.image)},
      ${sqlNumber(item.heat, 60)},
      ${sqlString(item.impact)},
      ${sqlDate(item.publishedAt)},
      CAST(${sqlString(rawJson)} AS JSON)
    )
    ON DUPLICATE KEY UPDATE
      source_id = VALUES(source_id),
      title = VALUES(title),
      summary = VALUES(summary),
      url = VALUES(url),
      country = VALUES(country),
      category = VALUES(category),
      tags_json = VALUES(tags_json),
      image = VALUES(image),
      heat = VALUES(heat),
      impact = VALUES(impact),
      published_at = VALUES(published_at),
      fetched_at = CURRENT_TIMESTAMP,
      raw_json = VALUES(raw_json),
      updated_at = CURRENT_TIMESTAMP;
  `);
}

async function listArticlesFromDb(limit = maxTotalItems) {
  return (
    (await mysqlJson(`
      SELECT COALESCE(JSON_ARRAYAGG(
        JSON_OBJECT(
          'id', dedupe_hash,
          'title', title,
          'summary', COALESCE(summary, ''),
          'source', source_name,
          'country', country,
          'category', category,
          'time', COALESCE(DATE_FORMAT(published_at, '%H:%i'), '刚刚'),
          'publishedAt', IF(published_at IS NULL, NULL, DATE_FORMAT(published_at, '%Y-%m-%dT%H:%i:%s.000Z')),
          'url', url,
          'heat', heat,
          'impact', impact,
          'tags', CAST(tags_json AS JSON),
          'image', image
        )
      ), JSON_ARRAY())
      FROM (
        SELECT a.*, s.name AS source_name
        FROM articles a
        JOIN sources s ON s.id = a.source_id
        ORDER BY a.heat DESC, COALESCE(a.published_at, a.fetched_at) DESC, a.id DESC
        LIMIT ${sqlNumber(limit, maxTotalItems)}
      ) ranked;
    `)) || []
  );
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
          'lastFetchedAt', IF(last_fetched_at IS NULL, NULL, DATE_FORMAT(last_fetched_at, '%Y-%m-%dT%H:%i:%s.000Z'))
        )
      ), JSON_ARRAY())
      FROM (
        SELECT s.*,
          (SELECT COUNT(*) FROM articles a WHERE a.source_id = s.id) AS article_count
        FROM sources s
        WHERE s.enabled = 1
        ORDER BY s.id
      ) source_rows;
    `)) || []
  );
}

async function saveSourceSubmission(data) {
  await initDb();
  await mysqlExec(`
    INSERT INTO source_submissions (name, url, topic)
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
    },
    { enabled: false },
  );
}

async function saveFeedback(data) {
  await initDb();
  await mysqlExec(`
    INSERT INTO feedback (type, message)
    VALUES (${sqlString(data.type || "页面反馈")}, ${sqlString(data.message || "")});
  `);
}

async function readSources() {
  const sourcePath = join(rootDir, "data", "sources.json");
  const raw = await readFile(sourcePath, "utf8");
  return JSON.parse(raw);
}

async function fetchWithTimeout(url, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "ImmigrationHot/0.2 (+local prototype)",
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

function cleanText(value) {
  return decodeEntities(
    String(value || "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function truncate(value, maxLength = 150) {
  if (!value) {
    return "";
  }

  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
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
    if (sourceType === "html") {
      extraHeaders.accept = "text/html, */*";
    } else if (sourceType === "json") {
      extraHeaders.accept = "application/json, */*";
    }

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

    let items;
    if (sourceType === "rss" || sourceType === "twitter") {
      items = parseFeed(response.text, source);
    } else if (sourceType === "html") {
      items = parseHtml(response.text, source);
    } else if (sourceType === "json") {
      items = parseJson(response.text, source);
    } else {
      items = [];
    }

    for (const item of items) {
      await upsertArticle(item, sourceId);
    }
    await updateSourceFetchStatus(sourceId, null);

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

async function refreshFeeds() {
  await initDb();
  const sources = (await readSources()).filter((source) => source.enabled !== false);
  const runId = await createFetchRun(sources.length);

  try {
    const results = await Promise.all(sources.map(fetchSource));
    const itemCount = results.reduce((sum, result) => sum + result.items.length, 0);
    await finishFetchRun(runId, {
      status: "completed",
      itemCount,
    });
    return results.map((result) => result.status);
  } catch (error) {
    await finishFetchRun(runId, {
      status: "failed",
      itemCount: 0,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    throw error;
  }
}

async function getNews({ force = false } = {}) {
  await initDb();

  if (!force && cache && cache.expiresAt > Date.now()) {
    return cache.payload;
  }

  let statuses = await listSourceStatusesFromDb();
  let items = await listArticlesFromDb(maxTotalItems);

  if (force || items.length === 0) {
    statuses = await refreshFeeds();
    items = await listArticlesFromDb(maxTotalItems);
  }

  const generatedAt = new Date().toISOString();
  const payload = {
    ok: true,
    live: true,
    generatedAt,
    cacheTtlMs,
    sourceCount: statuses.length,
    itemCount: items.length,
    items,
    sources: statuses,
  };

  cache = {
    expiresAt: Date.now() + cacheTtlMs,
    payload,
  };

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
      const level = heading[1].length + 1;
      html.push(`<h${level}>${escapeHtml(heading[2])}</h${level}>`);
      continue;
    }

    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      if (listType !== "ol") {
        closeList();
        listType = "ol";
        html.push("<ol>");
      }
      html.push(`<li>${formatInlineMarkdown(ordered[1])}</li>`);
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
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );
}

function buildFallbackDailyMarkdown(date, items, reason = "") {
  const countries = [...new Set(items.map((item) => item.country).filter(Boolean))].slice(0, 5);
  const categories = [...new Set(items.map((item) => item.category).filter(Boolean))].slice(0, 6);
  const topItems = items.slice(0, 8);

  return `# 移民热点日报 | ${date}

## 一、今日总结

今日共收录 ${items.length} 条移民相关动态，覆盖 ${countries.join("、") || "多个国家/地区"}。重点主题集中在 ${categories.join("、") || "政策、签证、排期"}。

${reason ? `> AI 日报生成暂不可用：${reason}` : ""}

## 二、重要信息

- 美国 EB-5、身份调整、签证排期和资金合规仍是高热度关注点。
- 加拿大与英国官方动态适合项目经理持续跟进，尤其是工签、雇主担保和顾问合规。
- 销售侧建议把等待周期、材料边界和政策不确定性放在咨询前段说明。

## 三、热点列表

${topItems
  .map((item, index) => `${index + 1}. [${item.title}](${item.url || "#"}) - ${item.summary}`)
  .join("\n")}

## 四、建议关注

- 更新美国 EB-5 与签证排期 FAQ。
- 跟进加拿大 IRCC 官方公告，筛出对省提名、EE、工签客户有直接影响的信息。
- 对英国雇主担保与 eVisa 内容建立单独解释卡片。`;
}

function buildDailyPrompt(date, items) {
  const articleLines = items
    .slice(0, 28)
    .map(
      (item, index) =>
        `${index + 1}. 标题：${item.title}
来源：${item.source}
国家：${item.country}
主题：${item.category}
热度：${item.heat}
链接：${item.url || ""}
摘要：${item.summary}`,
    )
    .join("\n\n");

  return `你是一位资深移民行业信息分析师。请基于以下抓取到的移民资讯，生成中文移民热点日报。

日期：${date}
资讯数量：${items.length}

${articleLines}

请严格使用 Markdown，包含以下四节：
## 一、今日总结
用 3-5 句话概括主要变化。

## 二、重要信息
列出 3-6 条最值得项目经理关注的信息，明确国家、项目、影响对象。

## 三、按主题整理
按主题归纳，不要简单逐条复述。重要条目保留原文链接，格式为 [标题](链接)。

## 四、建议关注
给销售、文案、项目经理各 1-2 条行动建议。

要求：客观、专业、中文表达，不夸大政策影响，不编造原文没有的信息。`;
}

async function callDeepSeek(prompt) {
  if (!deepseekConfig.apiKey) {
    throw new Error("DeepSeek API key is not configured");
  }

  const response = await fetch(`${deepseekConfig.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${deepseekConfig.apiKey}`,
    },
    body: JSON.stringify({
      model: deepseekConfig.model,
      temperature: 0.25,
      messages: [
        {
          role: "system",
          content:
            "你是移民政策日报编辑，只能基于用户提供的信息进行归纳，不能编造政策、日期、费用或结论。",
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
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("DeepSeek returned empty content");
  }

  return content;
}

async function getDailyReport(date = getShanghaiDate(), { refresh = false } = {}) {
  await initDb();

  if (!refresh) {
    const existing = await mysqlJson(`
      SELECT JSON_OBJECT(
        'date', DATE_FORMAT(report_date, '%Y-%m-%d'),
        'title', title,
        'contentMarkdown', content_markdown,
        'html', content_html,
        'sourceItemCount', source_item_count,
        'model', model,
        'generatedAt', DATE_FORMAT(generated_at, '%Y-%m-%dT%H:%i:%s.000Z')
      )
      FROM daily_reports
      WHERE report_date = ${sqlString(date)}
      LIMIT 1;
    `);

    if (existing) {
      return existing;
    }
  }

  let items = await listArticlesFromDb(maxTotalItems);
  if (items.length === 0) {
    await refreshFeeds();
    items = await listArticlesFromDb(maxTotalItems);
  }

  let markdown;
  let model = deepseekConfig.model;
  try {
    markdown = await callDeepSeek(buildDailyPrompt(date, items));
  } catch (error) {
    model = "fallback";
    markdown = buildFallbackDailyMarkdown(
      date,
      items,
      error instanceof Error ? error.message : String(error),
    );
  }

  const title = `移民热点日报（${date}）`;
  const html = markdownToHtml(markdown);

  await mysqlExec(`
    INSERT INTO daily_reports (
      report_date, title, content_markdown, content_html, source_item_count, model, generated_at
    )
    VALUES (
      ${sqlString(date)},
      ${sqlString(title)},
      ${sqlString(markdown)},
      ${sqlString(html)},
      ${sqlNumber(items.length)},
      ${sqlString(model)},
      CURRENT_TIMESTAMP
    )
    ON DUPLICATE KEY UPDATE
      title = VALUES(title),
      content_markdown = VALUES(content_markdown),
      content_html = VALUES(content_html),
      source_item_count = VALUES(source_item_count),
      model = VALUES(model),
      generated_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP;
  `);

  return {
    date,
    title,
    contentMarkdown: markdown,
    html,
    sourceItemCount: items.length,
    model,
    generatedAt: new Date().toISOString(),
  };
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
    "cache-control": ext === ".html" ? "no-store" : "public, max-age=60",
  });
  res.end(body);
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

    if (url.pathname === "/api/health") {
      await initDb();
      sendJson(res, 200, {
        ok: true,
        service: "immigration-hot",
        database: dbConfig.database,
        time: new Date().toISOString(),
      });
      return;
    }

    if (url.pathname === "/api/sources") {
      await initDb();
      if (req.method === "POST") {
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

    if (url.pathname === "/api/news") {
      const payload = await getNews({ force: url.searchParams.get("refresh") === "1" });
      sendJson(res, 200, payload);
      return;
    }

    if (url.pathname === "/api/daily") {
      const report = await getDailyReport(url.searchParams.get("date") || getShanghaiDate(), {
        refresh: url.searchParams.get("refresh") === "1",
      });
      sendJson(res, 200, {
        ok: true,
        report,
      });
      return;
    }

    if (url.pathname === "/api/feedback" && req.method === "POST") {
      const body = await readJsonBody(req);
      await saveFeedback(body);
      sendJson(res, 201, {
        ok: true,
      });
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
