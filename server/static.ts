import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
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

/**
 * 静态资源服务，行为对齐原来的 nginx 配置：
 * /static/ 下缺失直接 404 并长期缓存，其余未知路径回落到入口页，文本资源按需 gzip。
 */
export const createStaticHandler = (distDir: string) => {
  const root = path.resolve(distDir)
  const gzipCache = new Map<string, Buffer>()

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' })
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    let pathname: string
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Malformed URL')
      return
    }
    if (pathname.includes('\0')) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Malformed URL')
      return
    }

    const isStatic = pathname.startsWith('/static/')
    const target = path.resolve(root, pathname.replace(/^\/+/, ''))
    if (target !== root && !target.startsWith(root + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Forbidden')
      return
    }

    let file = target
    if (!(await isFile(file))) {
      if (isStatic) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Not found')
        return
      }
      file = path.join(root, 'index.html')
      if (!(await isFile(file))) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Application assets are missing; run the build first')
        return
      }
    }

    let body: Buffer
    try {
      body = await readFile(file)
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Failed to read asset')
      return
    }

    const mime = MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
    const cacheControl = isStatic ? IMMUTABLE_CACHE : 'no-cache'
    const headers: Record<string, string | number> = {
      'Content-Type': mime,
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
    }

    const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')
    if (acceptsGzip && body.length >= 1024 && COMPRESSIBLE.test(mime)) {
      let compressed = gzipCache.get(file)
      if (compressed === undefined) {
        compressed = gzipSync(body)
        gzipCache.set(file, compressed)
      }
      body = compressed
      headers['Content-Encoding'] = 'gzip'
      headers['Vary'] = 'Accept-Encoding'
    }

    headers['Content-Length'] = body.length
    res.writeHead(200, headers)
    if (method === 'HEAD') {
      res.end()
      return
    }
    res.end(body)
  }
}
