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
- H 专栏：从公共日报生成 0—3 个 Henry 候选，并可由无鉴权定时接口提前生成可编辑文章；事实包、版本和四层审校继续保留
- 市场素材：按“今日新增 / 延续关注 / 无新增项目 / 不建议重复发布”生成素材日报
- 分类筛选和关键词搜索
- 实时 RSS 抓取 API：`/api/news`
- 后台抓取队列：`/api/news?refresh=1` 会立即返回已有文章和 `fetchRun`，实际抓取按 `FEED_FETCH_CONCURRENCY` 限制并发，进度可查 `/api/fetch-runs/latest`
- 信源列表：`/api/sources`
- DeepSeek 分批分析、事件聚合后生成并入库的日报：`/api/daily`；`refresh=1` 或无缓存时默认异步后台生成，`sync=1` 才同步等待；英文版通过 `/api/daily?lang=en` 读取，复用同一天事件素材生成并缓存，不新增主日报记录
- 日报完整资讯附录：`/api/daily/items`，分页追溯全部候选文章
- 日报会记录引用明细，今日总结只使用近 7 天未出现过的当天新增事实
- 信源提报与公开反馈入库；静态打开时回退到本地草稿
- 网站源支持：通过 Firecrawl API 抓取无 RSS 的网页；额度不足时自动轮换备用 key 并重试
- Firecrawl 独立队列：`website` 信源不占用 RSS/JSON 抓取并发，默认每分钟最多启动 8 个请求；遇到 HTTP 429 时优先按 `Retry-After` 或错误中的重置时间等待，加入随机退避后自动重试
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
- 信源发布范围：抓取启用与公共日报分发分离；信源可设为“仅订阅部门”，继续抓取但不进入公共日报和公共明细
- 部门专属信源：部门重点直接读取本部门订阅信源的当日文章，不依赖公共日报明细；个人关注不能越权订阅其他部门的专属信源
- 日报完整分类：主题去重后不再按 12/8/8/8 条截断，全部候选都会进入日报分析与明细
- 日报长期流水线：候选分页全量读取，新增文章分批分析，按事件聚合后生成正文；低相关和重复文章仍保留在完整资讯附录
- 同行监控：按同行A–同行I匿名展示 420 个官网项目，并抓取已配置同行的公众号 RSS；仅 IOD、MD 与指定负责人可访问

## 同行监控

`#peer-monitor` 是内部同行情报页面，与公共新闻、移民日报和市场素材的数据表完全隔离。

- 当前监控同行A–同行I，共 9 家、420 个官网项目；官网数据只从 `data/peer-monitor-projects.json` 导入，不会自动重新抓取网站
- 页面和数据接口只返回匿名代号、项目结构化信息和经过清洗的公众号内容；公众号卡片可在站内打开匿名化全文，但不返回真实同行名称、域名、公众号名称、原文链接或图片
- 当前同行B、C、F、G、H、I已配置公众号 RSS；“刷新并补抓”只对已登录管理员显示，刷新在后台执行并可查询进度
- RSS 暂未提供正文时，页面明确标记“等待自动补全文”并只展示摘要；后续刷新会重新检查并补入新出现的正文，已入库的正文不会被空内容覆盖
- 每次刷新只写入新文章；同时按 URL、RSS 外部 ID、标题与发布时间识别同一篇文章，已有完整文章直接跳过，仅对历史缺失正文且 RSS 新提供正文的记录执行补写
- 公众号列表在服务端与前端双重去重，避免 RSS 标识变化、旧缓存或重复响应把同一篇文章显示多次
- 公众号文章按发布时间倒序分页，每次展示 20 条，可点击“加载更多”继续读取历史文章
- 同行 RSS 默认允许最大 32 MiB、抓取超时 60 秒，可通过 `PEER_MONITOR_RSS_MAX_BYTES` 和 `PEER_MONITOR_RSS_TIMEOUT_MS` 调整
- 页面访问仅允许企业微信直属部门为 IOD 或 MD 的用户，以及指定 UserID `fanrui`
- 可通过 `PEER_MONITOR_USER_IDS` 和 `PEER_MONITOR_DEPARTMENT_NAMES` 追加逗号分隔的允许名单

服务器本地或外部定时任务都可以直接请求刷新接口，无需 Token 或登录态：

```bash
curl -X POST http://127.0.0.1:4173/api/peer-monitor/refresh
# 或通过公网域名
curl -X POST https://your-domain.example/api/peer-monitor/refresh
```

