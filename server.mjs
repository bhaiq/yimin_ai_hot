import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const rootDir = resolve(".");
await loadEnv();

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const cacheTtlMs = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);
const requestTimeoutMs = Number(process.env.FEED_TIMEOUT_MS || 9000);
const maxItemsPerSource = Number(process.env.MAX_ITEMS_PER_SOURCE || 16);
const maxTotalItems = Number(process.env.MAX_TOTAL_ITEMS || 80);
const dailyCandidateLimit = Number(process.env.DAILY_CANDIDATE_LIMIT || Math.max(maxTotalItems * 8, 600));
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

function sqlJson(value) {
  return `CAST(${sqlString(JSON.stringify(value ?? null))} AS JSON)`;
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
        CREATE TABLE IF NOT EXISTS yimin_sources (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          name VARCHAR(160) NOT NULL COMMENT '来源名称',
          url VARCHAR(1200) NOT NULL COMMENT 'RSS 订阅地址',
          country VARCHAR(80) NOT NULL COMMENT '所属国家/地区',
          category VARCHAR(120) NOT NULL COMMENT '分类（如政策、签证、生活等）',
          priority INT NOT NULL DEFAULT 70 COMMENT '优先级 0-100，越高越重要',
          type VARCHAR(20) NOT NULL DEFAULT 'rss' COMMENT '来源类型（rss/twitter/html/json/website）',
          enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否启用（1=启用 0=禁用）',
          last_fetched_at DATETIME NULL COMMENT '最后一次抓取时间',
          last_fetch_error TEXT NULL COMMENT '最后一次抓取错误信息',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          UNIQUE KEY uk_sources_url (url(768)),
          INDEX idx_sources_enabled (enabled),
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
          category VARCHAR(120) NOT NULL COMMENT '分类（如政策、签证、生活等）',
          tags_json JSON NULL COMMENT '标签列表，JSON 数组格式',
          image VARCHAR(1000) NULL COMMENT '文章配图 URL',
          heat INT NOT NULL DEFAULT 60 COMMENT '热度评分 0-100',
          impact VARCHAR(40) NOT NULL DEFAULT '中影响' COMMENT '影响力等级（高影响/中影响/低影响）',
          published_at DATETIME NULL COMMENT '文章发布时间',
          fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '抓取入库时间',
          raw_json JSON NULL COMMENT '原始 RSS 条目 JSON 数据',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          UNIQUE KEY uk_articles_hash (dedupe_hash),
          INDEX idx_articles_published (published_at),
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
          model VARCHAR(120) NULL COMMENT '生成报告所用的 AI 模型名称',
          generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '报告生成时间',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
          UNIQUE KEY uk_yimin_daily_reports_date (report_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI 每日移民报告表';

        CREATE TABLE IF NOT EXISTS yimin_daily_report_items (
          id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
          report_id BIGINT NOT NULL COMMENT '日报 ID',
          article_hash CHAR(40) NOT NULL COMMENT '文章去重哈希',
          topic_key VARCHAR(160) NOT NULL COMMENT '归一化主题 Key',
          section VARCHAR(40) NOT NULL COMMENT '日报分组（today_new/important/continuing/repeated）',
          article_date DATETIME NULL COMMENT '文章发布时间或抓取时间',
          article_snapshot JSON NOT NULL COMMENT '文章快照',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
          UNIQUE KEY uk_daily_report_item (report_id, article_hash, section),
          INDEX idx_daily_report_items_hash (article_hash),
          INDEX idx_daily_report_items_topic (topic_key),
          INDEX idx_daily_report_items_section (section),
          CONSTRAINT fk_daily_report_items_report FOREIGN KEY (report_id) REFERENCES yimin_daily_reports(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='日报引用文章明细表';

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
          message TEXT NULL COMMENT '反馈内容',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '反馈时间'
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

        CREATE TABLE IF NOT EXISTS yimin_wx_token_cache (
          id INT AUTO_INCREMENT PRIMARY KEY,
          access_token VARCHAR(512) NOT NULL COMMENT '企业微信 access_token',
          expires_at DATETIME NOT NULL COMMENT '过期时间',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '缓存时间'
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='企业微信令牌缓存';
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
      'startedAt', DATE_FORMAT(started_at, '%Y-%m-%dT%H:%i:%s.000Z'),
      'finishedAt', IF(finished_at IS NULL, NULL, DATE_FORMAT(finished_at, '%Y-%m-%dT%H:%i:%s.000Z'))
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
      'startedAt', DATE_FORMAT(started_at, '%Y-%m-%dT%H:%i:%s.000Z'),
      'finishedAt', IF(finished_at IS NULL, NULL, DATE_FORMAT(finished_at, '%Y-%m-%dT%H:%i:%s.000Z'))
    )
    FROM yimin_fetch_runs
    ORDER BY id DESC
    LIMIT 1;
  `);
  return normalizeFetchRun(run);
}

async function upsertArticle(item, sourceId) {
  const rawJson = JSON.stringify(item);
  const tagsJson = JSON.stringify(item.tags || []);

  await mysqlExec(`
    INSERT INTO yimin_articles (
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
      published_at = COALESCE(published_at, VALUES(published_at)),
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
          'fetchedAt', IF(fetched_at IS NULL, NULL, DATE_FORMAT(fetched_at, '%Y-%m-%dT%H:%i:%s.000Z')),
          'url', url,
          'heat', heat,
          'impact', impact,
          'tags', CAST(tags_json AS JSON),
          'image', image
        )
      ), JSON_ARRAY())
      FROM (
        SELECT a.*, s.name AS source_name
        FROM yimin_articles a
        JOIN yimin_sources s ON s.id = a.source_id
        ORDER BY a.heat DESC, COALESCE(a.published_at, a.fetched_at) DESC, a.id DESC
        LIMIT ${sqlNumber(limit, maxTotalItems)}
      ) ranked;
    `)) || []
  );
}

async function listRecentArticlesFromDb(limit = Math.max(maxTotalItems * 2, 160)) {
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
          'fetchedAt', IF(fetched_at IS NULL, NULL, DATE_FORMAT(fetched_at, '%Y-%m-%dT%H:%i:%s.000Z')),
          'url', url,
          'heat', heat,
          'impact', impact,
          'tags', CAST(tags_json AS JSON),
          'image', image
        )
      ), JSON_ARRAY())
      FROM (
        SELECT a.*, s.name AS source_name
        FROM yimin_articles a
        JOIN yimin_sources s ON s.id = a.source_id
        ORDER BY COALESCE(a.published_at, a.fetched_at) DESC, a.heat DESC, a.id DESC
        LIMIT ${sqlNumber(limit, Math.max(maxTotalItems * 2, 160))}
      ) ranked;
    `)) || []
  );
}

