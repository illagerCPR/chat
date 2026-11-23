# 服务端

静态产物本身不需要后端：对话存在浏览器 IndexedDB 里。这个目录提供可选的存储服务，同一个前端产物在自托管容器或 Cloudflare Workers 上都能挂上它，数据落在服务端而不是浏览器里。

前端启动时请求 `GET /api/storage`，响应体带 `{"mode":"server"}` 就走这套 API，否则退回 IndexedDB。所以同一份产物在静态托管、`file://` 打开、容器部署和 Cloudflare 部署下都能用。

## 分层

两套部署共用同一份路由与校验，只在存储实现和入口上分叉：

```text
                     server/core/  路由、校验、Basic Auth、请求体读取
                        │                          │
        server/store/sqlite.ts            server/store/d1.ts
             node:sqlite                        D1 + R2
                        │                          │
   server/node/（node:http + 静态资源）   worker/index.ts（fetch + Static Assets）
```

| 目录              | 职责                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [core/](./core)   | 平台无关：`router.ts` 端点分发、`validate.ts` 请求校验、`auth.ts` Basic Auth、`http.ts` 响应与请求体、`errors.ts`                                                               |
| [store/](./store) | `types.ts` 是 `ChatStore` 接口；`sqlite.ts` 与 `d1.ts` 是两个实现                                                                                                               |
| [node/](./node)   | `index.ts` 入口在仓库根的 [server/index.ts](./index.ts)；`server.ts` 起 HTTP 服务、`bridge.ts` 把 Node 请求转成标准 `Request`、`static.ts` 伺服 `dist/`、`config.ts` 读环境变量 |
| `worker/`         | Cloudflare Worker 入口（仓库根），复用 `core` 与 `d1.ts`                                                                                                                        |

`ChatStore` 的方法都是异步的：D1 天生异步，SQLite 侧只是把同步调用包一层。需要「要么全成要么全不成」的路径由实现内部保证。

## 运行

### 自托管（Node）

```sh
pnpm build          # 产出 dist/
pnpm start          # 默认 3000 端口，数据目录 /data
```

开发时前后端分开跑：

```sh
pnpm dev            # 8090，把 /api 代理到 127.0.0.1:3000
pnpm dev:server     # 3000，数据写 .data/chat.db
```

环境变量（默认值以容器为准）：

| 变量                  | 默认值         | 说明                                             |
| --------------------- | -------------- | ------------------------------------------------ |
| `PORT`                | `3000`         | 监听端口                                         |
| `HOST`                | `0.0.0.0`      | 监听地址                                         |
| `CHAT_DATA_DIR`       | `/data`        | 数据库目录，不存在时自动创建                     |
| `CHAT_DIST_DIR`       | 仓库内 `dist/` | 静态资源目录                                     |
| `CHAT_USERNAME`       | `chat`         | Basic Auth 用户名                                |
| `CHAT_PASSWORD`       | 空             | 非空时启用 Basic Auth，静态资源与 API 都要求登录 |
| `CHAT_MAX_FILE_MB`    | `64`           | 单个附件原件的请求体上限                         |
| `CHAT_MAX_SESSION_MB` | `32`           | 单个会话 JSON 的请求体上限                       |

代码是 TypeScript，由 Node 24 的类型剥离直接运行，不单独编译；`pnpm type` 用 [server/tsconfig.json](./tsconfig.json) 一并检查（`erasableSyntaxOnly` 保证只用可擦除语法）。

### Cloudflare

```sh
pnpm build
pnpm db:migrate:local      # 本地 D1 建表
pnpm dev:cf                # wrangler dev，3000 端口

pnpm db:migrate:remote     # 线上 D1 建表
pnpm deploy:cf             # 发布 Worker（含静态资源）
```

绑定写在仓库根的 [wrangler.jsonc](../wrangler.jsonc)：

