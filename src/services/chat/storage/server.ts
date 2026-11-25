import type { Session, SessionSummary } from '../types.js'
import type { Storage, StoredFile } from './types.js'

export type ServerProbe = {
  /** 数据落在哪种后端：自托管容器是 sqlite，Cloudflare 部署是 d1 */
  backend: 'sqlite' | 'd1'
  /** 服务端数据库所在目录，用于在设置里提示备份位置；旧版本服务端可能不给。 */
  dataDir: string
}

/** 探测成功后固定下来的 API 前缀；探测之前不允许发起存储请求。 */
let apiBase: URL | null = null

/**
 * 依次尝试的 API 前缀：先按页面所在目录推导（反代到子路径时也命中），
 * 再退回站点根路径（页面恰好停在 SPA 回落的深层路径时兜底）。
 */
const apiCandidates = (): URL[] => {
  const candidates: URL[] = []
  const add = (path: string, base?: string) => {
    try {
      candidates.push(base === undefined ? new URL(path) : new URL(path, base))
    } catch {
      // file:// 这类没有合法 origin 的情况直接跳过
    }
  }
  add('api/', document.baseURI)
  add('/api/', location.origin)
  return candidates.filter(
    (url, index) => candidates.findIndex((other) => other.href === url.href) === index
  )
}

const probeAt = async (base: URL): Promise<ServerProbe | null> => {
  try {
    const response = await fetch(new URL('storage', base), {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    // 401 说明服务在、只是需要登录：浏览器已弹出登录框，后续请求会自动带上凭据
    if (response.status === 401) {
      return { backend: 'sqlite', dataDir: '' }
    }
    // 静态托管会把未知路径回落到入口页（200 HTML），所以必须校验响应体标识
    if (!response.ok) {
      return null
    }
    const payload = (await response.json()) as {
      mode?: unknown
      backend?: unknown
      dataDir?: unknown
    }
    if (payload.mode !== 'server') {
      return null
    }
    return {
      // 旧版本服务端没有这个字段，按自托管的 sqlite 处理
      backend: payload.backend === 'd1' ? 'd1' : 'sqlite',
      dataDir: typeof payload.dataDir === 'string' ? payload.dataDir : '',
    }
  } catch {
    return null
  }
}

/** 探测同源是否提供存储服务；命中后记住前缀供后续请求使用。 */
export const probeServer = async (): Promise<ServerProbe | null> => {
  for (const base of apiCandidates()) {
    const probe = await probeAt(base)
    if (probe !== null) {
      apiBase = base
      return probe
    }
  }
  return null
}

const apiUrl = (path: string): URL => {
  if (apiBase === null) {
    throw new Error('Storage service is not available')
  }
  return new URL(path, apiBase)
}

const send = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const response = await fetch(apiUrl(path), init)
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} failed with ${response.status}`)
  }
  return response
}

const sessionPath = (id: string) => `sessions/${encodeURIComponent(id)}`
const filePath = (id: string) => `files/${encodeURIComponent(id)}`

const putBlob = (path: string, blob: Blob) =>
  send(path, {
    method: 'PUT',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  })

const putJson = (path: string, body: string) =>
  send(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
  })

export const serverStorage: Storage = {
  loadSessionSummaries: async () => {
    const response = await send('sessions')
    const payload = (await response.json()) as { sessions?: unknown }
    return Array.isArray(payload.sessions) ? (payload.sessions as SessionSummary[]) : []
  },

  loadSession: async (id) => {
    const response = await fetch(apiUrl(sessionPath(id)))
    if (response.status === 404) {
      return undefined
    }
    if (!response.ok) {
      throw new Error(`GET ${sessionPath(id)} failed with ${response.status}`)
    }
    return (await response.json()) as Session
  },

  /** 原件先传再写会话：附件落库后会话才可见，中途失败只会留下没人引用的原件。 */
  saveSession: async (session, files = []) => {
    for (const file of files) {
      await putBlob(filePath(file.id), file.blob)
    }
    const body = JSON.stringify(session)
    await send(sessionPath(session.id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
      // 页面关闭（pagehide）时用 keepalive 兜住最后一次写入，小体积请求才在浏览器限额内
      keepalive: new TextEncoder().encode(body).byteLength < 60_000,
    })
  },

  renameSession: async (id, title) => {
    await send(sessionPath(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
  },

  deleteSession: async (id) => {
    const response = await fetch(apiUrl(sessionPath(id)), { method: 'DELETE' })
    // 已经不存在也算删除成功，与本地存储的语义一致
    if (!response.ok && response.status !== 404) {
      throw new Error(`DELETE ${sessionPath(id)} failed with ${response.status}`)
    }
  },

  saveFiles: async (files: StoredFile[]) => {
    for (const file of files) {
      await putBlob(filePath(file.id), file.blob)
    }
  },

  loadFile: async (id) => {
    const response = await fetch(apiUrl(filePath(id)))
    if (response.status === 404) {
      return undefined
    }
    if (!response.ok) {
      throw new Error(`GET ${filePath(id)} failed with ${response.status}`)
    }
    return response.blob()
  },

  clearStaging: async () => {
    await send('staging', { method: 'DELETE' })
  },

  addStagingSessions: async (sessions) => {
    for (const session of sessions) {
      await putJson(`staging/${sessionPath(session.id)}`, JSON.stringify(session))
    }
  },

  saveStagingFiles: async (files: StoredFile[]) => {
    for (const file of files) {
      await putBlob(`staging/${filePath(file.id)}`, file.blob)
    }
  },

  /** 服务端只看暂存表，本身就只在本次导入的会话里回填 MIME，不需要额外的会话范围。 */
  updateStagingFileTypes: async (types) => {
    if (types.size === 0) {
      return
    }
    await send('staging/file-types', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ types: Object.fromEntries(types) }),
    })
  },

  commitStaging: async () => {
    const response = await send('staging/commit', { method: 'POST' })
    const payload = (await response.json()) as { sessions?: unknown }
    return Array.isArray(payload.sessions) ? (payload.sessions as SessionSummary[]) : []
  },
}