async function listDailyCandidateArticlesFromDb(window, limit = dailyCandidateLimit) {
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
          'fetchedAt', IF(fetched_at IS NULL, NULL, DATE_FORMAT(fetched_at, '%Y-%m-%dT%H:%i:%s.000Z')),
          'url', url,
          'heat', heat,
          'impact', impact,
          'tags', CAST(tags_json AS JSON),
          'image', image
        )
      ), JSON_ARRAY())
      FROM (
        SELECT a.*, s.name AS source_name, COALESCE(a.published_at, a.fetched_at) AS article_at
        FROM yimin_articles a
        JOIN yimin_sources s ON s.id = a.source_id
        WHERE COALESCE(a.published_at, a.fetched_at) >= ${sqlDate(window.recentStart)}
          AND COALESCE(a.published_at, a.fetched_at) < ${sqlDate(window.end)}
        ORDER BY a.heat DESC, article_at DESC, a.id DESC
        LIMIT ${sqlNumber(limit, dailyCandidateLimit)}
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
          (SELECT COUNT(*) FROM yimin_articles a WHERE a.source_id = s.id) AS article_count
        FROM yimin_sources s
        WHERE s.enabled = 1
        ORDER BY s.id
      ) source_rows;
    `)) || []
  );
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
        'updatedAt', DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.000Z')
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
        latest: latestDate ? latestDate.toISOString() : null,
        suggestion: "今日不单独发新热点，可使用常青科普或等待新政策变化。",
      };
    })
    .filter((project) => !project.hasFresh)
    .slice(0, 8);

  const report = {
    date,
    title: `市场素材日报（${date}）`,
    generatedAt: new Date().toISOString(),
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
                'updatedAt', DATE_FORMAT(f.updated_at, '%Y-%m-%dT%H:%i:%s.000Z')
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
          'latest', IF(latest_article_at IS NULL, NULL, DATE_FORMAT(latest_article_at, '%Y-%m-%dT%H:%i:%s.000Z')),
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
      'generatedAt', DATE_FORMAT(generated_at, '%Y-%m-%dT%H:%i:%s.000Z')
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
          'generatedAt', DATE_FORMAT(generated_at, '%Y-%m-%dT%H:%i:%s.000Z')
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
};

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
    FROM yimin_wx_token_cache ORDER BY id DESC LIMIT 1
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
    VALUES (${sqlString(data.access_token)}, ${sqlDate(expiresAt.toISOString())})
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
    VALUES ('', ${sqlDate(expiresAt.toISOString())}, ${sqlString(data.ticket)})
  `);

  return data.ticket;
}

