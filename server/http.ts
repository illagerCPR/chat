import type { IncomingMessage, ServerResponse } from 'node:http'

/** 可预期的请求错误：状态码会原样回给客户端，其余错误统一按 500 处理。 */
export class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

const JSON_TYPE = 'application/json; charset=utf-8'

export const sendJson = (res: ServerResponse, status: number, value: unknown): void => {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'Content-Type': JSON_TYPE,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

export const sendEmpty = (res: ServerResponse, status: number): void => {
  res.writeHead(status, { 'Cache-Control': 'no-store' })
  res.end()
}

/** 错误响应只对外暴露状态码与简短原因；未预期错误写进日志，内容不外泄。 */
export const sendError = (res: ServerResponse, error: unknown): void => {
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: { message: error.message } })
    return
  }
  console.error('[chat] request failed', error)
  sendJson(res, 500, { error: { message: 'Internal server error' } })
}

/**
 * 读取完整请求体并限制大小。先看 Content-Length 快速拒绝，
 * 分块到达时再累计判断，避免超限请求占满内存。
 */
export const readBody = async (req: IncomingMessage, limit: number): Promise<Buffer> => {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) {
    req.resume()
    throw new HttpError(413, `Request body exceeds ${limit} bytes`)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > limit) {
      throw new HttpError(413, `Request body exceeds ${limit} bytes`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

export const readJson = async (req: IncomingMessage, limit: number): Promise<unknown> => {
  const body = await readBody(req, limit)
  if (body.length === 0) {
    throw new HttpError(400, 'Request body is empty')
  }
  try {
    return JSON.parse(body.toString('utf8')) as unknown
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON')
  }
}

/** 归档导入的 id 来自外部文件，只接受能安全放进 URL 与数据库键的片段。 */
const ID_PATTERN = /^[^/\\]{1,255}$/

const hasControlCharacter = (value: string): boolean => {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) {
      return true
    }
  }
  return false
}

export const parseId = (segment: string | undefined): string => {
  if (segment === undefined || segment === '') {
    throw new HttpError(400, 'Missing resource id')
  }
  let id: string
  try {
    id = decodeURIComponent(segment)
  } catch {
    throw new HttpError(400, 'Malformed resource id')
  }
  if (!ID_PATTERN.test(id) || id === '.' || id === '..' || hasControlCharacter(id)) {
    throw new HttpError(400, 'Invalid resource id')
  }
  return id
}
