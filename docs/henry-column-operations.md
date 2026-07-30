# H 专栏运行与验收手册

> 适用范围：H 专栏 P0  
> 内容方法：Henry 文章与视频写作 Skill  
> 最后核对：2026-07-24

## 1. 运行前提

H 专栏复用现有 Node.js、MySQL、DeepSeek 和企业微信身份能力。启动服务前至少确认：

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

模型密钥、接口地址和超时沿用 `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_TIMEOUT_MS`。人物档案默认读取 `data/henry-content-profile.json`。生产环境应显式配置身份白名单，不要依赖姓名兜底。

## 2. 权限边界

- `fanrui / Henry范睿`、`liangshuang / Celine梁爽`、IOD 部门直属成员和系统管理员采用同一权限；
- 能看到 H 菜单的成员可以使用候选、事实包、观点确认、草稿、审校、退回和最终采用等全部功能；
- 其他用户：普通 `/api/h/*` 返回 `403`。
- `/api/h/automation/pre-generate` 和 `/api/h/automation/pre-generate/status` 专供定时任务使用，按部署要求不校验登录态、签名或令牌。

所有 H 写操作仍记录真实操作者。P0 不发送企业微信通知，也不直接发布内容。

## 3. 日常工作流

1. 公共日报成功后，定时任务请求预生成接口；系统筛选 0—3 个 H 候选，没有合适内容时允许为 0。
2. 系统自动选择默认候选、补充原文、生成大纲和四个渠道稿件。重复请求默认复用已有稿件并补齐缺失渠道；只有显式 `refresh=1` 才全部创建新版本。
3. 编辑核对来源完整度、证据等级、政策状态，并显式标记人工核验。
4. 任一 H 专栏成员输入并确认本次核心观点；历史观点可编辑或软删除。
5. 生成一个或多个内容大纲，并在版本列表中选择本次要采用的大纲。
6. 点击“一键生成整套稿件”，系统按照所选大纲，结合当前事实包和已确认观点，并行生成公众号文章、H快评、H边跑边聊和 H深聊。
7. 大纲不要求先审校才能生成套稿；四个渠道从同一大纲独立组织，不以公众号文章机械缩写视频稿。
8. 部分失败不会影响已成功版本，失败渠道可单独重试。
9. 每个渠道版本都可人工修改，或按该版本最新审校意见重新生成；旧版本不会被覆盖。
10. 每个渠道版本需独立运行四层审校；事实或观点在审校后发生变化时，旧审校失效，不能最终采用。

候选刷新、内容生成和四层审校都会显示加载弹窗并暂时禁用重复操作；整套生成弹窗显示实际完成进度 0/4—4/4。

H 专栏页面地址为 `/#h-column`。当日公共日报缺失时，候选生成返回 `409`，应先生成公共日报。

## 4. 定时任务接口

后台异步生成，立即返回 `202`：

```bash
curl -X POST "http://127.0.0.1:4173/api/h/automation/pre-generate"
```

同步等待并取得逐选题结果：

```bash
curl -X POST "http://127.0.0.1:4173/api/h/automation/pre-generate?sync=1"
```

强制重新生成候选、大纲和文章版本：

```bash
curl -X POST "http://127.0.0.1:4173/api/h/automation/pre-generate?sync=1&refresh=1"
```

查询当前进程内最近一次运行状态：

```bash
curl "http://127.0.0.1:4173/api/h/automation/pre-generate/status?date=2026-07-30"
```

可选参数：

- `date=YYYY-MM-DD`：默认上海时区当天；
- `topicIds=12,13`：只处理指定日期的选题；
- `modes=wechat_article,short_video`：只生成指定渠道；默认同时生成四个渠道；
- `limit=3`：不超过 `H_COLUMN_DAILY_MAX_TOPICS`；
- `refreshTopics=1` / `refreshDrafts=1`：分别刷新候选或稿件；
- `refresh=1`：同时刷新候选和稿件；
- `sync=1`：同步等待，否则后台执行。

