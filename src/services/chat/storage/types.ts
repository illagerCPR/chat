import type { Session, SessionSummary } from '../types.js'

/** 附件原件按附件的本地 id 存储，所有引用同一 id 的消息共用一份。 */
export type StoredFile = {
  id: string
  blob: Blob
}

/**
 * 对话数据的读写接口，两套实现共用：
 * - indexeddb.ts：浏览器本地存储，静态部署或没有后端时使用
 * - server.ts：自托管部署的容器内存储服务
 */
export type Storage = {
  loadSessionSummaries(): Promise<SessionSummary[]>
  loadSession(id: string): Promise<Session | undefined>
  saveSession(session: Session, files?: StoredFile[]): Promise<void>
  renameSession(id: string, title: string): Promise<void>
  deleteSession(id: string): Promise<void>
  saveFiles(files: StoredFile[]): Promise<void>
  loadFile(id: string): Promise<Blob | undefined>
  clearStaging(): Promise<void>
  /** 批量写入导入暂存的会话；空数组不发起事务。 */
  addStagingSessions(sessions: Session[]): Promise<void>
  saveStagingFiles(files: StoredFile[]): Promise<void>
  /**
   * 回填附件 MIME，保留归档中的 isImage 标识。
   * sessionIds 是引用到这些原件的暂存会话，实现可以据此只改相关行。
   */
  updateStagingFileTypes(
    types: ReadonlyMap<string, string>,
    sessionIds: ReadonlySet<string>
  ): Promise<void>
  commitStaging(): Promise<SessionSummary[]>
}
