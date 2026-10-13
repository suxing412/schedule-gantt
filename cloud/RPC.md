# WorkBuddy 排期 RPC 契约 · V2

迁移顺序：`001_schedule_rpc.sql` → `002_collab_external.sql` → `003_tool_actions.sql`。V1 环境执行后两份增量迁移。所有对外函数位于 `public`；底表与内部函数保持受限。HTTP/MCP 工具调用见 [AI-TOOLS.md](AI-TOOLS.md)。

V3 的高亮、连续缩放与任务条几何改动属于前端，不需要额外数据库迁移。本交付用于现有应用增量升级，备份、恢复与平台验收按 [HANDOFF-PROMPT.md](HANDOFF-PROMPT.md) 和 [DEPLOYMENT.md](DEPLOYMENT.md) 执行，不能用清表重建代替迁移。

浏览器通过官方 SDK 使用命名参数：

```js
const { data, error } = await cloud.database.rpc('schedule_get_project', {
  p_id: projectId,
});
// error 是 SDK/网络/PostgREST 错误；data 是下面的业务结果。
```

使用普通 JSON POST。不要设置 `Prefer: tx=rollback`、`max-affected` 或特殊输出转换；写入函数拒绝这些选项及非 JSON 输出。网关还必须真正提交事务，见 [部署说明](DEPLOYMENT.md)。

## 统一结果

成功：`{ "ok": true, "data": ... }`。

失败：`{ "ok": false, "error": { "code": "...", "message": "...", "retryAfter": 123 } }`。限流的 `retryAfter` 单位为秒；版本冲突在顶层另有 `latest`。RPC 业务失败通常仍为 HTTP 200，必须检查 `ok`。数据库、网关或 SDK 故障不能视为空项目。

`PublicRecord`：

```json
{
  "id": "32位小写hex",
  "revision": 1,
  "project": { "tasks": [], "groups": [], "flags": [], "meta": {} },
  "createdAt": "ISO 8601时间",
  "updatedAt": "ISO 8601时间",
  "updatedBy": "昵称",
  "source": "human"
}
```

`source` 为最近一次内容写入的来源，取值 `human` / `external`；它不是完整修改历史，昵称也不是经过账号认证的真实身份。

`Session`：`{ token, displayName, expiresAt, source }`。令牌为随机 64 位小写 hex（256 位随机数），有效期固定 12 小时，心跳不续期。数据库只保存其 SHA-256 摘要。令牌只在创建或解锁时返回，不放入分享链接或日志。

## 人工编辑与密钥管理

| RPC | 命名参数 | 成功时 `data` |
| --- | --- | --- |
| `schedule_get_project` | `p_id: text` | `PublicRecord`，无需编辑授权 |
| `schedule_create_project` | `p_id: text`, `p_edit_code: text`, `p_display_name: text`, `p_project: jsonb` | `PublicRecord` 加 `session: Session` 和一次性 `apiKey` |
| `schedule_unlock_project` | `p_id: text`, `p_edit_code: text`, `p_display_name: text` | human `Session` |
| `schedule_save_project` | `p_id: text`, `p_token: text`, `p_expected_revision: integer`, `p_project: jsonb` | 更新后的 `PublicRecord`；仅接受 human 会话 |
| `schedule_reset_api_key` | `p_id: text`, `p_edit_code: text` | `{ "apiKey": "新的64位小写hex密钥" }`，仅此次返回 |
| `schedule_revoke_session` | `p_id: text`, `p_token: text` | `{ "revoked": true }`，适用于两种会话 |

- 排期 ID 由密码学随机数生成 16 字节，不从标题推导。编辑码以字符串传入，恰好四位 ASCII 数字，允许开头为零；数据库用 bcrypt cost 8 验证。
- 昵称去除 JavaScript 定义的首尾空白，不能为空，原始输入和处理后均不超过 64 个 UTF-16 单元。
- `apiKey` 与人工编辑码独立，数据库只保存 SHA-256 摘要。公开读取、导出和普通解锁不会返回它。丢失后用四位码重置；重置撤销该排期全部 external 会话，保留 human 会话，不改变内容版本。
- 旧排期升级时填入未公开随机密钥的摘要；须由人工输入四位码重置，取得首个可用的 AI 密钥。重复迁移不轮换已有密钥。
- 保存校验令牌所属排期和有效期，按预期版本原子写入；数据库自行递增版本，修改人来自会话昵称。冲突返回 `REVISION_CONFLICT` 和 `latest`，不能用旧整份数据直接覆盖最新版本。
- 撤销只影响指定排期的指定令牌；重复撤销仍成功。超时可能发生在提交之后，不自动重试写入，先读取排期确认结果。

## 外部 AI 会话与动作

