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
- **RSS pipeline**: `fetchWithTimeout` → regex-based XML parsing (`parseFeed`, `getBlocks`, `getTag`) → category/tag inference (`inferCategory`, `inferTags`) → heat scoring (`calculateHeat`) → upsert into `articles` table. `/api/news?refresh=1` starts a background fetch run by default, returns existing articles immediately, and limits source concurrency via `FEED_FETCH_CONCURRENCY` (default 12). Use `/api/news?refresh=1&sync=1` only when a caller intentionally wants to block until all sources finish.
- **Firecrawl integration**: `fetchWithFirecrawl` calls the Firecrawl scrape API to fetch pages without RSS. Used for `type: "website"` sources. Returns a single article per page (title, summary, url).
- **Jina Reader integration**: `fetchWithJina` calls `https://r.jina.ai/<url>` to extract page content as markdown. Used for `type: "html"` sources. Returns parsed articles via `parseJinaMarkdown`. **Requires proxy (127.0.0.1:7890)** — the server environment cannot reach `r.jina.ai` directly.
- **DeepSeek integration**: `callDeepSeek` sends a structured prompt to the OpenAI-compatible chat completions endpoint. Falls back to `buildFallbackDailyMarkdown` if the API key is missing or the call fails.
- **Daily report generation**: `/api/daily` reads candidate articles from `yimin_articles` by an explicit time window, not by a fixed “latest N” slice. Without a `date` query it defaults to `last24h` for the 7am morning report; with `date=YYYY-MM-DD` it defaults to the calendar-day window. Use `window=calendar` or `window=last24h` to override. Generated reports persist `window_start_at`, `window_end_at`, and `window_mode`.
- **Market素材生成**: `buildMarketReport` 按规则评分分类（新鲜度、权威度、商业匹配度），按新鲜度分组（今日新增/延续关注/无新增/不建议发布），包含推荐标题、渠道、话术。存入 `yimin_market_reports` + `yimin_market_materials`。反馈写入 `yimin_market_feedback`。年龄计算用 `publishedAt`（优先）或 `fetchedAt`（首次入库时间，upsert 不重置）。
- **Auth**: Cookie-based session login (`/api/login`, `/api/logout`, `/api/me`). Credentials from `.env` (`AUTH_USER`/`AUTH_PASS`).
- **API routes**: `/api/health`, `/api/news`, `/api/fetch-runs/latest`, `/api/daily`, `/api/daily/history`, `/api/market` (GET), `/api/market/history`, `/api/market/feedback` (POST), `/api/sources` (GET/POST), `/api/submissions` (GET), `/api/submissions/:id` (PUT), `/api/feedback` (POST), `/api/login` (POST), `/api/logout` (POST), `/api/me` (GET). Query param `refresh=1` forces re-fetch or re-generation; for `/api/news`, refresh is async unless `sync=1` is also provided.
- **Source types**: `rss` (default), `twitter` (via Nitter), `html` (Jina Reader API), `json` (dot-path), `website` (Firecrawl). Type is stored in `yimin_sources.type` column. Both `website` and `html` sources are read from DB in `refreshFeeds()` via `WHERE type IN ('website', 'html') AND enabled = 1`.
- **Static serving**: `serveStatic` resolves paths under the project root with directory traversal protection. Serves `index.html`, `styles.css`, `app.js`.

### Frontend (`app.js` + `index.html` + `styles.css`)

Single-page app with hash-based routing (`#home`, `#all`, `#daily`, `#market`, `#radar`, `#login`, `#sources`, `#review`, `#about`, `#changelog`, `#feedback`). Works both served from the Node server (live API data) and opened as `file://` (falls back to hardcoded demo data and localStorage drafts).

Key frontend patterns:
- `state` object holds all app state; `renderContent()` re-renders all views on any change
- `loadLiveNews()` and `loadDailyReport()` fetch from the API with graceful degradation
- Forms (source submission, feedback) POST to the API or fall back to localStorage

### Configuration

- `.env` — MySQL connection + DeepSeek API config + Firecrawl API config + auth credentials (loaded manually, no dotenv library)
- `data/sources.json` — RSS feed definitions with name, url, country, category, priority, type, fields (for html/json sources)

### Database schema

Auto-created tables: `yimin_sources` (with `type` column for source type), `yimin_articles`, `yimin_fetch_runs`, `yimin_daily_reports`, `yimin_daily_report_items` (article dedup across 7 days), `yimin_source_submissions` (with `status` enum: pending/accepted/rejected), `yimin_feedback`, `yimin_market_reports`, `yimin_market_materials`, `yimin_market_project_status`, `yimin_market_feedback`. Database default: `yimin_ai_hot` (MySQL, utf8mb4).
