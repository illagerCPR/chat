import { isAuthorized, type AuthConfig } from '../server/core/auth.ts'
import { unauthorizedResponse } from '../server/core/http.ts'
import { createRouter, isApiPath } from '../server/core/router.ts'
import { D1ChatStore } from '../server/store/d1.ts'

/** 与 wrangler.jsonc 的绑定一一对应。 */
export type Env = {
  DB: D1Database
  BUCKET: R2Bucket
  ASSETS: Fetcher
  /** 设置后对 /api/* 启用 Basic Auth；留空则不做访问控制 */
  CHAT_PASSWORD?: string
  CHAT_USERNAME?: string
  CHAT_MAX_FILE_MB?: string
  CHAT_MAX_SESSION_MB?: string
}

const MB = 1024 * 1024

const positiveNumber = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') {
    return fallback
  }
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Cloudflare 入口：静态资源由 Static Assets 直接伺服（只有 /api/* 进 Worker），
 * 存储接口复用 server/core 里与自托管完全相同的路由，差别只在 D1/R2 这个实现。
 *
 * D1 单行上限 2 MB，会话正文默认限制到 1.9 MB，留出列与元数据的余量；
 * 附件放 R2，受 Worker 的 128 MB 内存约束，默认限制到 25 MB。
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (!isApiPath(url.pathname)) {
      return env.ASSETS.fetch(request)
    }

    const password = env.CHAT_PASSWORD?.trim() ?? ''
    const auth: AuthConfig | null =
      password === '' ? null : { username: env.CHAT_USERNAME?.trim() || 'chat', password }
    if (!(await isAuthorized(request, auth))) {
      return unauthorizedResponse()
    }

    const router = createRouter({
      store: new D1ChatStore(env.DB, env.BUCKET),
      limits: {
        maxSessionBytes: positiveNumber(env.CHAT_MAX_SESSION_MB, 1.9) * MB,
        maxFileBytes: positiveNumber(env.CHAT_MAX_FILE_MB, 25) * MB,
      },
      storage: { backend: 'd1', dataDir: '' },
    })
    return router(request)
  },
}
