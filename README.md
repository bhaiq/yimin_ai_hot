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
- DeepSeek 分批分析、事件聚合后生成并入库的日报：`/api/daily`
- 日报完整资讯附录：`/api/daily/items`，分页追溯全部候选文章
- 日报会记录引用明细，今日总结只使用近 7 天未出现过的当天新增事实
- 信源提报与公开反馈入库；静态打开时回退到本地草稿
- 网站源支持：通过 Firecrawl API 抓取无 RSS 的网页
- HTML 页面抓取：通过 Jina Reader API 提取网页内容
- 信源审核：管理员审核用户提报的信源，补充类型和国家后启用
- 用户登录：管理员账号登录，审核等敏感操作需认证
- 企业微信 SSO 访问登记：识别 `#daily?sso_auth_code=...&sso_user_id=...`，解密登录人姓名和 UserID（拼音名）并生成访问统计
- 日报链接点击统计：通过 `/d/:token` 打开的日报会记录首次点击人、时间和 IP，并在访问统计中展示
- 企业微信日报推送：后台异步发送 textcard 消息，支持重试失败推送，推送状态和错误信息在管理后台可查看
- 个性化信源关注：企业微信用户可在“我的关注”中搜索、筛选和多选已启用信源
- 专属日报补充：公共日报统一生成一次，再按用户关注信源整理当日动态；已在公共日报明确引用的文章不重复展示
- 个性化推送提示：有订阅时提示关注信源及当日动态数量，无订阅时发送公共日报提示，不为每个人重复调用 AI
- 日报候选过滤：无发布日期的首次抓取文章标记为 `daily_excluded`，不进入日报候选；回看时间窗口可配置
- 日报完整分类：主题去重后不再按 12/8/8/8 条截断，全部候选都会进入日报分析与明细
- 日报长期流水线：候选分页全量读取，新增文章分批分析，按事件聚合后生成正文；低相关和重复文章仍保留在完整资讯附录

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
- `yimin_article_daily_analysis`：文章级日报分析缓存，内容未变化时不重复调用 AI
- `yimin_daily_report_events`：日报事件聚合结果，一项事件可关联多篇来源文章
- `yimin_market_reports`：市场素材日报主表
- `yimin_market_materials`：市场素材明细快照
- `yimin_market_project_status`：重点项目当日更新状态
- `yimin_market_feedback`：市场部对素材的采用反馈
- `yimin_sso_login_logs`：企业微信 SSO 访问登记日志
- `yimin_wx_users`：稳定的企业微信 UserID 身份记录，预留部门同步字段
- `yimin_user_source_subscriptions`：用户个人信源关注配置
- `yimin_source_submissions`：用户提报的信源（status: pending/accepted/rejected）
- `yimin_feedback`：前台公开反馈，记录反馈类型、页面、优先级、联系方式、反馈人和处理状态
- `yimin_push_tasks`：企业微信日报推送任务
- `yimin_push_logs`：推送发送记录（含用户、token、发送状态）
- `yimin_push_open_events`：推送中转页 SDK 调试事件（需 `WX_WORK_OPEN_DEBUG=1`）
- `yimin_wx_token_cache`：企业微信 access_token 缓存

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
- ~~同步企业微信部门，增加部门默认订阅与个人覆盖规则~~（已完成）
- ~~按直属部门生成 AI 部门重点，并按部门、日期、信源配置和文章集合缓存~~（已完成）
- 个性化日报下一阶段：根据使用反馈完善部门提示词、负责人确认和重新生成管理能力
- ~~为 Jina Reader 配置代理支持，解决服务器网络环境连通性~~（待配置 `HTTPS_PROXY` 环境变量）

## 本地测试企业微信身份

本地无法经过企业微信推送链接时，可以在 `.env` 配置测试身份：

```env
LOCAL_TEST_SSO_ENABLED=1
LOCAL_TEST_SSO_USER_ID=niujinlong
LOCAL_TEST_SSO_USER_NAME=牛金龙
LOCAL_TEST_SSO_DEPARTMENT_NAME=IOD
LOCAL_TEST_SSO_DEPARTMENT_IDS=
```

该身份只在非生产环境，并且请求来自 `localhost`、`127.0.0.1` 或 `::1` 时生效。真实签名 SSO 身份优先于本地测试身份。线上必须保持 `LOCAL_TEST_SSO_ENABLED=0`。

`LOCAL_TEST_SSO_DEPARTMENT_NAME` 会从已同步的企业微信部门中匹配一个真实直属部门，依次尝试完整名称、名称前缀和名称包含。未配置名称时，也可以用逗号分隔的 `LOCAL_TEST_SSO_DEPARTMENT_IDS` 直接指定部门 ID。管理员登录后进入“部门关注”，为测试部门配置默认信源；个人取消部门默认或增加其他信源时，系统只保存差异项。

## 企业微信通讯录同步

通讯录同步已与日报推送解耦。定时任务直接调用：

```bash
curl -X POST https://你的域名/api/wx/sync-contacts
```

接口不需要 Token 或登录态。它会获取企业微信 `department/list`，再按部门调用 `user/simplelist?fetch_child=0`，更新 `yimin_wx_departments` 和 `yimin_wx_users.departments_json`，并返回部门数、用户数和部门成员关系数。

`POST /api/push/daily` 不再执行或写入通讯录同步，只负责获取本次推送目标并发送日报。建议每天在日报生成和推送前独立执行一次通讯录同步。

## 直属部门重点

日报页按照当前用户 `yimin_wx_users.departments_json` 中的直属部门，展示公共日报之后、个人关注之前的部门重点：

- 部门 ID 和名称只读取企业微信同步后的 `yimin_wx_departments`，不根据信源推断部门
- 第一版不继承父部门关注，也不合并不同部门
- 使用 `yimin_department_source_subscriptions` 中的部门默认信源筛选当日文章
- 有匹配文章时调用 AI 生成“今日重点、业务影响、建议动作、参考原文”
- 没有关注信源或当日无匹配文章时不调用 AI
- 结果保存到 `yimin_department_daily_reports`；部门关注配置或输入文章未变化时不重复生成
- AI 失败时降级为规则整理，不影响公共日报和个人关注

部门日报提供独立批量生成接口，不需要用户身份或登录 Token：

```bash
curl -X POST https://你的域名/api/daily/departments/generate
```

接口只处理已经配置默认关注信源的真实部门，并发生成数量为 2。公共日报尚未生成时返回 `409`；部分部门失败时返回 `207` 和逐部门结果，其他部门仍会继续生成。需要强制重新生成时可请求 `?refresh=1`。

建议每日定时任务顺序：

1. `7:00` 请求 `/api/wx/sync-contacts`
2. `8:00` 请求 `/api/daily?refresh=1` 生成公共日报
3. 公共日报成功后请求 `/api/daily/departments/generate`
4. `8:50` 请求 `/api/push/daily`
