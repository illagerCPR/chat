import { HttpError } from './errors.ts'
import {
  emptyResponse,
  errorResponse,
  jsonResponse,
  readBodyBytes,
  readJsonBody,
  readMimeType,
} from './http.ts'
import { parseFileTypesUpdate, parseId, parseSessionInput, parseTitleUpdate } from './validate.ts'
import type { ChatStore, StorageDescriptor } from '../store/types.ts'

export type RouterLimits = {
  maxSessionBytes: number
  maxFileBytes: number
}

export type RouterDeps = {
  store: ChatStore
  limits: RouterLimits
  storage: StorageDescriptor
}

const assertMethod = (method: string, allowed: readonly string[]): void => {
  if (!allowed.includes(method)) {
    throw new HttpError(405, `Method ${method} is not allowed here`)
  }
}

/** 原样回传数据库里的会话 JSON，避免多一次解析与序列化。 */
const sessionResponse = (json: string): Response =>
  new Response(json, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })

const fileResponse = (file: { mimeType: string; size: number; body: ReadableStream<Uint8Array> }) =>
  new Response(file.body, {
    status: 200,
    headers: {
      'Content-Type': file.mimeType === '' ? 'application/octet-stream' : file.mimeType,
      'Content-Length': String(file.size),
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  })

const handleRequest = async (request: Request, { store, limits, storage }: RouterDeps) => {
  const method = request.method
  const url = new URL(request.url)
  // 路径已由调用方确认以 /api 开头，这里只看后面的段
  const [, resource, first, second] = url.pathname.split('/').filter((part) => part !== '')

  if (resource === 'storage' && first === undefined) {
    assertMethod(method, ['GET'])
    return jsonResponse(200, {
      mode: 'server',
      version: 1,
      backend: storage.backend,
      dataDir: storage.dataDir,
    })
  }

  if (resource === 'sessions') {
    if (first === undefined) {
      assertMethod(method, ['GET'])
      return jsonResponse(200, { sessions: await store.listSummaries() })
    }
    const id = parseId(first)
    switch (method) {
      case 'GET': {
        const json = await store.readSession(id)
        if (json === null) {
          throw new HttpError(404, 'Session not found')
        }
        return sessionResponse(json)
      }
      case 'PUT': {
        const session = parseSessionInput(await readJsonBody(request, limits.maxSessionBytes))
        if (session.id !== id) {
          throw new HttpError(400, 'Session id in body does not match the path')
        }
        await store.writeSession(session)
        return emptyResponse(204)
      }
      case 'PATCH': {
        const title = parseTitleUpdate(await readJsonBody(request, limits.maxSessionBytes))
        if (!(await store.renameSession(id, title))) {
          throw new HttpError(404, 'Session not found')
        }
        return emptyResponse(204)
      }
      case 'DELETE': {
        await store.deleteSession(id)
        return emptyResponse(204)
      }
      default:
        assertMethod(method, ['GET', 'PUT', 'PATCH', 'DELETE'])
    }
  }

  if (resource === 'files' && first !== undefined) {
    const id = parseId(first)
    switch (method) {
      case 'GET': {
        const file = await store.readFile(id)
        if (file === null) {
          throw new HttpError(404, 'File not found')
        }
        return fileResponse(file)
      }
      case 'PUT': {
        const data = await readBodyBytes(request, limits.maxFileBytes)
        await store.writeFile({ id, mimeType: readMimeType(request), size: data.byteLength, data })
        return emptyResponse(204)
      }
      default:
        assertMethod(method, ['GET', 'PUT'])
    }
  }

  if (resource === 'staging') {
    if (first === undefined) {
      assertMethod(method, ['DELETE'])
      await store.clearStaging()
      return emptyResponse(204)
    }
    if (first === 'commit' && second === undefined) {
      assertMethod(method, ['POST'])
      return jsonResponse(200, { sessions: await store.commitStaging() })
    }
    if (first === 'file-types' && second === undefined) {
      assertMethod(method, ['PATCH'])
      await store.updateStagingFileTypes(
        parseFileTypesUpdate(await readJsonBody(request, limits.maxSessionBytes))
      )
      return emptyResponse(204)
    }
    if (first === 'sessions' && second !== undefined) {
      assertMethod(method, ['PUT'])
      const id = parseId(second)
      const session = parseSessionInput(await readJsonBody(request, limits.maxSessionBytes))
      if (session.id !== id) {
        throw new HttpError(400, 'Session id in body does not match the path')
      }
      await store.writeStagingSession(session)
      return emptyResponse(204)
    }
    if (first === 'files' && second !== undefined) {
      assertMethod(method, ['PUT'])
      const id = parseId(second)
      const data = await readBodyBytes(request, limits.maxFileBytes)
      await store.writeStagingFile({
        id,
        mimeType: readMimeType(request),
        size: data.byteLength,
        data,
      })
      return emptyResponse(204)
    }
  }

  throw new HttpError(404, 'Unknown API endpoint')
}

/**
 * 存储 API 的入口。Node 与 Cloudflare 两个入口只负责把平台请求变成
 * 标准 Request，路由、校验、错误转换都在这里，各端点只关心自己的业务分支。
 */
export const createRouter = (deps: RouterDeps) => {
  return async (request: Request): Promise<Response> => {
    try {
      return await handleRequest(request, deps)
    } catch (error) {
      return errorResponse(error)
    }
  }
}

/** 判断某个路径是否属于存储 API，两个平台的入口都用它决定谁来处理。 */
export const isApiPath = (pathname: string): boolean =>
  pathname === '/api' || pathname.startsWith('/api/')