同一天的并发请求会合并。状态结果保存在当前 Node 进程内；服务重启后状态回到 `idle`，已经写入数据库的稿件不会丢失。

大纲和每个渠道默认最多尝试 3 次，间隔由 `H_COLUMN_PREGENERATE_RETRY_DELAY_MS` 控制。返回结果的 `attempts` 表示实际尝试次数，`recoveredAfterRetry=true` 表示该渠道在自动重试后恢复；超过最大次数仍失败时，批次返回 `207 partial_failed`，其他成功渠道继续保留，下一次普通请求只补失败或缺失渠道。

## 5. 最小验收

先执行静态检查：

```bash
npm run check
```

再启动服务，用授权测试身份完成下面的闭环：

1. 打开 H 专栏，确认菜单、四个页签和移动端详情正常；
2. 对同一天重复生成候选，确认不会重复插入；
3. 选择一个候选并补充完整来源；
4. 编辑来源正文后，确认原有“已核验”状态被重置；
5. 确认观点并观察四项门槛变为可成稿；
6. 生成两个大纲版本，选择其中一个；
7. 点击“一键生成整套稿件”，确认四个渠道各自有独立版本号，并共同引用所选大纲；
8. 模拟一个渠道失败，确认其他成功版本保留，失败渠道可单独重试；
9. 对渠道稿运行审校，确认失败或证据不足时不能最终采用；
10. 审校后修改事实包或 Henry 观点，确认旧审校失效且不能最终采用；
11. 对有必改项的渠道稿按审校意见重新生成，确认父版本和旧稿仍保留；
12. 测试 Markdown、纯文本复制和内容包导出；
13. 测试“已看”“退回修改”“最终采用”及审计日志；
14. 用未授权身份请求 `/api/h/me`，确认返回 `403`。

同时回归 `/api/health`、`/api/daily` 和 `/api/market`，确认现有功能未受影响。

## 6. 常见故障

| 现象 | 原因与处理 |
|---|---|
| 页面显示日报尚未生成 | 先生成对应日期的公共日报，再刷新候选 |
| 候选为 0 | 可能是正常结果；检查当日日报是否有与 Henry 内容定位相关的新事实 |
| 生成出的渠道稿仍提示事实不足 | 生成不等于通过审校；补充来源或删除没有依据的表述后重新审校 |
| 政策题始终不能成稿 | 必须存在人工核验的 A 级完整来源 |
| 原文抓取后仍未核验 | 自动抓取不会替代人工核验；需编辑显式确认 |
| 审校后不能采用 | 查看 L1—L4 必改项；模型不可用时系统会失败关闭 |
| “一键生成整套稿件”不可用 | 只可能是尚未选择“值得写”或还没有任何大纲；生成大纲后即可使用，打开渠道稿不会让按钮重新失效 |
| 只有部分渠道生成成功 | 已成功版本会保留；在对应失败渠道卡片点击“重试” |
| DeepSeek 生成失败 | 草稿会保存带警示的降级版本，运行记录标为失败；输入不会丢失，可点击“重试完整生成”创建新版本 |
| 未授权用户能看到菜单但打不开 | API 仍会拒绝；检查企业微信 UserID 白名单是否准确 |

## 7. 数据与恢复

H 数据保存在 `yimin_h_*` 八张表中。来源删除使用软删除；草稿编辑创建新版本，不覆盖旧版本。候选刷新会归档过期的系统候选，但不会覆盖已选择、暂缓或拒绝的人工决定。

排障时优先查看：

- `yimin_h_generation_runs`：草稿和审校调用状态、尝试次数和错误；
- `yimin_h_audit_logs`：操作者、动作和不含正文的变更元数据；
- `yimin_h_reviews`：四层质检和阻断原因；
- `yimin_h_feedback`：采用、暂缓、拒绝和退回记录。

不要直接修改已采用草稿；通过页面保存新版本，并重新运行审校。
