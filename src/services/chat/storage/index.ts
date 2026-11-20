import type { Session, SessionSummary } from '../types.js'
import { indexedDbStorage } from './indexeddb.js'
import { probeServer, serverStorage } from './server.js'
import type { Storage, StoredFile } from './types.js'

export type StorageMode = 'server' | 'indexeddb'

export type StorageInfo = {
  mode: StorageMode
  /** 仅 server 模式：服务端数据库所在目录，可能为空字符串 */
  dataDir?: string
}

type Resolved = {
  info: StorageInfo
  storage: Storage
}

let resolved: Promise<Resolved> | null = null

/** 同源有存储服务就用服务端，没有就退回浏览器本地；结果只探测一次。 */
const resolve = async (): Promise<Resolved> => {
  const server = await probeServer()
  if (server === null) {
    return { info: { mode: 'indexeddb' }, storage: indexedDbStorage }
  }
  return { info: { mode: 'server', dataDir: server.dataDir }, storage: serverStorage }
}

const getResolved = () => (resolved ??= resolve())

export const getStorageInfo = async (): Promise<StorageInfo> => (await getResolved()).info

const getStorage = async (): Promise<Storage> => (await getResolved()).storage

// 下面这些函数保持原 db.ts 的签名，业务代码不需要知道数据来自哪里。
export const loadSessionSummaries = async (): Promise<SessionSummary[]> =>
  (await getStorage()).loadSessionSummaries()

export const loadSession = async (id: string): Promise<Session | undefined> =>
  (await getStorage()).loadSession(id)

export const saveSession = async (session: Session, files?: StoredFile[]): Promise<void> =>
  (await getStorage()).saveSession(session, files)

export const renameSession = async (id: string, title: string): Promise<void> =>
  (await getStorage()).renameSession(id, title)

export const deleteSession = async (id: string): Promise<void> =>
  (await getStorage()).deleteSession(id)

export const saveFiles = async (files: StoredFile[]): Promise<void> =>
  (await getStorage()).saveFiles(files)

export const loadFile = async (id: string): Promise<Blob | undefined> =>
  (await getStorage()).loadFile(id)

export const clearStaging = async (): Promise<void> => (await getStorage()).clearStaging()

export const addStagingSession = async (session: Session): Promise<void> =>
  (await getStorage()).addStagingSession(session)

export const saveStagingFiles = async (files: StoredFile[]): Promise<void> =>
  (await getStorage()).saveStagingFiles(files)

export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> =>
  (await getStorage()).updateStagingFileTypes(types)

export const commitStaging = async (): Promise<SessionSummary[]> =>
  (await getStorage()).commitStaging()

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  console.error(`[storage] ${action} failed`, error)
}
