import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import path from 'node:path'
import { isAuthorized } from '../core/auth.ts'
import { errorResponse, unauthorizedResponse } from '../core/http.ts'
import { createRouter, isApiPath } from '../core/router.ts'
import type { ChatStore } from '../store/types.ts'
import { toRequest, writeResponse } from './bridge.ts'
import type { ServerConfig } from './config.ts'
import { createStaticHandler } from './static.ts'

/**
 * 自托管入口：一个 Node 进程同时伺服 dist/ 与存储 API。
 * 与 Cloudflare 版共享 server/core 里的路由与校验，差别只在存储实现与入口。
 */
export const startServer = (config: ServerConfig, store: ChatStore): void => {
  if (!existsSync(path.join(config.distDir, 'index.html'))) {
    console.warn(
      `[chat] ${config.distDir}/index.html is missing; run "pnpm build" or set CHAT_DIST_DIR`
    )
  }

  const router = createRouter({
    store,
    limits: config.limits,
    storage: { backend: 'sqlite', dataDir: config.dataDir },
  })
  const handleStatic = createStaticHandler(config.distDir)
  // 入口只做粗筛，具体端点的上限交给路由：这里先挡住显然超标的请求
  const maxBodyBytes = Math.max(config.limits.maxFileBytes, config.limits.maxSessionBytes)

  const handle = async (req: IncomingMessage) => {
    try {
      const request = await toRequest(req, maxBodyBytes)
      // 访问控制在分发处统一处理：先登录再拿页面，之后同源请求自动带上凭据
      if (!(await isAuthorized(request, config.auth))) {
        return unauthorizedResponse()
      }
      return isApiPath(new URL(request.url).pathname)
        ? await router(request)
        : await handleStatic(request)
    } catch (error) {
      return errorResponse(error)
    }
  }

  const server = createServer((req, res) => {
    void handle(req)
      .then((response) => writeResponse(res, response))
      .catch((error: unknown) => {
        console.error('[chat] request failed', error)
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
      `[chat] access control: ${config.auth === null ? 'disabled' : `Basic Auth (user "${config.auth.username}")`}`
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
      void store.close().finally(() => process.exit(0))
    })
    // 有长连接迟迟不关时别把容器卡在停止状态
    setTimeout(() => process.exit(0), 5000).unref()
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}