| 绑定     | 资源                 | 说明                                                |
| -------- | -------------------- | --------------------------------------------------- |
| `DB`     | D1 `aris-chat`       | 会话正文、附件元数据、导入暂存                      |
| `BUCKET` | R2 `aris-chat-files` | 附件原件，key = `files/<id>`                        |
| `ASSETS` | 静态资源             | `dist/`，`run_worker_first` 只放 `/api/*` 进 Worker |

运行期变量：`CHAT_USERNAME`、`CHAT_PASSWORD`（建议用 `wrangler secret put`）、`CHAT_MAX_FILE_MB`（默认 25）、`CHAT_MAX_SESSION_MB`（默认 1.9）。

## 两套实现的差异

| 方面        | `node:sqlite`                             | `D1 + R2`                                                        |
| ----------- | ----------------------------------------- | ---------------------------------------------------------------- |
| 事务        | `BEGIN IMMEDIATE` / `COMMIT`              | `db.batch([...])`，整批原子，最多 100 条语句                     |
| 会话正文    | `sessions.data` 列                        | 同左（单行上限 2 MB）                                            |
| 附件字节    | `files.data` BLOB                         | R2 对象 `files/<id>`                                             |
| 附件元数据  | `files(id, mime_type, size, data)`        | `files(id, mime_type, size)`，没有 `data` 列                     |
| 改名        | `UPDATE ... json_set(data, '$.title', ?)` | 同一句 SQL                                                       |
| 删除回收    | 删行 + `PRAGMA incremental_vacuum`        | 删 D1 行 + 删 R2 对象                                            |
| schema 版本 | `PRAGMA user_version`                     | `wrangler d1_migrations`（D1 不允许 PRAGMA，实测 `SQLITE_AUTH`） |

两套 schema 分别在 [store/sqlite.ts](./store/sqlite.ts) 的 `SCHEMA` 与 [migrations/0001_init.sql](../migrations/0001_init.sql)，改动时两边同步。

D1 侧的几处取舍：

- 多表写入一律 `db.batch()`；单会话引用超过 97 个附件时，超出的引用分批追加（会话行与第一批引用仍然原子）。
- `files` 表只用于「哪些附件还有人引用」，字节在 R2。删除会话时先删 D1 引用、再删 R2 对象；中途失败最多留下无人引用的对象，不影响正确性。
- 导入暂存的附件与正式附件**共用同一个 key**，提交时不需要搬字节；`commitStaging` 只在一个 batch 里换引用关系，被替换掉的旧附件随后从 R2 删除。

## API

同源，无 CORS。设置了口令时除探测端点外都要带 Basic Auth。

| 方法   | 路径                        | 前端对应                    | 说明                                                                 |
| ------ | --------------------------- | --------------------------- | -------------------------------------------------------------------- |
| GET    | `/api/storage`              | 启动探测                    | `{ mode, version, backend, dataDir }`，`backend` 为 `sqlite` 或 `d1` |
| GET    | `/api/sessions`             | `loadSessionSummaries`      | `{ sessions: [...] }`，按 `updated_at` 倒序                          |
| GET    | `/api/sessions/:id`         | `loadSession`               | 原样返回会话 JSON，不存在 404                                        |
| PUT    | `/api/sessions/:id`         | `saveSession`               | 整份会话覆盖写，附件的**引用关系**同事务更新                         |
| PATCH  | `/api/sessions/:id`         | `renameSession`             | `{ title }`，`updatedAt` 不变                                        |
| DELETE | `/api/sessions/:id`         | `deleteSession`             | 删会话并回收无引用附件，幂等                                         |
| GET    | `/api/files/:id`            | `loadFile`                  | 附件原件字节（D1 版从 R2 流式转发）                                  |
| PUT    | `/api/files/:id`            | `saveFiles` / `saveSession` | 原件字节，`Content-Type` 记为 MIME                                   |
| PUT    | `/api/staging/sessions/:id` | `addStagingSession`         | 导入暂存                                                             |
| PUT    | `/api/staging/files/:id`    | `saveStagingFiles`          | 导入暂存                                                             |
| PATCH  | `/api/staging/file-types`   | `updateStagingFileTypes`    | `{ types: { [fileId]: mime } }`                                      |
| POST   | `/api/staging/commit`       | `commitStaging`             | 整体替换，返回新列表                                                 |
| DELETE | `/api/staging`              | `clearStaging`              | 清空暂存                                                             |

