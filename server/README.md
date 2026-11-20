# 内置存储服务

静态产物本身不需要后端：对话存在浏览器 IndexedDB 里。这个目录提供一个可选的服务端，用一个 Node 进程同时伺服 `dist/` 和对话存储 API，把数据写进 `CHAT_DATA_DIR` 下的 SQLite 数据库。容器里它对应 `/data/chat.db`，挂成数据卷即可持久化。

前端启动时请求 `GET /api/storage`，响应体带 `{"mode":"server"}` 就走这套 API，否则退回 IndexedDB。所以同一份产物在静态托管、`file://` 打开和容器部署下都能用。

## 运行

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

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `CHAT_DATA_DIR` | `/data` | 数据库目录，不存在时自动创建 |
| `CHAT_DIST_DIR` | 仓库内 `dist/` | 静态资源目录 |
| `CHAT_USERNAME` | `chat` | Basic Auth 用户名 |
| `CHAT_PASSWORD` | 空 | 非空时启用 Basic Auth，静态资源与 API 都要求登录 |
| `CHAT_MAX_FILE_MB` | `64` | 单个附件原件的请求体上限 |
| `CHAT_MAX_SESSION_MB` | `32` | 单个会话 JSON 的请求体上限 |

代码是 TypeScript，由 Node 24 的类型剥离直接运行，不单独编译；`pnpm type` 用 `server/tsconfig.json` 一并检查（`erasableSyntaxOnly` 保证只用可擦除语法）。

## 目录

| 文件 | 职责 |
| --- | --- |
| [index.ts](./index.ts) | 启动、请求分发、优雅退出 |
| [config.ts](./config.ts) | 环境变量与默认值 |
| [db.ts](./db.ts) | 打开 SQLite、PRAGMA、建表与版本检查 |
| [store.ts](./store.ts) | 会话、附件、导入暂存的读写与事务 |
| [api.ts](./api.ts) | 存储 API 端点 |
| [static.ts](./static.ts) | 静态资源：缓存头、gzip、SPA 回退 |
| [http.ts](./http.ts) | 请求体读取、错误响应、资源 id 校验 |
| [auth.ts](./auth.ts) | 可选 Basic Auth |

## API

同源，无 CORS。设置了口令时除探测端点外都要带 Basic Auth。

| 方法 | 路径 | 前端对应 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/storage` | 启动探测 | `{ mode, version, dataDir }` |
| GET | `/api/sessions` | `loadSessionSummaries` | `{ sessions: [...] }`，按 `updated_at` 倒序 |
| GET | `/api/sessions/:id` | `loadSession` | 原样返回会话 JSON，不存在 404 |
| PUT | `/api/sessions/:id` | `saveSession` | 整份会话覆盖写，附件的**引用关系**同事务更新 |
| PATCH | `/api/sessions/:id` | `renameSession` | `{ title }`，`updatedAt` 不变 |
| DELETE | `/api/sessions/:id` | `deleteSession` | 删会话并回收无引用附件，幂等 |
| GET | `/api/files/:id` | `loadFile` | 附件原件字节 |
| PUT | `/api/files/:id` | `saveFiles` / `saveSession` | 原件字节，`Content-Type` 记为 MIME |
| PUT | `/api/staging/sessions/:id` | `addStagingSession` | 导入暂存 |
| PUT | `/api/staging/files/:id` | `saveStagingFiles` | 导入暂存 |
| PATCH | `/api/staging/file-types` | `updateStagingFileTypes` | `{ types: { [fileId]: mime } }` |
| POST | `/api/staging/commit` | `commitStaging` | 事务内整体替换，返回新列表 |
| DELETE | `/api/staging` | `clearStaging` | 清空暂存 |

写入顺序：`saveSession` 先 PUT 附件再 PUT 会话，所以会话一旦可见，它的附件一定已经落库；中途失败只会留下没人引用的原件，等下一次删除会话或导入提交时回收。

## 数据模型

```sql
sessions (id TEXT PK, title TEXT, created_at INTEGER, updated_at INTEGER, data TEXT)
files    (id TEXT PK, mime_type TEXT, size INTEGER, data BLOB)
session_files (session_id REFERENCES sessions ON DELETE CASCADE, file_id, PK(session_id, file_id))
staging_sessions / staging_files / staging_session_files   -- 结构同正式表
```

- 会话正文（含消息树、分支选择）整份存进 `data`，一次读写整个对象；列表需要的元信息单独成列，避免为了列表解析全部正文。
- `session_files` 记录引用关系：删除会话时级联清边，再删掉没有被任何会话引用的附件。同一个附件可能被多个会话或同一会话的多条消息引用，只按引用关系回收。
- `PRAGMA auto_vacuum = INCREMENTAL` + 删除后 `PRAGMA incremental_vacuum`，让删掉的附件页真正还给文件系统。

### 导入的原子替换

历史导入在前端完成解析与校验，把结果写进暂存表：逐条 `PUT /api/staging/sessions/:id`、`PUT /api/staging/files/:id`，图片 MIME 回填走 `PATCH /api/staging/file-types`。全部写完再 `POST /api/staging/commit`，服务端在一个事务里「清空正式表 → 从暂存灌入 → 清空暂存」，失败整体回滚，原有对话不受影响，也不需要崩溃恢复逻辑。

## 静态资源

行为对齐原来的 nginx 配置：

- `/static/` 下缺失直接 404，命中则 `cache-control: public, max-age=31536000, immutable`（文件名带内容哈希）。
- 入口页、`icon.svg` 使用 `no-cache`，发版后立刻生效。
- 其余未知路径回落到 `index.html`（单页应用），`/api` 开头除外。
- 文本资源超过 1 KB 且客户端支持 gzip 时压缩，压缩结果按文件路径缓存在内存里。
- 解析后的路径必须仍在 `dist/` 内，防目录穿越；所有响应带 `X-Content-Type-Options: nosniff`。

## 安全与限制

- Basic Auth 只在 HTTPS 下安全，纯 HTTP 会明文传输口令；没有口令时任何能访问端口的人都能看到全部对话。
- 请求体按 `Content-Length` 先快速拒绝、分块累计再判断，避免超限请求占满内存。
- 归档导入的会话 id、附件 id 来自外部文件，写入前校验：只允许非空、无路径分隔符、无控制字符、长度 ≤ 255。
- `node:sqlite` 在 Node 24 标注为实验性（会用 Release Candidate 版本），API 目前够用且零依赖；若将来需要更稳的绑定再换 `better-sqlite3` 之类的实现。数据都在单文件 SQLite 里，换实现不影响前端协议。
- 单进程、同步 SQLite 读写，写入由事件循环天然串行；面向个人与家庭使用，不处理多实例并发写同一个数据库。
