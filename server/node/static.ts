import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

/** 构建产物里的扩展名有限，表外的一律按二进制流返回。 */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
}

const COMPRESSIBLE =
  /^(?:text\/|application\/(?:javascript|json|xml|manifest\+json)|image\/svg\+xml)/

/** 与构建时的哈希文件名配套，静态资源可以长期缓存 */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'

const isFile = async (target: string): Promise<boolean> => {
  try {
    return (await stat(target)).isFile()
  } catch {
    return false
  }
}

const textResponse = (status: number, message: string, headers: Record<string, string> = {}) =>
  new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers },
  })

/**
 * 静态资源服务，行为对齐原来的 nginx 配置：
 * /static/ 下缺失直接 404 并长期缓存，其余未知路径回落到入口页，文本资源按需 gzip。
 *
 * Cloudflare 版不需要这段：那边的 Static Assets 由平台伺服，这里只服务自托管。
 */
export const createStaticHandler = (distDir: string) => {
  const root = path.resolve(distDir)
  const gzipCache = new Map<string, Uint8Array>()

  return async (request: Request): Promise<Response> => {
    const method = request.method
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
    }

    const url = new URL(request.url)
    let pathname: string
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      return textResponse(400, 'Malformed URL')
    }
    if (pathname.includes('\0')) {
      return textResponse(400, 'Malformed URL')
    }

    const isStatic = pathname.startsWith('/static/')
    const target = path.resolve(root, pathname.replace(/^\/+/, ''))
    if (target !== root && !target.startsWith(root + path.sep)) {
      return textResponse(403, 'Forbidden')
    }

    let file = target
    if (!(await isFile(file))) {
      if (isStatic) {
        return textResponse(404, 'Not found')
      }
      file = path.join(root, 'index.html')
      if (!(await isFile(file))) {
        return textResponse(500, 'Application assets are missing; run the build first')
      }
    }

    let body: Uint8Array
    try {
      body = await readFile(file)
    } catch {
      return textResponse(500, 'Failed to read asset')
    }

    const mime = MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
    const cacheControl = isStatic ? IMMUTABLE_CACHE : 'no-cache'
    const headers: Record<string, string> = {
      'Content-Type': mime,
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
    }

    const acceptsGzip = /\bgzip\b/.test(request.headers.get('accept-encoding') ?? '')
    if (acceptsGzip && body.byteLength >= 1024 && COMPRESSIBLE.test(mime)) {
      let compressed = gzipCache.get(file)
      if (compressed === undefined) {
        compressed = gzipSync(body)
        gzipCache.set(file, compressed)
      }
      body = compressed
      headers['Content-Encoding'] = 'gzip'
      headers['Vary'] = 'Accept-Encoding'
    }

    headers['Content-Length'] = String(body.byteLength)
    return new Response(method === 'HEAD' ? null : body, { status: 200, headers })
  }
}
