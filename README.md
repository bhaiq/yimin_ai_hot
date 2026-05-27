# 移民热点 V2

这是第二版静态原型，放在 `/Users/www/yimin_ai_hot`，没有修改第一版 `/Users/www/immigration-digest`。

## 运行方式

项目会读取本地 `.env`，连接 MySQL 并调用 DeepSeek。启动服务：

```bash
npm run dev
```

然后打开：

```text
http://127.0.0.1:4173
```

也可以直接在浏览器打开 `index.html`，但这种方式只会使用内置演示数据，不会读写数据库。

## 当前包含

- 深色侧栏信息流界面
- 精选热点、全部动态、移民日报、政策雷达
- 分类筛选和关键词搜索
- 实时 RSS 抓取 API：`/api/news`
- 信源列表：`/api/sources`
- DeepSeek 生成并入库的日报：`/api/daily`
- 信源提报与反馈入库；静态打开时回退到本地草稿
- 网站源支持：通过 Firecrawl API 抓取无 RSS 的网页
- 信源审核：管理员审核用户提报的信源，补充类型和国家后启用

## 数据库

默认数据库名：`yimin_ai_hot`。

启动服务或访问接口时会自动创建这些表：

- `sources`：信源配置（含 `type` 列：rss/twitter/html/json/website）
- `articles`：抓取到的文章和热度标签
- `fetch_runs`：每次抓取记录
- `daily_reports`：DeepSeek 生成的日报
- `source_submissions`：用户提报的信源（status: pending/accepted/rejected）
- `feedback`：前台反馈

## 当前实时信源

信源配置在 `data/sources.json`，当前包含：

- USCIS 官方新闻
- EB5 Investors Magazine
- IIUSA 行业协会
- Canada IRCC News
- UK Visas and Immigration

## 后续接入建议

- ~~给后台增加信源审核开关，把 `source_submissions` 里的有效源转为启用源~~（已完成）
- 将政策雷达从静态规则升级为基于文章主题和 AI 分类的数据库视图
- 增加定时任务，按小时执行 `/api/news?refresh=1`，每天生成一次 `/api/daily?refresh=1`