该定时请求同时负责公众号新文章刷新和旧文章正文补抓，建议按小时执行。

只刷新某个同行也可以显式指定，例如：

```bash
curl -X POST 'http://127.0.0.1:4173/api/peer-monitor/refresh?competitor=peer-h'
```

刷新接口允许公网匿名调用，但同一服务进程同时只运行一个刷新任务；已有任务运行时会直接返回当前任务。建议在反向代理层配置合理的请求频率限制，避免接口被反复触发。

后续替换或补充官网项目数据时，先生成匿名种子文件：

```bash
npm run peer:seed -- /path/to/all_companies_projects.json data/peer-monitor-projects.json
```

服务启动时会按文件内容哈希幂等导入；同一份数据不会重复新增项目。

## 市场素材

`#market` 是给市场部使用的素材工作台。它复用当前新闻数据，不影响原有日报、雷达和全部动态。

- 今日新增素材：24 小时内首次出现，适合优先发布
- 延续关注素材：24-72 小时内仍有客户沟通价值
- 今日无新增项目：重点项目今天没有新事实，避免硬凑热点
- 不建议重复发布：过旧、已采用或市场分较低的素材
- 每条素材包含推荐标题、推荐渠道、推荐角度、客户影响、销售话术和风险提醒
- “有用 / 稍后看 / 已采用 / 没用”反馈写入 `yimin_market_feedback`
- 历史素材从 `yimin_market_reports` 等快照表读取；同一天重复生成会更新当天记录，不会新增多条

## H 专栏

`#h-column` 是 Henry 的文章与视频内容工作台，使用「Henry 文章与视频写作」Skill。公共日报完成后，定时任务可以提前为默认候选生成可编辑文章；事实不足、观点待确认和发布前审校不会因自动生成而被跳过。

核心流程：

1. 公共日报生成后，系统自动筛出 0—3 个 H 候选；
2. 定时任务调用公开预生成接口后，系统自动选择合适的默认候选、复用日报来源并补全文；
3. 系统先生成内容大纲，再为每个默认候选生成公众号文章；已有文章默认复用，`refresh=1` 才创建新版本；
4. H 四问、事实与观点状态用于提示缺口，不阻断按大纲生成渠道稿；未满足项会在四层审校中阻断最终采用；
5. 生成并选择一个内容大纲后，即可一键并行生成公众号文章、H快评、H边跑边聊和 H深聊；
6. 四个渠道从所选大纲、当前事实包和已确认观点独立组织，不把文章机械缩写成视频稿；
7. 每次生成或编辑都会保留新版本、父版本、输入快照、Skill/人物档案版本和真实操作者；
8. 四渠道生成支持 0/4—4/4 实时进度、部分成功和失败渠道单独重试；
9. 四个渠道稿生成后分别审校；审校后事实包或观点发生变化时，旧审校自动失效；
10. 每个渠道稿与四层审校是独立步骤，审校失败或不可用时默认阻断最终采用；
11. 渠道稿有必改项时，可人工修改，也可按最新审校意见重新生成；旧稿始终保留；
12. 候选刷新、生成与审校等长操作会显示加载状态并阻止重复点击；
13. 内容包可以导出给 Claude、Gemini 等外部模型继续编辑，系统仍保存唯一事实包和最终采用版本；
14. 草稿支持 Markdown、纯文本复制，并可由任一 H 专栏成员确认、退回或最终采用。

默认权限已经收紧到企业微信 `fanrui / Henry范睿`、`liangshuang / Celine梁爽`、IOD 部门成员和系统管理员。生产环境建议显式配置：

```env
H_COLUMN_ENABLED=1
H_COLUMN_AUTO_GENERATE=1
H_COLUMN_DAILY_MAX_TOPICS=3
H_COLUMN_MODEL=deepseek-v4-pro
H_COLUMN_REVIEW_MODEL=deepseek-v4-pro
H_COLUMN_PREGENERATE_MODES=wechat_article,short_video,run_and_talk_video,deep_video
H_COLUMN_PREGENERATE_CONCURRENCY=2
H_COLUMN_PREGENERATE_MAX_ATTEMPTS=3
H_COLUMN_PREGENERATE_RETRY_DELAY_MS=2000
H_COLUMN_USER_IDS=fanrui
H_COLUMN_EDITOR_USER_IDS=liangshuang
H_COLUMN_DEPARTMENT_NAMES=IOD
```

