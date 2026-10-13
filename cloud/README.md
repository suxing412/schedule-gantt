# 排期工具 · WorkBuddy 云端版 V2 / V3

共享排期数据存 WorkBuddy PostgreSQL。人类通过昵称和四位编辑码编辑；AI 通过独立长密钥换取短期会话，调用工具修改任务、依赖、字段和里程碑。公开分享链接可直接查看，版本检查避免人机并发静默覆盖。

本交付版本用于升级现有网站 [schedule-gantt-37132.app.workbuddy.host](https://schedule-gantt-37132.app.workbuddy.host/)，保留原域名、排期数据、分享链接和人工编辑码。将独立交付目录交给 WorkBuddy，并使用 [HANDOFF-PROMPT.md](HANDOFF-PROMPT.md) 的部署指令。包内本地验证与实际云端部署验收分别记录，不能据本地通过宣称已经上线。

## 本轮能力

- HTTP 工具目录、OpenAPI、JSON 导出和统一调用入口；支持预览和原子批量。
- 本地 stdio MCP 适配器，连接固定排期，凭据通过环境配置提供。
- AI 独立密钥与人工编辑码分离；创建/重置仅展示一次，重置撤销旧 AI 会话。
- 需编辑授权的协作者列表；20 秒心跳、60 秒在线阈值，区分人工与外部来源。
- 当前浏览器工具覆盖布局、列、视图、筛选、选择、导出、撤销和高亮；远程 API 不改变其他人的视图。
- 负责人高亮与完整显式上下游依赖链高亮，只作用当前页视觉。

V3 支持 `Alt + 滚轮` 连续缩放并保持鼠标日期锚点，日/周/月预设可复位；任务条保留真实日期跨度，增加视觉间隙和圆角，短条不会延伸到下一天，PNG 与页面使用一致的几何规则。源码回归及浏览器验收进度见 [VALIDATION.md](VALIDATION.md)。

## 独立交付目录启动

要求 Node.js 22+。WorkBuddy 服务和工具适配器使用 Node 内置模块；浏览器官方 SDK 已固定版本并随源码提供，无需运行时 CDN。

```sh
npm start
```

等价命令 `node cloud/serve.cjs`。默认端口 `3000`，平台可用 `PORT` 覆盖。交付页面已构建，启动无需再构建。

若在原始源码仓库开发，先执行 `node scripts/build-frontend.cjs`，再运行 `node cloud/serve.cjs` 或 `npm run start:workbuddy`；原始仓库的 `npm start` 是旧 Node 存储服务，区别于独立交付包的启动命令。

`WORKBUDDY_PUBLISHABLE_KEY` 接平台公开配置，`WORKBUDDY_ENDPOINT` 接可信云服务 origin。HTTP AI 接口必须显式配置二者；仅浏览器 SDK 可在 endpoint 留空时使用当前 origin。服务不自动加载 `.env`；需要时用 Node 的 `--env-file`，凭据文件不进源码或交付物。缺云配置时明确报错，不回退旧本地数据。

## 文档入口

| 文档 | 内容 |
| --- | --- |
| [HANDOFF-PROMPT.md](HANDOFF-PROMPT.md) | 可直接交给 WorkBuddy 的现有站升级任务 |
| [AI-TOOLS.md](AI-TOOLS.md) | HTTP、MCP、浏览器工具完整入口、动作语义和例子 |
| [RPC.md](RPC.md) | SQL RPC、授权、会话、限流和版本契约 |
| [DEPLOYMENT.md](DEPLOYMENT.md) | 迁移顺序、环境变量、启动及平台验收 |
| [VALIDATION.md](VALIDATION.md) | 已执行测试与待实际平台验证事项 |
| [tests/README.md](tests/README.md) | 独立数据库测试环境准备 |

V1 升级按 `002_collab_external.sql` → `003_tool_actions.sql` 执行；新环境按 `001` → `002` → `003`。V2 环境不能单独重跑 001。平台只需要公开 SDK 配置和管理员迁移通道，不需要把 service-role 或数据库私有连接串交给前端/工具服务。

修改 `frontend/` 后重新构建 `index.html`。独立交付包可用 `npm test` 运行随包测试；原仓库的源码回归命令及开发期记录见 [VALIDATION.md](VALIDATION.md)。`node scripts/build-frontend.cjs --check` 检查构建一致性，`node scripts/vendor-workbuddy-sdk.cjs --check` 校验官方 SDK。数据库脚本只对专用测试实例运行；真实网站验收使用独立合成排期，不修改用户已有排期。
