# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

移民热点 (Immigration Hot) — a Chinese-language immigration news aggregation dashboard. It fetches RSS feeds from immigration authorities and industry sources, stores articles in MySQL, generates daily AI reports via DeepSeek, and serves a single-page dark-themed dashboard.

## Commands

```bash
npm run dev        # Start the server (reads .env, connects MySQL, port 4173)
npm run start      # Alias for dev
npm run check      # Syntax-check app.js and server.mjs with node --check
```

There is no build step, bundler, test framework, or linter. The project runs raw Node.js ESM.

## Architecture

**No framework, no dependencies.** Everything is vanilla Node.js (ESM) with zero npm packages beyond Node built-ins.

### Server (`server.mjs`)

Single-file HTTP server handling both API and static files:

- **Database layer**: Spawns `mysql` CLI via `child_process.spawn` for all SQL. No ORM, no driver. SQL helpers: `sqlString`, `sqlNumber`, `sqlDate`, `sqlIdentifier`. Tables auto-created on first request via `initDb()`. Note: `mysqlJson()` requires SQL queries to return JSON natively (via `JSON_ARRAYAGG`/`JSON_OBJECT`), not raw column output.
- **Text sanitization**: `sanitizeTextArtifacts()` strips Unicode replacement characters (�) and common mojibake patterns. Applied in `cleanText`, `truncate`, all daily report pipeline functions, and `callDeepSeek` output.
- **RSS pipeline**: `fetchWithTimeout` → regex-based XML parsing (`parseFeed`, `getBlocks`, `getTag`) → category/tag inference (`inferCategory`, `inferTags`) → heat scoring (`calculateHeat`) → upsert into `articles` table. `/api/news?refresh=1` starts a background fetch run by default, returns existing articles immediately, and limits source concurrency via `FEED_FETCH_CONCURRENCY` (default 12). Use `/api/news?refresh=1&sync=1` only when a caller intentionally wants to block until all sources finish.
- **Firecrawl integration**: `fetchWithFirecrawl` calls the Firecrawl scrape API to fetch pages without RSS. Used for `type: "website"` sources. Returns a single article per page (title, summary, url).
- **Jina Reader integration**: `fetchWithJina` calls `https://r.jina.ai/<url>` to extract page content as markdown. Used for `type: "html"` sources. Returns parsed articles via `parseJinaMarkdown`. **Requires proxy (127.0.0.1:7890)** — the server environment cannot reach `r.jina.ai` directly.
- **DeepSeek integration**: `callDeepSeek` sends prompts to the OpenAI-compatible chat completions endpoint. Daily article analysis runs in configurable batches and is cached by article content hash. A failed analysis batch falls back to deterministic rules; final report generation falls back to `buildFallbackDailyMarkdown`.
- **Daily report generation**: `/api/daily` reads all candidate articles from `yimin_articles` in database pages, with no global candidate cap. Without a `date` query it defaults to `last24h`; with `date=YYYY-MM-DD` it defaults to the calendar day. New or changed articles are analyzed in batches into `yimin_article_daily_analysis`, relevant articles are grouped into `yimin_daily_report_events`, and the final model reads event-level material instead of every raw article. Oversized event material is recursively reduced in batches. All candidates, including low-relevance articles, are stored in `yimin_daily_report_items` and exposed through the paginated `/api/daily/items` appendix.
- **Market素材生成**: `buildMarketReport` 按规则评分分类（新鲜度、权威度、商业匹配度），按新鲜度分组（今日新增/延续关注/无新增/不建议发布），包含推荐标题、渠道、话术。存入 `yimin_market_reports` + `yimin_market_materials`。反馈写入 `yimin_market_feedback`。年龄计算用 `publishedAt`（优先）或 `fetchedAt`（首次入库时间，upsert 不重置）。
- **Auth**: Cookie-based session login (`/api/login`, `/api/logout`, `/api/me`). Credentials from `.env` (`AUTH_USER`/`AUTH_PASS`).
- **API routes**: `/api/health`, `/api/news`, `/api/fetch-runs/latest`, `/api/daily`, `/api/daily/department`, `/api/daily/departments/generate` (POST batch generation, no app-level auth), `/api/daily/personal`, `/api/daily/items`, `/api/daily/history`, `/api/subscriptions/me` (GET/PUT, signed SSO identity), `/api/subscriptions/departments` (GET/PUT, admin auth), `/api/source-distribution` (GET admin auth), `/api/source-distribution/:id` (PUT admin auth), `/api/wx/sync-contacts` (POST, no app-level auth), `/api/market` (GET), `/api/market/history`, `/api/market/feedback` (POST), `/api/sources` (GET/POST), `/api/submissions` (GET), `/api/submissions/:id` (PUT), `/api/feedback` (GET auth, POST public), `/api/feedback/:id` (PUT auth), `/api/login` (POST), `/api/logout` (POST), `/api/me` (GET), `/api/sso/me` (GET), `/api/sso/visit` (POST), `/api/sso/stats` (GET, auth), `/api/push/tasks` (GET), `/api/push/tasks/:id` (GET), `/api/push/daily` (POST), `/api/push/retry` (POST). Query param `refresh=1` forces re-fetch or re-generation; for `/api/news`, refresh is async unless `sync=1` is also provided.
- **Source types**: `rss` (default), `twitter` (via Nitter), `html` (Jina Reader API), `json` (dot-path), `website` (Firecrawl). Type is stored in `yimin_sources.type` column. Both `website` and `html` sources are read from DB in `refreshFeeds()` via `WHERE type IN ('website', 'html') AND enabled = 1`.
- **Static serving**: `serveStatic` resolves paths under the project root with directory traversal protection. Serves `index.html`, `styles.css`, `app.js`.
- **WeChat Work push**: `POST /api/push/daily` creates a push task and runs it asynchronously (`startPushTaskInBackground`), returning 202 immediately. It fetches only the current push targets and does not synchronize or write contact records. It generates a unique token per user and sends textcard messages with `/d/:token` links. `POST /api/push/retry` re-queues failed sends. Visit tracking records first-click timestamp and IP in `yimin_push_logs`, increments `yimin_push_tasks.visited_count`, and is shown in the admin `#sso-stats` access stats page. `GET /d/:token` records the click, attempts WeChat Work JS-SDK `openDefaultBrowser`, and falls back to `/#daily`. Optional SDK diagnostics can be enabled with `WX_WORK_OPEN_DEBUG=1`; when enabled the transition page prints debug lines and writes `yimin_push_open_events`. Access token cached in `yimin_wx_token_cache`. Config: `WX_WORK_CORP_ID`, `WX_WORK_AGENT_ID`, `WX_WORK_SECRET`, `WX_WORK_PUSH_DEPT_IDS`, `WX_WORK_PUSH_TAG_IDS`, `WX_WORK_PUSH_EXCLUDE_DEPT_URL`, `PUBLIC_BASE_URL`.
- **WeChat Work SSO logging**: Frontend reads encrypted `sso_auth_code` (user name) and optional `sso_user_id` (WeChat Work UserID/pinyin name) from the hash query, posts both to `/api/sso/visit`, then removes both params from the URL. Backend decrypts AES-256-CBC with `SSO_SECRET_KEY` (default `GlobeVisa_SSO_2026_SecretKey!@#`) and fixed IV seed `SSO_IV_SEED` (default `globevisa_sso_iv`), then writes `yimin_sso_login_logs`. `/d/:token` daily links also persist the push log's `userid`. Identity cookies are HttpOnly and protected by an HMAC signature; `/api/sso/me` only returns a verified identity. Admin-only `#sso-stats` shows totals, trends, user ranking, UserID, and recent visits.
- **Source distribution scope**: `yimin_sources.enabled` controls fetching, while `public_daily_enabled` controls public-daily eligibility. Public daily candidates require both flags. Admins manage the scope through `/api/source-distribution`; moving a source between public and department-only invalidates the current Shanghai-date public and department report caches. Department-only sources remain fetchable and available to subscribed departments.
- **Personalized daily supplements**: `#subscriptions` lets an identified WeChat Work user select public enabled `yimin_sources`. Department defaults live in `yimin_department_source_subscriptions`; personal `subscribed`/`muted` rows in `yimin_user_source_subscriptions` are merged over those defaults. Department-only sources are visible only when inherited from a direct department and cannot be added as personal overrides. `/api/daily/personal` filters existing public report items by the effective source set and removes URLs already cited in public report Markdown. It does not call DeepSeek. Push text uses the same effective subscription calculation.
- **WeChat Work contact sync**: `POST /api/wx/sync-contacts` has no application-level authentication. It independently calls `department/list`, then `user/simplelist` with `fetch_child=0` for each department in batches of 5. It upserts `yimin_wx_departments` and `yimin_wx_users.departments_json`, returning department/user/membership counts.
- **Department subscriptions**: Admin-only `#department-subscriptions` configures department defaults from the independently synchronized department and user records.
- **Department daily focus**: `/api/daily/department` uses only department IDs directly stored in the identified user's `departments_json`; it does not traverse `parent_id`. `POST /api/daily/departments/generate` pre-generates all real departments with configured default sources at concurrency 2 after the public report exists; it returns 409 when the public report is missing and 207 for partial failures. Each direct department reads recent articles directly from its default subscribed sources, including department-only sources, and reuses the article-level daily analysis cache. Results are cached in `yimin_department_daily_reports` by date/department and regenerated when the source configuration or article/public-report input hash changes. Empty inputs skip department-level DeepSeek; generation failures save a rule-based fallback.
- **Local SSO test identity**: `LOCAL_TEST_SSO_ENABLED=1`, `LOCAL_TEST_SSO_USER_ID`, and `LOCAL_TEST_SSO_USER_NAME` provide a development fallback only when `NODE_ENV !== production` and both the request host and remote address are loopback. `LOCAL_TEST_SSO_DEPARTMENT_NAME` resolves one real synchronized direct department by exact, prefix, then partial name match; optional comma-separated `LOCAL_TEST_SSO_DEPARTMENT_IDS` is the fallback. A valid signed SSO cookie always takes precedence. Never enable this in production.

