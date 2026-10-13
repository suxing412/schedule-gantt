# 开发验收记录

## 2026-10-12：V2/V3 独立交付包验收

用户已明确要求提供部署说明和交付包。`schedule-gantt-workbuddy-v2-v3-20261012` 从独立目录执行随包测试，**256/256 通过**；发布脚本回归 **21/21 通过**。前端构建一致性和官方 SDK 0.1.3 校验和检查通过。

直接以交付目录为工作目录启动包内 `cloud/serve.cjs` 子进程，**10/10 项检查通过**：单端口启动、缺失配置时正确拒绝云操作、配置后的健康检查、首页及分享链接、静态资源、40 个 HTTP 工具发现与 OpenAPI、私有源码不可访问、公开读取、Worker 预览/分析，以及授权写入的版本和令牌传递。上游为隔离的本地模拟 RPC，未调用生产环境。详细结果随包提供为根目录 `PACKAGE-VALIDATION.md` 和 `PACKAGE-SMOKE.json`。

这次只生成交付文件，未执行生产数据库迁移、未上线、未修改用户排期。WorkBuddy 仍须完成部署说明中的真实数据库、网关事务提交和 UI 验收。下方为之前开发阶段的历史记录。

## 2026-10-12：V2 工具协作与 V3 时间轴交互

本节记录 V2/V3 开发阶段验收：当时按用户要求仅修改源码、构建开发页面并测试，没有生成新交付包，也没有向线上排期写入测试数据。随后用户明确授权准备 WorkBuddy 部署说明及交付包；此授权不改变以下历史测试范围。新交付包的独立运行验收需单独记录，不能以源码测试结果替代。下方 10 月 10 日记录是 V1 历史基线，不能作为本轮新增功能已经通过的证据。

本轮验收分为三层：纯函数及接口单测、真实 PostgreSQL 独立测试库、真实浏览器配合本地测试网关。它们均不能代替 WorkBuddy 生产网关的部署验收。

### 源码回归与构建

源码回归 **489/489 项通过**，最终回归明确排除 `test/web-release.test.cjs` 和 `test/workbuddy-release.test.cjs`，没有生成交付包。日志为 `.repair-work/v2-v3-unit-tests.log`。`node scripts/build-frontend.cjs --check` 与 `node scripts/vendor-workbuddy-sdk.cjs --check` 均通过。

真实 Chrome 使用官方 SDK，经本地测试网关连接真实 PostgreSQL，V2/V3 最终 **14/14 项检查通过**。报告为 `.repair-work/v2-browser-smoke-results.json`，覆盖 43 个浏览器工具的发现及关键交互。月视图下，绘制宽度仅 4.8 像素的单日任务条真实拖动后移一天、拖右端延长一天、撤销并保存均通过。

实际 PNG 下载成功，文件 1,854,281 字节；Alt 连续缩放从 22 到约 27.967 像素/天，鼠标日期锚点误差约 0.282 像素。JavaScript、控制台和 SQL 错误均为 0，高亮、协作者及月视图截图已经目视检查。测试浏览器及临时资源已清理，本次 loopback PostgreSQL 已停止，未停止用户原有 3000/5173 服务。

### 已完成的真实数据库验证

PostgreSQL 17.11 的两个独立测试环境均通过 **53/53 项**：全新 pgcrypto 安装在私有 schema，以及平台预先将 pgcrypto 安装在 public schema。报告为 [v2-full-pg17.json](tests/results/v2-full-pg17.json) 与 [v2-existing-pgcrypto-pg17.json](tests/results/v2-existing-pgcrypto-pg17.json)，报告中迁移 SHA-256 与验收时的三份迁移源码一致，临时测试数据库残留为 0。

覆盖 25 个动作的 SQL/JS 结果一致性、五种字段及边界值、失败批量不保存且额度正常提交、来源与授权隔离、重置/撤销竞态。64 次并发外部密钥请求结果为 60 次进入验证、4 次限流；20 次同版本并发动作恰好 1 次成功、19 次冲突。迁移保留旧排期及会话、重复执行不轮换密钥也已验证。

上述为独立 PostgreSQL 实测，不代表托管网关已验证。

