# 移民公司官网项目采集

当前已包含桉侨移民、景鸿移民、侨外移民、亨瑞移民、世贸通移民、澳星出国、
和中移民、外联出国和兆龙移民九家公司。

## `yimin_ai_hot` 统一运行方式

本目录与 `yimin_ai_hot` 放在同一个仓库，但使用独立 Python 虚拟环境运行。
Node 服务不启动采集进程，只接收本目录生成的
`peer-website-snapshot/v1` 快照。正式定时任务统一执行仓库中的
`scripts/run-peer-website-collect.sh`，不要再逐条配置九个 Python 命令。

### 首次安装

以下命令在服务器的 `yimin_ai_hot` 项目根目录执行：

```bash
python3 -m venv .venv-peer-web
./.venv-peer-web/bin/pip install --upgrade pip
./.venv-peer-web/bin/pip install -r collectors/peer-web/requirements.txt

PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/ms-playwright" \
  ./.venv-peer-web/bin/playwright install --with-deps chromium

chmod +x scripts/run-peer-website-collect.sh
```

桉侨、世贸通、澳星使用 Playwright/Chromium，其余六家主要使用 HTTP 和
`lxml`。虚拟环境、Chromium、运行输出和日志均已从 Git 排除。

### 首次联调

先只抓一家并调用导入接口的 dry-run，不写数据库：

```bash
/bin/bash scripts/run-peer-website-collect.sh dry-run --only peer-a
```

单家通过后，再验证九家完整快照：

```bash
/bin/bash scripts/run-peer-website-collect.sh dry-run
```

人工检查快照计数后正式导入：

```bash
/bin/bash scripts/run-peer-website-collect.sh write
```

默认请求本机 `http://127.0.0.1:4173`，loopback 请求不需要 Token。若实际
端口不同，在宝塔任务中设置 `YIMIN_BASE_URL`，例如：

```bash
YIMIN_BASE_URL=http://127.0.0.1:4174 \
  /bin/bash /服务器实际路径/yimin_ai_hot/scripts/run-peer-website-collect.sh write
```

若必须通过公网域名调用，需要同时在进程环境中提供
`PEER_DISCOVERY_CRON_TOKEN`，不得把 Token 写进脚本或命令行参数。

### 宝塔计划任务

建议每天 `02:30` 创建一条 Shell 计划任务：

```bash
YIMIN_BASE_URL=http://127.0.0.1:4173 \
  /bin/bash /服务器实际路径/yimin_ai_hot/scripts/run-peer-website-collect.sh write
```

脚本使用 `flock` 防止上一轮未结束时重复运行，九家按顺序采集；单站失败不会
阻塞其他站点，但最终退出码会明确表示本轮不完整：

- `0`：九家采集和导入均成功；
- `1`：导入接口或运行级错误；
- `2`：至少一家为 `partial/failed`，其余成功站点仍会导入；
- `75`：已有另一轮任务运行，本次未启动。

每轮文件保存在 `var/peer-web/runs/<run_id>/`：

- `snapshot-v1.json`：提交给 `yimin_ai_hot` 的标准快照；
- `manifest.json`：九家退出码、耗时、计数和日志位置；
- `<peer-code>/collector.log`：单站采集日志；
- `import-response.json`：导入接口响应。

`var/peer-web/latest.json` 指向最近一轮结果。日志和快照不得提交 Git。

可选环境变量：

| 变量 | 默认值 | 作用 |
|---|---:|---|
| `YIMIN_BASE_URL` | `http://127.0.0.1:4173` | `yimin_ai_hot` 本机地址 |
| `PEER_WEBSITE_IMPORT_MODE` | `write` | `write/dry-run/none` |
| `PEER_WEBSITE_COLLECTOR_TIMEOUT_SECONDS` | `2700` | 单家最长运行秒数 |
| `PEER_WEBSITE_IMPORT_TIMEOUT_SECONDS` | `300` | 快照导入超时秒数 |
| `PEER_WEBSITE_OUTPUT_ROOT` | `var/peer-web` | 运行快照与日志目录 |
| `PEER_WEBSITE_VENV_PATH` | `.venv-peer-web` | 独立 Python 环境目录 |
| `PLAYWRIGHT_BROWSERS_PATH` | `.cache/ms-playwright` | Chromium 安装目录 |

