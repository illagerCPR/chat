import type { SessionInput } from '../core/validate.ts'

export type { SessionInput }

/** 与前端 SessionSummary 同构；服务端只回传列表需要的元信息。 */
export type SessionSummary = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export type FileInput = {
  id: string
  mimeType: string
  size: number
  data: Uint8Array
}

/**
 * 附件原件的读取结果。body 用流而不是字节数组：Cloudflare 上 R2 对象可以是
 * 几十 MB，整体缓冲会顶到 isolate 的内存上限，流式转发才是正解。
 */
export type StoredFileBody = {
  mimeType: string
  size: number
  body: ReadableStream<Uint8Array>
}

/** 探测端点回报给前端的后端标识，设置页据此显示数据落点。 */
export type StorageDescriptor = {
  backend: 'sqlite' | 'd1'
  /** sqlite 后端是数据库目录，d1 后端为空串（数据在 Cloudflare 账号里） */
  dataDir: string
}

/**
 * 会话与附件的读写接口，两套平台各实现一份：
 * - sqlite.ts：自托管容器的 node:sqlite
 * - d1.ts：Cloudflare 的 D1 + R2
 *
 * 所有方法都是异步的：D1 天生异步，SQLite 侧只是把同步调用包一层。
 * 需要「要么全成要么全不成」的路径由实现内部保证（SQLite 用事务，D1 用 batch）。
 */
export type ChatStore = {
  listSummaries(): Promise<SessionSummary[]>
  readSession(id: string): Promise<string | null>
  writeSession(session: SessionInput): Promise<void>
  /** 返回 false 表示会话不存在 */
  renameSession(id: string, title: string): Promise<boolean>
  deleteSession(id: string): Promise<void>
  writeFile(file: FileInput): Promise<void>
  readFile(id: string): Promise<StoredFileBody | null>
  writeStagingSession(session: SessionInput): Promise<void>
  writeStagingFile(file: FileInput): Promise<void>
  updateStagingFileTypes(types: ReadonlyMap<string, string>): Promise<void>
  clearStaging(): Promise<void>
  commitStaging(): Promise<SessionSummary[]>
  /** 释放资源；D1 侧无所事事 */
  close(): Promise<void>
}