function buildWxJsConfig(jsapiTicket, url) {
  const nonceStr = Math.random().toString(36).slice(2, 15);
  const timestamp = Math.floor(Date.now() / 1000);
  const string1 = `jsapi_ticket=${jsapiTicket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`;
  const signature = createHash("sha1").update(string1).digest("hex");
  return { nonceStr, timestamp, signature };
}

async function getWxDepartmentUsers(accessToken, deptId) {
  const url = `https://qyapi.weixin.qq.com/cgi-bin/user/simplelist?access_token=${accessToken}&department_id=${deptId}&fetch_child=1`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.errcode !== 0) {
    throw new Error(`WeChat Work user list failed (dept ${deptId}): ${data.errcode} ${data.errmsg}`);
  }
  return (data.userlist || []).map((u) => ({
    userid: String(u.userid || ""),
    name: String(u.name || ""),
  }));
}

async function getWxAllPushUsers(accessToken) {
  const seen = new Set();
  const users = [];
  const deptIds = wxWorkConfig.pushDeptIds.length > 0
    ? wxWorkConfig.pushDeptIds
    : [1];

  for (const deptId of deptIds) {
    const deptUsers = await getWxDepartmentUsers(accessToken, deptId);
    for (const u of deptUsers) {
      if (u.userid && !seen.has(u.userid)) {
        seen.add(u.userid);
        users.push(u);
      }
    }
  }
  return users;
}

