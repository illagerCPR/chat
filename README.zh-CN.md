# Aris Chat

[English](README.md) | 简体中文

基于 DeepSeek API 的聊天客户端。默认是纯静态页面：不需要应用后端，浏览器直接请求配置的 API 服务。自托管时还可以启动内置的存储服务，把对话数据保存在 Docker 数据卷里，重建容器或升级镜像都不会丢失。

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

| 环境变量           | 默认值 | 说明                                       |
| ------------------ | ------ | ------------------------------------------ |
| `PORT`             | `3000` | 监听端口                                   |
| `CHAT_DATA_DIR`    | `/data` | 数据库所在目录                            |
| `CHAT_PASSWORD`    | 空     | 设置后启用访问口令（HTTP Basic Auth）      |
| `CHAT_USERNAME`    | `chat` | 口令对应的用户名                           |
| `CHAT_MAX_FILE_MB` | `64`   | 单个附件原件的大小上限                     |
| `CHAT_MAX_SESSION_MB` | `32` | 单个会话 JSON 的大小上限                   |

口令只在反向代理提供 HTTPS 时才算安全，纯 HTTP 下凭据是明文传输的。

备份与迁移：对话也可以随时在设置里导出为 ZIP，任何一份部署都能导入。直接备份数据卷：

```sh
docker run --rm -v chat-data:/data -v "$PWD":/backup alpine tar -czf /backup/chat-data.tgz -C /data .
```

### 方式三：本地开发

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
- 自定义提供商：可指向任何实现 DeepSeek Anthropic 兼容接口的端点，每条配置有自己的 Key、模型与能力开关。

## 提供商

设置 → 提供商 里维护一组 API 配置。内置的 DeepSeek 始终存在，且固定使用 DeepSeek 的 Anthropic 兼容接口（`/anthropic/v1/messages`、`/anthropic/v1/files`、`/models`），可以改成指向你自己的反向代理；新增的自定义提供商可以从两种协议里选一种：

- **DeepSeek 兼容**：Anthropic 兼容接口，支持附件、联网搜索、语音与余额。
- **OpenAI 兼容**：`POST /v1/chat/completions`，流式返回。地址填根地址或 `/v1` 地址均可，客户端会自动补全 `/v1/chat/completions`。只支持聊天：图片以 data URL 内联发送，端点返回的思考内容（`reasoning_content` 或 `reasoning`）会正常展示，联网搜索、语音与余额不可用；PDF、Word 这类文档附件无法通过该协议发送。「获取模型列表」会用 `GET /v1/models` 填充模型 ID。

每条提供商有独立的地址、API Key、模型 ID，以及附件、深度思考、联网搜索、语音、余额五个能力开关。只有开启的能力会出现在界面上，未开启的能力不会写进请求体，因此只实现了部分接口的端点也能正常聊天。会话标题由 DeepSeek 接口生成，OpenAI 兼容提供商下的对话会一直显示「新对话」，直到你手动改名。

浏览器直连端点有两条硬约束：

- 端点必须允许跨域请求。
- HTTPS 页面不能访问 `http://` 地址。本地模型请套一层 HTTPS 反向代理，或改用 HTTP 打开本页面。

## 数据

提供商配置与界面设置始终保存在浏览器 localStorage；API Key 按提供商分别保存，只会发往对应的端点。对话数据按部署方式存放：

- 静态部署：会话与附件原件保存在浏览器 IndexedDB，按浏览器用户配置和站点源（origin）隔离。
- Docker 自托管：会话与附件保存在服务端的 `/data/chat.db`，由数据卷持久化；浏览器只缓存当前页面里的状态，换浏览器或换设备访问同一实例能看到同一份对话。

两种方式下，发送消息、上传附件和使用语音功能都会把相应内容提交给配置的 API 服务。

设置中的历史导入导出使用 ZIP 格式。导入会在确认并校验成功后替换全部会话和附件；导出包含会话与可用的图片原件，不包含 API Key、设置或非图片附件原件。格式与保留范围见[历史导入导出](src/services/chat/history/README.md)。

设置 → 数据管理 → 删除所有对话，会在确认后清空全部会话、附件原件和未发送的草稿，停止正在生成的回复并回到新对话。API Key 和其他设置保留，已上传到 API 服务的文件不受影响；自托管部署下清理范围是服务器的数据库，数据卷里的数据库文件本身不会被删除。

## 开发

| 命令             | 用途                        |
| ---------------- | --------------------------- |
| `pnpm dev`       | 启动开发服务器              |
| `pnpm dev:server`| 启动内置存储服务（开发用）  |
| `pnpm build`     | 构建到 `dist/`              |
| `pnpm start`     | 运行构建产物与存储服务      |
| `pnpm type`      | TypeScript 类型检查         |
| `pnpm lint`      | oxlint 检查                 |
| `pnpm format`    | oxfmt 格式化                |

[rspack.config.ts](rspack.config.ts) 默认连接 `https://api.deepseek.com`。`createConfig({ apiOrigin, devServer })` 支持自定义 API 地址和开发服务器代理。

聊天默认使用 `deepseek-flash`，通过 Anthropic 兼容的 Messages / Files API 通信；语音使用 ASR / TTS 接口。请求使用搜索、链接阅读、标题和 `latest_reminder` 等扩展，接入服务需支持相应能力。附件实际支持的格式以服务端校验为准。

```text
server/               内置存储服务：静态资源 + 对话存储 API（实现见 server/README.md）
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

存储实现在 [src/services/chat/storage/](src/services/chat/storage/) 下：`indexeddb.ts` 是浏览器本地实现，`server.ts` 走内置存储服务，启动时探测同源是否存在 `/api/storage` 自动选择。

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
