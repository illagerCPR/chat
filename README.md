# Aris Chat

English | [简体中文](README.zh-CN.md)

A chat client for the DeepSeek API. By default it is a static site with no application backend: the browser calls the configured API service directly. When self-hosting you can also run the bundled storage service, which keeps conversations in a Docker volume so they survive container rebuilds and image upgrades.

[Try it online](https://www.illageraris.dpdns.org/chat/), or serve the contents of `pnpm build` from any static host, or open `dist/index.html` locally. Enter your API key in Settings before your first chat.

## Getting started

### Option 1: static site

Serve the build output from any static host; no backend is involved. Conversations live in the browser's IndexedDB, isolated by browser profile and site origin, so clearing site data or switching browsers loses them. Use the export in Settings to keep a backup.

### Option 2: self-host with Docker (conversations in a data volume)

```sh
docker run -d --name chat -p 8080:3000 -v chat-data:/data ghcr.io/illagercpr/chat:latest
```

Open http://localhost:8080. Conversations and attachments are stored in `/data/chat.db` (SQLite) inside the container, backed by the `chat-data` volume, so they survive container rebuilds and image upgrades. Everyone who can reach the instance shares the same conversations.

The [compose.yaml](compose.yaml) in this repository does the same thing:

```sh
docker compose up -d
```

To keep the data files visible on the host instead, point `volumes` at a host directory and give it to the container's `node` user (uid 1000) first:

```sh
mkdir -p ./data && sudo chown 1000:1000 ./data
```

| Variable              | Default | Description                                    |
| --------------------- | ------- | ---------------------------------------------- |
| `PORT`                | `3000`  | Listen port                                    |
| `CHAT_DATA_DIR`       | `/data` | Directory holding the database                 |
| `CHAT_PASSWORD`       | empty   | Enables HTTP Basic Auth when set               |
| `CHAT_USERNAME`       | `chat`  | Username for Basic Auth                        |
| `CHAT_MAX_FILE_MB`    | `64`    | Maximum stored attachment size                 |
| `CHAT_MAX_SESSION_MB` | `32`    | Maximum session JSON size                      |

Basic Auth is only safe behind an HTTPS reverse proxy; over plain HTTP the credentials travel in clear text.

Backups: Settings can always export every conversation as a ZIP that any deployment can import. To back up the volume itself:

```sh
docker run --rm -v chat-data:/data -v "$PWD":/backup alpine tar -czf /backup/chat-data.tgz -C /data .
```

### Option 3: local development

Building the frontend needs Node.js 22.12+ and pnpm; running the bundled storage service needs Node.js 24+ (it uses the built-in SQLite module and runs TypeScript directly).

```sh
git clone https://github.com/illagerCPR/chat.git
cd chat
pnpm install
pnpm dev
```

Open http://localhost:8090. To use server-side storage as well, start it in another terminal:

```sh
pnpm dev:server
```

`pnpm dev` proxies `/api` to `http://127.0.0.1:3000` and data is written to `.data/chat.db`; when the service is not running the frontend falls back to browser storage automatically.

To build the static site:

```sh
pnpm build
```

The output is written to `dist/`. Deploy it to a static web server or open `dist/index.html` directly; opening the file directly requires browser support for local storage on `file://` pages.

## Features

- Multiple conversations with automatic titles, renaming, and deletion; edit prompts, regenerate replies, and switch between message branches.
- Streaming replies, deep thinking, smart search, link reading, and source citations; stop generation or continue eligible replies.
- Upload, paste, or drag and drop attachments; use voice input and read replies aloud. A live audio spectrum appears in the first row of the input area while recording on mobile.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import and export.
- Optional server-side storage: conversations and attachments persist in a SQLite data volume, with optional password protection.
- Custom providers: point the app at DeepSeek-compatible, standard Anthropic Messages, or OpenAI-compatible endpoints, with per-provider keys, models, and capability switches; web search, voice, and balance always use the official DeepSeek service, so they work on third-party endpoints too.

## Providers

Settings → Providers holds a list of API configurations. The built-in DeepSeek entry is always present, with its URL, model ID, and protocol pinned to the official configuration (`/anthropic/v1/messages`, `/anthropic/v1/files`, `/models`); only its API key and capability switches can change. Additional entries can use either protocol:

- **DeepSeek compatible** — the URL decides which Anthropic-compatible shape is used, and the editor shows the resulting request URL.
  - A site root or a path containing `/anthropic` (e.g. `https://api.deepseek.com`, `…/anthropic/v1`) uses the DeepSeek extensions: attachments work, and web search plus link reading run through DeepSeek server tools on the endpoint itself.
  - A versioned path (e.g. `https://api.example.com/provider/v1`) or a pasted full endpoint (`…/v1/messages`, `…/v1/message`) uses the standard Anthropic Messages API. Attachments are unavailable and web search falls back to the official retrieval described below.
- **OpenAI compatible** — `POST /v1/chat/completions` with streaming replies. Enter either the root URL or a `/v1` URL; `/v1/chat/completions` is filled in automatically. Chat and inline images are supported: images are sent as data URLs, and reasoning returned by the endpoint (`reasoning_content` or `reasoning`) is displayed. Web search runs through the official retrieval and its result is injected as the first `system` message; voice and balance also use the official service (see below). Document attachments (PDF, Word) cannot be sent over this protocol. **Fetch models** fills the model ID from `GET /v1/models`.

Each provider has its own base URL, API key, model ID, and capability switches for attachments, deep thinking, web search, voice, and balance. Only enabled capabilities appear in the interface, and disabled ones are left out of request bodies, so an endpoint that implements a subset of the API keeps working.

### Official capabilities

Web search, voice (input and read-aloud), and balance are served by DeepSeek itself, regardless of the provider in use — even while chatting with a third-party model, those requests still go to `api.deepseek.com` with the **official API key** at the bottom of the provider settings. Leave it empty to reuse the built-in DeepSeek key; when neither exists, the three capabilities are greyed out and their controls disappear from the input area.

On third-party endpoints (standard Anthropic and OpenAI compatible), web search runs as a pre-pass: one official retrieval request, then the results are folded into the main request as context — the `system` field for the Anthropic shape, the first `system` message for the OpenAI shape — with source cards shown as usual. A failed retrieval does not interrupt the answer; the app only notes that this round had no search results. Only DeepSeek-shaped endpoints (official, or a proxy that forwards to it) execute search themselves.

Switching a provider to a third-party endpoint turns the web search, voice, and balance switches on automatically; each of them can still be turned off in the settings.

Conversation titles are generated after the first reply: the built-in DeepSeek provider reads the `title` extension field, while other endpoints send one extra lightweight request to the current model. A failed attempt is silent — the conversation stays untitled until you rename it, and a renamed conversation is never overwritten.

Two constraints come from calling the endpoint straight from the browser:

- The endpoint must allow cross-origin requests.
- An HTTPS page cannot call an `http://` endpoint. Serve local models behind an HTTPS reverse proxy, or open the app over HTTP.

## Data and storage

Your provider settings and interface settings are always stored in the browser's localStorage. Keys are kept per provider and never sent anywhere except that provider. Where conversations live depends on how the app is deployed:

- Static site: conversations and original attachments are stored in the browser's IndexedDB, isolated by browser profile and site origin.
- Self-hosted Docker: conversations and attachments are stored in `/data/chat.db` on the server and persisted by the data volume; the browser only keeps page state, so any browser or device that reaches the instance sees the same conversations.

In both cases, sending messages, uploading attachments, and using speech features send the relevant content to the configured API service.

History import and export in Settings use ZIP archives. After confirmation and successful validation, importing replaces all conversations and attachments. Exports include conversations and locally available original images, but exclude API keys, settings, and original non-image attachments. See the [history import/export documentation (Chinese)](src/services/chat/history/README.md) for the archive format and preservation details.

Settings → Data → Delete all chats clears all conversations, original attachments, and unsent drafts after confirmation. It stops ongoing replies and returns to a new chat. Your API key and settings are preserved; files already uploaded to the API service are not deleted. When self-hosting, this clears the server database rows, not the database file inside the volume.

## Development

| Command          | Description                          |
| ---------------- | ------------------------------------ |
| `pnpm dev`       | Start the development server         |
| `pnpm dev:server`| Start the storage service (dev)      |
| `pnpm build`     | Build into `dist/`                   |
| `pnpm start`     | Run the build with the storage service |
| `pnpm type`      | Run TypeScript type checks           |
| `pnpm lint`      | Lint with oxlint                     |
| `pnpm format`    | Format with oxfmt                    |

[rspack.config.ts](rspack.config.ts) uses `https://api.deepseek.com` by default. Use `createConfig({ apiOrigin, devServer })` to customize the API origin and development server proxy.

Chat uses `deepseek-flash` by default through Anthropic-compatible Messages / Files APIs. Speech features use ASR / TTS endpoints. Requests include extensions for search, link reading, titles, and `latest_reminder`, so the configured service must support the corresponding capabilities. Supported attachment formats are determined by server-side validation.

```text
server/               Bundled storage service: static assets + conversation storage API
src/
  app/                Application layout, themes, and global styles
  components/         Chat, settings, Markdown, and other UI components
  i18n/               English and Chinese translations
  services/
    api/              API requests, SSE, and protocol types
    chat/             Conversations, message branches, storage backends, history import/export
    markdown/         Markdown parsing, syntax highlighting, and diagrams
    speech/           Audio recording and read-aloud playback
  utils/              Shared utilities
```

Storage backends live in [src/services/chat/storage/](src/services/chat/storage/): `indexeddb.ts` is the browser implementation and `server.ts` talks to the bundled service. On startup the app probes `/api/storage` on the same origin and picks one automatically.

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