写入顺序：`saveSession` 先 PUT 附件再 PUT 会话，所以会话一旦可见，它的附件一定已经落库；中途失败只会留下没人引用的原件，等下一次删除会话或导入提交时回收。

## 数据模型

```sql
sessions (id TEXT PK, title TEXT, created_at INTEGER, updated_at INTEGER, data TEXT)
files    (id TEXT PK, mime_type TEXT, size INTEGER)      -- D1 版
files    (id TEXT PK, mime_type TEXT, size INTEGER, data BLOB)  -- SQLite 版
session_files (session_id REFERENCES sessions ON DELETE CASCADE, file_id, PK(session_id, file_id))
staging_sessions / staging_files / staging_session_files        -- 结构同正式表
```

- 会话正文（含消息树、分支选择）整份存进 `data`，一次读写整个对象；列表需要的元信息单独成列，避免为了列表解析全部正文。
- `session_files` 记录引用关系：删除会话时级联清边，再删掉没有被任何会话引用的附件。同一个附件可能被多个会话或同一会话的多条消息引用，只按引用关系回收。
- SQLite 版用 `PRAGMA auto_vacuum = INCREMENTAL` + 删除后 `PRAGMA incremental_vacuum`，让删掉的附件页真正还给文件系统；D1 由平台管理空间。

### 导入的原子替换

历史导入在前端完成解析与校验，把结果写进暂存表：逐条 `PUT /api/staging/sessions/:id`、`PUT /api/staging/files/:id`，图片 MIME 回填走 `PATCH /api/staging/file-types`。全部写完再 `POST /api/staging/commit`，服务端「清空正式表 → 从暂存灌入 → 清空暂存」在一处完成，失败整体回滚，原有对话不受影响，也不需要崩溃恢复逻辑。

## 静态资源

自托管版对齐原来的 nginx 配置：

- `/static/` 下缺失直接 404，命中则 `cache-control: public, max-age=31536000, immutable`（文件名带内容哈希）。
- 入口页、`icon.svg` 使用 `no-cache`，发版后立刻生效。
- 其余未知路径回落到 `index.html`（单页应用），`/api` 开头除外。
- 文本资源超过 1 KB 且客户端支持 gzip 时压缩，压缩结果按文件路径缓存在内存里。
- 解析后的路径必须仍在 `dist/` 内，防目录穿越；所有响应带 `X-Content-Type-Options: nosniff`。

Cloudflare 版由 Workers Static Assets 伺服，缓存头由构建时拷进 `dist/_headers` 的 [cloudflare/\_headers](../cloudflare/_headers) 决定，规则与上面同义。差异只有一处：SPA 的 `not_found_handling` 让未命中的 `/static/*` 也回落到入口页（状态码 200 而不是 404），脚本不会执行，只是响应码不同。

## 安全与限制

- Basic Auth 只在 HTTPS 下安全，纯 HTTP 会明文传输口令；没有口令时任何能访问端口的人都能看到全部对话。
- 请求体先按 `Content-Length` 快速拒绝，读到之后再按实际长度复核，避免超限请求占满内存。
- 归档导入的会话 id、附件 id 来自外部文件，写入前校验：只允许非空、无路径分隔符、无控制字符、长度 ≤ 255。
- Cloudflare 版的限制全部来自平台：D1 单行 2 MB（会话正文默认限 1.9 MB）、单条语句 100 KB、每次 `batch` 100 条语句、每 Worker 调用 50 次 D1 查询、Worker 内存 128 MB（附件默认限 25 MB）、免费版每天 10 万请求与单请求 10 ms CPU。
- Cloudflare Access 只保护自定义域名，`*.workers.dev` 入口绕过它；两者同时使用时保留口令作为兜底。
- 单进程、同步 SQLite 读写，写入由事件循环天然串行；面向个人与家庭使用，不处理多实例并发写同一个数据库。
