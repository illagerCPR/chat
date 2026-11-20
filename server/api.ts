import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ServerConfig } from './config.ts'
import { HttpError, parseId, readBody, readJson, sendEmpty, sendError, sendJson } from './http.ts'
import {
  parseFileTypesUpdate,
  parseSessionInput,
  parseTitleUpdate,
  type ChatStore,
} from './store.ts'

export type ApiOptions = {
  store: ChatStore
  config: ServerConfig
}

const assertMethod = (method: string, allowed: readonly string[]): void => {
  if (!allowed.includes(method)) {
    throw new HttpError(405, `Method ${method} is not allowed here`)
  }
}

/** 原样回传数据库里的会话 JSON，避免多一次解析与序列化。 */
const sendSessionJson = (res: ServerResponse, json: string): void => {
  const body = Buffer.from(json, 'utf8')
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/** Content-Type 可能带 charset 等参数，只保留 MIME 本身。 */
const readMimeType = (req: IncomingMessage): string => {
  const header = req.headers['content-type']
  if (typeof header !== 'string') {
    return 'application/octet-stream'
  }
  const [mime] = header.split(';')
  return mime && mime.trim() !== '' ? mime.trim() : 'application/octet-stream'
}

const handleRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
  { store, config }: ApiOptions
): Promise<void> => {
  const method = req.method ?? 'GET'
  const url = new URL(req.url ?? '/', 'http://localhost')
  // 路径已由调用方确认以 /api 开头，这里只看后面的段
  const [, resource, first, second] = url.pathname.split('/').filter((part) => part !== '')

  if (resource === 'storage' && first === undefined) {
    assertMethod(method, ['GET'])
    // dataDir 给设置页提示数据卷位置，便于备份
    sendJson(res, 200, { mode: 'server', version: 1, dataDir: config.dataDir })
    return
  }

  if (resource === 'sessions') {
    if (first === undefined) {
      assertMethod(method, ['GET'])
      sendJson(res, 200, { sessions: store.listSummaries() })
      return
    }
    const id = parseId(first)
    switch (method) {
      case 'GET': {
        const json = store.readSession(id)
        if (json === null) {
          throw new HttpError(404, 'Session not found')
        }
        sendSessionJson(res, json)
        return
      }
      case 'PUT': {
        const session = parseSessionInput(await readJson(req, config.maxSessionBytes))
        if (session.id !== id) {
          throw new HttpError(400, 'Session id in body does not match the path')
        }
        store.writeSession(session)
        sendEmpty(res, 204)
        return
      }
      case 'PATCH': {
        const title = parseTitleUpdate(await readJson(req, config.maxSessionBytes))
        if (!store.renameSession(id, title)) {
          throw new HttpError(404, 'Session not found')
        }
        sendEmpty(res, 204)
        return
      }
      case 'DELETE': {
        store.deleteSession(id)
        sendEmpty(res, 204)
        return
      }
      default:
        assertMethod(method, ['GET', 'PUT', 'PATCH', 'DELETE'])
    }
  }

  if (resource === 'files' && first !== undefined) {
    const id = parseId(first)
    switch (method) {
      case 'GET': {
        const file = store.readFile(id)
        if (file === null) {
          throw new HttpError(404, 'File not found')
        }
        res.writeHead(200, {
          'Content-Type': file.mimeType === '' ? 'application/octet-stream' : file.mimeType,
          'Content-Length': file.data.byteLength,
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
        })
        res.end(file.data)
        return
      }
      case 'PUT': {
        const data = await readBody(req, config.maxFileBytes)
        store.writeFile({ id, mimeType: readMimeType(req), data })
        sendEmpty(res, 204)
        return
      }
      default:
        assertMethod(method, ['GET', 'PUT'])
    }
  }

  if (resource === 'staging') {
    if (first === undefined) {
      assertMethod(method, ['DELETE'])
      store.clearStaging()
      sendEmpty(res, 204)
      return
    }
    if (first === 'commit' && second === undefined) {
      assertMethod(method, ['POST'])
      sendJson(res, 200, { sessions: store.commitStaging() })
      return
    }
    if (first === 'file-types' && second === undefined) {
      assertMethod(method, ['PATCH'])
      store.updateStagingFileTypes(
        parseFileTypesUpdate(await readJson(req, config.maxSessionBytes))
      )
      sendEmpty(res, 204)
      return
    }
    if (first === 'sessions' && second !== undefined) {
      assertMethod(method, ['PUT'])
      const id = parseId(second)
      const session = parseSessionInput(await readJson(req, config.maxSessionBytes))
      if (session.id !== id) {
        throw new HttpError(400, 'Session id in body does not match the path')
      }
      store.writeStagingSession(session)
      sendEmpty(res, 204)
      return
    }
    if (first === 'files' && second !== undefined) {
      assertMethod(method, ['PUT'])
      const id = parseId(second)
      store.writeStagingFile({
        id,
        mimeType: readMimeType(req),
        data: await readBody(req, config.maxFileBytes),
      })
      sendEmpty(res, 204)
      return
    }
  }

  throw new HttpError(404, 'Unknown API endpoint')
}

/**
 * 存储 API 的入口。访问控制、请求体读取与错误转换都在调用方与本文件统一处理，
 * 各端点只关心自己的业务分支。
 */
export const createApiHandler =
  (options: ApiOptions) =>
  async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await handleRequest(req, res, options)
    } catch (error) {
      if (res.headersSent) {
        res.end()
        return
      }
      sendError(res, error)
    }
  }