### Frontend (`app.js` + `index.html` + `styles.css`)

Single-page app with hash-based routing (`#home`, `#all`, `#daily`, `#subscriptions`, `#market`, `#radar`, `#feedback`, `#login`, `#sources`, `#review`, `#sso-stats`, `#department-subscriptions`, `#feedback-review`, `#about`, `#changelog`). Works both served from the Node server (live API data) and opened as `file://` (renders empty state — no demo data is loaded; only form drafts like source submissions and feedback fall back to localStorage).

Key frontend patterns:
- `state` object holds all app state; `renderContent()` re-renders all views on any change
- `loadLiveNews()` and `loadDailyReport()` fetch from the API with graceful degradation
- Forms (source submission, feedback) POST to the API or fall back to localStorage

### Configuration

- `.env` — MySQL connection + DeepSeek API config + Firecrawl API config + WeChat Work push config + auth credentials (loaded manually, no dotenv library)
- `data/sources.json` — RSS feed definitions with name, url, country, category, priority, type, fields (for html/json sources)

### Database schema

Auto-created tables: `yimin_sources`, `yimin_articles`, `yimin_fetch_runs`, `yimin_daily_reports`, `yimin_daily_report_items`, `yimin_article_daily_analysis`, `yimin_daily_report_events`, `yimin_department_daily_reports`, `yimin_source_submissions`, `yimin_feedback`, `yimin_market_reports`, `yimin_market_materials`, `yimin_market_project_status`, `yimin_market_feedback`, `yimin_push_tasks`, `yimin_push_logs`, `yimin_push_open_events`, `yimin_wx_token_cache`, `yimin_sso_login_logs`, `yimin_wx_users`, `yimin_wx_departments`, `yimin_user_source_subscriptions`, `yimin_department_source_subscriptions`. Database default: `yimin_ai_hot` (MySQL, utf8mb4).