| RPC | 命名参数 | 成功时 `data` |
| --- | --- | --- |
| `schedule_unlock_external` | `p_id: text`, `p_api_key: text`, `p_display_name: text = 'AI助手'` | external `Session` |
| `schedule_apply_action` | `p_id: text`, `p_token: text`, `p_expected_revision: integer`, `p_action: jsonb` | `PublicRecord` 加 `results` 与 `changed` |

外部会话由 AI 长密钥签发，只能通过动作接口修改排期，不能调用人工整份保存接口。动作接口也拒绝 human 会话。数据库内部应用动作、校验最终项目并按版本提交；HTTP 预览不替代数据库校验。

单动作 `p_action` 为 `{ name, arguments }`，原子批量为 `{ operations: [{ name, arguments }, ...] }`，含 1–100 个动作。不要传 HTTP 的 `project.batch` 外层包装。`results` 每项为 `{index,name,affectedIds}`；无变化时 `changed:false`，不增加版本或改变来源。HTTP 工具网关会把公开记录归入 `data.record`，这与直接 SQL RPC 的扁平结构不同。

所有写入须提供读取时的 `p_expected_revision`。任何动作失败不保存部分项目；冲突后读取并重新评估意图，不盲目重放请求。具体参数以 [AI-TOOLS.md](AI-TOOLS.md) 和 `/api/tools` 为准。

## 协作者与心跳

| RPC | 命名参数 | 成功时 `data` |
| --- | --- | --- |
| `schedule_list_presence` | `p_id: text`, `p_token: text` | `Presence` |
| `schedule_heartbeat` | `p_id: text`, `p_token: text` | 更新调用者活跃时间后的 `Presence` |

```json
{
  "members": [
    {
      "displayName": "示例协作者",
      "lastSeenAt": "2026-10-12T08:00:00Z",
      "online": true,
      "source": "human"
    }
  ],
  "onlineThresholdSeconds": 60
}
```

两个接口都要求有效、未过期且属于当前排期的令牌，没有匿名的一参数列表接口。列表只含有效会话，同名成员并列，不返回令牌、摘要或会话 ID。“在线”表示最近 60 秒有活跃信号，不代表真实身份或正在编辑某个任务。页面编辑态每 20 秒心跳，退出/离开页面后停止；心跳不修改项目内容和版本。

## 业务错误码

| code | 含义 |
| --- | --- |
| `VALIDATION_ERROR` | ID、昵称、版本、项目或动作参数无效 |
| `NOT_FOUND` | 排期不存在 |
| `PROJECT_EXISTS` | 创建时随机 ID 已存在 |
| `INVALID_EDIT_CODE` | 四位码格式正确，但验证不通过 |
| `INVALID_API_KEY` | AI 密钥无效 |
| `UNAUTHORIZED` | 会话无效、过期、被撤销或不属于此排期 |
| `FORBIDDEN` | 会话来源不满足接口要求 |
| `RATE_LIMITED` | 额度已用完，按 `retryAfter` 等待 |
| `REVISION_CONFLICT` | 项目已变更，顶层附带 `latest` |
| `UNSUPPORTED_REQUEST` | 方法、事务选项或响应类型不受支持 |

细粒度工具还可能返回任务/字段不存在、重复 ID、子树删除需要显式参数等动作错误；以响应 `code`、`message` 为准。

## 限流与数据边界

| 通道 | 全站预算 | 单排期预算 |
| --- | --- | --- |
| 人工解锁及 AI 密钥重置 | 120 次/分钟 | 10 次错误编辑码/15 分钟 |
| 创建排期 | 20 次/小时 | — |
| 外部密钥交换及外部动作 | 60 次/分钟 | 60 次/分钟 |
| 在线列表及心跳 | 6,000 次/分钟 | 600 次/分钟 |

通道计数相互独立。正确人工码只退回本次单排期失败额度，不清空以前的失败；达到失败上限后正确码也须等待，已有会话仍可编辑。外部预算计入成功和失败请求，并非只计错误密钥。

每排期 human/external 合计最多保留 50 个会话；签发新会话时清理本排期过期及最旧的多余会话。正常业务失败用 `RETURN` 提交预算；PostgreSQL 无法阻止外层事务强制回滚。必须实测网关提交策略，数据库预算不是 DDoS 防护。

共享数据含 `tasks/groups/flags/meta`，不含个人列宽和折叠状态。未知安全 JSON 属性保留；所有层级拒绝 `__proto__`、`prototype`、`constructor`。原始项目上限 10 MiB、JSON 深度 32、节点 300,000，规范化所需节点另行预留。最多 10,000 任务、1,000 职能、10,000 全局里程碑、50 自定义字段、100,000 依赖。日期、字段类型、父子结构及双端口依赖拓扑在数据库独立校验。

不提供匿名排期总列表、编辑码反查链接、历史版本服务或账户认证。公开读仅凭排期 ID；不要开放底表或裸 `verify_code` / `update_project` 函数。