H 专栏采用单一权限模型：Henry、Celine、直属部门名称匹配 `H_COLUMN_DEPARTMENT_NAMES` 的成员（默认 IOD 部门）和系统管理员权限完全相同。能看到菜单就能使用全部 H 专栏功能；其他人看不到菜单，且普通 `/api/h/*` 返回 `403`。定时任务专用的 `/api/h/automation/pre-generate` 与状态接口按部署要求明确不做身份校验。

定时预生成默认异步返回 `202`，适合由 cron 或其他调度器直接请求：

```bash
curl -X POST "http://127.0.0.1:4173/api/h/automation/pre-generate"
curl "http://127.0.0.1:4173/api/h/automation/pre-generate/status?date=2026-07-30"
```

需要同步等待结果时使用 `sync=1`；需要重新生成候选、大纲和文章的新版本时使用 `refresh=1`：

```bash
curl -X POST "http://127.0.0.1:4173/api/h/automation/pre-generate?sync=1"
curl -X POST "http://127.0.0.1:4173/api/h/automation/pre-generate?sync=1&refresh=1"
```

接口默认同时生成公众号文章、H快评、H边跑边聊和 H深聊，也支持通过 `modes` 只跑指定渠道。每个大纲和渠道最多自动尝试 `H_COLUMN_PREGENERATE_MAX_ATTEMPTS` 次，已成功渠道会保留，失败渠道不会影响其他结果。接口还支持 `date=YYYY-MM-DD`、`topicIds=12,13` 和 `limit=3`。重复请求会按日期合并；不传 `refresh=1` 时复用已有可编辑稿件，只补缺失渠道。自动生成只产出待审草稿，不自动标记事实已核验、不自动通过四层审校，也不直接发布。

P0 只写系统日志，不发送企业微信通知，也不直接发布到公众号或视频号。详细产品约束见 `docs/henry-column-prd.md`，部署、验证和故障处理见 `docs/henry-column-operations.md`。

## 数据库

默认数据库名：`yimin_ai_hot`。

启动服务或访问接口时会自动创建这些表：

- `yimin_sources`：信源配置（含 `type` 和 `public_daily_enabled`，分别控制抓取类型与公共日报发布范围）
- `yimin_articles`：抓取到的文章和热度标签
- `yimin_fetch_runs`：每次抓取记录
- `yimin_daily_reports`：DeepSeek 生成的日报
- `yimin_daily_report_localizations`：日报英文等多语言本地化内容，按 `report_id + language` 缓存，不影响主日报统计
- `yimin_daily_report_items`：日报引用文章明细，用于近 7 天去重和旧信息降级
- `yimin_article_daily_analysis`：文章级日报分析缓存，内容未变化时不重复调用 AI
- `yimin_daily_report_events`：日报事件聚合结果，一项事件可关联多篇来源文章
- `yimin_market_reports`：市场素材日报主表
- `yimin_market_materials`：市场素材明细快照
- `yimin_market_project_status`：重点项目当日更新状态
- `yimin_market_feedback`：市场部对素材的采用反馈
- `yimin_h_topics`：H 每日候选、四问、准备度和选择状态
- `yimin_h_topic_sources`：事实包来源、完整度、证据等级、政策状态和核验日志
- `yimin_h_viewpoints`：Henry 观点、人物档案观点、编辑记录及真实确认人
- `yimin_h_drafts`：文章、口播和大纲的可追溯版本
- `yimin_h_reviews`：L1—L4 独立审校结果
- `yimin_h_feedback`：采用、暂缓、拒绝和修改日志
- `yimin_h_generation_runs`：草稿和审校运行记录
- `yimin_h_audit_logs`：H 专栏写操作的真实操作者与变更元数据
- `yimin_sso_login_logs`：企业微信 SSO 访问登记日志
- `yimin_wx_users`：稳定的企业微信 UserID 身份记录，预留部门同步字段
- `yimin_user_source_subscriptions`：用户个人信源关注配置
- `yimin_source_submissions`：用户提报的信源（status: pending/accepted/rejected）
- `yimin_feedback`：前台公开反馈，记录反馈类型、页面、优先级、联系方式、反馈人和处理状态
- `yimin_push_tasks`：企业微信日报推送任务
- `yimin_push_logs`：推送发送记录（含用户、token、发送状态）
- `yimin_push_open_events`：推送中转页 SDK 调试事件（需 `WX_WORK_OPEN_DEBUG=1`）
- `yimin_wx_token_cache`：企业微信 access_token 缓存
- `yimin_peer_competitors`：同行私有配置和匿名代号
- `yimin_peer_sources`：同行公众号 RSS 私有订阅配置
- `yimin_peer_projects`：匿名化后的官网项目
- `yimin_peer_articles`：同行公众号文章，与公共新闻文章隔离
- `yimin_peer_refresh_runs`：公众号刷新任务和进度
- `yimin_peer_imports`：官网项目种子文件导入记录

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

