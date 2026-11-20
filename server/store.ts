import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { HttpError } from './http.ts'

/** 与前端 SessionSummary 同构；服务端只回传列表需要的元信息。 */
export type SessionSummary = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

/** 一次会话写入需要的列，JSON 原样保存，附件引用单独建边。 */
export type SessionInput = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  json: string
  fileIds: string[]
}

export type FileInput = {
  id: string
  mimeType: string
  data: Uint8Array
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/**
 * 校验会话 JSON 的骨架：正文由前端与历史导入共同保证，
 * 这里只挡住会让数据库列或列表出现废数据的情况。
 */
export const parseSessionInput = (value: unknown): SessionInput => {
  if (!isRecord(value)) {
    throw new HttpError(400, 'Session must be a JSON object')
  }
  const { id, title, createdAt, updatedAt, messages } = value
  if (typeof id !== 'string' || id === '') {
    throw new HttpError(400, 'Session id is missing')
  }
  if (typeof title !== 'string') {
    throw new HttpError(400, 'Session title must be a string')
  }
  if (!isTimestamp(createdAt) || !isTimestamp(updatedAt)) {
    throw new HttpError(400, 'Session timestamps must be finite numbers')
  }
  if (!Array.isArray(messages)) {
    throw new HttpError(400, 'Session messages must be an array')
  }
  const fileIds = new Set<string>()
  for (const message of messages) {
    if (!isRecord(message) || message.role !== 'user' || !Array.isArray(message.files)) {
      continue
    }
    for (const file of message.files) {
      if (isRecord(file) && typeof file.id === 'string' && file.id !== '') {
        fileIds.add(file.id)
      }
    }
  }
  return { id, title, createdAt, updatedAt, json: JSON.stringify(value), fileIds: [...fileIds] }
}

export const parseTitleUpdate = (value: unknown): string => {
  if (!isRecord(value) || typeof value.title !== 'string') {
    throw new HttpError(400, 'Rename request must contain a title string')
  }
  return value.title
}

export const parseFileTypesUpdate = (value: unknown): Map<string, string> => {
  if (!isRecord(value) || !isRecord(value.types)) {
    throw new HttpError(400, 'File type update must contain a types object')
  }
  const types = new Map<string, string>()
  for (const [id, type] of Object.entries(value.types)) {
    if (typeof type !== 'string') {
      throw new HttpError(400, `File type for ${id} must be a string`)
    }
    types.set(id, type)
  }
  return types
}

/** 会话正文里每处附件引用都换成本次识别出的 MIME；导入时补全图片类型用。 */
const retypeStagingSession = (json: string, types: Map<string, string>): string | null => {
  const session = JSON.parse(json) as unknown
  if (!isRecord(session) || !Array.isArray(session.messages)) {
    return null
  }
  let changed = false
  for (const message of session.messages) {
    if (!isRecord(message) || message.role !== 'user' || !Array.isArray(message.files)) {
      continue
    }
    for (const file of message.files) {
      if (!isRecord(file) || typeof file.id !== 'string') {
        continue
      }
      const type = types.get(file.id) ?? ''
      if (file.mimeType !== type) {
        file.mimeType = type
        changed = true
      }
    }
  }
  return changed ? JSON.stringify(session) : null
}

type Statements = {
  listSummaries: StatementSync
  readSession: StatementSync
  upsertSession: StatementSync
  updateTitle: StatementSync
  deleteSession: StatementSync
  deleteSessionFiles: StatementSync
  insertSessionFile: StatementSync
  gcFiles: StatementSync
  writeFile: StatementSync
  readFile: StatementSync
  listStagingSummaries: StatementSync
  listStagingSessions: StatementSync
  upsertStagingSession: StatementSync
  updateStagingSession: StatementSync
  deleteStagingSessionFiles: StatementSync
  insertStagingSessionFile: StatementSync
  writeStagingFile: StatementSync
  clearStagingSessions: StatementSync
  clearStagingFiles: StatementSync
  clearStagingSessionFiles: StatementSync
}

/**
 * 会话与附件的读写。所有写操作走同步 API，Node 单线程下天然串行；
 * 需要「要么全成要么全不成」的路径包在事务里。
 */
export class ChatStore {
  private readonly db: DatabaseSync
  private readonly stmts: Statements

  constructor(db: DatabaseSync) {
    this.db = db
    const prepare = (sql: string) => db.prepare(sql)
    this.stmts = {
      listSummaries: prepare(
        'SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM sessions ORDER BY updated_at DESC'
      ),
      readSession: prepare('SELECT data FROM sessions WHERE id = ?'),
      upsertSession: prepare(
        `INSERT INTO sessions (id, title, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           title = excluded.title,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           data = excluded.data`
      ),
      updateTitle: prepare('UPDATE sessions SET title = ?, data = ? WHERE id = ?'),
      deleteSession: prepare('DELETE FROM sessions WHERE id = ?'),
      deleteSessionFiles: prepare('DELETE FROM session_files WHERE session_id = ?'),
      insertSessionFile: prepare(
        'INSERT OR IGNORE INTO session_files (session_id, file_id) VALUES (?, ?)'
      ),
      gcFiles: prepare('DELETE FROM files WHERE id NOT IN (SELECT file_id FROM session_files)'),
      writeFile: prepare(
        `INSERT INTO files (id, mime_type, size, data) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           mime_type = excluded.mime_type,
           size = excluded.size,
           data = excluded.data`
      ),
      readFile: prepare('SELECT mime_type AS mimeType, data FROM files WHERE id = ?'),
      listStagingSummaries: prepare(
        'SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM staging_sessions ORDER BY updated_at DESC'
      ),
      listStagingSessions: prepare('SELECT id, data FROM staging_sessions'),
      upsertStagingSession: prepare(
        `INSERT INTO staging_sessions (id, title, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           title = excluded.title,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           data = excluded.data`
      ),
      updateStagingSession: prepare('UPDATE staging_sessions SET data = ? WHERE id = ?'),
      deleteStagingSessionFiles: prepare('DELETE FROM staging_session_files WHERE session_id = ?'),
      insertStagingSessionFile: prepare(
        'INSERT OR IGNORE INTO staging_session_files (session_id, file_id) VALUES (?, ?)'
      ),
      writeStagingFile: prepare(
        `INSERT INTO staging_files (id, mime_type, size, data) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           mime_type = excluded.mime_type,
           size = excluded.size,
           data = excluded.data`
      ),
      clearStagingSessions: prepare('DELETE FROM staging_sessions'),
      clearStagingFiles: prepare('DELETE FROM staging_files'),
      clearStagingSessionFiles: prepare('DELETE FROM staging_session_files'),
    }
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = run()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // 事务已因语句失败自动回滚
      }
      throw error
    }
  }

  /** 删除后把空闲页还给文件系统，否则数据库文件只增不减。 */
  private reclaim(): void {
    try {
      this.db.exec('PRAGMA incremental_vacuum')
    } catch (error) {
      console.error('[chat] incremental_vacuum failed', error)
    }
  }

  listSummaries(): SessionSummary[] {
    return this.stmts.listSummaries.all() as SessionSummary[]
  }

  readSession(id: string): string | null {
    const row = this.stmts.readSession.get(id) as { data?: string } | undefined
    return row?.data ?? null
  }

  writeSession(session: SessionInput): void {
    this.transaction(() => {
      this.stmts.upsertSession.run(
        session.id,
        session.title,
        session.createdAt,
        session.updatedAt,
        session.json
      )
      this.stmts.deleteSessionFiles.run(session.id)
      for (const fileId of session.fileIds) {
        this.stmts.insertSessionFile.run(session.id, fileId)
      }
    })
  }

  /** 只改标题：列表里的标题与正文 JSON 保持同步，updatedAt 不变。 */
  renameSession(id: string, title: string): boolean {
    return this.transaction(() => {
      const row = this.stmts.readSession.get(id) as { data?: string } | undefined
      if (row?.data === undefined) {
        return false
      }
      const session = JSON.parse(row.data) as Record<string, unknown>
      session.title = title
      this.stmts.updateTitle.run(title, JSON.stringify(session), id)
      return true
    })
  }

  deleteSession(id: string): void {
    this.transaction(() => {
      this.stmts.deleteSession.run(id)
      this.stmts.gcFiles.run()
    })
    this.reclaim()
  }

  writeFile(file: FileInput): void {
    this.stmts.writeFile.run(file.id, file.mimeType, file.data.byteLength, file.data)
  }

  readFile(id: string): { mimeType: string; data: Uint8Array } | null {
    const row = this.stmts.readFile.get(id) as { mimeType?: string; data?: Uint8Array } | undefined
    if (row?.data === undefined) {
      return null
    }
    return { mimeType: row.mimeType ?? '', data: row.data }
  }

  writeStagingSession(session: SessionInput): void {
    this.transaction(() => {
      this.stmts.upsertStagingSession.run(
        session.id,
        session.title,
        session.createdAt,
        session.updatedAt,
        session.json
      )
      this.stmts.deleteStagingSessionFiles.run(session.id)
      for (const fileId of session.fileIds) {
        this.stmts.insertStagingSessionFile.run(session.id, fileId)
      }
    })
  }

  writeStagingFile(file: FileInput): void {
    this.stmts.writeStagingFile.run(file.id, file.mimeType, file.data.byteLength, file.data)
  }

  updateStagingFileTypes(types: Map<string, string>): void {
    if (types.size === 0) {
      return
    }
    this.transaction(() => {
      const rows = this.stmts.listStagingSessions.all() as { id: string; data: string }[]
      for (const row of rows) {
        const updated = retypeStagingSession(row.data, types)
        if (updated !== null) {
          this.stmts.updateStagingSession.run(updated, row.id)
        }
      }
    })
  }

  clearStaging(): void {
    this.transaction(() => {
      this.stmts.clearStagingSessions.run()
      this.stmts.clearStagingFiles.run()
      this.stmts.clearStagingSessionFiles.run()
    })
    this.reclaim()
  }

  /**
   * 用暂存内容整体替换正式数据：删、搬、清暂存在同一个事务里，
   * 任何一步失败都回滚，原有会话保持可用。
   */
  commitStaging(): SessionSummary[] {
    const summaries = this.stmts.listStagingSummaries.all() as SessionSummary[]
    this.transaction(() => {
      this.db.exec('DELETE FROM session_files')
      this.db.exec('DELETE FROM sessions')
      this.db.exec('DELETE FROM files')
      this.db.exec(
        'INSERT INTO sessions (id, title, created_at, updated_at, data) SELECT id, title, created_at, updated_at, data FROM staging_sessions'
      )
      this.db.exec(
        'INSERT INTO session_files (session_id, file_id) SELECT session_id, file_id FROM staging_session_files'
      )
      this.db.exec(
        'INSERT INTO files (id, mime_type, size, data) SELECT id, mime_type, size, data FROM staging_files'
      )
      this.stmts.clearStagingSessionFiles.run()
      this.stmts.clearStagingSessions.run()
      this.stmts.clearStagingFiles.run()
    })
    this.reclaim()
    return summaries
  }

  close(): void {
    this.db.close()
  }
}