async function sendWxTextCard(accessToken, userIds, title, description, url) {
  const toUser = userIds.join("|");
  if (!toUser) return { errcode: 0, errmsg: "no users" };

  const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      touser: toUser,
      msgtype: "textcard",
      agentid: wxWorkConfig.agentId,
      textcard: { title, description, url, btntxt: "查看日报" },
    }),
  });
  return res.json();
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
  let sentCount = 0;
  let failedCount = 0;
  const batchSize = 100;

  for (const logEntry of allLogs) {
    const dailyUrl = `${baseUrl}/d/${logEntry.token}`;
    const title = "移民热点日报";
    const description = `${dailyDate} 移民政策日报已生成，点击查看今日动态。`;

    try {
      const result = await sendWxTextCard(accessToken, [logEntry.userid], title, description, dailyUrl);

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

  return { taskId: log.task_id || log.taskId, userid: log.userid, username: log.username };
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
          'startedAt', DATE_FORMAT(started_at, '%Y-%m-%dT%H:%i:%s.000Z'),
          'finishedAt', DATE_FORMAT(finished_at, '%Y-%m-%dT%H:%i:%s.000Z')
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
          'sentAt', DATE_FORMAT(sent_at, '%Y-%m-%dT%H:%i:%s.000Z'),
          'visitAt', DATE_FORMAT(visit_at, '%Y-%m-%dT%H:%i:%s.000Z'),
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
  return executePushTask(taskId);
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

async function saveFeedback(data) {
  await initDb();
  await mysqlExec(`
    INSERT INTO yimin_feedback (type, message)
    VALUES (${sqlString(data.type || "页面反馈")}, ${sqlString(data.message || "")});
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
        title: result.title,
        summary: result.summary,
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
    startedAt: new Date().toISOString(),
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

function getDailyWindowLabel(window) {
  if (!window?.start || !window?.end) {
    return "";
  }
  return `${formatShanghaiDateTime(window.start)} - ${formatShanghaiDateTime(window.end)}`;
}

function getDailyDateWindow(date, mode = "calendar", now = new Date()) {
  const normalizedMode = normalizeDailyWindowMode(mode, "calendar");
  if (normalizedMode === "last24h") {
    const end = now;
    const start = new Date(end.getTime() - 24 * 36e5);
    const recentStart = new Date(end.getTime() - 72 * 36e5);
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
  const recentStart = new Date(end.getTime() - 72 * 36e5);
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
  const freshness = ageHours <= 24 ? 35 : ageHours <= 72 ? 18 : 0;
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
      AND r.report_date >= DATE_SUB(${sqlString(date)}, INTERVAL ${sqlNumber(lookbackDays, 7)} DAY);
  `);

  const byHash = new Map();
  const byTopic = new Map();
  for (const row of rows || []) {
    if (row.articleHash && !byHash.has(row.articleHash)) byHash.set(row.articleHash, row);
    if (row.topicKey && !byTopic.has(row.topicKey)) byTopic.set(row.topicKey, row);
  }
  return { rows: rows || [], byHash, byTopic };
}

function uniqueDailyItemsByTopic(items) {
  const usedTopics = new Set();
  return items
    .sort((a, b) => b.dailyScore - a.dailyScore)
    .filter((item) => {
      if (usedTopics.has(item.topicKey)) return false;
      usedTopics.add(item.topicKey);
      return true;
    });
}

async function buildDailyContext(date, { windowMode = "calendar" } = {}) {
  const window = getDailyDateWindow(date, windowMode);
  let items = await listDailyCandidateArticlesFromDb(window);
  if (items.length === 0) {
    await refreshFeeds();
    items = await listDailyCandidateArticlesFromDb(window);
  }

  const usage = await getRecentDailyUsage(date);
  const enriched = items.map((item) => {
    const articleDate = getDailyArticleDate(item);
    const topicKey = getDailyTopicKey(item);
    const recentUsage = usage.byHash.get(item.id) || usage.byTopic.get(topicKey) || null;
    const ageHours = articleDate ? Math.max(0, (window.end.getTime() - articleDate.getTime()) / 36e5) : 999;
    const isToday = articleDate ? articleDate >= window.start && articleDate < window.end : false;
    const isRecent = articleDate ? articleDate >= window.recentStart && articleDate < window.end : false;
    return {
      ...item,
      articleDate: articleDate ? articleDate.toISOString() : null,
      ageHours,
      isToday,
      isRecent,
      topicKey,
      recentUsage,
      dailyScore: getDailyItemScore(item, articleDate, window),
    };
  });

  const uniqueItems = uniqueDailyItemsByTopic(enriched);
  const todayNew = uniqueItems.filter((item) => item.isToday && !item.recentUsage).slice(0, 12);
  const todayKeys = new Set(todayNew.map((item) => item.id));
  const important = uniqueItems
    .filter((item) => item.isRecent && !item.isToday && !item.recentUsage && !todayKeys.has(item.id))
    .slice(0, 8);
  const selectedKeys = new Set([...todayNew, ...important].map((item) => item.id));
  const continuing = uniqueItems
    .filter((item) => item.isRecent && !selectedKeys.has(item.id))
    .slice(0, 8);
  const continuingKeys = new Set(continuing.map((item) => item.id));
  const repeated = uniqueItems
    .filter((item) => (item.recentUsage || !item.isRecent) && !selectedKeys.has(item.id) && !continuingKeys.has(item.id))
    .slice(0, 8);

  return {
    date,
    window,
    rawItems: items,
    todayNew: todayNew.map((item) => ({ ...item, dailySection: "today_new" })),
    important: important.map((item) => ({ ...item, dailySection: "important" })),
    continuing: continuing.map((item) => ({ ...item, dailySection: "continuing" })),
    repeated: repeated.map((item) => ({ ...item, dailySection: "repeated" })),
  };
}

function formatDailyPromptItems(items) {
  if (!items.length) {
    return "暂无。";
  }

  return items
    .map(
      (item, index) =>
        `${index + 1}. 标题：${item.title}
来源：${item.source}
国家：${item.country}
主题：${item.category}
热度：${item.heat}
时间：${item.articleDate || item.publishedAt || item.fetchedAt || "未知"}
链接：${item.url || ""}
摘要：${item.summary}
${item.recentUsage ? `历史状态：近 7 天已在 ${item.recentUsage.reportDate} 的 ${item.recentUsage.section} 中出现，不能写入今日总结。` : "历史状态：近 7 天未在日报中出现。"}`,
    )
    .join("\n\n");
}

function dailyItemLink(item) {
  return item.url ? `[${item.title}](${item.url})` : item.title;
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

function buildDailyPrompt(date, context) {
  return `你是一位资深移民行业信息分析师。请基于以下抓取到的移民资讯，生成中文移民热点日报。

日期：${date}
统计窗口：${context.window?.label || date}
窗口模式：${context.window?.mode === "last24h" ? "过去 24 小时早报" : "自然日完整日报"}
候选资讯总数：${context.rawItems.length}

【本期新增：只能这些内容进入“今日总结”】
${formatDailyPromptItems(context.todayNew)}

【重要变化：近 72 小时内，近 7 天日报未出现，但不是本期新增】
${formatDailyPromptItems(context.important)}

【延续关注：可作为跟进，不得包装为本期新增】
${formatDailyPromptItems(context.continuing)}

【不建议重复：过旧或近 7 天已出现】
${formatDailyPromptItems(context.repeated)}

请严格使用 Markdown，包含以下六节：
## 一、今日总结
只总结【本期新增】里的事实。若本期新增为空，必须明确写“本期暂无可确认的重大新增事实”，不要复述延续关注或不建议重复内容。

## 二、今日新增
列出本期新增事实，明确国家、项目、影响对象，并保留原文链接。

## 三、重要变化
列出不是本期新增、但近 72 小时内且近 7 天未写过的变化。

## 四、延续关注
列出需要跟进但不能当作今日新闻的内容，说明为什么不能重复包装。

## 五、不建议重复
列出过旧或近 7 天已出现的信息，提醒不要放进今日总结。

## 六、行动建议
给销售、文案、项目经理各 1-2 条行动建议。

硬性要求：
- 不要把【延续关注】或【不建议重复】写进“今日总结”。
- 不要编造政策、日期、费用、影响范围。
- 如果某条信息近 7 天已经出现，只能放在“延续关注”或“不建议重复”。
- 同一章节内如使用数字编号，必须连续递增，不要每条都写成“1.”。`;
}

function getDailyContextItems(context) {
  return [
    ...(context.todayNew || []),
    ...(context.important || []),
    ...(context.continuing || []),
    ...(context.repeated || []),
  ];
}

function getDailyArticleSnapshot(item) {
  return {
    id: item.id,
    title: item.title,
    summary: item.summary,
    source: item.source,
    country: item.country,
    category: item.category,
    time: item.time,
    publishedAt: item.publishedAt,
    fetchedAt: item.fetchedAt,
    articleDate: item.articleDate,
    url: item.url,
    heat: item.heat,
    impact: item.impact,
    tags: item.tags || [],
    image: item.image || "",
    recentUsage: item.recentUsage || null,
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
  `);

  for (const item of getDailyContextItems(context)) {
    await mysqlExec(`
      INSERT INTO yimin_daily_report_items (
        report_id, article_hash, topic_key, section, article_date, article_snapshot
      )
      VALUES (
        ${sqlNumber(reportId)},
        ${sqlString(item.id)},
        ${sqlString(item.topicKey)},
        ${sqlString(item.dailySection)},
        ${sqlDate(item.articleDate)},
        ${sqlJson(getDailyArticleSnapshot(item))}
      );
    `);
  }
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

async function getDailyReport(date = getShanghaiDate(), { refresh = false, windowMode = "calendar" } = {}) {
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
        'generatedAt', DATE_FORMAT(generated_at, '%Y-%m-%dT%H:%i:%s.000Z'),
        'windowMode', window_mode,
        'windowStart', IF(window_start_at IS NULL, NULL, DATE_FORMAT(window_start_at, '%Y-%m-%dT%H:%i:%s.000Z')),
        'windowEnd', IF(window_end_at IS NULL, NULL, DATE_FORMAT(window_end_at, '%Y-%m-%dT%H:%i:%s.000Z'))
      )
      FROM yimin_daily_reports
      WHERE report_date = ${sqlString(date)}
      LIMIT 1;
    `);

    if (existing) {
      if (existing.contentMarkdown) {
        existing.html = markdownToHtml(existing.contentMarkdown);
      }
      return attachDailyWindowLabel(existing);
    }
  }

  const dailyContext = await buildDailyContext(date, { windowMode });
  const selectedItems = getDailyContextItems(dailyContext);

  let markdown;
  let model = deepseekConfig.model;
  try {
    markdown = await callDeepSeek(buildDailyPrompt(date, dailyContext));
  } catch (error) {
    model = "fallback";
    markdown = buildFallbackDailyMarkdown(
      date,
      dailyContext,
      error instanceof Error ? error.message : String(error),
    );
  }

  const title = dailyContext.window.mode === "last24h" ? `移民热点早报（${date}）` : `移民热点日报（${date}）`;
  const html = markdownToHtml(markdown);

  await mysqlExec(`
    INSERT INTO yimin_daily_reports (
      report_date, window_start_at, window_end_at, window_mode,
      title, content_markdown, content_html, source_item_count, model, generated_at
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
      model = VALUES(model),
      generated_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP;
  `);
  await saveDailyReportItems(date, dailyContext);

  return attachDailyWindowLabel({
    date,
    title,
    contentMarkdown: markdown,
    html,
    sourceItemCount: selectedItems.length,
    model,
    windowMode: dailyContext.window.mode,
    windowStart: dailyContext.window.start.toISOString(),
    windowEnd: dailyContext.window.end.toISOString(),
    generatedAt: new Date().toISOString(),
  });
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

function requireAuth(req) {
  const cookies = parseCookies(req);
  const token = cookies.token;
  if (!token) return null;
  const session = sessions.get(token);
  return session || null;
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

    if (url.pathname === "/api/news") {
      const force = url.searchParams.get("refresh") === "1";
      const sync = url.searchParams.get("sync") === "1";
      const payload = await getNews({ force, background: force && !sync });
      sendJson(res, 200, payload);
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
      });
      sendJson(res, 200, {
        ok: true,
        report,
      });
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

    if (url.pathname === "/api/feedback" && req.method === "POST") {
      if (!requireAuth(req)) {
        sendJson(res, 401, { ok: false, error: "请先登录" });
        return;
      }
      const body = await readJsonBody(req);
      await saveFeedback(body);
      sendJson(res, 201, {
        ok: true,
      });
      return;
    }

    // ── Push visit tracking: /d/:token ──
    if (url.pathname.startsWith("/d/") && req.method === "GET") {
      const token = url.pathname.replace("/d/", "").split("/")[0];
      if (token && /^[a-kmnp-z2-9]{12}$/i.test(token)) {
        const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "";
        await recordPushVisit(token, ip);

        const targetUrl = `${process.env.PUBLIC_BASE_URL || ""}/#daily`;
        const ua = (req.headers["user-agent"] || "").toLowerCase();

        if (ua.includes("wxwork")) {
          const currentUrl = `${process.env.PUBLIC_BASE_URL || ""}/d/${token}`;
          let jsConfig = null;
          try {
            const accessToken = await getWxAccessToken();
            const ticket = await getWxJsapiTicket(accessToken);
            jsConfig = buildWxJsConfig(ticket, currentUrl);
          } catch {}

          const corpId = wxWorkConfig.corpId;
          const nonceStr = jsConfig ? jsConfig.nonceStr : "";
          const timestamp = jsConfig ? jsConfig.timestamp : "";
          const signature = jsConfig ? jsConfig.signature : "";

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>移民热点日报</title>
<script src="https://res.wx.qq.com/open/js/jweixin-1.2.0.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d0d1a;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
.wrap{text-align:center;padding:24px;max-width:320px}
</style>
</head>
<body>
<div class="wrap">
<p>正在打开日报...</p>
<p id="dbg" style="font-size:11px;color:#6b7280;margin-top:12px;word-break:break-all"></p>
</div>
<script>
var targetUrl = '${targetUrl}';
var dbg = document.getElementById('dbg');
function log(msg) { dbg.textContent += msg + '\\n'; }
log('corpId=${corpId} hasSign=${signature ? "1" : "0"}');
try {
  wx.config({
    beta: true,
    debug: true,
    appId: '${corpId}',
    timestamp: ${timestamp},
    nonceStr: '${nonceStr}',
    signature: '${signature}',
    jsApiList: ['openDefaultBrowser']
  });
  log('config called');
  wx.ready(function() {
    log('ready');
    wx.invoke('openDefaultBrowser', { url: targetUrl }, function(res) {
      log('invoke: ' + (res.err_msg || JSON.stringify(res)));
      if (res.err_msg !== 'openDefaultBrowser:ok') {
        window.location.href = targetUrl;
      }
    });
  });
  wx.error(function(res) {
    log('error: ' + JSON.stringify(res));
    setTimeout(function() { window.location.href = targetUrl; }, 3000);
  });
} catch(e) {
  log('catch: ' + e.message);
  window.location.href = targetUrl;
}
</script>
</body></html>`);
          return;
        }

        res.writeHead(302, { Location: targetUrl });
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
        sendJson(res, 400, { ok: false, error: "未找到推送目标用户，请检查 WX_WORK_PUSH_DEPT_IDS" });
        return;
      }

      const taskId = await createPushTask(dailyDate, users);
      const result = await executePushTask(taskId);

      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (url.pathname === "/api/push/retry" && req.method === "POST") {
      const body = await readJsonBody(req);
      const taskId = Number(body?.taskId);
      if (!taskId) {
        sendJson(res, 400, { ok: false, error: "taskId required" });
        return;
      }
      const result = await retryFailedPushes(taskId);
      sendJson(res, 200, { ok: true, ...result });
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
