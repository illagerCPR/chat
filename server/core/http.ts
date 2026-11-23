import { HttpError } from './errors.ts'

const JSON_TYPE = 'application/json; charset=utf-8'
const NO_STORE = 'no-store'

/** 存储服务只回数据，任何响应都不该被中间层缓存。 */
export const jsonResponse = (status: number, value: unknown): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': NO_STORE },
  })

export const emptyResponse = (status: number): Response =>
  new Response(null, { status, headers: { 'Cache-Control': NO_STORE } })

/** 错误响应只对外暴露状态码与简短原因；未预期错误写进日志，内容不外泄。 */
export const errorResponse = (error: unknown): Response => {
  if (error instanceof HttpError) {
    return jsonResponse(error.status, { error: { message: error.message } })
  }
  console.error('[chat] request failed', error)
  return jsonResponse(500, { error: { message: 'Internal server error' } })
}

/** 401 带 WWW-Authenticate，浏览器才会弹出原生登录框并缓存凭据。 */
export const unauthorizedResponse = (): Response =>
  new Response('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Aris Chat", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': NO_STORE,
    },
  })

/**
 * 读取完整请求体并限制大小。先看 Content-Length 快速拒绝，
 * 读到之后再按实际长度复核，避免超限请求占满内存。
 */
export const readBodyBytes = async (request: Request, limit: number): Promise<Uint8Array> => {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    await request.body?.cancel()
    throw new HttpError(413, `Request body exceeds ${limit} bytes`)
  }
  const buffer = await request.arrayBuffer()
  if (buffer.byteLength > limit) {
    throw new HttpError(413, `Request body exceeds ${limit} bytes`)
  }
  return new Uint8Array(buffer)
}

export const readJsonBody = async (request: Request, limit: number): Promise<unknown> => {
  const body = await readBodyBytes(request, limit)
  if (body.byteLength === 0) {
    throw new HttpError(400, 'Request body is empty')
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON')
  }
}

/** Content-Type 可能带 charset 等参数，只保留 MIME 本身。 */
export const readMimeType = (request: Request): string => {
  const header = request.headers.get('content-type')
  if (header === null) {
    return 'application/octet-stream'
  }
  const [mime] = header.split(';')
  return mime && mime.trim() !== '' ? mime.trim() : 'application/octet-stream'
}

/** 把字节数组包成单块流，让「流式响应」这条路径对上层的形状一致。 */
export const bytesToStream = (data: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data)
      controller.close()
    },
  })
