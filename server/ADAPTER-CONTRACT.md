# 云存储适配器契约

此文档供 WorkBuddy 接入实际数据库。HTTP 服务、权限校验、编辑码验证、项目校验和冲突响应由应用负责；适配器负责持久化完整排期记录及原子版本写入。

`server/adapters/cloud.example.cjs` 是待实现模板。模板会明确抛出未实现错误，不会伪装保存成功。本次交付不包含已连接的 WorkBuddy 数据库或未知 SDK。

## 模块入口

使用 CommonJS 导出一个工厂：

```js
module.exports = {
  async createStore(config) {
    // 在这里初始化真实数据库客户端；初始化失败应抛错。
    // 返回满足下文契约的 { get, create, compareAndSwap, close? }。
    throw new Error('请实现实际数据库适配器');
  }
};
```

应用通过 `server/storage.cjs` 的 `createStore({driver, dataDir, adapterModule, ...config})` 加载模块。工厂可以同步或异步返回存储对象；接收的是传入配置的浅拷贝，含 `driver`、`adapterModule` 及显式传入的其他配置。适配器也可以自行从服务端环境变量读取数据库连接和凭据；这些变量不得写入网页运行配置。

生产环境由 HTTP 入口强制要求：

- `NODE_ENV=production`。
- `STORAGE_DRIVER=external`。
- `STORAGE_ADAPTER_MODULE` 为实际适配器模块的**绝对路径**。
- `SESSION_SECRET` 至少包含 32 个 UTF-8 字节。

存储模块底层也支持相对当前工作目录解析模块路径，但生产入口不允许依赖相对路径。缺少外部适配器或初始化失败时必须终止启动，不能降级到文件模式。

## 私有记录

`get` 返回完整私有记录，`create` 和 `compareAndSwap` 接收同样结构：

```text
{
  id:             32 位小写十六进制字符串,
  revision:       大于等于 1 的安全整数,
  project:        经过应用项目校验的 JSON 对象,
  createdAt:      与 Date.toISOString() 一致的 ISO 日期时间字符串,
  updatedAt:      与 Date.toISOString() 一致的 ISO 日期时间字符串,
  updatedBy:      最后修改者的昵称字符串,
  editCodeHash:   包含盐与散列信息的 scrypt 编码字符串
}
```

数据库至少需要以 `id` 为唯一键。请按原样持久化应用传入的记录，不在适配器内重新计算版本、时间或项目内容，不丢弃散列中的盐和编码信息，也不把 `editCodeHash` 改存为四位明文编辑码。

完整记录是**服务端私有数据**。云平台的数据表、SDK 访问规则和任何自动生成接口都不能允许匿名直接读取它。只有 HTTP 层生成的公开排期响应可以交给浏览器，该响应会排除 `editCodeHash`。不能把数据库记录直接绑定到前端页面或返回给客户端。

个人列宽、左右比例、列显隐和顺序、默认视图、任务折叠等偏好由共享前端隔离在本机；适配器不需要为它们创建共享用户设置，也不应在保存项目时混入某一浏览器的布局。

## 必须实现的方法

```js
await store.get(id);                                    // record | null
await store.create(record);                             // boolean
await store.compareAndSwap(id, expectedRevision, nextRecord); // boolean
await store.close?.();                                  // 可选
```

| 方法 | 契约 |
|---|---|
| `get(id)` | 返回该 ID 的完整私有记录；不存在返回 `null`。数据库故障抛错，不得伪装成不存在。 |
| `create(record)` | 原子地插入不存在的 ID。插入成功返回 `true`；该 ID 已存在返回 `false`，不能覆盖已有记录。 |
| `compareAndSwap(id, expectedRevision, nextRecord)` | 仅当该 ID 存在且当前 `revision === expectedRevision` 时，原子替换为 `nextRecord`。成功返回 `true`；不存在或版本不匹配返回 `false`，并保持已有记录不变。 |
| `close()` | 可选，释放数据库连接或其他资源。 |

所有 ID 必须是 32 位小写十六进制字符串。CAS 请求中的 `nextRecord.id` 必须等于参数 `id`，`nextRecord.revision` 必须严格等于 `expectedRevision + 1`。

`server/storage.cjs` 对记录与适配器返回值做校验及克隆隔离。`create`、`compareAndSwap` 必须返回真正的布尔值，不能返回受影响行数、SDK 响应对象或 `undefined`。`get` 必须返回符合记录契约的对象或 `null`；`undefined` 不表示不存在，无效结果会被当作错误，不会被解释为写入成功。

## 原子性是必需条件

CAS 必须由数据库事务、带版本条件的更新或等价的原子操作实现。例如，逻辑上执行：

```text
UPDATE record
SET contents = nextRecord, revision = nextRecord.revision
WHERE id = requestedId AND revision = expectedRevision

只在恰好更新一条记录时返回 true。
```

上面是操作语义，不是可直接运行的 SQL。适配器实现应使用所选数据库的参数绑定和实际存储字段。

不能先 `get`、在 JavaScript 中比较版本，再执行无条件覆盖；两个并发请求都可能通过比较。也不能用单个 Node 进程里的锁替代云数据库事务，因为生产可能有多个进程或实例。

`create` 同样必须依靠唯一键约束或原子“仅不存在时创建”操作完成。唯一键冲突返回 `false`；网络中断、超时、权限不足等故障应抛错，由上层处理。

收到 CAS `false` 后，HTTP 服务按当前记录状态处理不存在或版本冲突；版本冲突返回 `409 REVISION_CONFLICT` 及最新公开记录。适配器不能自行忽略旧版本重试覆盖，也不需要自行组装 HTTP 响应。

## 文件模式边界

内置 `file` 模式在 `dataDir` 写入本机文件，以同进程、同解析目录的串行锁和临时文件替换保护写入。它只用于开发验证，不能让多个进程共享同一数据目录充当云数据库。

HTTP 入口将 `DATA_DIR` 解析为目录；兼容旧别名 `SCHEDULE_DATA_DIR`，但优先使用 `DATA_DIR`。两者均未配置时使用服务文件旁的 `.data/`。该目录不应随交付目录打包，不应被静态服务暴露。生产模式必须使用真实外部适配器。

## WorkBuddy 接入验收

1. 创建记录后重启进程，用同一数据库可读回完整项目及版本。
2. 两次同时 `create` 相同 ID，只有一次返回 `true`。
3. 两个实例同时对同一版本执行 CAS，恰有一次返回 `true`，最终版本只增加一次；失败方不会覆盖成功方。
4. 旧版本 CAS 返回 `false` 且不修改记录；不存在的 ID 也返回 `false`。
5. 写入成功后可取得已提交的记录；不要用不能满足版本确认需要的陈旧缓存读取。
6. 数据库故障抛错；无效返回值不能被转换成成功；修改调用方持有的对象不能改变已持久化记录。
7. 匿名用户只能通过应用的公开 GET 读取排期，无法通过云数据库 API 或静态路径取得 `editCodeHash`、会话密钥或数据库凭据。

实际部署步骤、环境变量及 HTTP 接口见 [DEPLOYMENT.md](../DEPLOYMENT.md)。