`build_companies_summary.py` 仅保留给人工导出 CSV/Markdown 使用，正式定时链路
由 `peer_website_runner.py` 直接生成 V1 快照，不依赖覆盖式总汇总文件。

## 桉侨移民

采集 `https://www.aqyimin.com` 简体中文官网公开展示的移民项目，包括：

- 项目名称与所属国家/地区分类
- 项目介绍
- 投资、购房、存款、基金等投资方式
- 金额、资产、收入、存款证明等财务要求
- 项目/移民优势
- 申请条件
- 申请流程与逐步办理流程
- 官网原始链接和图片链接

该网站是 Vue 单页应用，普通 HTTP 请求只能得到空壳 HTML，因此程序使用 Playwright 渲染详情页。项目网址同时从 `sitemap.xml` 和当前前端 JavaScript 路由中发现，以减少漏项。

## 运行

```bash
python3 aqyimin_projects_scraper.py
```

默认低频顺序抓取，页面间隔 0.8 秒，并输出：

- `output/aqyimin_projects.json`：保留列表、流程等嵌套结构，推荐作为主数据
- `output/aqyimin_projects.csv`：方便用 Excel 打开
- `output/summary.json`：数量、分类和失败页面汇总
- `output/aqyimin_projects_overview.md`：按官网国家/地区分类的项目清单

常用参数：

```bash
# 先抓 3 个页面验证
python3 aqyimin_projects_scraper.py --limit 3

# 只抓一个指定项目
python3 aqyimin_projects_scraper.py \
  --url https://www.aqyimin.com/detail/turmigrate

# 指定输出目录和抓取间隔
python3 aqyimin_projects_scraper.py \
  --output-dir output \
  --delay 1.2
```

程序会优先使用 macOS 中已安装的 Google Chrome、Chromium 或 Microsoft Edge。如果未自动找到浏览器，可使用：

