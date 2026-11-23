/** 访问控制配置：password 为 null 时不做鉴权。 */
export type AuthConfig = {
  username: string
  password: string
}

const encoder = new TextEncoder()

/** 比较摘要而不是原始字符串：长度不同也能用同一耗时比较完。 */
const digest = async (value: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))

const safeEqual = async (left: string, right: string): Promise<boolean> => {
  const [a, b] = await Promise.all([digest(left), digest(right)])
  let diff = 0
  for (let index = 0; index < a.length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0)
  }
  return diff === 0
}

const decodeBase64 = (value: string): string | null => {
  try {
    // atob 只认标准 base64，浏览器与 Workers 里都有；Node 24 也有全局实现
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

/**
 * HTTP Basic Auth。浏览器在收到 401 后会弹出原生登录框，
 * 之后同源的 fetch 会自动带上凭据，前端无需额外处理。
 *
 * 这里只做凭据校验，放不放行由调用方决定：Cloudflare Access 之类的
 * 上游网关会在 Worker 之前先行拦截，两者叠加时这里仍是最后一道兜底。
 */
export const isAuthorized = async (
  request: Request,
  auth: AuthConfig | null
): Promise<boolean> => {
  if (auth === null) {
    return true
  }
  const header = request.headers.get('authorization')
  if (header === null) {
    return false
  }
  const [scheme, credentials] = header.split(' ')
  if (scheme?.toLowerCase() !== 'basic' || !credentials) {
    return false
  }
  const decoded = decodeBase64(credentials)
  if (decoded === null) {
    return false
  }
  const separator = decoded.indexOf(':')
  if (separator < 0) {
    return false
  }
  const username = decoded.slice(0, separator)
  const password = decoded.slice(separator + 1)
  const [userMatches, passwordMatches] = await Promise.all([
    safeEqual(username, auth.username),
    safeEqual(password, auth.password),
  ])
  return userMatches && passwordMatches
}
