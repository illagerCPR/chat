import type { IncomingMessage, ServerResponse } from 'node:http'
import { HttpError } from '../core/errors.ts'

const READABLE_METHODS = new Set(['GET', 'HEAD'])

const headersToObject = (headers: IncomingMessage['headers']): Headers => {
  const result = new Headers()
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue
    }
    result.set(key, Array.isArray(value) ? value.join(', ') : value)
  }
  return result
}

/** 把请求体读成字节数组；超限时立刻停下，不让超限请求占满内存。 */
const readRawBody = async (req: IncomingMessage, limit: number): Promise<Uint8Array> => {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) {
    req.resume()
    throw new HttpError(413, `Request body exceeds ${limit} bytes`)
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBufferLike)
    size += buffer.byteLength
    if (size > limit) {
      req.destroy()
      throw new HttpError(413, `Request body exceeds ${limit} bytes`)
    }
    chunks.push(buffer)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/**
 * 把 Node 的请求对象转成标准 Request，让平台无关的路由与静态服务
 * 只看见 Web 标准接口。请求体在这里读完：Node 侧的缓存本来就是整体的，
 * 上层按各自的上限再复核一次长度。
 */
export const toRequest = async (req: IncomingMessage, maxBodyBytes: number): Promise<Request> => {
  const method = (req.method ?? 'GET').toUpperCase()
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const headers = headersToObject(req.headers)
  const body = READABLE_METHODS.has(method) ? undefined : await readRawBody(req, maxBodyBytes)
  return new Request(url, { method, headers, body })
}

/** 把标准 Response 写回 Node 的响应对象；body 统一缓冲，与原有行为一致。 */
export const writeResponse = async (res: ServerResponse, response: Response): Promise<void> => {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })
  const body = response.body === null ? null : new Uint8Array(await response.arrayBuffer())
  if (body !== null && headers['content-length'] === undefined) {
    headers['content-length'] = String(body.byteLength)
  }
  res.writeHead(response.status, headers)
  res.end(body ?? undefined)
}