Firecrawl 支持保留原有的单 key 配置，并通过逗号分隔或编号变量增加备用 key：

```env
FIRECRAWL_API_KEY=fc-primary
FIRECRAWL_API_KEYS=fc-backup-1,fc-backup-2
# 也支持 FIRECRAWL_API_KEY_2=fc-backup-3
FIRECRAWL_REQUESTS_PER_MINUTE=8
FIRECRAWL_MAX_RATE_LIMIT_RETRIES=3
FIRECRAWL_RETRY_JITTER_MS=1500
```

当接口明确返回 `Insufficient credits` 或 `Unauthorized: Invalid token` 时，本次抓取会立即跳过当前 key，并切换到下一个 key 重试；其他类型错误不会触发 key 轮换。
HTTP 429 不切换 key，而是暂停整个 Firecrawl 队列，优先读取响应头 `Retry-After`，其次解析错误消息里的 `retry after ...s` 或 `resets at ...`；等待时会追加最多 `FIRECRAWL_RETRY_JITTER_MS` 的随机抖动，最多重试 `FIRECRAWL_MAX_RATE_LIMIT_RETRIES` 次。RSS、JSON、Twitter 和 Jina HTML 信源继续使用原 `FEED_FETCH_CONCURRENCY`，不会被 Firecrawl 等待队列占满。

## 后续接入建议

- ~~给后台增加信源审核开关，把 `source_submissions` 里的有效源转为启用源~~（已完成）
- 将政策雷达从静态规则升级为基于文章主题和 AI 分类的数据库视图
- 增加定时任务，按小时执行 `/api/news?refresh=1` 启动后台抓取；每天 7 点执行 `/api/daily?refresh=1` 后台生成过去 24 小时早报。若需要自然日完整日报，可调用 `/api/daily?refresh=1&window=calendar&date=YYYY-MM-DD`；人工调试需要等待完整结果时加 `sync=1`
- ~~同步企业微信部门，增加部门默认订阅与个人覆盖规则~~（已完成）
- ~~按直属部门生成 AI 部门重点，并按部门、日期、信源配置和文章集合缓存~~（已完成）
- 个性化日报下一阶段：根据使用反馈完善部门提示词、负责人确认和重新生成管理能力
- 为 Jina Reader 配置代理支持，解决服务器网络环境连通性（未完成：`fetchWithJina` 目前是裸 `fetch`，服务器无法直连 `r.jina.ai`，需在代码中实现 `HTTPS_PROXY`）

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
- “仅订阅部门”信源与公共信源使用同一套文章分析缓存，但只会进入已订阅部门的部门重点
- 有匹配文章时调用 AI 生成“今日重点、业务影响、建议动作、参考原文”
- 没有关注信源或当日无匹配文章时不调用 AI
- 结果保存到 `yimin_department_daily_reports`；同一部门当天的信源、文章和公共日报输入未变化时复用缓存
- AI 失败时降级为规则整理，不影响公共日报和个人关注

部门日报提供独立批量生成接口，不需要用户身份或登录 Token：

```bash
curl -X POST https://你的域名/api/daily/departments/generate
```

本地调试也可以直接访问：

```text
http://127.0.0.1:4173/api/daily/departments/generate?refresh=1
```

接口默认异步返回 `202` 并在后台生成，避免长时间 AI 请求被线上网关切断；需要同步等待完整结果时可请求 `?sync=1`。接口只处理已经配置默认关注信源的真实部门，并发生成数量为 2。当天已有部门日报记录时直接复用，不再重复生成；公共日报尚未生成时返回 `409`；同步模式下部分部门失败时返回 `207` 和逐部门结果，其他部门仍会继续生成。需要人工强制覆盖当天记录时可请求 `?refresh=1`。

手机端和 PC 网页端的 `/api/daily/department` 只读取已有部门日报，不触发懒生成。常规生成应由每日定时任务在公共日报成功后调用上述批量接口。

建议每日定时任务顺序：

1. `7:00` 请求 `/api/wx/sync-contacts`
2. `8:00` 请求 `/api/daily?refresh=1` 后台生成公共日报，并在成功后预生成英文版缓存
3. 公共日报成功后请求 `/api/daily/departments/generate`
4. `8:50` 请求 `/api/push/daily`
