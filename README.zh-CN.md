# Aris Chat

[English](README.md) | 简体中文

基于 DeepSeek API 的聊天客户端。默认是纯静态页面：不需要应用后端，浏览器直接请求配置的 API 服务。自托管时还可以启动内置的存储服务，把对话数据保存在 Docker 数据卷里，重建容器或升级镜像都不会丢失；也可以部署到 Cloudflare（Workers + D1 + R2），不用自己运维服务器。

点击 [在线体验](https://www.illageraris.dpdns.org/chat/) 即可使用；也可以把 `pnpm build` 的产物部署到任意静态服务器，或直接打开 `dist/index.html` 在本机使用。首次使用时，请在设置中填写 API Key。

## 快速开始

### 方式一：静态页面

把所有构建产物放到任意静态服务器即可，无需后端。对话保存在浏览器本地存储（IndexedDB）中，按浏览器用户配置和站点源隔离，换浏览器或清理站点数据后不可恢复；可以随时用设置里的导出做备份。

### 方式二：Docker 自托管（对话存到数据卷）

```sh
docker run -d --name chat -p 8080:3000 -v chat-data:/data ghcr.io/illagercpr/chat:latest
```

打开 http://localhost:8080 。对话和附件保存在容器内的 `/data/chat.db`（SQLite），挂在 `chat-data` 卷上，重建容器、升级镜像都不会丢；同一实例的所有访问者共享同一份对话。

也可以用仓库里的 [compose.yaml](compose.yaml)：

```sh
docker compose up -d
```

想直接在宿主机上看到数据文件，把 volumes 换成宿主机目录，并先给容器内的 `node` 用户（uid 1000）写权限：

```sh
mkdir -p ./data && sudo chown 1000:1000 ./data
```

| 环境变量              | 默认值  | 说明                                  |
| --------------------- | ------- | ------------------------------------- |
| `PORT`                | `3000`  | 监听端口                              |
| `CHAT_DATA_DIR`       | `/data` | 数据库所在目录                        |
| `CHAT_PASSWORD`       | 空      | 设置后启用访问口令（HTTP Basic Auth） |
| `CHAT_USERNAME`       | `chat`  | 口令对应的用户名                      |
| `CHAT_MAX_FILE_MB`    | `64`    | 单个附件原件的大小上限                |
| `CHAT_MAX_SESSION_MB` | `32`    | 单个会话 JSON 的大小上限              |

口令只在反向代理提供 HTTPS 时才算安全，纯 HTTP 下凭据是明文传输的。

备份与迁移：对话也可以随时在设置里导出为 ZIP，任何一份部署都能导入。直接备份数据卷：

```sh
docker run --rm -v chat-data:/data -v "$PWD":/backup alpine tar -czf /backup/chat-data.tgz -C /data .
```

### 方式三：Cloudflare 部署（Workers + D1 + R2）

想长期在线、又不想自己运维服务器时用这条线：前端产物由 Cloudflare Workers 的静态资源伺服，对话数据存进 D1（SQLite），附件原件存进 R2。代码在 [worker/index.ts](worker/index.ts)，与自托管版共用同一套存储接口。

前置条件：Cloudflare 账号，并在控制台 **R2 → 开通**（需要绑定支付方式；每月 10 GB 存储与 100 万次 A 类操作都在免费额度内）。

```sh
wrangler login
wrangler r2 bucket create aris-chat-files
pnpm db:migrate:remote     # 建表：wrangler d1 migrations apply aris-chat --remote
pnpm deploy:cf             # 构建并发布 Worker（含前端产物）
```

D1 数据库 `aris-chat` 已经创建，`database_id` 写在 [wrangler.jsonc](wrangler.jsonc) 里；换账号部署时先 `wrangler d1 create aris-chat`，再把新的 id 替换进去。

发布后到 Workers 控制台给 Worker 绑定域名。**如果打算叠加 Cloudflare Access**，要注意 Access 只作用于自定义域名，`*.workers.dev` 那个入口会绕过它；想堵住这个口子，就同时设一个访问口令：

```sh
wrangler secret put CHAT_PASSWORD
```

口令只作用于 `/api/*`：静态资源由 CDN 直接伺服，不经过 Worker，因此不消耗 Worker 请求额度，也不受口令保护。数据本身都在 `/api` 后面。

本地调试不需要真实的 Cloudflare 资源，`wrangler dev` 会用本地模拟的 D1 与 R2：

```sh
pnpm build
pnpm db:migrate:local
pnpm dev:cf                # 3000 端口，正好是 pnpm dev 的 /api 代理目标
```

自动部署：[.github/workflows/cloudflare.yml](.github/workflows/cloudflare.yml) 在 push 到 main 时执行「类型检查 → lint → 构建 → D1 迁移 → 发布」。在仓库 Secrets 里配置 `CLOUDFLARE_API_TOKEN`（模板选 "Edit Cloudflare Workers"，再补 R2 的 Edit 权限）与 `CLOUDFLARE_ACCOUNT_ID`；没配 Token 时部署步骤自动跳过，流水线不会变红。

与自托管版的差异（都是平台限制，不是配置项）：

- 单个会话正文上限 2 MB（D1 单行上限，默认限到 1.9 MB），超限时保存会明确报错；
- 单个附件上限 25 MB（受 Worker 128 MB 内存约束）；
- 免费额度：D1 单库 500 MB、R2 10 GB、Workers 每天 10 万次请求；单请求 CPU 超过 10 ms 时免费版会报 1102 错误。

数据迁移用设置里的「导入历史对话」即可：新部署指向空库，导入一次就把旧数据搬过去。

### 方式四：本地开发

前端构建需要 Node.js 22.12+ 和 pnpm；运行内置存储服务需要 Node.js 24+（用到内置 SQLite 与 TypeScript 类型剥离）。

```sh
git clone https://github.com/illagerCPR/chat.git
cd chat
pnpm install
pnpm dev
```

打开 http://localhost:8090 。想同时用上服务端存储，另开一个终端：

```sh
pnpm dev:server
```

`pnpm dev` 会把 `/api` 代理到 `http://127.0.0.1:3000`，数据写到 `.data/chat.db`；服务没起时前端自动退回浏览器存储。

生成静态产物：

```sh
pnpm build
```

产物位于 `dist/`，可部署到静态服务器，也可直接打开 `dist/index.html`。直接打开时，浏览器需允许 `file://` 页面的本地存储。

## 功能

- 多会话、自动标题、重命名与删除；编辑提问、重新生成和切换消息分支。
- 流式回答、深度思考、智能搜索、链接阅读与来源引用；支持停止和符合条件的继续生成。
- 附件上传、粘贴与拖拽，语音输入和回复朗读；移动端录音时输入框首行显示实时频谱。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 简体中文与英文、浅色与深色主题、移动端布局、位置设置、历史导入导出。
- 可选的服务器端存储：对话与附件持久化到 SQLite 数据卷，可选用访问口令。
- 自定义提供商：可指向 DeepSeek 兼容、标准 Anthropic Messages 或 OpenAI 兼容端点，每条配置有自己的 Key、模型、系统提示词与能力开关；联网搜索、语音与余额固定使用 DeepSeek 官方服务，因此第三方端点上也能用这三项。

## 提供商

设置 → 提供商 里维护一组 API 配置。内置的 DeepSeek 始终存在，地址、模型 ID 与协议固定为官方配置（`/anthropic/v1/messages`、`/anthropic/v1/files`、`/models`），只能修改 API Key、系统提示词与能力开关。新增的自定义提供商可以从两种协议里选一种：

- **DeepSeek 兼容**：按地址自动识别是哪一种 Anthropic 兼容接口，设置页地址下方会显示实际请求地址。
  - 站点根地址或带 `/anthropic` 的地址（如 `https://api.deepseek.com`、`…/anthropic/v1`）：按 DeepSeek 的扩展接口调用，支持附件，联网搜索与链接阅读由端点自己用 DeepSeek 的 server tools 完成。
  - 带版本段的地址（如 `https://api.example.com/provider/v1`）或直接粘贴的整条端点（`…/v1/messages`、`…/v1/message`）：按标准 Anthropic Messages API 调用，附件不可用，联网搜索改由官方检索完成（见下文）。
- **OpenAI 兼容**：`POST /v1/chat/completions`，流式返回。地址填根地址或 `/v1` 地址均可，客户端会自动补全 `/v1/chat/completions`。聊天与图片内联都支持：图片以 data URL 发送，端点返回的思考内容（`reasoning_content` 或 `reasoning`）会正常展示。联网搜索由官方检索完成，结果作为首条 `system` 消息注入；语音与余额同样使用官方服务（见下文）。PDF、Word 这类文档附件无法通过该协议发送。「获取模型列表」会用 `GET /v1/models` 填充模型 ID。

每条提供商有独立的地址、API Key、模型 ID、系统提示词，以及附件、深度思考、联网搜索、语音、余额五个能力开关。只有开启的能力会出现在界面上，未开启的能力不会写进请求体，因此只实现了部分接口的端点也能正常聊天。

### 系统提示词

每条提供商的系统提示词单独保存，在「API Key」下方编辑，输入框失焦即保存。默认值按提供商区分：内置 DeepSeek 是「该助手为DeepSeek，由深度求索公司创造。」，其他端点为空——空默认值表示请求里不带 `system`。内置项同样可以改，改过之后右上角的「恢复默认」回到该提供商的默认值。

- 清空并保存表示明确不发送系统提示词，与「使用默认值」是两种状态：只有后者会跟随默认文案的变化。
- 系统提示词每轮请求都会带上；用第三方端点开启联网搜索时，检索结果会与它拼成同一段 `system`（提示词在前，空行分隔），OpenAI 兼容形态也仍然只有一条 `system` 消息，避免部分网关只认一条。

### 官方能力

联网搜索、语音（语音输入与朗读）和余额查询由 DeepSeek 官方服务提供，与当前选中的提供商无关——正和第三方模型聊天时，这三项仍然请求 `api.deepseek.com`，使用设置底部的「官方能力 Key」。留空即沿用内置 DeepSeek 的 Key；两者都没有时，这三项在设置里置灰，输入区也不会显示对应按钮。

第三方端点（标准 Anthropic 与 OpenAI 兼容）上的联网搜索是这样实现的：先用官方 Key 做一次检索，把结果整理成上下文附给主请求——标准 Anthropic 形态注入 `system` 字段，OpenAI 形态作为首条 `system` 消息——界面上照常显示来源卡片。检索失败不会中断回答，只会提示本次没有用上检索结果。只有 DeepSeek 结构端点（官方本身或转发到官方的反代）才由端点执行搜索。

把提供商改成第三方端点时，联网搜索、语音与余额三个开关会自动打开，也可以在设置里单独关掉。

会话标题在首轮回答结束后自动生成：内置 DeepSeek 由接口的 `title` 扩展字段返回，其他端点则用当前模型另发一次轻量请求概括主题。起名失败不会提示，会话保持「新对话」，你随时可以手动改名（已改过名的会话不会再被覆盖）。

浏览器直连端点有两条硬约束：

- 端点必须允许跨域请求。
- HTTPS 页面不能访问 `http://` 地址。本地模型请套一层 HTTPS 反向代理，或改用 HTTP 打开本页面。

## 数据

提供商配置与界面设置始终保存在浏览器 localStorage；API Key 按提供商分别保存，只会发往对应的端点。对话数据按部署方式存放：

- 静态部署：会话与附件原件保存在浏览器 IndexedDB，按浏览器用户配置和站点源（origin）隔离。
- Docker 自托管：会话与附件保存在服务端的 `/data/chat.db`，由数据卷持久化；浏览器只缓存当前页面里的状态，换浏览器或换设备访问同一实例能看到同一份对话。
- Cloudflare 部署：会话正文与附件元数据存在 D1，附件原件存在 R2；浏览器同样只缓存页面状态，所有访问者共享同一份对话。

三种方式下，发送消息、上传附件和使用语音功能都会把相应内容提交给配置的 API 服务。

设置中的历史导入导出使用 ZIP 格式。导入会在确认并校验成功后替换全部会话和附件；导出包含会话与可用的图片原件，不包含 API Key、设置或非图片附件原件。格式与保留范围见[历史导入导出](src/services/chat/history/README.md)。

设置 → 数据管理 → 删除所有对话，会在确认后清空全部会话、附件原件和未发送的草稿，停止正在生成的回复并回到新对话。API Key 和其他设置保留，已上传到 API 服务的文件不受影响；自托管部署下清理范围是服务器的数据库，数据卷里的数据库文件本身不会被删除。

## 开发

| 命令                                                | 用途                                      |
| --------------------------------------------------- | ----------------------------------------- |
| `pnpm dev`                                          | 启动开发服务器                            |
| `pnpm dev:server`                                   | 启动内置存储服务（开发用）                |
| `pnpm dev:cf`                                       | 本地运行 Cloudflare 版（本地 D1/R2 模拟） |
| `pnpm deploy:cf`                                    | 发布 Worker（含前端产物）                 |
| `pnpm db:migrate:local`<br>`pnpm db:migrate:remote` | 应用 D1 表结构迁移（本地 / 线上）         |
| `pnpm build`                                        | 构建到 `dist/`                            |
| `pnpm start`                                        | 运行构建产物与存储服务                    |
| `pnpm type`                                         | TypeScript 类型检查                       |
| `pnpm lint`                                         | oxlint 检查                               |
| `pnpm format`                                       | oxfmt 格式化                              |

[rspack.config.ts](rspack.config.ts) 默认连接 `https://api.deepseek.com`。`createConfig({ apiOrigin, devServer })` 支持自定义 API 地址和开发服务器代理。

聊天默认使用 `deepseek-flash`，通过 Anthropic 兼容的 Messages / Files API 通信；语音使用 ASR / TTS 接口。请求使用搜索、链接阅读、标题和 `latest_reminder` 等扩展，接入服务需支持相应能力。附件实际支持的格式以服务端校验为准。

```text
server/               服务端核心：路由与校验（core/）、存储实现（store/）、自托管入口（node/）
worker/               Cloudflare Worker 入口，复用 server/core 的路由
migrations/           D1 表结构迁移
cloudflare/           静态资源的缓存头规则（构建时拷到 dist）
src/
  app/                应用布局、主题与全局样式
  components/         聊天、设置、Markdown 等界面组件
  i18n/               中英文文案
  services/
    api/              API 请求、SSE 与协议类型
    chat/             会话、消息分支、存储实现与历史导入导出
    markdown/         Markdown 解析、代码高亮与图表
    speech/           录音与朗读
  utils/              通用工具
```

存储实现在 [src/services/chat/storage/](src/services/chat/storage/) 下：`indexeddb.ts` 是浏览器本地实现，`server.ts` 走内置存储服务，启动时探测同源是否存在 `/api/storage` 自动选择。服务端细节见 [server/README.md](server/README.md)。

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