```bash
python3 aqyimin_projects_scraper.py \
  --chrome-path "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

## 合规提示

程序只访问 `robots.txt` 允许的公开项目页面，不访问登录、会员、搜索或带查询参数的页面。官网声明“未经书面授权禁止复制或建立镜像”；如需重新发布全文或图片，应先取得相应授权。

## 景鸿移民

运行景鸿移民官网采集：

```bash
python3 ekimmigration_scraper.py
```

结果保存到 `output/ekimmigration/`。该站的部分申请流程以图片形式发布在
`/uploads/` 下，而该目录被网站 `robots.txt` 禁止抓取；程序会保留流程图片
链接和相应标记，但不会批量下载图片。

合并所有已采集公司的结果：

```bash
python3 build_companies_summary.py
```

统一结果保存在 `output/all_companies_projects.json` 和
`output/all_companies_projects.csv`。

## 侨外移民

运行侨外移民官网采集：

```bash
python3 iqiaowai_scraper.py
```

结果保存到 `output/iqiaowai/`。该站使用静态 HTML，但一个国家入口页可能
同时展示多个项目；程序会按页内选项卡拆分，并继续读取“热门海外身份”目录
中的公开专题页。重复指向同一美国页面的入口会按项目名称去重。

侨外页面对不同项目公开的字段并不完全一致。程序只保存官网实际提供的内容：
完整流程保存在 `application_process` / `handling_process`，只公开办理周期的
项目标为 `summary_only`，未公开流程的项目标为 `missing`。

抓取完成后重新生成所有公司的统一结果：

```bash
python3 build_companies_summary.py
```

## 亨瑞移民

运行亨瑞移民官网采集：

```bash
python3 visa800_scraper.py
```

结果保存到 `output/visa800/`。该站使用服务端生成的 GB2312/GBK HTML，
不需要浏览器渲染。程序合并首页和项目总目录发现项目，并从统一详情模板提取
项目介绍、投资及费用、申请条件、申请流程、项目优势和亨瑞服务优势。

站点的 IIS/WAF 偶尔会以 HTTP 500 返回完整官网页面。程序只在响应正文达到
合理长度且通过项目名称与详情模板校验后接受此响应，防止把普通错误页保存成
项目数据。

## 世贸通移民

运行世贸通移民官网采集：

```bash
python3 worldwayhk_scraper.py
```

结果保存到 `output/worldwayhk/`。该站前置阿里云浏览器 JavaScript 校验，
普通 HTTP 请求拿到的是验证脚本，因此程序使用 Playwright 顺序访问官网前台
导航可达的国家页和项目页。若无头浏览器被拦截，可改用：

```bash
python3 worldwayhk_scraper.py --headed
```

官网部分项目的申请流程仅以图片发布。程序会标记为 `image_only` 并保存图片
原始链接，不自动下载或 OCR。国家攻略、移民指南等非统一项目模板页面会进入
`summary.json` 的排除清单，不计入正式项目数。

采集后重新生成所有公司的统一结果：

```bash
python3 build_companies_summary.py
```

## 澳星出国

运行澳星出国官网采集：

```bash
python3 austargroup_scraper.py
```

结果保存到 `output/austargroup/`。该站使用服务端静态 HTML，但首页前置
“云锁”浏览器校验，普通 HTTP 客户端只能得到验证跳转脚本；程序使用
Playwright 通过首页发现 `/visa/` 和 `/passport/` 两类公开详情页。

签证/居留页的办理流程多数是 HTML 步骤，投资入籍页可能只以图片发布。
程序会保存流程图片原始链接并标记为 `image_only`，不自动下载或 OCR。
同一项目若同时存在两种模板入口，会保留内容更完整的一页，并把另一页写入
`summary.json` 的重复排除清单。官网明确标注“已暂停”或存量名额的项目，
会保留 `website_status_note`，不将“仍展示”等同于正常开放。

采集后重新生成所有公司的统一结果：

```bash
python3 build_companies_summary.py
```

## 和中移民

运行和中移民官网采集：

```bash
python3 welltrendvisa_scraper.py
```

结果保存到 `output/welltrendvisa/`。该站使用服务端生成的静态 HTML，
`robots.txt` 明确允许公开页面。项目分布在美国、加拿大、欧洲、护照移民、
亚非身份、大洋洲和香港七个栏目页。

加拿大和香港栏目提供包含项目介绍、优势、条件、费用及周期的详细选项卡；
其他栏目主要提供项目名称、身份类型和资产要求等摘要卡片。程序使用
`source_granularity` 区分 `detailed_tab` 与 `summary_card`，对官网没有
公开的优势、条件或流程标记为缺失，不进行推测补全。官网仍展示并不代表相关
政策当前开放，结果不作为法律或移民政策有效性判断。

采集后重新生成所有公司的统一结果：

```bash
python3 build_companies_summary.py
```

## 外联出国

运行外联出国官网采集：

```bash
python3 wailianvisa_scraper.py
```

结果保存到 `output/wailianvisa/`。该站使用服务端生成的静态 HTML，程序从
当前 `/projects` 项目总目录发现项目，不依赖更新滞后的 `sitemap.xml`。
普通项目详情页可直接提取项目介绍、优势和申请条件；申请流程与申请费用多数
以图片形式发布，程序保留原图链接并标记为 `image_only`，不自动 OCR。

四个重点项目使用图片型专题页，程序保留专题正文图片并以项目目录摘要补足
文本介绍。官网仍展示不代表相关政策当前开放，结果不作为法律或政策有效性
判断。

采集后重新生成所有公司统一结果：

```bash
python3 build_companies_summary.py
```

## 兆龙移民

运行兆龙移民官网采集：

```bash
python3 zlglobal_scraper.py
```

结果保存到 `output/zlglobal/`。该站首页、专题页和文章详情页使用
GB2312/GBK 静态 HTML，不需要浏览器渲染；程序以当前首页导航为项目范围，
采集 25 个 `/zt/` 专题项目和 5 个澳洲文章式项目，不依赖内容较旧的
`sitemap.xml`。

程序从两类模板提取项目介绍、投资或财务要求、项目优势、申请条件和办理流程。
流程仅以图片发布时，程序保留官网图片链接并标记为 `image_only`，不下载
`robots.txt` 禁止的 `/uploads` 资源，也不自动 OCR。官网仍显示项目不代表
项目当前一定开放，结果不作为法律或移民政策有效性判断。

采集后重新生成所有公司统一结果：

```bash
python3 build_companies_summary.py
```
