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
- **RSS pipeline**: `fetchWithTimeout` → regex-based XML parsing (`parseFeed`, `getBlocks`, `getTag`) → category/tag inference (`inferCategory`, `inferTags`) → heat scoring (`calculateHeat`) → upsert into `articles` table.
- **Firecrawl integration**: `fetchWithFirecrawl` calls the Firecrawl scrape API to fetch pages without RSS. Used for `type: "website"` sources. Returns a single article per page (title, summary, url).
- **DeepSeek integration**: `callDeepSeek` sends a structured prompt to the OpenAI-compatible chat completions endpoint. Falls back to `buildFallbackDailyMarkdown` if the API key is missing or the call fails.
- **API routes**: `/api/health`, `/api/news`, `/api/daily`, `/api/sources` (GET/POST), `/api/submissions` (GET), `/api/submissions/:id` (PUT), `/api/feedback` (POST). Query param `refresh=1` forces re-fetch or re-generation.
- **Source types**: `rss` (default), `twitter` (via Nitter), `html` (regex CSS selectors), `json` (dot-path), `website` (Firecrawl). Type is stored in `yimin_sources.type` column. Website sources are also read from DB in `refreshFeeds()`.
- **Static serving**: `serveStatic` resolves paths under the project root with directory traversal protection. Serves `index.html`, `styles.css`, `app.js`.

### Frontend (`app.js` + `index.html` + `styles.css`)

Single-page app with hash-based routing (`#home`, `#all`, `#daily`, `#radar`, `#sources`, `#review`, `#about`, `#changelog`, `#feedback`). Works both served from the Node server (live API data) and opened as `file://` (falls back to hardcoded demo data and localStorage drafts).

Key frontend patterns:
- `state` object holds all app state; `renderContent()` re-renders all views on any change
- `loadLiveNews()` and `loadDailyReport()` fetch from the API with graceful degradation
- Forms (source submission, feedback) POST to the API or fall back to localStorage

### Configuration

- `.env` — MySQL connection + DeepSeek API config + Firecrawl API config (loaded manually, no dotenv library)
- `data/sources.json` — RSS feed definitions with name, url, country, category, priority, type, fields (for html/json sources)

### Database schema

Auto-created tables: `sources` (with `type` column for source type), `articles`, `fetch_runs`, `daily_reports`, `source_submissions` (with `status` enum: pending/accepted/rejected), `feedback`. Database default: `yimin_ai_hot` (MySQL, utf8mb4).
