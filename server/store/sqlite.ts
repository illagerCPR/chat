import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { bytesToStream } from '../core/http.ts'
import { retypeSessionJson } from '../core/validate.ts'
import type { ChatStore, FileInput, SessionInput, SessionSummary, StoredFileBody } from './types.ts'

/** 当前表结构版本；改动 schema 时递增并补迁移步骤。 */
const SCHEMA_VERSION = 1

/**
 * 会话正文按整份 JSON 保存：前端一次读写整个会话（含消息树），
 * 拆字段只会让写入和分支关系更难维护。列表需要的元信息单独成列。
 *
 * 与 migrations/0001_init.sql 必须保持一致：那份给 Cloudflare D1 用，
 * 这份给自托管的 node:sqlite 用，两边只有 PRAGMA 与版本表不同。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  mime_type TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL,
  data BLOB NOT NULL
);

-- 会话与附件的引用关系：删除会话时级联清理，附件只有在无人引用时才回收
CREATE TABLE IF NOT EXISTS session_files (
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  PRIMARY KEY (session_id, file_id)
);

CREATE INDEX IF NOT EXISTS session_files_file ON session_files (file_id);
CREATE INDEX IF NOT EXISTS sessions_updated ON sessions (updated_at DESC);

-- 历史导入的暂存区，结构与正式表一致；提交时在一个事务里整体替换
CREATE TABLE IF NOT EXISTS staging_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS staging_files (
  id TEXT PRIMARY KEY,
  mime_type TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL,
  data BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS staging_session_files (
  session_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  PRIMARY KEY (session_id, file_id)
);
`

const migrate = (db: DatabaseSync): void => {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  const current = row?.user_version ?? 0
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${current} is newer than this build supports (${SCHEMA_VERSION}); use a newer image`
    )
  }
  if (current === SCHEMA_VERSION) {
    return
  }
  // 建表语句全部带 IF NOT EXISTS，从 0 升到 1 与重复执行都安全。
  db.exec(SCHEMA)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}

/** 打开（必要时创建）数据目录下的数据库，并按需建表。 */
export const openDatabase = (dataDir: string): DatabaseSync => {
  mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(path.join(dataDir, 'chat.db'))
  // auto_vacuum 必须在新库建表前设置；删除会话后附件占用的页才会被回收
  db.exec('PRAGMA auto_vacuum = INCREMENTAL')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  migrate(db)
  return db
}

type Statements = {
  listSummaries: StatementSync
  readSession: StatementSync
  upsertSession: StatementSync
  renameSession: StatementSync
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
 * 自托管容器里的实现：node:sqlite 同步 API，Node 单线程下天然串行。
 * 对外暴露的接口是异步的，与 D1 实现同形。
 */
export class SqliteChatStore implements ChatStore {
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
      // 列表列与正文 JSON 里的标题一起改，一条语句内原子完成，不需要读改写
      renameSession: prepare(
        "UPDATE sessions SET title = ?, data = json_set(data, '$.title', ?) WHERE id = ?"
      ),
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
      readFile: prepare('SELECT mime_type AS mimeType, size, data FROM files WHERE id = ?'),
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

  async listSummaries(): Promise<SessionSummary[]> {
    return this.stmts.listSummaries.all() as SessionSummary[]
  }

  async readSession(id: string): Promise<string | null> {
    const row = this.stmts.readSession.get(id) as { data?: string } | undefined
    return row?.data ?? null
  }

  async writeSession(session: SessionInput): Promise<void> {
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

  async renameSession(id: string, title: string): Promise<boolean> {
    const result = this.stmts.renameSession.run(title, title, id)
    return Number(result.changes) > 0
  }

  async deleteSession(id: string): Promise<void> {
    this.transaction(() => {
      this.stmts.deleteSession.run(id)
      this.stmts.gcFiles.run()
    })
    this.reclaim()
  }

  async writeFile(file: FileInput): Promise<void> {
    this.stmts.writeFile.run(file.id, file.mimeType, file.data.byteLength, file.data)
  }

  async readFile(id: string): Promise<StoredFileBody | null> {
    const row = this.stmts.readFile.get(id) as
      | { mimeType?: string; size?: number; data?: Uint8Array }
      | undefined
    if (row?.data === undefined) {
      return null
    }
    return {
      mimeType: row.mimeType ?? '',
      size: row.size ?? row.data.byteLength,
      body: bytesToStream(row.data),
    }
  }

  async writeStagingSession(session: SessionInput): Promise<void> {
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

  async writeStagingFile(file: FileInput): Promise<void> {
    this.stmts.writeStagingFile.run(file.id, file.mimeType, file.data.byteLength, file.data)
  }

  async updateStagingFileTypes(types: ReadonlyMap<string, string>): Promise<void> {
    if (types.size === 0) {
      return
    }
    this.transaction(() => {
      const rows = this.stmts.listStagingSessions.all() as { id: string; data: string }[]
      for (const row of rows) {
        const updated = retypeSessionJson(row.data, types)
        if (updated !== null) {
          this.stmts.updateStagingSession.run(updated, row.id)
        }
      }
    })
  }

  async clearStaging(): Promise<void> {
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
  async commitStaging(): Promise<SessionSummary[]> {
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

  async close(): Promise<void> {
    this.db.close()
  }
}