### 可重复执行的源码检查

```powershell
node scripts/build-frontend.cjs
$sourceTests = Get-ChildItem -LiteralPath test -Filter '*.test.cjs' |
  Where-Object { $_.Name -notin @('web-release.test.cjs', 'workbuddy-release.test.cjs') } |
  ForEach-Object { $_.FullName }
node --test $sourceTests
node scripts/build-frontend.cjs --check
node scripts/vendor-workbuddy-sdk.cjs --check
```

专项文件包括 `test/ai-operations.test.cjs`、`test/ai-read-tools.test.cjs`、`test/ai-http.test.cjs`、`test/ai-mcp.test.cjs` 和浏览器工具/高亮、时间轴缩放、任务条几何、云端 transport/client 的回归测试。上述命令复现开发阶段的源码回归范围，跳过两份会创建发布目录的测试。后续已授权的交付验收可另行执行发布测试；独立交付包的 `npm test` 只执行随包收录的测试。前端重新构建与生成交付包是两个步骤。

数据库：先按 `cloud/tests/README.md` 准备专用 PostgreSQL、角色、`PSQL_BIN`、`PGHOST/PGPORT/PGUSER/PGDATABASE` 和 `SCHEDULE_TEST_DB=1`，再运行：

```sh
node cloud/tests/v2-rpc-regression.cjs
```

脚本在自己创建的随机数据库中验证 `001` → `002` → `003`，结束只删除该测试库。不要把生产环境连接配置传给测试脚本。可用 `RPC_TEST_REPORT` 指定 `cloud/tests/results/v2-*.json` 报告；真实凭据不写入报告。

### V2 核心验收项

- 升级和重复迁移保留旧排期、人工会话、已有 API 密钥；旧排期能用四位码签发首个可用 AI 密钥。
- 公开记录、导出和 presence 无密钥/令牌/摘要；匿名、过期及跨排期会话不能列出协作者。
- API 密钥与人工编辑码分别验证、分别限流；错误请求正常提交额度，human/external 会话不能走对方写入路径。
- 重置密钥撤销全部旧外部会话，保留人工会话；撤销、重置和写入并发不绕过授权。
- JS 预览与数据库动作语义一致，非法日期、依赖环、字段类型不写入；原子批量失败不留下部分内容。
- 同版本人机写入只能一个成功，另一个返回最新版本；无变化动作不增加版本。
- HTTP 目录/schema/公开读/导出/授权/动作可用；请求大小、固定上游、错误响应及凭据过滤生效。
- stdio MCP 初始化、目录、调用、版本字段、授权和错误均符合适配器协议；无自动写入重试，取消/超时不假定未提交。
- 真实浏览器检查一次性密钥展示/关闭清理、协作者心跳生命周期、来源标记、授权控制和保存冲突保留草稿。
- 浏览器工具不绕过编辑权限或草稿保护；负责人和完整显式依赖链高亮不保存共享数据。

### 高亮与 V3 交互实现约定

- 负责人高亮只存在当前页内存，按 `who.trim()` 精确匹配，不写入项目或 localStorage。依赖高亮对显式 `deps` 上游、下游分别进行带访问标记的 BFS，按需计算并缓存；不混入父子层级，也不因同一个祖先误高亮其他分支。
- `Alt + 滚轮` 连续缩放按动画帧合并，范围为 1–200 像素/天。用 `day = bds.mn + (scrollLeft + anchorX) / oldDw` 记录鼠标锚点日期，重建时间轴后设 `scrollLeft = (day - newMin) * newDw - anchorX`，保持该日期位于鼠标下。日/周/月预设会重置连续缩放；原有 `Shift + 滚轮` 横向滚动保留。
- 任务条的逻辑 `bPos.x / bPos.w` 保持完整日期跨度，用于命中、拖动、缩放及依赖定位；视觉主体宽度为 `paintWidth = w - min(2px, 0.2 × dw)`。短任务不靠最小绘制宽度延伸到下一天。
- 普通条圆角 5 px、泳道条 4 px、汇总条 1 px，汇总条保留三角端部并移除原先 15 px 错位。节点使用 12/16 px 日期中心符号，不借符号尺寸延长时间跨度。
- PNG 导出与当前连续缩放共用宽度及视觉间隙规则，保持页面与导出几何一致。上述视图交互不触发共享排期保存。

