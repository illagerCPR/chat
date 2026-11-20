import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { createApiHandler } from './api.ts'
import { isAuthorized, sendUnauthorized } from './auth.ts'
import { loadConfig } from './config.ts'
import { openDatabase } from './db.ts'
import { createStaticHandler } from './static.ts'
import { ChatStore } from './store.ts'

const config = loadConfig()

let store: ChatStore
try {
  store = new ChatStore(openDatabase(config.dataDir))
} catch (error) {
  console.error(`[chat] cannot open database in ${config.dataDir}`, error)
  process.exit(1)
}

if (!existsSync(path.join(config.distDir, 'index.html'))) {
  console.warn(
    `[chat] ${config.distDir}/index.html is missing; run "pnpm build" or set CHAT_DIST_DIR`
  )
}

const handleApi = createApiHandler({ store, config })
const handleStatic = createStaticHandler(config.distDir)

const server = createServer((req, res) => {
  // 访问控制在分发处统一处理：先登录再拿页面，之后同源请求自动带上凭据
  if (!isAuthorized(req, config)) {
    sendUnauthorized(res)
    return
  }
  const url = req.url ?? '/'
  if (url === '/api' || url.startsWith('/api/') || url.startsWith('/api?')) {
    void handleApi(req, res)
    return
  }
  void handleStatic(req, res).catch((error: unknown) => {
    console.error('[chat] static request failed', error)
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    }
    res.end()
  })
})

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[chat] port ${config.port} is already in use`)
  } else {
    console.error('[chat] server error', error)
  }
  process.exit(1)
})

server.listen(config.port, config.host, () => {
  console.log(`[chat] listening on http://${config.host}:${config.port}`)
  console.log(`[chat] storage: ${path.join(config.dataDir, 'chat.db')}`)
  console.log(`[chat] static: ${config.distDir}`)
  console.log(
    `[chat] access control: ${config.password === null ? 'disabled' : `Basic Auth (user "${config.username}")`}`
  )
})

let closing = false
const shutdown = (signal: string): void => {
  if (closing) {
    return
  }
  closing = true
  console.log(`[chat] ${signal} received, shutting down`)
  server.close(() => {
    store.close()
    process.exit(0)
  })
  // 有长连接迟迟不关时别把容器卡在停止状态
  setTimeout(() => process.exit(0), 5000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
