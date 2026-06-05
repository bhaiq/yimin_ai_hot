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

不建议直接打开 `index.html`，静态文件模式不会读写数据库，也不会展示演示数据。

## 当前包含

- 深色侧栏信息流界面
- 精选热点、全部动态、移民日报、政策雷达
- 市场素材：按“今日新增 / 延续关注 / 无新增项目 / 不建议重复发布”生成素材日报
- 分类筛选和关键词搜索
- 实时 RSS 抓取 API：`/api/news`
- 后台抓取队列：`/api/news?refresh=1` 会立即返回已有文章和 `fetchRun`，实际抓取按 `FEED_FETCH_CONCURRENCY` 限制并发，进度可查 `/api/fetch-runs/latest`
- 信源列表：`/api/sources`
- DeepSeek 生成并入库的日报：`/api/daily`
- 日报会记录引用明细，今日总结只使用近 7 天未出现过的当天新增事实
- 信源提报与反馈入库；静态打开时回退到本地草稿
- 网站源支持：通过 Firecrawl API 抓取无 RSS 的网页
- HTML 页面抓取：通过 Jina Reader API 提取网页内容
- 信源审核：管理员审核用户提报的信源，补充类型和国家后启用
- 用户登录：管理员账号登录，审核等敏感操作需认证
- 企业微信 SSO 访问登记：识别 `#daily?sso_auth_code=...`，解密登录人姓名并生成访问统计
- 日报链接点击统计：通过 `/d/:token` 打开的日报会记录首次点击人、时间和 IP，并在访问统计中展示

## 市场素材

`#market` 是给市场部使用的素材工作台。它复用当前新闻数据，不影响原有日报、雷达和全部动态。

- 今日新增素材：24 小时内首次出现，适合优先发布
- 延续关注素材：24-72 小时内仍有客户沟通价值
- 今日无新增项目：重点项目今天没有新事实，避免硬凑热点
- 不建议重复发布：过旧、已采用或市场分较低的素材
- 每条素材包含推荐标题、推荐渠道、推荐角度、客户影响、销售话术和风险提醒
- “有用 / 稍后看 / 已采用 / 没用”反馈写入 `yimin_market_feedback`
- 历史素材从 `yimin_market_reports` 等快照表读取；同一天重复生成会更新当天记录，不会新增多条

## 数据库

默认数据库名：`yimin_ai_hot`。

启动服务或访问接口时会自动创建这些表：

- `yimin_sources`：信源配置（含 `type` 列：rss/twitter/html/json/website）
- `yimin_articles`：抓取到的文章和热度标签
- `yimin_fetch_runs`：每次抓取记录
- `yimin_daily_reports`：DeepSeek 生成的日报
- `yimin_daily_report_items`：日报引用文章明细，用于近 7 天去重和旧信息降级
- `yimin_market_reports`：市场素材日报主表
- `yimin_market_materials`：市场素材明细快照
- `yimin_market_project_status`：重点项目当日更新状态
- `yimin_market_feedback`：市场部对素材的采用反馈
- `yimin_sso_login_logs`：企业微信 SSO 访问登记日志
- `yimin_source_submissions`：用户提报的信源（status: pending/accepted/rejected）
- `yimin_feedback`：前台反馈

## 数据来源

信源配置在 `data/sources.json`（文件型）和 `yimin_sources` 数据库表（在线管理），两者合并去重：

| 名称 | 国家 | 类型 | 说明 |
|---|---|---|---|
| USCIS 官方新闻 | 美国 | rss | 美国移民局官方 RSS |
| EB5 Investors Magazine | 美国 | rss | EB-5 行业媒体 |
| IIUSA 行业协会 | 美国 | rss | EB-5 行业协会 |
| Canada IRCC News | 加拿大 | rss | 加拿大移民局 |
| UK Visas and Immigration | 英国 | rss | 英国签证移民局 |
| USCIS Twitter | 美国 | twitter | Twitter 官方账号 |
| Canada Border Services Agency | 加拿大 | website | Firecrawl 抓取 |
| Visa Bulletin API | 美国 | json | 签证排期数据接口 |
| 用户提报信源 | — | html/website | 数据库管理，Jina Reader / Firecrawl 抓取 |

## 后续接入建议

- ~~给后台增加信源审核开关，把 `source_submissions` 里的有效源转为启用源~~（已完成）
- 将政策雷达从静态规则升级为基于文章主题和 AI 分类的数据库视图
- 增加定时任务，按小时执行 `/api/news?refresh=1` 启动后台抓取；每天 7 点执行 `/api/daily?refresh=1` 生成过去 24 小时早报。若需要自然日完整日报，可调用 `/api/daily?refresh=1&window=calendar&date=YYYY-MM-DD`
- 为 Jina Reader 配置代理支持，解决服务器网络环境连通性