### 实际部署仍需验证

使用隔离的合成排期，经真实发布域名验证管理员迁移、PostgREST schema 刷新、Origin/CORS、公开配置注入、HTTP `/api/` 路由、外部客户端取会话并写入、并发冲突及换容器后的持久化。编辑码、AI 密钥和令牌不能进入部署日志。

必须检查真实网关默认提交事务且不能强制回滚失败计数。数据库内正常 `RETURN` 能保留计数，并不能消除外层事务回滚；数据库预算也不是 DDoS 防护。工具目录与 `/healthz` 可访问均不足以证明云端数据库和授权正常。

## 2026-10-10：V1 历史基线

日期：2026-10-10。开发环境：Windows、Node.js 24.19.0、PostgreSQL 17.11、Chrome 155。以下结果来自当时的本地执行，记录形成时尚未部署到 WorkBuddy，不描述现有网站的部署状态。

### 自动回归

源码仓库执行 `node --test test/*.test.cjs`：**354 项通过，0 项失败**。包括原有排期功能、共享客户端、官方 SDK transport、发布脚本和 HTTP 服务检查。`node scripts/build-frontend.cjs --check` 与官方 SDK 离线校验通过。

独立交付目录中的随包测试 **99 项通过**，构建一致性与 SDK 校验通过。直接运行交付包入口 `node cloud/serve.cjs`（与 `npm start` 等价），在临时本机端口完成 **12 项路由检查**：首页、分享链接、静态 SDK、runtime 配置和健康检查可用，环境文件、SQL、测试文件及旧 API 不对外提供。检查使用合成公开配置，只验证静态服务独立启动，不代表云数据库连通。测试进程已关闭。

### 真实数据库

`cloud/tests/rpc-regression.cjs` 在两个随机独立测试库分别执行：全新 pgcrypto 安装在私有 schema、已有 pgcrypto 安装在 public schema。**每种环境 15 项通过**，包含：

- 重复迁移保留已有排期和编辑会话，匿名用户不能读取私有表或直接调用加密函数。
- 正确码获取编辑权限；错误码、跨排期、过期及已撤销令牌拒绝写入。
- 20 个连接同时保存同一版本：1 次成功，19 次冲突。
- 40 个连接同时提交错误码：10 次实际验证失败，30 次限流，独立连接读回计数为 10。
- 正确码不消耗失败额度，也不清空之前的失败次数。

外层强制回滚仍会撤销计数的测试也通过，表示**已复现并记录这个限制**，不表示 SQL 消除了外层回滚风险。真实平台必须按部署说明限制回滚和响应转换等路径。

### 真实浏览器

两个隔离 Chrome 浏览器上下文，使用随包官方 SDK，经测试专用 HTTP 网关调用真实 PostgreSQL：**18 项业务检查通过**，无未捕获异常、控制台错误或网关错误。

覆盖新建与复制链接、匿名查看、昵称及四位码解锁、任务和字段保存、轮询同步、版本冲突保留草稿、刷新恢复、个人列宽隔离、退出后旧令牌拒写、加载重试、缺少配置/SDK 时阻止进入，以及原本地版兼容。工作区、冲突提示、只读页和配置错误页截图已检查。

首轮浏览器脚本在所有业务检查通过后，因 Windows 临时 Chrome 目录删除失败而退出码为 1。临时目录已用核实路径后的 PowerShell 清理，修正后的清理函数单独验证退出码为 0；临时浏览器和 HTTP 服务已关闭。该清理问题未计作应用业务通过之外的成功运行。

### 当时交由部署方验收的事项

本地测试网关不等同于 WorkBuddy 的托管网关。尚未验证真实发布域名、Origin/CORS、管理员迁移权限、publicConfig 注入、云端事务提交、换容器后的持久化及平台流量保护。

请依照 `DEPLOYMENT.md` 和 `HANDOFF-PROMPT.md` 完成实际平台验收并返回网址；不要把 `/healthz` 返回成功当作云数据库已接通。
