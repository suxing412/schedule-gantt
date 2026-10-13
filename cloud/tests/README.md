# 数据库回归验收

`rpc-regression.cjs` 是已在真实 PostgreSQL 17.11 + pgcrypto 上执行的回归脚本，不是 SQL 文本匹配测试。它通过独立 psql 连接模拟 `anon` 调用，验证数据库权限、编辑会话、失败计数提交和并发版本控制。

## 环境与运行

需要 Node.js 22+、PostgreSQL 17 和 `psql`。使用**专用测试 PostgreSQL 实例**，不要对生产环境运行。连接账号须具有创建/删除测试数据库、安装 pgcrypto、迁移对象及修改其权限的能力；测试集群中预先建好 `anon` 和 `authenticated` 两个角色：

```sql
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
```

连接使用标准 libpq 环境变量：`PGHOST`、`PGPORT`、`PGUSER`、`PGDATABASE`（维护数据库，默认 `postgres`）。认证可使用标准 `.pgpass` / `PGPASSFILE`；无需把密码写入源码或测试命令。`PSQL_BIN` 可指定 psql 可执行文件路径，默认从 PATH 查找。

PowerShell 示例（替换为自己的测试环境）：

```powershell
$env:PSQL_BIN = 'C:\tools\pgsql\bin\psql.exe'
$env:PGHOST = '127.0.0.1'
$env:PGPORT = '55432'
$env:PGUSER = 'schedule_test'
$env:PGDATABASE = 'postgres'
$env:SCHEDULE_TEST_DB = '1'
node cloud/tests/rpc-regression.cjs

# 第二条路径：模拟平台已将 pgcrypto 安装在 public schema。
$env:PGCRYPTO_TEST_PUBLIC = '1'
node cloud/tests/rpc-regression.cjs
```

可设置 `RPC_TEST_REPORT` 为 JSON 报告输出路径，父目录须已存在。报告不包含编辑码哈希或令牌。所有配置只在运行时传入；不得将真实凭据提交到仓库。

## 数据隔离和清理

脚本要求显式设置 `SCHEDULE_TEST_DB=1`。每次生成随机的 `schedule_rpc_test_<20位hex>` 数据库，在该库应用迁移并创建合成排期。默认路径验证 pgcrypto 新装进私有 schema；设置 `PGCRYPTO_TEST_PUBLIC=1` 时先在随机库安装 public.pgcrypto，再验证迁移收紧已有扩展权限。

脚本不清空或更新维护数据库及其他既有数据库的业务表，不修改既有全局预算。结束时只删除本进程成功创建的那个随机数据库。若进程被强制终止或删除失败，日志会提示残留测试库名；管理员核实该名称后可单独清理。脚本不会自动创建集群角色、修改系统服务、开放监听地址或安装软件。

## 覆盖范围

- 重跑迁移、保留已有排期及会话；匿名角色不能读取私有表/调用私有函数/直接调用 pgcrypto。
- 创建排期使用 bcrypt，公开返回不含哈希和令牌；临时令牌绑定排期、昵称和有效期。
- Unicode UTF-16 长度及 JavaScript trim 边界。
- 超过十次正确解锁不消耗排期失败额度；错误码计数正常提交，成功解锁不抹去历史失败。
- 无效、跨排期、过期、撤销的令牌拒绝写入；非法项目数据不增加版本。
- 20 个并发保存、两个有效会话争抢同一版本：恰好 1 次成功、19 次冲突。
- 40 个并发错误编辑码：恰好 10 次验证失败、30 次限流；窗口过期后恢复。
- 拒绝显式 `Prefer: tx=rollback` 请求；另行复现强制外层回滚会撤销失败计数这一数据库事务边界。

## WorkBuddy 上线前仍需验收

这套测试运行真实 PostgreSQL，但没有经过 WorkBuddy 托管网关/PostgREST。没有外部数据库连接串的平台不能直接运行 psql；部署方应通过其管理员迁移通道与真实 SDK/RPC 执行对应验收。

必须确认真实网关默认提交 RPC 事务，不能接受调用者强制回滚计数；检查错误码请求后失败计数持久存在，检查匿名直接访问私有表及 pgcrypto 被拒绝。数据库计数是业务验证额度，不能代替网关请求频率/资源防护。测试报告中的外层回滚案例通过，表示限制已被复现，并不表示该风险已经消除。
