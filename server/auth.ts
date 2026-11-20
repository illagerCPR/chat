import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ServerConfig } from './config.ts'

/** 比较摘要而不是原始字符串：长度不同也能用同一耗时比较完。 */
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest()

const safeEqual = (left: string, right: string) => timingSafeEqual(digest(left), digest(right))

/**
 * HTTP Basic Auth。浏览器在收到 401 后会弹出原生登录框，
 * 之后同源的 fetch 会自动带上凭据，前端无需额外处理。
 */
export const isAuthorized = (req: IncomingMessage, config: ServerConfig): boolean => {
  if (config.password === null) {
    return true
  }
  const header = req.headers.authorization
  if (typeof header !== 'string') {
    return false
  }
  const [scheme, credentials] = header.split(' ')
  if (scheme?.toLowerCase() !== 'basic' || !credentials) {
    return false
  }
  const decoded = Buffer.from(credentials, 'base64').toString('utf8')
  const separator = decoded.indexOf(':')
  if (separator < 0) {
    return false
  }
  const username = decoded.slice(0, separator)
  const password = decoded.slice(separator + 1)
  const userMatches = safeEqual(username, config.username)
  const passwordMatches = safeEqual(password, config.password)
  return userMatches && passwordMatches
}

/** 401 带 WWW-Authenticate，浏览器才会弹出原生登录框并缓存凭据。 */
export const sendUnauthorized = (res: ServerResponse): void => {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Aris Chat", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end('Unauthorized')
}
