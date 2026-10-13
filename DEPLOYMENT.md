# 排期工具 Node 后端与外部数据库部署

**WorkBuddy 内置云版本请使用 [cloud/DEPLOYMENT.md](cloud/DEPLOYMENT.md) 和 `npm run release:workbuddy`。** 那个交付已包含前端 RPC 和数据库函数，不需要本文件中的服务端适配器。以下说明仅适用于保留 Node 私有鉴权、另接外部数据库的部署路线。

本交付是独立 Node.js HTTP 应用：同一个进程、同一个端口提供网页与排期 API，默认端口为 `3000`。共享排期由服务端存储，前端通过 HTTP 读写；不需要 Electron，也不依赖本地网页预览服务。

该路线预留外部数据库适配接口；选择此路线时，需要实现适配器并完成事务验证。生产模式没有可用的外部适配器会拒绝启动，不会自动退回本地文件保存。

## 交付目录与运行环境

独立交付目录默认命名为 `release/schedule-gantt-web-<时间戳>/`，避免覆盖既有交付；交付脚本也可显式指定 `release/schedule-gantt-web/`。在实际生成的交付目录运行下文命令；其中包含已构建网页、Node 服务、存储模块及说明，不包含 Electron、`node_modules` 或本机排期数据。

- Node.js **22 或以上**。
- 网页与 HTTP 服务使用 Node 内置功能，启动本体无需安装运行依赖。
- WorkBuddy 后续实现的外部适配器若使用数据库 SDK，相关依赖由适配器实现方补充并随部署提供。
- `node server.js` 与交付目录内的 `npm start` 都启动同一个网页服务。

## 本机验证

在 PowerShell 中运行：

```powershell
$env:HOST = '127.0.0.1'
$env:PORT = '3000'
$env:NODE_ENV = 'development'
$env:STORAGE_DRIVER = 'file'
node server.js
```

也可将最后一行替换为 `npm start`，然后打开 <http://127.0.0.1:3000/>。

`file` 仅用于开发验证。默认数据目录为服务文件旁的 `.data/`；可用 `DATA_DIR` 指定另一处本机目录。此模式不等于云端存储，不要将同一目录交给多个 Node 进程同时写入，也不要把它放进对外静态目录。停止后重新使用同一数据目录启动，可继续读取排期。开发时若未配置固定的 `SESSION_SECRET`，重启会使已有编辑会话失效，需要重新输入昵称和编辑码。

源码中的 `node scripts/preview.cjs` 仍是 `5173` 端口的本地界面预览；它不代替本交付的共享排期服务。

## 环境变量

| 变量 | 用途 |
|---|---|
| `HOST` | HTTP 监听地址，默认 `0.0.0.0`。本机验证建议显式设为 `127.0.0.1`。 |
| `PORT` | HTTP 端口，默认 `3000`。 |
| `NODE_ENV` | 生产部署设为 `production`，启用外部存储与会话密钥强制检查。 |
| `STORAGE_DRIVER` | 开发默认 `file`；生产必须为 `external`。 |
| `DATA_DIR` | `file` 模式的数据目录；默认服务文件旁的 `.data/`。兼容旧别名 `SCHEDULE_DATA_DIR`，两者同时设置时以 `DATA_DIR` 为准。 |
| `STORAGE_ADAPTER_MODULE` | 外部适配器模块路径；生产必须使用绝对路径。接口见 [适配器契约](server/ADAPTER-CONTRACT.md)。 |
| `SESSION_SECRET` | 服务端会话签名密钥；生产要求至少 32 个 UTF-8 字节。通过部署平台的秘密配置注入，所有实例使用同一值。 |
| `PUBLIC_ORIGIN` | 配置允许的公开网页来源，例如实际部署后的 HTTPS origin。只填协议、主机及必要的端口。 |
| `ALLOWED_ORIGINS` | 需要多个允许来源时，使用逗号分隔的 origin 列表。 |
| `TRUST_PROXY` | 只有设为 `1` 才信任代理转发的协议与客户端 IP；仅在受控反向代理会覆盖这些头时启用。 |
| `PUBLIC_DIR` | 可选，显式配置后将该目录作为 `/public/` 下的公开静态资源。只能指向专用公开资源目录，不能指向数据、源码或凭据目录。 |

同源部署即可使用本应用，服务不开放跨域 CORS。反向代理需要把页面路径、`/p/`、`/api/`、`/healthz` 和静态资源都转发到同一个 Node 端口。

## 生产部署

1. 按 [适配器契约](server/ADAPTER-CONTRACT.md) 实现并测试所选外部数据库模块。`server/adapters/cloud.example.cjs` 是待实现模板，不能直接作为已完成的云端连接使用。
2. 在部署平台配置 `NODE_ENV=production`、`STORAGE_DRIVER=external`，以及适配器的绝对路径 `STORAGE_ADAPTER_MODULE`。
3. 配置数据库所需的服务端凭据和 `SESSION_SECRET`。为实际环境生成随机密钥并保存到平台秘密配置；不要把密钥写进前端、仓库或分享链接。所有服务实例及重启后的进程应使用同一个密钥；更换密钥会使已有编辑会话失效。
4. 按平台要求设置 `HOST`、`PORT` 和公开来源。由平台或受控反向代理提供 HTTPS。
5. 运行 `npm start` 或 `node server.js`，检查健康接口，再验证新建、匿名查看、解锁编辑、重新加载和并发冲突。

可以用 Node 的 `crypto.randomBytes(32)` 生成会话密钥，例如生成其十六进制文本后存入平台秘密配置。本文不提供可直接复用的固定密钥。

缺少外部驱动、适配器路径或合格会话密钥时，生产启动应失败。适配器加载或初始化失败同样应暴露错误，由部署方修复；不要改为返回假数据，也不要静默改用文件模式。

## 使用与共享流程

1. 访问根路径 `/`，创建一份**空排期**，填写标题、昵称和四位数字编辑码。
2. 创建成功后进入 `/p/<排期 ID>`。分享此页面链接，其他人无需登录即可查看排期。
3. 访问者用昵称和编辑码解锁编辑；昵称用于显示最后修改者。退出编辑后回到只读状态。
4. 修改通过服务端保存。编辑会话令牌仅用于 API 授权，不放进分享链接。
5. 已有 JSON 文件可从「项目文件 → 导入 JSON」进入；共享排期需要先解锁编辑。导入后仍按正常保存及版本冲突流程处理。

列宽、左右比例、列顺序与显隐、默认视图及折叠状态属于每个人的本机偏好，不会随共享保存覆盖其他人的界面。任务内容、自定义字段定义和填写值通过服务端共享。

编辑会话按排期保存在当前标签页的 `sessionStorage`；本机草稿和界面偏好按排期隔离保存。它们不能替代服务端数据库。

## 同时编辑与冲突

每次读取会取得排期 `revision`。保存必须携带读取时的 `baseRevision`，服务端以原子条件更新保证只接受基于当前版本的写入。

如果别人在此期间已经保存，服务端返回 `409 REVISION_CONFLICT` 和当前最新版。界面会保留本机草稿并暂停继续上传，可选择「导出草稿」留存修改，或「加载最新版」。加载最新版会要求确认放弃当前草稿；不应通过自动重试、去掉版本条件或覆盖写入来绕过冲突。

## HTTP 接口

请求体使用 `Content-Type: application/json`。公开响应包含 `id`、`revision`、`createdAt`、`updatedAt`、`updatedBy` 和 `project`；不返回编辑码散列。错误格式为 `{ "error": { "code": "…", "message": "…" } }`。

| 方法与路径 | 请求与权限 | 成功响应 |
|---|---|---|
| `GET /healthz` | 无须编辑会话 | `200`，`{ok:true,mode:"shared",storage:"file"或"external"}`。 |
| `POST /api/projects` | `{displayName, editCode, project}`；昵称去除两端空白后为 1–64 字符、无控制字符；编辑码为四位数字字符串。 | `201`，公开排期记录及 `session:{token,displayName,expiresAt}`，初始版本为 `1`。 |
| `GET /api/projects/:id` | 无须编辑会话 | `200`，公开排期记录。 |
| `POST /api/projects/:id/session` | `{displayName, editCode}` | `200`，`{token,displayName,expiresAt}`。 |
| `PUT /api/projects/:id` | `Authorization: Bearer <token>`；请求体 `{baseRevision,project}`。 | `200`，保存后的公开排期记录；过期版本返回 `409`，并附 `latest` 公开记录。 |

排期 ID 是 32 位小写十六进制字符串。编辑会话默认有效 12 小时。服务包含新建和编辑码尝试的限流，达到限制时应等待后重试；客户端不得用自动循环绕过限制。

访问 `GET /healthz` 应返回 HTTP `200`。生产环境应显示 `storage:"external"`。该响应可用于进程存活检查，但不能代替真实数据库读写及并发事务验证。

## 交给 WorkBuddy 的完成标准

- 数据表和适配器只允许服务端凭据访问，完整私有记录中的 `editCodeHash` 不提供给匿名查询、前端 SDK 或公开接口。
- 实现真正的原子 `create` 和 `compareAndSwap`；两名用户基于同一版本同时保存时，只有一个成功，另一个收到冲突。
- 重启服务或使用另一实例读取时，仍能取得已保存排期；生产状态不能依赖容器本地数据目录。
- 分享链接可匿名查看，错误编辑码无法写入，正确编辑码可解锁保存；过期会话需要重新解锁。
- JSON 导入、字段值、多人冲突与个人布局隔离均在真实云存储下通过验收。

以上云端验收需在实际适配器完成后执行。本交付不宣称已经连接或部署到 WorkBuddy 云端。
